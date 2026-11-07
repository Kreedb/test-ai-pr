// ROS1 bag v2 reader for the replay page.
//
// Only the records replay needs are decoded: connection metadata, chunks and
// message records. Chunk compression `none` and `lz4` are supported; the
// uncompressed size is not trusted, so a decoded chunk is capped as well.
//
// JointState and IMU messages are turned into columns instead of one object per
// message: a 300k-frame Luna bag would otherwise hold millions of decoded
// strings. Payloads are decoded from the embedded message definition, so both
// standard ROS types and LimX's custom controller messages use the same reader.

import lz4js from 'lz4js'

import { decodeImuMessage, decodeJointMessage, messageKind, messageProfile } from './rosmsg.js'
import { finalizeSeries, makeImuAccumulator, makeJointAccumulator, pushImu, pushJoint } from './series.js'

export const BAG_MAGIC = '#ROSBAG V2.0\n'
export const MAX_BAG_BYTES = 2048 * 1024 * 1024
// A single ROS chunk is far smaller than a whole bag; capping it separately keeps
// a tiny hostile frame from requesting the full upload budget.
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

const textDecoder = new TextDecoder()

function text(bytes) {
  return textDecoder.decode(bytes)
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function parseFields(bytes, start, end) {
  const view = viewOf(bytes)
  const fields = {}
  let offset = start
  while (offset + 4 <= end) {
    const length = view.getUint32(offset, true)
    offset += 4
    const fieldEnd = offset + length
    if (fieldEnd > end) throw new Error('bag 记录头长度越界，文件可能被截断')
    let equals = offset
    while (equals < fieldEnd && bytes[equals] !== 0x3d) equals += 1
    const key = text(bytes.subarray(offset, equals))
    fields[key] = bytes.subarray(Math.min(equals + 1, fieldEnd), fieldEnd)
    offset = fieldEnd
  }
  return fields
}

// Returns false when the file ends inside a record. An interrupted `.active`
// recording is a normal ROS1 bag with a truncated tail, so callers keep the
// complete records before it instead of failing the whole file.
function eachRecord(bytes, start, end, visit) {
  const view = viewOf(bytes)
  let offset = start
  while (offset + 4 <= end) {
    const recordStart = offset
    const headerLength = view.getUint32(offset, true)
    offset += 4
    if (offset + headerLength + 4 > end) return false
    const header = parseFields(bytes, offset, offset + headerLength)
    offset += headerLength
    const dataLength = view.getUint32(offset, true)
    offset += 4
    if (offset + dataLength > end) return false
    visit(header, bytes.subarray(offset, offset + dataLength), recordStart)
    offset += dataLength
  }
  return offset === end
}

function timeOf(field) {
  if (!field || field.length < 8) return null
  const view = viewOf(field)
  return view.getUint32(0, true) + view.getUint32(4, true) / 1e9
}

function connIdOf(header) {
  return header.conn?.length >= 4 ? viewOf(header.conn).getUint32(0, true) : null
}

function connectionMeta(header, data, previous) {
  const fields = parseFields(data, 0, data.length)
  return {
    ...(previous || {}),
    ...(header.topic ? { topic: text(header.topic) } : {}),
    type: fields.type ? text(fields.type) : previous?.type || '',
    md5: fields.md5sum ? text(fields.md5sum) : previous?.md5 || '',
    definition: fields.message_definition ? text(fields.message_definition) : previous?.definition || '',
  }
}

function decompressChunk(header, data) {
  const compression = header.compression ? text(header.compression) : 'none'
  const declared = header.size?.length >= 4 ? viewOf(header.size).getUint32(0, true) : null
  let raw = data
  if (compression === 'lz4') {
    // An interrupted recording leaves its open chunk header at size 0; its
    // bytes were not finalized, so there is nothing safe to decode.
    if (declared === 0) return new Uint8Array(0)
    // lz4js allocates maxSize before decoding. Pass the chunk's declared
    // uncompressed size so a hostile frame cannot request a huge buffer.
    if (declared === null) throw new Error('lz4 数据块缺少解压后大小')
    if (declared > MAX_CHUNK_BYTES) {
      throw new Error(`bag 数据块声明解压后 ${declared} 字节，超过 ${MAX_CHUNK_BYTES / 1024 / 1024} MiB 上限`)
    }
    raw = lz4js.decompress(data, declared)
    if (raw.length !== declared) {
      throw new Error('bag 数据块解压后大小与声明不符')
    }
  } else if (compression && compression !== 'none') {
    throw new Error(`暂不支持 ${compression} 压缩的 bag。请重新录制为 lz4 / 未压缩，或先用 rosbag decompress 展开。`)
  }
  if (raw.length > MAX_CHUNK_BYTES) {
    throw new Error(`bag 数据块解压后超过 ${MAX_CHUNK_BYTES / 1024 / 1024} MiB，拒绝继续解析`)
  }
  return raw
}

export function isRosbag(bytes) {
  if (bytes.byteLength < BAG_MAGIC.length) return false
  for (let index = 0; index < BAG_MAGIC.length; index += 1) {
    if (bytes[index] !== BAG_MAGIC.charCodeAt(index)) return false
  }
  return true
}

// `readRosbag` reuses the inspection of the exact same byte buffer: an
// interrupted `.active` file needs a full chunk scan just to find connections.
const inspections = new WeakMap()

/**
 * Read the connection table without touching chunk payloads. This is cheap
 * enough to run before choosing a joint / IMU topic, except for `.active`
 * files whose connections only exist inside chunks.
 */
export function inspectRosbag(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('bag 数据必须是 Uint8Array')
  if (bytes.byteLength > MAX_BAG_BYTES) {
    throw new Error(`bag 超过 ${MAX_BAG_BYTES / 1024 / 1024} MiB，浏览器内回放会耗尽内存`)
  }
  if (!isRosbag(bytes)) {
    throw new Error('不是 ROS1 bag v2 文件（缺少 #ROSBAG V2.0 头）')
  }

  const connections = new Map()
  const collect = (header, data) => {
    if (header.op?.[0] !== 0x07) return
    const id = connIdOf(header)
    if (id === null) return
    connections.set(id, connectionMeta(header, data, connections.get(id)))
  }
  eachRecord(bytes, BAG_MAGIC.length, bytes.length, collect)

  if (!connections.size) {
    // Interrupted `.active` recordings keep their connection records inside
    // the chunks instead of writing them after the file header.
    let chunkError = null
    eachRecord(bytes, BAG_MAGIC.length, bytes.length, (header, data) => {
      if (header.op?.[0] !== 0x05) return
      let raw
      try {
        raw = decompressChunk(header, data)
      } catch (cause) {
        chunkError ||= cause
        return
      }
      eachRecord(raw, 0, raw.length, collect)
    })
    if (!connections.size && chunkError) throw chunkError
  }

  const topics = [...connections.values()]
    .filter((connection) => connection.topic)
    .map((connection) => {
      const profile = messageProfile(connection.type, connection.definition)
      return {
        name: connection.topic,
        type: connection.type,
        md5: connection.md5,
        kind: profile.kind,
        family: profile.family,
        modified: profile.modified,
        standard: profile.standard,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))

  const result = { version: BAG_MAGIC.trim().split(' ').pop(), topics, connections }
  inspections.set(bytes, result)
  return result
}

export function topicKind(type = '', definition = '') {
  return messageKind(type, definition)
}

function decodeJoint(accumulator, data, timestamp) {
  const { names, values } = decodeJointMessage(data, {
    ros2: false,
    definition: accumulator.definition,
    type: accumulator.type,
  })
  pushJoint(accumulator, names, values, timestamp)
}

function decodeImu(accumulator, data, timestamp) {
  pushImu(accumulator, decodeImuMessage(data, { ros2: false, definition: accumulator.definition, type: accumulator.type }), timestamp)
}

/**
 * Decode the selected topics. `topics` is a list of topic names from
 * `inspectRosbag`; unsupported types are ignored with a warning.
 *
 * Returns `{ series, topics, warnings }`, where `series` is keyed by topic.
 */
export function readRosbag(bytes, { topics = [], onProgress } = {}) {
  const { connections } = inspections.get(bytes) || inspectRosbag(bytes)
  const wanted = new Set(topics)
  const accumulators = new Map()
  const byTopic = new Map()
  const warnings = []

  for (const [id, connection] of connections) {
    if (!wanted.has(connection.topic)) continue
    const kind = topicKind(connection.type, connection.definition)
    if (!kind) {
      warnings.push({
        level: 'warn',
        message: `话题 ${connection.topic} 的类型 ${connection.type} 暂不支持解码`,
      })
      continue
    }
    const existing = byTopic.get(connection.topic)
    if (existing) {
      // Multiple publishers can share one topic. Merge only when the message
      // type agrees; otherwise the decoded columns would not line up.
      if (existing.type !== connection.type) {
        warnings.push({
          level: 'warn',
          message: `话题 ${connection.topic} 有多个不同类型的连接，只使用第一个 ${existing.type}`,
        })
        continue
      }
      accumulators.set(id, existing)
      warnings.push({
        level: 'info',
        message: `话题 ${connection.topic} 有多个连接，消息按时间合并。`,
      })
      continue
    }
    const accumulator =
      kind === 'joint'
        ? makeJointAccumulator({ topic: connection.topic, type: connection.type, definition: connection.definition })
        : makeImuAccumulator({ topic: connection.topic, type: connection.type, definition: connection.definition })
    byTopic.set(connection.topic, accumulator)
    accumulators.set(id, accumulator)
  }

  const total = bytes.length
  let lastProgress = -1
  const readChunk = (header, data) => {
    const raw = decompressChunk(header, data)
    eachRecord(raw, 0, raw.length, (recordHeader, recordData) => {
      if (recordHeader.op?.[0] !== 0x02) return
      const id = connIdOf(recordHeader)
      const accumulator = accumulators.get(id)
      if (!accumulator) return
      const timestamp = timeOf(recordHeader.time)
      if (timestamp === null || !Number.isFinite(timestamp)) {
        throw new Error(`话题 ${accumulator.topic} 有缺少时间戳的消息`)
      }
      try {
        if (accumulator.kind === 'joint') decodeJoint(accumulator, recordData, timestamp)
        else decodeImu(accumulator, recordData, timestamp)
      } catch (cause) {
        throw new Error(`${accumulator.topic}: ${cause.message || cause}`)
      }
    })
  }

  const complete = eachRecord(bytes, BAG_MAGIC.length, bytes.length, (header, data, recordStart) => {
    if (onProgress && recordStart / total - lastProgress >= 0.05) {
      lastProgress = recordStart / total
      onProgress(Math.min(1, lastProgress))
    }
    if (header.op?.[0] === 0x05) {
      readChunk(header, data)
    } else if (header.op?.[0] === 0x02) {
      // Unchunked bags exist in the wild; reuse the chunk path on one record.
      const id = connIdOf(header)
      const accumulator = accumulators.get(id)
      if (!accumulator) return
      const timestamp = timeOf(header.time)
      if (timestamp === null || !Number.isFinite(timestamp)) {
        throw new Error(`话题 ${accumulator.topic} 有缺少时间戳的消息`)
      }
      if (accumulator.kind === 'joint') decodeJoint(accumulator, data, timestamp)
      else decodeImu(accumulator, data, timestamp)
    }
  })

  if (!complete) {
    warnings.push({
      level: 'warn',
      message: '文件尾部记录不完整，已保留截断前的完整数据块。',
    })
  }

  const finalized = finalizeSeries(accumulators)
  const series = finalized.series
  warnings.push(...finalized.warnings)

  const summaries = Object.values(series).map((item) => ({
    name: item.topic,
    type: item.type,
    kind: item.kind,
    frames: item.count,
    startTime: item.times[0],
    endTime: item.times[item.times.length - 1],
  }))

  for (const name of topics) {
    if (!series[name] && !warnings.some((warning) => warning.message.includes(name))) {
      warnings.push({ level: 'warn', message: `话题 ${name} 没有可用消息` })
    }
  }

  return { series, topics: summaries, warnings }
}
