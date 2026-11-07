<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// Stacked strip chart: one row per joint / IMU channel, each scaled to its own
// range so an abnormal joint is visible without the others flattening it.
// Dragging anywhere on the chart seeks the replay cursor.
const props = defineProps({
  rows: { type: Array, default: () => [] },
  startTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  current: { type: Number, default: 0 },
  emptyMessage: { type: String, default: '没有可绘制的数据' },
})

const emit = defineEmits(['seek'])

const GUTTER = 176
const RIGHT_GUTTER = 76
const TOP = 20
const ROW = 30
const PAD = 6

const host = ref(null)
const base = ref(null)
const overlay = ref(null)
let observer = null
let pressing = false

function dimensions() {
  const element = host.value
  const width = Math.max(1, element?.clientWidth || 1)
  return { width, height: TOP + Math.max(1, props.rows.length) * ROW + PAD }
}

function setup(canvas, width, height) {
  if (!canvas) return null
  const ratio = window.devicePixelRatio || 1
  const pixelWidth = Math.round(width * ratio)
  const pixelHeight = Math.round(height * ratio)
  // Assigning `width`/`height` resets the backing store even to the same value;
  // the cursor overlay redraws every animation frame, so only resize on change.
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  const context = canvas.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  return context
}

function valueAt(times, values, time) {
  if (!times.length) return null
  let low = 0
  let high = times.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (times[middle] < time) low = middle + 1
    else high = middle
  }
  const value = values[low]
  return Number.isFinite(value) ? value : null
}

function drawBase() {
  const { width, height } = dimensions()
  const context = setup(base.value, width, height)
  if (!context) return
  context.clearRect(0, 0, width, height)
  context.fillStyle = 'rgba(13, 16, 23, 0.55)'
  context.fillRect(0, 0, width, height)

  const left = GUTTER
  const right = width - RIGHT_GUTTER
  if (right <= left) return
  const span = props.duration || 1

  context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'center'
  context.fillStyle = 'rgba(153, 163, 179, 0.75)'
  for (let index = 0; index <= 4; index += 1) {
    const x = left + ((right - left) * index) / 4
    context.fillText((props.startTime + (span * index) / 4).toFixed(2), x, 13)
  }

  if (!props.rows.length) {
    context.fillStyle = 'rgba(153, 163, 179, 0.9)'
    context.font = '13px Inter, system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText(props.emptyMessage, width / 2, height / 2)
    return
  }

  let cursor = TOP
  for (const row of props.rows) {
    const rowTop = cursor
    const rowBottom = cursor + ROW
    cursor = rowBottom

    let min = Infinity
    let max = -Infinity
    for (const value of row.values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    if (!Number.isFinite(min)) {
      min = 0
      max = 1
    }
    if (max - min < 1e-9) {
      max += 0.5
      min -= 0.5
    }
    const scaleY = (value) => rowBottom - PAD - ((value - min) / (max - min)) * (ROW - PAD * 2)

    context.strokeStyle = 'rgba(148, 163, 184, 0.12)'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(left, rowBottom)
    context.lineTo(right, rowBottom)
    context.stroke()

    if (min < 0 && max > 0) {
      context.strokeStyle = 'rgba(148, 163, 184, 0.2)'
      context.setLineDash([3, 4])
      context.beginPath()
      context.moveTo(left, scaleY(0))
      context.lineTo(right, scaleY(0))
      context.stroke()
      context.setLineDash([])
    }

    context.strokeStyle = row.color || '#5b8cff'
    context.lineWidth = 1.25
    context.beginPath()
    let started = false
    const pixels = Math.max(1, Math.floor(right - left))
    for (let pixel = 0; pixel <= pixels; pixel += 1) {
      const time = props.startTime + (span * pixel) / pixels
      const value = valueAt(row.times, row.values, time)
      if (value === null) continue
      const x = left + pixel
      const y = scaleY(value)
      if (!started) {
        context.moveTo(x, y)
        started = true
      } else {
        context.lineTo(x, y)
      }
    }
    context.stroke()

    context.textAlign = 'left'
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillStyle = 'rgba(231, 234, 240, 0.86)'
    const label = row.label.length > 26 ? `${row.label.slice(0, 25)}…` : row.label
    context.fillText(label, 8, rowTop + ROW / 2 + 4)
    context.fillStyle = 'rgba(153, 163, 179, 0.75)'
    context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.textAlign = 'left'
    context.fillText(`${min.toFixed(2)} / ${max.toFixed(2)}`, right + 6, rowTop + ROW / 2 + 4)
  }
}

function drawOverlay() {
  const { width, height } = dimensions()
  const context = setup(overlay.value, width, height)
  if (!context) return
  context.clearRect(0, 0, width, height)
  if (!props.duration || !props.rows.length) return
  const left = GUTTER
  const right = width - RIGHT_GUTTER
  const x = left + ((right - left) * Math.min(Math.max(props.current, 0), props.duration)) / props.duration
  context.strokeStyle = 'rgba(255, 107, 122, 0.9)'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(x, TOP)
  context.lineTo(x, height - PAD)
  context.stroke()
}

function redraw() {
  drawBase()
  drawOverlay()
}

function seekAt(event) {
  const rect = host.value?.getBoundingClientRect()
  if (!rect || !props.duration) return
  const width = rect.width
  const ratio = (event.clientX - rect.left - GUTTER) / Math.max(1, width - GUTTER - RIGHT_GUTTER)
  emit('seek', Math.min(props.duration, Math.max(0, ratio * props.duration)))
}

function onPointerDown(event) {
  pressing = true
  event.currentTarget.setPointerCapture?.(event.pointerId)
  seekAt(event)
}

function onPointerMove(event) {
  if (pressing) seekAt(event)
}

function onPointerUp(event) {
  pressing = false
  event.currentTarget.releasePointerCapture?.(event.pointerId)
}

onMounted(() => {
  observer = new ResizeObserver(() => redraw())
  observer.observe(host.value)
  redraw()
})

onBeforeUnmount(() => observer?.disconnect())

watch(() => [props.rows, props.startTime, props.duration], redraw)
watch(() => props.current, drawOverlay)
</script>

<template>
  <div ref="host" class="signal-chart">
    <canvas ref="base" class="layer" aria-hidden="true" />
    <canvas
      ref="overlay"
      class="layer interactive"
      role="slider"
      aria-label="拖动查看时间点"
      :aria-valuemin="0"
      :aria-valuemax="duration"
      :aria-valuenow="current"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
  </div>
</template>

<style scoped>
.signal-chart {
  position: relative;
  max-height: 430px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
}

.layer {
  display: block;
  width: 100%;
}

.interactive {
  position: absolute;
  top: 0;
  left: 0;
  cursor: crosshair;
  touch-action: none;
}
</style>
