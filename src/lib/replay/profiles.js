// Robot profiles map recorded joint columns to a kinematic skeleton. The
// skeleton itself lives in a URDF under `public/robots`, so adding or editing a
// vendor model does not mean editing JavaScript.

const LUNA_ORDER = [
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_hip_yaw_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_hip_yaw_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'waist_yaw_joint',
  'waist_roll_joint',
  'waist_pitch_joint',
  'head_yaw_joint',
  'head_pitch_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_yaw_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_yaw_joint',
]

const OLI_ORDER = [
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_hip_yaw_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_hip_yaw_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'waist_yaw_joint',
  'waist_roll_joint',
  'waist_pitch_joint',
  'head_yaw_joint',
  'head_pitch_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_yaw_joint',
  'left_wrist_pitch_joint',
  'left_wrist_roll_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_yaw_joint',
  'right_wrist_pitch_joint',
  'right_wrist_roll_joint',
]

const TRON_ORDER = ['proximal_pitch_L', 'proximal_roll_L', 'proximal_yaw_L', 'knee_L', 'wheel_L', 'proximal_pitch_R', 'proximal_roll_R', 'proximal_yaw_R', 'knee_R', 'wheel_R']

const LUNA_MESH_BASE = 'https://raw.githubusercontent.com/limxdynamics/luna-description/main/HU_L04_description/'

function makeProfile(id, label, urdf, order, extra = {}) {
  return { id, label, urdf, skeleton: null, order, joints: new Set(order), aliases: null, ...extra }
}

const LUNA_PROFILE = makeProfile('luna', 'LimX Luna（HU_L04，27 关节）', 'robots/luna.urdf', LUNA_ORDER, { meshBase: LUNA_MESH_BASE })
const OLI_PROFILE = makeProfile('oli', 'LimX Oli（HU_D04，31 关节）', 'robots/oli.urdf', OLI_ORDER)
const TRON_PROFILE = makeProfile('tron2a', 'LimX TRON2A（10 关节）', 'robots/tron2a.urdf', TRON_ORDER)
// URDF exports spell the TRON joints with a `_Joint` suffix; bag configs drop it.
TRON_PROFILE.aliases = (name) => name.replace(/_Joint$/i, '')

/** Attach a parsed URDF skeleton to a detected profile. */
export function attachSkeleton(profile, skeleton) {
  const joints = new Set(skeleton.filter((node) => node.joint && node.axis).map((node) => node.joint))
  return { ...profile, skeleton, joints, order: profile.order || [...joints] }
}

// Common URDF-style names from other humanoids can be mapped onto the Luna
// skeleton when the part and axis are spelled out. Vendor-specific profiles
// still win; this only covers standard `<side>_<part>_<axis>_joint` names.
function canonicalJoint(name) {
  const normalized = String(name)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  const tokens = normalized.split('_').filter(Boolean)
  const side = tokens.includes('left') || tokens.includes('l') ? 'left' : tokens.includes('right') || tokens.includes('r') ? 'right' : ''
  const part = ['hip', 'knee', 'ankle', 'shoulder', 'elbow', 'wrist', 'head', 'waist', 'torso'].find((token) => tokens.includes(token))
  if (!part) return null
  if (part === 'knee') return side ? `${side}_knee_joint` : null
  if (part === 'elbow') return side ? `${side}_elbow_joint` : null
  // Remaining joints carry their rotation axis in the name; ankle defaults to
  // pitch when the axis token is omitted.
  const axis = ['pitch', 'roll', 'yaw'].find((token) => tokens.includes(token)) || (part === 'ankle' ? 'pitch' : null)
  if (!axis) return null
  if (part === 'torso') return `waist_${axis}_joint`
  if (part === 'head') return `head_${axis}_joint`
  if (part === 'waist') return `waist_${axis}_joint`
  if (!side) return null
  return `${side}_${part}_${axis}_joint`
}

const GENERIC_PROFILE = {
  ...makeProfile('generic', '通用人形骨架（按标准关节名推断）', 'robots/luna.urdf', LUNA_ORDER, { meshBase: LUNA_MESH_BASE }),
  aliases: canonicalJoint,
}

export const ROBOT_PROFILES = [LUNA_PROFILE, OLI_PROFILE, TRON_PROFILE]
/** Manual picker options, including the generic fallback skeleton. */
export const ALL_PROFILES = [LUNA_PROFILE, OLI_PROFILE, TRON_PROFILE, GENERIC_PROFILE]

function profileJoint(profile, name) {
  if (profile.joints.has(name)) return name
  const alias = profile.aliases?.(name)
  return alias && profile.joints.has(alias) ? alias : null
}

export function detectProfile(names, jointCount, named = true) {
  if (!named || !names?.length) {
    if (jointCount === LUNA_ORDER.length) return LUNA_PROFILE
    if (jointCount === OLI_ORDER.length) return OLI_PROFILE
    if (jointCount === TRON_ORDER.length) return TRON_PROFILE
    return {
      id: 'index',
      label: `索引关节（${jointCount}）`,
      skeleton: null,
      order: null,
      joints: new Set(),
      aliases: null,
    }
  }

  let best = null
  let bestScore = 0
  for (const profile of ROBOT_PROFILES) {
    const score = names.filter((name) => profileJoint(profile, name)).length / names.length
    if (score > bestScore) {
      best = profile
      bestScore = score
    }
  }
  if (best && bestScore >= 0.6) return best

  const mapped = names.filter((name) => profileJoint(GENERIC_PROFILE, name)).length
  if (mapped >= Math.min(names.length, 4)) return GENERIC_PROFILE

  return {
    id: 'unknown',
    label: '未识别关节名',
    skeleton: null,
    order: null,
    joints: new Set(),
    aliases: null,
  }
}

/**
 * Resolve each recorded column to a skeleton joint once, then apply per frame.
 * Returns `{ entries, unmapped }`; `entries` holds `{ index, joint }`.
 */
export function mapJoints(profile, series) {
  const entries = []
  const unmapped = []
  if (!profile?.skeleton || !series) return { entries, unmapped }

  if (!series.named) {
    const order = profile.order || []
    for (let index = 0; index < series.names.length; index += 1) {
      if (order[index]) entries.push({ index, joint: order[index] })
    }
    return { entries, unmapped }
  }

  for (let index = 0; index < series.names.length; index += 1) {
    const name = series.names[index]
    const joint = profileJoint(profile, name)
    if (joint) entries.push({ index, joint })
    else unmapped.push(name)
  }
  return { entries, unmapped }
}
