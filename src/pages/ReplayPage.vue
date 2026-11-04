<script>
export const route = {
  label: '机器人回放',
  order: 15,
  tool: {
    tag: 'BAG',
    title: '机器人包回放',
    description: '读取 ROS1 bag 的关节与 IMU 话题（支持未完成的 .active 自动恢复），按时间轴还原机器人姿态；内置 LimX Luna / Oli / TRON2A 骨架。',
    action: '打开回放',
  },
}
</script>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import RobotSkeletonView from '@/components/RobotSkeletonView.vue'
import { formatBytes } from '@/lib/format'
import { buildJointValues, computePose, normalizeQuat, quatToEuler } from '@/lib/replay/pose'
import { detectProfile, mapJoints } from '@/lib/replay/profiles'
import { MAX_BAG_BYTES, inspectRosbag, readRosbag } from '@/lib/replay/rosbag'

const SAMPLE = { file: 'samples/replay/luna-demo.bag', label: 'Luna 动作' }

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
const bagBytes = shallowRef(null)
const startTime = ref(0)
const duration = ref(0)
const current = ref(0)
const playing = ref(false)
const speed = ref(1)
const loop = ref(true)
const jointGap = ref(0.1)

let frameHandle = 0
let lastFrame = 0

const jointSeries = computed(() => result.value?.series?.[jointTopic.value] || null)
const imuSeries = computed(() => result.value?.series?.[imuTopic.value] || null)
const jointTopics = computed(() => topics.value.filter((topic) => topic.kind === 'joint'))
const imuTopics = computed(() => topics.value.filter((topic) => topic.kind === 'imu'))
const absoluteTime = computed(() => startTime.value + current.value)

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

async function applyTopics(bytes, jointName, imuName) {
  busy.value = true
  error.value = ''
  progress.value = 0
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const decoded = readRosbag(bytes, {
      topics: [jointName, imuName].filter(Boolean),
      onProgress: (value) => {
        progress.value = Math.round(value * 100)
      },
    })
    const joint = decoded.series[jointName]
    if (!joint) throw new Error(`话题 ${jointName} 没有可用的关节消息`)
    const imu = imuName ? decoded.series[imuName] : null
    const start = imu ? Math.max(joint.times[0], imu.times[0]) : joint.times[0]
    const end = imu ? Math.min(joint.times[joint.times.length - 1], imu.times[imu.times.length - 1]) : joint.times[joint.times.length - 1]
    if (!(end > start)) throw new Error('关节与 IMU 话题没有重叠的有效时间段')

    const detected = detectProfile(joint.names, joint.names.length, joint.named)
    result.value = decoded
    profile.value = detected
    mapping.value = mapJoints(detected, joint)
    startTime.value = start
    duration.value = end - start
    jointGap.value = Math.max(0.1, 10 * medianInterval(joint.times))
    resetPlayback()

    const list = [...decoded.warnings]
    if (/\.active$/i.test(fileName.value)) {
      list.unshift({
        level: 'info',
        message: '已按未完成录制打开 .active 文件，自动保留尾部截断前的完整数据块。',
      })
    }
    if (!detected.skeleton) {
      list.push({
        level: 'warn',
        message: `没有匹配的骨架（${detected.label}），仍会显示关节数值，但不会绘制 3D 姿态。`,
      })
    }
    if (joint.topic.includes('/motor/') && (detected.id === 'luna' || detected.id === 'oli')) {
      list.push({
        level: 'warn',
        message: '当前使用电机话题：并联踝/腰的电机角度与串行关节角不同，3D 姿态只作参考，不是实机串行关节角。',
      })
    }
    if (mapping.value.unmapped.length) {
      list.push({
        level: 'warn',
        message: `${mapping.value.unmapped.length} 个关节名未映射到骨架：${mapping.value.unmapped.slice(0, 6).join('、')}${mapping.value.unmapped.length > 6 ? ' 等' : ''}`,
      })
    }
    warnings.value = list
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
    progress.value = 0
  }
}

async function loadBytes(bytes, name, sample) {
  busy.value = true
  error.value = ''
  try {
    if (!bytes.length) throw new Error(`${name} 是空文件`)
    if (bytes.length > MAX_BAG_BYTES) {
      throw new Error(`${name} 超过 ${formatBytes(MAX_BAG_BYTES)} 上限`)
    }
    const info = inspectRosbag(bytes)
    topics.value = info.topics
    const joints = info.topics.filter((topic) => topic.kind === 'joint')
    if (!joints.length) {
      throw new Error('bag 里没有 JointState 话题；至少需要一个关节状态话题才能回放姿态')
    }
    const imus = info.topics.filter((topic) => topic.kind === 'imu')
    const joint = pickTopic(joints, ['/joint/state', '/motor/state'])
    const imu = pickTopic(imus, ['/ImuData', '/imu/data', '/imu'])
    bagBytes.value = bytes
    fileName.value = name
    sampleName.value = sample
    jointTopic.value = joint.name
    imuTopic.value = imu?.name || ''
    await applyTopics(bytes, jointTopic.value, imuTopic.value)
  } catch (cause) {
    fail(cause)
  }
}

async function handleFile(file) {
  if (!/\.(bag|active)$/i.test(file.name)) {
    fail(new Error('仅支持 ROS1 .bag / .active 文件'))
    return
  }
  if (file.size === 0) {
    fail(new Error('文件为空'))
    return
  }
  if (file.size > MAX_BAG_BYTES) {
    fail(new Error(`文件超过 ${formatBytes(MAX_BAG_BYTES)} 上限`))
    return
  }
  busy.value = true
  error.value = ''
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await loadBytes(bytes, file.name, '')
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function onDrop(event) {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) handleFile(file)
}

function onFileChange(event) {
  const file = event.target.files?.[0]
  if (file) handleFile(file)
  event.target.value = ''
}

async function loadSample() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${SAMPLE.file}`)
    if (!response.ok) throw new Error(`示例 bag 加载失败（HTTP ${response.status}）`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await loadBytes(bytes, SAMPLE.file.split('/').pop(), SAMPLE.label)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

async function reparse() {
  if (!bagBytes.value || !jointTopic.value) return
  await applyTopics(bagBytes.value, jointTopic.value, imuTopic.value || '')
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
  bagBytes.value = null
}

function clearAll() {
  pause()
  fail('')
  error.value = ''
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

function onKeydown(event) {
  const tag = event.target?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
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

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  pause()
})
</script>

<template>
  <main class="app-main">
    <section class="card input-card">
      <div class="card-head">
        <h2>导入机器人 bag</h2>
        <span v-if="fileName" class="badge">{{ fileName }}</span>
      </div>

      <label class="drop-zone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
        <input type="file" accept=".bag,.active" @change="onFileChange" />
        <span class="drop-title">拖拽 ROS1 .bag / .active 到这里，或点击选择文件</span>
        <span class="drop-hint">
          JointState + IMU · 未压缩或 lz4 · .active 自动恢复 · 最大
          {{ formatBytes(MAX_BAG_BYTES) }} · 数据只在浏览器本地处理
        </span>
      </label>

      <div class="actions">
        <button type="button" class="btn" :disabled="busy" @click="loadSample">示例：{{ SAMPLE.label }}</button>
        <button type="button" class="btn ghost" :disabled="busy" @click="clearAll">清空</button>
        <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
        <span v-if="busy" class="muted small">正在解析 {{ progress }}%…</span>
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

      <section v-if="warnings.length" class="card warnings-card">
        <h2>提示（{{ warnings.length }}）</h2>
        <ul class="warning-list">
          <li v-for="(warning, index) in warnings" :key="index" :class="`warn-${warning.level}`">
            {{ warning.message }}
          </li>
        </ul>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>姿态回放</h2>
          <span v-if="atGap" class="chip warn-chip">DATA GAP</span>
        </div>

        <RobotSkeletonView
          :points="pose?.points || null"
          :skeleton="profile?.skeleton || null"
          :empty-message="profile?.skeleton ? '当前时刻没有关节数据' : '未识别骨架，请展开下方关节角度查看数值'"
        />

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
            <dd>bag 记录时间</dd>
          </div>
        </dl>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>话题与型号</h2>
          <span class="badge">{{ profile?.label }}</span>
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
        </div>
        <p class="muted small">关节按名称映射到骨架；没有名称的 bag 按机型配置的硬件下标顺序映射。 未接入的机型会显示关节数值，不会凭空生成模型。</p>
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
  margin-top: 14px;
}

.topic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin-bottom: 10px;
}

.topic-grid label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--muted);
  font-size: 0.82rem;
}

.topic-grid select {
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
