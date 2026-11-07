// URDF → replay skeleton. Preset robots live as `.urdf` files under
// `public/robots`; uploaded URDFs are parsed with the same code. Mesh visuals
// are optional: the caller resolves the filenames and passes STL triangles back
// to the view.
//
// The 3D view uses a bone skeleton, not a physics engine, so fixed joints are
// kept as nodes and revolute/continuous joints carry their axis.

import { computePose } from './pose.js'

const textDecoder = new TextDecoder()

function numbers(value, count) {
  const parts = String(value || '')
    .trim()
    .split(/\s+/)
    .map(Number)
  if (parts.length !== count || parts.some((part) => !Number.isFinite(part))) return null
  return parts
}

function childElements(element, name) {
  return [...element.childNodes].filter((node) => node.nodeType === 1 && node.localName === name)
}

function firstChild(element, name) {
  return childElements(element, name)[0] || null
}

function originOf(element) {
  const origin = firstChild(element, 'origin')
  return {
    xyz: (origin && numbers(origin.getAttribute('xyz'), 3)) || [0, 0, 0],
    rpy: (origin && numbers(origin.getAttribute('rpy'), 3)) || [0, 0, 0],
  }
}

/**
 * Parse a URDF. `parseXml` defaults to the browser's DOMParser and is injected
 * by the Node tests (`@xmldom/xmldom`).
 */
export function parseUrdf(source, { parseXml } = {}) {
  const Parser = parseXml || globalThis.DOMParser
  if (!Parser) throw new Error('当前环境没有 XML 解析器')
  const document = new Parser().parseFromString(String(source || ''), 'application/xml')
  const robot = document.documentElement
  if (!robot || robot.localName !== 'robot') throw new Error('不是 URDF 文件（缺少 <robot> 根节点）')

  const links = [...robot.getElementsByTagName('link')].filter((link) => link.parentNode === robot)
  if (!links.length) throw new Error('URDF 里没有 <link>')

  const warnings = []
  const joints = []
  const childLinks = new Set()
  for (const joint of [...robot.getElementsByTagName('joint')]) {
    const parent = firstChild(joint, 'parent')?.getAttribute('link')
    const child = firstChild(joint, 'child')?.getAttribute('link')
    if (!parent || !child) {
      warnings.push({ level: 'warn', message: `关节 ${joint.getAttribute('name') || '?'} 缺少 parent 或 child` })
      continue
    }
    childLinks.add(child)
    const type = joint.getAttribute('type') || 'fixed'
    const axisElement = firstChild(joint, 'axis')
    const axis = axisElement && numbers(axisElement.getAttribute('xyz'), 3)
    let jointAxis = null
    if (type === 'revolute' || type === 'continuous') jointAxis = axis || [1, 0, 0]
    else if (type !== 'fixed') warnings.push({ level: 'warn', message: `关节 ${joint.getAttribute('name')} 的类型 ${type} 按固定关节处理` })
    const origin = originOf(joint)
    joints.push({
      name: joint.getAttribute('name') || child,
      parent,
      child,
      offset: origin.xyz,
      rpy: origin.rpy,
      joint: jointAxis ? joint.getAttribute('name') || child : null,
      axis: jointAxis,
    })
  }

  const byChild = new Map()
  for (const joint of joints) {
    if (byChild.has(joint.child)) warnings.push({ level: 'warn', message: `连杆 ${joint.child} 有多个父关节，只使用第一个` })
    else byChild.set(joint.child, joint)
  }

  // Named materials are defined once under <robot> and referenced by <visual>.
  const materialColors = new Map()
  for (const material of [...robot.getElementsByTagName('material')]) {
    if (material.parentNode !== robot) continue
    const rgba = numbers(firstChild(material, 'color')?.getAttribute('rgba'), 4)
    if (rgba) materialColors.set(material.getAttribute('name'), rgba)
  }

  const meshes = []
  for (const link of links) {
    for (const visual of [...link.getElementsByTagName('visual')]) {
      if (visual.parentNode !== link) continue
      const mesh = firstChild(firstChild(visual, 'geometry') || visual, 'mesh')
      if (!mesh) continue
      const origin = originOf(visual)
      const scale = numbers(mesh.getAttribute('scale'), 3) || [1, 1, 1]
      const material = firstChild(visual, 'material')
      const color = (material && numbers(firstChild(material, 'color')?.getAttribute('rgba'), 4)) || materialColors.get(material?.getAttribute('name')) || null
      meshes.push({ link: link.getAttribute('name'), filename: mesh.getAttribute('filename') || '', xyz: origin.xyz, rpy: origin.rpy, scale, color })
    }
  }

  const skeleton = []
  const queue = links.map((link) => link.getAttribute('name')).filter((name) => !childLinks.has(name))
  const visited = new Set()
  while (queue.length) {
    const name = queue.shift()
    if (visited.has(name)) continue
    visited.add(name)
    const joint = byChild.get(name)
    skeleton.push({
      name,
      parent: joint ? joint.parent : null,
      offset: joint ? joint.offset : [0, 0, 0],
      rpy: joint ? joint.rpy : [0, 0, 0],
      joint: joint ? joint.joint : null,
      axis: joint ? joint.axis : null,
    })
    for (const candidate of joints) if (candidate.parent === name) queue.push(candidate.child)
  }
  if (skeleton.length < links.length) warnings.push({ level: 'warn', message: 'URDF 里有无法连接到根连杆的孤立连杆，已忽略' })

  // URDF models usually put the base at z=0 with the feet below it. Lift the
  // roots so the rest pose stands on the canvas grid.
  const rest = computePose(skeleton, new Map(), [1, 0, 0, 0])
  const minZ = Math.min(...rest.points.filter((point) => point.every(Number.isFinite)).map((point) => point[2]))
  if (Number.isFinite(minZ) && minZ < 0) {
    for (const node of skeleton) if (node.parent === null) node.offset = [node.offset[0], node.offset[1], node.offset[2] - minZ]
  }

  const jointsSet = new Set(skeleton.filter((node) => node.joint && node.axis).map((node) => node.joint))
  return {
    name: robot.getAttribute('name') || 'robot',
    skeleton,
    meshes: meshes.filter((mesh) => mesh.filename && visited.has(mesh.link)),
    order: [...jointsSet],
    joints: jointsSet,
    warnings,
  }
}

/** Parse a binary or ASCII STL into flat triangle vertices. */
export function parseStl(bytes, { maxTriangles = Infinity } = {}) {
  let triangles
  let total
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const head = textDecoder
    .decode(bytes.subarray(0, Math.min(bytes.length, 24)))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  const ascii = head.startsWith('solid')
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0
  const binaryLength = 84 + count * 50
  // Some exporters write `solid` into a binary STL's 80-byte header. An exact
  // binary length wins; otherwise trust the shape of the data.
  const binary = count > 0 && binaryLength <= bytes.length && (binaryLength === bytes.length || !ascii)

  if (binary) {
    total = count
    const stride = Math.max(1, Math.ceil(total / maxTriangles))
    triangles = new Float32Array(Math.ceil(total / stride) * 9)
    let write = 0
    for (let index = 0; index < total; index += stride) {
      const offset = 84 + index * 50 + 12
      for (let vertex = 0; vertex < 9; vertex += 1) triangles[write++] = view.getFloat32(offset + vertex * 4, true)
    }
  } else {
    const vertices = []
    const text = textDecoder.decode(bytes)
    const pattern = /vertex\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
    let match
    while ((match = pattern.exec(text))) vertices.push(Number(match[1]), Number(match[2]), Number(match[3]))
    total = Math.floor(vertices.length / 9)
    const stride = Math.max(1, Math.ceil(total / maxTriangles))
    triangles = new Float32Array(Math.ceil(total / stride) * 9)
    let write = 0
    for (let index = 0; index < total; index += stride) {
      for (let vertex = 0; vertex < 9; vertex += 1) triangles[write++] = vertices[index * 9 + vertex]
    }
  }
  return { triangles, total, binary }
}

/**
 * Per-vertex normals for triangle soup. STL duplicates every vertex, so weld
 * by rounded position before averaging; otherwise every face stays flat and a
 * dense mesh renders as noise.
 */
export function smoothNormals(triangles) {
  const faces = Math.floor(triangles.length / 9)
  const sums = new Map()
  const key = (offset) => `${Math.round(triangles[offset] * 1e4)},${Math.round(triangles[offset + 1] * 1e4)},${Math.round(triangles[offset + 2] * 1e4)}`
  for (let face = 0; face < faces; face += 1) {
    const offset = face * 9
    const ax = triangles[offset]
    const ay = triangles[offset + 1]
    const az = triangles[offset + 2]
    const e1x = triangles[offset + 3] - ax
    const e1y = triangles[offset + 4] - ay
    const e1z = triangles[offset + 5] - az
    const e2x = triangles[offset + 6] - ax
    const e2y = triangles[offset + 7] - ay
    const e2z = triangles[offset + 8] - az
    // Unnormalized cross product: area weighting falls out for free.
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    for (let vertex = 0; vertex < 9; vertex += 3) {
      const id = key(offset + vertex)
      const sum = sums.get(id)
      if (sum) {
        sum[0] += nx
        sum[1] += ny
        sum[2] += nz
      } else sums.set(id, [nx, ny, nz])
    }
  }

  const normals = new Float32Array(triangles.length)
  for (let face = 0; face < faces; face += 1) {
    const offset = face * 9
    for (let vertex = 0; vertex < 9; vertex += 3) {
      const sum = sums.get(key(offset + vertex))
      const length = sum ? Math.hypot(sum[0], sum[1], sum[2]) : 0
      if (length > 0) {
        normals[offset + vertex] = sum[0] / length
        normals[offset + vertex + 1] = sum[1] / length
        normals[offset + vertex + 2] = sum[2] / length
      }
    }
  }
  return normals
}
