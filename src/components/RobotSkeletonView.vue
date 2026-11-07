<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  points: { type: Array, default: null },
  skeleton: { type: Array, default: null },
  transforms: { type: Array, default: null },
  meshes: { type: Array, default: null },
  emptyMessage: { type: String, default: '没有可显示的姿态数据' },
})

const MESH_COLOR = [0.78, 0.81, 0.86]
const NEAR = 0.2
const FAR = 20

const host = ref(null)
const canvas = ref(null)
const glCanvas = ref(null)
const camera = reactive({ yaw: 0.72, pitch: 0.26, distance: 3.3 })
const target = [0, 0, 0.92]

let observer = null
let drag = null
let gl = null
let programs = null
let grid = null
let meshBuffers = []
let uploadedMeshes = null

function resize() {
  const element = host.value
  if (!element) return
  const ratio = window.devicePixelRatio || 1
  for (const surface of [canvas.value, glCanvas.value]) {
    if (!surface) continue
    surface.width = Math.max(1, Math.round(element.clientWidth * ratio))
    surface.height = Math.max(1, Math.round(element.clientHeight * ratio))
  }
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
  const relative = [point[0] - target[0], point[1] - target[1], point[2] - target[2]]
  const dot = (axis) => relative[0] * axis[0] + relative[1] * axis[1] + relative[2] * axis[2]
  const depth = dot(projectBasis.forward) + camera.distance
  if (depth < NEAR) return null
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

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

/** Column-major 4x4 multiply, same layout as `pose.js`. */
function multiply(left, right) {
  const out = new Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = left[row] * right[column * 4] + left[4 + row] * right[column * 4 + 1] + left[8 + row] * right[column * 4 + 2] + left[12 + row] * right[column * 4 + 3]
    }
  }
  return out
}

/** World -> clip matrix matching the 2D `project` used for bones. */
function viewProjection(width, height) {
  const view = basis()
  const focal = Math.min(width, height) * 0.9
  const viewMatrix = [
    view.right[0],
    view.up[0],
    view.forward[0],
    0,
    view.right[1],
    view.up[1],
    view.forward[1],
    0,
    view.right[2],
    view.up[2],
    view.forward[2],
    0,
    -dot(view.right, target),
    -dot(view.up, target),
    camera.distance - dot(view.forward, target),
    1,
  ]
  const a = (FAR + NEAR) / (FAR - NEAR)
  const b = (-2 * FAR * NEAR) / (FAR - NEAR)
  // prettier-ignore
  const projection = [
    (2 * focal) / width, 0, 0, 0,
    0, (2 * focal) / height, 0, 0,
    0, 0, a, 1,
    0, 0, b, 0,
  ]
  return multiply(projection, viewMatrix)
}

/** Mesh visual origin (T * RPY * scale), column-major. */
function meshModel(mesh) {
  const [sx, sy, sz] = mesh.scale || [1, 1, 1]
  const [rx, ry, rz] = mesh.rpy || [0, 0, 0]
  const [tx, ty, tz] = mesh.xyz || [0, 0, 0]
  const cr = Math.cos(rx)
  const sr = Math.sin(rx)
  const cp = Math.cos(ry)
  const sp = Math.sin(ry)
  const cy = Math.cos(rz)
  const sy2 = Math.sin(rz)
  const m00 = cy * cp
  const m01 = cy * sp * sr - sy2 * cr
  const m02 = cy * sp * cr + sy2 * sr
  const m10 = sy2 * cp
  const m11 = sy2 * sp * sr + cy * cr
  const m12 = sy2 * sp * cr - cy * sr
  const m20 = -sp
  const m21 = cp * sr
  const m22 = cp * cr
  return [m00 * sx, m10 * sx, m20 * sx, 0, m01 * sy, m11 * sy, m21 * sy, 0, m02 * sz, m12 * sz, m22 * sz, 0, tx, ty, tz, 1]
}

function compile(type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '着色器编译失败')
  return shader
}

function createProgram(vertexSource, fragmentSource, attributeNames, uniformNames) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '着色器链接失败')
  const attributes = {}
  for (const name of attributeNames) attributes[name] = gl.getAttribLocation(program, name)
  const uniforms = {}
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name)
  return { program, attributes, uniforms }
}

function initGL() {
  const surface = glCanvas.value
  if (!surface) return
  gl = surface.getContext('webgl', { antialias: true, alpha: true }) || surface.getContext('experimental-webgl', { antialias: true, alpha: true })
  if (!gl) return
  const meshFragment = `precision highp float;
uniform vec3 u_color;
varying highp vec3 v_normal;
void main() {
  float light = 0.55 + 0.45 * abs(dot(normalize(v_normal), normalize(vec3(0.35, 0.3, 0.9))));
  gl_FragColor = vec4(u_color * light, 1.0);
}`
  try {
    programs = {
      mesh: createProgram(
        `attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_viewProjection;
uniform mat4 u_model;
varying highp vec3 v_normal;
void main() {
  v_normal = mat3(u_model) * a_normal;
  gl_Position = u_viewProjection * u_model * vec4(a_position, 1.0);
}`,
        meshFragment,
        ['a_position', 'a_normal'],
        ['u_viewProjection', 'u_model', 'u_color'],
      ),
      line: createProgram(
        `attribute vec3 a_position;
attribute vec4 a_color;
uniform mat4 u_viewProjection;
varying vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_viewProjection * vec4(a_position, 1.0);
}`,
        `precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
}`,
        ['a_position', 'a_color'],
        ['u_viewProjection'],
      ),
    }
  } catch (cause) {
    console.warn('3D 网格渲染初始化失败，改为只显示骨架', cause)
    gl = null
    return
  }
  gl.enable(gl.DEPTH_TEST)
  buildGrid()
}

function buildGrid() {
  const vertices = []
  const push = (from, to, color) => vertices.push(from[0], from[1], from[2], ...color, to[0], to[1], to[2], ...color)
  for (let value = -2; value <= 2.0001; value += 0.5) {
    const major = Math.abs(value - Math.round(value)) < 1e-6
    const color = major ? [0.58, 0.64, 0.72, 0.22] : [0.58, 0.64, 0.72, 0.1]
    push([value, -2, 0], [value, 2, 0], color)
    push([-2, value, 0], [2, value, 0], color)
  }
  push([0, 0, 0], [0.35, 0, 0], [1, 0.42, 0.48, 1])
  push([0, 0, 0], [0, 0.35, 0], [0.24, 0.86, 0.59, 1])
  push([0, 0, 0], [0, 0, 0.35], [0.36, 0.55, 1, 1])
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)
  grid = { buffer, count: vertices.length / 7 }
}

function syncMeshes() {
  if (uploadedMeshes === props.meshes) return
  uploadedMeshes = props.meshes || []
  for (const item of meshBuffers) {
    gl.deleteBuffer(item.buffer)
    gl.deleteBuffer(item.normalBuffer)
  }
  meshBuffers = []
  for (const mesh of uploadedMeshes) {
    if (!mesh.triangles?.length || !mesh.normals?.length) continue
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.triangles, gl.STATIC_DRAW)
    const normalBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW)
    meshBuffers.push({
      buffer,
      normalBuffer,
      count: mesh.triangles.length / 3,
      node: mesh.node,
      origin: meshModel(mesh),
      color: (mesh.color || MESH_COLOR).slice(0, 3),
    })
  }
}

function drawScene(width, height) {
  if (!gl || !glCanvas.value) return
  syncMeshes()
  gl.viewport(0, 0, glCanvas.value.width, glCanvas.value.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  const matrix = viewProjection(width, height)

  gl.useProgram(programs.line.program)
  gl.uniformMatrix4fv(programs.line.uniforms.u_viewProjection, false, matrix)
  gl.bindBuffer(gl.ARRAY_BUFFER, grid.buffer)
  gl.enableVertexAttribArray(programs.line.attributes.a_position)
  gl.vertexAttribPointer(programs.line.attributes.a_position, 3, gl.FLOAT, false, 28, 0)
  gl.enableVertexAttribArray(programs.line.attributes.a_color)
  gl.vertexAttribPointer(programs.line.attributes.a_color, 4, gl.FLOAT, false, 28, 12)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.LINES, 0, grid.count)
  gl.disable(gl.BLEND)

  if (!meshBuffers.length || !props.transforms?.length || !props.skeleton?.length) return
  const indices = new Map(props.skeleton.map((node, index) => [node.name, index]))
  gl.useProgram(programs.mesh.program)
  gl.uniformMatrix4fv(programs.mesh.uniforms.u_viewProjection, false, matrix)
  gl.enableVertexAttribArray(programs.mesh.attributes.a_position)
  gl.enableVertexAttribArray(programs.mesh.attributes.a_normal)
  for (const item of meshBuffers) {
    const index = indices.get(item.node)
    const link = index === undefined ? null : props.transforms[index]
    if (!link) continue
    gl.uniformMatrix4fv(programs.mesh.uniforms.u_model, false, multiply(link, item.origin))
    gl.uniform3fv(programs.mesh.uniforms.u_color, item.color)
    gl.bindBuffer(gl.ARRAY_BUFFER, item.buffer)
    gl.vertexAttribPointer(programs.mesh.attributes.a_position, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, item.normalBuffer)
    gl.vertexAttribPointer(programs.mesh.attributes.a_normal, 3, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, item.count)
  }
}

function draw() {
  const element = host.value
  const overlay = canvas.value
  if (!element || !overlay) return
  const ratio = window.devicePixelRatio || 1
  const cssWidth = overlay.width / ratio
  const cssHeight = overlay.height / ratio
  const context = overlay.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, cssWidth, cssHeight)

  drawScene(cssWidth, cssHeight)

  const projectBasis = basis()
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
    const color = name.startsWith('left') || name.endsWith('_L') ? '#5b8cff' : name.startsWith('right') || name.endsWith('_R') ? '#f5b942' : '#c4b5fd'
    bones.push({
      from,
      to,
      color,
      depth: (from.depth + to.depth) / 2,
      width: name.startsWith('contact_') ? 1 : 2,
    })
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
  context.fillText(props.meshes?.length && !gl ? '当前浏览器不支持 WebGL，无法显示 3D 网格' : '拖动旋转 · 滚轮缩放 · 双击复位', 12, 18)
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
  initGL()
  observer = new ResizeObserver(resize)
  observer.observe(host.value)
  resize()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (gl)
    for (const item of meshBuffers) {
      gl.deleteBuffer(item.buffer)
      gl.deleteBuffer(item.normalBuffer)
    }
})

watch(
  () => [props.points, props.skeleton, props.transforms, props.meshes],
  () => draw(),
)
</script>

<template>
  <div ref="host" class="skeleton-view">
    <canvas ref="glCanvas" class="mesh-layer" aria-hidden="true" />
    <canvas
      ref="canvas"
      class="overlay"
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
  background: linear-gradient(180deg, rgba(21, 25, 34, 0.95), rgba(11, 13, 18, 0.98));
}

canvas {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.mesh-layer {
  pointer-events: none;
}

canvas.overlay {
  cursor: grab;
  touch-action: none;
}

canvas.overlay:active {
  cursor: grabbing;
}
</style>
