<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import PcbPreview from '@/components/PcbPreview.vue'
import PreviewViewport from '@/components/PreviewViewport.vue'
import SchematicPreview from '@/components/SchematicPreview.vue'
import {
  SCHEMATIC_MM_PER_UNIT,
  buildPreviewModel,
  buildSearchIndex,
  indexComponents,
  indexNets,
  padBounds,
  searchPreview,
  unionBounds,
} from '@/lib/preview'

// Read-only preview of a converted project: board and schematic side by side,
// with search, layer visibility and net cross-probing. Nothing here writes back
// to the model, so it stays a viewer.
const props = defineProps({
  circuitJson: { type: Array, required: true },
})

const model = computed(() => buildPreviewModel(props.circuitJson))
const nets = computed(() => indexNets(model.value))
const components = computed(() => indexComponents(model.value))
const pcb = computed(() => model.value.pcb)
const schematic = computed(() => model.value.schematic)

const tabs = computed(() =>
  [
    { id: 'pcb', label: 'PCB 板图', available: Boolean(pcb.value) },
    { id: 'schematic', label: '原理图', available: Boolean(schematic.value) },
  ].filter((tab) => tab.available),
)

const tab = ref('pcb')
const activeSheetIndex = ref(0)
const activeNetName = ref('')
const selectedComponentId = ref('')
const selectedPcbId = ref('')
const query = ref('')
const fitKey = ref(0)
const viewport = ref(null)

const activeSheet = computed(() => schematic.value?.sheets[activeSheetIndex.value] || null)

// Every selectable group, keyed for both views: the model uses one key for a
// net so a click on a pad, a pin and a search result all highlight together.
function netByName(name) {
  return nets.value.find((net) => net.name === name) || null
}

const activeNet = computed(() => (activeNetName.value ? netByName(activeNetName.value) : null))

const netNeedle = computed(() => activeNet.value?.name || '')

const selectedPcbItem = computed(
  () => pcb.value?.items.find((item) => item.id === selectedPcbId.value) || null,
)

const searchIndex = computed(() => buildSearchIndex(model.value, nets.value))
const results = computed(() => searchPreview(searchIndex.value, query.value.trim()))

const componentsWithBothSides = computed(
  () => components.value.filter((component) => component.pcb && component.schematic).length,
)

// ---- layer visibility -----------------------------------------------------

const hiddenLayers = ref(new Set())

const layerGroups = computed(() => {
  const groups = [
    { id: 'copper', label: '铜层' },
    { id: 'silk', label: '丝印' },
    { id: 'board', label: '板框' },
    { id: 'other', label: '辅助层' },
  ]
  return groups
    .map((group) => ({
      ...group,
      layers: (pcb.value?.layers || []).filter((layer) => layer.group === group.id),
    }))
    .filter((group) => group.layers.length)
})

const visibleLayers = computed(() => {
  const visible = new Set()
  for (const layer of pcb.value?.layers || []) {
    if (!hiddenLayers.value.has(layer.id)) visible.add(layer.id)
  }
  return visible
})

const allLayersVisible = computed(() =>
  (pcb.value?.layers || []).every((layer) => !hiddenLayers.value.has(layer.id)),
)

function toggleLayer(id) {
  const next = new Set(hiddenLayers.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  hiddenLayers.value = next
}

function setAllLayers(visible) {
  hiddenLayers.value = visible
    ? new Set()
    : new Set((pcb.value?.layers || []).map((layer) => layer.id))
}

// "Only this layer" is what a layer toggle is really used for: flip back to
// all layers when the same one is clicked again while it is the only one.
function isolateLayer(id) {
  const visible = visibleLayers.value
  if (visible.size === 1 && visible.has(id)) {
    setAllLayers(true)
    return
  }
  hiddenLayers.value = new Set(
    (pcb.value?.layers || []).map((layer) => layer.id).filter((layerId) => layerId !== id),
  )
}

// ---- cross-probing --------------------------------------------------------

function focusBounds(bounds) {
  if (!bounds) return
  viewport.value?.focus(bounds)
}

/** Bounds of a net inside the currently visible view, padded for its pins. */
function netBoundsOnPcb(net) {
  if (!net?.pcbPads.length) return null
  return padBounds(unionBounds(net.pcbPads.map((pad) => pad.bounds)), 1)
}

function netBoundsOnSchematic(net) {
  if (!net) return null
  const points = [...net.schematicPins, ...net.labels]
  if (!points.length) return null
  return padBounds(unionBounds(points.map((point) => point.bounds)), 1.5)
}

function selectNet(name, { jumpTo = '' } = {}) {
  activeNetName.value = name || ''
  selectedPcbId.value = ''
  selectedComponentId.value = ''
  const net = name ? netByName(name) : null
  const destination =
    jumpTo ||
    (net?.pcbPads.length && tab.value !== 'pcb'
      ? 'pcb'
      : net?.schematicPins.length && tab.value !== 'schematic'
        ? 'schematic'
        : '')
  if (destination && tabs.value.some((entry) => entry.id === destination)) {
    tab.value = destination
    if (destination === 'schematic') {
      // A net can reach the schematic through a label alone, in which case
      // that label decides which sheet to show.
      const sheetId = net?.schematicPins[0]?.sheet || net?.labels[0]?.sheet
      const index = schematic.value?.sheets.findIndex((sheet) => sheet.id === sheetId) ?? -1
      if (index >= 0) activeSheetIndex.value = index
    }
  }
  nextTick(() => {
    if (!net) return
    if (tab.value === 'pcb') focusBounds(netBoundsOnPcb(net))
    else focusBounds(netBoundsOnSchematic(net))
  })
}

function jumpToOtherView() {
  if (!activeNet.value) return
  const destination = tab.value === 'pcb' ? 'schematic' : 'pcb'
  selectNet(activeNet.value.name, { jumpTo: destination })
}

const canJumpToOtherView = computed(() =>
  tab.value === 'pcb' ? netHasSchematic(activeNet.value?.name) : netHasPcb(activeNet.value?.name),
)

/** Whether the named net has anything to frame in the PCB view. */
function netHasPcb(name) {
  const net = name ? netByName(name) : null
  return Boolean(net?.pcbPads.length) && tabs.value.some((entry) => entry.id === 'pcb')
}

/** Whether the named net has anything to frame in the schematic view. */
function netHasSchematic(name) {
  const net = name ? netByName(name) : null
  const reachable = Boolean(net?.schematicPins.length || net?.labels.length)
  return reachable && tabs.value.some((entry) => entry.id === 'schematic')
}

// Ctrl/Cmd+click is the familiar "open the other side" gesture in EDA tools:
// it selects the net here and jumps straight to its counterpart.
function wantsJump(event) {
  return Boolean(event?.ctrlKey || event?.metaKey)
}

function onPcbSelect(item, event) {
  if (!item) return
  if (item.net && wantsJump(event) && netHasSchematic(item.net)) {
    selectNet(item.net, { jumpTo: 'schematic' })
    return
  }
  selectedPcbId.value = item.id
  selectedComponentId.value = item.componentId || ''
  if (item.net) activeNetName.value = item.net
}

function onSchematicSelect(item, event) {
  if (!item) return
  if (item.net && wantsJump(event) && netHasPcb(item.net)) {
    selectNet(item.net, { jumpTo: 'pcb' })
    return
  }
  if (item.componentId) selectedComponentId.value = item.componentId
  if (item.net) activeNetName.value = item.net
}

// Net names in the net table follow the same gesture: a plain click selects the
// net where it is drawn, Ctrl/Cmd+click opens the other view.
function onNetNameClick(name, event) {
  if (wantsJump(event)) {
    if (tab.value === 'pcb' && netHasSchematic(name)) {
      selectNet(name, { jumpTo: 'schematic' })
      return
    }
    if (tab.value === 'schematic' && netHasPcb(name)) {
      selectNet(name, { jumpTo: 'pcb' })
      return
    }
  }
  // Keep the current view while the net is drawn there; a net that only exists
  // on the other side still takes the user to it.
  const here =
    tab.value === 'pcb' ? netHasPcb(name) : netHasSchematic(name)
  selectNet(name, { jumpTo: here ? tab.value : '' })
}

// Endpoint chips jump to their own side by default; Ctrl/Cmd flips them to the
// other view when the net reaches it.
function onEndpointClick(name, side, event) {
  const other = side === 'pcb' ? 'schematic' : 'pcb'
  const otherHasNet = other === 'pcb' ? netHasPcb(name) : netHasSchematic(name)
  selectNet(name, { jumpTo: wantsJump(event) && otherHasNet ? other : side })
}

function onSearchSelect(entry) {
  // Collapse the result list so it stops covering the canvas the selection just
  // moved to.
  query.value = ''
  if (entry.kind === 'net') {
    selectNet(entry.label)
    return
  }
  if (entry.kind === 'component') {
    activeNetName.value = ''
    selectComponent(entry.refdes)
    return
  }
  selectNet(entry.net)
}

function selectComponent(refdes) {
  const component = components.value.find((entry) => entry.refdes === refdes)
  if (!component) return
  const wantsPcb = tab.value === 'pcb'
  const target = wantsPcb ? component.pcb : component.schematic
  if (!target) {
    // The part exists on only one side; switch to the side that has it.
    const destination = component.pcb ? 'pcb' : component.schematic ? 'schematic' : ''
    if (!destination || destination === tab.value) return
    tab.value = destination
    return selectComponent(refdes)
  }
  selectedComponentId.value = target.id
  selectedPcbId.value = wantsPcb ? component.pcb.id : ''
  activeNetName.value = ''
  const bounds = target.bounds
  nextTick(() => focusBounds(bounds ? padBounds(bounds, 1) : null))
}

function clearSelection() {
  activeNetName.value = ''
  selectedComponentId.value = ''
  selectedPcbId.value = ''
}

function setTab(next) {
  tab.value = next
  fitKey.value += 1
  clearSelection()
}

// Re-fit when the model changes, e.g. after a second conversion.
watch(model, () => {
  activeSheetIndex.value = 0
  hiddenLayers.value = new Set()
  clearSelection()
  fitKey.value += 1
})

// A project with only a board or only a schematic has a single available tab.
watch(
  tabs,
  (available) => {
    if (!available.length) return
    if (!available.some((entry) => entry.id === tab.value)) tab.value = available[0].id
  },
  { immediate: true },
)

const activeNetPcbPads = computed(() => activeNet.value?.pcbPads || [])
const activeNetSchematicPins = computed(() => activeNet.value?.schematicPins || [])

const sheetCount = computed(() => schematic.value?.sheets.length || 0)

const selectedLabel = computed(() => {
  const item = selectedPcbItem.value
  if (!item?.refdes) return ''
  return `${item.refdes}${item.pin !== '' && item.pin !== undefined ? `.${item.pin}` : ''}`
})
</script>

<template>
  <section class="card preview-card">
    <div class="card-head">
      <h2>设计预览</h2>
      <span class="badge">只读</span>
    </div>
    <p class="muted small">
      直接渲染转换得到的 Circuit JSON：滚轮缩放、拖拽平移，点击元件或焊盘可定位，网络可在 PCB 与原理图之间互相跳转。
      按住 Ctrl（macOS 为 ⌘）点击焊盘、引脚或网络名，可直接跳到另一视图的同名网络。
    </p>

    <div class="preview-toolbar">
      <div class="tabs" role="tablist">
        <button
          v-for="entry in tabs"
          :key="entry.id"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: tab === entry.id }"
          :aria-selected="tab === entry.id"
          @click="setTab(entry.id)"
        >
          {{ entry.label }}
        </button>
      </div>

      <div class="preview-search">
        <input
          v-model="query"
          type="search"
          class="table-input"
          placeholder="搜索网络、位号或引脚，例如 GND、R1、U1.3"
          aria-label="搜索网络、位号或引脚"
        />
        <ul v-if="results.length" class="search-results">
          <li v-for="entry in results" :key="entry.id">
            <button type="button" class="search-hit" @click="onSearchSelect(entry)">
              <span class="mono">{{ entry.label }}</span>
              <span class="muted small">{{ entry.detail }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="query.trim()" class="muted small no-results">没有匹配的网络、元件或引脚。</p>
      </div>

      <div class="preview-meta muted small">
        <span v-if="pcb">{{ pcb.copperLayerCount }} 层铜 · {{ pcb.components.length }} 元件</span>
        <span v-if="schematic">{{ sheetCount }} 张原理图 · {{ schematic.components.length }} 符号</span>
        <span v-if="componentsWithBothSides">{{ componentsWithBothSides }} 个位号两侧都有</span>
      </div>
    </div>

    <div class="preview-body">
      <aside v-if="tab === 'pcb' && pcb" class="preview-side">
        <div class="side-head">
          <h3>图层</h3>
          <div class="side-actions">
            <button type="button" class="btn small ghost" @click="setAllLayers(true)">全开</button>
            <button type="button" class="btn small ghost" @click="setAllLayers(false)">全关</button>
          </div>
        </div>
        <div v-for="group in layerGroups" :key="group.id" class="layer-group">
          <span class="layer-group-title">{{ group.label }}</span>
          <label v-for="layer in group.layers" :key="layer.id" class="check layer-row">
            <input
              type="checkbox"
              :checked="!hiddenLayers.has(layer.id)"
              @change="toggleLayer(layer.id)"
            />
            <span class="layer-swatch" :class="`swatch-${layer.group}`" />
            <span class="layer-name">{{ layer.label }}</span>
            <button
              type="button"
              class="btn small ghost isolate"
              title="只显示这一层"
              @click.prevent.stop="isolateLayer(layer.id)"
            >
              仅
            </button>
          </label>
        </div>
        <p v-if="!allLayersVisible" class="muted small">
          已隐藏 {{ hiddenLayers.size }} 层，点击“全开”恢复。
        </p>
      </aside>

      <aside v-else-if="tab === 'schematic' && schematic" class="preview-side">
        <div class="side-head">
          <h3>图纸</h3>
        </div>
        <label v-for="(sheet, index) in schematic.sheets" :key="sheet.id" class="check layer-row">
          <input
            v-model="activeSheetIndex"
            type="radio"
            name="sheet"
            :value="index"
            @change="fitKey += 1"
          />
          <span class="layer-name">{{ sheet.name }}</span>
          <span class="muted small">{{ sheet.items.filter((item) => item.kind === 'component').length }} 符号</span>
        </label>
        <p class="muted small">
          原理图按层次化输出，跨图同名网络在 KiCad 中按全局标签连接，这里也会作为同一个网络高亮。
        </p>
      </aside>

      <div class="preview-canvas">
        <PreviewViewport
          v-if="(tab === 'pcb' && pcb) || (tab === 'schematic' && activeSheet)"
          ref="viewport"
          :bounds="tab === 'pcb' ? pcb?.boardBounds || pcb?.bounds : activeSheet?.bounds"
          :mm-per-unit="tab === 'pcb' ? 1 : SCHEMATIC_MM_PER_UNIT"
          :fit-key="`${tab}-${activeSheetIndex}-${fitKey}`"
        >
          <PcbPreview
            v-if="tab === 'pcb' && pcb"
            :model="pcb"
            :visible-layers="visibleLayers"
            :active-net="netNeedle"
            :selected-component-id="selectedComponentId"
            @select="onPcbSelect"
          />
          <SchematicPreview
            v-else-if="tab === 'schematic' && activeSheet"
            :sheet="activeSheet"
            :active-net="netNeedle"
            :selected-component-id="selectedComponentId"
            @select="onSchematicSelect"
          />
        </PreviewViewport>
        <div v-else class="empty-state">
          <h2>没有可预览的内容</h2>
          <p>本次转换没有产生{{ tab === 'pcb' ? '板级' : '原理图' }}数据。</p>
        </div>
      </div>
    </div>

    <div class="preview-net-panel">
      <div class="card-head">
        <h3>网络</h3>
        <div class="side-actions">
          <button
            v-if="activeNet"
            type="button"
            class="btn small"
            :disabled="!canJumpToOtherView"
            :title="canJumpToOtherView ? '' : '这个网络在另一个视图里没有连接点'"
            @click="jumpToOtherView"
          >
            跳到{{ tab === 'pcb' ? '原理图' : 'PCB' }}
          </button>
          <button v-if="activeNet" type="button" class="btn small ghost" @click="clearSelection">
            清除高亮
          </button>
        </div>
      </div>

      <p v-if="activeNet" class="net-summary">
        <span class="mono net-name">{{ activeNet.name }}</span>
        <span class="muted small">
          PCB {{ activeNetPcbPads.length }} 个焊盘 · 原理图 {{ activeNetSchematicPins.length }} 个引脚
        </span>
      </p>
      <p v-else class="muted small">
        在画布上点击焊盘/引脚，或在下方列表里选择网络，两个视图会同时高亮这个网络。
      </p>

      <ul v-if="activeNet && (activeNetPcbPads.length || activeNetSchematicPins.length)" class="net-endpoints">
        <li v-for="pad in activeNetPcbPads" :key="`pad-${pad.id}`">
          <button
            type="button"
            class="linkish mono"
            title="Ctrl/⌘+点击跳到原理图"
            @click="onEndpointClick(activeNet.name, 'pcb', $event)"
          >
            {{ pad.refdes || '?' }}{{ pad.pin !== '' ? `.${pad.pin}` : '' }}
          </button>
          <span class="muted small">PCB 焊盘</span>
        </li>
        <li v-for="pin in activeNetSchematicPins" :key="`pin-${pin.id}`">
          <button
            type="button"
            class="linkish mono"
            title="Ctrl/⌘+点击跳到 PCB"
            @click="onEndpointClick(activeNet.name, 'schematic', $event)"
          >
            {{ pin.refdes || '?' }}{{ pin.pin !== '' ? `.${pin.pin}` : '' }}
          </button>
          <span class="muted small">原理图引脚</span>
        </li>
      </ul>

      <div class="table-wrap net-table-wrap">
        <table class="data-table net-table">
          <thead>
            <tr>
              <th>网络</th>
              <th>PCB</th>
              <th>原理图</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="net in nets.slice(0, 300)"
              :key="net.id"
              :class="{ 'row-active': net.name === activeNetName }"
            >
              <td class="mono">
                <button
                  type="button"
                  class="linkish mono"
                  title="Ctrl/⌘+点击跳到另一视图的同名网络"
                  @click="onNetNameClick(net.name, $event)"
                >
                  {{ net.name }}
                </button>
              </td>
              <td>{{ net.pcbPads.length }}</td>
              <td>{{ net.schematicPins.length }}</td>
              <td class="row-actions">
                <button
                  v-if="pcb && net.pcbPads.length"
                  type="button"
                  class="btn small ghost"
                  @click="selectNet(net.name, { jumpTo: 'pcb' })"
                >
                  定位 PCB
                </button>
                <button
                  v-if="schematic && (net.schematicPins.length || net.labels.length)"
                  type="button"
                  class="btn small ghost"
                  @click="selectNet(net.name, { jumpTo: 'schematic' })"
                >
                  定位原理图
                </button>
              </td>
            </tr>
            <tr v-if="!nets.length">
              <td colspan="4" class="muted small">这个设计没有网络信息。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="nets.length > 300" class="muted small">
        仅列出前 300 个网络，共 {{ nets.length }} 个；用上方搜索框可以直接定位其余网络。
      </p>
    </div>

    <p v-if="selectedLabel" class="muted small">
      已选中 {{ selectedLabel }}<template v-if="selectedPcbItem?.net"> · 网络 {{ selectedPcbItem.net }}</template>
    </p>
  </section>
</template>
