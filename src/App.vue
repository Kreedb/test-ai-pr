<script setup>
import { computed, ref, shallowRef } from 'vue'

import CategoryTable from '@/components/CategoryTable.vue'
import DcTable from '@/components/DcTable.vue'
import FieldTable from '@/components/FieldTable.vue'
import HexDump from '@/components/HexDump.vue'
import PdoTable from '@/components/PdoTable.vue'
import StringsTable from '@/components/StringsTable.vue'
import SyncManagerTable from '@/components/SyncManagerTable.vue'
import { formatBytes, hex } from '@/lib/format'
import {
  COE_DETAIL_BITS,
  GENERAL_FLAG_BITS,
  MAILBOX_PROTOCOLS,
  MAX_INPUT_BYTES,
  PORT_TYPES,
  decodeHexInput,
  exportSii,
  parseSii,
  setBits,
} from '@/lib/sii'

const FORMAT_LABELS = {
  binary: '二进制',
  hex: '十六进制文本',
  'hex-dump': '十六进制转储',
  'intel-hex': 'Intel HEX',
}

const hexText = ref('')
const fileName = ref('')
const inputFormat = ref('')
const error = ref('')
const result = shallowRef(null)
const inputWarnings = ref([])
const busy = ref(false)
const dragging = ref(false)
const copied = ref(false)
const sampleName = ref('')

const info = computed(() => result.value?.info || {})
const general = computed(() => result.value?.general || null)

const warnings = computed(() => [
  ...inputWarnings.value,
  ...(result.value?.warnings || []),
])

const stats = computed(() => {
  const parsed = result.value
  if (!parsed) return []
  const checksum = parsed.info.checksumValid
  return [
    {
      label: '校验和',
      value: checksum === null ? '—' : checksum ? '通过' : '失败',
      note: checksum === false ? `计算 ${hex(parsed.info.checksumComputed, 2)}` : 'CRC-8',
      tone: checksum === false ? 'tone-error' : checksum === true ? 'tone-ok' : '',
    },
    {
      label: 'EEPROM 大小',
      value: formatBytes(parsed.info.eepromSizeBytes),
      note: `输入 ${formatBytes(parsed.byteLength)}`,
    },
    {
      label: '类别',
      value: parsed.categories.length,
      note: `${parsed.categories.filter((category) => category.type !== 0xffff).length} 个数据类别`,
    },
    { label: '字符串', value: parsed.strings.length, note: 'SII Strings' },
    { label: 'SyncManager', value: parsed.syncManagers.length, note: 'SM 条目' },
    {
      label: 'PDO',
      value: parsed.txPdos.length + parsed.rxPdos.length,
      note: `Tx ${parsed.txPdos.length} · Rx ${parsed.rxPdos.length}`,
    },
  ]
})

const mailboxProtocolLabels = computed(() =>
  MAILBOX_PROTOCOLS.filter(
    (protocol) => ((info.value.mailboxProtocols ?? 0) & protocol.bit) !== 0,
  ).map((protocol) => protocol.label),
)

const coeLabels = computed(() => setBits(general.value?.coeDetails ?? 0, COE_DETAIL_BITS))
const generalFlagLabels = computed(() =>
  setBits(general.value?.flags ?? 0, GENERAL_FLAG_BITS),
)

const portLabels = computed(() => {
  const ports = general.value?.ports
  if (!ports) return []
  return ports.map((value, index) => ({
    index,
    value,
    label: PORT_TYPES[value] || `Type ${value}`,
  }))
})

const headerRows = computed(() => {
  const header = result.value?.info
  if (!header) return []

  const rows = []
  const add = (key, word, label, value, note = '') => {
    rows.push({ key, word, label, value, note })
  }

  add('pdi', '0x00', 'PDI Control', hex(header.pdiControl, 4), '低 8 位为 PDI 类型码')
  add('pdi-config', '0x01', 'ESC Configuration', hex(header.pdiConfiguration, 4), 'PDI 配置字')
  add('sync-impulse', '0x02', 'Sync Impulse Length', hex(header.syncImpulseLength, 4))
  add('pdi-config-2', '0x03', 'PDI Configuration 2', hex(header.pdiConfiguration2, 4))
  add(
    'alias',
    '0x04',
    'Configured Station Alias',
    `${hex(header.stationAlias, 4)}（${header.stationAlias ?? '—'}）`,
    '配置站别名',
  )
  add('reserved-1', '0x05', 'Reserved', hex(header.reserved1, 4))
  add('reserved-2', '0x06', 'Reserved', hex(header.reserved2, 4))
  add(
    'checksum',
    '0x07',
    'Checksum',
    `${hex(header.checksumStored, 4)} / 计算 ${hex(header.checksumComputed, 2)}`,
    'CRC-8，poly 0x07，init 0xFF，覆盖前 14 字节',
  )
  add('vendor', '0x08–0x09', 'Vendor ID', hex(header.vendorId, 8), 'u32，小端')
  add('product', '0x0A–0x0B', 'Product Code', hex(header.productCode, 8), 'u32，小端')
  add('revision', '0x0C–0x0D', 'Revision Number', hex(header.revisionNumber, 8), 'u32，小端')
  add('serial', '0x0E–0x0F', 'Serial Number', hex(header.serialNumber, 8), 'u32，小端')
  add(
    'delays',
    '0x10–0x13',
    'Reserved / Hardware Delays',
    `执行 ${hex(header.executionDelay, 4)} · 端口 0 ${hex(header.port0Delay, 4)} · 端口 1 ${hex(header.port1Delay, 4)}`,
    '部分厂商用作硬件延迟',
  )
  add('boot-rx-offset', '0x14', 'Bootstrap Rx Mailbox Offset', hex(header.bootstrap.rxOffset, 4))
  add('boot-rx-size', '0x15', 'Bootstrap Rx Mailbox Size', `${hex(header.bootstrap.rxSize, 4)}（${header.bootstrap.rxSize ?? '—'} B）`)
  add('boot-tx-offset', '0x16', 'Bootstrap Tx Mailbox Offset', hex(header.bootstrap.txOffset, 4))
  add('boot-tx-size', '0x17', 'Bootstrap Tx Mailbox Size', `${hex(header.bootstrap.txSize, 4)}（${header.bootstrap.txSize ?? '—'} B）`)
  add('std-rx-offset', '0x18', 'Standard Rx Mailbox Offset', hex(header.standard.rxOffset, 4))
  add('std-rx-size', '0x19', 'Standard Rx Mailbox Size', `${hex(header.standard.rxSize, 4)}（${header.standard.rxSize ?? '—'} B）`)
  add('std-tx-offset', '0x1A', 'Standard Tx Mailbox Offset', hex(header.standard.txOffset, 4))
  add('std-tx-size', '0x1B', 'Standard Tx Mailbox Size', `${hex(header.standard.txSize, 4)}（${header.standard.txSize ?? '—'} B）`)
  add(
    'mailbox-protocols',
    '0x1C',
    'Mailbox Protocols',
    hex(header.mailboxProtocols, 4),
    mailboxProtocolLabels.value.join(' / ') || '无',
  )
  add('reserved-range', '0x1D–0x3D', 'Reserved', '—', '保留')
  add(
    'size',
    '0x3E',
    'EEPROM Size',
    `${hex(header.eepromSizeRaw, 4)} → ${formatBytes(header.eepromSizeBytes)}`,
    '（值 + 1）× 128 字节',
  )
  add('version', '0x3F', 'EEPROM Version', hex(header.eepromVersion, 4))
  return rows
})

const navItems = computed(() => {
  const parsed = result.value
  const items = [
    { id: 'overview', label: '概览' },
    { id: 'header', label: '固定头' },
    { id: 'categories', label: '类别' },
  ]
  if (parsed?.strings.length) items.push({ id: 'strings', label: '字符串' })
  if (parsed?.syncManagers.length) items.push({ id: 'sm', label: 'SyncManager' })
  if (parsed?.fmmus.length) items.push({ id: 'fmmu', label: 'FMMU' })
  if (parsed?.txPdos.length || parsed?.rxPdos.length) items.push({ id: 'pdo', label: 'PDO' })
  if (parsed?.dc?.elements.length) items.push({ id: 'dc', label: 'DC' })
  items.push({ id: 'hex', label: '原始数据' })
  return items
})

function applyParsed(parsed, format, name, extraWarnings) {
  parsed.inputFormat = format
  parsed.inputName = name
  result.value = parsed
  inputWarnings.value = extraWarnings || []
  inputFormat.value = format
  error.value = ''
}

function fail(cause) {
  result.value = null
  inputWarnings.value = []
  inputFormat.value = ''
  error.value = cause instanceof Error ? cause.message : String(cause)
}

function parseFromText() {
  try {
    const decoded = decodeHexInput(hexText.value)
    if (decoded.bytes.length > MAX_INPUT_BYTES) {
      throw new Error(`输入数据超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    fileName.value = ''
    sampleName.value = ''
    applyParsed(parseSii(decoded.bytes), decoded.format, '', decoded.warnings)
  } catch (cause) {
    fail(cause)
  }
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
  fileName.value = file.name

  try {
    if (file.size > MAX_INPUT_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())

    if (looksLikeHexText(bytes)) {
      const text = new TextDecoder().decode(bytes)
      if (text.length <= 100000) hexText.value = text
      const decoded = decodeHexInput(text)
      if (decoded.bytes.length > MAX_INPUT_BYTES) {
        throw new Error(`输入数据超过 ${formatBytes(MAX_INPUT_BYTES)} 限制`)
      }
      applyParsed(parseSii(decoded.bytes), decoded.format, file.name, decoded.warnings)
    } else {
      hexText.value = ''
      applyParsed(parseSii(bytes), 'binary', file.name, [])
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

async function loadSample() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/akd-eeprom.bin`)
    if (!response.ok) {
      throw new Error(`示例文件加载失败（HTTP ${response.status}）`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    hexText.value = ''
    fileName.value = 'akd-eeprom.bin'
    sampleName.value = 'Kollmorgen AKD'
    applyParsed(parseSii(bytes), 'binary', 'akd-eeprom.bin', [])
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function clearAll() {
  hexText.value = ''
  fileName.value = ''
  inputFormat.value = ''
  error.value = ''
  result.value = null
  inputWarnings.value = []
  sampleName.value = ''
}

async function copyJson() {
  try {
    const json = JSON.stringify(exportSii(result.value), null, 2)
    await navigator.clipboard.writeText(json)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (cause) {
    error.value = `复制失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">EC</div>
        <div>
          <h1>EtherCAT EEPROM 解析器</h1>
          <p>解析从站 SII（Slave Information Interface）EEPROM 转储 · 支持二进制 / Intel HEX / 十六进制文本</p>
        </div>
      </div>
      <a class="gh-link" href="https://github.com/Kreedb/test-ai-pr" target="_blank" rel="noreferrer">
        GitHub
      </a>
    </header>

    <main class="app-main">
      <section class="card input-card">
        <div class="card-head">
          <h2>输入数据</h2>
          <span v-if="fileName" class="badge">{{ fileName }}</span>
        </div>

        <label
          class="drop-zone"
          :class="{ dragging }"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input type="file" accept=".bin,.hex,.ihex,.txt,.eeprom" @change="onFileChange" />
          <span class="drop-title">拖拽 EEPROM 转储到这里，或点击选择文件</span>
          <span class="drop-hint">.bin / .hex / .ihex / .txt · 最大 {{ formatBytes(MAX_INPUT_BYTES) }}</span>
        </label>

        <div class="input-divider"><span>或粘贴十六进制数据</span></div>

        <textarea
          v-model="hexText"
          class="hex-input"
          spellcheck="false"
          rows="6"
          placeholder="0A 00 22 00 04 06 45 4B 31 31 30 30 ...&#10;&#10;也支持 Intel HEX（:10000000...）和带偏移的转储（0000: 0A 00 22 00 ...）"
        ></textarea>

        <div class="actions">
          <button type="button" class="btn primary" :disabled="busy" @click="parseFromText">
            {{ busy ? '解析中…' : '解析' }}
          </button>
          <button type="button" class="btn" :disabled="busy" @click="loadSample">加载示例</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="clearAll">清空</button>
          <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
          <span v-else-if="result" class="muted small">
            格式：{{ FORMAT_LABELS[inputFormat] || inputFormat }}
          </span>
        </div>
      </section>

      <div v-if="error" class="card error-card" role="alert">
        <strong>解析失败</strong>
        <p>{{ error }}</p>
      </div>

      <template v-if="result">
        <section class="stats-grid" aria-label="概览">
          <div v-for="stat in stats" :key="stat.label" class="card stat" :class="stat.tone">
            <span class="stat-label">{{ stat.label }}</span>
            <span class="stat-value">{{ stat.value }}</span>
            <span v-if="stat.note" class="stat-note">{{ stat.note }}</span>
          </div>
        </section>

        <nav class="section-nav" aria-label="章节导航">
          <a v-for="item in navItems" :key="item.id" :href="`#${item.id}`">{{ item.label }}</a>
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

            <div v-if="general" class="panel">
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

            <div v-if="general" class="panel">
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
          <h2>固定头</h2>
          <p class="muted small">字地址 0x00–0x3F，共 128 字节。多字节字段均为小端。</p>
          <FieldTable :rows="headerRows" />
        </section>

        <section id="categories" class="card">
          <h2>类别（Categories）</h2>
          <p class="muted small">从字 0x40 开始按顺序排列；类别大小不含 2 个字的类别头。</p>
          <CategoryTable :categories="result.categories" />
        </section>

        <section v-if="result.strings.length" id="strings" class="card">
          <h2>字符串（Strings）</h2>
          <p class="muted small">索引从 1 开始，索引 0 表示空字符串。文本按 Latin-1 解码。</p>
          <StringsTable :strings="result.strings" />
        </section>

        <section v-if="result.syncManagers.length" id="sm" class="card">
          <h2>同步管理器（SyncManager）</h2>
          <SyncManagerTable :sync-managers="result.syncManagers" />
        </section>

        <section v-if="result.fmmus.length" id="fmmu" class="card">
          <h2>FMMU</h2>
          <div class="chip-row">
            <span v-for="(fmmu, index) in result.fmmus" :key="index" class="chip">
              FMMU {{ index }} · {{ fmmu.label }}
            </span>
          </div>
        </section>

        <section v-if="result.txPdos.length || result.rxPdos.length" id="pdo" class="card">
          <h2>PDO 映射</h2>
          <div v-if="result.txPdos.length" class="pdo-group">
            <h3>TxPDO（从站发送 / 主站接收）</h3>
            <PdoTable :pdos="result.txPdos" />
          </div>
          <div v-if="result.rxPdos.length" class="pdo-group">
            <h3>RxPDO（从站接收 / 主站发送）</h3>
            <PdoTable :pdos="result.rxPdos" />
          </div>
        </section>

        <section v-if="result.dc && result.dc.elements.length" id="dc" class="card">
          <h2>分布式时钟（DC）</h2>
          <p class="muted small">每个 24 字节元素对应一个 DC 操作模式。</p>
          <DcTable :dc="result.dc" />
        </section>

        <section id="hex" class="card">
          <div class="card-head">
            <h2>原始数据</h2>
            <button type="button" class="btn small" @click="copyJson">
              {{ copied ? '已复制' : '复制 JSON' }}
            </button>
          </div>
          <HexDump :bytes="result.bytes" />
        </section>
      </template>

      <section v-else-if="!error" class="empty-state">
        <h2>等待输入</h2>
        <p>
          上传 EEPROM 转储或粘贴十六进制数据后开始解析。没有设备数据？点击“加载示例”查看
          Kollmorgen AKD 的 SII 镜像。
        </p>
      </section>
    </main>

    <footer class="app-footer">
      <span>EtherCAT SII 解析器 · 数据仅在浏览器本地处理</span>
    </footer>
  </div>
</template>
