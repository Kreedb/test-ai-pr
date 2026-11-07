// CDR + MCAP writers for the replay regression tests. They emit the same
// encapsulation and record layout `ros2 bag record -s mcap` produces for
// JointState / Imu, including lz4 chunk compression.

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

  u8(value) {
    return this.push(new Uint8Array([value & 0xff]))
  }

  u16(value) {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setUint16(0, value, true)
    return this.push(bytes)
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

class Cdr {
  constructor() {
    this.bytes = new Uint8Array(64 * 1024)
    this.view = new DataView(this.bytes.buffer)
    this.offset = 4
  }

  align(size) {
    this.offset += (size - ((this.offset - 4) % size)) % size
  }

  u32(value) {
    this.align(4)
    this.view.setUint32(this.offset, value, true)
    this.offset += 4
  }

  f64(value) {
    this.align(8)
    this.view.setFloat64(this.offset, value, true)
    this.offset += 8
  }

  str(value) {
    const bytes = encoder.encode(value)
    this.u32(bytes.length + 1)
    this.bytes.set(bytes, this.offset)
    this.offset += bytes.length
    this.bytes[this.offset++] = 0
  }

  header() {
    this.u32(0) // sec
    this.u32(0) // nanosec
    this.str('')
  }

  build() {
    const bytes = this.bytes.slice(0, this.offset)
    bytes[0] = 0
    bytes[1] = 1 // CDR little endian
    return bytes
  }
}

export function encodeCdrJointState({ names = [], position = [] } = {}) {
  const cdr = new Cdr()
  cdr.header()
  cdr.u32(names.length)
  for (const name of names) cdr.str(name)
  cdr.u32(position.length)
  for (const value of position) cdr.f64(value)
  cdr.u32(0)
  cdr.u32(0)
  return cdr.build()
}

export function encodeCdrImu({ quat = [1, 0, 0, 0], acc = [0, 0, 9.81], gyro = [0, 0, 0] } = {}) {
  const cdr = new Cdr()
  cdr.header()
  for (const value of [quat[1], quat[2], quat[3], quat[0]]) cdr.f64(value)
  for (let index = 0; index < 9; index += 1) cdr.f64(0)
  for (const value of gyro) cdr.f64(value)
  for (let index = 0; index < 9; index += 1) cdr.f64(0)
  for (const value of acc) cdr.f64(value)
  for (let index = 0; index < 9; index += 1) cdr.f64(0)
  return cdr.build()
}

export const JOINT_DEFINITION = `std_msgs/Header header
string[] name
float64[] position
float64[] velocity
float64[] effort
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
`

export const IMU_DEFINITION = `std_msgs/Header header
geometry_msgs/Quaternion orientation
float64[9] orientation_covariance
geometry_msgs/Vector3 angular_velocity
float64[9] angular_velocity_covariance
geometry_msgs/Vector3 linear_acceleration
float64[9] linear_acceleration_covariance
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
`

function record(opcode, data) {
  return new Out().u8(opcode).u64(data.length).push(data).build()
}

export function buildMcap({ channels, messages, compression = 'none', chunked = true }) {
  const parts = []
  const header = new Out().str('').str('').build()
  parts.push(record(0x01, header))

  for (const channel of channels) {
    const schema = new Out().u16(channel.id).str(channel.type).str('ros2msg')
    const definition = encoder.encode(channel.definition || '')
    schema.u32(definition.length).push(definition)
    parts.push(record(0x03, schema.build()))

    const meta = new Out().u16(channel.id).u16(channel.id).str(channel.topic).str('cdr')
    const metadata = new Out()
    for (const [key, value] of Object.entries(channel.metadata || {})) metadata.str(key).str(value)
    const metadataBytes = metadata.build()
    meta.u32(metadataBytes.length).push(metadataBytes)
    parts.push(record(0x04, meta.build()))
  }

  const encoded = messages.map((message) => {
    const data = new Out().u16(message.channel).u32(0).u64(message.logTime).u64(message.logTime).push(message.data).build()
    return record(0x05, data)
  })

  if (chunked) {
    const raw = new Out()
    for (const bytes of encoded) raw.push(bytes)
    const payload = raw.build()
    const compressed = compression === 'lz4' ? lz4js.compress(payload) : payload
    const start = messages[0].logTime
    const end = messages[messages.length - 1].logTime
    const chunk = new Out().u64(start).u64(end).u64(payload.length).u32(0).str(compression).u64(compressed.length).push(compressed).build()
    parts.push(record(0x06, chunk))
  } else {
    for (const bytes of encoded) parts.push(bytes)
  }

  parts.push(record(0x0c, new Out().u32(0).build()))
  const out = new Out()
  out.push(new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]))
  for (const part of parts) out.push(part)
  out.push(new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]))
  return out.build()
}
