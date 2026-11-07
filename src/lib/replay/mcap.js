// ROS2 MCAP reader. `ros2 bag record -s mcap` writes one `.mcap` file per split;
// message schemas are embedded as `ros2msg` text, so the shared field-driven
// decoder can read standard and LimX-modified messages alike.

import lz4js from 'lz4js'

import { decodeImuMessage, decodeJointMessage, messageKind, messageProfile } from './rosmsg.js'
import { finalizeSeries, makeImuAccumulator, makeJointAccumulator, pushImu, pushJoint } from './series.js'
import { MAX_CHUNK_BYTES } from './rosbag.js'

export const MCAP_MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a])

const decoder = new TextDecoder()

export function isMcap(bytes) {
  if (!bytes || bytes.byteLength < MCAP_MAGIC.length) return false
  for (let index = 0; index < MCAP_MAGIC.length; index += 1) if (bytes[index] !== MCAP_MAGIC[index]) return false
  return true
}

class MetaReader {
  constructor(bytes) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = 0
  }

  ensure(count) {
    if (count < 0 || this.offset + count > this.bytes.length) throw new Error('MCAP 记录越界，文件可能被截断')
  }

  u16() {
    this.ensure(2)
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  u32() {
    this.ensure(4)
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  u64() {
    this.ensure(8)
    const value = Number(this.view.getBigUint64(this.offset, true))
    this.offset += 8
    return value
  }

  string() {
    const length = this.u32()
    this.ensure(length)
    const value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  bytesOf() {
    const length = this.u32()
    this.ensure(length)
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
}

function eachRecord(bytes, start, visit) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start
  while (offset + 9 <= bytes.length) {
    const opcode = bytes[offset]
    if (opcode === MCAP_MAGIC[0]) break
    const length = Number(view.getBigUint64(offset + 1, true))
    const dataStart = offset + 9
    if (dataStart + length > bytes.length) return false
    visit(opcode, bytes.subarray(dataStart, dataStart + length), dataStart)
    offset = dataStart + length
  }
  return true
}

function readChunk(data) {
  const reader = new MetaReader(data)
  reader.offset = 16
  const uncompressedSize = reader.u64()
  reader.u32() // uncompressed CRC
  const compression = reader.string()
  const length = reader.u64()
  if (reader.offset + length > data.length) throw new Error('MCAP 数据块长度越界，文件可能被截断')
  const records = data.subarray(reader.offset, reader.offset + length)
  if (!compression || compression === 'none') return records
  if (compression === 'lz4') {
    if (uncompressedSize > MAX_CHUNK_BYTES) throw new Error(`MCAP 数据块声明解压后 ${uncompressedSize} 字节，超过上限`)
    const raw = lz4js.decompress(records, uncompressedSize)
    if (raw.length !== uncompressedSize) throw new Error('MCAP 数据块解压后大小与声明不符')
    return raw
  }
  throw new Error(`暂不支持 ${compression} 压缩的 MCAP。请重新录制成 lz4 / 未压缩。`)
}

function readSchema(opcode, data, state) {
  if (opcode !== 0x03) return
  const reader = new MetaReader(data)
  const id = reader.u16()
  const name = reader.string()
  const encoding = reader.string()
  state.schemas.set(id, { name, encoding, definition: decoder.decode(reader.bytesOf()) })
}

function readChannel(opcode, data, state) {
  if (opcode !== 0x04) return
  const reader = new MetaReader(data)
  const id = reader.u16()
  const schemaId = reader.u16()
  const topic = reader.string()
  const encoding = reader.string()
  // Channel metadata is a uint32 byte length followed by the packed pairs.
  const metadataLength = reader.u32()
  reader.ensure(metadataLength)
  reader.offset += metadataLength
  const schema = state.schemas.get(schemaId)
  state.channels.set(id, {
    topic,
    type: schema?.name || '',
    definition: schema?.encoding === 'ros2msg' ? schema.definition : '',
    schemaEncoding: schema?.encoding || '',
    messageEncoding: encoding,
  })
}

function collectMetadata(bytes, state) {
  eachRecord(bytes, MCAP_MAGIC.length, (opcode, data) => {
    readSchema(opcode, data, state)
    readChannel(opcode, data, state)
    if (opcode !== 0x06) return
    const chunk = readChunk(data)
    eachRecord(chunk, 0, (innerOpcode, innerData) => {
      readSchema(innerOpcode, innerData, state)
      readChannel(innerOpcode, innerData, state)
    })
  })
}

function topicList(channels) {
  const byName = new Map()
  for (const channel of channels.values()) {
    if (!channel.topic) continue
    const profile = messageProfile(channel.type, channel.definition)
    if (!profile.kind) continue
    byName.set(channel.topic, {
      name: channel.topic,
      type: channel.type,
      kind: profile.kind,
      family: profile.family,
      modified: profile.modified,
      standard: profile.standard,
    })
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

// Inspection and decoding walk the same buffer; cache metadata so selecting a
// different topic does not decompress every chunk twice.
const inspections = new WeakMap()

export function inspectMcap(bytes) {
  if (!isMcap(bytes)) throw new Error('不是 MCAP 文件（缺少 MCAP 头）')
  const state = { schemas: new Map(), channels: new Map() }
  collectMetadata(bytes, state)
  const result = { version: 'MCAP', topics: topicList(state.channels), channels: state.channels }
  inspections.set(bytes, result)
  return result
}

export function readMcap(bytes, { topics = [], onProgress } = {}) {
  const info = inspections.get(bytes) || inspectMcap(bytes)
  const wanted = new Set(topics)
  const accumulators = new Map()
  const byTopic = new Map()
  const warnings = []

  for (const [id, channel] of info.channels) {
    if (!wanted.has(channel.topic)) continue
    if (channel.messageEncoding && channel.messageEncoding !== 'cdr') {
      warnings.push({ level: 'warn', message: `话题 ${channel.topic} 的消息编码 ${channel.messageEncoding} 暂不支持` })
      continue
    }
    const kind = messageKind(channel.type, channel.definition)
    if (!kind) {
      warnings.push({ level: 'warn', message: `话题 ${channel.topic} 的类型 ${channel.type || '未知'} 暂不支持解码` })
      continue
    }
    const existing = byTopic.get(channel.topic)
    if (existing) {
      if (existing.type !== channel.type) {
        warnings.push({ level: 'warn', message: `话题 ${channel.topic} 有多个不同类型的通道，只使用第一个 ${existing.type}` })
        continue
      }
      accumulators.set(id, existing)
      continue
    }
    const accumulator =
      kind === 'joint'
        ? makeJointAccumulator({ topic: channel.topic, type: channel.type, definition: channel.definition })
        : makeImuAccumulator({ topic: channel.topic, type: channel.type, definition: channel.definition })
    byTopic.set(channel.topic, accumulator)
    accumulators.set(id, accumulator)
  }

  const total = bytes.length
  let lastProgress = -1
  const consume = (opcode, data, recordOffset) => {
    if (onProgress && recordOffset !== undefined && recordOffset / total - lastProgress >= 0.05) {
      lastProgress = recordOffset / total
      onProgress(Math.min(1, lastProgress))
    }
    if (opcode !== 0x05) return
    let accumulator = null
    try {
      const reader = new MetaReader(data)
      const channelId = reader.u16()
      reader.u32() // sequence
      const logTime = reader.u64()
      reader.u64() // publish time
      const payload = data.subarray(reader.offset)
      accumulator = accumulators.get(channelId)
      if (!accumulator) return
      const timestamp = logTime / 1e9
      if (!Number.isFinite(timestamp)) throw new Error('消息缺少时间戳')
      if (accumulator.kind === 'joint') {
        const { names, values } = decodeJointMessage(payload, { ros2: true, definition: accumulator.definition, type: accumulator.type })
        pushJoint(accumulator, names, values, timestamp)
      } else {
        pushImu(accumulator, decodeImuMessage(payload, { ros2: true, definition: accumulator.definition, type: accumulator.type }), timestamp)
      }
    } catch (cause) {
      throw new Error(`${accumulator?.topic || 'MCAP'}: ${cause.message || cause}`)
    }
  }

  const complete = eachRecord(bytes, MCAP_MAGIC.length, (opcode, data, offset) => {
    if (opcode === 0x06) {
      const chunk = readChunk(data)
      eachRecord(chunk, 0, (innerOpcode, innerData) => consume(innerOpcode, innerData))
    } else if (opcode === 0x05) {
      consume(opcode, data, offset)
    }
  })
  if (!complete) warnings.push({ level: 'warn', message: 'MCAP 尾部记录不完整，已保留截断前的完整数据块。' })

  const finalized = finalizeSeries(accumulators)
  warnings.push(...finalized.warnings)
  for (const name of topics) {
    if (!finalized.series[name] && !warnings.some((warning) => warning.message.includes(name))) {
      warnings.push({ level: 'warn', message: `话题 ${name} 没有可用消息` })
    }
  }

  const summaries = Object.values(finalized.series).map((item) => ({
    name: item.topic,
    type: item.type,
    kind: item.kind,
    frames: item.count,
    startTime: item.times[0],
    endTime: item.times[item.times.length - 1],
  }))
  return { series: finalized.series, topics: summaries, warnings }
}
