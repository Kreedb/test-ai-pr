// Regression tests for the ROS1 bag reader, robot profile matching and the
// forward-kinematics pose used by the replay page.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DOMParser } from '@xmldom/xmldom'

import { buildJointValues, computePose, normalizeQuat, quatToEuler } from '../../src/lib/replay/pose.js'
import { attachSkeleton, detectProfile, mapJoints } from '../../src/lib/replay/profiles.js'
import { inspectRosbag, readRosbag } from '../../src/lib/replay/rosbag.js'
import { parseUrdf } from '../../src/lib/replay/urdf.js'
import { buildRosbag, encodeImu, encodeJointState, encodeSensorImu, encodeSensorJointState, record } from './rosbag-fixture.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
function skeletonOf(name) {
  return parseUrdf(readFileSync(join(root, `public/robots/${name}.urdf`), 'utf8'), { parseXml: DOMParser })
}
const luna = skeletonOf('luna')
const oli = skeletonOf('oli')
const tron = skeletonOf('tron2a')
const lunaSkeleton = luna.skeleton
const lunaNames = [...luna.joints]
const oliNames = [...oli.joints]
const tronNames = [...tron.joints]

function bag(messages, connections, compression = 'lz4') {
  return buildRosbag({ connections, messages, compression })
}

const JOINT_CONNECTION = { id: 0, topic: '/joint/state', type: 'controller_msgs/JointState' }
const IMU_CONNECTION = { id: 1, topic: '/ImuData', type: 'controller_msgs/IMUData' }

test('inspects connections without decoding chunks', () => {
  const bytes = bag([{ conn: 0, time: 10, data: encodeJointState({ names: ['a'], position: [0], time: 10 }) }], [JOINT_CONNECTION])
  const info = inspectRosbag(bytes)
  assert.deepEqual(
    info.topics.map((topic) => [topic.name, topic.type, topic.kind]),
    [['/joint/state', 'controller_msgs/JointState', 'joint']],
  )
})

test('finds connection metadata stored inside chunks (active recording)', () => {
  const bytes = buildRosbag({
    connections: [JOINT_CONNECTION, IMU_CONNECTION],
    messages: [
      { conn: 0, time: 10, data: encodeJointState({ names: ['a'], position: [0.5], time: 10 }) },
      { conn: 1, time: 10, data: encodeImu({ quat: [0.5, 0.5, 0.5, 0.5], time: 10 }) },
    ],
    compression: 'lz4',
    topLevelConnections: false,
  })
  const info = inspectRosbag(bytes)
  assert.deepEqual(
    info.topics.map((topic) => [topic.name, topic.kind]),
    [
      ['/ImuData', 'imu'],
      ['/joint/state', 'joint'],
    ],
  )
  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state', '/ImuData'] })
  assert.equal(series['/joint/state'].count, 1)
  assert.equal(series['/ImuData'].count, 1)
  assert.deepEqual(warnings, [])
})

test('keeps complete records when an active recording has a truncated tail', () => {
  const full = buildRosbag({
    connections: [JOINT_CONNECTION],
    messages: [{ conn: 0, time: 10, data: encodeJointState({ names: ['a'], position: [0.5], time: 10 }) }],
    compression: 'lz4',
    topLevelConnections: false,
  })
  // An interrupted writer leaves a complete chunk header whose declared data
  // never arrived. Truncate the record body but keep header and length.
  const dangling = record(
    {
      op: new Uint8Array([0x05]),
      compression: 'lz4',
      size: new Uint8Array(new Uint32Array([0]).buffer),
    },
    new Uint8Array([1, 2, 3]),
  ).slice(0, -3)
  const bytes = new Uint8Array(full.length + dangling.length)
  bytes.set(full)
  bytes.set(dangling, full.length)

  const info = inspectRosbag(bytes)
  assert.deepEqual(
    info.topics.map((topic) => topic.name),
    ['/joint/state'],
  )
  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state'] })
  assert.equal(series['/joint/state'].count, 1)
  assert.ok(warnings.some((warning) => /尾部记录不完整/.test(warning.message)))
})

test('skips an unfinished zero-length lz4 chunk', () => {
  const full = bag([{ conn: 0, time: 10, data: encodeJointState({ names: ['a'], position: [0.5], time: 10 }) }], [JOINT_CONNECTION])
  // rosbag writers leave the open chunk header at size 0 until it is closed.
  const empty = record(
    {
      op: new Uint8Array([0x05]),
      compression: 'lz4',
      size: new Uint8Array(new Uint32Array([0]).buffer),
    },
    new Uint8Array(0),
  )
  const bytes = new Uint8Array(full.length + empty.length)
  bytes.set(full)
  bytes.set(empty, full.length)

  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state'] })
  assert.equal(series['/joint/state'].count, 1)
  assert.deepEqual(warnings, [])
})

test('does not offer unsupported JointState-like types', () => {
  const bytes = bag([{ conn: 0, time: 10, data: encodeJointState({ names: ['a'], position: [0], time: 10 }) }], [{ id: 0, topic: '/joint/state', type: 'my_robot/JointState' }])
  const info = inspectRosbag(bytes)
  assert.deepEqual(
    info.topics.map((topic) => topic.kind),
    [null],
  )
})

test('decodes named joint state and IMU from an lz4 chunk', () => {
  const bytes = bag(
    [
      {
        conn: 0,
        time: 10,
        data: encodeJointState({
          names: lunaNames,
          position: lunaNames.map((_, index) => index / 10),
          time: 10,
        }),
      },
      { conn: 1, time: 10, data: encodeImu({ quat: [0.5, 0.5, 0.5, 0.5], time: 10 }) },
      {
        conn: 0,
        time: 10.1,
        data: encodeJointState({ names: lunaNames, position: lunaNames.map(() => 1), time: 10.1 }),
      },
    ],
    [JOINT_CONNECTION, IMU_CONNECTION],
  )

  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state', '/ImuData'] })
  const joint = series['/joint/state']
  const imu = series['/ImuData']
  assert.equal(joint.count, 2)
  assert.equal(joint.named, true)
  assert.deepEqual(joint.names, lunaNames)
  assert.equal(joint.columns.length, lunaNames.length)
  assert.equal(joint.columns[0][0], 0)
  assert.equal(joint.columns[0][1], 1)
  assert.equal(imu.count, 1)
  assert.deepEqual([...imu.quat[0]], [0.5])
  assert.deepEqual(warnings, [])
})

test('reads unnamed joint state by hardware index', () => {
  const bytes = bag(
    [
      {
        conn: 0,
        time: 5,
        data: encodeJointState({ names: [], position: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], time: 5 }),
      },
    ],
    [JOINT_CONNECTION],
  )
  const joint = readRosbag(bytes, { topics: ['/joint/state'] }).series['/joint/state']
  assert.equal(joint.named, false)
  assert.deepEqual(joint.names.slice(0, 3), ['q_0', 'q_1', 'q_2'])
  assert.equal(joint.columns[9][0], 9)
  assert.equal(detectProfile(joint.names, joint.names.length, joint.named).id, 'tron2a')
})

test('decodes standard sensor_msgs JointState and Imu', () => {
  const bytes = bag(
    [
      {
        conn: 0,
        time: 2,
        data: encodeSensorJointState({
          names: ['left_hip_pitch_joint', 'left_knee_joint'],
          position: [0.4, -0.25],
          time: 2,
        }),
      },
      { conn: 1, time: 2, data: encodeSensorImu({ quat: [0.7071, 0, 0.7071, 0], time: 2 }) },
    ],
    [
      { id: 0, topic: '/joint_states', type: 'sensor_msgs/JointState' },
      { id: 1, topic: '/imu/data', type: 'sensor_msgs/Imu' },
    ],
  )
  const { series } = readRosbag(bytes, { topics: ['/joint_states', '/imu/data'] })
  assert.ok(Math.abs(series['/joint_states'].columns[0][0] - 0.4) < 1e-6)
  assert.ok(Math.abs(series['/joint_states'].columns[1][0] + 0.25) < 1e-6)
  // sensor_msgs/Imu is x,y,z,w; the reader normalizes to w,x,y,z.
  assert.ok(Math.abs(series['/imu/data'].quat[0][0] - 0.7071) < 1e-6)
  assert.ok(Math.abs(series['/imu/data'].quat[2][0] - 0.7071) < 1e-6)
})

test('keeps the last message when a timestamp repeats', () => {
  const bytes = bag(
    [
      { conn: 0, time: 1, data: encodeJointState({ names: ['a'], position: [1], time: 1 }) },
      { conn: 0, time: 1, data: encodeJointState({ names: ['a'], position: [2], time: 1 }) },
    ],
    [JOINT_CONNECTION],
  )
  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state'] })
  assert.equal(series['/joint/state'].count, 1)
  assert.equal(series['/joint/state'].columns[0][0], 2)
  assert.match(warnings[0].message, /重复时间戳/)
})

test('merges messages from two connections on the same topic', () => {
  const bytes = bag(
    [
      { conn: 0, time: 1, data: encodeJointState({ names: ['a'], position: [1], time: 1 }) },
      { conn: 2, time: 2, data: encodeJointState({ names: ['a'], position: [2], time: 2 }) },
    ],
    [
      { id: 0, topic: '/joint/state', type: 'controller_msgs/JointState' },
      { id: 2, topic: '/joint/state', type: 'controller_msgs/JointState' },
    ],
  )
  const { series, warnings } = readRosbag(bytes, { topics: ['/joint/state'] })
  assert.equal(series['/joint/state'].count, 2)
  assert.deepEqual([...series['/joint/state'].columns[0]], [1, 2])
  assert.ok(warnings.some((warning) => warning.message.includes('多个连接')))
})

test('rejects backwards timestamps and unsupported compression', () => {
  const backwards = bag(
    [
      { conn: 0, time: 2, data: encodeJointState({ names: ['a'], position: [1], time: 2 }) },
      { conn: 0, time: 1, data: encodeJointState({ names: ['a'], position: [2], time: 1 }) },
    ],
    [JOINT_CONNECTION],
  )
  assert.throws(() => readRosbag(backwards, { topics: ['/joint/state'] }), /时间戳倒退/)

  const bz2 = bag([{ conn: 0, time: 1, data: encodeJointState({ names: ['a'], position: [1], time: 1 }) }], [JOINT_CONNECTION], 'bz2')
  assert.throws(() => readRosbag(bz2, { topics: ['/joint/state'] }), /暂不支持 bz2 压缩/)
})

test('rejects data without the ROS1 bag header', () => {
  assert.throws(() => inspectRosbag(new Uint8Array([1, 2, 3])), /不是 ROS1 bag v2/)
})

test('detects Luna, Oli and TRON profiles by name or index count', () => {
  assert.equal(detectProfile(lunaNames, lunaNames.length, true).id, 'luna')
  assert.equal(detectProfile(oliNames, oliNames.length, true).id, 'oli')
  assert.equal(detectProfile(tronNames, tronNames.length, true).id, 'tron2a')
  const urdfNames = tronNames.map((name) => `${name}_Joint`)
  const urdfProfile = detectProfile(urdfNames, urdfNames.length, true)
  assert.equal(urdfProfile.id, 'tron2a')
  assert.equal(mapJoints(attachSkeleton(urdfProfile, tron.skeleton), { names: urdfNames, named: true }).entries.length, 10)
  assert.equal(detectProfile(lunaNames, lunaNames.length, false).id, 'luna')
  assert.equal(detectProfile([], 10, false).id, 'tron2a')
  assert.equal(detectProfile([], 27, false).id, 'luna')
})

test('maps standard URDF-style names onto the generic skeleton', () => {
  const names = ['left_hip_pitch', 'right_knee', 'waist_yaw', 'head_yaw']
  const profile = detectProfile(names, names.length, true)
  assert.equal(profile.id, 'generic')
  const { entries, unmapped } = mapJoints(attachSkeleton(profile, lunaSkeleton), {
    names,
    named: true,
    columns: names.map(() => new Float32Array(1)),
  })
  assert.deepEqual(
    entries.map((entry) => entry.joint),
    ['left_hip_pitch_joint', 'right_knee_joint', 'waist_yaw_joint', 'head_yaw_joint'],
  )
  assert.deepEqual(unmapped, [])
})

test('forward kinematics follows joint angles and base rotation', () => {
  const zeros = new Map()
  const neutral = computePose(lunaSkeleton, zeros, [1, 0, 0, 0])
  assert.deepEqual(neutral.points[0], [0, 0, lunaSkeleton[0].offset[2]])

  const hipIndex = lunaSkeleton.findIndex((node) => node.name === 'left_hip_pitch_link')
  const kneeIndex = lunaSkeleton.findIndex((node) => node.name === 'left_hip_roll_link')
  const bent = computePose(lunaSkeleton, new Map([['left_hip_pitch_joint', 0.5]]), [1, 0, 0, 0])
  assert.notDeepEqual(bent.points[kneeIndex], neutral.points[kneeIndex])

  const yaw90 = computePose(lunaSkeleton, zeros, normalizeQuat([Math.SQRT1_2, 0, 0, Math.SQRT1_2]))
  assert.ok(Math.abs(yaw90.points[hipIndex][0] + neutral.points[hipIndex][1]) < 1e-6)
  assert.ok(Math.abs(yaw90.points[hipIndex][1] - neutral.points[hipIndex][0]) < 1e-6)

  const euler = quatToEuler(normalizeQuat([0, 1, 0, 0]))
  assert.deepEqual(
    euler.map((value) => Math.round(value)),
    [180, 0, 0],
  )
})

test('the committed Luna demo bag parses and reaches a pose', () => {
  const bytes = new Uint8Array(readFileSync(join(root, 'public/samples/replay/luna-demo.bag')))
  const info = inspectRosbag(bytes)
  assert.ok(info.topics.some((topic) => topic.name === '/joint/state' && topic.kind === 'joint'))
  const { series } = readRosbag(bytes, { topics: ['/joint/state', '/ImuData'] })
  const joint = series['/joint/state']
  const profile = detectProfile(joint.names, joint.names.length, joint.named)
  assert.equal(profile.id, 'luna')
  const { entries } = mapJoints(attachSkeleton(profile, lunaSkeleton), joint)
  assert.equal(entries.length, 27)
  const pose = computePose(lunaSkeleton, buildJointValues(joint, entries, 0), [1, 0, 0, 0])
  assert.equal(pose.points.length, lunaSkeleton.length)
  assert.ok(pose.points.every((point) => point.every(Number.isFinite)))
})
