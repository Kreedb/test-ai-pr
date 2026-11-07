// Minimal read-only SQLite reader for ROS2 `.db3` bags.
//
// `ros2 bag record` defaults to the sqlite3 storage plugin: a `topics` table and
// a `messages` table whose `data` blobs are CDR-encoded. Only table B-trees and
// overflow pages are needed to stream those rows, so the app does not ship a
// WASM SQLite build just for replay.

import { decodeImuMessage, decodeJointMessage, messageKind, messageProfile } from './rosmsg.js'
import { finalizeSeries, makeImuAccumulator, makeJointAccumulator, pushImu, pushJoint } from './series.js'

const MAGIC = 'SQLite format 3\0'
const decoder = new TextDecoder()

export function isSqlite(bytes) {
  if (!bytes || bytes.byteLength < MAGIC.length) return false
  for (let index = 0; index < MAGIC.length; index += 1) if (bytes[index] !== MAGIC.charCodeAt(index)) return false
  return true
}

function u16(page, offset) {
  return (page[offset] << 8) | page[offset + 1]
}

function u32(page, offset) {
  return (page[offset] * 0x1000000 + ((page[offset + 1] << 16) | (page[offset + 2] << 8) | page[offset + 3])) >>> 0
}

function varint(bytes, offset) {
  let value = 0
  for (let index = 0; index < 9; index += 1) {
    const byte = bytes[offset + index]
    if (byte === undefined) throw new Error('SQLite 变长整数越界，文件可能被截断')
    value = value * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) return { value, offset: offset + index + 1 }
  }
  return { value, offset: offset + 9 }
}

const SERIAL_SIZE = [0, 1, 2, 3, 4, 6, 8]

function decodeRecord(payload) {
  const header = varint(payload, 0)
  let offset = header.offset
  const serials = []
  while (offset < header.value) {
    const next = varint(payload, offset)
    serials.push(next.value)
    offset = next.offset
  }
  let data = header.value
  const values = []
  for (const serial of serials) {
    if (serial === 0) {
      values.push(null)
    } else if (serial >= 1 && serial <= 6) {
      const size = SERIAL_SIZE[serial]
      let value = 0
      for (let index = 0; index < size; index += 1) value = value * 256 + payload[data + index]
      const limit = 2 ** (size * 8)
      if (value >= limit / 2) value -= limit
      values.push(value)
      data += size
    } else if (serial === 7) {
      const view = new DataView(payload.buffer, payload.byteOffset + data, 8)
      values.push(view.getFloat64(0, false))
      data += 8
    } else if (serial === 8 || serial === 9) {
      values.push(serial === 8 ? 0 : 1)
    } else if (serial === 10 || serial === 11) {
      throw new Error('SQLite 记录包含保留的序列类型')
    } else {
      const length = serial % 2 ? (serial - 13) / 2 : (serial - 12) / 2
      const slice = payload.subarray(data, data + length)
      values.push(serial % 2 ? decoder.decode(slice) : slice)
      data += length
    }
  }
  return values
}

class Database {
  constructor(bytes) {
    this.bytes = bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let pageSize = view.getUint16(16, false)
    if (pageSize === 1) pageSize = 65536
    if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1)) throw new Error('SQLite 页大小无效')
    this.pageSize = pageSize
    this.usable = pageSize - bytes[20]
    this.pages = Math.floor(bytes.length / pageSize)
  }

  page(number) {
    if (number < 1 || number > this.pages) throw new Error(`SQLite 页 ${number} 超出文件范围`)
    const start = (number - 1) * this.pageSize
    return this.bytes.subarray(start, start + this.pageSize)
  }

  readPayload(page, cellOffset, size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length) throw new Error('SQLite 行载荷长度越界')
    const usable = this.usable
    const maxLocal = usable - 35
    let local = size
    if (size > maxLocal) {
      const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23
      local = minLocal + ((size - minLocal) % (usable - 4))
      if (local > maxLocal) local = minLocal
    }
    local = Math.min(local, size)
    const payload = new Uint8Array(size)
    payload.set(page.subarray(cellOffset, cellOffset + local))
    let filled = local
    let next = filled < size ? u32(page, cellOffset + local) : 0
    const seen = new Set()
    while (next && filled < size) {
      if (seen.has(next)) throw new Error('SQLite 溢出页成环')
      seen.add(next)
      const overflow = this.page(next)
      const amount = Math.min(size - filled, usable - 4)
      payload.set(overflow.subarray(4, 4 + amount), filled)
      filled += amount
      next = u32(overflow, 0)
    }
    if (filled < size) throw new Error('SQLite 行载荷不完整，文件可能被截断')
    return payload
  }

  // Walk a table B-tree in rowid order. Page 1 carries the 100-byte database
  // header before the b-tree header.
  scanPage(number, visit, visited = new Set()) {
    if (visited.has(number)) throw new Error('SQLite 表页成环')
    visited.add(number)
    const page = this.page(number)
    const header = number === 1 ? 100 : 0
    const type = page[header]
    this.scanned = (this.scanned || 0) + 1
    if (type === 0x0d) {
      const count = u16(page, header + 3)
      for (let index = 0; index < count; index += 1) {
        const cell = u16(page, header + 8 + index * 2)
        const length = varint(page, cell)
        const rowid = varint(page, length.offset)
        // An INTEGER PRIMARY KEY column is stored as NULL; its rowid is the value.
        visit(decodeRecord(this.readPayload(page, rowid.offset, length.value)), this.scanned, Number(rowid.value))
      }
      return
    }
    if (type === 0x05) {
      const count = u16(page, header + 3)
      for (let index = 0; index < count; index += 1) {
        const cell = u16(page, header + 12 + index * 2)
        this.scanPage(u32(page, cell), visit, visited)
      }
      this.scanPage(u32(page, header + 8), visit, visited)
      return
    }
    throw new Error('SQLite 表页类型不支持，文件可能已损坏')
  }

  table(name) {
    if (!this.master) {
      this.master = new Map()
      this.scanPage(1, (row) => {
        if (row[0] === 'table' && row[1]) this.master.set(String(row[1]), { root: Number(row[3]), sql: String(row[4] || '') })
      })
    }
    return this.master.get(name) || null
  }
}

function columnsOf(sql) {
  const start = sql.indexOf('(')
  const end = sql.lastIndexOf(')')
  if (start < 0 || end < start) return []
  const body = sql.slice(start + 1, end)
  const parts = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
    .map((part) =>
      part
        .trim()
        .split(/\s+/)[0]
        .replace(/["`[\]]/g, ''),
    )
    .filter(Boolean)
}

function readTopics(db) {
  const table = db.table('topics')
  if (!table) throw new Error('不是 ROS2 sqlite3 bag（缺少 topics 表）')
  const columns = columnsOf(table.sql)
  const idIndex = columns.indexOf('id')
  const nameIndex = columns.indexOf('name')
  const typeIndex = columns.indexOf('type')
  const formatIndex = columns.indexOf('serialization_format')
  const byId = new Map()
  const byName = new Map()
  db.scanPage(table.root, (row, scanned, rowid) => {
    const name = row[nameIndex]
    if (!name) return
    const topic = { name, type: row[typeIndex] || '', format: formatIndex < 0 ? 'cdr' : row[formatIndex] }
    byId.set(Number(row[idIndex] ?? rowid), topic)
    byName.set(name, topic)
  })
  return { byId, byName }
}

const inspections = new WeakMap()

export function inspectDb(bytes) {
  if (!isSqlite(bytes)) throw new Error('不是 ROS2 sqlite3 bag（缺少 SQLite 头）')
  const db = new Database(bytes)
  const topics = [...readTopics(db).byName.values()].map((topic) => {
    const profile = messageProfile(topic.type)
    return {
      name: topic.name,
      type: topic.type,
      kind: profile.kind,
      family: profile.family,
      modified: profile.modified,
      standard: profile.standard,
      format: topic.format,
    }
  })
  const result = { version: 'SQLite', topics: topics.sort((left, right) => left.name.localeCompare(right.name)) }
  inspections.set(bytes, result)
  return result
}

export function readDb(bytes, { topics = [], onProgress } = {}) {
  const db = new Database(bytes)
  const table = db.table('messages')
  if (!table) throw new Error('不是 ROS2 sqlite3 bag（缺少 messages 表）')
  const columns = columnsOf(table.sql)
  const topicIndex = columns.indexOf('topic_id')
  const timeIndex = columns.indexOf('timestamp')
  const dataIndex = columns.indexOf('data')
  if (topicIndex < 0 || timeIndex < 0 || dataIndex < 0) throw new Error('messages 表结构无法识别')

  const { byId } = readTopics(db)
  const wanted = new Set(topics)
  const accumulators = new Map()
  const warnings = []
  for (const [id, topic] of byId) {
    if (!wanted.has(topic.name)) continue
    const kind = messageKind(topic.type)
    if (!kind) continue
    if (topic.format && topic.format !== 'cdr') {
      warnings.push({ level: 'warn', message: `话题 ${topic.name} 的序列化格式 ${topic.format} 暂不支持` })
      continue
    }
    const accumulator = kind === 'joint' ? makeJointAccumulator({ topic: topic.name, type: topic.type, definition: '' }) : makeImuAccumulator({ topic: topic.name, type: topic.type, definition: '' })
    accumulators.set(id, accumulator)
  }

  const totalPages = Math.max(1, db.pages)
  let lastProgress = -1
  db.scanned = 0
  db.scanPage(table.root, (row, scanned) => {
    if (onProgress && scanned / totalPages - lastProgress >= 0.05) {
      lastProgress = scanned / totalPages
      onProgress(Math.min(1, lastProgress))
    }
    const accumulator = accumulators.get(Number(row[topicIndex]))
    if (!accumulator) return
    const timestamp = Number(row[timeIndex]) / 1e9
    if (!Number.isFinite(timestamp)) throw new Error(`话题 ${accumulator.topic} 有缺少时间戳的消息`)
    const payload = row[dataIndex]
    if (!payload?.length) return
    try {
      if (accumulator.kind === 'joint') {
        const { names, values } = decodeJointMessage(payload, { ros2: true, definition: '', type: accumulator.type })
        pushJoint(accumulator, names, values, timestamp)
      } else {
        pushImu(accumulator, decodeImuMessage(payload, { ros2: true, definition: '', type: accumulator.type }), timestamp)
      }
    } catch (cause) {
      throw new Error(`${accumulator.topic}: ${cause.message || cause}`)
    }
  })

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
