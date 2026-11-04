<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  points: { type: Array, default: null },
  skeleton: { type: Array, default: null },
  emptyMessage: { type: String, default: '没有可显示的姿态数据' },
})

const host = ref(null)
const canvas = ref(null)
const camera = reactive({ yaw: 0.72, pitch: 0.26, distance: 3.3 })
const target = [0, 0, 0.92]

let observer = null
let drag = null

function resize() {
  const element = host.value
  const context = canvas.value
  if (!element || !context) return
  const ratio = window.devicePixelRatio || 1
  context.width = Math.max(1, Math.round(element.clientWidth * ratio))
  context.height = Math.max(1, Math.round(element.clientHeight * ratio))
  draw()
}

function basis() {
  const cp = Math.cos(camera.pitch)
  const sp = Math.sin(camera.pitch)
  const cy = Math.cos(camera.yaw)
  const sy = Math.sin(camera.yaw)
  return {
    right: [-sy, cy, 0],
    up: [-cy * sp, -sy * sp, cp],
    forward: [cy * cp, sy * cp, sp],
  }
}

function project(point, projectBasis, width, height) {
  const relative = [
    point[0] - target[0],
    point[1] - target[1],
    point[2] - target[2],
  ]
  const dot = (axis) => relative[0] * axis[0] + relative[1] * axis[1] + relative[2] * axis[2]
  const depth = dot(projectBasis.forward) + camera.distance
  if (depth < 0.08) return null
  const focal = Math.min(width, height) * 0.9
  return {
    x: width / 2 + (dot(projectBasis.right) * focal) / depth,
    y: height / 2 - (dot(projectBasis.up) * focal) / depth,
    depth,
  }
}

function line(context, from, to, color, width = 1) {
  if (!from || !to) return
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.strokeStyle = color
  context.lineWidth = width
  context.stroke()
}

function drawGrid(context, projectBasis, width, height) {
  for (let value = -2; value <= 2.0001; value += 0.5) {
    const major = Math.abs(value - Math.round(value)) < 1e-6
    const color = major ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.1)'
    line(
      context,
      project([value, -2, 0], projectBasis, width, height),
      project([value, 2, 0], projectBasis, width, height),
      color,
    )
    line(
      context,
      project([-2, value, 0], projectBasis, width, height),
      project([2, value, 0], projectBasis, width, height),
      color,
    )
  }
  const origin = project([0, 0, 0], projectBasis, width, height)
  line(context, origin, project([0.35, 0, 0], projectBasis, width, height), '#ff6b7a', 1.6)
  line(context, origin, project([0, 0.35, 0], projectBasis, width, height), '#3ddc97', 1.6)
  line(context, origin, project([0, 0, 0.35], projectBasis, width, height), '#5b8cff', 1.6)
}

function draw() {
  const element = host.value
  const canvasElement = canvas.value
  if (!element || !canvasElement) return
  const context = canvasElement.getContext('2d')
  const width = canvasElement.width
  const height = canvasElement.height
  const ratio = window.devicePixelRatio || 1
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const cssWidth = width / ratio
  const cssHeight = height / ratio
  context.clearRect(0, 0, cssWidth, cssHeight)

  const gradient = context.createLinearGradient(0, 0, 0, cssHeight)
  gradient.addColorStop(0, 'rgba(21, 25, 34, 0.95)')
  gradient.addColorStop(1, 'rgba(11, 13, 18, 0.98)')
  context.fillStyle = gradient
  context.fillRect(0, 0, cssWidth, cssHeight)

  const projectBasis = basis()
  drawGrid(context, projectBasis, cssWidth, cssHeight)

  if (!props.points?.length || !props.skeleton?.length) {
    context.fillStyle = 'rgba(153, 163, 179, 0.9)'
    context.font = '13px Inter, system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText(props.emptyMessage, cssWidth / 2, cssHeight / 2)
    return
  }

  const projected = props.points.map((point) => project(point, projectBasis, cssWidth, cssHeight))
  const bones = []
  props.skeleton.forEach((node, index) => {
    if (node.parent === null) return
    const parentIndex = props.skeleton.findIndex((item) => item.name === node.parent)
    if (parentIndex < 0) return
    const from = projected[parentIndex]
    const to = projected[index]
    if (!from || !to) return
    const name = node.name
    const color = name.startsWith('left') || name.endsWith('_L')
      ? '#5b8cff'
      : name.startsWith('right') || name.endsWith('_R')
        ? '#f5b942'
        : '#c4b5fd'
    bones.push({ from, to, color, depth: (from.depth + to.depth) / 2, width: name.startsWith('contact_') ? 1 : 2 })
  })

  bones.sort((left, right) => right.depth - left.depth)
  for (const bone of bones) line(context, bone.from, bone.to, bone.color, bone.width)

  props.skeleton.forEach((node, index) => {
    const point = projected[index]
    if (!point) return
    const isContact = node.name.startsWith('contact_') || node.name.endsWith('_contact')
    context.beginPath()
    context.arc(point.x, point.y, isContact ? 2.4 : 3, 0, Math.PI * 2)
    context.fillStyle = isContact ? '#3ddc97' : '#e7eaf0'
    context.fill()
  })

  context.fillStyle = 'rgba(153, 163, 179, 0.75)'
  context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'left'
  context.fillText('拖动旋转 · 滚轮缩放 · 双击复位', 12, 18)
}

function onPointerDown(event) {
  drag = { x: event.clientX, y: event.clientY }
  event.currentTarget.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event) {
  if (!drag) return
  camera.yaw += (event.clientX - drag.x) * 0.01
  camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + (drag.y - event.clientY) * 0.01))
  drag = { x: event.clientX, y: event.clientY }
  draw()
}

function onPointerUp(event) {
  drag = null
  event.currentTarget.releasePointerCapture?.(event.pointerId)
}

function onWheel(event) {
  camera.distance = Math.max(1.2, Math.min(9, camera.distance * Math.exp(event.deltaY * 0.001)))
  draw()
}

function resetCamera() {
  camera.yaw = 0.72
  camera.pitch = 0.26
  camera.distance = 3.3
  draw()
}

onMounted(() => {
  observer = new ResizeObserver(resize)
  observer.observe(host.value)
  resize()
})

onBeforeUnmount(() => {
  observer?.disconnect()
})

watch(
  () => [props.points, props.skeleton],
  () => draw(),
)
</script>

<template>
  <div ref="host" class="skeleton-view">
    <canvas
      ref="canvas"
      aria-label="机器人姿态预览"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
      @dblclick="resetCamera"
    />
  </div>
</template>

<style scoped>
.skeleton-view {
  position: relative;
  min-height: 360px;
  height: clamp(360px, 52vh, 620px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

canvas:active {
  cursor: grabbing;
}
</style>
