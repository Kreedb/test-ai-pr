// ROS2 MCAP / sqlite3 and URDF regression tests for the replay page.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DOMParser } from '@xmldom/xmldom'

import { inspectBag, readBag, sniffBagFormat } from '../../src/lib/replay/bag.js'
import { decodeImuMessage, decodeJointMessage, messageProfile, parseDefinition } from '../../src/lib/replay/rosmsg.js'
import { parseStl, parseUrdf } from '../../src/lib/replay/urdf.js'
import { buildMcap, encodeCdrImu, encodeCdrJointState, IMU_DEFINITION, JOINT_DEFINITION } from './ros2-fixture.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sqliteBytes = new Uint8Array(readFileSync(join(root, 'test/fixtures/ros2.db3')))

function mcapBytes(compression) {
  return buildMcap({
    channels: [
      { id: 0, topic: '/joint/state', type: 'sensor_msgs/msg/JointState', definition: JOINT_DEFINITION, metadata: { topic_type_hash: 'abc', offered_qos_profiles: 'x' } },
      { id: 1, topic: '/imu/data', type: 'sensor_msgs/msg/Imu', definition: IMU_DEFINITION },
    ],
    messages: [
      { channel: 0, logTime: 1_700_000_000_000_000_000n, data: encodeCdrJointState({ names: ['a', 'b'], position: [0.5, -0.5] }) },
      { channel: 0, logTime: 1_700_000_001_000_000_000n, data: encodeCdrJointState({ names: ['a', 'b'], position: [1, -1] }) },
      { channel: 1, logTime: 1_700_000_000_000_000_000n, data: encodeCdrImu({ quat: [1, 0, 0, 0] }) },
    ],
    compression,
  })
}

test('detects ROS1, MCAP and sqlite bags from their magic', () => {
  const ros1 = new Uint8Array(readFileSync(join(root, 'public/samples/replay/luna-demo.bag')))
  assert.equal(sniffBagFormat(ros1), 'ros1')
  assert.equal(sniffBagFormat(mcapBytes('none')), 'mcap')
  assert.equal(sniffBagFormat(sqliteBytes), 'sqlite')
  assert.equal(sniffBagFormat(new Uint8Array([1, 2, 3])), null)
})

test('reads MCAP messages with and without lz4 chunks', () => {
  for (const compression of ['none', 'lz4']) {
    const bytes = mcapBytes(compression)
    const info = inspectBag([{ name: 'demo.mcap', bytes }], 'mcap')
    assert.equal(info.format, 'mcap')
    assert.deepEqual(
      info.topics.map((topic) => [topic.name, topic.kind, topic.standard]),
      [
        ['/imu/data', 'imu', true],
        ['/joint/state', 'joint', true],
      ],
    )
    const decoded = readBag([{ name: 'demo.mcap', bytes }], { topics: ['/joint/state', '/imu/data'] })
    assert.equal(decoded.series['/joint/state'].count, 2)
    assert.deepEqual(decoded.series['/joint/state'].names, ['a', 'b'])
    assert.deepEqual([...decoded.series['/joint/state'].columns[0]], [0.5, 1])
    assert.deepEqual([...decoded.series['/imu/data'].quat[0]], [1])
    assert.equal(decoded.series['/imu/data'].hasAcc, true)
  }
})

test('reads a ROS2 sqlite3 bag', () => {
  const info = inspectBag([{ name: 'demo.db3', bytes: sqliteBytes }], 'sqlite')
  assert.equal(info.format, 'sqlite')
  assert.ok(info.topics.some((topic) => topic.name === '/joint/state' && topic.kind === 'joint'))
  const decoded = readBag([{ name: 'demo.db3', bytes: sqliteBytes }], { topics: ['/joint/state', '/imu/data'] })
  assert.equal(decoded.series['/joint/state'].count, 2)
  assert.deepEqual(decoded.series['/joint/state'].names, ['a', 'b'])
  assert.deepEqual([...decoded.series['/joint/state'].columns[1]], [-0.5, -0.5])
  assert.equal(decoded.series['/imu/data'].count, 1)
})

test('manual format selection rejects a mismatched file', () => {
  assert.throws(() => inspectBag([{ name: 'demo.mcap', bytes: mcapBytes('none') }], 'sqlite'), /不一致/)
  assert.throws(() => readBag([{ name: 'demo.db3', bytes: sqliteBytes }], { format: 'ros1', topics: [] }), /不一致/)
})

test('recognizes standard and modified LimX message definitions', () => {
  const standard = messageProfile('sensor_msgs/msg/JointState', JOINT_DEFINITION)
  assert.deepEqual([standard.kind, standard.standard, standard.modified], ['joint', true, false])

  const modified = messageProfile('sensor_msgs/JointState', 'std_msgs/Header header\nstring[] name\nfloat32[] q\n')
  assert.deepEqual([modified.kind, modified.family, modified.modified], ['joint', 'standard', true])

  const limx = messageProfile('controller_msgs/JointState', 'std_msgs/Header header\nstring[] names\nfloat32[] q\n')
  assert.deepEqual([limx.kind, limx.family, limx.standard], ['joint', 'limx', false])
})

test('decodes CDR produced by an independent ROS2 implementation', () => {
  // Generated with `rosbags` (https://github.com/ternaris/rosbags) from
  // sensor_msgs/msg/JointState and sensor_msgs/msg/Imu. This pins the CDR
  // alignment origin, which differs from a naive absolute file offset.
  const joint = '0001000000000000000000000100000000000000020000000200000061000000020000006200000002000000000000000000e03f000000000000e0bf0000000000000000'
  const imu =
    '0001000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f85eb51b89e2340000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))
  const jointMessage = decodeJointMessage(bytes(joint), { ros2: true, type: 'sensor_msgs/msg/JointState' })
  assert.deepEqual(jointMessage.names, ['a', 'b'])
  assert.deepEqual([...jointMessage.values], [0.5, -0.5])
  const imuMessage = decodeImuMessage(bytes(imu), { ros2: true, type: 'sensor_msgs/msg/Imu' })
  assert.deepEqual(imuMessage.quat, [1, 0, 0, 0])
  assert.deepEqual(imuMessage.acc, [0, 0, 9.81])
})

test('parses nested message definition blocks', () => {
  const parsed = parseDefinition(JOINT_DEFINITION)
  assert.deepEqual(
    parsed.fields.map((field) => field.name),
    ['header', 'name', 'position', 'velocity', 'effort'],
  )
  assert.ok(parsed.types.has('std_msgs/header'))
})

test('parses URDF joints, fixed links and mesh references', () => {
  const luna = parseUrdf(readFileSync(join(root, 'public/robots/luna.urdf'), 'utf8'), { parseXml: DOMParser })
  assert.equal(luna.joints.size, 27)
  assert.equal(luna.meshes.length, 28)
  assert.ok(luna.skeleton.every((node, index) => node.parent === null || luna.skeleton.findIndex((item) => item.name === node.parent) < index))
  assert.ok(luna.skeleton[0].offset[2] > 0)

  const simple = parseUrdf(
    `<robot name="demo">
      <link name="base"/>
      <link name="arm"/>
      <joint name="shoulder" type="revolute">
        <parent link="base"/><child link="arm"/>
        <origin xyz="0 0 0.5" rpy="0 1.5707963 0"/><axis xyz="0 0 1"/>
      </joint>
    </robot>`,
    { parseXml: DOMParser },
  )
  assert.equal(simple.joints.size, 1)
  const arm = simple.skeleton.find((node) => node.name === 'arm')
  assert.deepEqual(arm.offset, [0, 0, 0.5])
  assert.ok(Math.abs(arm.rpy[1] - 1.5707963) < 1e-6)
})

test('parses binary STL triangles and decimates to a budget', () => {
  const count = 10
  const bytes = new Uint8Array(84 + count * 50)
  new DataView(bytes.buffer).setUint32(80, count, true)
  for (let index = 0; index < count; index += 1) {
    const offset = 84 + index * 50 + 12
    const view = new DataView(bytes.buffer)
    for (let vertex = 0; vertex < 9; vertex += 1) view.setFloat32(offset + vertex * 4, vertex, true)
  }
  const parsed = parseStl(bytes)
  assert.equal(parsed.total, 10)
  assert.equal(parsed.triangles.length, 90)
  const decimated = parseStl(bytes, { maxTriangles: 2 })
  assert.equal(decimated.triangles.length, 18)
})
