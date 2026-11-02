// Read-only preview model for the Circuit JSON a conversion produced.
//
// The preview renders the intermediate model rather than the KiCad output:
// Circuit JSON is already millimetres with Y up, and it keeps the source
// net/port IDs on both the board and the schematic, which is what the
// cross-probe between the two views needs.
//
// Everything here is framework-free so `node --test` can check the indexing
// without a DOM.

const TOP = 'top'
const BOTTOM = 'bottom'
const INNER = /^(?:inner|in)(\d+)(?:\.cu)?$/i

// `circuit-json-to-kicad` scales schematic coordinates by 15 to get millimetres
// and draws schematic text at 1.27 mm, so text drawn at the default size has to
// be 1.27 / 15 model units to match the exported `.kicad_sch`.
export const SCHEMATIC_TEXT_SIZE = 1.27 / 15

// Millimetres per schematic model unit. `circuit-json-to-kicad` multiplies
// schematic coordinates by this to get millimetres; the board is already in
// millimetres, so its factor is 1.
export const SCHEMATIC_MM_PER_UNIT = 15

// Zoom limits in screen pixels per millimetre. Stating them physically is what
// keeps the schematic readable: a limit in model units per pixel is 15x weaker
// on the schematic, which left 1.27 mm text five pixels tall at the old cap.
export const MAX_PX_PER_MM = 240
export const MIN_PX_PER_MM = 0.02

/**
 * The viewport's allowed `scale` range, in model units per pixel, for a model
 * whose coordinates are `mmPerUnit` millimetres. Zooming in makes `scale`
 * smaller, so `zoomIn` is the lower numeric bound and `zoomOut` the upper one.
 */
export function zoomScaleLimits(mmPerUnit = 1) {
  return {
    zoomIn: 1 / (MAX_PX_PER_MM * mmPerUnit),
    zoomOut: 1 / (MIN_PX_PER_MM * mmPerUnit),
  }
}

/** Screen pixels per millimetre for a viewport `scale` of the given model. */
export function pxPerMm(scale, mmPerUnit = 1) {
  return 1 / (scale * mmPerUnit)
}

/**
 * Font size, in schematic model units, of a `schematic_text`. `keepsOwnSize`
 * mirrors the writer: it honours `font_size` only while the schematic also keeps
 * its component-level graphics, and redraws everything else at the 1.27 mm
 * default. Net labels and pin numbers have no size of their own.
 */
export function schematicTextSize(element, keepsOwnSize = false) {
  return (keepsOwnSize && element?.font_size) || SCHEMATIC_TEXT_SIZE
}

const COMPONENT_PRIMITIVE_TYPES = new Set([
  'schematic_path',
  'schematic_circle',
  'schematic_arc',
  'schematic_line',
  'schematic_rect',
])

// `circuit-json-to-kicad` only keeps a text's own `font_size` when it also keeps
// standalone graphics (`preserveStandaloneGraphics`): some component must be
// drawn from its own primitives instead of a library symbol. EAGLE schematics
// qualify; Altium ones are all library symbols, so the writer redraws their text
// at the 1.27 mm default and the preview has to do the same or every label ends
// up a couple of times the size of the exported one.
function keepsTextSizes(index) {
  const primitiveOwners = new Set()
  const symbolOwners = new Set()
  for (const elements of index.groups.values()) {
    for (const element of elements) {
      const owner = element.schematic_component_id
      if (!owner) continue
      if (element.schematic_symbol_id) symbolOwners.add(owner)
      else if (COMPONENT_PRIMITIVE_TYPES.has(element.type)) primitiveOwners.add(owner)
    }
  }
  return index.list('schematic_component').some(
    (component) =>
      component.is_box_with_pins === false &&
      !component.symbol_name &&
      !('schematic_symbol_id' in component) &&
      !symbolOwners.has(component.schematic_component_id) &&
      primitiveOwners.has(component.schematic_component_id),
  )
}

const COPPER_RANK = new Map([[TOP, 0]])
for (let index = 1; index <= 16; index += 1) COPPER_RANK.set(`inner${index}`, index)
COPPER_RANK.set(BOTTOM, 99)

export const PCB_LAYERS = {
  edge: { id: 'edge', label: '板框 Edge.Cuts', group: 'board' },
  holes: { id: 'holes', label: '钻孔 / 开槽', group: 'board' },
  'silk-top': { id: 'silk-top', label: '顶层丝印 F.SilkS', group: 'silk' },
  'silk-bottom': { id: 'silk-bottom', label: '底层丝印 B.SilkS', group: 'silk' },
  'courtyard-top': { id: 'courtyard-top', label: '顶层占地 F.CrtYd', group: 'other' },
  'courtyard-bottom': { id: 'courtyard-bottom', label: '底层占地 B.CrtYd', group: 'other' },
  'fab-top': { id: 'fab-top', label: '顶层装配 F.Fab', group: 'other' },
  'fab-bottom': { id: 'fab-bottom', label: '底层装配 B.Fab', group: 'other' },
}

const SIDE_LAYER = {
  top: { silk: 'silk-top', courtyard: 'courtyard-top', fab: 'fab-top' },
  bottom: { silk: 'silk-bottom', courtyard: 'courtyard-bottom', fab: 'fab-bottom' },
}

// Accept both the Circuit JSON spelling (`top`, `bottom`, `inner1`) and the
// KiCad one (`F.Cu`, `B.Cu`, `In1.Cu`) so a converter that leaks a KiCad layer
// name still lands on a real layer instead of silently piling onto the top.
function copperLayer(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === BOTTOM || text === 'b.cu' || text === 'back') return BOTTOM
  const inner = INNER.exec(text)
  if (inner) return `inner${inner[1]}`
  return TOP
}

export function copperLayerLabel(layer) {
  if (layer === TOP) return '顶层 F.Cu'
  if (layer === BOTTOM) return '底层 B.Cu'
  const inner = INNER.exec(layer || '')
  return inner ? `内层 ${inner[1]}` : String(layer || '')
}

function copperLayersOf(element) {
  if (Array.isArray(element.layers) && element.layers.length) {
    const layers = [...new Set(element.layers.map(copperLayer))]
    return layers.filter((layer) => COPPER_RANK.has(layer))
  }
  return [copperLayer(element.layer)]
}

export function boundsOf(points) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points || []) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  if (minX === Infinity) return null
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

export function unionBounds(boundsList) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const bounds of boundsList || []) {
    if (!bounds) continue
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }
  if (minX === Infinity) return null
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

export function padBounds(bounds, margin) {
  if (!bounds) return null
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  }
}

// Axis-aligned bounds of a rotated rectangle, used for pads and graphics that
// carry a `ccw_rotation`.
function rotatedRectBounds(center, width, height, angleDegrees) {
  const angle = ((angleDegrees || 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const halfW = width / 2
  const halfH = height / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [dx, dy] of [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ]) {
    const x = center.x + dx * cos - dy * sin
    const y = center.y + dx * sin + dy * cos
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

function groupByType(circuitJson) {
  const groups = new Map()
  for (const element of circuitJson || []) {
    if (!element || typeof element.type !== 'string') continue
    let list = groups.get(element.type)
    if (!list) groups.set(element.type, (list = []))
    list.push(element)
  }
  return groups
}

// Nets are keyed by name: EAGLE merges them across sheets and the KiCad writer
// turns same-named labels into global labels, so the preview should treat them
// as one net even when the converters emitted several `source_net` entries.
const netKeyOf = (name) => `net:${name}`

class ProjectIndex {
  constructor(circuitJson) {
    this.groups = groupByType(circuitJson)
    this.netBySourceId = new Map()
    this.netBySourceTraceId = new Map()
    this.netBySourcePortId = new Map()
    this.pcbPortNet = new Map()
    this.schematicPortNet = new Map()
    this.componentName = new Map()

    const nets = this.list('source_net')
    for (const net of nets) {
      if (!net.source_net_id) continue
      const existing = this.netBySourceId.get(net.source_net_id)
      if (existing) continue
      this.netBySourceId.set(net.source_net_id, {
        key: netKeyOf(net.name || net.source_net_id),
        name: net.name || net.source_net_id,
        sourceNetId: net.source_net_id,
      })
    }

    for (const trace of this.list('source_trace')) {
      const id = trace.source_trace_id
      if (!id) continue
      let net = null
      for (const sourceNetId of trace.connected_source_net_ids || []) {
        if (this.netBySourceId.has(sourceNetId)) {
          net = this.netBySourceId.get(sourceNetId)
          break
        }
      }
      if (!net) continue
      if (!this.netBySourceTraceId.has(id)) this.netBySourceTraceId.set(id, net)
      for (const portId of trace.connected_source_port_ids || []) {
        if (!this.netBySourcePortId.has(portId)) this.netBySourcePortId.set(portId, net)
      }
    }

    for (const port of this.list('pcb_port')) {
      const net = port.source_port_id ? this.netBySourcePortId.get(port.source_port_id) : null
      if (net) this.pcbPortNet.set(port.pcb_port_id, net)
    }
    for (const port of this.list('schematic_port')) {
      const net = port.source_port_id ? this.netBySourcePortId.get(port.source_port_id) : null
      if (net) this.schematicPortNet.set(port.schematic_port_id, net)
    }
    for (const component of this.list('source_component')) {
      this.componentName.set(
        component.source_component_id,
        component.display_name || component.name || component.source_component_id || '',
      )
    }
  }

  list(type) {
    return this.groups.get(type) || []
  }

  netForTrace(sourceTraceId) {
    return sourceTraceId ? this.netBySourceTraceId.get(sourceTraceId) || null : null
  }

  netForSourceNet(sourceNetId) {
    return sourceNetId ? this.netBySourceId.get(sourceNetId) || null : null
  }

  nameOf(sourceComponentId) {
    return this.componentName.get(sourceComponentId) || ''
  }
}

function pcbElementBounds(element) {
  switch (element.type) {
    case 'pcb_board':
      return boundsOf(element.outline)
    case 'pcb_cutout':
      return boundsOf(element.outline || element.route || element.points)
    case 'pcb_trace': {
      const route = element.route || []
      const bounds = boundsOf(route.filter((entry) => entry.route_type !== 'via'))
      const width = route.reduce((max, entry) => Math.max(max, entry.width || 0), 0)
      return bounds ? padBounds(bounds, width / 2) : null
    }
    case 'pcb_copper_pour':
      return boundsOf(element.points || element.brep_shape?.outer_ring?.vertices)
    case 'pcb_via': {
      const bounds = boundsOf([{ x: element.x, y: element.y }])
      return bounds ? padBounds(bounds, (element.outer_diameter || 0) / 2) : null
    }
    case 'pcb_smtpad': {
      const center = { x: element.x ?? element.center?.x, y: element.y ?? element.center?.y }
      if (element.shape === 'circle') {
        return padBounds(boundsOf([center]), element.radius || 0)
      }
      if (element.shape === 'pill' || element.shape === 'rotated_pill') {
        return rotatedRectBounds(center, element.width || 0, element.height || 0, element.ccw_rotation || 0)
      }
      if (element.points) return boundsOf(element.points)
      return rotatedRectBounds(center, element.width || 0, element.height || 0, element.ccw_rotation || 0)
    }
    case 'pcb_plated_hole': {
      const center = { x: element.x, y: element.y }
      const width = element.rect_pad_width || element.outer_diameter || element.hole_diameter || 0
      const height = element.rect_pad_height || element.outer_diameter || element.hole_diameter || 0
      return rotatedRectBounds(center, width, height, element.rect_ccw_rotation || 0)
    }
    case 'pcb_hole': {
      const center = { x: element.x, y: element.y }
      const width = element.hole_width || element.hole_diameter || 0
      const height = element.hole_height || element.hole_diameter || 0
      return rotatedRectBounds(center, width, height, element.ccw_rotation || 0)
    }
    case 'pcb_component': {
      const radius = Math.hypot(element.width || 0, element.height || 0) / 2
      return padBounds(boundsOf([element.center || { x: 0, y: 0 }]), radius)
    }
    case 'pcb_silkscreen_path':
    case 'pcb_fabrication_note_path':
      return boundsOf(element.route)
    case 'pcb_silkscreen_line': {
      const bounds = boundsOf([
        { x: element.x1, y: element.y1 },
        { x: element.x2, y: element.y2 },
      ])
      return bounds ? padBounds(bounds, (element.stroke_width || 0) / 2) : null
    }
    case 'pcb_silkscreen_circle': {
      const center = element.center || { x: element.x, y: element.y }
      return padBounds(boundsOf([center]), element.radius || 0)
    }
    case 'pcb_silkscreen_graphic': {
      const ring = element.brep_shape?.outer_ring?.vertices || element.points
      return boundsOf(ring)
    }
    case 'pcb_courtyard_outline':
      return boundsOf(element.outline)
    case 'pcb_silkscreen_text':
    case 'pcb_fabrication_note_text':
    case 'pcb_fabrication_note_rect': {
      // Text is drawn from its anchor towards +X with the glyph height along Y;
      // treating the whole string as a square would inflate the board bounds and
      // make the initial fit zoom out for no reason.
      const anchor = element.anchor_position || element.center || { x: element.x, y: element.y }
      const fontSize = element.font_size || element.height || 1
      const width = fontSize * 0.6 * Math.max(1, String(element.text || '').length)
      const x = Number.isFinite(anchor?.x) ? anchor.x : 0
      const y = Number.isFinite(anchor?.y) ? anchor.y : 0
      return {
        minX: x,
        minY: y,
        maxX: x + width,
        maxY: y + fontSize,
        width,
        height: fontSize,
      }
    }
    default:
      return null
  }
}

function pcbItem(index, element, kind, layers) {
  return {
    kind,
    id: element[`${element.type}_id`] || element.type,
    element,
    layers,
    bounds: pcbElementBounds(element),
  }
}

function sideLayers(layer, suffix) {
  const side = layer === BOTTOM ? BOTTOM : TOP
  return [SIDE_LAYER[side][suffix]]
}

function withNet(item, net) {
  if (net) {
    item.net = net.name
    item.netKey = net.key
  }
  return item
}

function buildPcb(index) {
  const items = []
  const copperLayers = new Set()
  const refdesByComponent = new Map()

  // Vias span every layer between their ends, which on a two-layer board can
  // still say `inner1..16` (EAGLE does); only pads, traces and pours prove a
  // copper layer exists.
  const trackCopper = (element) => {
    for (const layer of copperLayersOf(element)) copperLayers.add(layer)
  }

  for (const element of index.list('pcb_board')) {
    items.push(pcbItem(index, element, 'board', ['edge']))
  }
  for (const element of index.list('pcb_cutout')) {
    items.push(pcbItem(index, element, 'cutout', ['edge']))
  }
  for (const element of index.list('pcb_copper_pour')) {
    trackCopper(element)
    items.push(withNet(pcbItem(index, element, 'pour', copperLayersOf(element)), index.netForSourceNet(element.source_net_id)))
  }
  for (const element of index.list('pcb_trace')) {
    trackCopper(element)
    const net =
      index.netForSourceNet(element.source_net_id) || index.netForTrace(element.source_trace_id)
    items.push(withNet(pcbItem(index, element, 'trace', copperLayersOf(element)), net))
  }
  for (const element of index.list('pcb_via')) {
    const net =
      index.netForSourceNet(element.source_net_id) || index.netForTrace(element.source_trace_id)
    items.push(withNet(pcbItem(index, element, 'via', copperLayersOf(element)), net))
  }
  for (const element of index.list('pcb_smtpad')) {
    trackCopper(element)
    const net = element.pcb_port_id ? index.pcbPortNet.get(element.pcb_port_id) : null
    const item = pcbItem(index, element, 'pad', copperLayersOf(element))
    item.componentId = element.pcb_component_id
    item.pin = element.port_hints?.[0] ?? element.pin_number ?? ''
    items.push(withNet(item, net))
  }
  for (const element of index.list('pcb_plated_hole')) {
    trackCopper(element)
    const net = element.pcb_port_id ? index.pcbPortNet.get(element.pcb_port_id) : null
    const item = pcbItem(index, element, 'pad', copperLayersOf(element))
    item.componentId = element.pcb_component_id
    item.pin = element.port_hints?.[0] ?? element.pin_number ?? ''
    items.push(withNet(item, net))
  }
  for (const element of index.list('pcb_hole')) {
    items.push(pcbItem(index, element, 'hole', ['holes']))
  }
  for (const element of index.list('pcb_component')) {
    const item = pcbItem(index, element, 'component', [element.layer === BOTTOM ? 'silk-bottom' : 'silk-top'])
    item.refdes = index.nameOf(element.source_component_id)
    item.componentId = item.id
    refdesByComponent.set(item.id, item.refdes)
    items.push(item)
  }
  // Pads are created before the components they belong to, so the reference
  // designator is attached here once the component map is complete.
  for (const item of items) {
    if (item.kind === 'pad') item.refdes = refdesByComponent.get(item.componentId) || ''
  }
  for (const element of index.list('pcb_courtyard_outline')) {
    items.push(pcbItem(index, element, 'courtyard', sideLayers(element.layer, 'courtyard')))
  }
  for (const type of ['pcb_silkscreen_path', 'pcb_silkscreen_line', 'pcb_silkscreen_circle', 'pcb_silkscreen_graphic']) {
    for (const element of index.list(type)) {
      items.push(pcbItem(index, element, 'graphic', sideLayers(element.layer, 'silk')))
    }
  }
  for (const element of index.list('pcb_silkscreen_text')) {
    items.push(pcbItem(index, element, 'text', sideLayers(element.layer, 'silk')))
  }
  for (const type of ['pcb_fabrication_note_path', 'pcb_fabrication_note_text']) {
    for (const element of index.list(type)) {
      items.push(pcbItem(index, element, 'fab', sideLayers(element.layer, 'fab')))
    }
  }

  if (!copperLayers.size) {
    copperLayers.add(TOP)
    copperLayers.add(BOTTOM)
  }
  // KiCad boards always have both outer copper layers, even when nothing in the
  // converted model happens to sit on the bottom one yet.
  copperLayers.add(TOP)
  copperLayers.add(BOTTOM)

  // The technical layers are listed only when something is drawn on them, so
  // the layer panel never offers a checkbox that controls nothing.
  const usedLayers = new Set()
  for (const item of items) {
    for (const layer of item.layers) usedLayers.add(layer)
  }

  const layers = [...copperLayers]
    .sort((a, b) => COPPER_RANK.get(a) - COPPER_RANK.get(b))
    .map((layer) => ({
      id: layer,
      label: copperLayerLabel(layer),
      group: 'copper',
    }))
    .concat(Object.values(PCB_LAYERS).filter((layer) => usedLayers.has(layer.id)))

  const bounds = unionBounds(items.map((item) => item.bounds))
  // Silkscreen text and designators can sit outside the edge cut, so the
  // initial fit frames the outline instead of the union over everything drawn.
  const boardBounds = unionBounds(
    items.filter((item) => item.kind === 'board').map((item) => item.bounds),
  )
  return {
    items,
    layers,
    bounds,
    boardBounds: boardBounds || bounds,
    pads: items.filter((item) => item.kind === 'pad'),
    components: items.filter((item) => item.kind === 'component'),
    copperLayerCount: [...copperLayers].length,
  }
}

function schematicItemPoints(element) {
  switch (element.type) {
    case 'schematic_line':
      return [
        { x: element.x1, y: element.y1 },
        { x: element.x2, y: element.y2 },
      ]
    case 'schematic_path':
      return element.points || []
    case 'schematic_circle':
      return [element.center]
    case 'schematic_text':
      return [element.position || element.center]
    case 'schematic_net_label':
      return [element.anchor_position || element.center]
    case 'schematic_trace': {
      const points = []
      for (const edge of element.edges || []) points.push(edge.from, edge.to)
      return points
    }
    case 'schematic_port':
      return [element.center]
    case 'schematic_component':
      return [element.center]
    default:
      return []
  }
}

function schematicElementBounds(element) {
  const points = schematicItemPoints(element).filter(Boolean)
  const bounds = boundsOf(points)
  if (!bounds) {
    if (element.type === 'schematic_component' && element.center) {
      const width = element.size?.width || 0
      const height = element.size?.height || 0
      return rotatedRectBounds(element.center, width, height, 0)
    }
    return null
  }
  if (element.type === 'schematic_circle') return padBounds(bounds, element.radius || 0)
  if (element.type === 'schematic_component') {
    const width = element.size?.width || 0
    const height = element.size?.height || 0
    return rotatedRectBounds(element.center, width, height, 0)
  }
  return bounds
}

function buildSchematic(index) {
  const declaredSheets = index.list('schematic_sheet')
  const sheets = declaredSheets.length ? declaredSheets : [{ schematic_sheet_id: undefined, name: '图纸 1' }]
  const sheetIds = new Set(sheets.map((sheet) => sheet.schematic_sheet_id).filter(Boolean))
  const defaultSheet = sheets[0].schematic_sheet_id
  const keepsOwnTextSizes = keepsTextSizes(index)

  // Elements that name a sheet the converter never declared stay visible on the
  // first sheet rather than disappearing.
  const sheetOf = (element) => {
    const id = element.schematic_sheet_id
    return id && sheetIds.has(id) ? id : defaultSheet
  }

  const items = []
  const add = (item) => {
    item.bounds = schematicElementBounds(item.element)
    items.push(item)
    return item
  }

  for (const component of index.list('schematic_component')) {
    const item = add({
      kind: 'component',
      id: component.schematic_component_id,
      element: component,
      sheet: sheetOf(component),
      componentId: component.schematic_component_id,
      refdes: index.nameOf(component.source_component_id),
      value: component.symbol_display_value || '',
    })
    const ports = []
    for (const port of index.list('schematic_port')) {
      if (port.schematic_component_id !== component.schematic_component_id) continue
      const net = index.schematicPortNet.get(port.schematic_port_id) || null
      ports.push(
        withNet(
          add({
            kind: 'pin',
            id: port.schematic_port_id,
            element: port,
            sheet: sheetOf(port),
            componentId: component.schematic_component_id,
            refdes: item.refdes,
            pin: port.pin_number ?? '',
          }),
          net,
        ),
      )
    }
    item.ports = ports
  }

  for (const type of ['schematic_line', 'schematic_circle', 'schematic_path']) {
    for (const element of index.list(type)) {
      add({
        kind: 'graphic',
        id: element[`${type}_id`],
        element,
        sheet: sheetOf(element),
        componentId: element.schematic_component_id,
      })
    }
  }

  for (const element of index.list('schematic_text')) {
    add({
      kind: 'text',
      id: element.schematic_text_id,
      element,
      sheet: sheetOf(element),
      componentId: element.schematic_component_id,
      fontSize: schematicTextSize(element, keepsOwnTextSizes),
    })
  }

  for (const element of index.list('schematic_trace')) {
    const net = index.netForTrace(element.source_trace_id)
    add(withNet({
      kind: 'wire',
      id: element.schematic_trace_id,
      element,
      sheet: sheetOf(element),
      junctions: element.junctions || [],
    }, net))
  }

  for (const element of index.list('schematic_net_label')) {
    const net = index.netForSourceNet(element.source_net_id)
    add(withNet({
      kind: 'label',
      id: element.schematic_net_label_id,
      element,
      sheet: sheetOf(element),
      text: element.text || net?.name || '',
    }, net))
  }

  const sheetList = sheets.map((sheet, position) => {
    const id = sheet.schematic_sheet_id || `sheet_${position}`
    const sheetItems = items.filter((item) => item.sheet === sheet.schematic_sheet_id)
    return {
      id,
      name: sheet.name || sheet.display_name || `图纸 ${position + 1}`,
      items: sheetItems,
      bounds: unionBounds(sheetItems.map((item) => item.bounds)),
    }
  })

  return {
    sheets: sheetList,
    items,
    components: items.filter((item) => item.kind === 'component'),
    pins: items.filter((item) => item.kind === 'pin'),
  }
}

/**
 * Build the preview model from the Circuit JSON `convertEda` returns.
 * Resolves to `{ hasBoard, hasSchematic, pcb, schematic }`; `pcb` and
 * `schematic` are `null` when the project has no such side.
 */
export function buildPreviewModel(circuitJson) {
  const index = new ProjectIndex(circuitJson)
  const hasBoard = index.list('pcb_board').length > 0
  const hasSchematic =
    index.list('schematic_sheet').length > 0 ||
    index.list('schematic_component').length > 0 ||
    index.list('schematic_text').length > 0

  // Every named net stays searchable even when it reaches no pad, e.g. a net
  // whose only copper is a via.
  const nets = new Map()
  for (const net of index.netBySourceId.values()) nets.set(net.key, { key: net.key, name: net.name })

  return {
    hasBoard,
    hasSchematic,
    nets: [...nets.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    pcb: hasBoard ? buildPcb(index) : null,
    schematic: hasSchematic ? buildSchematic(index) : null,
  }
}

/**
 * Every net in the project, with the pads and pins it reaches. `model` is the
 * result of `buildPreviewModel`; the output is stable across re-renders.
 */
export function indexNets(model) {
  const nets = new Map()
  const ensure = (name, key) => {
    const id = key || netKeyOf(name)
    let entry = nets.get(id)
    if (!entry) {
      entry = { id, name, pcbPads: [], schematicPins: [], labels: [] }
      nets.set(id, entry)
    }
    return entry
  }

  for (const net of model.nets || []) ensure(net.name, net.key)

  const componentById = new Map()
  for (const component of model.pcb?.components || []) componentById.set(component.id, component)

  for (const pad of model.pcb?.pads || []) {
    if (!pad.net) continue
    const component = componentById.get(pad.componentId)
    ensure(pad.net, pad.netKey).pcbPads.push({
      id: pad.id,
      refdes: component?.refdes || '',
      pin: pad.pin,
      bounds: pad.bounds,
    })
  }

  for (const sheet of model.schematic?.sheets || []) {
    for (const item of sheet.items) {
      if (item.kind === 'pin' && item.net) {
        ensure(item.net, item.netKey).schematicPins.push({
          id: item.id,
          refdes: item.refdes,
          pin: item.pin,
          sheet: sheet.id,
          bounds: item.bounds,
        })
      }
      // A label the converters could not tie to a source net has no name to
      // search for and no net to highlight, so it stays a plain drawing.
      if (item.kind === 'label' && item.net) {
        ensure(item.net, item.netKey).labels.push({
          id: item.id,
          text: item.text,
          sheet: sheet.id,
          bounds: item.bounds,
        })
      }
    }
  }

  return [...nets.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/** Components of both views, joined on the reference designator. */
export function indexComponents(model) {
  const byName = new Map()
  const ensure = (refdes) => {
    let entry = byName.get(refdes)
    if (!entry) {
      entry = { refdes, value: '', pcb: null, schematic: null }
      byName.set(refdes, entry)
    }
    return entry
  }
  for (const component of model.pcb?.components || []) {
    if (!component.refdes) continue
    ensure(component.refdes).pcb = component
  }
  for (const component of model.schematic?.components || []) {
    if (!component.refdes) continue
    const entry = ensure(component.refdes)
    entry.schematic = component
    entry.value = entry.value || component.value || ''
  }
  return [...byName.values()].sort((a, b) =>
    a.refdes.localeCompare(b.refdes, 'en', { numeric: true }),
  )
}

/**
 * Flat search index for the toolbar. Matching happens in `searchPreview`, so
 * the UI only has to call one function per keystroke.
 */
export function buildSearchIndex(model, nets) {
  const entries = []
  for (const net of nets) {
    entries.push({
      kind: 'net',
      id: net.id,
      label: net.name,
      detail: `网络 · PCB ${net.pcbPads.length} 焊盘 · 原理图 ${net.schematicPins.length} 引脚`,
      net: net.name,
      hasPcb: net.pcbPads.length > 0,
      hasSchematic: net.schematicPins.length > 0 || net.labels.length > 0,
    })
  }
  for (const component of indexComponents(model)) {
    entries.push({
      kind: 'component',
      id: `component:${component.refdes}`,
      label: component.refdes,
      detail: [component.value, '元件'].filter(Boolean).join(' · '),
      refdes: component.refdes,
      hasPcb: Boolean(component.pcb),
      hasSchematic: Boolean(component.schematic),
    })
  }
  for (const pin of model.schematic?.pins || []) {
    entries.push({
      kind: 'pin',
      id: pin.id,
      label: `${pin.refdes}.${pin.pin}`,
      detail: pin.net ? `原理图引脚 · ${pin.net}` : '原理图引脚',
      refdes: pin.refdes,
      net: pin.net,
      hasSchematic: true,
      hasPcb: false,
    })
  }
  return entries
}

/** Case-insensitive substring search over nets, components and pins. */
export function searchPreview(entries, query, limit = 12) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const scored = []
  for (const entry of entries) {
    const label = entry.label.toLowerCase()
    if (!label.includes(needle)) continue
    // Exact and prefix matches rank above substring hits so typing `R1` does
    // not bury the resistor under `R10`, `R11`, ...
    const score = label === needle ? 0 : label.startsWith(needle) ? 1 : 2
    scored.push({ entry, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.label.length - b.entry.label.length ||
      a.entry.label.localeCompare(b.entry.label, 'en', { numeric: true }),
  )
  return scored.slice(0, limit).map((item) => item.entry)
}
