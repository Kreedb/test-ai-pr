// ROS1 bag v2 reader for the replay page.
//
// Only the records replay needs are decoded: connection metadata, chunks and
// message records. Chunk compression `none` and `lz4` are supported; the
// uncompressed size is not trusted, so a decoded chunk is capped as well.
//
// JointState and IMU messages are turned into columns instead of one object per
// message: a 300k-frame Luna bag would otherwise hold millions of decoded
// strings. Message types are matched by name because no ROS environment is
// available in the browser.

import lz4js from 'lz4js'

export const BAG_MAGIC = '#ROSBAG V2.0\n'
export const MAX_BAG_BYTES = 2048 * 1024 * 1024
export const MAX_CHUNK_BYTES = MAX_BAG_BYTES

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
    definition: fields.message_definition
      ? text(fields.message_definition)
      : previous?.definition || '',
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
      throw new Error(
        `bag 数据块声明解压后 ${declared} 字节，超过 ${MAX_CHUNK_BYTES / 1024 / 1024} MiB 上限`,
      )
    }
    raw = lz4js.decompress(data, declared)
    if (raw.length !== declared) {
      throw new Error('bag 数据块解压后大小与声明不符')
    }
  } else if (compression && compression !== 'none') {
    throw new Error(
      `暂不支持 ${compression} 压缩的 bag。请重新录制为 lz4 / 未压缩，或先用 rosbag decompress 展开。`,
    )
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
    .map((connection) => ({
      name: connection.topic,
      type: connection.type,
      md5: connection.md5,
      kind: topicKind(connection.type),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  const result = { version: BAG_MAGIC.trim().split(' ').pop(), topics, connections }
  inspections.set(bytes, result)
  return result
}

export function topicKind(type = '') {
  if (type === 'controller_msgs/JointState' || type === 'sensor_msgs/JointState') return 'joint'
  if (type === 'controller_msgs/IMUData' || type === 'sensor_msgs/Imu') return 'imu'
  return null
}

class Cursor {
  constructor(bytes) {
    this.bytes = bytes
    this.view = viewOf(bytes)
    this.offset = 0
  }

  u32() {
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  u64() {
    const value = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return Number(value)
  }

  f32() {
    const value = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return value
  }

  f64() {
    const value = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return value
  }

  ensure(count) {
    if (count < 0 || this.offset + count > this.bytes.length) {
      throw new Error('bag 消息字段越界，文件可能被截断')
    }
  }

  string() {
    const length = this.u32()
    this.ensure(length)
    const value = text(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  stringArray() {
    const count = this.u32()
    // Every string has at least its 4-byte length prefix.
    this.ensure(count * 4)
    const values = []
    const raw = []
    for (let index = 0; index < count; index += 1) {
      const length = this.u32()
      this.ensure(length)
      const slice = this.bytes.subarray(this.offset, this.offset + length)
      raw.push(slice)
      values.push(text(slice))
      this.offset += length
    }
    return { values, raw }
  }

  f32Array() {
    const count = this.u32()
    this.ensure(count * 4)
    const values = new Float32Array(count)
    for (let index = 0; index < count; index += 1) values[index] = this.f32()
    return values
  }

  f64Array() {
    const count = this.u32()
    this.ensure(count * 8)
    const values = new Float64Array(count)
    for (let index = 0; index < count; index += 1) values[index] = this.f64()
    return values
  }

  skip(count) {
    this.ensure(count)
    this.offset += count
  }
}

function readHeader(cursor) {
  const seq = cursor.u32()
  const seconds = cursor.u32()
  const nanoseconds = cursor.u32()
  const frameId = cursor.string()
  return { seq, time: seconds + nanoseconds / 1e9, frameId }
}

const CHUNK = 8192

class Column {
  constructor(Type = Float32Array) {
    this.Type = Type
    this.chunks = []
    this.current = null
    this.filled = 0
    this.length = 0
  }

  push(value) {
    if (!this.current || this.filled === CHUNK) {
      this.current = new this.Type(CHUNK)
      this.chunks.push(this.current)
      this.filled = 0
    }
    this.current[this.filled++] = value
    this.length += 1
  }

  toArray() {
    const values = new this.Type(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      values.set(chunk.subarray(0, Math.min(chunk.length, this.length - offset)), offset)
      offset += chunk.length
    }
    return values
  }
}

function sameRawNames(left, right) {
  if (!left || !right || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.length !== b.length) return false
    for (let byte = 0; byte < a.length; byte += 1) {
      if (a[byte] !== b[byte]) return false
    }
  }
  return true
}

function indexByName(names) {
  const map = new Map()
  for (let index = 0; index < names.length; index += 1) map.set(names[index], index)
  for (let index = 0; index < names.length; index += 1) {
    if (map.get(names[index]) !== index) {
      throw new Error(`话题里的关节名称 ${names[index]} 重复，无法确定角度顺序`)
    }
  }
  return map
}

function makeJointAccumulator(connection) {
  return {
    kind: 'joint',
    topic: connection.topic,
    type: connection.type,
    times: new Column(Float64Array),
    names: null,
    rawNames: null,
    columns: null,
    named: false,
    count: 0,
  }
}

function pushJoint(accumulator, nameInfo, values) {
  if (!accumulator.names) {
    accumulator.named = nameInfo.values.length > 0
    accumulator.names = nameInfo.values.length
      ? nameInfo.values
      : values.map((_, index) => `q_${index}`)
    accumulator.rawNames = nameInfo.values.length ? nameInfo.raw.map((raw) => raw.slice()) : null
    accumulator.columns = accumulator.names.map(() => new Column())
  } else if (accumulator.rawNames && !sameRawNames(accumulator.rawNames, nameInfo.raw)) {
    // A later frame may list the same joints in a different order; reorder once
    // by name instead of trusting the column position.
    const lookup = indexByName(nameInfo.values)
    values = accumulator.names.map((name) => {
      const source = lookup.get(name)
      if (source === undefined)
        throw new Error(`话题 ${accumulator.topic} 的关节 ${name} 在后续帧里缺失`)
      return values[source]
    })
  }
  if (values.length !== accumulator.names.length) {
    throw new Error(
      `话题 ${accumulator.topic} 的关节数从 ${accumulator.names.length} 变成 ${values.length}，无法对齐`,
    )
  }
  accumulator.times.push(accumulator.timestamp)
  for (let index = 0; index < values.length; index += 1)
    accumulator.columns[index].push(values[index])
  accumulator.count += 1
}

function decodeJoint(accumulator, data, timestamp) {
  const cursor = new Cursor(data)
  readHeader(cursor)
  const nameInfo = cursor.stringArray()
  // Both variants put positions immediately after names, but std_msgs uses
  // float64 while the LimX controller message uses float32.
  const values =
    accumulator.type === 'sensor_msgs/JointState' ? cursor.f64Array() : cursor.f32Array()
  if (!values.length) throw new Error(`话题 ${accumulator.topic} 没有关节角度`)
  accumulator.timestamp = timestamp
  pushJoint(accumulator, nameInfo, [...values])
}

function makeImuAccumulator(connection) {
  return {
    kind: 'imu',
    topic: connection.topic,
    type: connection.type,
    times: new Column(Float64Array),
    quat: [0, 1, 2, 3].map(() => new Column()),
    count: 0,
  }
}

function decodeImu(accumulator, data, timestamp) {
  const cursor = new Cursor(data)
  readHeader(cursor)
  let quat
  if (accumulator.type === 'sensor_msgs/Imu') {
    const x = cursor.f64()
    const y = cursor.f64()
    const z = cursor.f64()
    const w = cursor.f64()
    quat = [w, x, y, z]
  } else {
    cursor.u64() // imustamp
    cursor.u32() // status
    cursor.skip(3 * 8) // euler is not needed for the base orientation
    quat = [cursor.f64(), cursor.f64(), cursor.f64(), cursor.f64()]
  }
  accumulator.times.push(timestamp)
  for (let index = 0; index < 4; index += 1) accumulator.quat[index].push(quat[index])
  accumulator.count += 1
}

function dedupe(series) {
  const times = series.times.toArray()
  const columns = {}
  for (const [key, value] of Object.entries(series)) {
    if (value instanceof Column) columns[key] = value.toArray()
  }
  for (const [key, value] of Object.entries(series)) {
    if (Array.isArray(value) && value[0] instanceof Column) {
      columns[key] = value.map((column) => column.toArray())
    }
  }

  const length = times.length
  let write = 0
  let duplicates = 0
  for (let read = 0; read < length; read += 1) {
    if (read + 1 < length && times[read + 1] === times[read]) {
      duplicates += 1
      continue
    }
    times[write] = times[read]
    for (const value of Object.values(columns)) {
      if (Array.isArray(value)) {
        for (const column of value) column[write] = column[read]
      } else {
        value[write] = value[read]
      }
    }
    write += 1
  }

  for (const [key, value] of Object.entries(columns)) {
    series[key] = Array.isArray(value)
      ? value.map((column) => column.slice(0, write))
      : value.slice(0, write)
  }
  series.times = times.slice(0, write)
  series.count = write
  series.duplicates = duplicates
  return series
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
    const kind = topicKind(connection.type)
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
      kind === 'joint' ? makeJointAccumulator(connection) : makeImuAccumulator(connection)
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

  const complete = eachRecord(
    bytes,
    BAG_MAGIC.length,
    bytes.length,
    (header, data, recordStart) => {
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
    },
  )

  if (!complete) {
    warnings.push({
      level: 'warn',
      message: '文件尾部记录不完整，已保留截断前的完整数据块。',
    })
  }

  const series = {}
  const seen = new Set()
  for (const accumulator of accumulators.values()) {
    if (seen.has(accumulator) || !accumulator.count) continue
    seen.add(accumulator)
    const ordered = dedupe(accumulator)
    series[ordered.topic] = ordered
    if (ordered.duplicates) {
      warnings.push({
        level: 'info',
        message: `话题 ${ordered.topic} 有 ${ordered.duplicates} 个重复时间戳，回放时保留同刻最后一条记录。`,
      })
    }
    for (let index = 1; index < ordered.times.length; index += 1) {
      if (ordered.times[index] < ordered.times[index - 1]) {
        throw new Error(`话题 ${ordered.topic} 的时间戳倒退，无法可靠回放`)
      }
    }
  }

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
