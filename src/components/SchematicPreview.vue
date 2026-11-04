<script setup>
import { computed } from 'vue'

import { SCHEMATIC_TEXT_SIZE, unionBounds } from '@/lib/preview'

// Read-only schematic canvas. Coordinates are Circuit JSON schematic units
// with Y up; PreviewViewport flips the world group for the DOM.
const props = defineProps({
  sheet: { type: Object, required: true },
  activeNet: { type: String, default: '' },
  selectedComponentId: { type: String, default: '' },
})

const emit = defineEmits(['select'])

const WIRE_COLOR = '#4ade80'
const SYMBOL_COLOR = '#cbd5e1'
const PIN_COLOR = '#93c5fd'
const ACTIVE_COLOR = '#ffb340'

// Pin numbers have no size in the model; KiCad draws them at its default text
// size, which is the same 1.27 mm the writer uses for every other schematic
// label.
const TEXT_SIZE = SCHEMATIC_TEXT_SIZE

// Strokes are drawn at a constant screen width (`non-scaling-stroke`), so lines
// stay readable at every zoom instead of turning into bars once the viewport
// magnifies a schematic. The values are CSS pixels, not model units: with
// `non-scaling-stroke` the browser reads `stroke-width` in screen space.
const WIRE_STROKE = 1.5
const SYMBOL_STROKE = 1.2
const PIN_STROKE = 1.2

// Marks that do grow with the drawing, because they are physical copper in
// KiCad: a junction is 0.9144 mm across and a pin end about 0.6 mm. Sizing them
// in model units keeps that ratio at any zoom; the old 0.15 model-unit radius
// was a 4.5 mm dot, five times a real junction.
const JUNCTION_RADIUS = 0.9144 / 2 / 15
const PIN_DOT_RADIUS = 0.3 / 15

const items = computed(() => props.sheet.items)

function classesOf(item) {
  const net = item.net || ''
  return {
    'preview-dim': Boolean(props.activeNet) && net !== props.activeNet,
  }
}

const components = computed(() => items.value.filter((item) => item.kind === 'component'))
const graphics = computed(() => items.value.filter((item) => item.kind === 'graphic'))
const wires = computed(() => items.value.filter((item) => item.kind === 'wire'))
const pins = computed(() => items.value.filter((item) => item.kind === 'pin'))
const labels = computed(() => items.value.filter((item) => item.kind === 'label'))
const texts = computed(() => items.value.filter((item) => item.kind === 'text'))

const componentById = computed(() => {
  const map = new Map()
  for (const component of components.value) map.set(component.id, component)
  return map
})

// A dashed outline marks the selected part. The old highlight was an SVG filter,
// which re-rasterized the drawing on every pan frame for no benefit here. The
// union covers pins and value texts too, and keeps zero-sized symbols (the
// renderer falls back to a 0.4 mm body) from collapsing to a 0x0 rect.
const selectionBounds = computed(() => {
  if (!props.selectedComponentId) return null
  const own = items.value.filter((item) => item.componentId === props.selectedComponentId)
  const bounds = unionBounds(own.map((item) => item.bounds))
  if (bounds && (bounds.width || bounds.height)) return bounds
  // A symbol with no size and no children is drawn as the minimum body box, so
  // outline that instead of a 0x0 rect the user cannot see.
  const component = components.value.find((item) => item.componentId === props.selectedComponentId)
  if (!component) return bounds
  const rect = componentRect(component)
  return { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height, width: rect.width, height: rect.height }
})

function componentRect(component) {
  const { center, size } = component.element
  const width = Math.max(size?.width || 0.4, 0.2)
  const height = Math.max(size?.height || 0.4, 0.2)
  return {
    x: (center?.x || 0) - width / 2,
    y: (center?.y || 0) - height / 2,
    width,
    height,
    isBox: component.element.is_box_with_pins !== false,
  }
}

const FACING = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
}

// The port centre is the connection point; the pin line runs back toward the
// symbol body, which is what KiCad draws.
function pinStub(pin) {
  const component = componentById.value.get(pin.componentId)
  const center = pin.element.center || { x: 0, y: 0 }
  const facing = FACING[pin.element.facing_direction] || FACING.right
  const size = component?.element.size || { width: 1, height: 1 }
  const length = pin.element.distance_from_component_edge || Math.min(Math.max(size.width || 1, size.height || 1) * 0.3, 0.8)
  return {
    x1: center.x,
    y1: center.y,
    x2: center.x - facing.x * length,
    y2: center.y - facing.y * length,
    size,
  }
}

const labelText = (item) => {
  const element = item.element
  return {
    x: element.anchor_position?.x ?? element.center?.x ?? 0,
    y: element.anchor_position?.y ?? element.center?.y ?? 0,
    text: item.text,
    // The writer draws every net label at 1.27 mm, whatever the source says.
    size: TEXT_SIZE,
    anchor: element.anchor_side === 'right' ? 'end' : 'start',
  }
}

const textOf = (item) => {
  const element = item.element
  const position = element.position || element.center || { x: 0, y: 0 }
  return {
    x: position.x,
    y: position.y,
    text: element.text,
    size: item.fontSize,
    color: element.color || '#94a3b8',
    rotation: element.rotation || 0,
    anchor: element.anchor === 'bottom_left' ? 'start' : element.anchor === 'bottom_right' ? 'end' : 'middle',
  }
}
</script>

<template>
  <g class="schematic">
    <g v-for="item in graphics" :key="item.id" :class="classesOf(item)" @click.stop="emit('select', item, $event)">
      <line
        v-if="item.element.x1 !== undefined"
        :x1="item.element.x1"
        :y1="item.element.y1"
        :x2="item.element.x2"
        :y2="item.element.y2"
        :stroke="SYMBOL_COLOR"
        :stroke-width="SYMBOL_STROKE"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
      />
      <polyline
        v-else-if="item.element.points"
        :points="item.element.points.map((point) => `${point.x},${point.y}`).join(' ')"
        fill="none"
        :stroke="SYMBOL_COLOR"
        :stroke-width="SYMBOL_STROKE"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
      />
      <circle
        v-else-if="item.element.radius"
        :cx="item.element.center.x"
        :cy="item.element.center.y"
        :r="item.element.radius"
        fill="none"
        :stroke="SYMBOL_COLOR"
        :stroke-width="SYMBOL_STROKE"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <g v-for="item in wires" :key="item.id" :class="classesOf(item)" @click.stop="emit('select', item, $event)">
      <title>{{ item.net ? `网络 ${item.net}` : '导线' }}</title>
      <line
        v-for="(edge, index) in item.element.edges || []"
        :key="index"
        :x1="edge.from.x"
        :y1="edge.from.y"
        :x2="edge.to.x"
        :y2="edge.to.y"
        :stroke="item.net && item.net === activeNet ? ACTIVE_COLOR : WIRE_COLOR"
        :stroke-width="WIRE_STROKE"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
      />
      <circle
        v-for="(junction, index) in item.junctions"
        :key="`j-${index}`"
        :cx="junction.x"
        :cy="junction.y"
        :r="JUNCTION_RADIUS"
        :fill="item.net && item.net === activeNet ? ACTIVE_COLOR : WIRE_COLOR"
      />
    </g>

    <g v-for="item in components" :key="item.id" :class="classesOf(item)" @click.stop="emit('select', item, $event)">
      <title>{{ [item.refdes, item.value].filter(Boolean).join(' · ') }}</title>
      <rect
        v-if="componentRect(item).isBox"
        :x="componentRect(item).x"
        :y="componentRect(item).y"
        :width="componentRect(item).width"
        :height="componentRect(item).height"
        fill="rgba(91, 140, 255, 0.06)"
        :stroke="SYMBOL_COLOR"
        :stroke-width="SYMBOL_STROKE"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <g v-for="item in pins" :key="item.id" :class="classesOf(item)" @click.stop="emit('select', item, $event)">
      <title>{{ [item.refdes, item.pin, item.net].filter(Boolean).join(' · ') }}</title>
      <line :x1="pinStub(item).x1" :y1="pinStub(item).y1" :x2="pinStub(item).x2" :y2="pinStub(item).y2" :stroke="PIN_COLOR" :stroke-width="PIN_STROKE" vector-effect="non-scaling-stroke" />
      <circle :cx="pinStub(item).x1" :cy="pinStub(item).y1" :r="PIN_DOT_RADIUS" :fill="item.net && item.net === activeNet ? ACTIVE_COLOR : PIN_COLOR" />
      <g :transform="`translate(${pinStub(item).x1} ${pinStub(item).y1}) scale(1 -1)`">
        <text x="0" :y="-TEXT_SIZE" :font-size="TEXT_SIZE" fill="#cbd5e1" text-anchor="middle">
          {{ item.pin }}
        </text>
      </g>
    </g>

    <g v-for="item in texts" :key="item.id" :class="classesOf(item)">
      <g :transform="`translate(${textOf(item).x} ${textOf(item).y}) scale(1 -1) rotate(${-textOf(item).rotation})`">
        <text x="0" y="0" :font-size="textOf(item).size" :fill="textOf(item).color" :text-anchor="textOf(item).anchor">
          {{ textOf(item).text }}
        </text>
      </g>
    </g>

    <g v-for="item in labels" :key="item.id" :class="classesOf(item)" @click.stop="emit('select', item, $event)">
      <title>{{ item.text }}</title>
      <g :transform="`translate(${labelText(item).x} ${labelText(item).y}) scale(1 -1)`">
        <text x="0" y="0" :font-size="labelText(item).size" :fill="item.net && item.net === activeNet ? ACTIVE_COLOR : WIRE_COLOR" :text-anchor="labelText(item).anchor">
          {{ labelText(item).text }}
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
