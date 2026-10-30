<script setup>
import { computed, ref, shallowRef } from 'vue'

import HexDump from '@/components/HexDump.vue'
import { downloadBlob, fileBaseName } from '@/lib/download'
import { generateSiiFromEsi } from '@/lib/esi'
import { formatBytes, hex } from '@/lib/format'
import { COE_DETAIL_BITS, MAILBOX_PROTOCOLS, setBits } from '@/lib/sii'

const SAMPLE = {
  file: 'samples/limx-tron2.xml',
  name: 'limx-tron2.xml',
  label: 'Limx Tron2',
}

const MAX_XML_BYTES = 8 * 1024 * 1024

const xmlText = ref('')
const fileName = ref('')
const sampleName = ref('')
const error = ref('')
const result = shallowRef(null)
const busy = ref(false)
const dragging = ref(false)
const copied = ref(false)

const summary = computed(() => result.value?.summary || null)
const warnings = computed(() => result.value?.warnings || [])

const stats = computed(() => {
  const data = summary.value
  if (!data) return []
  return [
    { label: '厂商 ID', value: hex(data.vendorId, 8), note: 'Vendor Id' },
    { label: '产品码', value: hex(data.productCode, 8), note: 'Product Code' },
    { label: '修订号', value: hex(data.revisionNumber, 8), note: 'Revision No' },
    { label: 'EEPROM 大小', value: formatBytes(data.byteSize), note: 'CRC-8 已写入' },
    { label: '类别', value: data.categories.length, note: 'End 标记之前' },
    { label: '字符串', value: data.stringCount, note: 'SII Strings' },
    { label: 'SyncManager', value: data.syncManagerCount, note: 'SM 条目' },
    {
      label: 'PDO',
      value: data.txPdoCount + data.rxPdoCount,
      note: `Tx ${data.txPdoCount} · Rx ${data.rxPdoCount}`,
    },
  ]
})

const mailboxProtocolLabels = computed(() =>
  setBits(summary.value?.mailboxProtocols ?? 0, MAILBOX_PROTOCOLS),
)

const coeLabels = computed(() =>
  setBits(summary.value?.coeDetails ?? 0, COE_DETAIL_BITS),
)

const hexText = computed(() => {
  if (!result.value) return ''
  const parts = []
  for (const byte of result.value.bytes) {
    parts.push(byte.toString(16).toUpperCase().padStart(2, '0'))
  }
  return parts.join(' ')
})

function applyResult(text, name, sample) {
  result.value = generateSiiFromEsi(text)
  error.value = ''
  fileName.value = name || ''
  sampleName.value = sample || ''
}

function fail(cause) {
  result.value = null
  error.value = cause instanceof Error ? cause.message : String(cause)
}

function generateFromText() {
  if (!xmlText.value.trim()) {
    fail(new Error('请先选择 ESI XML 文件或粘贴 XML 内容'))
    return
  }
  busy.value = true
  try {
    applyResult(xmlText.value, '', '')
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

async function handleFile(file) {
  busy.value = true
  error.value = ''
  sampleName.value = ''
  try {
    if (file.size > MAX_XML_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_XML_BYTES)} 限制`)
    }
    const text = await file.text()
    if (text.length <= 4 * 1024 * 1024) xmlText.value = text
    applyResult(text, file.name, '')
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
    if (!response.ok) {
      throw new Error(`示例文件加载失败（HTTP ${response.status}）`)
    }
    const text = await response.text()
    xmlText.value = text
    applyResult(text, SAMPLE.name, SAMPLE.label)
  } catch (cause) {
    fail(cause)
  } finally {
    busy.value = false
  }
}

function clearAll() {
  xmlText.value = ''
  fileName.value = ''
  sampleName.value = ''
  error.value = ''
  result.value = null
}

async function copyHex() {
  try {
    await navigator.clipboard.writeText(hexText.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (cause) {
    error.value = `复制失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function downloadBin() {
  if (!result.value) return
  const base = fileBaseName(fileName.value || sampleName.value, 'eeprom')
  downloadBlob(result.value.bytes, `${base}.bin`, 'application/octet-stream')
}
</script>

<template>
  <main class="app-main">
    <section class="card input-card">
      <div class="card-head">
        <h2>ESI XML 输入</h2>
        <span v-if="fileName" class="badge">{{ fileName }}</span>
      </div>

      <label
        class="drop-zone"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input type="file" accept=".xml,.esi" @change="onFileChange" />
        <span class="drop-title">拖拽 EtherCATInfo XML 到这里，或点击选择文件</span>
        <span class="drop-hint">.xml / .esi · 由 TwinCAT 或 ESI 编辑器导出</span>
      </label>

      <div class="input-divider"><span>或粘贴 XML</span></div>

      <textarea
        v-model="xmlText"
        class="hex-input xml-input"
        spellcheck="false"
        rows="8"
        placeholder="&lt;?xml version=&quot;1.0&quot; encoding=&quot;utf-8&quot;?&gt;&#10;&lt;EtherCATInfo Version=&quot;1.6&quot;&gt;&#10;  &lt;Vendor&gt;...&lt;/Vendor&gt;&#10;  ...&#10;&lt;/EtherCATInfo&gt;"
      ></textarea>

      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy" @click="generateFromText">
          {{ busy ? '生成中…' : '生成 bin' }}
        </button>
        <button type="button" class="btn" :disabled="busy" @click="loadSample">
          示例：{{ SAMPLE.label }}
        </button>
        <button type="button" class="btn ghost" :disabled="busy" @click="clearAll">清空</button>
        <span v-if="sampleName" class="muted small">示例：{{ sampleName }}</span>
      </div>
    </section>

    <div v-if="error" class="card error-card" role="alert">
      <strong>生成失败</strong>
      <p>{{ error }}</p>
    </div>

    <template v-if="result">
      <section class="stats-grid" aria-label="生成结果概览">
        <div v-for="stat in stats" :key="stat.label" class="card stat">
          <span class="stat-label">{{ stat.label }}</span>
          <span class="stat-value">{{ stat.value }}</span>
          <span v-if="stat.note" class="stat-note">{{ stat.note }}</span>
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
        <h2>设备信息</h2>
        <div class="overview-grid">
          <div class="panel">
            <h3>身份信息</h3>
            <dl class="kv">
              <div><dt>设备名称</dt><dd>{{ summary.deviceName || '—' }}</dd></div>
              <div><dt>订货号 / 类型</dt><dd>{{ summary.orderName || '—' }}</dd></div>
              <div><dt>组</dt><dd>{{ summary.groupName || '—' }}</dd></div>
              <div><dt>厂商 ID</dt><dd class="mono">{{ hex(summary.vendorId, 8) }}</dd></div>
              <div><dt>产品码</dt><dd class="mono">{{ hex(summary.productCode, 8) }}</dd></div>
              <div><dt>修订号</dt><dd class="mono">{{ hex(summary.revisionNumber, 8) }}</dd></div>
            </dl>
          </div>

          <div class="panel">
            <h3>固定头</h3>
            <dl class="kv">
              <div><dt>ConfigData</dt><dd class="mono break-all">{{ summary.configData }}</dd></div>
              <div><dt>BootStrap</dt><dd class="mono break-all">{{ summary.bootStrap }}</dd></div>
              <div><dt>EEPROM 大小</dt><dd>{{ formatBytes(summary.byteSize) }}</dd></div>
              <div><dt>EEPROM 版本</dt><dd class="mono">0x0001</dd></div>
              <div>
                <dt>邮箱协议</dt>
                <dd class="chip-row compact">
                  <span v-for="label in mailboxProtocolLabels" :key="label" class="chip accent">{{ label }}</span>
                  <span v-if="!mailboxProtocolLabels.length" class="muted">无</span>
                </dd>
              </div>
              <div>
                <dt>CoE 服务</dt>
                <dd class="chip-row compact">
                  <span v-for="label in coeLabels" :key="label" class="chip">{{ label }}</span>
                  <span v-if="!coeLabels.length" class="muted">无</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>类别布局</h2>
        <p class="muted small">从字 0x40 开始；End 类别之后用 0xFF 填充到 EEPROM 末尾。</p>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>类型</th><th>名称</th><th>字</th><th>字节</th></tr>
            </thead>
            <tbody>
              <tr v-for="category in summary.categories" :key="category.type">
                <td class="mono">0x{{ category.type.toString(16).toUpperCase().padStart(4, '0') }}</td>
                <td>{{ category.name }}</td>
                <td class="mono">{{ category.sizeWords }}</td>
                <td class="mono">{{ category.sizeBytes }}</td>
              </tr>
              <tr>
                <td class="mono">0xFFFF</td>
                <td>End</td>
                <td class="mono">—</td>
                <td class="mono">4</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>生成的镜像</h2>
          <div class="actions inline-actions">
            <button type="button" class="btn small" @click="copyHex">
              {{ copied ? '已复制' : '复制十六进制' }}
            </button>
            <button type="button" class="btn small primary" @click="downloadBin">下载 .bin</button>
          </div>
        </div>
        <HexDump :bytes="result.bytes" />
      </section>
    </template>

    <section v-else-if="!error" class="empty-state">
      <h2>等待输入</h2>
      <p>
        选择或粘贴 TwinCAT 导出的 EtherCATInfo XML 后开始生成。没有现成文件？点击“示例：Limx Tron2”
        载入一对真实 ESI / EEPROM 数据中的 XML 部分。
      </p>
    </section>
  </main>
</template>
