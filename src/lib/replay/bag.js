// Format detection and a single read interface for ROS1 bags and ROS2
// MCAP / sqlite3 bags. Split ROS2 bags are several files with one schema.

import { isMcap, inspectMcap, readMcap } from './mcap.js'
import { isRosbag, inspectRosbag, readRosbag } from './rosbag.js'
import { isSqlite, inspectDb, readDb } from './sqlite.js'
import { mergeSeries } from './series.js'

export const BAG_FORMATS = [
  { id: 'auto', label: '自动检测' },
  { id: 'ros1', label: 'ROS1 bag' },
  { id: 'mcap', label: 'ROS2 MCAP' },
  { id: 'sqlite', label: 'ROS2 SQLite (.db3)' },
]

export const FORMAT_LABELS = {
  ros1: 'ROS1 bag',
  mcap: 'ROS2 MCAP',
  sqlite: 'ROS2 SQLite',
}

export function sniffBagFormat(bytes) {
  if (isRosbag(bytes)) return 'ros1'
  if (isMcap(bytes)) return 'mcap'
  if (isSqlite(bytes)) return 'sqlite'
  return null
}

function formatFiles(files, format) {
  const out = []
  for (const file of files) {
    const sniffed = sniffBagFormat(file.bytes)
    if (!sniffed) throw new Error(`${file.name} 不是 ROS1 bag、ROS2 MCAP 或 ROS2 sqlite3 bag`)
    if (format !== 'auto' && sniffed !== format) {
      throw new Error(`${file.name} 实际是 ${FORMAT_LABELS[sniffed]}，与手动选择的 ${FORMAT_LABELS[format]} 不一致`)
    }
    out.push({ ...file, format: sniffed })
  }
  const formats = new Set(out.map((file) => file.format))
  if (formats.size > 1) throw new Error('一次只能加载一种格式的 bag 文件')
  return { format: out[0].format, files: out }
}

function unionTopics(results) {
  const byName = new Map()
  const warnings = []
  for (const result of results) {
    warnings.push(...(result.warnings || []))
    for (const topic of result.topics) {
      if (!topic.kind) continue
      const existing = byName.get(topic.name)
      if (!existing) {
        byName.set(topic.name, topic)
      } else if (existing.type !== topic.type) {
        warnings.push({ level: 'warn', message: `话题 ${topic.name} 在分片里类型不一致（${existing.type} / ${topic.type}）` })
      }
    }
  }
  return { topics: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)), warnings }
}

export function inspectBag(files, format = 'auto') {
  if (!files?.length) throw new Error('没有 bag 文件')
  const { format: kind, files: selected } = formatFiles(files, format)
  if (kind === 'ros1') {
    if (selected.length > 1) throw new Error('一次只能加载一个 ROS1 bag 文件')
    const info = inspectRosbag(selected[0].bytes)
    return { format: kind, topics: info.topics, warnings: [] }
  }
  const results = selected.map((file) => (kind === 'mcap' ? inspectMcap(file.bytes) : inspectDb(file.bytes)))
  const { topics, warnings } = unionTopics(results)
  return { format: kind, topics, warnings }
}

export function readBag(files, { format = 'auto', topics = [], onProgress } = {}) {
  const { format: kind, files: selected } = formatFiles(files, format)
  if (kind === 'ros1') {
    if (selected.length > 1) throw new Error('一次只能加载一个 ROS1 bag 文件')
    return { format: kind, ...readRosbag(selected[0].bytes, { topics, onProgress }) }
  }

  const results = selected.map((file, index) =>
    kind === 'mcap'
      ? readMcap(file.bytes, { topics, onProgress: (value) => onProgress?.((index + value) / selected.length) })
      : readDb(file.bytes, { topics, onProgress: (value) => onProgress?.((index + value) / selected.length) }),
  )
  const series = mergeSeries(results.map((result) => result.series))
  const warnings = results.flatMap((result) => result.warnings)
  const summaries = Object.values(series).map((item) => ({
    name: item.topic,
    type: item.type,
    kind: item.kind,
    frames: item.count,
    startTime: item.times[0],
    endTime: item.times[item.times.length - 1],
  }))
  return { format: kind, series, topics: summaries, warnings }
}
