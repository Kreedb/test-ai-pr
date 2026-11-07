// Column storage shared by the ROS1 and ROS2 readers. A bag of 300k frames
// would otherwise hold millions of small objects; joint values are appended to
// typed columns and only materialized once at the end.

const CHUNK = 8192

export class Column {
  constructor(Type = Float64Array) {
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

function sameNames(left, right) {
  if (!left || !right || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}

function indexByName(names) {
  const map = new Map()
  for (let index = 0; index < names.length; index += 1) {
    if (map.has(names[index])) throw new Error(`话题里的关节名称 ${names[index]} 重复，无法确定角度顺序`)
    map.set(names[index], index)
  }
  return map
}

export function makeJointAccumulator({ topic, type, definition = '' }) {
  return {
    kind: 'joint',
    topic,
    type,
    definition,
    times: new Column(),
    names: null,
    columns: null,
    named: false,
    count: 0,
  }
}

export function pushJoint(accumulator, names, values, timestamp) {
  if (names.length && names.length !== values.length) {
    throw new Error(`话题 ${accumulator.topic} 的关节名称数 ${names.length} 与角度数 ${values.length} 不一致`)
  }
  if (!accumulator.names) {
    accumulator.named = names.length > 0
    accumulator.names = names.length ? [...names] : Array.from(values, (_, index) => `q_${index}`)
    accumulator.columns = accumulator.names.map(() => new Column())
  } else if (accumulator.named && !sameNames(accumulator.names, names)) {
    // A later frame may list the same joints in a different order; reorder once
    // by name instead of trusting the column position.
    const lookup = indexByName(names)
    values = accumulator.names.map((name) => {
      const source = lookup.get(name)
      if (source === undefined) throw new Error(`话题 ${accumulator.topic} 的关节 ${name} 在后续帧里缺失`)
      return values[source]
    })
  }
  if (values.length !== accumulator.names.length) {
    throw new Error(`话题 ${accumulator.topic} 的关节数从 ${accumulator.names.length} 变成 ${values.length}，无法对齐`)
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) throw new Error(`话题 ${accumulator.topic} 有缺失或非数值的关节角度`)
  }
  accumulator.times.push(timestamp)
  for (let index = 0; index < values.length; index += 1) accumulator.columns[index].push(values[index])
  accumulator.count += 1
}

export function makeImuAccumulator({ topic, type, definition = '' }) {
  return {
    kind: 'imu',
    topic,
    type,
    definition,
    times: new Column(),
    quat: [0, 0, 0, 0].map(() => new Column()),
    acc: [0, 0, 0].map(() => new Column()),
    gyro: [0, 0, 0].map(() => new Column()),
    hasAcc: false,
    hasGyro: false,
    count: 0,
  }
}

export function pushImu(accumulator, sample, timestamp) {
  const { quat = [1, 0, 0, 0], acc = null, gyro = null } = sample
  accumulator.times.push(timestamp)
  for (let index = 0; index < 4; index += 1) accumulator.quat[index].push(quat[index])
  for (let index = 0; index < 3; index += 1) {
    accumulator.acc[index].push(acc ? acc[index] : 0)
    accumulator.gyro[index].push(gyro ? gyro[index] : 0)
  }
  if (acc) accumulator.hasAcc = true
  if (gyro) accumulator.hasGyro = true
  accumulator.count += 1
}

function dedupe(series) {
  const times = series.times.toArray()
  const columns = {}
  for (const [key, value] of Object.entries(series)) {
    if (value instanceof Column) columns[key] = value.toArray()
    else if (Array.isArray(value) && value[0] instanceof Column) columns[key] = value.map((column) => column.toArray())
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
    series[key] = Array.isArray(value) ? value.map((column) => column.slice(0, write)) : value.slice(0, write)
  }
  series.times = times.slice(0, write)
  series.count = write
  series.duplicates = duplicates
  return series
}

/** Materialize accumulators into `{ [topic]: series }`, dropping empty ones. */
export function finalizeSeries(accumulators) {
  const series = {}
  const seen = new Set()
  const warnings = []
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
      if (ordered.times[index] < ordered.times[index - 1]) throw new Error(`话题 ${ordered.topic} 的时间戳倒退，无法可靠回放`)
    }
  }
  return { series, warnings }
}

/** Concatenate split-bag files, then order by time (usually nothing moves). */
export function mergeSeries(sources) {
  const merged = {}
  for (const source of sources) {
    for (const series of Object.values(source || {})) {
      if (!series) continue
      if (!merged[series.topic]) {
        merged[series.topic] = {
          ...series,
          columns: series.columns ? series.columns.map((column) => [...column]) : undefined,
          quat: series.quat ? series.quat.map((column) => [...column]) : undefined,
          acc: series.acc ? series.acc.map((column) => [...column]) : undefined,
          gyro: series.gyro ? series.gyro.map((column) => [...column]) : undefined,
          times: [...series.times],
        }
        continue
      }
      const target = merged[series.topic]
      for (const value of series.times) target.times.push(value)
      for (const name of ['columns', 'quat', 'acc', 'gyro']) {
        if (!target[name] || !series[name]) continue
        for (let index = 0; index < target[name].length; index += 1) {
          const source = series[name][index]
          const destination = target[name][index]
          for (const value of source) destination.push(value)
        }
      }
      target.count += series.count
      target.hasAcc ||= series.hasAcc
      target.hasGyro ||= series.hasGyro
    }
  }

  for (const series of Object.values(merged)) {
    const order = series.times.map((_, index) => index)
    let sorted = true
    for (let index = 1; index < order.length; index += 1) {
      if (series.times[order[index]] < series.times[order[index - 1]]) sorted = false
    }
    if (!sorted) order.sort((left, right) => series.times[left] - series.times[right])
    // Duplicate timestamps at a file boundary keep the later record, matching
    // the single-file readers.
    const keep = []
    for (let index = 0; index < order.length; index += 1) {
      const next = order[index + 1]
      if (next !== undefined && series.times[next] === series.times[order[index]]) continue
      keep.push(order[index])
    }
    series.times = keep.map((index) => series.times[index])
    for (const name of ['columns', 'quat', 'acc', 'gyro']) {
      if (series[name]) series[name] = series[name].map((column) => keep.map((index) => column[index]))
    }
    series.count = keep.length
  }
  return merged
}
