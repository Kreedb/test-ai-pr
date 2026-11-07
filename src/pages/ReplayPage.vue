<script>
export const route = {
  label: '机器人回放',
  order: 15,
  tool: {
    tag: 'BAG',
    title: '机器人包回放',
    description: '读取 ROS1 bag 与 ROS2 MCAP / SQLite bag 的关节与 IMU 话题（支持未完成的 .active 自动恢复），按时间轴还原机器人姿态；可同时导入文本日志、上传或选择预置 URDF，并用波形图定位异常点。',
    action: '打开回放',
  },
}
</script>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import LogTimeline from '@/components/LogTimeline.vue'
import RobotSkeletonView from '@/components/RobotSkeletonView.vue'
import SignalChart from '@/components/SignalChart.vue'
import { expandArchive, isZipArchive } from '@/lib/archive'
import { formatBytes } from '@/lib/format'
import { BAG_FORMATS, FORMAT_LABELS, inspectBag, readBag, sniffBagFormat } from '@/lib/replay/bag'
import { MAX_LOG_BYTES, alignLog, parseLogText } from '@/lib/replay/logfile'
import { buildJointValues, computePose, normalizeQuat, quatToEuler } from '@/lib/replay/pose'
import { ALL_PROFILES, attachSkeleton, detectProfile, mapJoints } from '@/lib/replay/profiles'
import { MAX_BAG_BYTES } from '@/lib/replay/rosbag'
import { parseStl, parseUrdf } from '@/lib/replay/urdf'

const SAMPLE = { file: 'samples/replay/luna-demo.bag', label: 'Luna 动作' }
const MESH_TRIANGLES = 4000
const MESH_MAX_BYTES = 96 * 1024 * 1024
// Known `package://` sources. Uploaded STL files still win; this is the
// best-effort fallback the issue asked for (luna-description STL on demand).
const MESH_PACKAGES = {
  HU_L04_description: 'https://raw.githubusercontent.com/limxdynamics/luna-description/main/HU_L04_description/',
}

const fileName = ref('')
const sampleName = ref('')
const error = ref('')
const busy = ref(false)
const progress = ref(0)
const dragging = ref(false)
const topics = shallowRef([])
const jointTopic = ref('')
const imuTopic = ref('')
const result = shallowRef(null)
const profile = shallowRef(null)
const mapping = shallowRef({ entries: [], unmapped: [] })
const warnings = shallowRef([])
const bagFiles = shallowRef([])
const formatMode = ref('auto')
const bagFormat = ref('')
const profileChoice = ref('auto')
const customUrdf = shallowRef(null)
const meshEnabled = ref(false)
const meshSources = shallowRef(new Map())
const meshes = shallowRef([])
const meshStatus = ref('')
const meshErrors = shallowRef([])
const urdfWarning = ref('')
const urdfMeshSource = shallowRef({ defs: [], meshBase: '' })
const logName = ref('')
const logEntries = shallowRef([])
const logWarnings = shallowRef([])
const logError = ref('')
const logBusy = ref(false)
const startTime = ref(0)
const duration = ref(0)
const current = ref(0)
const playing = ref(false)
const speed = ref(1)
const loop = ref(false)
const jointGap = ref(0.1)
const stage = ref(null)
const isFullscreen = ref(false)

let frameHandle = 0
let lastFrame = 0
let meshToken = 0

const jointSeries = computed(() => result.value?.series?.[jointTopic.value] || null)
const imuSeries = computed(() => result.value?.series?.[imuTopic.value] || null)
const jointTopics = computed(() => topics.value.filter((topic) => topic.kind === 'joint'))
const imuTopics = computed(() => topics.value.filter((topic) => topic.kind === 'imu'))
const absoluteTime = computed(() => startTime.value + current.value)

const logAligned = computed(() => {
  if (!logEntries.value.length || !result.value) return { entries: [], basis: '', aligned: false, dropped: 0 }
  return alignLog(logEntries.value, startTime.value, startTime.value + duration.value)
})

const logRows = computed(() => logAligned.value.entries)

const logIndex = computed(() => {
  if (!logAligned.value.aligned) return -1
  const entries = logAligned.value.entries
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle].time <= absoluteTime.value) low = middle + 1
    else high = middle
  }
  return low ? low - 1 : -1
})

const logBasis = computed(() => (logAligned.value.basis === 'clk' ? 'clk 单调时钟' : '墙钟时间'))

const parseLabel = computed(() => {
  const selected = topics.value.filter((topic) => topic.name === jointTopic.value || topic.name === imuTopic.value)
  if (!selected.length) return ''
  if (selected.some((topic) => topic.modified)) return '检测到魔改字段，已按消息定义解析'
  if (selected.some((topic) => topic.family === 'limx')) return 'LimX 自定义消息，已按消息定义解析'
  if (selected.every((topic) => topic.standard)) return '通用解析（标准 ROS 消息）'
  return '通用解析'
})

const modelWarnings = computed(() => {
  const list = []
  if (!result.value) return list
  if (urdfWarning.value) list.push({ level: 'warn', message: urdfWarning.value })
  if (!profile.value?.skeleton) {
    list.push({ level: 'warn', message: '没有可用的骨架，仍会显示关节数值与波形，但不会绘制 3D 姿态。' })
  }
  if (mapping.value.unmapped.length) {
    list.push({
      level: 'warn',
      message: `${mapping.value.unmapped.length} 个关节名未映射到骨架：${mapping.value.unmapped.slice(0, 6).join('、')}${mapping.value.unmapped.length > 6 ? ' 等' : ''}`,
    })
  }
  if (jointTopic.value.includes('/motor/') && (profile.value?.id === 'luna' || profile.value?.id === 'oli')) {
    list.push({ level: 'warn', message: '当前使用电机话题：并联踝/腰的电机角度与串行关节角不同，3D 姿态只作参考，不是实机串行关节角。' })
  }
  return list
})

const allWarnings = computed(() => [...warnings.value, ...modelWarnings.value, ...meshErrors.value])

function indexAt(times, time) {
  if (!times?.length) return -1
  if (time <= times[0]) return 0
  const last = times.length - 1
  if (time >= times[last]) return last
  let low = 0
  let high = last
  while (low <= high) {
    const middle = (low + high) >> 1
    if (times[middle] <= time) {
      if (times[middle + 1] > time) return middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return Math.max(0, low - 1)
}

const jointFrame = computed(() => indexAt(jointSeries.value?.times, absoluteTime.value))
const imuFrame = computed(() => indexAt(imuSeries.value?.times, absoluteTime.value))

const baseQuat = computed(() => {
  const series = imuSeries.value
  const index = imuFrame.value
  if (!series || index < 0) return [1, 0, 0, 0]
  return normalizeQuat([series.quat[0][index], series.quat[1][index], series.quat[2][index], series.quat[3][index]])
})

const baseEuler = computed(() => quatToEuler(baseQuat.value))

const pose = computed(() => {
  const series = jointSeries.value
  const skeleton = profile.value?.skeleton
  const index = jointFrame.value
  if (!series || !skeleton || index < 0) return null
  const values = buildJointValues(series, mapping.value.entries, index)
  return computePose(skeleton, values, baseQuat.value)
})

const atGap = computed(() => {
  const series = jointSeries.value
  const index = jointFrame.value
  if (!series || index < 0 || index >= series.times.length - 1) return false
  return series.times[index + 1] - series.times[index] > jointGap.value
})

const jointRows = computed(() => {
  const series = jointSeries.value
  const index = jointFrame.value
  if (!series || index < 0) return []
  return series.names.map((name, column) => {
    const radians = series.columns[column][index]
    return {
      name,
      target: mapping.value.entries.find((entry) => entry.index === column)?.joint || '',
      radians,
      degrees: (radians * 180) / Math.PI,
    }
  })
})

const stats = computed(() => {
  const joint = jointSeries.value
  const imu = imuSeries.value
  return [
    {
      label: '格式',
      value: FORMAT_LABELS[bagFormat.value] || '—',
      note: parseLabel.value || '选择文件后自动识别',
    },
    {
      label: '关节',
      value: `${(joint?.count ?? 0).toLocaleString()} 帧`,
      note: jointTopic.value || '—',
    },
    {
      label: 'IMU',
      value: imu ? `${imu.count.toLocaleString()} 帧` : '未使用',
      note: imuTopic.value || '底座姿态固定',
    },
    {
      label: '回放时长',
      value: `${duration.value.toFixed(2)} s`,
      note: `起点 ${startTime.value.toFixed(2)} s`,
    },
    {
      label: '骨架',
      value: (profile.value?.id || '—').toUpperCase(),
      note: profile.value?.label || '—',
    },
  ]
})

function colorOf(name) {
  if (String(name).startsWith('left') || String(name).endsWith('_L')) return '#5b8cff'
  if (String(name).startsWith('right') || String(name).endsWith('_R')) return '#f5b942'
  return '#c4b5fd'
}

const waveRows = computed(() => {
  const rows = []
  const joint = jointSeries.value
  if (joint) {
    joint.names.forEach((name, column) => {
      rows.push({ label: name, values: joint.columns[column], times: joint.times, color: colorOf(name) })
    })
  }
  const imu = imuSeries.value
  if (imu) {
    const euler = [new Float64Array(imu.count), new Float64Array(imu.count), new Float64Array(imu.count)]
    for (let index = 0; index < imu.count; index += 1) {
      const [roll, pitch, yaw] = quatToEuler([imu.quat[0][index], imu.quat[1][index], imu.quat[2][index], imu.quat[3][index]])
      euler[0][index] = roll
      euler[1][index] = pitch
      euler[2][index] = yaw
    }
    const labels = ['roll', 'pitch', 'yaw']
    labels.forEach((label, axis) => rows.push({ label: `IMU ${label}°`, values: euler[axis], times: imu.times, color: '#3ddc97' }))
    const add = (values, label, unit) => {
      const names = ['x', 'y', 'z']
      for (let axis = 0; axis < 3; axis += 1) rows.push({ label: `${label}.${names[axis]}${unit}`, values: values[axis], times: imu.times, color: '#7dd3fc' })
    }
    if (imu.hasAcc) add(imu.acc, 'acc', ' m/s²')
    if (imu.hasGyro) add(imu.gyro, 'gyro', ' rad/s')
  }
  return rows
})

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatTime(seconds) {
  const sign = seconds < 0 ? '-' : ''
  const value = Math.abs(seconds)
  const minutes = Math.floor(value / 60)
  const rest = value - minutes * 60
  return `${sign}${minutes}:${rest.toFixed(2).padStart(5, '0')}`
}

function pickTopic(list, preferred) {
  for (const name of preferred) {
    const found = list.find((topic) => topic.name === name)
    if (found) return found
  }
  return list[0] || null
}

function medianInterval(times) {
  if (!times || times.length < 2) return 0.01
  const intervals = []
  for (let index = 1; index < times.length; index += 1) intervals.push(times[index] - times[index - 1])
  intervals.sort((left, right) => left - right)
  return intervals[Math.floor(intervals.length / 2)]
}

function resetPlayback() {
  pause()
  current.value = 0
  lastFrame = 0
}

async function presetText(meta) {
  const response = await fetch(`${import.meta.env.BASE_URL}${meta.urdf}`)
  if (!response.ok) throw new Error(`预置 URDF 加载失败（HTTP ${response.status}）`)
  return response.text()
}

function chosenProfile(series) {
  if (profileChoice.value === 'custom') {
    return customUrdf.value ? { id: 'custom', label: `自定义 URDF · ${customUrdf.value.name}`, urdf: '', order: null, joints: new Set(), aliases: null } : null
  }
  if (profileChoice.value !== 'auto') return ALL_PROFILES.find((item) => item.id === profileChoice.value) || null
  return detectProfile(series.names, series.names.length, series.named)
}

async function mountModel(series) {
  const meta = chosenProfile(series)
  urdfWarning.value = ''
  urdfMeshSource.value = { defs: [], meshBase: '' }
  meshes.value = []
  meshErrors.value = []
  if (!meta || meta.id === 'index' || (!meta.urdf && meta.id !== 'custom')) {
    profile.value = null
    mapping.value = { entries: [], unmapped: [] }
    return
  }

  let parsed
  try {
    parsed = parseUrdf(meta.id === 'custom' ? customUrdf.value.text : await presetText(meta))
  } catch (cause) {
    profile.value = null
    mapping.value = { entries: [], unmapped: [] }
    urdfWarning.value = `URDF 解析失败：${messageOf(cause)}`
    return
  }

  const attached = attachSkeleton(meta.id === 'custom' ? { ...meta, order: parsed.order } : meta, parsed.skeleton)
  profile.value = attached
  mapping.value = mapJoints(attached, series)
  urdfMeshSource.value = { defs: parsed.meshes, meshBase: meta.meshBase || '' }
  await loadMeshes()
}

function meshBytes(name) {
  const sources = meshSources.value
  const path = name.replace(/^package:\/\/[^/]+\//, '')
  return sources.get(name) || sources.get(path) || sources.get(path.split('/').pop()) || null
}

async function loadMeshes() {
  const token = ++meshToken
  const { defs, meshBase } = urdfMeshSource.value
  meshErrors.value = []
  if (!meshEnabled.value || !defs.length) {
    meshes.value = []
    meshStatus.value = defs.length ? '未显示 3D 网格' : ''
    return
  }

  meshStatus.value = '加载 3D 网格…'
  const loaded = []
  let failures = 0
  let total = 0
  try {
    for (let index = 0; index < defs.length; index += 1) {
      if (token !== meshToken) return
      meshStatus.value = `加载 3D 网格 ${index + 1}/${defs.length}…`
      const definition = defs[index]
      let bytes = meshBytes(definition.filename)
      const packageMatch = /^package:\/\/([^/]+)\//.exec(definition.filename)
      const remoteBase = meshBase || (packageMatch ? MESH_PACKAGES[packageMatch[1]] : '')
      if (!bytes && remoteBase && packageMatch) {
        try {
          const response = await fetch(remoteBase + definition.filename.replace(/^package:\/\/[^/]+\//, ''))
          if (response.ok) bytes = new Uint8Array(await response.arrayBuffer())
        } catch {
          bytes = null
        }
      }
      if (!bytes) {
        failures += 1
        continue
      }
      total += bytes.length
      if (total > MESH_MAX_BYTES) {
        failures += 1
        continue
      }
      loaded.push({ definition, bytes })
    }

    const geometries = []
    const totalBytes = loaded.reduce((sum, item) => sum + item.bytes.length, 0) || 1
    for (const item of loaded) {
      const budget = Math.max(24, Math.round((MESH_TRIANGLES * item.bytes.length) / totalBytes))
      const { triangles } = parseStl(item.bytes, { maxTriangles: budget })
      geometries.push({
        node: item.definition.link,
        triangles,
        xyz: item.definition.xyz,
        rpy: item.definition.rpy,
        scale: item.definition.scale,
      })
    }
    if (token !== meshToken) return
    meshes.value = geometries
    meshStatus.value = `已加载 ${geometries.length} 个网格${failures ? `，${failures} 个无法获取` : ''}`
    if (failures) meshErrors.value = [{ level: 'warn', message: `${failures} 个 URDF 网格无法加载（.dae/.obj 暂不支持，或文件不在本机）。` }]
  } finally {
    if (token === meshToken) meshStatus.value ||= '未加载网格'
  }
}

async function applyTopics(files, jointName, imuName) {
  busy.value = true
  error.value = ''
  progress.value = 0
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const decoded = readBag(files, {
      format: formatMode.value,
      topics: [jointName, imuName].filter(Boolean),
      onProgress: (value) => {
        progress.value = Math.round(value * 100)
      },
    })
    const joint = decoded.series[jointName]
    if (!joint) throw new Error(`话题 ${jointName} 没有可用的关节消息`)
    let imu = imuName ? decoded.series[imuName] : null
    let start = joint.times[0]
    let end = joint.times[joint.times.length - 1]
    let imuFallback = false
    if (imu) {
      const imuStart = Math.max(start, imu.times[0])
      const imuEnd = Math.min(end, imu.times[imu.times.length - 1])
      if (imuEnd > imuStart) {
        start = imuStart
        end = imuEnd
      } else {
        // The IMU is optional; a mismatched clock should not hide the joints.
        imu = null
        imuFallback = true
        imuTopic.value = ''
      }
    }
    if (!(end > start)) throw new Error('关节与 IMU 话题没有重叠的有效时间段')

    result.value = decoded
    bagFormat.value = decoded.format
    startTime.value = start
    duration.value = end - start
    jointGap.value = Math.max(0.1, 10 * medianInterval(joint.times))
    resetPlayback()

    const list = [...decoded.warnings]
    if (imuFallback) {
      list.push({ level: 'warn', message: `IMU 话题 ${imuName} 与关节时间没有重叠，已改为仅用关节回放。` })
    }
    if (files.some((file) => /\.active$/i.test(file.name))) {
      list.unshift({ level: 'info', message: '已按未完成录制打开 .active 文件，自动保留尾部截断前的完整数据块。' })
    }
    warnings.value = list
    await mountModel(joint)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
    progress.value = 0
  }
}

async function loadBagFiles(files, sample = '') {
  busy.value = true
  error.value = ''
  try {
    if (!files.length) throw new Error('没有 bag 文件')
    for (const file of files) {
      if (!file.bytes.length) throw new Error(`${file.name} 是空文件`)
      if (file.bytes.length > MAX_BAG_BYTES) throw new Error(`${file.name} 超过 ${formatBytes(MAX_BAG_BYTES)} 上限`)
    }
    const info = inspectBag(files, formatMode.value)
    topics.value = info.topics
    const joints = info.topics.filter((topic) => topic.kind === 'joint')
    if (!joints.length) throw new Error('bag 里没有可解析的关节话题；至少需要一个 JointState 话题才能回放姿态')
    const imus = info.topics.filter((topic) => topic.kind === 'imu')
    const joint = pickTopic(joints, ['/joint/state', '/motor/state'])
    const imu = pickTopic(imus, ['/ImuData', '/imu/data', '/imu'])
    bagFormat.value = info.format
    bagFiles.value = files
    fileName.value = files.map((file) => file.name).join(' + ')
    sampleName.value = sample
    jointTopic.value = joint.name
    imuTopic.value = imu?.name || ''
    await applyTopics(files, jointTopic.value, imuTopic.value)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function addMeshSources(entries) {
  const next = new Map(meshSources.value)
  for (const entry of entries) {
    next.set(entry.name, entry.bytes)
    if (entry.path) next.set(entry.path, entry.bytes)
    next.set(entry.name.split('/').filter(Boolean).pop(), entry.bytes)
  }
  meshSources.value = next
}

async function useUrdf(urdf, meshEntries) {
  addMeshSources(meshEntries)
  customUrdf.value = { name: urdf.name, text: new TextDecoder().decode(urdf.bytes) }
  profileChoice.value = 'custom'
  meshEnabled.value = meshEntries.length > 0
  if (result.value && jointSeries.value) await mountModel(jointSeries.value)
}

async function loadSample() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${SAMPLE.file}`)
    if (!response.ok) throw new Error(`示例 bag 加载失败（HTTP ${response.status}）`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await loadBagFiles([{ name: SAMPLE.file.split('/').pop(), bytes }], SAMPLE.label)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

async function handleLogs(files) {
  if (logBusy.value) return
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_LOG_BYTES) {
    logError.value = `日志合计超过 ${formatBytes(MAX_LOG_BYTES)} 上限`
    return
  }
  logBusy.value = true
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const texts = []
    for (const file of files) texts.push(await file.text())
    const parsed = parseLogText(texts.join('\n'))
    if (!parsed.entries.length) throw new Error('日志里没有带时间戳的行（支持 clk(...)、[epoch] 或 YYYY-MM-DD HH:MM:SS.mmm）')
    logEntries.value = parsed.entries
    logWarnings.value = parsed.warnings
    logError.value = ''
    logName.value = files.map((file) => file.name).join(' + ')
  } catch (cause) {
    logError.value = `${files.map((file) => file.name).join(' + ')}：${messageOf(cause)}`
  } finally {
    logBusy.value = false
  }
}

async function expandInputFiles(input) {
  const entries = []
  for (const file of [...input]) {
    if (file.size > MAX_BAG_BYTES) throw new Error(`${file.name} 超过 ${formatBytes(MAX_BAG_BYTES)} 上限`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (isZipArchive(file.name, bytes)) {
      const { files } = await expandArchive(file.name, bytes, { maxFileBytes: MAX_BAG_BYTES, maxTotalBytes: MAX_BAG_BYTES, maxEntries: 512 })
      for (const entry of files) entries.push({ name: entry.path, path: entry.path, bytes: entry.bytes })
    } else {
      entries.push({ name: file.name, bytes })
    }
  }
  return entries
}

async function handleFiles(input) {
  if (busy.value || logBusy.value) return
  busy.value = true
  error.value = ''
  try {
    const entries = await expandInputFiles(input)
    const bags = []
    const logs = []
    const meshEntries = []
    const unsupported = []
    let urdf = null
    for (const entry of entries) {
      if (entry.bytes.length > MAX_BAG_BYTES) throw new Error(`${entry.name} 超过 ${formatBytes(MAX_BAG_BYTES)} 上限`)
      if (sniffBagFormat(entry.bytes)) bags.push(entry)
      else if (/\.(log|txt)$/i.test(entry.name)) logs.push({ name: entry.name, size: entry.bytes.length, text: async () => new TextDecoder().decode(entry.bytes) })
      else if (/\.urdf$/i.test(entry.name)) urdf = entry
      else if (/\.xacro$/i.test(entry.name)) throw new Error('暂不支持 .xacro，请先展开为 .urdf')
      else if (/\.stl$/i.test(entry.name)) meshEntries.push(entry)
      else if (/\.(dae|obj)$/i.test(entry.name)) meshEntries.push(entry)
      else unsupported.push(entry.name)
    }
    if (!bags.length && !logs.length && !urdf && !meshEntries.length) {
      throw new Error(`仅支持 ROS1 .bag/.active、ROS2 .mcap/.db3、.zip、文本 .log/.txt 与 URDF/STL。${unsupported.length ? `不支持：${unsupported.slice(0, 3).join('、')}` : ''}`)
    }
    if (meshEntries.some((item) => /\.(dae|obj)$/i.test(item.name))) {
      meshErrors.value = [{ level: 'warn', message: '.dae / .obj 网格暂不支持，请使用 STL。' }]
    }
    if (urdf)
      await useUrdf(
        urdf,
        meshEntries.filter((item) => /\.stl$/i.test(item.name)),
      )
    else if (meshEntries.length && customUrdf.value) {
      addMeshSources(meshEntries.filter((item) => /\.stl$/i.test(item.name)))
      meshEnabled.value = true
      if (result.value) await loadMeshes()
    }
    if (logs.length) await handleLogs(logs)
    if (bags.length) await loadBagFiles(bags)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function onDrop(event) {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files?.length) handleFiles(files)
}

function onFileChange(event) {
  const files = event.target.files
  if (files?.length) handleFiles(files)
  event.target.value = ''
}

async function reloadFormat() {
  if (!bagFiles.value.length || busy.value) return
  await loadBagFiles(bagFiles.value, sampleName.value)
}

async function reparse() {
  if (!bagFiles.value.length || !jointTopic.value) return
  await applyTopics(bagFiles.value, jointTopic.value, imuTopic.value || '')
}

async function changeProfile() {
  if (profileChoice.value === 'custom' && !customUrdf.value) {
    error.value = '请先上传 .urdf 文件（可同时选择同目录的 STL，或上传包含网格的 zip）'
    profileChoice.value = 'auto'
    return
  }
  if (!result.value || !jointSeries.value || busy.value) return
  busy.value = true
  try {
    await mountModel(jointSeries.value)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

async function toggleMeshes() {
  if (!urdfMeshSource.value.defs.length && meshEnabled.value) {
    meshStatus.value = '当前 URDF 没有引用网格'
  }
  await loadMeshes()
}

function fail(cause) {
  pause()
  error.value = messageOf(cause)
  result.value = null
  profile.value = null
  mapping.value = { entries: [], unmapped: [] }
  warnings.value = []
  topics.value = []
  fileName.value = ''
  sampleName.value = ''
  bagFiles.value = []
  bagFormat.value = ''
  urdfMeshSource.value = { defs: [], meshBase: '' }
  meshes.value = []
  meshErrors.value = []
  meshStatus.value = ''
  urdfWarning.value = ''
}

function clearAll() {
  pause()
  fail('')
  error.value = ''
  formatMode.value = 'auto'
  profileChoice.value = 'auto'
  customUrdf.value = null
  meshSources.value = new Map()
  meshEnabled.value = false
  logName.value = ''
  logEntries.value = []
  logWarnings.value = []
  logError.value = ''
}

function toggle() {
  if (playing.value) pause()
  else play()
}

function play() {
  if (!result.value || duration.value <= 0) return
  if (current.value >= duration.value) current.value = 0
  playing.value = true
  lastFrame = 0
  frameHandle = requestAnimationFrame(tick)
}

function pause() {
  playing.value = false
  if (frameHandle) cancelAnimationFrame(frameHandle)
  frameHandle = 0
}

function tick(timestamp) {
  if (!playing.value) return
  if (!lastFrame) lastFrame = timestamp
  const delta = Math.min(0.1, (timestamp - lastFrame) / 1000)
  lastFrame = timestamp
  current.value += delta * speed.value
  if (current.value >= duration.value) {
    if (loop.value) {
      current.value = 0
    } else {
      current.value = duration.value
      pause()
      return
    }
  }
  frameHandle = requestAnimationFrame(tick)
}

function step(direction) {
  const series = jointSeries.value
  if (!series) return
  pause()
  const index = Math.max(0, Math.min(series.times.length - 1, jointFrame.value + direction))
  current.value = Math.max(0, Math.min(duration.value, series.times[index] - startTime.value))
}

function seek(event) {
  pause()
  current.value = Math.max(0, Math.min(duration.value, Number(event.target.value)))
}

function seekWave(seconds) {
  pause()
  current.value = Math.max(0, Math.min(duration.value, seconds))
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await stage.value?.requestFullscreen?.()
}

function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === stage.value
}

function onKeydown(event) {
  if (event.repeat) return
  // Do not steal Space/arrows from a focused control (sample button, link,
  // details summary, editable field).
  if (event.target?.closest?.('input, textarea, select, button, a, summary, [contenteditable]')) return
  if (event.code === 'Space') {
    event.preventDefault()
    toggle()
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault()
    if (playing.value) current.value = Math.max(0, current.value - 1)
    else step(-1)
  } else if (event.code === 'ArrowRight') {
    event.preventDefault()
    if (playing.value) current.value = Math.min(duration.value, current.value + 1)
    else step(1)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  pause()
})
</script>

<template>
  <main class="app-main">
    <section class="card input-card">
      <div class="card-head">
        <h2>导入机器人 bag、日志与 URDF</h2>
        <span v-if="fileName" class="badge">{{ fileName }}</span>
        <span v-if="logName" class="badge">{{ logName }}</span>
      </div>

      <label class="drop-zone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
        <input type="file" multiple accept=".bag,.active,.mcap,.db3,.zip,.log,.txt,.urdf,.stl,.dae,.obj" :disabled="busy || logBusy" @change="onFileChange" />
        <span class="drop-title">拖拽 ROS1 bag、ROS2 MCAP / .db3、.zip、.log 或 .urdf，或点击选择文件</span>
        <span class="drop-hint">
          JointState + IMU · ROS1 未压缩或 lz4 · ROS2 MCAP（lz4 / 未压缩）与 sqlite3 · 自动识别 LimX 自定义消息 · .active 自动恢复 · 日志按 clk / 时间戳对齐 · bag 最大
          {{ formatBytes(MAX_BAG_BYTES) }} · 日志最大 {{ formatBytes(MAX_LOG_BYTES) }} · 数据只在浏览器本地处理
        </span>
      </label>

      <div class="actions">
        <label class="format-select">
          <span>bag 格式</span>
          <select v-model="formatMode" :disabled="busy" @change="reloadFormat">
            <option v-for="item in BAG_FORMATS" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </label>
        <span v-if="bagFormat" class="badge">{{ FORMAT_LABELS[bagFormat] }}</span>
        <button type="button" class="btn" :disabled="busy" @click="loadSample">示例：{{ SAMPLE.label }}</button>
        <button type="button" class="btn ghost" :disabled="busy || logBusy" @click="clearAll">清空</button>
        <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
        <span v-if="busy" class="muted small">正在解析 {{ progress }}%…</span>
        <span v-if="logBusy" class="muted small">正在解析日志…</span>
      </div>
    </section>

    <div v-if="error" class="card error-card" role="alert">
      <strong>无法回放</strong>
      <p>{{ error }}</p>
    </div>

    <template v-if="result">
      <section class="stats-grid" aria-label="回放概览">
        <div v-for="stat in stats" :key="stat.label" class="card stat">
          <span class="stat-label">{{ stat.label }}</span>
          <span class="stat-value">{{ stat.value }}</span>
          <span class="stat-note">{{ stat.note }}</span>
        </div>
      </section>

      <section v-if="allWarnings.length" class="card warnings-card">
        <h2>提示（{{ allWarnings.length }}）</h2>
        <ul class="warning-list">
          <li v-for="(warning, index) in allWarnings" :key="index" :class="`warn-${warning.level}`">
            {{ warning.message }}
          </li>
        </ul>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>话题、型号与 URDF</h2>
          <span class="badge">{{ profile?.label || '未识别骨架' }}</span>
        </div>
        <div class="topic-grid">
          <label>
            <span>关节话题</span>
            <select v-model="jointTopic" :disabled="busy" @change="reparse">
              <option v-for="topic in jointTopics" :key="topic.name" :value="topic.name">{{ topic.name }} · {{ topic.type }}</option>
            </select>
          </label>
          <label>
            <span>IMU 话题</span>
            <select v-model="imuTopic" :disabled="busy" @change="reparse">
              <option value="">不使用（底座姿态固定）</option>
              <option v-for="topic in imuTopics" :key="topic.name" :value="topic.name">{{ topic.name }} · {{ topic.type }}</option>
            </select>
          </label>
          <label>
            <span>骨架 / URDF</span>
            <select v-model="profileChoice" :disabled="busy" @change="changeProfile">
              <option value="auto">自动识别（按关节名）</option>
              <option v-for="item in ALL_PROFILES" :key="item.id" :value="item.id">{{ item.label }}</option>
              <option value="custom">自定义 URDF</option>
            </select>
          </label>
        </div>
        <div class="urdf-row">
          <label class="btn ghost file-btn">
            上传 URDF / STL / ZIP
            <input type="file" multiple accept=".urdf,.stl,.zip,.dae,.obj" :disabled="busy" @change="onFileChange" />
          </label>
          <label class="loop-label"><input v-model="meshEnabled" type="checkbox" :disabled="busy" @change="toggleMeshes" /> 加载 3D 模型</label>
          <span v-if="customUrdf" class="muted small">{{ customUrdf.name }}</span>
          <span v-if="meshStatus" class="muted small">{{ meshStatus }}</span>
        </div>
        <p class="muted small">
          预置骨架从 <code>public/robots/*.urdf</code> 加载，不再写死在源码里。Luna 的 URDF 引用了 limxdynamics/luna-description 的 STL，勾选“加载 3D
          模型”后会按需下载并抽稀显示。关节按名称映射到骨架；没有名称的 bag 按机型配置的硬件下标顺序映射。
        </p>
      </section>

      <section class="card">
        <details>
          <summary>关节角度（{{ jointRows.length }} 个，当前帧）</summary>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>录制名称</th>
                  <th>映射关节</th>
                  <th>rad</th>
                  <th>deg</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in jointRows" :key="index">
                  <td class="mono">{{ index }}</td>
                  <td class="mono">{{ row.name }}</td>
                  <td class="mono">{{ row.target || '—' }}</td>
                  <td class="mono">{{ row.radians.toFixed(4) }}</td>
                  <td class="mono">{{ row.degrees.toFixed(1) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <div ref="stage" class="replay-stage">
        <section class="card pose-card">
          <div class="card-head">
            <h2>姿态回放</h2>
            <span v-if="atGap" class="chip warn-chip">DATA GAP</span>
            <button type="button" class="btn ghost icon-btn fullscreen-btn" @click="toggleFullscreen">
              {{ isFullscreen ? '退出全屏' : '全屏' }}
            </button>
          </div>

          <dl class="kv pose-kv">
            <div>
              <dt>底座位姿</dt>
              <dd class="mono">RPY {{ baseEuler.map((value) => value.toFixed(1)).join('° / ') }}°</dd>
            </div>
            <div>
              <dt>关节帧</dt>
              <dd class="mono">{{ jointFrame + 1 }} / {{ jointSeries?.count ?? 0 }}</dd>
            </div>
            <div>
              <dt>IMU 帧</dt>
              <dd class="mono">{{ imuSeries ? imuFrame + 1 : '—' }}</dd>
            </div>
            <div>
              <dt>时钟</dt>
              <dd class="mono">{{ absoluteTime.toFixed(3) }} s</dd>
            </div>
          </dl>

          <div class="pose-view">
            <RobotSkeletonView
              :points="pose?.points || null"
              :skeleton="profile?.skeleton || null"
              :transforms="pose?.transforms || null"
              :meshes="meshes"
              :empty-message="profile?.skeleton ? '当前时刻没有关节数据' : '未识别骨架，可上传 URDF 或展开上方关节角度查看数值'"
            />
          </div>

          <div class="playback-bar">
            <button type="button" class="btn primary icon-btn" @click="toggle">
              {{ playing ? '暂停' : '播放' }}
            </button>
            <button type="button" class="btn ghost icon-btn" title="上一帧" @click="step(-1)">‹</button>
            <button type="button" class="btn ghost icon-btn" title="下一帧" @click="step(1)">›</button>
            <input class="playback-range" type="range" min="0" :max="duration" step="0.001" :value="current" aria-label="回放时间" @input="seek" />
            <span class="mono time-label">{{ formatTime(current) }} / {{ formatTime(duration) }}</span>
            <select v-model.number="speed" class="mono" aria-label="播放速度">
              <option :value="0.25">0.25×</option>
              <option :value="0.5">0.5×</option>
              <option :value="1">1×</option>
              <option :value="2">2×</option>
            </select>
            <label class="loop-label"><input v-model="loop" type="checkbox" /> 循环</label>
          </div>
        </section>

        <section v-if="logName || logError || isFullscreen" class="card log-card">
          <div class="card-head">
            <h2>日志时间线</h2>
            <span v-if="logName" class="badge">{{ logName }}</span>
          </div>

          <p v-if="logError" class="warn-warn">{{ logError }}</p>
          <template v-else-if="logEntries.length">
            <p class="muted small">
              {{ logEntries.length.toLocaleString() }} 条带时间戳的日志
              <template v-if="result">
                · 按 {{ logBasis }} 对齐
                <span v-if="!logAligned.aligned" class="warn-warn">· 日志时间与 bag 记录时间不重叠，无法匹配</span>
                <span v-if="logAligned.dropped" class="warn-warn">· 另有 {{ logAligned.dropped.toLocaleString() }} 条日志使用其他时钟，无法对齐</span>
              </template>
            </p>

            <LogTimeline v-if="result && logRows.length" :rows="logRows" :active="logIndex" :aligned="logAligned.aligned" :start-time="startTime" />

            <ul v-if="logWarnings.length" class="warning-list">
              <li v-for="(warning, index) in logWarnings" :key="index" :class="`warn-${warning.level}`">
                {{ warning.message }}
              </li>
            </ul>
          </template>
          <p v-else-if="isFullscreen" class="muted small">未导入日志。把 .log/.txt 拖进来后会按时间戳显示在这里。</p>
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <h2>关节与 IMU 波形</h2>
          <span class="muted small">拖动图表可定位时间点</span>
        </div>
        <SignalChart :rows="waveRows" :start-time="startTime" :duration="duration" :current="current" empty-message="没有可绘制的关节或 IMU 数据" @seek="seekWave" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.playback-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.icon-btn {
  min-width: 44px;
  padding: 6px 10px;
}

.playback-range {
  flex: 1 1 220px;
  min-width: 160px;
  accent-color: var(--accent);
}

.time-label {
  font-size: 0.82rem;
  color: var(--muted);
  white-space: nowrap;
}

.loop-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 0.82rem;
}

.pose-kv {
  margin: 14px 0;
}

.topic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-bottom: 10px;
}

.topic-grid label,
.format-select {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--muted);
  font-size: 0.82rem;
}

.topic-grid select,
.format-select select {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.8rem;
}

.format-select {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.format-select select {
  width: auto;
}

.urdf-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.file-btn {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.pose-view {
  min-height: 0;
}

.fullscreen-btn {
  margin-left: auto;
}

.replay-stage:fullscreen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow: auto;
  background: var(--bg, #0b0d12);
}

.replay-stage:fullscreen .pose-card {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.replay-stage:fullscreen .pose-view {
  flex: 1 1 auto;
  display: flex;
  min-height: 240px;
}

.replay-stage:fullscreen .pose-kv {
  margin: 8px 0;
  flex: 0 0 auto;
}

.replay-stage:fullscreen .playback-bar {
  flex: 0 0 auto;
}

.replay-stage:fullscreen :deep(.skeleton-view) {
  height: 100%;
  min-height: 0;
  flex: 1 1 auto;
}

.replay-stage:fullscreen .log-card {
  flex: 0 0 auto;
  max-height: 34vh;
  overflow: auto;
}

.warn-chip {
  border-color: rgba(245, 185, 66, 0.4);
  color: var(--warn);
}

details summary {
  cursor: pointer;
  color: var(--text);
  font-weight: 600;
}

details[open] summary {
  margin-bottom: 12px;
}
</style>
