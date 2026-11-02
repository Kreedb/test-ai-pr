<script setup>
import { computed, ref, shallowRef } from 'vue'

import EdaPreview from '@/components/EdaPreview.vue'
import {
  SKIP_REASON_LABELS,
  expandArchive,
  isZipArchive,
} from '@/lib/archive'
import { downloadBlob, fileBaseName } from '@/lib/download'
import {
  LOSS_NOTES,
  MAX_INPUT_BYTES,
  MAX_TOTAL_BYTES,
  SOURCE_FORMATS,
  convertEda,
  detectSource,
} from '@/lib/eda'
import { formatBytes } from '@/lib/format'

const SAMPLES = [
  {
    label: 'STM32F411 四层板（Altium 项目）',
    files: [
      'samples/altium/stm32-f411-4layer/STM32F411.PcbDoc',
      'samples/altium/stm32-f411-4layer/STM32F411.SchDoc',
    ],
  },
  {
    label: 'STM32F405RGT6 核心板（Altium 项目）',
    files: [
      'samples/altium/stm32f405-core/STM32F405RGT6.PcbDoc',
      'samples/altium/stm32f405-core/00_connectors_power.SchDoc',
      'samples/altium/stm32f405-core/01_stm32f4_min_system.SchDoc',
      'samples/altium/stm32f405-core/02_other.SchDoc',
    ],
  },
  {
    label: 'Specctra DSN',
    files: ['samples/specctra/motor-driver.dsn'],
  },
  {
    label: 'EAGLE SOT23-3（PCB + 原理图）',
    files: ['samples/eagle/SOT23-3.brd', 'samples/eagle/SOT23-3.sch'],
  },
  {
    label: 'PADS ASCII（0805 + 排针）',
    files: ['samples/pads/res0805.asc'],
  },
  {
    label: 'Altium 工程压缩包（.zip）',
    files: ['samples/altium/stm32-f411-4layer.zip'],
  },
]

const LOSS_GROUPS = [
  {
    id: 'altiumPcb',
    source: 'Altium PCB',
    target: '.kicad_pcb',
    items: LOSS_NOTES.altiumPcb,
  },
  {
    id: 'altiumSch',
    source: 'Altium 原理图',
    target: '.kicad_sch',
    items: LOSS_NOTES.altiumSch,
  },
  {
    id: 'dsn',
    source: 'Specctra DSN / SES',
    target: '.kicad_pcb',
    items: LOSS_NOTES.dsn,
  },
  {
    id: 'eaglePcb',
    source: 'EAGLE 板图',
    target: '.kicad_pcb',
    items: LOSS_NOTES.eaglePcb,
  },
  {
    id: 'eagleSch',
    source: 'EAGLE 原理图',
    target: '.kicad_sch',
    items: LOSS_NOTES.eagleSch,
  },
  {
    id: 'pads',
    source: 'PADS Layout ASCII',
    target: '.kicad_pcb',
    items: LOSS_NOTES.pads,
  },
]

// One row per (source, lossy category), so the table can be scanned by format or
// by what kind of information is at risk rather than read as six bullet lists.
const LOSS_ROWS = LOSS_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ source: group.source, target: group.target, ...item })),
)

const entries = ref([])
const dragging = ref(false)
const busy = ref(false)
const error = ref('')
const errorDetail = ref('')
const sampleLabel = ref('')
const result = shallowRef(null)
// Files that came out of a zip, grouped by the archive they arrived in, so the
// page can say where a document came from after the archive itself is gone.
const archives = ref([])
const archiveNotes = ref([])

// Formats that actually produce output. Everything else is either a project
// side file the converters cannot read, or listed as not yet supported.
const CONVERTIBLE_FORMATS = ['altium', 'specctra', 'eagle', 'pads']

const formatOf = (source) => detectSource(source.name, source.bytes)
const formatLabel = (id) => SOURCE_FORMATS.find((format) => format.id === id)?.label || '未知格式'
const entryNames = (list) => list.map((entry) => entry.name).join('、')

// Project side files (`.PrjPcb`, `.PcbLib`, `.OutJob`) carry nothing the
// converters can read. Keep them visible but never count them as a source.
const ignoredEntries = computed(() =>
  entries.value.filter((entry) => formatOf(entry).id === 'unknown'),
)

const unsupportedEntries = computed(() =>
  entries.value.filter((entry) => {
    const { id } = formatOf(entry)
    return id !== 'unknown' && !CONVERTIBLE_FORMATS.includes(id)
  }),
)

const sourceFormats = computed(
  () =>
    new Set(
      entries.value
        .map((entry) => formatOf(entry).id)
        .filter((id) => CONVERTIBLE_FORMATS.includes(id)),
    ),
)

const mixedFormats = computed(() => sourceFormats.value.size > 1)

const canConvert = computed(
  () => sourceFormats.value.size > 0 && !mixedFormats.value && !unsupportedEntries.value.length,
)

const stats = computed(() => {
  const outcome = result.value
  if (!outcome) return []
  const list = []
  const board = outcome.summary.board
  if (board) {
    list.push(
      { label: '元件', value: board.components, note: '板上封装' },
      { label: '网络', value: board.nets, note: 'Net' },
      { label: '焊盘', value: board.pads, note: 'SMD + 通孔' },
      { label: '走线', value: board.tracks, note: '铜层线段' },
      { label: '过孔', value: board.vias, note: 'Via' },
      { label: '敷铜', value: board.zones, note: 'KiCad zone' },
    )
  }
  const schematic = outcome.summary.schematic
  if (schematic) {
    list.push(
      { label: '原理图页', value: schematic.sheets, note: '层次化输出' },
      { label: '符号', value: schematic.components, note: 'Schematic symbol' },
    )
  }
  list.push({ label: '耗时', value: `${outcome.elapsedMs} ms`, note: '全部在本地完成' })
  return list
})

const outputTotal = computed(() =>
  result.value ? result.value.files.reduce((sum, file) => sum + file.size, 0) : 0,
)

// Which archive a document came from, keyed by the (possibly de-duplicated)
// name the entry list uses.
const archiveByEntry = computed(() => {
  const map = new Map()
  for (const archive of archives.value) {
    for (const name of archive.files) map.set(name, archive.name)
  }
  return map
})

const projectName = computed(() => {
  const outcome = result.value
  if (!outcome) return 'converted'
  const base = outcome.files.find((file) => file.name.endsWith('.kicad_pcb'))?.name
  return fileBaseName(base || outcome.files[0].name, 'converted')
})

// Turn a batch of `{ name, bytes }` documents into entries, opening any archive
// along the way. `useAfter` is the byte budget already spent by entries that
// stay; archives never reach the converters, so the members of one replace its
// own compressed size in the running total.
async function collectEntries(documents, { useAfter, taken }) {
  const added = []
  const opened = []
  const notes = []
  const duplicates = new Set()
  let used = useAfter

  for (const { name, bytes } of documents) {
    used += bytes.length
    if (!isZipArchive(name, bytes)) {
      added.push({ name, bytes })
      continue
    }

    const { files: members, skipped } = await expandArchive(name, bytes, {
      maxFileBytes: MAX_INPUT_BYTES,
      maxTotalBytes: Math.max(0, MAX_TOTAL_BYTES - used + bytes.length),
    })
    const landed = []
    let imported = 0
    for (const member of members) {
      if (taken.has(member.name)) {
        duplicates.add(member.name)
        continue
      }
      taken.add(member.name)
      imported += member.bytes.length
      added.push(member)
      landed.push(member.name)
    }
    // The archive itself is dropped, so its members only add their own size.
    used += imported - bytes.length
    if (landed.length) opened.push({ name, files: landed })
    if (skipped.length) {
      const shown = skipped.slice(0, 4)
      const summary = shown
        .map((item) => `${item.name}（${SKIP_REASON_LABELS[item.reason]}）`)
        .join('、')
      const rest = skipped.length > shown.length ? ` 等 ${skipped.length} 个文件` : ''
      notes.push(`${name}：${summary}${rest} 已跳过。`)
    }
  }
  if (duplicates.size) notes.push(`${[...duplicates].join('、')} 与已有文件重名，已跳过。`)
  if (used > MAX_TOTAL_BYTES) {
    throw new Error(`解压后合计 ${formatBytes(used)}，超过 ${formatBytes(MAX_TOTAL_BYTES)} 上限，请分批转换。`)
  }

  return { added, opened, notes }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  busy.value = true
  error.value = ''
  errorDetail.value = ''
  try {
    // Check the declared sizes before reading anything: a 200 MB PcbDoc must
    // be refused without being buffered first.
    const pending = []
    let total = entries.value.reduce((sum, entry) => sum + entry.bytes.length, 0)
    const taken = new Set(entries.value.map((entry) => entry.name))
    for (const file of files) {
      if (!file.size) throw new Error(`${file.name} 是空文件`)
      if (file.size > MAX_INPUT_BYTES) {
        throw new Error(`${file.name} 超过 ${formatBytes(MAX_INPUT_BYTES)} 上限，请先拆分工程。`)
      }
      if (taken.has(file.name)) continue
      total += file.size
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`本次上传合计超过 ${formatBytes(MAX_TOTAL_BYTES)} 上限，请分批转换。`)
      }
      taken.add(file.name)
      pending.push(file)
    }

    const existing = entries.value.reduce((sum, entry) => sum + entry.bytes.length, 0)
    const documents = await Promise.all(
      pending.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    )
    const { added, opened, notes } = await collectEntries(documents, { useAfter: existing, taken })
    entries.value.push(...added)
    archives.value.push(...opened)
    archiveNotes.value.push(...notes)
    sampleLabel.value = ''
    result.value = null
  } catch (cause) {
    error.value = cause.message
  } finally {
    busy.value = false
  }
}

function onDrop(event) {
  dragging.value = false
  addFiles(event.dataTransfer?.files)
}

function onFileChange(event) {
  addFiles(event.target.files)
  event.target.value = ''
}

function removeEntry(index) {
  const [removed] = entries.value.splice(index, 1)
  for (const archive of archives.value) {
    archive.files = archive.files.filter((name) => name !== removed.name)
  }
  archives.value = archives.value.filter((archive) => archive.files.length)
  sampleLabel.value = ''
  result.value = null
}

async function loadSample(sample) {
  busy.value = true
  error.value = ''
  errorDetail.value = ''
  try {
    const fetched = await Promise.all(
      sample.files.map(async (path) => {
        const response = await fetch(`${import.meta.env.BASE_URL}${path}`)
        if (!response.ok) throw new Error(`示例文件加载失败（HTTP ${response.status}）`)
        return { name: path.split('/').pop(), bytes: new Uint8Array(await response.arrayBuffer()) }
      }),
    )
    // Samples go through the same expansion path as uploads, so a zipped
    // example exercises the archive reader too.
    const { added, opened, notes } = await collectEntries(fetched, {
      useAfter: 0,
      taken: new Set(),
    })
    entries.value = added
    archives.value = opened
    archiveNotes.value = notes
    sampleLabel.value = sample.label
    result.value = null
  } catch (cause) {
    error.value = cause.message
  } finally {
    busy.value = false
  }
}

async function runConversion() {
  busy.value = true
  error.value = ''
  errorDetail.value = ''
  result.value = null
  try {
    const inputs = entries.value
      .filter((entry) => CONVERTIBLE_FORMATS.includes(formatOf(entry).id))
      .map(({ name, bytes }) => ({ name, bytes }))
    result.value = await convertEda(inputs)
  } catch (cause) {
    error.value = cause.message || '转换失败'
    errorDetail.value = cause.detail || ''
  } finally {
    busy.value = false
  }
}

function downloadFile(file) {
  downloadBlob(file.content, file.name, 'text/plain;charset=utf-8')
}

async function downloadArchive() {
  const { zipSync } = await import('fflate')
  const bundle = {}
  for (const file of result.value.files) {
    bundle[file.name] = new TextEncoder().encode(file.content)
  }
  downloadBlob(zipSync(bundle, { level: 6 }), `${projectName.value}.zip`, 'application/zip')
}

function clearAll() {
  entries.value = []
  archives.value = []
  archiveNotes.value = []
  result.value = null
  sampleLabel.value = ''
  error.value = ''
  errorDetail.value = ''
}
</script>

<template>
  <main class="app-main">
    <section class="card input-card">
      <div class="card-head">
        <h2>输入 EDA 工程文件</h2>
        <span v-if="entries.length" class="badge">{{ entries.length }} 个文件</span>
      </div>

      <label
        class="drop-zone"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input
          type="file"
          multiple
          accept=".PcbDoc,.SchDoc,.pcbdoc,.schdoc,.PrjPcb,.prjpcb,.dsn,.ses,.asc,.brd,.sch,.edif,.zip"
          @change="onFileChange"
        />
        <span class="drop-title">
          拖拽 Altium / Specctra / EAGLE / PADS 文件或 .zip 压缩包到这里,或点击选择文件
        </span>
        <span class="drop-hint">
          支持 .PcbDoc、.SchDoc、.dsn、.ses、.brd、.sch、.asc,可一次选择整个工程,也可以直接给一个 .zip;
          压缩包会在浏览器里解开,只取其中能转换的文件 · 单个文件最大
          {{ formatBytes(MAX_INPUT_BYTES) }},合计最大 {{ formatBytes(MAX_TOTAL_BYTES) }}
        </span>
      </label>

      <ul v-if="entries.length" class="file-list">
        <li v-for="(entry, index) in entries" :key="entry.name" class="file-row">
          <div class="file-main">
            <span class="file-name mono">{{ entry.name }}</span>
            <span v-if="archiveByEntry.get(entry.name)" class="muted small">
              来自 {{ archiveByEntry.get(entry.name) }}
            </span>
          </div>
          <span class="chip">{{ formatLabel(formatOf(entry).id) }}</span>
          <span class="muted small nowrap">{{ formatBytes(entry.bytes.length) }}</span>
          <button type="button" class="btn ghost small" @click="removeEntry(index)">移除</button>
        </li>
      </ul>

      <p v-for="(note, index) in archiveNotes" :key="`note-${index}`" class="warn-inline">
        {{ note }}
      </p>

      <details v-if="archives.length" class="archive-list">
        <summary>
          来自压缩包：{{ archives.map((archive) => archive.name).join('、') }}
        </summary>
        <ul class="loss-list">
          <li v-for="archive in archives" :key="archive.name">
            <span class="mono">{{ archive.name }}</span>
            <span class="muted small">（{{ archive.files.length }} 个文件）</span>
          </li>
        </ul>
      </details>

      <p v-if="mixedFormats" class="warn-inline">
        当前混选了不同来源的文件，请只保留同一类（Altium、Specctra、EAGLE 或 PADS）。
      </p>
      <p v-else-if="unsupportedEntries.length" class="warn-inline">
        {{ entryNames(unsupportedEntries) }} 的格式尚未接入，见下方支持列表。
      </p>
      <p v-else-if="ignoredEntries.length" class="muted small">
        {{ entryNames(ignoredEntries) }} 不是可转换的输入（工程侧文件如 .PrjPcb，或缺少 PADS-POWERPCB 版本头的 .asc），已忽略。
      </p>

      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy || !canConvert" @click="runConversion">
          {{ busy ? '转换中…' : '转换为 KiCad' }}
        </button>
        <button
          v-for="sample in SAMPLES"
          :key="sample.label"
          type="button"
          class="btn"
          :disabled="busy"
          @click="loadSample(sample)"
        >
          示例：{{ sample.label }}
        </button>
        <button type="button" class="btn ghost" :disabled="busy || !entries.length" @click="clearAll">
          清空
        </button>
        <span v-if="sampleLabel" class="muted small">示例：{{ sampleLabel }}</span>
      </div>
    </section>

    <div v-if="error" class="card error-card" role="alert">
      <strong>无法转换</strong>
      <p>{{ error }}</p>
      <p v-if="errorDetail" class="muted small">{{ errorDetail }}</p>
    </div>

    <template v-if="result">
      <section class="stats-grid" aria-label="转换结果概览">
        <div v-for="stat in stats" :key="stat.label" class="card stat">
          <span class="stat-label">{{ stat.label }}</span>
          <span class="stat-value">{{ stat.value }}</span>
          <span v-if="stat.note" class="stat-note">{{ stat.note }}</span>
        </div>
      </section>

      <section v-if="result.warnings.length" class="card warnings-card">
        <h2>提示（{{ result.warnings.length }}）</h2>
        <ul class="warning-list">
          <li v-for="(warning, index) in result.warnings" :key="index" :class="`warn-${warning.level}`">
            {{ warning.message }}
          </li>
        </ul>
      </section>

      <EdaPreview v-if="result.circuitJson?.length" :circuit-json="result.circuitJson" />

      <section class="card">
        <div class="card-head">
          <h2>输出文件</h2>
          <span class="muted small">{{ result.files.length }} 个 · {{ formatBytes(outputTotal) }}</span>
        </div>
        <ul class="file-list">
          <li v-for="file in result.files" :key="file.name" class="file-row">
            <span class="file-name mono">{{ file.name }}</span>
            <span class="muted small nowrap">{{ formatBytes(file.size) }}</span>
            <button type="button" class="btn small" @click="downloadFile(file)">下载</button>
          </li>
        </ul>
        <div class="actions">
          <button v-if="result.files.length > 1" type="button" class="btn primary" @click="downloadArchive">
            打包下载 {{ projectName }}.zip
          </button>
          <span class="muted small">
            层次化原理图（根图 + 子图）必须放在同一目录下，KiCad 才能解析图纸引用。
          </span>
        </div>
      </section>
    </template>

    <section class="card">
      <div class="card-head">
        <h2>哪些信息可能无法无损转换</h2>
        <span class="badge">有损转换</span>
      </div>
      <p class="muted small">
        所有来源先解析成统一的中间模型 Circuit JSON，再统一写出 KiCad（.kicad_pcb / .kicad_sch / .kicad_pro），
        因此新增一种来源只需要补一个解析器。下表按“来源 + 信息类别”列出会被简化或丢失的内容，
        请在 KiCad 打开后逐项核对，再重新灌注敷铜、补 3D 模型和设计规则。
      </p>
      <div class="table-wrap loss-table-wrap">
        <table class="data-table loss-table">
          <thead>
            <tr>
              <th>来源</th>
              <th>输出</th>
              <th>信息类别</th>
              <th>影响</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in LOSS_ROWS" :key="index">
              <td class="nowrap">{{ row.source }}</td>
              <td class="mono small nowrap">{{ row.target }}</td>
              <td class="nowrap">{{ row.category }}</td>
              <td class="small">{{ row.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>支持的格式</h2>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>来源</th>
              <th>扩展名</th>
              <th>可转换内容</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="format in SOURCE_FORMATS" :key="format.id">
              <td class="nowrap">{{ format.label }}</td>
              <td class="mono small">{{ format.extensions.join(' / ') }}</td>
              <td class="nowrap">{{ format.converts }}</td>
              <td>
                <span class="chip" :class="format.status === 'supported' ? 'accent' : ''">
                  {{ format.status === 'supported' ? '已支持' : '计划中' }}
                </span>
              </td>
              <td class="small">{{ format.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="export-note">
        转换器来自 tscircuit 的开源项目：altium-to-circuit-json、dsn-to-circuit-json、circuit-json-to-kicad（均为 MIT）。
        EAGLE XML 与 PADS Layout ASCII 由本仓库的 src/lib/eagle.js、src/lib/pads.js 解析（fast-xml-parser，MIT），
        zip 压缩包由 src/lib/archive.js 用 fflate（MIT）在本地解开。
        文件不会上传到任何服务器。
      </p>
    </section>
  </main>
</template>
