// EAGLE XML (board `.brd` and schematic `.sch`) -> Circuit JSON.
//
// EAGLE stores both document types as XML in millimetres with Y pointing up,
// which is the frame Circuit JSON uses for PCBs, so board coordinates pass
// through unchanged. Schematic Circuit JSON is consumed by
// `circuit-json-to-kicad` at 15x the source millimetres (that is the unit its
// own converters emit), so schematic coordinates, stroke widths and font sizes
// are divided by `SCHEMATIC_UNIT_SCALE` on the way in.
//
// This module only produces Circuit JSON. `eda.js` feeds the result to the same
// KiCad writer used by the Altium and Specctra paths.

import { XMLParser } from 'fast-xml-parser'

const SCHEMATIC_UNIT_SCALE = 15

// EAGLE's named pin lengths, in millimetres.
const PIN_LENGTHS = { point: 0, short: 2.54, middle: 3.81, long: 5.08 }

const DEFAULT_LINE_WIDTH = 0.1524

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})

function list(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function child(node, name) {
  const value = node?.[name]
  return Array.isArray(value) ? value[0] : value
}

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function slug(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unnamed'
  )
}

function createIdRegistry() {
  const used = new Set()
  const byName = new Map()
  return (prefix, name) => {
    const key = `${prefix}:${name}`
    if (name !== undefined && byName.has(key)) return byName.get(key)
    const base = name === undefined ? prefix : `${prefix}_${slug(name)}`
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) candidate = `${base}_${suffix++}`
    used.add(candidate)
    if (name !== undefined) byName.set(key, candidate)
    return candidate
  }
}

/**
 * EAGLE XML files start with an XML declaration and a doctype pointing at
 * `eagle.dtd`. `.brd` is also Cadence Allegro's binary extension, so callers
 * must sniff the contents before treating a `.brd` as EAGLE.
 */
export function looksLikeEagleXml(text) {
  const sample = String(text || '').replace(/^﻿/, '').trimStart()
  if (!sample.startsWith('<')) return false
  return /<eagle[\s>]/.test(sample.slice(0, 4096))
}

/** Parse EAGLE XML into its board/schematic subtrees. */
export function parseEagleXml(text) {
  const root = parser.parse(String(text).replace(/^﻿/, ''))
  const eagle = root?.eagle
  if (!eagle) throw new Error('不是 EAGLE XML：缺少 <eagle> 根节点。')
  return {
    version: String(eagle.version || ''),
    board: child(eagle.drawing, 'board') || null,
    schematic: child(eagle.drawing, 'schematic') || null,
  }
}

// EAGLE rotation strings look like "R90", "MR270" or "SMR90": an optional
// mirror flag, an optional rotation and text spin. Only mirror and angle matter
// for geometry; spin only affects text.
function parseRotation(value) {
  const text = String(value || '').toUpperCase()
  const match = /R(-?\d+(?:\.\d+)?)/.exec(text)
  return {
    mirror: text.includes('M'),
    angle: match ? num(match[1]) : 0,
  }
}

function rotate({ x, y }, angle) {
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

function mirrorPoint(point, mirror) {
  return mirror ? { x: -point.x, y: point.y } : point
}

/**
 * Placement for one EAGLE element or gate instance. `place` returns the final
 * board/sheet position in EAGLE's millimetre, Y-up frame, which is also the
 * frame Circuit JSON expects for component geometry (its KiCad writer converts
 * absolute positions back into footprint-local coordinates).
 */
function createPlacement(node) {
  const rotation = parseRotation(node?.rot)
  const origin = { x: num(node?.x), y: num(node?.y) }
  return {
    ...rotation,
    origin,
    place(point) {
      const placed = rotate(mirrorPoint(point, rotation.mirror), rotation.angle)
      return { x: origin.x + placed.x, y: origin.y + placed.y }
    },
    vector(direction) {
      return rotate(mirrorPoint(direction, rotation.mirror), rotation.angle)
    },
  }
}

function copperLayer(layer) {
  const number = num(layer)
  if (number === 1) return 'top'
  if (number === 16) return 'bottom'
  if (number >= 2 && number <= 15) return `inner${number - 1}`
  return null
}

function flipLayer(layer, mirrored) {
  if (!mirrored) return layer
  if (layer === 1) return 16
  if (layer === 16) return 1
  if (layer === 21) return 22
  if (layer === 22) return 21
  if (layer === 25) return 26
  if (layer === 26) return 25
  if (layer === 27) return 28
  if (layer === 28) return 27
  if (layer === 51) return 52
  if (layer === 52) return 51
  return layer
}

function isPowerNet(name) {
  return /^(VCC|VDD|VEE|VBUS|VIN|V\+|AVCC|DVCC|VPP|\+\d)/i.test(String(name))
}

function isGroundNet(name) {
  return /^(GND|AGND|DGND|PGND|VSS|0V|0)$/i.test(String(name))
}

function makeContext() {
  const id = createIdRegistry()
  return {
    id,
    elements: [],
    components: new Map(), // part name -> { sourceComponentId, value }
    ports: new Map(), // `${part}\u0000${pad}` -> { sourcePortId, pcbPortId, pinNumber }
    nets: new Map(), // net name -> { name, sourceNetId, sourceTraceId, portIds }
    pinCounters: new Map(),
    usedPinNumbers: new Map(), // part name -> Set of pin numbers
  }
}

function ensureComponent(ctx, name, value) {
  let component = ctx.components.get(name)
  if (!component) {
    const sourceComponentId = ctx.id('source_component', name)
    component = {
      sourceComponentId,
      value: '',
      element: {
        type: 'source_component',
        ftype: 'simple_chip',
        source_component_id: sourceComponentId,
        name,
        display_name: name,
      },
    }
    ctx.components.set(name, component)
    ctx.elements.push(component.element)
  }
  if (value && !component.value) {
    component.value = String(value)
    component.element.display_value = component.value
  }
  return component
}

function ensurePort(ctx, componentName, padName, pinNumber) {
  const key = `${componentName}\u0000${padName}`
  let port = ctx.ports.get(key)
  if (!port) {
    const component = ensureComponent(ctx, componentName)
    let used = ctx.usedPinNumbers.get(componentName)
    if (!used) {
      used = new Set()
      ctx.usedPinNumbers.set(componentName, used)
    }
    let resolvedNumber = pinNumber
    // Numeric pad names ("1", "2") make the best KiCad pad numbers; anything
    // else falls back to the pad order so symbol pins and footprint pads still
    // match each other.
    if (resolvedNumber === undefined && /^\d+$/.test(String(padName)) && !used.has(Number(padName))) {
      resolvedNumber = Number(padName)
    }
    if (resolvedNumber === undefined) {
      let next = (ctx.pinCounters.get(componentName) || 0) + 1
      while (used.has(next)) next += 1
      ctx.pinCounters.set(componentName, next)
      resolvedNumber = next
    }
    used.add(resolvedNumber)
    port = {
      sourcePortId: ctx.id('source_port', `${componentName}_${padName}`),
      pcbPortId: ctx.id('pcb_port', `${componentName}_${padName}`),
      pinNumber: resolvedNumber,
    }
    ctx.ports.set(key, port)
    ctx.elements.push({
      type: 'source_port',
      source_port_id: port.sourcePortId,
      source_component_id: component.sourceComponentId,
      name: String(padName),
      pin_number: resolvedNumber,
      port_hints: [String(padName)],
    })
  }
  return port
}

function ensureNet(ctx, name) {
  const netName = String(name || 'N$')
  let net = ctx.nets.get(netName)
  if (!net) {
    net = {
      name: netName,
      sourceNetId: ctx.id('source_net', netName),
      sourceTraceId: ctx.id('source_trace', netName),
      portIds: new Set(),
    }
    ctx.nets.set(netName, net)
  }
  return net
}

function finishNets(ctx) {
  for (const net of ctx.nets.values()) {
    ctx.elements.push({
      type: 'source_net',
      source_net_id: net.sourceNetId,
      name: net.name,
      member_source_group_ids: [],
      ...(isPowerNet(net.name) ? { is_power: true } : {}),
      ...(isGroundNet(net.name) ? { is_ground: true } : {}),
    })
    ctx.elements.push({
      type: 'source_trace',
      source_trace_id: net.sourceTraceId,
      connected_source_net_ids: [net.sourceNetId],
      connected_source_port_ids: [...net.portIds],
    })
  }
}

function libraryKey(libraryName, itemName) {
  return `${libraryName}\u0000${itemName}`
}

function collectPackages(board) {
  const packages = new Map()
  for (const library of list(board?.libraries?.library)) {
    for (const pkg of list(library?.packages?.package)) {
      packages.set(libraryKey(library.name, pkg.name), pkg)
    }
  }
  return packages
}

function collectSchematicLibraries(schematic) {
  const symbols = new Map()
  const devicesets = new Map()
  for (const library of list(schematic?.libraries?.library)) {
    for (const symbol of list(library?.symbols?.symbol)) {
      symbols.set(libraryKey(library.name, symbol.name), symbol)
    }
    for (const deviceset of list(library?.devicesets?.deviceset)) {
      devicesets.set(libraryKey(library.name, deviceset.name), deviceset)
    }
  }
  return { symbols, devicesets }
}

function deviceFor(deviceset, part) {
  const devices = list(deviceset?.devices?.device)
  return devices.find((device) => String(device.name ?? '') === String(part.device ?? '')) || devices[0]
}

function packageGeometry(pkg, element, ctx) {
  const placement = createPlacement(element)
  const mirrored = placement.mirror
  ensureComponent(ctx, element.name, element.value)
  const componentId = ctx.id('pcb_component', element.name)
  const localPoints = []

  let padIndex = 0
  for (const smd of list(pkg?.smd)) {
    padIndex += 1
    const local = { x: num(smd.x), y: num(smd.y) }
    localPoints.push(local)
    const placed = placement.place(local)
    const padRot = parseRotation(smd.rot)
    const width = num(smd.dx, 0.5)
    const height = num(smd.dy, 0.5)
    const roundness = Math.min(Math.max(num(smd.roundness), 0), 100)
    const layer = copperLayer(flipLayer(num(smd.layer, 1), mirrored)) || 'top'
    const port = ensurePort(ctx, element.name, smd.name, padIndex)
    // Circuit JSON pad positions and angles are absolute board values; the
    // KiCad writer converts them back to footprint-local coordinates.
    const angle = placement.angle + (mirrored ? -padRot.angle : padRot.angle)
    const cornerRadius = roundness > 0 ? (Math.min(width, height) * roundness) / 100 : undefined
    const pad =
      width === height && roundness >= 100
        ? { shape: 'circle', radius: width / 2 }
        : angle % 180 === 0
          ? { shape: 'rect', width, height, ...(cornerRadius ? { corner_radius: cornerRadius } : {}) }
          : {
              shape: 'rotated_rect',
              width,
              height,
              ccw_rotation: angle,
              ...(cornerRadius ? { corner_radius: cornerRadius } : {}),
            }

    ctx.elements.push({
      type: 'pcb_smtpad',
      pcb_smtpad_id: ctx.id('pcb_smtpad', `${element.name}_${smd.name}`),
      pcb_component_id: componentId,
      pcb_port_id: port.pcbPortId,
      port_hints: [String(smd.name)],
      layer,
      x: placed.x,
      y: placed.y,
      ...pad,
    })
    ctx.elements.push({
      type: 'pcb_port',
      pcb_port_id: port.pcbPortId,
      source_port_id: port.sourcePortId,
      pcb_component_id: componentId,
      x: placed.x,
      y: placed.y,
      layers: [layer],
    })
  }

  for (const pad of list(pkg?.pad)) {
    padIndex += 1
    const local = { x: num(pad.x), y: num(pad.y) }
    localPoints.push(local)
    const placed = placement.place(local)
    const drill = num(pad.drill, 0.8)
    const diameter = num(pad.diameter) || drill * 1.6
    const port = ensurePort(ctx, element.name, pad.name, padIndex)
    const padRot = parseRotation(pad.rot)
    const angle = placement.angle + (mirrored ? -padRot.angle : padRot.angle)
    const shape = String(pad.shape || 'round')
    const common = {
      type: 'pcb_plated_hole',
      pcb_plated_hole_id: ctx.id('pcb_plated_hole', `${element.name}_${pad.name}`),
      pcb_component_id: componentId,
      pcb_port_id: port.pcbPortId,
      port_hints: [String(pad.name)],
      x: placed.x,
      y: placed.y,
      layers: ['top', 'bottom'],
    }
    if (shape === 'square' || shape === 'octagon') {
      ctx.elements.push({
        ...common,
        shape: 'circular_hole_with_rect_pad',
        rect_pad_width: diameter,
        rect_pad_height: diameter,
        rect_ccw_rotation: angle,
        hole_diameter: drill,
      })
    } else {
      ctx.elements.push({ ...common, shape: 'circle', outer_diameter: diameter, hole_diameter: drill })
    }
    ctx.elements.push({
      type: 'pcb_port',
      pcb_port_id: port.pcbPortId,
      source_port_id: port.sourcePortId,
      pcb_component_id: componentId,
      x: placed.x,
      y: placed.y,
      layers: ['top', 'bottom'],
    })
  }

  for (const hole of list(pkg?.hole)) {
    const local = { x: num(hole.x), y: num(hole.y) }
    localPoints.push(local)
    const placed = placement.place(local)
    ctx.elements.push({
      type: 'pcb_hole',
      pcb_hole_id: ctx.id('pcb_hole', `${element.name}_${hole.x}_${hole.y}`),
      pcb_component_id: componentId,
      hole_shape: 'circle',
      hole_diameter: num(hole.drill, 1),
      x: placed.x,
      y: placed.y,
    })
  }

  // Package graphics. tPlace/bPlace are silk screen, tDocu/bDocu are the
  // assembly outline most EAGLE libraries actually draw.
  for (const wire of list(pkg?.wire)) {
    const layer = flipLayer(num(wire.layer), mirrored)
    if (![21, 22, 51, 52].includes(layer)) continue
    const start = placement.place({ x: num(wire.x1), y: num(wire.y1) })
    const end = placement.place({ x: num(wire.x2), y: num(wire.y2) })
    localPoints.push({ x: num(wire.x1), y: num(wire.y1) }, { x: num(wire.x2), y: num(wire.y2) })
    const isSilk = layer === 21 || layer === 22
    ctx.elements.push({
      type: isSilk ? 'pcb_silkscreen_path' : 'pcb_fabrication_note_path',
      ...(isSilk
        ? { pcb_silkscreen_path_id: ctx.id('pcb_silkscreen_path', `${element.name}_${num(wire.x1)}_${num(wire.y1)}_${num(wire.x2)}_${num(wire.y2)}`) }
        : { pcb_fabrication_note_path_id: ctx.id('pcb_fabrication_note_path', `${element.name}_${num(wire.x1)}_${num(wire.y1)}_${num(wire.x2)}_${num(wire.y2)}`) }),
      pcb_component_id: componentId,
      layer: layer === 21 || layer === 51 ? 'top' : 'bottom',
      stroke_width: num(wire.width, DEFAULT_LINE_WIDTH),
      route: [start, end],
    })
  }

  for (const circle of list(pkg?.circle)) {
    const layer = flipLayer(num(circle.layer), mirrored)
    if (![21, 22].includes(layer)) continue
    const placed = placement.place({ x: num(circle.x), y: num(circle.y) })
    const radius = num(circle.radius)
    localPoints.push(
      { x: num(circle.x) - radius, y: num(circle.y) - radius },
      { x: num(circle.x) + radius, y: num(circle.y) + radius },
    )
    ctx.elements.push({
      type: 'pcb_silkscreen_circle',
      pcb_silkscreen_circle_id: ctx.id('pcb_silkscreen_circle', `${element.name}_${num(circle.x)}_${num(circle.y)}`),
      pcb_component_id: componentId,
      layer: layer === 21 ? 'top' : 'bottom',
      center: placed,
      radius,
      stroke_width: num(circle.width, DEFAULT_LINE_WIDTH),
    })
  }

  for (const text of list(pkg?.text)) {
    const layer = flipLayer(num(text.layer), mirrored)
    if (![21, 22, 25, 26, 27, 28].includes(layer)) continue
    const value = String(text['#text'] ?? '')
      .replace(/>NAME/g, element.name)
      .replace(/>VALUE/g, element.value || '')
      .trim()
    if (!value) continue
    const placed = placement.place({ x: num(text.x), y: num(text.y) })
    localPoints.push({ x: num(text.x), y: num(text.y) })
    const rotation = parseRotation(text.rot)
    ctx.elements.push({
      type: 'pcb_silkscreen_text',
      pcb_silkscreen_text_id: ctx.id('pcb_silkscreen_text', `${element.name}_${num(text.x)}_${num(text.y)}_${value}`),
      pcb_component_id: componentId,
      text: value,
      font: 'tscircuit2024',
      font_size: num(text.size, 1),
      anchor_position: placed,
      anchor_alignment: 'bottom_left',
      ccw_rotation: placement.angle + (mirrored ? -rotation.angle : rotation.angle),
      layer: [21, 25, 27].includes(layer) ? 'top' : 'bottom',
      is_mirrored: mirrored,
    })
  }

  return { componentId, localPoints }
}

function boundingBox(points) {
  if (!points.length) return { center: { x: 0, y: 0 }, width: 1, height: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: Math.max(maxX - minX, 0.1),
    height: Math.max(maxY - minY, 0.1),
  }
}

function ringsFromWires(wires) {
  const key = (point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`
  const edges = new Map()
  for (const wire of wires) {
    const a = { x: num(wire.x1), y: num(wire.y1) }
    const b = { x: num(wire.x2), y: num(wire.y2) }
    const from = key(a)
    const to = key(b)
    if (!edges.has(from)) edges.set(from, [])
    if (!edges.has(to)) edges.set(to, [])
    edges.get(from).push(to)
    edges.get(to).push(from)
  }
  const unvisited = new Set(edges.keys())
  const rings = []
  while (unvisited.size) {
    const start = unvisited.values().next().value
    const ring = []
    let current = start
    let previous = null
    for (let guard = 0; guard <= edges.size + 1; guard += 1) {
      const [x, y] = current.split(',').map(Number)
      ring.push({ x, y })
      unvisited.delete(current)
      const next = (edges.get(current) || []).find((candidate) => candidate !== previous && unvisited.has(candidate))
      if (!next) break
      previous = current
      current = next
      if (current === start) break
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

function ringArea(ring) {
  let area = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area / 2)
}

function addBoardOutline(board, ctx, warnings) {
  const wires = list(board?.plain?.wire).filter((wire) => num(wire.layer) === 20)
  let rings = ringsFromWires(wires).sort((a, b) => ringArea(b) - ringArea(a))
  let outline = rings[0]
  if (!outline) {
    // No usable dimension layer: fall back to the extent of placed parts.
    const points = list(board?.elements?.element).map((element) => ({ x: num(element.x), y: num(element.y) }))
    if (!points.length) return null
    const box = boundingBox(points)
    const margin = 5
    outline = [
      { x: box.center.x - box.width / 2 - margin, y: box.center.y - box.height / 2 - margin },
      { x: box.center.x + box.width / 2 + margin, y: box.center.y - box.height / 2 - margin },
      { x: box.center.x + box.width / 2 + margin, y: box.center.y + box.height / 2 + margin },
      { x: box.center.x - box.width / 2 - margin, y: box.center.y + box.height / 2 + margin },
    ]
    warnings.push({
      level: 'warn',
      message: 'Dimension 层没有闭合板框，已用元件外接矩形估算，请在 KiCad 里重新绘制 Edge.Cuts。',
    })
  }
  const box = boundingBox(outline)
  ctx.elements.push({
    type: 'pcb_board',
    pcb_board_id: ctx.id('pcb_board', 'board'),
    center: box.center,
    width: box.width,
    height: box.height,
    shape: 'polygon',
    outline,
  })
  for (const ring of rings.slice(1)) {
    ctx.elements.push({
      type: 'pcb_cutout',
      pcb_cutout_id: ctx.id('pcb_cutout', `cutout_${ctx.elements.length}`),
      shape: 'path',
      route: [...ring, ring[0]],
    })
  }
  return outline
}

function addBoardSignal(signal, ctx) {
  const net = ensureNet(ctx, signal.name)
  for (const contact of list(signal?.contactref)) {
    const port = ctx.ports.get(`${contact.element}\u0000${contact.pad}`)
    if (port) net.portIds.add(port.sourcePortId)
  }

  for (const wire of list(signal?.wire)) {
    const layer = copperLayer(wire.layer)
    if (!layer) continue
    const width = num(wire.width, DEFAULT_LINE_WIDTH)
    ctx.elements.push({
      type: 'pcb_trace',
      pcb_trace_id: ctx.id('pcb_trace', `${signal.name}_${num(wire.x1)}_${num(wire.y1)}_${num(wire.x2)}_${num(wire.y2)}`),
      source_trace_id: net.sourceTraceId,
      route: [
        { route_type: 'wire', x: num(wire.x1), y: num(wire.y1), width, layer },
        { route_type: 'wire', x: num(wire.x2), y: num(wire.y2), width, layer },
      ],
    })
  }

  for (const via of list(signal?.via)) {
    const drill = num(via.drill, 0.6)
    const diameter = num(via.diameter) || drill * 2
    ctx.elements.push({
      type: 'pcb_via',
      pcb_via_id: ctx.id('pcb_via', `${signal.name}_${num(via.x)}_${num(via.y)}`),
      source_net_id: net.sourceNetId,
      x: num(via.x),
      y: num(via.y),
      outer_diameter: diameter,
      hole_diameter: drill,
      layers: viaLayers(via.extent),
    })
  }

  for (const polygon of list(signal?.polygon)) {
    const layer = copperLayer(polygon.layer)
    const vertices = list(polygon?.vertex)
    if (!layer || vertices.length < 3) continue
    ctx.elements.push({
      type: 'pcb_copper_pour',
      pcb_copper_pour_id: ctx.id('pcb_copper_pour', `${signal.name}_${ctx.elements.length}`),
      source_net_id: net.sourceNetId,
      layer,
      shape: 'polygon',
      points: vertices.map((vertex) => ({ x: num(vertex.x), y: num(vertex.y) })),
    })
  }
}

function viaLayers(extent) {
  const match = /(\d+)\s*-\s*(\d+)/.exec(String(extent || '1-16'))
  const from = match ? num(match[1], 1) : 1
  const to = match ? num(match[2], 16) : 16
  const names = []
  for (let layer = from; layer <= to; layer += 1) {
    const name = copperLayer(layer)
    if (name) names.push(name)
  }
  return names.length ? names : ['top', 'bottom']
}

function convertBoard(board, ctx, warnings) {
  if (!addBoardOutline(board, ctx, warnings)) {
    warnings.push({ level: 'warn', message: '板文件里没有板框或元件，跳过板级内容。' })
    return
  }

  const packages = collectPackages(board)
  for (const element of list(board?.elements?.element)) {
    const pkg = packages.get(libraryKey(element.library, element.package))
    if (!pkg) {
      warnings.push({
        level: 'warn',
        message: `元件 ${element.name} 引用的封装 ${element.library}/${element.package} 不在文件里，已跳过。`,
      })
      continue
    }
    const { componentId, localPoints } = packageGeometry(pkg, element, ctx)
    const box = boundingBox(localPoints)
    const placement = createPlacement(element)
    ctx.elements.push({
      type: 'pcb_component',
      pcb_component_id: componentId,
      source_component_id: ctx.components.get(element.name).sourceComponentId,
      center: placement.origin,
      width: box.width,
      height: box.height,
      layer: placement.mirror ? 'bottom' : 'top',
      rotation: placement.angle,
      position_mode: 'none',
      obstructs_within_bounds: false,
    })
  }

  // Plain-board silk screen and drills outside any package.
  for (const wire of list(board?.plain?.wire)) {
    const layer = num(wire.layer)
    if (![21, 22].includes(layer)) continue
    ctx.elements.push({
      type: 'pcb_silkscreen_path',
      pcb_silkscreen_path_id: ctx.id('pcb_silkscreen_path', `plain_${num(wire.x1)}_${num(wire.y1)}_${num(wire.x2)}_${num(wire.y2)}`),
      layer: layer === 21 ? 'top' : 'bottom',
      stroke_width: num(wire.width, DEFAULT_LINE_WIDTH),
      route: [
        { x: num(wire.x1), y: num(wire.y1) },
        { x: num(wire.x2), y: num(wire.y2) },
      ],
    })
  }
  for (const text of list(board?.plain?.text)) {
    const value = String(text['#text'] ?? '').trim()
    if (!value) continue
    const rotation = parseRotation(text.rot)
    ctx.elements.push({
      type: 'pcb_silkscreen_text',
      pcb_silkscreen_text_id: ctx.id('pcb_silkscreen_text', `plain_${num(text.x)}_${num(text.y)}_${value}`),
      text: value,
      font: 'tscircuit2024',
      font_size: num(text.size, 1),
      anchor_position: { x: num(text.x), y: num(text.y) },
      anchor_alignment: 'bottom_left',
      ccw_rotation: rotation.mirror ? -rotation.angle : rotation.angle,
      layer: [22, 26, 28].includes(num(text.layer)) ? 'bottom' : 'top',
      is_mirrored: rotation.mirror,
    })
  }
  for (const hole of list(board?.plain?.hole)) {
    ctx.elements.push({
      type: 'pcb_hole',
      pcb_hole_id: ctx.id('pcb_hole', `plain_${num(hole.x)}_${num(hole.y)}`),
      hole_shape: 'circle',
      hole_diameter: num(hole.drill, 1),
      x: num(hole.x),
      y: num(hole.y),
    })
  }

  for (const signal of list(board?.signals?.signal)) addBoardSignal(signal, ctx)
}

// ---------------------------------------------------------------------------
// Schematic

function schematicLength(value) {
  return value / SCHEMATIC_UNIT_SCALE
}

function schematicPoint(point) {
  return { x: schematicLength(point.x), y: schematicLength(point.y) }
}

function addSymbolShape(shape, type, placement, elements, componentId, sheetId, ctx, key) {
  if (num(shape.layer, 94) !== 94) return
  if (type === 'wire') {
    const start = schematicPoint(placement.place({ x: num(shape.x1), y: num(shape.y1) }))
    const end = schematicPoint(placement.place({ x: num(shape.x2), y: num(shape.y2) }))
    elements.push({
      type: 'schematic_line',
      schematic_line_id: ctx.id('schematic_line', key),
      schematic_component_id: componentId,
      schematic_sheet_id: sheetId,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      stroke_width: schematicLength(num(shape.width, DEFAULT_LINE_WIDTH)),
    })
    return
  }
  if (type === 'circle') {
    elements.push({
      type: 'schematic_circle',
      schematic_circle_id: ctx.id('schematic_circle', key),
      schematic_component_id: componentId,
      schematic_sheet_id: sheetId,
      center: schematicPoint(placement.place({ x: num(shape.x), y: num(shape.y) })),
      radius: schematicLength(num(shape.radius)),
      stroke_width: schematicLength(num(shape.width, DEFAULT_LINE_WIDTH)),
    })
    return
  }
  if (type === 'rectangle') {
    const corners = [
      { x: num(shape.x1), y: num(shape.y1) },
      { x: num(shape.x2), y: num(shape.y1) },
      { x: num(shape.x2), y: num(shape.y2) },
      { x: num(shape.x1), y: num(shape.y2) },
      { x: num(shape.x1), y: num(shape.y1) },
    ].map((point) => schematicPoint(placement.place(point)))
    elements.push({
      type: 'schematic_path',
      schematic_path_id: ctx.id('schematic_path', key),
      schematic_component_id: componentId,
      schematic_sheet_id: sheetId,
      points: corners,
      stroke_width: schematicLength(DEFAULT_LINE_WIDTH),
    })
    return
  }
  if (type === 'polygon') {
    const points = list(shape?.vertex).map((vertex) =>
      schematicPoint(placement.place({ x: num(vertex.x), y: num(vertex.y) })),
    )
    if (points.length < 3) return
    elements.push({
      type: 'schematic_path',
      schematic_path_id: ctx.id('schematic_path', key),
      schematic_component_id: componentId,
      schematic_sheet_id: sheetId,
      points: [...points, points[0]],
      stroke_width: schematicLength(num(shape.width, DEFAULT_LINE_WIDTH)),
    })
  }
}

function facingFrom(direction) {
  if (Math.abs(direction.x) >= Math.abs(direction.y)) return direction.x >= 0 ? 'right' : 'left'
  return direction.y >= 0 ? 'up' : 'down'
}

function pinLength(pin) {
  const length = String(pin.length ?? 'point')
  if (length in PIN_LENGTHS) return PIN_LENGTHS[length]
  return num(length)
}

function padForPin(pinref, parts, devicesets) {
  const part = parts.get(pinref.part)
  if (!part) return pinref.pin
  const deviceset = devicesets.get(libraryKey(part.library, part.deviceset))
  if (!deviceset) return pinref.pin
  const connect = list(deviceFor(deviceset, part)?.connects?.connect).find(
    (item) => item.gate === pinref.gate && item.pin === pinref.pin,
  )
  return connect?.pad || pinref.pin
}

function convertSchematic(schematic, ctx, warnings) {
  const { symbols, devicesets } = collectSchematicLibraries(schematic)
  const parts = new Map()
  for (const part of list(schematic?.parts?.part)) parts.set(part.name, part)

  const sheets = list(schematic?.sheets?.sheet)
  let skippedGraphics = 0
  sheets.forEach((sheet, sheetIndex) => {
    const sheetId = ctx.id('schematic_sheet', `sheet_${sheetIndex + 1}`)
    ctx.elements.push({
      type: 'schematic_sheet',
      schematic_sheet_id: sheetId,
      name: `Sheet ${sheetIndex + 1}`,
      display_name: `Sheet ${sheetIndex + 1}`,
      sheet_index: sheetIndex,
    })

    const sheetPorts = [] // { center, schematicPortId } for wire-endpoint snapping

    for (const instance of list(sheet?.instances?.instance)) {
      const part = parts.get(instance.part)
      if (!part) continue
      const deviceset = devicesets.get(libraryKey(part.library, part.deviceset))
      const gate = list(deviceset?.gates?.gate).find((item) => item.name === instance.gate)
      const symbol = symbols.get(libraryKey(part.library, gate?.symbol))
      if (!deviceset || !gate || !symbol) {
        warnings.push({
          level: 'warn',
          message: `原理图元件 ${part.name} 的库符号缺失（${part.library}/${part.deviceset}/${gate?.symbol}），已跳过。`,
        })
        continue
      }
      // Title frames and decorative symbols carry no pins. KiCad supplies its
      // own drawing sheet, so importing them as components only creates
      // duplicate references with nothing electrical inside.
      if (!list(symbol?.pin).length) {
        skippedGraphics += 1
        continue
      }

      // EAGLE gate offsets are library-editor placement aids, not part of the
      // instance transform: KiCad's own EAGLE importer ignores them too, and
      // the net wire endpoints only line up with pin positions when they are
      // left out.
      const placement = createPlacement(instance)
      const component = ensureComponent(ctx, part.name, part.value)
      const schematicComponentId = ctx.id('schematic_component', `${part.name}_${instance.gate}_${sheetIndex}`)

      const symbolElements = []
      const symbolPoints = []
      const shapeKey = (type, index) => `${part.name}_${instance.gate}_${type}_${index}`
      for (const [index, wire] of list(symbol?.wire).entries()) {
        addSymbolShape(wire, 'wire', placement, symbolElements, schematicComponentId, sheetId, ctx, shapeKey('w', index))
        symbolPoints.push({ x: num(wire.x1), y: num(wire.y1) }, { x: num(wire.x2), y: num(wire.y2) })
      }
      for (const [index, circle] of list(symbol?.circle).entries()) {
        addSymbolShape(circle, 'circle', placement, symbolElements, schematicComponentId, sheetId, ctx, shapeKey('c', index))
        const radius = num(circle.radius)
        symbolPoints.push(
          { x: num(circle.x) - radius, y: num(circle.y) - radius },
          { x: num(circle.x) + radius, y: num(circle.y) + radius },
        )
      }
      for (const [index, rectangle] of list(symbol?.rectangle).entries()) {
        addSymbolShape(rectangle, 'rectangle', placement, symbolElements, schematicComponentId, sheetId, ctx, shapeKey('r', index))
        symbolPoints.push({ x: num(rectangle.x1), y: num(rectangle.y1) }, { x: num(rectangle.x2), y: num(rectangle.y2) })
      }
      for (const [index, polygon] of list(symbol?.polygon).entries()) {
        addSymbolShape(polygon, 'polygon', placement, symbolElements, schematicComponentId, sheetId, ctx, shapeKey('p', index))
        for (const vertex of list(polygon?.vertex)) symbolPoints.push({ x: num(vertex.x), y: num(vertex.y) })
      }

      const connects = list(deviceFor(deviceset, part)?.connects?.connect)
      for (const pin of list(symbol?.pin)) {
        const connect = connects.find((item) => item.gate === instance.gate && item.pin === pin.name)
        const padName = connect?.pad || pin.name
        const port = ensurePort(ctx, part.name, padName)
        const pinRotation = parseRotation(pin.rot).angle
        const connection = placement.place({ x: num(pin.x), y: num(pin.y) })
        const direction = placement.vector({
          x: Math.cos((pinRotation * Math.PI) / 180),
          y: Math.sin((pinRotation * Math.PI) / 180),
        })
        const length = pinLength(pin)
        const body = schematicPoint({
          x: connection.x + direction.x * length,
          y: connection.y + direction.y * length,
        })
        const center = schematicPoint(connection)
        if (length > 0) {
          symbolElements.push({
            type: 'schematic_line',
            schematic_line_id: ctx.id('schematic_line', `${part.name}_${instance.gate}_pin_${pin.name}`),
            schematic_component_id: schematicComponentId,
            schematic_sheet_id: sheetId,
            x1: center.x,
            y1: center.y,
            x2: body.x,
            y2: body.y,
            stroke_width: schematicLength(DEFAULT_LINE_WIDTH),
          })
        }
        const schematicPortId = ctx.id('schematic_port', `${part.name}_${instance.gate}_${padName}`)
        ctx.elements.push({
          type: 'schematic_port',
          schematic_port_id: schematicPortId,
          schematic_component_id: schematicComponentId,
          schematic_sheet_id: sheetId,
          source_port_id: port.sourcePortId,
          center,
          pin_number: String(port.pinNumber),
          facing_direction: facingFrom({ x: -direction.x, y: -direction.y }),
        })
        sheetPorts.push({ center, schematicPortId })
        symbolPoints.push({ x: num(pin.x), y: num(pin.y) })
      }

      const placed = symbolPoints.map((point) => placement.place(point))
      const box = boundingBox(placed)
      const center = schematicPoint(box.center)
      const width = schematicLength(box.width)
      const height = schematicLength(box.height)
      ctx.elements.push({
        type: 'schematic_component',
        schematic_component_id: schematicComponentId,
        schematic_sheet_id: sheetId,
        source_component_id: component.sourceComponentId,
        center,
        size: { width: Math.max(width, 0.2), height: Math.max(height, 0.2) },
        is_box_with_pins: false,
        symbol_display_value: part.value || undefined,
      })
      ctx.elements.push(...symbolElements)

      ctx.elements.push({
        type: 'schematic_text',
        schematic_text_id: ctx.id('schematic_text', `${part.name}_${instance.gate}_ref`),
        schematic_component_id: schematicComponentId,
        schematic_sheet_id: sheetId,
        text: part.name,
        font_size: schematicLength(1.778),
        position: { x: center.x, y: center.y + height / 2 + schematicLength(1.27) },
        rotation: 0,
        anchor: 'bottom_left',
      })
      if (part.value) {
        ctx.elements.push({
          type: 'schematic_text',
          schematic_text_id: ctx.id('schematic_text', `${part.name}_${instance.gate}_value`),
          schematic_component_id: schematicComponentId,
          schematic_sheet_id: sheetId,
          text: String(part.value),
          font_size: schematicLength(1.524),
          position: { x: center.x, y: center.y - height / 2 - schematicLength(2.54) },
          rotation: 0,
          anchor: 'top_left',
        })
      }
    }

    // Nets. Segments hold pin references, wires, junctions and labels. Net
    // names are merged across sheets, which is what KiCad global labels do.
    for (const net of list(sheet?.nets?.net)) {
      const sharedNet = ensureNet(ctx, net.name)
      let traceIndex = 0
      for (const segment of list(net?.segment)) {
        traceIndex += 1
        for (const pinref of list(segment?.pinref)) {
          const padName = padForPin(pinref, parts, devicesets)
          const port = ctx.ports.get(`${pinref.part}\u0000${padName}`)
          if (port) sharedNet.portIds.add(port.sourcePortId)
        }
        const edges = list(segment?.wire).map((wire) => {
          const rawStart = schematicPoint({ x: num(wire.x1), y: num(wire.y1) })
          const rawEnd = schematicPoint({ x: num(wire.x2), y: num(wire.y2) })
          // EAGLE rounds wire endpoints when it writes the file, while pin
          // positions are recomputed from the instance transform. Snap a wire
          // endpoint onto a nearby pin so KiCad sees a real connection.
          const startPort = snapToPort(rawStart, sheetPorts)
          const endPort = snapToPort(rawEnd, sheetPorts)
          const edge = {
            from: startPort?.center ?? rawStart,
            to: endPort?.center ?? rawEnd,
          }
          if (startPort) edge.from_schematic_port_id = startPort.schematicPortId
          if (endPort) edge.to_schematic_port_id = endPort.schematicPortId
          return edge
        })
        const junctions = list(segment?.junction).map((junction) =>
          schematicPoint({ x: num(junction.x), y: num(junction.y) }),
        )
        for (const label of list(segment?.label)) {
          ctx.elements.push({
            type: 'schematic_net_label',
            schematic_net_label_id: ctx.id('schematic_net_label', `${net.name}_${num(label.x)}_${num(label.y)}`),
            schematic_sheet_id: sheetId,
            source_net_id: sharedNet.sourceNetId,
            text: net.name,
            anchor_position: schematicPoint({ x: num(label.x), y: num(label.y) }),
            anchor_side: parseRotation(label.rot).angle === 180 ? 'right' : 'left',
          })
        }
        if (edges.length || junctions.length) {
          ctx.elements.push({
            type: 'schematic_trace',
            schematic_trace_id: ctx.id('schematic_trace', `${net.name}_${sheetIndex}_${traceIndex}`),
            schematic_sheet_id: sheetId,
            source_trace_id: sharedNet.sourceTraceId,
            edges,
            junctions,
          })
        }
      }
    }
  })
  if (skippedGraphics) {
    warnings.push({
      level: 'info',
      message: `已跳过 ${skippedGraphics} 个无引脚的图框/装饰符号，KiCad 会使用自己的图纸边框。`,
    })
  }
}

// ~0.3 mm in Circuit JSON schematic units; enough for EAGLE's 4-decimal
// coordinate rounding, small enough not to merge unrelated wires.
const SNAP_TOLERANCE = 0.02

function snapToPort(point, ports) {
  let best = null
  let bestDistance = SNAP_TOLERANCE
  for (const port of ports) {
    const distance = Math.hypot(point.x - port.center.x, point.y - port.center.y)
    if (distance <= bestDistance) {
      best = port
      bestDistance = distance
    }
  }
  return best
}

/** Convert parsed EAGLE documents into Circuit JSON plus user-facing warnings. */
export function eagleToCircuitJson({ board, schematic }, warnings = []) {
  const ctx = makeContext()
  if (board) convertBoard(board, ctx, warnings)
  if (schematic) convertSchematic(schematic, ctx, warnings)
  finishNets(ctx)
  return ctx.elements
}
