<script setup>
import { computed } from 'vue'

import { copperLayerLabel, pcbFlipTransform } from '@/lib/preview'

// Read-only PCB canvas drawn from the preview model. Coordinates are
// millimetres with Y up; PreviewViewport flips the world group, so everything
// here can use the converter's numbers unchanged.
const props = defineProps({
  model: { type: Object, required: true },
  visibleLayers: { type: Object, required: true },
  activeNet: { type: String, default: '' },
  selectedComponentId: { type: String, default: '' },
  flipped: { type: Boolean, default: false },
})

const emit = defineEmits(['select'])

const INNER_COLORS = ['#8fbf5a', '#b58ad8', '#d8b25a', '#5ab8b8', '#d88a5a', '#7f8fd8']

const layerColors = computed(() => {
  const colors = new Map()
  let inner = 0
  for (const layer of props.model.layers) {
    if (layer.group !== 'copper') continue
    if (layer.id === 'top') colors.set(layer.id, '#e05a5a')
    else if (layer.id === 'bottom') colors.set(layer.id, '#4f8ff7')
    else colors.set(layer.id, INNER_COLORS[inner++ % INNER_COLORS.length])
  }
  return colors
})

const colorOf = (layer) => layerColors.value.get(layer) || '#e05a5a'

const flipTransform = computed(() =>
  pcbFlipTransform(props.model.boardBounds || props.model.bounds, props.flipped),
)

// Keep label text readable after the board itself is mirrored.
const textTransform = (x, y) => `translate(${x} ${y}) scale(${props.flipped ? -1 : 1} -1)`

function visible(item) {
  return item.layers.some((layer) => props.visibleLayers.has(layer))
}

function classesOf(item) {
  if (item.kind === 'board' || item.kind === 'cutout') return {}
  return {
    'preview-dim': Boolean(props.activeNet) && item.net !== props.activeNet,
    'preview-hit': Boolean(props.activeNet) && item.net === props.activeNet,
    'preview-selected': Boolean(props.selectedComponentId) && item.componentId === props.selectedComponentId,
  }
}

function polygonPath(points, closed = true) {
  if (!points?.length) return ''
  const commands = points.map((point) => `${point.x} ${point.y}`)
  return `${closed ? 'M' : 'M'}${commands.join(' L')}${closed ? ' Z' : ''}`
}

// Trace routes are lists of points on possibly different layers (a layer change
// inside a route is a via). Split them so each polyline is single-layer.
function tracePolylines(element) {
  const lines = []
  let current = null
  for (const entry of element.route || []) {
    if (entry.route_type === 'via') {
      current = null
      continue
    }
    const point = { x: entry.x, y: entry.y, layer: entry.layer || 'top', width: entry.width || 0.15 }
    if (current && current.layer === point.layer) {
      current.points.push({ x: point.x, y: point.y })
    } else {
      current = { layer: point.layer, width: point.width, points: [{ x: point.x, y: point.y }] }
      lines.push(current)
    }
  }
  return lines
}

function pourPath(element) {
  if (element.points?.length) return polygonPath(element.points)
  const outer = element.brep_shape?.outer_ring?.vertices
  if (!outer?.length) return ''
  return polygonPath(outer)
}

const rendered = computed(() =>
  props.model.items
    .filter((item) => item.kind !== 'component' && visible(item))
    .filter((item) => item.kind !== 'text' || props.visibleLayers.has(item.layers[0]))
    .sort((a, b) => orderOf(a) - orderOf(b)),
)

function orderOf(item) {
  switch (item.kind) {
    case 'board':
      return 0
    case 'cutout':
      return 1
    case 'pour':
      return 2
    case 'trace':
      return 3
    case 'pad':
      return 4
    case 'via':
      return 5
    case 'hole':
      return 6
    case 'courtyard':
      return 7
    case 'fab':
      return 8
    case 'graphic':
      return 9
    case 'text':
      return 10
    default:
      return 11
  }
}

// Reference designators are drawn from the board's silkscreen side, so hiding
// the silk layer hides them too.
const refdesLabels = computed(() =>
  props.model.components
    .filter((item) => visible(item) && item.id !== props.selectedComponentId)
    .map((item) => ({
      id: `ref-${item.id}`,
      text: item.refdes,
      x: item.element.center?.x ?? 0,
      y: item.element.center?.y ?? 0,
      size: Math.max(0.9, Math.min(1.6, (item.element.width || 2) * 0.4)),
    }))
    .filter((label) => label.text),
)

const selectionBounds = computed(() => {
  if (!props.selectedComponentId) return null
  const item = props.model.components.find((candidate) => candidate.id === props.selectedComponentId)
  return item?.bounds || null
})

const pinSummary = (item) => {
  if (item.kind !== 'pad') return ''
  const parts = []
  if (item.refdes) parts.push(item.refdes)
  if (item.pin) parts.push(`.${item.pin}`)
  if (item.net) parts.push(` → ${item.net}`)
  return parts.join('')
}
</script>

<template>
  <g class="pcb" :transform="flipTransform">
    <g
      v-for="item in rendered"
      :key="item.id"
      :class="classesOf(item)"
      @click.stop="emit('select', item, $event)"
    >
      <title>{{ item.kind === 'pad' ? pinSummary(item) : item.net ? `网络 ${item.net}` : item.kind }}</title>

      <path
        v-if="item.kind === 'board'"
        :d="polygonPath(item.element.outline)"
        fill="#0f2a1c"
        stroke="#f5d76e"
        stroke-width="0.15"
        vector-effect="non-scaling-stroke"
      />
      <path
        v-else-if="item.kind === 'cutout'"
        :d="polygonPath(item.element.outline || item.element.route || item.element.points)"
        fill="#0b0d12"
        stroke="#f5d76e"
        stroke-width="0.12"
        vector-effect="non-scaling-stroke"
      />
      <path
        v-else-if="item.kind === 'pour'"
        :d="pourPath(item.element)"
        :fill="colorOf(item.layers[0])"
        fill-rule="evenodd"
        fill-opacity="0.35"
        stroke="none"
      />

      <template v-else-if="item.kind === 'trace'">
        <polyline
          v-for="(line, index) in tracePolylines(item.element)"
          :key="index"
          :points="line.points.map((point) => `${point.x},${point.y}`).join(' ')"
          fill="none"
          :stroke="colorOf(line.layer)"
          :stroke-width="Math.max(line.width, 0.05)"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>

      <template v-else-if="item.kind === 'pad'">
        <circle
          v-if="item.element.shape === 'circle' && !item.element.rect_pad_width"
          :cx="item.element.x"
          :cy="item.element.y"
          :r="item.element.radius || (item.element.outer_diameter || 0) / 2"
          :fill="item.layers[0] === 'bottom' ? '#4f8ff7' : '#e0b04a'"
          stroke="#0b0d12"
          stroke-width="0.06"
        />
        <g v-else-if="item.element.rect_pad_width || item.element.width">
          <rect
            :x="(item.element.x ?? 0) - (item.element.rect_pad_width || item.element.width) / 2"
            :y="(item.element.y ?? 0) - (item.element.rect_pad_height || item.element.height) / 2"
            :width="item.element.rect_pad_width || item.element.width"
            :height="item.element.rect_pad_height || item.element.height"
            :rx="item.element.corner_radius || 0"
            :transform="`rotate(${item.element.rect_ccw_rotation || item.element.ccw_rotation || 0} ${item.element.x ?? 0} ${item.element.y ?? 0})`"
            fill="#e0b04a"
            stroke="#0b0d12"
            stroke-width="0.06"
          />
        </g>
        <circle
          v-if="item.element.hole_diameter"
          :cx="item.element.x"
          :cy="item.element.y"
          :r="item.element.hole_diameter / 2"
          fill="#0b0d12"
        />
      </template>

      <template v-else-if="item.kind === 'via'">
        <circle
          :cx="item.element.x"
          :cy="item.element.y"
          :r="(item.element.outer_diameter || 0.6) / 2"
          fill="#c9b458"
          stroke="#0b0d12"
          stroke-width="0.06"
        />
        <circle
          :cx="item.element.x"
          :cy="item.element.y"
          :r="(item.element.hole_diameter || 0.3) / 2"
          fill="#0b0d12"
        />
      </template>

      <template v-else-if="item.kind === 'hole'">
        <circle
          :cx="item.element.x"
          :cy="item.element.y"
          :r="(item.element.hole_diameter || item.element.hole_width || 0.5) / 2"
          fill="#0b0d12"
          stroke="#4b5563"
          stroke-width="0.06"
        />
      </template>

      <template v-else-if="item.kind === 'courtyard'">
        <path
          v-if="item.element.outline"
          :d="polygonPath(item.element.outline)"
          fill="none"
          stroke="#7d8aa3"
          stroke-width="0.08"
          stroke-dasharray="0.5 0.4"
          vector-effect="non-scaling-stroke"
        />
      </template>

      <template v-else-if="item.kind === 'fab'">
        <polyline
          v-if="item.element.route"
          :points="item.element.route.map((point) => `${point.x},${point.y}`).join(' ')"
          fill="none"
          stroke="#6b7688"
          :stroke-width="Math.max(item.element.stroke_width || 0.1, 0.05)"
          stroke-linecap="round"
        />
        <g
          v-else-if="item.element.text"
          :transform="textTransform(item.element.anchor_position?.x ?? 0, item.element.anchor_position?.y ?? 0)"
        >
          <text
            x="0"
            y="0"
            :font-size="Math.max(item.element.font_size || 1, 0.4)"
            fill="#6b7688"
            opacity="0.7"
          >
            {{ item.element.text }}
          </text>
        </g>
      </template>

      <template v-else-if="item.kind === 'graphic'">
        <polyline
          v-if="item.element.route"
          :points="item.element.route.map((point) => `${point.x},${point.y}`).join(' ')"
          fill="none"
          stroke="#e8e8d8"
          :stroke-width="Math.max(item.element.stroke_width || 0.12, 0.05)"
          stroke-linecap="round"
        />
        <line
          v-else-if="item.element.x1 !== undefined"
          :x1="item.element.x1"
          :y1="item.element.y1"
          :x2="item.element.x2"
          :y2="item.element.y2"
          stroke="#e8e8d8"
          :stroke-width="Math.max(item.element.stroke_width || 0.12, 0.05)"
          stroke-linecap="round"
        />
        <circle
          v-else-if="item.element.radius"
          :cx="(item.element.center || item.element).x"
          :cy="(item.element.center || item.element).y"
          :r="item.element.radius"
          fill="none"
          stroke="#e8e8d8"
          :stroke-width="Math.max(item.element.stroke_width || 0.12, 0.05)"
        />
        <path
          v-else-if="item.element.brep_shape || item.element.points"
          :d="pourPath(item.element)"
          fill="none"
          stroke="#e8e8d8"
          :stroke-width="Math.max(item.element.stroke_width || 0.12, 0.05)"
        />
      </template>

      <template v-else-if="item.kind === 'text'">
        <g :transform="textTransform(item.element.anchor_position?.x ?? 0, item.element.anchor_position?.y ?? 0)">
          <text
            x="0"
            y="0"
            :font-size="Math.max(item.element.font_size || 1, 0.4)"
            fill="#e8e8d8"
            :opacity="item.layers[0] === 'silk-bottom' ? 0.55 : 0.95"
          >
            {{ item.element.text }}
          </text>
        </g>
      </template>
    </g>

    <g class="pcb-refdes">
      <g
        v-for="label in refdesLabels"
        :key="label.id"
        :transform="textTransform(label.x, label.y)"
      >
        <text x="0" y="0" :font-size="label.size" text-anchor="middle" fill="#9fb2c8" opacity="0.9">
          {{ label.text }}
        </text>
      </g>
    </g>

    <rect
      v-if="selectionBounds"
      :x="selectionBounds.minX"
      :y="selectionBounds.minY"
      :width="selectionBounds.width"
      :height="selectionBounds.height"
      fill="none"
      stroke="#5b8cff"
      stroke-width="1.5"
      stroke-dasharray="4 3"
      vector-effect="non-scaling-stroke"
    />
  </g>
</template>
