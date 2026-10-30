<script setup>
import { computed, reactive, ref, shallowRef, watch } from 'vue'

import { downloadBlob, fileBaseName } from '@/lib/download'
import { generateEsiXml, generateSiiFromEsi, parseEsiXml, verifyEsiXml } from '@/lib/esi'
import { formatBytes, hex } from '@/lib/format'
import {
  COE_DETAIL_BITS,
  MAILBOX_PROTOCOLS,
  MAX_INPUT_BYTES,
  decodeHexInput,
  parseSii,
} from '@/lib/sii'

const SAMPLES = [
  { file: 'samples/limx-tron2.bin', label: 'Limx Tron2', kind: 'sii' },
  { file: 'samples/akd-eeprom.bin', label: 'Kollmorgen AKD', kind: 'sii' },
  { file: 'samples/limx-tron2.xml', label: 'Limx ESI XML', kind: 'esi' },
]

const MAX_XML_BYTES = 8 * 1024 * 1024

const PORT_LETTERS = { 1: 'Y', 3: 'E', 4: 'K' }
const PORT_CHOICES = [
  { value: 0, label: '未使用' },
  { value: 1, label: 'MII / 100BASE-TX' },
  { value: 2, label: 'Reserved' },
  { value: 3, label: 'EBUS' },
  { value: 4, label: 'Fast Hot Connect' },
]
const COE_SERVICES = COE_DETAIL_BITS.filter((service) => service.bit !== 0x01)

// Order and spelling follow ETG.2000 so the emitted XML matches TwinCAT's.
const STATE_MACHINE_TIMEOUT_FIELDS = [
  { key: 'preopTimeout', label: 'PreopTimeout' },
  { key: 'safeopOpTimeout', label: 'SafeopOpTimeout' },
  { key: 'backToInitTimeout', label: 'BackToInitTimeout' },
  { key: 'backToSafeopTimeout', label: 'BackToSafeopTimeout' },
]
const MAILBOX_TIMEOUT_FIELDS = [
  { key: 'requestTimeout', label: 'RequestTimeout' },
  { key: 'responseTimeout', label: 'ResponseTimeout' },
]

// A device description with no SII image behind it. The builder fills in the
// identity fields from the form and omits every optional category.
const BLANK_RESULT = {
  bytes: new Uint8Array(0),
  byteLength: 0,
  info: {
    vendorId: 0,
    productCode: 0,
    revisionNumber: 0,
    serialNumber: 0,
    eepromSizeBytes: 2048,
    eepromSizeRaw: 15,
    mailboxProtocols: 0,
  },
  general: null,
  strings: [],
  fmmus: [],
  syncManagers: [],
  txPdos: [],
  rxPdos: [],
  dc: null,
  categories: [],
  warnings: [],
}

const hexText = ref('')
const fileName = ref('')
const sampleName = ref('')
const busy = ref(false)
const dragging = ref(false)
const error = ref('')
const copied = ref(false)
const blank = ref(false)
const source = shallowRef(null)
const output = shallowRef(null)
const check = shallowRef(null)

const form = reactive({
  vendorName: 'Vendor (SII image)',
  vendorId: '00000000',
  productCode: '00000000',
  revision: '00000000',
  orderName: '',
  deviceName: '',
  groupName: 'Group',
  byteSize: '2048',
  configData: '',
  bootStrap: '',
  profileNo: '',
  ports: [0, 0, 0, 0],
  mailboxProtocols: 0,
  coeDetails: 0,
  coeSegmentedSdo: false,
  identificationReg134: false,
  stateMachine: { preopTimeout: '', safeopOpTimeout: '', backToInitTimeout: '', backToSafeopTimeout: '' },
  mailboxTimeout: { requestTimeout: '', responseTimeout: '' },
  smSizes: [
    { minSize: '34', maxSize: '256' },
    { minSize: '34', maxSize: '256' },
  ],
  includeMailbox: false,
  includeFmmu: false,
  includeSyncManagers: false,
  includePdos: false,
  includeDc: false,
})

const parsed = computed(() => source.value?.result || null)
// The parser, the exporter and the recompile all report their own warnings, so
// the same message can arrive more than once.
const warnings = computed(() => {
  const seen = new Set()
  const list = []
  for (const warning of [
    ...(parsed.value?.warnings || []),
    ...(output.value?.warnings || []),
    ...(check.value?.warnings || []),
  ]) {
    if (seen.has(warning.message)) continue
    seen.add(warning.message)
    list.push(warning)
  }
  return list
})

// Multi-device ESI files (the Beckhoff SSC sample ships four) let the user pick
// which device description to edit.
const deviceCount = computed(() => parsed.value?.esi?.deviceCount || 1)
const deviceOptions = computed(() => parsed.value?.esi?.devices || [])
const deviceIndex = computed(() => parsed.value?.esi?.deviceIndex || 0)
const expectedLabel = computed(() => (source.value?.kind === 'esi' ? '原 ESI 编译结果' : '原转储'))

const physics = computed(() => {
  const letters = []
  for (const value of form.ports) {
    const letter = PORT_LETTERS[value]
    if (!letter) break
    letters.push(letter)
  }
  return letters.join('')
})

const physicsGap = computed(() => {
  const firstBlocked = form.ports.findIndex((value) => !PORT_LETTERS[value])
  return firstBlocked !== -1 && form.ports.slice(firstBlocked).some((value) => PORT_LETTERS[value])
})

const coeLabels = computed(() => {
  if (!(form.mailboxProtocols & 0x04)) return []
  const labels = ['SDO']
  for (const service of COE_SERVICES) {
    if (form.coeDetails & service.bit) labels.push(service.label)
  }
  return labels
})

const stats = computed(() => {
  if (!output.value) return []
  const data = check.value?.summary
  const result = parsed.value
  const tx = data?.txPdoCount ?? result?.txPdos.length ?? 0
  const rx = data?.rxPdoCount ?? result?.rxPdos.length ?? 0
  return [
    {
      label: 'XML 大小',
      value: formatBytes(new TextEncoder().encode(output.value.xml).length),
      note: 'UTF-8 编码',
    },
    { label: 'EEPROM 大小', value: formatBytes(data?.byteSize ?? parseByteSize()), note: 'Eeprom ByteSize' },
    { label: '字符串', value: data?.stringCount ?? result?.strings.length ?? 0, note: 'SII Strings' },
    {
      label: 'SyncManager',
      value: data?.syncManagerCount ?? result?.syncManagers.length ?? 0,
      note: 'SM 条目',
    },
    { label: 'PDO', value: tx + rx, note: `Tx ${tx} · Rx ${rx}` },
    { label: 'DC', value: data?.dcCount ?? result?.dc?.elements.length ?? 0, note: '操作模式' },
  ]
})

function hexField(value) {
  return (Number(value) >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

function parseHexField(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^(?:#x|0x)/i, '')
    .replace(/[^0-9a-f]/gi, '')
  if (!cleaned) return 0
  const value = parseInt(cleaned, 16)
  return Number.isFinite(value) ? value >>> 0 : 0
}

function parseNumberField(text, fallback) {
  const value = String(text ?? '').trim()
  if (!value) return fallback
  const prefixed = value.match(/^(?:#x|0x)([0-9a-f]+)$/i)
  if (prefixed) return parseInt(prefixed[1], 16)
  const decimal = Number(value)
  return Number.isFinite(decimal) ? decimal : fallback
}

function parseByteSize() {
  const value = parseNumberField(form.byteSize, 2048)
  return value > 0 ? Math.floor(value) : 2048
}

function numericField(text, fallback) {
  const value = String(text ?? '').trim()
  if (!value) return fallback
  const parsed = parseNumberField(value, null)
  return parsed === null ? fallback : parsed
}

function normalizeHex(text, length) {
  return String(text ?? '')
    .replace(/(?:#x|0x)/gi, '')
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, length * 2)
    .toUpperCase()
}

function bytesHex(bytes, start, length) {
  const out = new Uint8Array(length)
  if (bytes?.length) out.set(bytes.subarray(start, Math.min(start + length, bytes.length)))
  return Array.from(out, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('')
}

// A timeout block is emitted only when at least one field is filled in.
function timeoutGroup(values, fields) {
  const timeouts = {}
  let found = false
  for (const field of fields) {
    const text = String(values[field.key] ?? '').trim()
    timeouts[field.key] = text ? numericField(text, 0) : 0
    if (text) found = true
  }
  return found ? timeouts : null
}

function smSizeOptions() {
  // Keep the sizes of SyncManagers the form does not model (SM2 and up).
  const sizes = { ...(source.value?.result?.esi?.syncManagerSizes || {}) }
  form.smSizes.forEach((entry, index) => {
    const minSize = numericField(entry.minSize, null)
    const maxSize = numericField(entry.maxSize, null)
    if (minSize !== null || maxSize !== null) sizes[index] = { minSize, maxSize }
  })
  return sizes
}

function hasProtocol(bit) {
  return (form.mailboxProtocols & bit) !== 0
}

function hasCoeService(bit) {
  return (form.coeDetails & bit) !== 0
}

function toggleProtocol(bit, event) {
  form.mailboxProtocols = event.target.checked
    ? form.mailboxProtocols | bit
    : form.mailboxProtocols & ~bit
  if (event.target.checked) form.includeMailbox = true
}

function toggleCoe(bit, event) {
  form.coeDetails = event.target.checked ? form.coeDetails | bit : form.coeDetails & ~bit
}

function seedFromResult(result) {
  const general = result.general || {}
  const esi = result.esi || {}
  const ports = general.ports || [0, 0, 0, 0]
  form.vendorName = esi.vendorName || 'Vendor (SII image)'
  form.vendorId = hexField(result.info.vendorId)
  form.productCode = hexField(result.info.productCode)
  form.revision = hexField(result.info.revisionNumber)
  form.orderName = general.orderName || ''
  form.deviceName = general.deviceName || general.orderName || ''
  form.groupName = general.groupName || 'Group'
  form.byteSize = String(result.info.eepromSizeBytes || result.byteLength || 2048)
  form.configData = esi.configData || bytesHex(result.bytes, 0, 10)
  form.bootStrap = esi.bootStrap || bytesHex(result.bytes, 0x28, 8)
  form.profileNo = esi.profileNo === null || esi.profileNo === undefined ? '' : String(esi.profileNo)
  form.ports = [ports[0] || 0, ports[1] || 0, ports[2] || 0, ports[3] || 0]
  form.mailboxProtocols = result.info.mailboxProtocols || 0
  form.coeDetails = general.coeDetails || 0
  form.coeSegmentedSdo = Boolean(esi.coeSegmentedSdo)
  form.identificationReg134 = Boolean(general.flags & 0x08)

  const stateMachine = esi.stateMachineTimeouts || null
  form.stateMachine = {}
  for (const field of STATE_MACHINE_TIMEOUT_FIELDS) {
    form.stateMachine[field.key] = stateMachine ? String(stateMachine[field.key] ?? '') : ''
  }
  const mailboxTimeout = esi.mailboxTimeouts || null
  form.mailboxTimeout = {}
  for (const field of MAILBOX_TIMEOUT_FIELDS) {
    form.mailboxTimeout[field.key] = mailboxTimeout ? String(mailboxTimeout[field.key] ?? '') : ''
  }

  form.smSizes = [0, 1].map((index) => {
    const sizes = esi.syncManagerSizes?.[index]
    return {
      minSize: sizes?.minSize === null || sizes?.minSize === undefined ? '34' : String(sizes.minSize),
      maxSize: sizes?.maxSize === null || sizes?.maxSize === undefined ? '256' : String(sizes.maxSize),
    }
  })

  form.includeMailbox = Boolean(result.info.mailboxProtocols || (general.flags & 0x04))
  form.includeFmmu = (result.fmmus || []).length > 0
  form.includeSyncManagers = (result.syncManagers || []).length > 0
  form.includePdos = (result.txPdos || []).length + (result.rxPdos || []).length > 0
  form.includeDc = Boolean(result.dc?.elements?.length)
}

function buildOptions() {
  const orderName = form.orderName.trim() || form.deviceName.trim() || 'Device'
  const deviceName = form.deviceName.trim() || orderName
  const options = {
    vendorName: form.vendorName.trim() || 'Vendor (SII image)',
    vendorId: parseHexField(form.vendorId),
    productCode: parseHexField(form.productCode),
    revisionNumber: parseHexField(form.revision),
    orderName,
    deviceName,
    groupName: form.groupName.trim() || 'Group',
    byteSize: parseByteSize(),
    physics: physics.value,
    mailboxProtocols: form.mailboxProtocols,
    // CoE always carries the SDO service bit; the rest are user selectable.
    coeDetails: (form.coeDetails & ~0x01) | (form.mailboxProtocols & 0x04 ? 0x01 : 0),
    coeSegmentedSdo: form.coeSegmentedSdo,
    identificationReg134: form.identificationReg134,
    stateMachineTimeouts: timeoutGroup(form.stateMachine, STATE_MACHINE_TIMEOUT_FIELDS),
    mailboxTimeouts: timeoutGroup(form.mailboxTimeout, MAILBOX_TIMEOUT_FIELDS),
    profileNo: numericField(form.profileNo, null),
    syncManagerSizes: smSizeOptions(),
    includeMailbox: form.includeMailbox,
    includeFmmu: form.includeFmmu,
    includeSyncManagers: form.includeSyncManagers,
    includePdos: form.includePdos,
    includeDc: form.includeDc,
  }
  // An empty field falls back to whatever the source provides.
  const configData = normalizeHex(form.configData, 10)
  if (configData) options.configData = configData
  const bootStrap = normalizeHex(form.bootStrap, 8)
  if (bootStrap) options.bootStrap = bootStrap
  return options
}

// The baseline for the round-trip diff: the source dump, or the image the
// original ESI compiles to when the editor was seeded from an XML file.
function expectedBytes() {
  const current = source.value
  if (!current) return null
  if (current.kind !== 'esi') return current.bytes || null
  if (current.expected === null) {
    try {
      current.expected = generateSiiFromEsi(current.text, { deviceIndex: current.deviceIndex }).bytes
    } catch {
      current.expected = undefined
    }
  }
  return current.expected || null
}

function generate() {
  if (!source.value && !blank.value) return
  const result = source.value?.result || BLANK_RESULT
  let generated
  try {
    generated = generateEsiXml(result, buildOptions())
  } catch (cause) {
    output.value = null
    check.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
    return
  }

  output.value = generated
  error.value = ''
  try {
    check.value = verifyEsiXml(generated.xml, expectedBytes())
  } catch (cause) {
    check.value = { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

watch(form, generate, { deep: true })

function fail(cause) {
  source.value = null
  blank.value = false
  output.value = null
  check.value = null
  error.value = cause instanceof Error ? cause.message : String(cause)
}

function applySii(result, bytes, name, sample) {
  blank.value = false
  source.value = { kind: 'sii', result, bytes, text: '', name, sample, deviceIndex: 0, expected: null }
  seedFromResult(result)
  generate()
}

function applyEsi(text, name, sample, index = 0) {
  const result = parseEsiXml(text, { deviceIndex: index })
  blank.value = false
  source.value = {
    kind: 'esi',
    result,
    bytes: null,
    text,
    name,
    sample,
    deviceIndex: result.esi.deviceIndex,
    expected: null,
  }
  seedFromResult(result)
  generate()
}

function selectDevice(event) {
  const current = source.value
  if (!current || current.kind !== 'esi') return
  busy.value = true
  error.value = ''
  try {
    applyEsi(current.text, current.name, current.sample, Number(event.target.value))
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function loadFromText() {
  const text = hexText.value.trim()
  if (!text) {
    error.value = '请先选择 EEPROM 转储、ESI XML 或粘贴相应内容'
    return
  }
  busy.value = true
  error.value = ''
  try {
    if (text.startsWith('<') || /<EtherCATInfo[\s>]/.test(text.slice(0, 2048))) {
      if (text.length > MAX_XML_BYTES) {
        throw new Error(`XML 内容超过 ${formatBytes(MAX_XML_BYTES)} 限制`)
      }
      fileName.value = ''
      sampleName.value = ''
      applyEsi(text, '', '')
      return
    }
    const decoded = decodeHexInput(text)
    if (decoded.bytes.length > MAX_INPUT_BYTES) {
      throw new Error(`输入数据超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    fileName.value = ''
    sampleName.value = ''
    applySii(parseSii(decoded.bytes), decoded.bytes, '', '')
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function looksLikeEsiXml(bytes) {
  if (bytes.length === 0) return false
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
  return /<EtherCATInfo[\s>]/.test(head) || /^\s*<\?xml/i.test(head)
}

function looksLikeHexText(bytes) {
  if (bytes.length === 0) return false
  const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  if (!/^[\t\n\r\x20-\x7e]*$/.test(sample)) return false
  return (
    /^\s*:/m.test(sample) ||
    /^(?:0x)?[0-9a-fA-F]{2,8}\s*:/m.test(sample) ||
    /^[\s,;0-9a-fA-FxX]+$/.test(sample)
  )
}

async function handleFile(file) {
  busy.value = true
  error.value = ''
  sampleName.value = ''
  try {
    if (file.size > MAX_XML_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_XML_BYTES)} 限制`)
    }
    // Only XML may be this large; reject an oversized dump before reading it.
    if (file.size > MAX_INPUT_BYTES && !/\.xml$|\.esi$/i.test(file.name)) {
      throw new Error(`文件超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (looksLikeEsiXml(bytes)) {
      hexText.value = ''
      fileName.value = file.name
      applyEsi(new TextDecoder().decode(bytes), file.name, '')
      return
    }
    if (file.size > MAX_INPUT_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    if (looksLikeHexText(bytes)) {
      const text = new TextDecoder().decode(bytes)
      if (text.length <= 100000) hexText.value = text
      const decoded = decodeHexInput(text)
      if (decoded.bytes.length > MAX_INPUT_BYTES) {
        throw new Error(`输入数据超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
      }
      fileName.value = file.name
      applySii(parseSii(decoded.bytes), decoded.bytes, file.name, '')
    } else {
      hexText.value = ''
      fileName.value = file.name
      applySii(parseSii(bytes), bytes, file.name, '')
    }
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

async function loadSample(sample) {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${sample.file}`)
    if (!response.ok) {
      throw new Error(`示例文件加载失败（HTTP ${response.status}）`)
    }
    hexText.value = ''
    fileName.value = sample.file.split('/').pop()
    sampleName.value = sample.label
    if (sample.kind === 'esi') {
      applyEsi(await response.text(), fileName.value, sample.label)
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer())
      applySii(parseSii(bytes), bytes, fileName.value, sample.label)
    }
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function loadBlank() {
  hexText.value = ''
  fileName.value = ''
  sampleName.value = ''
  error.value = ''
  source.value = null
  blank.value = true
  seedFromResult(BLANK_RESULT)
  generate()
}

function resetForm() {
  seedFromResult(source.value?.result || BLANK_RESULT)
  generate()
}

function clearAll() {
  hexText.value = ''
  fileName.value = ''
  sampleName.value = ''
  error.value = ''
  source.value = null
  blank.value = false
  output.value = null
  check.value = null
}

async function copyXml() {
  if (!output.value) return
  try {
    await navigator.clipboard.writeText(output.value.xml)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (cause) {
    error.value = `复制失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function downloadXml() {
  if (!output.value) return
  const base = fileBaseName(source.value?.name || form.orderName.trim() || 'esi', 'esi')
  downloadBlob(output.value.xml, `${base}.xml`, 'application/xml')
}

function downloadBin() {
  const bytes = check.value?.bytes
  if (!bytes) return
  const base = fileBaseName(source.value?.name || form.orderName.trim() || 'eeprom', 'eeprom')
  downloadBlob(bytes, `${base}.bin`, 'application/octet-stream')
}
</script>

<template>
  <main class="app-main">
    <section class="card input-card">
      <div class="card-head">
        <h2>输入 SII EEPROM 转储或 ESI XML</h2>
        <span v-if="fileName" class="badge">{{ fileName }}</span>
      </div>

      <label
        class="drop-zone"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input type="file" accept=".bin,.hex,.ihex,.txt,.eeprom,.xml,.esi" @change="onFileChange" />
        <span class="drop-title">拖拽 EEPROM 转储或 EtherCATInfo XML 到这里，或点击选择文件</span>
        <span class="drop-hint">
          .bin / .hex / .ihex / .txt / .xml / .esi · 转储最大 {{ formatBytes(MAX_INPUT_BYTES) }}
        </span>
      </label>

      <div class="input-divider"><span>或粘贴十六进制数据 / ESI XML</span></div>

      <textarea
        v-model="hexText"
        class="hex-input"
        spellcheck="false"
        rows="6"
        placeholder="0A 00 22 00 04 06 45 4B 31 31 30 30 ...&#10;&#10;也支持 Intel HEX（:10000000...）和带偏移的转储（0000: 0A 00 22 00 ...），或直接粘贴 &lt;EtherCATInfo&gt; XML"
      ></textarea>

      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy" @click="loadFromText">
          {{ busy ? '读取中…' : '读取并生成 XML' }}
        </button>
        <button
          v-for="sample in SAMPLES"
          :key="sample.file"
          type="button"
          class="btn"
          :disabled="busy"
          @click="loadSample(sample)"
        >
          示例：{{ sample.label }}
        </button>
        <button type="button" class="btn ghost" :disabled="busy" @click="loadBlank">空白模板</button>
        <button type="button" class="btn ghost" :disabled="busy" @click="clearAll">清空</button>
        <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
      </div>
    </section>

    <div v-if="error" class="card error-card" role="alert">
      <strong>无法生成 XML</strong>
      <p>{{ error }}</p>
    </div>

    <template v-if="output">
      <section class="stats-grid" aria-label="生成概览">
        <div v-for="stat in stats" :key="stat.label" class="card stat">
          <span class="stat-label">{{ stat.label }}</span>
          <span class="stat-value">{{ stat.value }}</span>
          <span v-if="stat.note" class="stat-note">{{ stat.note }}</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>ESI 设备描述</h2>
          <div class="actions inline-actions">
            <button type="button" class="btn small" @click="resetForm">重置为原始值</button>
            <button type="button" class="btn small" @click="copyXml">
              {{ copied ? '已复制' : '复制 XML' }}
            </button>
            <button type="button" class="btn small primary" @click="downloadXml">下载 .xml</button>
          </div>
        </div>
        <p class="muted small">
          修改下列字段后 XML 会实时重新生成。空白模板只包含身份信息与 Eeprom 段。
        </p>

        <div v-if="deviceCount > 1" class="form-section">
          <h3>文件中的设备（{{ deviceCount }} 个）</h3>
          <label class="field">
            <span>当前编辑的设备</span>
            <select :value="deviceIndex" :disabled="busy" @change="selectDevice">
              <option v-for="device in deviceOptions" :key="device.index" :value="device.index">
                第 {{ device.index + 1 }} 个：{{ device.orderName || '（未命名）' }}
              </option>
            </select>
          </label>
          <p class="muted small">切换设备会重新载入该设备的字段，当前未保存的修改会丢失。</p>
        </div>

        <div class="form-grid">
          <label class="field">
            <span>厂商名称</span>
            <input v-model="form.vendorName" type="text" />
          </label>
          <label class="field">
            <span>厂商 ID（十六进制）</span>
            <input v-model="form.vendorId" type="text" class="mono" spellcheck="false" />
          </label>
          <label class="field">
            <span>产品码（十六进制）</span>
            <input v-model="form.productCode" type="text" class="mono" spellcheck="false" />
          </label>
          <label class="field">
            <span>修订号（十六进制）</span>
            <input v-model="form.revision" type="text" class="mono" spellcheck="false" />
          </label>
          <label class="field">
            <span>订货号 / Type</span>
            <input v-model="form.orderName" type="text" />
          </label>
          <label class="field">
            <span>设备名称</span>
            <input v-model="form.deviceName" type="text" />
          </label>
          <label class="field">
            <span>组（GroupType）</span>
            <input v-model="form.groupName" type="text" />
          </label>
          <label class="field">
            <span>EEPROM 大小（字节，128 的倍数）</span>
            <input v-model="form.byteSize" type="text" class="mono" spellcheck="false" />
          </label>
        </div>

        <div class="form-section">
          <h3>端口（Physics）</h3>
          <div class="port-grid">
            <label v-for="(_, index) in form.ports" :key="index" class="field">
              <span>Port {{ index }}</span>
              <select v-model.number="form.ports[index]">
                <option v-for="option in PORT_CHOICES" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
          </div>
          <p class="muted small">
            Physics 属性：<span class="mono">{{ physics || '（无）' }}</span>
            <span v-if="physicsGap" class="warn-inline">
              未使用或保留端口之后仍有端口定义，ESI 无法表达这种间隔，后续端口会被忽略。
            </span>
          </p>
        </div>

        <div class="form-section">
          <h3>Eeprom 固定头</h3>
          <div class="form-grid">
            <label class="field">
              <span>ConfigData（10 字节十六进制）</span>
              <input v-model="form.configData" type="text" class="mono" spellcheck="false" />
            </label>
            <label class="field">
              <span>BootStrap（8 字节十六进制）</span>
              <input v-model="form.bootStrap" type="text" class="mono" spellcheck="false" />
            </label>
          </div>
          <p class="muted small">
            ConfigData 决定 PDI 类型与 PDI Control；BootStrap 是引导模式下的邮箱地址。留空则沿用来源的取值。
          </p>
        </div>

        <div class="form-section">
          <h3>Info 超时（仅 ESI）</h3>
          <div class="form-grid">
            <label v-for="field in STATE_MACHINE_TIMEOUT_FIELDS" :key="field.key" class="field">
              <span>{{ field.label }}（ms）</span>
              <input v-model="form.stateMachine[field.key]" type="text" class="mono" spellcheck="false" />
            </label>
          </div>
          <div class="form-grid">
            <label v-for="field in MAILBOX_TIMEOUT_FIELDS" :key="field.key" class="field">
              <span>{{ field.label }}（ms）</span>
              <input v-model="form.mailboxTimeout[field.key]" type="text" class="mono" spellcheck="false" />
            </label>
          </div>
          <p class="muted small">
            Info/StateMachine/Timeout 与 Info/Mailbox/Timeout 只存在于 ESI 中，不会写入 SII 镜像；全部留空则省略该段。
          </p>
        </div>

        <div class="form-section">
          <h3>Profile 与邮箱 SyncManager</h3>
          <div class="form-grid">
            <label class="field">
              <span>ProfileNo（可选）</span>
              <input v-model="form.profileNo" type="text" class="mono" spellcheck="false" />
            </label>
            <template v-for="(size, index) in form.smSizes" :key="`sm-${index}`">
              <label class="field">
                <span>SM{{ index }} MinSize</span>
                <input v-model="size.minSize" type="text" class="mono" spellcheck="false" />
              </label>
              <label class="field">
                <span>SM{{ index }} MaxSize</span>
                <input v-model="size.maxSize" type="text" class="mono" spellcheck="false" />
              </label>
            </template>
          </div>
          <p class="muted small">
            MinSize / MaxSize 只影响 ESI 的 Sm 属性，SII 的 SyncManager 类别只保存 DefaultSize。
          </p>
        </div>

        <div class="form-section">
          <h3>邮箱（Mailbox）</h3>
          <label class="check">
            <input v-model="form.includeMailbox" type="checkbox" />
            写入 Mailbox 元素
          </label>
          <div class="check-grid" :class="{ disabled: !form.includeMailbox }">
            <label v-for="protocol in MAILBOX_PROTOCOLS" :key="protocol.bit" class="check">
              <input
                type="checkbox"
                :checked="hasProtocol(protocol.bit)"
                :disabled="!form.includeMailbox"
                @change="toggleProtocol(protocol.bit, $event)"
              />
              {{ protocol.label }}
            </label>
          </div>
          <p class="muted small">
            mailboxProtocols = <span class="mono">{{ hex(form.mailboxProtocols, 4) }}</span>
          </p>
          <div
            class="check-grid"
            :class="{ disabled: !form.includeMailbox || !(form.mailboxProtocols & 0x04) }"
          >
            <label v-for="service in COE_SERVICES" :key="service.bit" class="check">
              <input
                type="checkbox"
                :checked="hasCoeService(service.bit)"
                :disabled="!form.includeMailbox || !(form.mailboxProtocols & 0x04)"
                @change="toggleCoe(service.bit, $event)"
              />
              {{ service.label }}
            </label>
          </div>
          <p class="muted small">CoE 服务（SDO 始终启用）：{{ coeLabels.join(' / ') || '无' }}</p>
          <label class="check">
            <input
              v-model="form.coeSegmentedSdo"
              type="checkbox"
              :disabled="!form.includeMailbox || !(form.mailboxProtocols & 0x04)"
            />
            SegmentedSdo（分段 SDO，仅存在于 ESI）
          </label>
        </div>

        <div class="form-section">
          <h3>输出内容</h3>
          <div class="check-grid">
            <label class="check">
              <input v-model="form.includeFmmu" type="checkbox" />
              FMMU
            </label>
            <label class="check">
              <input v-model="form.includeSyncManagers" type="checkbox" />
              SyncManager
            </label>
            <label class="check">
              <input v-model="form.includePdos" type="checkbox" />
              TxPDO / RxPDO
            </label>
            <label class="check">
              <input v-model="form.includeDc" type="checkbox" />
              DC 操作模式
            </label>
            <label class="check">
              <input v-model="form.identificationReg134" type="checkbox" />
              IdentificationReg134
            </label>
          </div>
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
          <h2>回归校验</h2>
          <div class="actions inline-actions">
            <button type="button" class="btn small" :disabled="!check?.bytes" @click="downloadBin">
              下载 .bin
            </button>
          </div>
        </div>
        <p v-if="check?.error" class="muted">
          无法从生成的 XML 重新生成镜像：{{ check.error }}
        </p>
        <template v-else-if="check">
          <p v-if="check.identical === true" class="roundtrip-ok">
            生成的 XML 重新编译后与{{ expectedLabel }}逐字节一致（{{ formatBytes(check.actualLength) }}）。
          </p>
          <template v-else-if="check.identical === false">
            <p class="roundtrip-diff">
              与{{ expectedLabel }}有 {{ check.diffCount }} 个字节不同（原
              {{ formatBytes(check.expectedLength) }} / 新 {{ formatBytes(check.actualLength) }}）。
              修改身份字段、端口或输出内容后出现差异属预期。
            </p>
            <div v-if="check.firstDiffs.length" class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>偏移</th><th>原值</th><th>重新生成</th></tr>
                </thead>
                <tbody>
                  <tr v-for="diff in check.firstDiffs" :key="diff.offset">
                    <td class="mono">{{ hex(diff.offset, 4) }}</td>
                    <td class="mono">{{ diff.expected === null ? '—' : hex(diff.expected, 2) }}</td>
                    <td class="mono">{{ diff.actual === null ? '—' : hex(diff.actual, 2) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <p v-else class="muted small">
            已从生成的 XML 重新编译出 {{ formatBytes(check.actualLength) }} 的镜像；没有可对比的基准。
          </p>
        </template>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>EtherCATInfo XML</h2>
          <div class="actions inline-actions">
            <button type="button" class="btn small" @click="copyXml">
              {{ copied ? '已复制' : '复制 XML' }}
            </button>
            <button type="button" class="btn small primary" @click="downloadXml">下载 .xml</button>
          </div>
        </div>
        <textarea
          class="hex-input xml-input xml-preview"
          readonly
          wrap="off"
          spellcheck="false"
          :value="output.xml"
        ></textarea>
      </section>
    </template>

    <section v-else-if="!error" class="empty-state">
      <h2>等待输入</h2>
      <p>
        上传 SII EEPROM 转储或 EtherCATInfo XML 后，这里会生成可编辑的设备描述。导入 ESI 时会保留状态机超时、Profile、SyncManager 尺寸等 ESI 专有字段，并提示哪些内容无法写入 SII 镜像。也可以直接使用“空白模板”从零编辑设备描述。
      </p>
    </section>
  </main>
</template>
