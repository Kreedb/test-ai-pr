// Text log reader for the replay page.
//
// Robot logs mix several clocks: a wall-clock prefix (2026-10-20 10:23:52.646),
// a ROS epoch stamp ([1700000000.123]) or the controller's monotonic `clk(...)`
// seconds. The bag's record time can be either the monotonic clock or epoch, so
// keep both and let `alignLog` pick the basis that overlaps the bag.

export const MAX_LOG_BYTES = 256 * 1024 * 1024

const MAX_ENTRIES = 500000
const CLK = /\bclk\(([0-9]+(?:\.[0-9]+)?)\)/
const ROS = /^\s*\[(?:DEBUG|INFO|WARN|ERROR|FATAL)\]\s*\[([0-9]+(?:\.[0-9]+)?)\]/
const WALL = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/
const LEVEL = /(?:^|\s)([IWEF])\//
const ROS_LEVEL = /\[(DEBUG|INFO|WARN|ERROR|FATAL)\]/

function wallClocks(match) {
  const parts = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index]))
  const milliseconds = Number((match[7] || '').padEnd(3, '0').slice(0, 3))
  const [year, month, day, hour, minute, second] = parts
  return {
    // The same wall clock can mean UTC or the robot's local timezone; keep
    // both so the caller can pick the one that lines up with the bag.
    wall: Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) / 1000,
    wallLocal: new Date(year, month - 1, day, hour, minute, second, milliseconds).getTime() / 1000,
  }
}

function clocksOf(line) {
  const clk = CLK.exec(line)
  const ros = ROS.exec(line)
  const wall = WALL.exec(line)
  const parsedWall = wall ? wallClocks(wall) : null
  return {
    clk: clk ? Number(clk[1]) : null,
    wall: parsedWall ? parsedWall.wall : ros ? Number(ros[1]) : null,
    wallLocal: parsedWall ? parsedWall.wallLocal : null,
  }
}

function levelOf(line) {
  const match = LEVEL.exec(line) || ROS_LEVEL.exec(line)
  if (!match) return ''
  return match[1][0]
}

/**
 * Parse a text log into timestamped entries. Lines without their own timestamp
 * are continuation lines of the previous entry, because robot logs wrap stack
 * traces and multi-line messages.
 */
export function parseLogText(text) {
  if (typeof text !== 'string') throw new Error('日志必须是文本')

  const entries = []
  const warnings = []
  let current = null
  let orphan = 0
  let truncated = false

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const clock = clocksOf(line)
    // `clk(...)` can also appear inside a wrapped message, so a clk-only line
    // is a new entry only when it is a header (level marker or unindented).
    const starts = clock.wall !== null || (clock.clk !== null && (LEVEL.test(line) || !/^\s/.test(line)))
    if (!starts) {
      if (current) current.text += `\n${line}`
      else if (line.trim()) orphan += 1
      continue
    }
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    current = { ...clock, level: levelOf(line), text: line }
    entries.push(current)
  }

  for (const entry of entries) entry.text = entry.text.replace(/\s+$/, '')
  if (orphan) warnings.push({ level: 'warn', message: `日志开头有 ${orphan} 行没有时间戳，已忽略。` })
  if (truncated) {
    warnings.push({
      level: 'warn',
      message: `日志超过 ${MAX_ENTRIES.toLocaleString()} 条，只解析了前 ${MAX_ENTRIES.toLocaleString()} 条。`,
    })
  }
  return { entries, warnings }
}

function rangeOf(entries, key) {
  let min = Infinity
  let max = -Infinity
  for (const entry of entries) {
    const value = entry[key]
    if (value === null) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return min <= max ? { min, max } : null
}

function overlaps(range, start, end) {
  return Boolean(range) && range.max >= start && range.min <= end
}

/**
 * Pick the clock that lines up with the bag's `[start, end]` record time.
 * Returns entries sorted by that clock plus `{ basis, aligned }`.
 */
export function alignLog(entries, start, end) {
  if (!entries.length) return { entries: [], basis: '', aligned: false }

  const clk = rangeOf(entries, 'clk')
  const wall = rangeOf(entries, 'wall')
  const wallLocal = rangeOf(entries, 'wallLocal')
  let basis = null
  let key = null
  let aligned = false
  if (overlaps(clk, start, end)) {
    basis = key = 'clk'
    aligned = true
  } else if (overlaps(wall, start, end)) {
    basis = key = 'wall'
    aligned = true
  } else if (overlaps(wallLocal, start, end)) {
    basis = 'wall'
    key = 'wallLocal'
    aligned = true
  } else {
    // Nothing overlaps: still show the entries so the raw timestamps are
    // visible, but the caller warns that they are not aligned to this bag.
    key = clk ? 'clk' : wall ? 'wall' : 'wallLocal'
    basis = key === 'clk' ? 'clk' : 'wall'
  }

  const alignedEntries = entries
    .filter((entry) => entry[key] !== null)
    .map((entry) => ({ time: entry[key], level: entry.level, text: entry.text }))
    .sort((left, right) => left.time - right.time)

  return { entries: alignedEntries, basis, aligned }
}
