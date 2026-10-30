<script setup>
import { computed, reactive, ref, shallowRef, watch } from 'vue'

import CategoryTable from '@/components/CategoryTable.vue'
import DcTable from '@/components/DcTable.vue'
import HexDump from '@/components/HexDump.vue'
import PdoTable from '@/components/PdoTable.vue'
import StringsTable from '@/components/StringsTable.vue'
import SyncManagerTable from '@/components/SyncManagerTable.vue'
import { downloadBlob, fileBaseName } from '@/lib/download'
import * as editor from '@/lib/editor'
import { generateEsiXml, verifyEsiXml } from '@/lib/esi'
import { formatBytes, hex, parseDecValue, parseHexValue } from '@/lib/format'
import {
  COE_DETAIL_BITS,
  DATA_TYPE_NAMES,
  FMMU_USAGE,
  GENERAL_FLAG_BITS,
  MAILBOX_PROTOCOLS,
  MAX_INPUT_BYTES,
  PORT_TYPES,
  parseSii,
  setBits,
} from '@/lib/sii'

const SAMPLES = [
  { file: 'samples/akd-eeprom.bin', label: 'Kollmorgen AKD' },
  { file: 'samples/limx-tron2.bin', label: 'Limx Tron2' },
]

const FMMU_CHOICES = [0x00, 0x01, 0x02, 0x03, 0xff].map((value) => ({
  value,
  label: FMMU_USAGE[value],
}))
const PORT_CHOICES = PORT_TYPES.map((label, value) => ({ value, label }))
const COE_SERVICES = COE_DETAIL_BITS.filter((service) => service.bit !== 0x01)

const fileName = ref('')
const sampleName = ref('')
const vendorName = ref('Vendor (SII image)')
const error = ref('')
const exportError = ref('')
const busy = ref(false)
const dragging = ref(false)
const copied = ref(false)
const source = shallowRef(null)
const output = shallowRef(null)
const check = shallowRef(null)
const model = reactive(editor.createEmptyModel())

const info = computed(() => model.info)
const general = computed(() => model.general)

const pageWarnings = computed(() => {
  const list = []
  const version = model.info.eepromVersion
  if (version !== null && version !== undefined && version !== 1) {
    list.push({
      level: 'info',
      message: `EEPROM 版本 ${hex(version, 4)} 无法写入 ESI，重新编译时为 0x0001。`,
    })
  }
  const unreferenced = editor.unreferencedStrings(model).filter((entry) => entry.text)
  if (unreferenced.length) {
    list.push({
      level: 'info',
      message: `有 ${unreferenced.length} 个字符串没有被任何名称引用，导出 XML 时会丢失。`,
    })
  }
  return list
})

const warnings = computed(() => {
  const seen = new Set()
  const list = []
  for (const warning of [
    ...(source.value?.parsed?.warnings || []),
    ...pageWarnings.value,
    ...(output.value?.warnings || []),
    ...(check.value?.warnings || []),
  ]) {
    if (seen.has(warning.message)) continue
    seen.add(warning.message)
    list.push(warning)
  }
  return list
})

const stats = computed(() => {
  const parsed = source.value?.parsed
  if (!parsed) return []
  const checksum = parsed.info.checksumValid
  return [
    {
      label: '原始校验和',
      value: checksum === null ? '—' : checksum ? '通过' : '失败',
      note: checksum === false ? `计算 ${hex(parsed.info.checksumComputed, 2)}` : 'CRC-8',
      tone: checksum === false ? 'tone-error' : checksum === true ? 'tone-ok' : '',
    },
    {
      label: 'EEPROM 大小',
      value: formatBytes(model.info.eepromSizeBytes),
      note: `原始输入 ${formatBytes(parsed.byteLength)}`,
    },
    {
      label: '类别',
      value: parsed.categories.length,
      note: `${parsed.categories.filter((category) => category.type !== 0xffff).length} 个数据类别`,
    },
    { label: '字符串', value: model.strings.length, note: 'SII Strings' },
    { label: 'SyncManager', value: model.syncManagers.length, note: 'SM 条目' },
    {
      label: 'PDO',
      value: model.txPdos.length + model.rxPdos.length,
      note: `Tx ${model.txPdos.length} · Rx ${model.rxPdos.length}`,
    },
  ]
})

const mailboxProtocolLabels = computed(() =>
  MAILBOX_PROTOCOLS.filter(
    (protocol) => ((model.info.mailboxProtocols ?? 0) & protocol.bit) !== 0,
  ).map((protocol) => protocol.label),
)

const coeLabels = computed(() => setBits(model.general.coeDetails ?? 0, COE_DETAIL_BITS))
const generalFlagLabels = computed(() => setBits(model.general.flags ?? 0, GENERAL_FLAG_BITS))
const portsWordValue = computed(() => editor.portsWord(model.general.ports))
const portLabels = computed(() =>
  model.general.ports.map((value, index) => ({
    index,
    value,
    label: PORT_TYPES[value] || `Type ${value}`,
  })),
)

const configDataPreview = computed(
  () => editor.editorOptions(model, vendorName.value).configData,
)
const bootStrapPreview = computed(
  () => editor.editorOptions(model, vendorName.value).bootStrap,
)

const navItems = [
  { id: 'overview', label: '概览' },
  { id: 'header', label: '固定头' },
  { id: 'mailbox', label: '邮箱' },
  { id: 'general', label: 'General' },
  { id: 'strings', label: '字符串' },
  { id: 'fmmu', label: 'FMMU' },
  { id: 'sm', label: 'SyncManager' },
  { id: 'pdo', label: 'PDO' },
  { id: 'dc', label: 'DC' },
  { id: 'categories', label: '类别' },
  { id: 'export', label: '导出 XML' },
  { id: 'hex', label: '原始数据' },
]

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function setHex(target, key, event, bits = 16) {
  const value = parseHexValue(event.target.value)
  target[key] = bits >= 32 ? value >>> 0 : value & ((1 << bits) - 1)
}

function setDec(target, key, event, max = 0xffff) {
  target[key] = Math.min(Math.max(parseDecValue(event.target.value), 0), max)
}

function setSigned(target, key, event) {
  target[key] = Math.max(-32768, Math.min(32767, parseDecValue(event.target.value)))
}

function toggleBit(target, key, bit, event) {
  target[key] = event.target.checked ? target[key] | bit : target[key] & ~bit
}

function toggleProtocol(bit, event) {
  toggleBit(model.info, 'mailboxProtocols', bit, event)
}

function toggleCoe(bit, event) {
  toggleBit(model.general, 'coeDetails', bit, event)
}

function toggleGeneralFlag(bit, event) {
  toggleBit(model.general, 'flags', bit, event)
}

function setEepromSize(event) {
  const value = parseDecValue(event.target.value, 2048)
  const bytes = Math.max(128, Math.round(value / 128) * 128)
  model.info.eepromSizeBytes = bytes
  model.info.eepromSizeRaw = bytes / 128 - 1
}

function setName(owner, nameKey, indexKey, event) {
  editor.setName(model, owner, nameKey, indexKey, event.target.value)
}

function setStringText(index, text) {
  editor.setStringText(model, index, text)
}

function setFmmuUsage(index, event) {
  const usage = Number(event.target.value) || 0
  const fmmu = model.fmmus[index]
  if (!fmmu) return
  fmmu.usage = usage
  fmmu.label = FMMU_USAGE[usage] || `Unknown (0x${usage.toString(16).toUpperCase()})`
}

function updateSyncManager(index, key, value) {
  const manager = model.syncManagers[index]
  if (manager) manager[key] = value
}

function pdoList(kind) {
  return kind === 'tx' ? model.txPdos : model.rxPdos
}

function updatePdo(kind, index, key, value) {
  const pdo = pdoList(kind)[index]
  if (!pdo) return
  if (key === 'name') editor.setName(model, pdo, 'name', 'nameIndex', value)
  else pdo[key] = value
}

function updatePdoEntry(kind, pdoIndex, entryIndex, key, value) {
  const entry = pdoList(kind)[pdoIndex]?.entries[entryIndex]
  if (!entry) return
  if (key === 'name') {
    editor.setName(model, entry, 'name', 'nameIndex', value)
  } else if (key === 'dataType') {
    entry.dataType = value
    entry.dataTypeName = DATA_TYPE_NAMES[value] || ''
  } else {
    entry[key] = value
  }
}

function updateDc(index, key, value) {
  const element = model.dc.elements[index]
  if (!element) return
  if (key === 'name') editor.setName(model, element, 'name', 'nameIndex', value)
  else if (key === 'description') editor.setName(model, element, 'description', 'descIndex', value)
  else element[key] = value
}

function regenerate() {
  if (!source.value) return
  let generated
  try {
    generated = generateEsiXml(
      editor.editorResult(model, source.value.bytes),
      editor.editorOptions(model, vendorName.value),
    )
  } catch (cause) {
    output.value = null
    check.value = null
    exportError.value = `生成 XML 失败：${messageOf(cause)}`
    return
  }

  output.value = generated
  exportError.value = ''
  try {
    check.value = verifyEsiXml(generated.xml, source.value.bytes)
  } catch (cause) {
    check.value = { error: messageOf(cause) }
  }
}

watch(model, regenerate, { deep: true })
watch(vendorName, regenerate)

function applyParsed(parsed, name, sample) {
  source.value = { name, bytes: parsed.bytes, parsed }
  Object.assign(model, editor.createEditorModel(parsed))
  vendorName.value = 'Vendor (SII image)'
  fileName.value = name
  sampleName.value = sample || ''
  error.value = ''
  exportError.value = ''
}

function fail(cause) {
  source.value = null
  output.value = null
  check.value = null
  fileName.value = ''
  sampleName.value = ''
  exportError.value = ''
  error.value = messageOf(cause)
}

async function handleFile(file) {
  busy.value = true
  error.value = ''
  try {
    if (!/\.bin$/i.test(file.name)) {
      throw new Error('仅支持 .bin 格式的 EEPROM 转储')
    }
    if (file.size === 0) throw new Error('文件为空')
    if (file.size > MAX_INPUT_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    applyParsed(parseSii(bytes), file.name, '')
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
    const bytes = new Uint8Array(await response.arrayBuffer())
    applyParsed(parseSii(bytes), sample.file.split('/').pop(), sample.label)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function clearAll() {
  source.value = null
  Object.assign(model, editor.createEmptyModel())
  fileName.value = ''
  sampleName.value = ''
  vendorName.value = 'Vendor (SII image)'
  error.value = ''
  exportError.value = ''
  output.value = null
  check.value = null
}

function baseName() {
  return fileBaseName(source.value?.name || 'eeprom', 'eeprom')
}

function downloadOriginal() {
  if (!source.value) return
  downloadBlob(source.value.bytes, `${baseName()}.bin`, 'application/octet-stream')
}

function downloadXml() {
  if (!output.value) return
  downloadBlob(output.value.xml, `${baseName()}.xml`, 'application/xml')
}

function downloadCompiled() {
  if (!check.value?.bytes) return
  downloadBlob(check.value.bytes, `${baseName()}-recompiled.bin`, 'application/octet-stream')
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
    exportError.value = `复制失败：${messageOf(cause)}`
  }
}

// Section links stay in-page; letting the browser follow them would replace
// the router hash and send the app back to the navigation page.
function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
<main class="app-main">
  <section class="card input-card">
    <div class="card-head">
      <h2>输入 EEPROM 转储</h2>
      <span v-if="fileName" class="badge">{{ fileName }}</span>
    </div>

    <label
      class="drop-zone"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" accept=".bin" @change="onFileChange" />
      <span class="drop-title">拖拽 .bin EEPROM 转储到这里，或点击选择文件</span>
      <span class="drop-hint">仅支持 .bin · 最大 {{ formatBytes(MAX_INPUT_BYTES) }}</span>
    </label>

    <div class="actions">
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
      <button type="button" class="btn ghost" :disabled="busy" @click="clearAll">清空</button>
      <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
    </div>
  </section>

  <div v-if="error" class="card error-card" role="alert">
    <strong>无法解析</strong>
    <p>{{ error }}</p>
  </div>

  <template v-if="source">
    <section class="stats-grid" aria-label="概览">
      <div v-for="stat in stats" :key="stat.label" class="card stat" :class="stat.tone">
        <span class="stat-label">{{ stat.label }}</span>
        <span class="stat-value">{{ stat.value }}</span>
        <span v-if="stat.note" class="stat-note">{{ stat.note }}</span>
      </div>
    </section>

    <nav class="section-nav" aria-label="章节导航">
      <a
        v-for="item in navItems"
        :key="item.id"
        :href="`#${item.id}`"
        @click.prevent="scrollToSection(item.id)"
      >{{ item.label }}</a>
    </nav>

    <section v-if="warnings.length" class="card warnings-card">
      <h2>提示（{{ warnings.length }}）</h2>
      <ul class="warning-list">
        <li v-for="(warning, index) in warnings" :key="index" :class="`warn-${warning.level}`">
          {{ warning.message }}
        </li>
      </ul>
    </section>

    <section id="overview" class="card">
      <div class="card-head">
        <h2>设备概览</h2>
        <span v-if="sampleName" class="badge">{{ sampleName }}</span>
      </div>

      <div class="overview-grid">
        <div class="panel">
          <h3>身份信息</h3>
          <dl class="kv">
            <div><dt>厂商 ID</dt><dd class="mono">{{ hex(info.vendorId, 8) }}</dd></div>
            <div><dt>产品码</dt><dd class="mono">{{ hex(info.productCode, 8) }}</dd></div>
            <div><dt>修订号</dt><dd class="mono">{{ hex(info.revisionNumber, 8) }}</dd></div>
            <div><dt>序列号</dt><dd class="mono">{{ hex(info.serialNumber, 8) }}</dd></div>
            <div><dt>配置站别名</dt><dd class="mono">{{ hex(info.stationAlias, 4) }}（{{ info.stationAlias ?? '—' }}）</dd></div>
            <div><dt>EEPROM 版本</dt><dd class="mono">{{ hex(info.eepromVersion, 4) }}</dd></div>
          </dl>
        </div>

        <div class="panel">
          <h3>设备名称</h3>
          <dl class="kv">
            <div><dt>设备名称</dt><dd>{{ general.deviceName || '—' }}</dd></div>
            <div><dt>订货号</dt><dd>{{ general.orderName || '—' }}</dd></div>
            <div><dt>组</dt><dd>{{ general.groupName || '—' }}</dd></div>
            <div><dt>图像</dt><dd>{{ general.imageName || '—' }}</dd></div>
            <div><dt>EBus 电流</dt><dd>{{ general.ebusCurrent ?? '—' }} mA</dd></div>
            <div><dt>物理内存地址</dt><dd class="mono">{{ hex(general.physicalMemoryAddress, 4) }}</dd></div>
          </dl>
        </div>

        <div class="panel">
          <h3>协议与端口</h3>
          <div class="chip-row">
            <span v-for="label in coeLabels" :key="label" class="chip accent">{{ label }}</span>
            <span v-if="!coeLabels.length" class="muted small">未启用 CoE 服务</span>
          </div>
          <div class="chip-row">
            <span v-if="general.foeDetails & 0x01" class="chip">FoE</span>
            <span v-if="general.eoeDetails & 0x01" class="chip">EoE</span>
            <span v-if="general.soeChannels" class="chip">SoE × {{ general.soeChannels }}</span>
            <span v-if="general.ds402Channels" class="chip">DS402 × {{ general.ds402Channels }}</span>
            <span v-if="general.sysmanClass" class="chip">Sysman class {{ general.sysmanClass }}</span>
          </div>
          <div class="chip-row">
            <span v-for="label in generalFlagLabels" :key="label" class="chip">{{ label }}</span>
            <span v-if="!generalFlagLabels.length" class="muted small">无标志位</span>
          </div>
          <div class="port-grid">
            <div v-for="port in portLabels" :key="port.index" class="port">
              <span class="muted small">Port {{ port.index }}</span>
              <span>{{ port.label }}</span>
            </div>
          </div>
        </div>

        <div class="panel">
          <h3>邮箱配置</h3>
          <dl class="kv">
            <div><dt>标准接收</dt><dd class="mono">{{ hex(info.standard.rxOffset, 4) }} · {{ info.standard.rxSize }} B</dd></div>
            <div><dt>标准发送</dt><dd class="mono">{{ hex(info.standard.txOffset, 4) }} · {{ info.standard.txSize }} B</dd></div>
            <div><dt>Bootstrap 接收</dt><dd class="mono">{{ hex(info.bootstrap.rxOffset, 4) }} · {{ info.bootstrap.rxSize }} B</dd></div>
            <div><dt>Bootstrap 发送</dt><dd class="mono">{{ hex(info.bootstrap.txOffset, 4) }} · {{ info.bootstrap.txSize }} B</dd></div>
            <div>
              <dt>协议</dt>
              <dd class="chip-row compact">
                <span v-for="label in mailboxProtocolLabels" :key="label" class="chip accent">{{ label }}</span>
                <span v-if="!mailboxProtocolLabels.length" class="muted">无</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>

    <section id="header" class="card">
      <h2>身份与固定头</h2>
      <p class="muted small">
        多字节字段均为小端。带 <span class="sii-only">*</span> 的字段只存在于 SII 镜像中，导出 ESI XML 时无法保留。
      </p>

      <div class="form-grid">
        <label class="field">
          <span>厂商 ID（十六进制）</span>
          <input class="mono" :value="hex(info.vendorId, 8)" spellcheck="false" @change="setHex(info, 'vendorId', $event, 32)" />
        </label>
        <label class="field">
          <span>产品码（十六进制）</span>
          <input class="mono" :value="hex(info.productCode, 8)" spellcheck="false" @change="setHex(info, 'productCode', $event, 32)" />
        </label>
        <label class="field">
          <span>修订号（十六进制）</span>
          <input class="mono" :value="hex(info.revisionNumber, 8)" spellcheck="false" @change="setHex(info, 'revisionNumber', $event, 32)" />
        </label>
        <label class="field">
          <span>序列号（十六进制）<span class="sii-only">*</span></span>
          <input class="mono" :value="hex(info.serialNumber, 8)" spellcheck="false" @change="setHex(info, 'serialNumber', $event, 32)" />
        </label>
      </div>

      <div class="form-section">
        <h3>PDI 与站别名（ConfigData）</h3>
        <div class="form-grid">
          <label class="field">
            <span>PDI Control（0x00）</span>
            <input class="mono" :value="hex(info.pdiControl, 4)" spellcheck="false" @change="setHex(info, 'pdiControl', $event)" />
          </label>
          <label class="field">
            <span>ESC Configuration（0x01）</span>
            <input class="mono" :value="hex(info.pdiConfiguration, 4)" spellcheck="false" @change="setHex(info, 'pdiConfiguration', $event)" />
          </label>
          <label class="field">
            <span>Sync Impulse Length（0x02）</span>
            <input class="mono" :value="hex(info.syncImpulseLength, 4)" spellcheck="false" @change="setHex(info, 'syncImpulseLength', $event)" />
          </label>
          <label class="field">
            <span>PDI Configuration 2（0x03）</span>
            <input class="mono" :value="hex(info.pdiConfiguration2, 4)" spellcheck="false" @change="setHex(info, 'pdiConfiguration2', $event)" />
          </label>
          <label class="field">
            <span>Configured Station Alias（0x04）</span>
            <input class="mono" :value="hex(info.stationAlias, 4)" spellcheck="false" @change="setHex(info, 'stationAlias', $event)" />
          </label>
        </div>
        <p class="muted small mono break-all">ConfigData = {{ configDataPreview }}</p>
      </div>

      <div class="form-section">
        <h3>保留字与硬件延迟 <span class="sii-only">*</span></h3>
        <div class="form-grid">
          <label class="field">
            <span>Reserved（0x05）</span>
            <input class="mono" :value="hex(info.reserved1, 4)" spellcheck="false" @change="setHex(info, 'reserved1', $event)" />
          </label>
          <label class="field">
            <span>Reserved（0x06）</span>
            <input class="mono" :value="hex(info.reserved2, 4)" spellcheck="false" @change="setHex(info, 'reserved2', $event)" />
          </label>
          <label class="field">
            <span>Execution Delay（0x10）</span>
            <input class="mono" :value="hex(info.executionDelay, 4)" spellcheck="false" @change="setHex(info, 'executionDelay', $event)" />
          </label>
          <label class="field">
            <span>Port 0 Delay（0x11）</span>
            <input class="mono" :value="hex(info.port0Delay, 4)" spellcheck="false" @change="setHex(info, 'port0Delay', $event)" />
          </label>
          <label class="field">
            <span>Port 1 Delay（0x12）</span>
            <input class="mono" :value="hex(info.port1Delay, 4)" spellcheck="false" @change="setHex(info, 'port1Delay', $event)" />
          </label>
        </div>
      </div>

      <div class="form-section">
        <h3>EEPROM</h3>
        <div class="form-grid">
          <label class="field">
            <span>大小（字节，128 的倍数）</span>
            <input class="mono" :value="info.eepromSizeBytes" @change="setEepromSize" />
          </label>
          <label class="field">
            <span>大小字（0x3E）</span>
            <input class="mono" :value="hex(info.eepromSizeRaw, 4)" readonly />
          </label>
          <label class="field">
            <span>版本（0x3F）<span class="sii-only">*</span></span>
            <input class="mono" :value="hex(info.eepromVersion, 4)" spellcheck="false" @change="setHex(info, 'eepromVersion', $event)" />
          </label>
        </div>
      </div>
    </section>

    <section id="mailbox" class="card">
      <h2>邮箱（Mailbox）</h2>

      <div class="form-section">
        <h3>Bootstrap 邮箱（BootStrap）</h3>
        <div class="form-grid">
          <label class="field">
            <span>接收偏移（0x14）</span>
            <input class="mono" :value="hex(info.bootstrap.rxOffset, 4)" spellcheck="false" @change="setHex(info.bootstrap, 'rxOffset', $event)" />
          </label>
          <label class="field">
            <span>接收大小（0x15）</span>
            <input class="mono" :value="info.bootstrap.rxSize" @change="setDec(info.bootstrap, 'rxSize', $event)" />
          </label>
          <label class="field">
            <span>发送偏移（0x16）</span>
            <input class="mono" :value="hex(info.bootstrap.txOffset, 4)" spellcheck="false" @change="setHex(info.bootstrap, 'txOffset', $event)" />
          </label>
          <label class="field">
            <span>发送大小（0x17）</span>
            <input class="mono" :value="info.bootstrap.txSize" @change="setDec(info.bootstrap, 'txSize', $event)" />
          </label>
        </div>
        <p class="muted small mono break-all">BootStrap = {{ bootStrapPreview }}</p>
      </div>

      <div class="form-section">
        <h3>标准邮箱（0x18–0x1B）<span class="sii-only">*</span></h3>
        <div class="form-grid">
          <label class="field">
            <span>接收偏移</span>
            <input class="mono" :value="hex(info.standard.rxOffset, 4)" spellcheck="false" @change="setHex(info.standard, 'rxOffset', $event)" />
          </label>
          <label class="field">
            <span>接收大小</span>
            <input class="mono" :value="info.standard.rxSize" @change="setDec(info.standard, 'rxSize', $event)" />
          </label>
          <label class="field">
            <span>发送偏移</span>
            <input class="mono" :value="hex(info.standard.txOffset, 4)" spellcheck="false" @change="setHex(info.standard, 'txOffset', $event)" />
          </label>
          <label class="field">
            <span>发送大小</span>
            <input class="mono" :value="info.standard.txSize" @change="setDec(info.standard, 'txSize', $event)" />
          </label>
        </div>
        <p class="muted small">重新编译时标准邮箱由 SyncManager 0/1 生成。</p>
      </div>

      <div class="form-section">
        <h3>邮箱协议（0x1C）</h3>
        <div class="check-grid">
          <label v-for="protocol in MAILBOX_PROTOCOLS" :key="protocol.bit" class="check">
            <input
              type="checkbox"
              :checked="(info.mailboxProtocols & protocol.bit) !== 0"
              @change="toggleProtocol(protocol.bit, $event)"
            />
            {{ protocol.label }}
          </label>
        </div>
        <p class="muted small mono">mailboxProtocols = {{ hex(info.mailboxProtocols, 4) }}</p>
      </div>
    </section>

    <section id="general" class="card">
      <h2>General 类别</h2>

      <div class="form-grid">
        <label class="field">
          <span>设备名称</span>
          <input :value="general.deviceName" @input="setName(general, 'deviceName', 'nameStringIndex', $event)" />
        </label>
        <label class="field">
          <span>订货号 / Type</span>
          <input :value="general.orderName" @input="setName(general, 'orderName', 'orderStringIndex', $event)" />
        </label>
        <label class="field">
          <span>组（GroupType）</span>
          <input :value="general.groupName" @input="setName(general, 'groupName', 'groupStringIndex', $event)" />
        </label>
        <label class="field">
          <span>图像名称 <span class="sii-only">*</span></span>
          <input :value="general.imageName" @input="setName(general, 'imageName', 'imageStringIndex', $event)" />
        </label>
      </div>

      <div class="form-section">
        <h3>CoE 服务（SDO 始终启用）</h3>
        <div class="check-grid">
          <label v-for="service in COE_SERVICES" :key="service.bit" class="check">
            <input
              type="checkbox"
              :checked="(general.coeDetails & service.bit) !== 0"
              @change="toggleCoe(service.bit, $event)"
            />
            {{ service.label }}
          </label>
        </div>
      </div>

      <div class="form-section">
        <h3>协议明细与通道</h3>
        <div class="form-grid">
          <label class="check">
            <input
              type="checkbox"
              :checked="(general.foeDetails & 0x01) !== 0"
              @change="toggleBit(general, 'foeDetails', 0x01, $event)"
            />
            FoE 明细 <span class="sii-only">*</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              :checked="(general.eoeDetails & 0x01) !== 0"
              @change="toggleBit(general, 'eoeDetails', 0x01, $event)"
            />
            EoE 明细 <span class="sii-only">*</span>
          </label>
          <label class="field">
            <span>SoE 通道 <span class="sii-only">*</span></span>
            <input class="mono" :value="general.soeChannels" @change="setDec(general, 'soeChannels', $event, 0xff)" />
          </label>
          <label class="field">
            <span>DS402 通道 <span class="sii-only">*</span></span>
            <input class="mono" :value="general.ds402Channels" @change="setDec(general, 'ds402Channels', $event, 0xff)" />
          </label>
          <label class="field">
            <span>Sysman Class <span class="sii-only">*</span></span>
            <input class="mono" :value="general.sysmanClass" @change="setDec(general, 'sysmanClass', $event, 0xff)" />
          </label>
          <label class="field">
            <span>保留字节（offset 4）<span class="sii-only">*</span></span>
            <input class="mono" :value="hex(general.reserved, 2)" spellcheck="false" @change="setHex(general, 'reserved', $event, 8)" />
          </label>
          <label class="field">
            <span>EBus 电流（mA）<span class="sii-only">*</span></span>
            <input class="mono" :value="general.ebusCurrent" @change="setSigned(general, 'ebusCurrent', $event)" />
          </label>
          <label class="field">
            <span>物理内存地址 <span class="sii-only">*</span></span>
            <input class="mono" :value="hex(general.physicalMemoryAddress, 4)" spellcheck="false" @change="setHex(general, 'physicalMemoryAddress', $event)" />
          </label>
        </div>
      </div>

      <div class="form-section">
        <h3>General 标志位</h3>
        <div class="check-grid">
          <label v-for="flag in GENERAL_FLAG_BITS" :key="flag.bit" class="check">
            <input
              type="checkbox"
              :checked="(general.flags & flag.bit) !== 0"
              @change="toggleGeneralFlag(flag.bit, $event)"
            />
            {{ flag.label }}
          </label>
        </div>
        <p class="muted small">
          Mailbox DLL 与 Identification via AL Status 会写入 ESI；其余标志位只存在于 SII 镜像中。
        </p>
      </div>

      <div class="form-section">
        <h3>端口（Physics）</h3>
        <div class="port-grid">
          <label v-for="(port, index) in general.ports" :key="index" class="field">
            <span>Port {{ index }}</span>
            <select v-model="general.ports[index]">
              <option v-for="choice in PORT_CHOICES" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </label>
        </div>
        <p class="muted small mono">portsWord = {{ hex(portsWordValue, 4) }}</p>
      </div>
    </section>

    <section id="strings" class="card">
      <h2>字符串（Strings）</h2>
      <p class="muted small">
        索引从 1 开始。在名称字段中输入新名称会自动创建字符串；修改字符串会同步所有引用它的名称。
      </p>
      <StringsTable
        :strings="model.strings"
        @update-text="setStringText"
        @remove="editor.removeString(model, $event)"
      />
    </section>

    <section id="fmmu" class="card">
      <h2>FMMU</h2>
      <div v-if="model.fmmus.length" class="fmmu-list">
        <div v-for="(fmmu, index) in model.fmmus" :key="index" class="fmmu-row">
          <span class="badge">FMMU {{ index }}</span>
          <select class="table-input" :value="fmmu.usage" @change="setFmmuUsage(index, $event)">
            <option v-for="choice in FMMU_CHOICES" :key="choice.value" :value="choice.value">
              {{ choice.label }}
            </option>
          </select>
          <span v-if="fmmu.usage === 0xff" class="muted small">填充字节（位于末尾时导出会忽略）</span>
          <span class="spacer"></span>
          <button type="button" class="btn small ghost" @click="editor.removeFmmu(model, index)">
            删除
          </button>
        </div>
      </div>
      <p v-else class="muted small">没有 FMMU 条目。</p>
      <div class="actions">
        <button type="button" class="btn small" @click="editor.addFmmu(model)">添加 FMMU</button>
      </div>
    </section>

    <section id="sm" class="card">
      <h2>同步管理器（SyncManager）</h2>
      <p class="muted small">
        带 <span class="sii-only">*</span> 的字段（状态、类型）只存在于 SII 镜像中；重新编译时类型取 SM 序号 + 1。
      </p>
      <SyncManagerTable
        :sync-managers="model.syncManagers"
        @update="updateSyncManager"
        @add="editor.addSyncManager(model)"
        @remove="editor.removeSyncManager(model, $event)"
      />
    </section>

    <section id="pdo" class="card">
      <h2>PDO 映射</h2>
      <p class="muted small">
        带 <span class="sii-only">*</span> 的字段（同步方式、条目标志）不会写入 ESI；PDO 标志只有 Mandatory、Fixed、Depend on Slot 会保留。
      </p>
      <div class="pdo-group">
        <h3>TxPDO（从站发送 / 主站接收）</h3>
        <PdoTable
          :pdos="model.txPdos"
          @update-pdo="(index, key, value) => updatePdo('tx', index, key, value)"
          @remove-pdo="editor.removePdo(model, 'tx', $event)"
          @add-pdo="editor.addPdo(model, 'tx')"
          @add-entry="editor.addEntry(model, 'tx', $event)"
          @update-entry="(pdoIndex, entryIndex, key, value) => updatePdoEntry('tx', pdoIndex, entryIndex, key, value)"
          @remove-entry="(pdoIndex, entryIndex) => editor.removeEntry(model, 'tx', pdoIndex, entryIndex)"
        />
      </div>
      <div class="pdo-group">
        <h3>RxPDO（从站接收 / 主站发送）</h3>
        <PdoTable
          :pdos="model.rxPdos"
          @update-pdo="(index, key, value) => updatePdo('rx', index, key, value)"
          @remove-pdo="editor.removePdo(model, 'rx', $event)"
          @add-pdo="editor.addPdo(model, 'rx')"
          @add-entry="editor.addEntry(model, 'rx', $event)"
          @update-entry="(pdoIndex, entryIndex, key, value) => updatePdoEntry('rx', pdoIndex, entryIndex, key, value)"
          @remove-entry="(pdoIndex, entryIndex) => editor.removeEntry(model, 'rx', pdoIndex, entryIndex)"
        />
      </div>
    </section>

    <section id="dc" class="card">
      <h2>分布式时钟（DC）</h2>
      <p class="muted small">
        每个操作模式对应一个 24 字节元素。描述会写入 ESI XML，但 SII 镜像不保存描述字符串，重新编译时会丢失。
      </p>
      <DcTable
        :dc="model.dc"
        @update="updateDc"
        @add="editor.addDcOpMode(model)"
        @remove="editor.removeDcOpMode(model, $event)"
      />
    </section>

    <section id="categories" class="card">
      <h2>原始类别布局</h2>
      <p class="muted small">来自导入的转储，不随字段编辑更新。</p>
      <CategoryTable :categories="source.parsed.categories" />
    </section>

    <section id="export" class="card">
      <div class="card-head">
        <h2>导出 ESI XML</h2>
        <div class="actions inline-actions">
          <button type="button" class="btn small" :disabled="!output" @click="copyXml">
            {{ copied ? '已复制' : '复制 XML' }}
          </button>
          <button type="button" class="btn small primary" :disabled="!output" @click="downloadXml">
            下载 .xml
          </button>
        </div>
      </div>

      <div class="form-grid">
        <label class="field">
          <span>厂商名称（仅 ESI）</span>
          <input v-model="vendorName" type="text" />
        </label>
      </div>

      <p v-if="exportError" class="warn-inline">{{ exportError }}</p>
      <p v-else class="muted small">
        编辑后的字段会实时反映到 XML；导出前已用内置 EEPROM 生成器重新编译并和原始转储比对。
      </p>

      <div class="form-section">
        <h3>生成器重新编译校验</h3>
        <p v-if="!output" class="muted small">尚未生成 XML。</p>
        <template v-else-if="check?.error">
          <p class="muted">无法从生成的 XML 重新生成镜像：{{ check.error }}</p>
        </template>
        <template v-else-if="check">
          <p v-if="check.identical === true" class="roundtrip-ok">
            生成的 XML 重新编译后与原始转储逐字节一致（{{ formatBytes(check.actualLength) }}）。
          </p>
          <template v-else-if="check.identical === false">
            <p class="roundtrip-diff">
              与原始转储有 {{ check.diffCount }} 个字节不同（原 {{ formatBytes(check.expectedLength) }} /
              新 {{ formatBytes(check.actualLength) }}）。修改身份字段、端口或输出内容后出现差异属预期。
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
            已从生成的 XML 重新编译出 {{ formatBytes(check.actualLength) }} 的镜像。
          </p>
          <div class="actions">
            <button type="button" class="btn small" :disabled="!check.bytes" @click="downloadCompiled">
              下载重新编译的 .bin
            </button>
          </div>
        </template>
      </div>

      <div class="form-section">
        <h3>EtherCATInfo XML</h3>
        <textarea
          class="hex-input xml-input xml-preview"
          readonly
          wrap="off"
          spellcheck="false"
          :value="output?.xml || ''"
        ></textarea>
      </div>
    </section>

    <section id="hex" class="card">
      <div class="card-head">
        <h2>原始数据</h2>
        <div class="actions inline-actions">
          <button type="button" class="btn small" @click="downloadOriginal">下载原始 .bin</button>
        </div>
      </div>
      <HexDump :bytes="source.bytes" />
    </section>
  </template>

  <section v-else-if="!error" class="empty-state">
    <h2>等待输入</h2>
    <p>
      上传 .bin 格式的 SII EEPROM 转储后，可在此编辑固定头、General、字符串、FMMU、SyncManager、PDO 与 DC，
      并导出 ESI XML。所有解析出的字段都支持新增、修改和删除。
    </p>
  </section>
</main>
</template>
