// Minimal ROS1 bag v2 writer used by the replay regression tests and to
// regenerate `public/samples/replay/luna-demo.bag`. It writes one chunk and no
// index records; the reader does not depend on an index.

import lz4js from 'lz4js'

const encoder = new TextEncoder()

class Out {
  constructor() {
    this.parts = []
    this.length = 0
  }

  push(bytes) {
    this.parts.push(bytes)
    this.length += bytes.length
    return this
  }

  u32(value) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    return this.push(bytes)
  }

  u64(value) {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
    return this.push(bytes)
  }

  f32(value) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setFloat32(0, value, true)
    return this.push(bytes)
  }

  f64(value) {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    return this.push(bytes)
  }

  str(value) {
    const bytes = encoder.encode(value)
    this.u32(bytes.length)
    return this.push(bytes)
  }

  build() {
    const bytes = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return bytes
  }
}

function field(name, value) {
  const key = encoder.encode(`${name}=`)
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const out = new Out()
  out.u32(key.length + bytes.length).push(key).push(bytes)
  return out.build()
}

function header(fields) {
  const out = new Out()
  for (const [name, value] of Object.entries(fields)) out.push(field(name, value))
  return out.build()
}

export function record(fields, data) {
  const head = header(fields)
  const out = new Out()
  out.u32(head.length).push(head).u32(data.length).push(data)
  return out.build()
}

function timeBytes(seconds) {
  const whole = Math.floor(seconds)
  let nanoseconds = Math.round((seconds - whole) * 1e9)
  let secs = whole
  if (nanoseconds >= 1e9) {
    secs += 1
    nanoseconds -= 1e9
  }
  const out = new Out()
  out.u32(secs).u32(nanoseconds)
  return out.build()
}

export function encodeHeader({ seq = 0, time = 0, frameId = '' } = {}) {
  const out = new Out()
  out.u32(seq).push(timeBytes(time)).str(frameId)
  return out.build()
}

function floatArray(values) {
  const out = new Out()
  out.u32(values.length)
  for (const value of values) out.f32(value)
  return out.build()
}

function doubleArray(values) {
  const out = new Out()
  out.u32(values.length)
  for (const value of values) out.f64(value)
  return out.build()
}

function stringArray(values) {
  const out = new Out()
  out.u32(values.length)
  for (const value of values) out.str(value)
  return out.build()
}

export function encodeJointState({ names = [], position = [], time = 0, frameId = '' } = {}) {
  const out = new Out()
  out.push(encodeHeader({ time, frameId }))
    .push(stringArray(names))
    .push(floatArray(position))
    .push(floatArray([]))
    .push(floatArray([]))
    .push(floatArray([]))
    .u32(0)
  return out.build()
}

export function encodeImu({ quat = [1, 0, 0, 0], euler = [0, 0, 0], time = 0, frameId = 'limx' } = {}) {
  const out = new Out()
  out.push(encodeHeader({ time, frameId })).u64(0).u32(0)
  for (const value of euler) out.f64(value)
  for (const value of quat) out.f64(value)
  for (const value of [0, 0, 9.81]) out.f64(value)
  for (const value of [0, 0, 0]) out.f64(value)
  return out.build()
}

export function encodeSensorJointState({ names = [], position = [], time = 0, frameId = '' } = {}) {
  const out = new Out()
  out.push(encodeHeader({ time, frameId }))
    .push(stringArray(names))
    .push(doubleArray(position))
    .push(doubleArray([]))
    .push(doubleArray([]))
  return out.build()
}

export function encodeSensorImu({ quat = [1, 0, 0, 0], time = 0, frameId = 'imu' } = {}) {
  const out = new Out()
  out.push(encodeHeader({ time, frameId }))
  // sensor_msgs/Imu stores orientation as x, y, z, w.
  for (const value of [quat[1], quat[2], quat[3], quat[0]]) out.f64(value)
  for (let index = 0; index < 9; index += 1) out.f64(0)
  for (const value of [0, 0, 0]) out.f64(value)
  for (let index = 0; index < 9; index += 1) out.f64(0)
  for (const value of [0, 0, 9.81]) out.f64(value)
  for (let index = 0; index < 9; index += 1) out.f64(0)
  return out.build()
}

export function buildRosbag({ connections, messages, compression = 'none', topLevelConnections = true }) {
  const connectionRecords = connections.map((connection) => {
    const data = header({
      topic: connection.topic,
      type: connection.type,
      md5sum: connection.md5 || '00000000000000000000000000000000',
      message_definition: connection.definition || '',
    })
    const fields = { op: new Uint8Array([0x07]), conn: new Uint8Array(new Uint32Array([connection.id]).buffer) }
    fields.topic = connection.topic
    return record(fields, data)
  })

  const messageRecords = messages.map((message) =>
    record(
      {
        op: new Uint8Array([0x02]),
        conn: new Uint8Array(new Uint32Array([message.conn]).buffer),
        time: timeBytes(message.time),
      },
      message.data,
    ),
  )

  const inner = new Out()
  for (const connection of connectionRecords) inner.push(connection)
  for (const message of messageRecords) inner.push(message)
  const raw = inner.build()
  const chunk = compression === 'lz4' ? lz4js.compress(raw) : raw

  const bagHeader = record(
    {
      op: new Uint8Array([0x03]),
      index_pos: new Uint8Array(new BigUint64Array([0n]).buffer),
      conn_count: new Uint8Array(new Uint32Array([connections.length]).buffer),
      chunk_count: new Uint8Array(new Uint32Array([1]).buffer),
    },
    new Uint8Array(0),
  )

  const chunkRecord = record(
    {
      op: new Uint8Array([0x05]),
      compression,
      size: new Uint8Array(new Uint32Array([raw.length]).buffer),
    },
    new Uint8Array(chunk),
  )

  const out = new Out()
  out.push(encoder.encode('#ROSBAG V2.0\n')).push(bagHeader)
  if (topLevelConnections) {
    for (const connection of connectionRecords) out.push(connection)
  }
  out.push(chunkRecord)
  return out.build()
}
