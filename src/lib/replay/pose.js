// Forward kinematics for the replay skeleton. Matrices are column-major 4x4
// arrays, matching what the canvas view expects from a transform position.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(left, right) {
  const out = new Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = left[row] * right[column * 4] + left[4 + row] * right[column * 4 + 1] + left[8 + row] * right[column * 4 + 2] + left[12 + row] * right[column * 4 + 3]
    }
  }
  return out
}

function translation([x, y, z]) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

function quatMatrix(quat) {
  if (!quat) return IDENTITY
  const [w, x, y, z] = quat
  const norm = Math.hypot(w, x, y, z)
  if (!Number.isFinite(norm) || norm < 1e-9) return IDENTITY
  const nw = w / norm
  const nx = x / norm
  const ny = y / norm
  const nz = z / norm
  const xx = nx * nx
  const yy = ny * ny
  const zz = nz * nz
  const xy = nx * ny
  const xz = nx * nz
  const yz = ny * nz
  const wx = nw * nx
  const wy = nw * ny
  const wz = nw * nz
  // prettier-ignore
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ]
}

function rpyMatrix(rpy) {
  if (!rpy) return IDENTITY
  const [roll, pitch, yaw] = rpy
  if (!roll && !pitch && !yaw) return IDENTITY
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  // R = Rz(yaw) * Ry(pitch) * Rx(roll), written column-major.
  // prettier-ignore
  return [
    cy * cp, sy * cp, -sp, 0,
    cy * sp * sr - sy * cr, sy * sp * sr + cy * cr, cp * sr, 0,
    cy * sp * cr + sy * sr, sy * sp * cr - cy * sr, cp * cr, 0,
    0, 0, 0, 1,
  ]
}

function axisAngle(axis, angle) {
  const length = Math.hypot(axis[0], axis[1], axis[2])
  if (!Number.isFinite(length) || length < 1e-9) return IDENTITY
  const x = axis[0] / length
  const y = axis[1] / length
  const z = axis[2] / length
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  // prettier-ignore
  return [
    c + x * x * t, y * x * t + z * s, z * x * t - y * s, 0,
    x * y * t - z * s, c + y * y * t, z * y * t + x * s, 0,
    x * z * t + y * s, y * z * t - x * s, c + z * z * t, 0,
    0, 0, 0, 1,
  ]
}

/**
 * Apply joint angles and a base quaternion to the skeleton.
 * Returns `{ points, transforms }` in skeleton order.
 */
export function computePose(skeleton, jointValues, baseQuat) {
  const points = []
  const transforms = []
  const indices = new Map(skeleton.map((node, index) => [node.name, index]))

  for (let index = 0; index < skeleton.length; index += 1) {
    const node = skeleton[index]
    const parentIndex = node.parent === null ? null : indices.get(node.parent)
    let matrix
    if (parentIndex === undefined || parentIndex === null) {
      // Rotate around the model origin, then place the base at its rest height.
      matrix = multiply(translation(node.offset), rpyMatrix(node.rpy))
      matrix = multiply(matrix, quatMatrix(baseQuat))
    } else {
      matrix = multiply(transforms[parentIndex], translation(node.offset))
      matrix = multiply(matrix, rpyMatrix(node.rpy))
      const angle = node.joint ? jointValues.get(node.joint) : undefined
      if (node.joint && node.axis && Number.isFinite(angle)) {
        matrix = multiply(matrix, axisAngle(node.axis, angle))
      }
    }
    transforms.push(matrix)
    points.push([matrix[12], matrix[13], matrix[14]])
  }
  return { points, transforms }
}

export function normalizeQuat(quat) {
  if (!quat) return [1, 0, 0, 0]
  const [w, x, y, z] = quat
  const norm = Math.hypot(w, x, y, z)
  if (!Number.isFinite(norm) || norm < 1e-9) return [1, 0, 0, 0]
  return [w / norm, x / norm, y / norm, z / norm]
}

/** Return ZYX Euler angles in degrees for the pose panel. */
export function quatToEuler(quat) {
  const [w, x, y, z] = normalizeQuat(quat)
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))))
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  return [roll, pitch, yaw].map((value) => (value * 180) / Math.PI)
}

export function buildJointValues(series, entries, frame) {
  const values = new Map()
  if (!series) return values
  for (const { index, joint } of entries) {
    values.set(joint, series.columns[index][frame])
  }
  return values
}
