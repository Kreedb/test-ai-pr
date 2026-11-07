// Field-driven message decoding shared by the ROS1 bag reader and the ROS2
// MCAP / SQLite readers.
//
// Both ROS1 bags and MCAP ROS2 bags embed message definitions, so the joint and
// IMU messages are decoded from their declared fields instead of a hardcoded
// byte layout. That is what decides whether a LimX recording is a modified
// format: a standard `sensor_msgs/JointState` is parsed generically, and a
// LimX `controller_msgs/...` type is parsed by the same generic reader using
// the field names the recording ships with.

const textDecoder = new TextDecoder()

function text(bytes) {
  return textDecoder.decode(bytes)
}

const PRIMITIVES = {
  bool: ['u8', 1],
  byte: ['i8', 1],
  char: ['u8', 1],
  int8: ['i8', 1],
  uint8: ['u8', 1],
  int16: ['i16', 2],
  uint16: ['u16', 2],
  int32: ['i32', 4],
  uint32: ['u32', 4],
  int64: ['i64', 8],
  uint64: ['u64', 8],
  float32: ['f32', 4],
  float64: ['f64', 8],
}

// ROS 2 type names carry a `/msg/` segment; the rest of the app keys on the
// ROS1 spelling (`sensor_msgs/JointState`).
export function normalizeType(type = '') {
  return String(type || '')
    .trim()
    .replace(/^([^/]+)\/msg\//, '$1/')
}

function baseType(type) {
  const parts = normalizeType(type).split('/')
  return parts[parts.length - 1]
}

/** Parse a `.msg` definition (ROS1 or MCAP `ros2msg` text). */
export function parseDefinition(source) {
  const lines = String(source || '').split(/\r?\n/)
  const blocks = []
  let current = { name: '', lines: [] }
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^=+\s*$/.test(trimmed)) continue
    const marker = /^MSG:\s*(\S+)\s*$/.exec(trimmed)
    if (marker) {
      if (current.name || current.lines.some((item) => item.trim())) blocks.push(current)
      current = { name: marker[1], lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.name || current.lines.some((item) => item.trim())) blocks.push(current)

  const types = new Map()
  const register = (name, fields) => {
    const normalized = normalizeType(name).toLowerCase()
    if (!normalized) return
    types.set(normalized, fields)
    const base = baseType(normalized)
    if (base && !types.has(base)) types.set(base, fields)
  }

  const main = blocks[0]
  // A definition that starts with `MSG:` was split above; the first block then
  // only holds the main fields. Subsequent blocks are nested types.
  const fields = parseFields(main.lines)
  register(main.name, fields)
  for (let index = 1; index < blocks.length; index += 1) register(blocks[index].name, parseFields(blocks[index].lines))
  return { fields, types }
}

function parseFields(lines) {
  const fields = []
  for (const raw of lines) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line || line.includes('=')) continue
    const match = /^(\S+)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(line)
    if (!match) continue
    const [, rawType, name] = match
    const array = /^(.*)\[(\d*)\]$/.exec(rawType)
    fields.push({
      name,
      type: normalizeType(array ? array[1] : rawType),
      array: array ? { length: array[2] ? Number(array[2]) : null } : null,
    })
  }
  return fields
}

const HEADER_ROS1 = [
  { name: 'seq', type: 'uint32', array: null },
  { name: 'stamp', type: 'time', array: null },
  { name: 'frame_id', type: 'string', array: null },
]
const HEADER_ROS2 = [
  { name: 'stamp', type: 'builtin_interfaces/Time', array: null },
  { name: 'frame_id', type: 'string', array: null },
]

function builtinTypes(ros2) {
  return new Map([
    ['std_msgs/header', ros2 ? HEADER_ROS2 : HEADER_ROS1],
    ['header', ros2 ? HEADER_ROS2 : HEADER_ROS1],
    [
      'builtin_interfaces/time',
      [
        { name: 'sec', type: 'int32', array: null },
        { name: 'nanosec', type: 'uint32', array: null },
      ],
    ],
    [
      'builtin_interfaces/duration',
      [
        { name: 'sec', type: 'int32', array: null },
        { name: 'nanosec', type: 'uint32', array: null },
      ],
    ],
    [
      'geometry_msgs/quaternion',
      [
        { name: 'x', type: 'float64', array: null },
        { name: 'y', type: 'float64', array: null },
        { name: 'z', type: 'float64', array: null },
        { name: 'w', type: 'float64', array: null },
      ],
    ],
    [
      'geometry_msgs/vector3',
      [
        { name: 'x', type: 'float64', array: null },
        { name: 'y', type: 'float64', array: null },
        { name: 'z', type: 'float64', array: null },
      ],
    ],
    [
      'geometry_msgs/point',
      [
        { name: 'x', type: 'float64', array: null },
        { name: 'y', type: 'float64', array: null },
        { name: 'z', type: 'float64', array: null },
      ],
    ],
  ])
}

const JOINTS = [
  { name: 'header', type: 'std_msgs/Header', array: null },
  // ROS1 and ROS2 `sensor_msgs/JointState` call this `name`; LimX's custom
  // controller message calls it `names`.
  { name: 'name', type: 'string', array: { length: null } },
]

export function fallbackDefinition(type, ros2) {
  const normalized = normalizeType(type)
  if (normalized === 'sensor_msgs/JointState') {
    return [
      ...JOINTS,
      { name: 'position', type: 'float64', array: { length: null } },
      { name: 'velocity', type: 'float64', array: { length: null } },
      { name: 'effort', type: 'float64', array: { length: null } },
    ]
  }
  if (normalized === 'controller_msgs/JointState' || normalized === 'controller_msgs/msg/JointState') {
    return [
      { name: 'header', type: 'std_msgs/Header', array: null },
      { name: 'names', type: 'string', array: { length: null } },
      { name: 'q', type: 'float32', array: { length: null } },
      { name: 'v', type: 'float32', array: { length: null } },
      { name: 'vd', type: 'float32', array: { length: null } },
      { name: 'tau', type: 'float32', array: { length: null } },
      { name: 'na', type: 'uint32', array: null },
    ]
  }
  if (normalized === 'sensor_msgs/Imu') {
    return [
      { name: 'header', type: 'std_msgs/Header', array: null },
      { name: 'orientation', type: 'geometry_msgs/Quaternion', array: null },
      { name: 'orientation_covariance', type: 'float64', array: { length: 9 } },
      { name: 'angular_velocity', type: 'geometry_msgs/Vector3', array: null },
      { name: 'angular_velocity_covariance', type: 'float64', array: { length: 9 } },
      { name: 'linear_acceleration', type: 'geometry_msgs/Vector3', array: null },
      { name: 'linear_acceleration_covariance', type: 'float64', array: { length: 9 } },
    ]
  }
  if (normalized === 'controller_msgs/IMUData') {
    return [
      { name: 'header', type: 'std_msgs/Header', array: null },
      { name: 'imustamp', type: 'uint64', array: null },
      { name: 'status', type: 'uint32', array: null },
      { name: 'euler', type: 'float64', array: { length: 3 } },
      { name: 'quat', type: 'float64', array: { length: 4 } },
      { name: 'acc', type: 'float64', array: { length: 3 } },
      { name: 'gyro', type: 'float64', array: { length: 3 } },
    ]
  }
  return null
}

class Reader {
  constructor(bytes, { ros2 = false, bigEndian = false } = {}) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.ros2 = ros2
    this.bigEndian = bigEndian
    this.offset = ros2 ? 4 : 0
    this.base = this.offset
  }

  ensure(count) {
    if (count < 0 || this.offset + count > this.bytes.length) throw new Error('消息字段越界，文件可能被截断')
  }

  align(size) {
    if (!this.ros2 || size <= 1) return
    // CDR alignment is relative to the start of the payload after the 4-byte
    // encapsulation header, not to the file offset.
    const pad = (size - ((this.offset - this.base) % size)) % size
    this.offset += pad
    this.ensure(0)
  }

  u8() {
    this.ensure(1)
    return this.view.getUint8(this.offset++)
  }

  i8() {
    this.ensure(1)
    return this.view.getInt8(this.offset++)
  }

  u16() {
    this.align(2)
    this.ensure(2)
    const value = this.view.getUint16(this.offset, !this.bigEndian)
    this.offset += 2
    return value
  }

  i16() {
    this.align(2)
    this.ensure(2)
    const value = this.view.getInt16(this.offset, !this.bigEndian)
    this.offset += 2
    return value
  }

  u32() {
    this.align(4)
    this.ensure(4)
    const value = this.view.getUint32(this.offset, !this.bigEndian)
    this.offset += 4
    return value
  }

  i32() {
    this.align(4)
    this.ensure(4)
    const value = this.view.getInt32(this.offset, !this.bigEndian)
    this.offset += 4
    return value
  }

  u64() {
    this.align(8)
    this.ensure(8)
    const value = Number(this.view.getBigUint64(this.offset, !this.bigEndian))
    this.offset += 8
    return value
  }

  i64() {
    this.align(8)
    this.ensure(8)
    const value = Number(this.view.getBigInt64(this.offset, !this.bigEndian))
    this.offset += 8
    return value
  }

  f32() {
    this.align(4)
    this.ensure(4)
    const value = this.view.getFloat32(this.offset, !this.bigEndian)
    this.offset += 4
    return value
  }

  f64() {
    this.align(8)
    this.ensure(8)
    const value = this.view.getFloat64(this.offset, !this.bigEndian)
    this.offset += 8
    return value
  }

  string() {
    const length = this.u32()
    this.ensure(length)
    const end = this.offset + length
    // CDR strings include a trailing NUL; ROS1 strings do not.
    const slice = this.bytes.subarray(this.offset, this.ros2 && length ? end - 1 : end)
    this.offset = end
    return text(slice)
  }

  time() {
    return { sec: this.u32(), nanosec: this.ros2 ? this.u32() : this.u32() }
  }
}

const METHOD = {
  bool: 'u8',
  byte: 'i8',
  char: 'u8',
  int8: 'i8',
  uint8: 'u8',
  int16: 'i16',
  uint16: 'u16',
  int32: 'i32',
  uint32: 'u32',
  int64: 'i64',
  uint64: 'u64',
  float32: 'f32',
  float64: 'f64',
}

const MAX_ARRAY = 1 << 20

function resolveFields(type, context) {
  const normalized = normalizeType(type).toLowerCase()
  if (context.types.has(normalized)) return context.types.get(normalized)
  const base = baseType(normalized)
  return context.types.get(base) || null
}

function decodeSingle(reader, type, context, depth) {
  const normalized = normalizeType(type)
  const lower = normalized.toLowerCase()
  const primitive = PRIMITIVES[lower] || PRIMITIVES[baseType(lower)]
  if (primitive) {
    const value = reader[METHOD[lower] || METHOD[baseType(lower)]]()
    return lower === 'bool' || baseType(lower) === 'bool' ? Boolean(value) : value
  }
  if (lower === 'string') return reader.string()
  if (lower === 'time' || lower === 'duration') return reader.time()
  if (depth > 8) throw new Error(`消息类型 ${type} 嵌套过深`)
  const fields = resolveFields(type, context)
  if (!fields) throw new Error(`缺少消息定义，无法解析类型 ${type}`)
  return decodeFields(reader, fields, context, depth + 1)
}

function decodeField(reader, field, context, depth) {
  if (!field.array) return decodeSingle(reader, field.type, context, depth)
  const count = field.array.length ?? reader.u32()
  if (!Number.isFinite(count) || count < 0 || count > MAX_ARRAY) throw new Error(`消息数组长度 ${count} 不合理`)
  if (!count) return []

  const primitive = PRIMITIVES[field.type.toLowerCase()]
  if (primitive) {
    const method = METHOD[field.type.toLowerCase()]
    const values = method === 'f32' || method === 'f64' ? new Float64Array(count) : new Array(count)
    for (let index = 0; index < count; index += 1) values[index] = reader[method]()
    return values
  }
  const values = new Array(count)
  for (let index = 0; index < count; index += 1) values[index] = decodeSingle(reader, field.type, context, depth)
  return values
}

function decodeFields(reader, fields, context, depth) {
  const values = {}
  for (const field of fields) {
    values[field.name] = decodeField(reader, field, context, depth)
    if (context.stopWhen?.has(field.name)) break
  }
  return values
}

const definitions = new Map()

function definitionOf(source, ros2) {
  const key = `${ros2 ? '2' : '1'}:${source}`
  const cached = definitions.get(key)
  if (cached) return cached
  const parsed = source ? parseDefinition(source) : { fields: [], types: new Map() }
  const types = new Map(builtinTypes(ros2))
  for (const [name, fields] of parsed.types) types.set(name, fields)
  const result = { fields: parsed.fields, types }
  // Definitions come from the bag itself; keep the cache tiny so a hostile file
  // cannot grow it without bound.
  if (definitions.size > 64) definitions.clear()
  definitions.set(key, result)
  return result
}

/**
 * Decode one message. `ros2` selects CDR alignment and string framing; ROS1
 * payloads are packed. When no embedded definition is available, a built-in
 * definition for the known joint / IMU types is used.
 */
export function decodeMessage(bytes, { ros2 = false, definition = '', type = '', stopWhen = null } = {}) {
  let reader = new Reader(bytes, { ros2 })
  if (ros2) {
    if (bytes.length < 4) throw new Error('CDR 消息为空')
    // Encapsulation identifier 0x0001 is little-endian CDR, 0x0000 big-endian.
    const identifier = (bytes[0] << 8) | bytes[1]
    if (identifier !== 0 && identifier !== 1) throw new Error(`不支持的 CDR 封装 0x${identifier.toString(16)}`)
    reader = new Reader(bytes, { ros2: true, bigEndian: identifier === 0 })
  }

  const parsed = definitionOf(definition, ros2)
  const fields = parsed.fields.length ? parsed.fields : fallbackDefinition(type, ros2)
  if (!fields) throw new Error(`没有 ${type} 的消息定义`)
  return decodeFields(reader, fields, { types: parsed.types, stopWhen }, 0)
}

function hasField(fields, name) {
  return fields.some((field) => field.name === name)
}

function definitionFields(definition) {
  return definition ? parseDefinition(definition).fields : []
}

/** Classify a connection and whether it is a standard ROS message. */
export function messageProfile(type, definition = '') {
  const normalized = normalizeType(type)
  const fields = definitionFields(definition)
  const joint = (hasField(fields, 'name') || hasField(fields, 'names')) && (hasField(fields, 'q') || hasField(fields, 'position'))
  const imu = hasField(fields, 'quat') || hasField(fields, 'orientation')
  let kind = null
  if (/^(sensor_msgs|controller_msgs)\/JointState$/.test(normalized)) kind = 'joint'
  else if (/^(sensor_msgs\/Imu|controller_msgs\/IMUData)$/.test(normalized)) kind = 'imu'
  else if (fields.length && joint) kind = 'joint'
  else if (fields.length && imu) kind = 'imu'

  let family = 'custom'
  if (/^(sensor_msgs|std_msgs|geometry_msgs|builtin_interfaces)\//.test(normalized)) family = 'standard'
  else if (/^(controller_msgs|mros_msgs)\//.test(normalized)) family = 'limx'

  // A standard type whose payload moved to the LimX field names is a modified
  // recording even though the type string claims otherwise.
  let modified = false
  if (kind === 'joint' && family === 'standard' && hasField(fields, 'q') && !hasField(fields, 'position')) modified = true
  if (kind === 'imu' && family === 'standard' && hasField(fields, 'quat') && !hasField(fields, 'orientation')) modified = true
  return { kind, family, modified, standard: family === 'standard' && !modified }
}

export function messageKind(type, definition = '') {
  return messageProfile(type, definition).kind
}

function isNumbers(value) {
  return value && (Array.isArray(value) || ArrayBuffer.isView(value))
}

/** Decode a joint message into `{ names, values }` (positions in radians). */
export function decodeJointMessage(bytes, options) {
  const message = decodeMessage(bytes, { ...options, stopWhen: new Set(['position', 'q']) })
  const names = Array.isArray(message.names) ? message.names : Array.isArray(message.name) ? message.name : []
  const position = isNumbers(message.position) ? message.position : null
  const q = isNumbers(message.q) ? message.q : null
  const values = position || q
  if (!values?.length) throw new Error('消息里没有关节角度（position / q）')
  return { names, values, field: position ? 'position' : 'q' }
}

function vectorOf(value) {
  if (isNumbers(value)) return value.length >= 3 ? [value[0], value[1], value[2]] : [0, 0, 0]
  if (value && typeof value === 'object') return [value.x || 0, value.y || 0, value.z || 0]
  return null
}

/**
 * Decode an IMU message. The quaternion is normalized to `[w, x, y, z]`;
 * `sensor_msgs/Imu` stores `[x, y, z, w]` and LimX's message stores `[w, x,
 * y, z]`.
 */
export function decodeImuMessage(bytes, options) {
  const message = decodeMessage(bytes, { ...options, stopWhen: new Set(['gyro', 'linear_acceleration']) })
  let quat = [1, 0, 0, 0]
  if (isNumbers(message.quat) && message.quat.length >= 4) quat = [message.quat[0], message.quat[1], message.quat[2], message.quat[3]]
  else if (message.orientation && typeof message.orientation === 'object') {
    const { x = 0, y = 0, z = 0, w = 1 } = message.orientation
    quat = [w, x, y, z]
  }
  return { quat, acc: vectorOf(message.acc || message.linear_acceleration), gyro: vectorOf(message.gyro || message.angular_velocity) }
}
