// PADS Layout ASCII (`.asc`) -> Circuit JSON.
//
// PADS Layout exports a line/section oriented ASCII database: a
// `!PADS-POWERPCB-<version>-<UNITS>!` preamble followed by `*SECTION*` headers
// (PCB, LAYER, VIA, PARTDECAL, PARTTYPE, PART, NET, ROUTE, LINES, TEXT, MISC,
// END). Coordinates use the export's declared units with Y pointing up, which is
// also Circuit JSON's PCB frame, so geometry passes through after a unit
// conversion.
//
// The field order below was cross-checked against two independent readers of the
// format: tscircuit's `padsts` (MIT) and KiCad's GPL-3 PADS importer
// (`pcbnew/pcb_io/pads`, `common/io/pads`). Only Circuit JSON is produced;
// `eda.js` feeds it to the same KiCad writer as every other source.

const MM_PER_UNIT = {
  // PADS internal database unit: 1 BASIC unit = 1/38100 mil.
  BASIC: 25400 / 38100 / 1e6,
  MILS: 0.0254,
  INCHES: 25.4,
  METRIC: 1,
}

const SILK_LAYERS = new Set([26, 29])

// Pad-stack shapes that describe relief/clearance around the barrel rather than
// the barrel itself: thermal relief (RT/ST), antipad (RA/SA) and annular ring
// (A). They must not be used to size the finished via.
const RELIEF_SHAPES = new Set(['RT', 'ST', 'RA', 'SA', 'A'])

// Decal/LINES piece kinds. `COPCUT`/`COPCCO` are negative polarity copper.
const COPPER_PIECE_KINDS = new Set(['COPCLS', 'COPOPN', 'COPCIR', 'COPCUT', 'COPCCO'])
const NEGATIVE_PIECE_KINDS = new Set(['COPCUT', 'COPCCO'])
const CLOSED_PIECE_KINDS = new Set(['CLOSED', 'COPCLS', 'COPCUT', 'KPTCLS'])
const CIRCLE_PIECE_KINDS = new Set(['CIRCLE', 'COPCIR', 'COPCCO', 'KPTCIR'])
const PIECE_KINDS = new Set([
  'OPEN',
  'CLOSED',
  'CIRCLE',
  'COPCLS',
  'COPOPN',
  'COPCIR',
  'COPCUT',
  'COPCCO',
  'KPTCLS',
  'KPTCIR',
  'TAG',
])

const DEFAULT_LINE_WIDTH = 0.15
const ARC_SEGMENTS = 16

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function tokenize(line) {
  const text = String(line ?? '')
  const tokens = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1
    if (index >= text.length) break
    if (text[index] === '"') {
      index += 1
      let value = ''
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) index += 1
        value += text[index]
        index += 1
      }
      index += 1
      tokens.push(value)
      continue
    }
    const start = index
    while (index < text.length && !/\s/.test(text[index])) index += 1
    tokens.push(text.slice(start, index))
  }
  return tokens
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
 * PADS Layout ASCII announces itself on the first line: `!PADS-…!` for the
 * standard export, `*PADS-…*` for the BASIC variant. `.asc` is also used for
 * unrelated netlists, so callers sniff the contents rather than the extension.
 */
export function looksLikePadsAscii(text) {
  const sample = String(text || '').replace(/^﻿/, '').trimStart()
  return /^[!*]PADS-POWERPCB-/i.test(sample.slice(0, 512))
}

function parseVersionHeader(header) {
  const match = /^PADS-POWERPCB-(.+)-(BASIC|MILS|INCHES|METRIC)(?:-.*)?$/i.exec(header)
  if (!match) return null
  return { version: match[1], units: match[2].toUpperCase() }
}

/**
 * Split the document into its top level sections. `*REMARK*` (format notes) and
 * `*SIGNAL*` (net scopes) are content inside the enclosing section, not sections
 * of their own.
 */
export function parsePadsAscii(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const sections = []
  let units = null
  let version = ''
  let sawHeader = false

  for (const line of lines) {
    const trimmed = line.trim()
    const headerMatch = /^[!*](PADS-POWERPCB-[^!*]+)[!*]/.exec(trimmed)
    if (headerMatch && !sawHeader) {
      sawHeader = true
      const header = parseVersionHeader(headerMatch[1].trim())
      if (header) {
        version = header.version
        units = header.units
      }
      continue
    }
    const sectionMatch = /^\*([A-Z_]+)\*/.exec(trimmed)
    if (sectionMatch) {
      const name = sectionMatch[1]
      if (name === 'REMARK' || name === 'SIGNAL') {
        sections.at(-1)?.lines.push(line)
        continue
      }
      sections.push({ name, lines: [] })
      continue
    }
    sections.at(-1)?.lines.push(line)
  }

  if (!units) {
    throw new Error('不是 PADS ASCII 文件:缺少 PADS-POWERPCB 版本头。')
  }

  const sectionOf = (name) => sections.filter((section) => section.name === name)
  let layerCount = 0
  for (const line of sectionOf('PCB').flatMap((section) => section.lines)) {
    const tokens = tokenize(line)
    // `UNITS 0|1|2` refines the header suffix (0 mils, 1 metric, 2 inches), but
    // a BASIC database stays BASIC: its internal-unit flag dominates the
    // declared display units in both tscircuit's parser and KiCad's importer.
    if (tokens[0] === 'UNITS' && units !== 'BASIC') {
      if (tokens[1] === '0') units = 'MILS'
      else if (tokens[1] === '1') units = 'METRIC'
      else if (tokens[1] === '2') units = 'INCHES'
    } else if (tokens[0] === 'MAXIMUMLAYER' || tokens[0] === 'MAXLAYER') {
      layerCount = Math.max(layerCount, Math.trunc(num(tokens[1], 0)))
    }
  }

  return {
    version,
    units,
    sectionOf,
    linesOf: (name) => sectionOf(name).flatMap((section) => section.lines),
    layerCount: layerCount || 2,
    scale: MM_PER_UNIT[units],
  }
}

// Copper levels inside a decal are decal-local: a part placed on the bottom
// layer has its decal flipped, so the mounted-side copper of a mirrored part
// lands on the opposite physical layer.
function flipDecalLevel(level, layerCount, bottom) {
  if (!bottom) return level
  if (level === -2) return 0
  if (level === 0) return -2
  if (level > 0 && level <= layerCount) return layerCount + 1 - level
  return level
}

// Copper levels: -2 is the mounted/top copper, 0 the opposite/bottom copper, -1
// every inner layer, and 1..layerCount the explicit copper layers.
function copperLayerFor(level, layerCount) {
  if (level === -2) return 'top'
  if (level === 0) return 'bottom'
  if (level < 1 || level > layerCount) return null
  if (level === 1) return 'top'
  if (level === layerCount) return 'bottom'
  return `inner${level - 1}`
}

// `<level> <size> <shape> [shape fields] [corner radius] [drill [plated]]`.
// Shapes: R circle, S square, RF rectangular finger, OF oval finger, RT/ST
// thermal relief, RA/SA antipad, A annular.
function readPadStack(line, scale, usesCornerRadius = true) {
  const tokens = tokenize(line)
  const level = Math.trunc(num(tokens[0], NaN))
  const shape = String(tokens[2] || '').toUpperCase()
  if (!Number.isFinite(level) || !shape) return null
  const size = Math.abs(num(tokens[1]))
  const finger = shape === 'RF' || shape === 'OF'
  const thermal = shape === 'RT' || shape === 'ST'
  const orientation = finger || thermal ? num(tokens[3], 0) : 0
  const length = finger ? Math.abs(num(tokens[4], size)) : size
  const offset = finger ? num(tokens[5], 0) : 0
  let cursor = finger ? 6 : 3
  let cornerRadius = 0
  // Only square and rectangular-finger pads carry the optional corner radius,
  // and only from the PADS versions that added the field.
  if ((shape === 'S' || shape === 'RF') && usesCornerRadius) {
    const corner = num(tokens[cursor], NaN)
    if (Number.isFinite(corner)) {
      cornerRadius = Math.abs(corner)
      cursor += 1
    }
  }
  const drill = num(tokens[cursor], 0)
  if (drill > 0) cursor += 1
  const platedToken = String(tokens[cursor] || '').toUpperCase()
  const plated = drill > 0 && ['N', 'P', 'Y'].includes(platedToken) ? platedToken !== 'N' : drill > 0
  if (['N', 'P', 'Y'].includes(platedToken)) cursor += 1
  let slotLength = 0
  const slot = num(tokens[cursor + 1], NaN)
  if (Number.isFinite(slot)) slotLength = Math.abs(slot)
  return {
    level,
    size: size * scale,
    shape,
    orientation,
    length: length * scale,
    offset: offset * scale,
    cornerRadius: cornerRadius * scale,
    drill: drill * scale,
    plated,
    slotLength: slotLength * scale,
  }
}

// A piece is `<kind> <cornerCount> <width> [lineStyle] <layer>` followed by
// `cornerCount` relative points; a point with 8+ fields is an arc vertex
// instead. V9+ part decals add a line-style field between width and layer.
function readPiece(lines, index, origin, scale, usesLineStyle = false) {
  const header = tokenize(lines[index])
  const kind = String(header[0] || '').toUpperCase()
  if (!PIECE_KINDS.has(kind)) return null
  const cornerCount = Math.max(0, Math.trunc(num(header[1], 0)))
  const width = Math.abs(num(header[2], 0)) * scale
  const layer = Math.trunc(num(header[usesLineStyle ? 4 : 3], NaN))
  const points = []
  let flattenedArcs = 0
  let cursor = index + 1
  let parsed = 0
  while (cursor < lines.length && parsed < cornerCount) {
    const pointTokens = tokenize(lines[cursor])
    const x = num(pointTokens[0], NaN)
    const y = num(pointTokens[1], NaN)
    cursor += 1
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    parsed += 1
    if (pointTokens.length >= 8) {
      points.push(...flattenArc(pointTokens, origin, scale))
      flattenedArcs += 1
      continue
    }
    points.push({ x: (origin.x + x) * scale, y: (origin.y + y) * scale })
  }
  return { kind, width, layer, points, flattenedArcs, nextIndex: cursor }
}

// Arc vertices carry the start angle, sweep and bounding box in tenths of a
// degree. Circuit JSON has no arc primitive for copper or silkscreen, so arcs
// are flattened into a short polyline.
function flattenArc(tokens, origin, scale) {
  const startAngle = num(tokens[2], 0) / 10
  const deltaAngle = num(tokens[3], 0) / 10
  const minX = num(tokens[4], 0)
  const minY = num(tokens[5], 0)
  const maxX = num(tokens[6], 0)
  const maxY = num(tokens[7], 0)
  const center = { x: origin.x + (minX + maxX) / 2, y: origin.y + (minY + maxY) / 2 }
  const radius = Math.abs(maxX - minX) / 2
  const steps = Math.max(2, Math.round((Math.abs(deltaAngle) / 90) * (ARC_SEGMENTS / 4)) + 1)
  if (!(radius > 0) || !deltaAngle) {
    return [{ x: (origin.x + num(tokens[0], 0)) * scale, y: (origin.y + num(tokens[1], 0)) * scale }]
  }
  const points = []
  for (let step = 0; step <= steps; step += 1) {
    const angle = ((startAngle + (deltaAngle * step) / steps) * Math.PI) / 180
    points.push({
      x: (center.x + radius * Math.cos(angle)) * scale,
      y: (center.y + radius * Math.sin(angle)) * scale,
    })
  }
  return points
}

function parseViaDefinitions(parsed, warnings) {
  const definitions = new Map()
  let malformed = 0
  for (const section of parsed.sectionOf('VIA')) {
    const lines = section.lines
    let index = 0
    while (index < lines.length) {
      const tokens = tokenize(lines[index])
      const name = tokens[0]
      const drill = Math.abs(num(tokens[1], 0))
      const stackCount = Math.trunc(num(tokens[2], 0))
      if (!name || name.startsWith('*') || !(drill > 0) || stackCount < 1) {
        index += 1
        continue
      }
      const startLayer = Math.trunc(num(tokens[3], 1))
      const endLayer = Math.trunc(num(tokens[4], parsed.layerCount))
      const layers = []
      index += 1
      let parsedStacks = 0
      let guard = 0
      while (index < lines.length && parsedStacks < stackCount && guard++ < 64) {
        const line = lines[index]
        index += 1
        if (!line.trim() || line.trim().startsWith('*REMARK')) continue
        parsedStacks += 1
        const stack = readPadStack(line, parsed.scale)
        if (stack) layers.push(stack)
      }
      if (parsedStacks < stackCount) malformed += 1
      definitions.set(name, { name, drill: drill * parsed.scale, layers, startLayer, endLayer })
    }
  }
  if (malformed > 0) {
    warnings.push({ level: 'warn', message: `${malformed} 个 *VIA* 定义的焊盘层数不完整,已按已读到的层输出。` })
  }
  return definitions
}

// Upper bound of the "explicit corner radius" era: `padsts` treats V9..V1999 as
// carrying the `[CORNERRADIUS]` field, and the `*REMARK*` header states it
// outright when the exporter writes one.
function usesCornerRadiusFields(section, version) {
  if (section.lines.some((line) => line.includes('[CORNERRADIUS]'))) return true
  const major = Number(/^V?(\d+)/.exec(version)?.[1])
  return Number.isFinite(major) && major >= 9 && major < 2000
}

// Pieces inside a decal that declares `LINESTYLE` carry one extra field between
// the width and the layer (`*REMARK* PIECETYPE CORNERS WIDTHHGHT LINESTYLE LEVEL`).
function usesPieceLineStyleField(section) {
  return section.lines.some((line) => line.includes('PIECETYPE') && line.includes('LINESTYLE'))
}

// Header: `<name> <I|M|MM> <orix> <oriy> <pieces> <terminals> <stacks> <texts>
// <labels>`, then the piece blocks, `T` terminals and `PAD` blocks.
function parsePartDecals(parsed, warnings) {
  const decals = new Map()
  let malformedTexts = 0
  let malformedPads = 0
  const unsupportedShapes = new Map()

  for (const section of parsed.sectionOf('PARTDECAL')) {
    const lines = section.lines
    const cornerRadiusFields = usesCornerRadiusFields(section, parsed.version)
    const lineStyleField = usesPieceLineStyleField(section)
    let current = null
    let remainingPieces = 0
    let remainingTexts = 0
    let index = 0
    while (index < lines.length) {
      const tokens = tokenize(lines[index])
      const isHeader =
        tokens.length >= 9 &&
        ['I', 'M', 'MM'].includes(tokens[1]) &&
        tokens.slice(2, 9).every((token) => Number.isFinite(Number(token)))
      if (isHeader) {
        current = {
          name: tokens[0],
          terminals: [],
          padStacks: new Map(),
          pieces: [],
          texts: [],
        }
        remainingPieces = Math.trunc(num(tokens[4], 0))
        remainingTexts = Math.trunc(num(tokens[7], 0))
        if (tokens[0]) decals.set(tokens[0], current)
        index += 1
        continue
      }
      if (!current) {
        index += 1
        continue
      }
      if (tokens[0] === 'PAD') {
        const pinNumber = tokens[1]
        const stackCount = Math.trunc(num(tokens[2], 0))
        const layers = []
        index += 1
        let parsedStacks = 0
        let guard = 0
        while (index < lines.length && parsedStacks < stackCount && guard++ < 32) {
          const line = lines[index]
          index += 1
          if (!line.trim() || line.trim().startsWith('*REMARK')) continue
          parsedStacks += 1
          const stack = readPadStack(line, parsed.scale, cornerRadiusFields)
          if (stack) layers.push(stack)
        }
        if (parsedStacks < stackCount) malformedPads += 1
        if (!pinNumber) continue
        for (const layer of layers) {
          if (!['R', 'S', 'RF', 'OF', 'A'].includes(layer.shape)) {
            unsupportedShapes.set(layer.shape, (unsupportedShapes.get(layer.shape) ?? 0) + 1)
          }
        }
        current.padStacks.set(pinNumber, { pinNumber, layers })
        continue
      }
      if (remainingPieces > 0 && PIECE_KINDS.has(String(tokens[0] || '').toUpperCase())) {
        const piece = readPiece(lines, index, { x: 0, y: 0 }, parsed.scale, lineStyleField)
        if (!piece) {
          index += 1
          continue
        }
        index = piece.nextIndex
        remainingPieces -= 1
        if (piece.kind !== 'TAG') current.pieces.push(piece)
        continue
      }
      // `T<dx> <dy> <dx> <dy> <pin>`: decal-local terminal. V5.x omits the pin.
      const terminalMatch = /^T([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(String(tokens[0] || ''))
      if (terminalMatch) {
        const y = num(tokens[1], NaN)
        if (Number.isFinite(y)) {
          current.terminals.push({
            x: num(terminalMatch[1], 0) * parsed.scale,
            y: y * parsed.scale,
            pinNumber: tokens[4] || String(current.terminals.length + 1),
          })
        }
        index += 1
        continue
      }
      if (remainingPieces === 0 && remainingTexts > 0) {
        const content = lines[index + 2]?.trim()
        if (tokens.length >= 6 && content && !content.startsWith('*')) {
          current.texts.push({
            x: num(tokens[0], 0) * parsed.scale,
            y: num(tokens[1], 0) * parsed.scale,
            rotation: num(tokens[2], 0),
            layer: Math.trunc(num(tokens[3], 0)),
            height: Math.abs(num(tokens[4], 0)) * parsed.scale,
            strokeWidth: Math.abs(num(tokens[5], 0)) * parsed.scale,
            content,
          })
        } else {
          malformedTexts += 1
        }
        remainingTexts -= 1
        // Parameter line, font line, then the text itself.
        index += 3
        continue
      }
      index += 1
    }
  }

  if (malformedPads > 0) {
    warnings.push({ level: 'warn', message: `${malformedPads} 个 *PARTDECAL* 焊盘定义的层数不完整,已按已读到的层输出。` })
  }
  if (malformedTexts > 0) {
    warnings.push({ level: 'warn', message: `${malformedTexts} 个封装内的文字记录无法解析,已跳过。` })
  }
  const shapes = [...unsupportedShapes.keys()].filter(Boolean)
  if (shapes.length) {
    warnings.push({
      level: 'warn',
      message: `封装里出现 ${shapes.join('、')} 焊盘(热焊盘/反焊盘/环形),这些焊盘不会输出到 KiCad。`,
    })
  }
  return decals
}

function parsePartTypeDecals(parsed) {
  const decalsByType = new Map()
  for (const line of parsed.linesOf('PARTTYPE')) {
    const tokens = tokenize(line)
    if (tokens.length < 3 || !tokens[0] || !tokens[1]) continue
    decalsByType.set(tokens[0], tokens[1].split(':').filter(Boolean))
  }
  return decalsByType
}

// Placement transform: mirror across the vertical axis for bottom-side parts,
// then rotate counter-clockwise, then translate. This is the convention both
// `padsts` and KiCad's importer use, and Circuit JSON pad positions are absolute
// board coordinates in the same millimetre, Y-up frame.
function transformDecalPoint(point, placement) {
  const mirroredX = placement.bottom ? -point.x : point.x
  const radians = (placement.rotation * Math.PI) / 180
  return {
    x: placement.x + mirroredX * Math.cos(radians) - point.y * Math.sin(radians),
    y: placement.y + mirroredX * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

function normalizeRotation(rotation) {
  const normalized = rotation % 360
  return normalized < 0 ? normalized + 360 : normalized
}

// `*NET*`/`*ROUTE*` bodies are a flat stream of `*SIGNAL* <name>` scopes: net
// sections list `REF.PIN` membership, route sections list `x y layer width`
// points and `V x y viaName [startLayer] [endLayer]` vias.
function collectNetsAndRoutes(parsed, placements) {
  const references = new Set(placements.map((placement) => placement.reference))
  const netByTerminal = new Map()
  const routes = []
  let currentNet = ''

  const recordTerminals = (tokens) => {
    for (const token of tokens) {
      const separator = token.lastIndexOf('.')
      if (separator <= 0 || separator >= token.length - 1) continue
      const reference = token.slice(0, separator)
      if (!references.has(reference)) continue
      const key = `${reference}\u0000${token.slice(separator + 1)}`
      if (!netByTerminal.has(key)) netByTerminal.set(key, currentNet)
    }
  }

  for (const name of ['NET', 'ROUTE']) {
    currentNet = ''
    for (const line of parsed.linesOf(name)) {
      const trimmed = line.trim()
      const signal = /^\*SIGNAL\*\s*(\S*)/.exec(trimmed)
      if (signal) {
        // A new net scope ends the previous polyline: without this break the
        // last point of one net would be joined to the first point of the next.
        if (name === 'ROUTE' && currentNet) routes.push({ kind: 'break', net: currentNet })
        currentNet = signal[1] || ''
        continue
      }
      if (!currentNet || trimmed.startsWith('*')) continue
      const tokens = tokenize(line)
      if (name === 'NET') {
        recordTerminals(tokens)
        continue
      }
      if (tokens[0] === 'V') {
        routes.push({
          kind: 'via',
          net: currentNet,
          x: num(tokens[1], 0) * parsed.scale,
          y: num(tokens[2], 0) * parsed.scale,
          name: tokens[3] || '',
          startLayer: Number.isFinite(Number(tokens[4])) ? Math.trunc(Number(tokens[4])) : undefined,
          endLayer: Number.isFinite(Number(tokens[5])) ? Math.trunc(Number(tokens[5])) : undefined,
        })
        continue
      }
      const x = num(tokens[0], NaN)
      const y = num(tokens[1], NaN)
      const layer = Math.trunc(num(tokens[2], NaN))
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(layer)) {
        routes.push({ kind: 'break', net: currentNet })
        continue
      }
      recordTerminals(tokens.slice(5))
      routes.push({
        kind: 'point',
        net: currentNet,
        x: x * parsed.scale,
        y: y * parsed.scale,
        layer,
        width: Math.abs(num(tokens[3], 0)) * parsed.scale || DEFAULT_LINE_WIDTH,
      })
    }
  }
  return { netByTerminal, routes }
}

function boundingBox(points) {
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

function ringArea(points) {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area / 2)
}

function circleRing(center, radius) {
  const points = []
  for (let step = 0; step < 32; step += 1) {
    const angle = (step / 32) * Math.PI * 2
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }
  return points
}

function rectangleRing(box) {
  const halfWidth = box.width / 2
  const halfHeight = box.height / 2
  return [
    { x: box.center.x - halfWidth, y: box.center.y - halfHeight },
    { x: box.center.x + halfWidth, y: box.center.y - halfHeight },
    { x: box.center.x + halfWidth, y: box.center.y + halfHeight },
    { x: box.center.x - halfWidth, y: box.center.y + halfHeight },
  ]
}

// `*LINES*` objects are `<name> <type> <orix> <oriy> <pieceCount>` followed by
// piece blocks. `BOARD` type is the board outline; `COPPER` types are pours.
function parseLineObjects(parsed) {
  const objects = []
  let flattenedArcs = 0
  for (const section of parsed.sectionOf('LINES')) {
    const lines = section.lines
    let index = 0
    while (index < lines.length) {
      const header = tokenize(lines[index])
      const isObject =
        header.length >= 5 &&
        !Number.isFinite(Number(header[1])) &&
        Number.isFinite(Number(header[2])) &&
        Number.isFinite(Number(header[3])) &&
        Number.isFinite(Number(header[4])) &&
        !String(header[0]).startsWith('*')
      if (!isObject) {
        index += 1
        continue
      }
      const object = {
        name: header[0],
        type: String(header[1] || 'LINES').toUpperCase(),
        origin: { x: num(header[2], 0), y: num(header[3], 0) },
        pieceCount: Math.trunc(num(header[4], 0)),
        pieces: [],
      }
      index += 1
      for (let pieceIndex = 0; pieceIndex < object.pieceCount && index < lines.length; pieceIndex += 1) {
        const piece = readPiece(lines, index, object.origin, parsed.scale)
        if (!piece) break
        index = piece.nextIndex
        flattenedArcs += piece.flattenedArcs
        object.pieces.push(piece)
      }
      objects.push(object)
    }
  }
  return { objects, flattenedArcs }
}

function isBoardObject(object) {
  return object.type === 'BOARD' || object.type === 'BOARD_OUTLINE' || /BOARD/i.test(String(object.name))
}

function isCopperObject(object) {
  return object.type.includes('COPPER') || object.type === 'COPCUT'
}

function isKeepoutObject(object) {
  return object.type.includes('KEEP') || object.type.startsWith('RESTRICT')
}

function addBoard(points, ctx, warnings) {
  let box
  let outline
  if (points && points.length >= 3) {
    box = boundingBox(points)
    outline = points
  } else {
    if (!ctx.components.length) return
    const placed = boundingBox(ctx.components.map((component) => component.center))
    box = {
      center: placed.center,
      width: placed.width + 10,
      height: placed.height + 10,
    }
    outline = rectangleRing(box)
    warnings.push({
      level: 'warn',
      message: 'PADS 文件里没有 *LINES* 板框,已用元件外接矩形估算,请在 KiCad 里重画 Edge.Cuts。',
    })
  }

  ctx.elements.push({
    type: 'pcb_board',
    pcb_board_id: ctx.id('pcb_board', 'board'),
    center: box.center,
    width: box.width,
    height: box.height,
    shape: 'polygon',
    outline,
  })
}

function makeContext(layerCount) {
  return {
    id: createIdRegistry(),
    layerCount,
    elements: [],
    components: [],
    componentIds: new Map(),
    ports: new Map(),
    nets: new Map(),
    pinCounters: new Map(),
    usedPinNumbers: new Map(),
  }
}

function ensureComponent(ctx, reference, value) {
  let component = ctx.componentIds.get(reference)
  if (component) return component
  const sourceComponentId = ctx.id('source_component', reference)
  const pcbComponentId = ctx.id('pcb_component', reference)
  component = { sourceComponentId, pcbComponentId }
  ctx.componentIds.set(reference, component)
  ctx.elements.push({
    type: 'source_component',
    source_component_id: sourceComponentId,
    ftype: 'simple_chip',
    name: reference,
    display_name: reference,
    ...(value ? { display_value: value } : {}),
  })
  return component
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

function ensurePort(ctx, reference, pinNumber) {
  const key = `${reference}\u0000${pinNumber}`
  let port = ctx.ports.get(key)
  if (port) return port
  const component = ensureComponent(ctx, reference)
  let used = ctx.usedPinNumbers.get(reference)
  if (!used) {
    used = new Set()
    ctx.usedPinNumbers.set(reference, used)
  }
  let resolved = /^\d+$/.test(String(pinNumber)) ? Number(pinNumber) : undefined
  if (resolved === undefined) {
    let next = (ctx.pinCounters.get(reference) || 0) + 1
    while (used.has(next)) next += 1
    ctx.pinCounters.set(reference, next)
    resolved = next
  }
  used.add(resolved)
  port = {
    sourcePortId: ctx.id('source_port', `${reference}_${pinNumber}`),
    pcbPortId: ctx.id('pcb_port', `${reference}_${pinNumber}`),
    pinNumber: resolved,
  }
  ctx.ports.set(key, port)
  ctx.elements.push({
    type: 'source_port',
    source_port_id: port.sourcePortId,
    source_component_id: component.sourceComponentId,
    name: String(pinNumber),
    pin_number: resolved,
    port_hints: [String(pinNumber)],
  })
  return port
}

function smtPadShape(layer, shape, width, height, rotation, cornerRadius) {
  if (shape === 'R') return { shape: 'circle', radius: Math.min(width, height) / 2 }
  if (shape === 'OF') {
    return rotation % 180 === 0
      ? { shape: 'pill', width, height, radius: Math.min(width, height) / 2 }
      : { shape: 'rotated_pill', width, height, radius: Math.min(width, height) / 2, ccw_rotation: rotation }
  }
  const roundedCorner = cornerRadius
    ? { corner_radius: Math.min(cornerRadius, Math.min(width, height) / 2) }
    : {}
  return rotation % 180 === 0
    ? { shape: 'rect', width, height, ...roundedCorner }
    : { shape: 'rotated_rect', width, height, ccw_rotation: rotation, ...roundedCorner }
}

function addPlacedPart(placement, decal, netByTerminal, ctx) {
  const component = ensureComponent(ctx, placement.reference, placement.partType)
  const localPoints = []
  const mountedLevel = placement.bottom ? ctx.layerCount : 1
  const mountedLayer = copperLayerFor(mountedLevel, ctx.layerCount) || 'top'

  for (const terminal of decal.terminals) {
    const stack = decal.padStacks.get(terminal.pinNumber) ?? decal.padStacks.get('0')
    if (!stack) continue
    const padLayer =
      stack.layers.find((layer) => layer.level === mountedLevel) ??
      stack.layers.find((layer) => layer.level === -2) ??
      stack.layers[0]
    if (!padLayer || padLayer.size <= 0) continue

    const localCenter = { x: terminal.x, y: terminal.y }
    if (padLayer.offset) {
      const radians = (padLayer.orientation * Math.PI) / 180
      localCenter.x += padLayer.offset * Math.cos(radians)
      localCenter.y += padLayer.offset * Math.sin(radians)
    }
    const center = transformDecalPoint(localCenter, placement)
    const rotation = normalizeRotation(
      placement.rotation + (placement.bottom ? 180 - padLayer.orientation : padLayer.orientation),
    )
    const width = padLayer.shape === 'RF' || padLayer.shape === 'OF' ? padLayer.length : padLayer.size
    const height = padLayer.size
    const port = ensurePort(ctx, placement.reference, terminal.pinNumber)
    const netName = netByTerminal.get(`${placement.reference}\u0000${terminal.pinNumber}`)
    if (netName) ensureNet(ctx, netName).portIds.add(port.sourcePortId)

    // Footprint extents: the pad outline, without rotating it (the component
    // box is only used for the KiCad footprint bounding box).
    const halfWidth = (padLayer.shape === 'RF' || padLayer.shape === 'OF' ? padLayer.length : padLayer.size) / 2
    const halfHeight = padLayer.size / 2
    localPoints.push(
      { x: localCenter.x - halfWidth, y: localCenter.y - halfHeight },
      { x: localCenter.x + halfWidth, y: localCenter.y + halfHeight },
    )

    // Drilled pads: plated ones become a through-hole pad, non-plated ones a
    // plain hole plus the copper that is still on the component side.
    if (padLayer.drill > 0 && padLayer.plated) {
      ctx.elements.push({
        type: 'pcb_plated_hole',
        pcb_plated_hole_id: ctx.id('pcb_plated_hole', `${placement.reference}_${terminal.pinNumber}`),
        pcb_component_id: component.pcbComponentId,
        pcb_port_id: port.pcbPortId,
        port_hints: [String(terminal.pinNumber)],
        x: center.x,
        y: center.y,
        layers: ['top', 'bottom'],
        ...(padLayer.shape === 'S'
          ? {
              shape: 'circular_hole_with_rect_pad',
              rect_pad_width: width,
              rect_pad_height: height,
              rect_ccw_rotation: rotation,
              hole_diameter: padLayer.drill,
            }
          : {
              shape: 'circle',
              outer_diameter: Math.max(width, height),
              hole_diameter: padLayer.drill,
            }),
      })
    } else if (padLayer.drill > 0) {
      ctx.elements.push({
        type: 'pcb_hole',
        pcb_hole_id: ctx.id('pcb_hole', `${placement.reference}_${terminal.pinNumber}`),
        pcb_component_id: component.pcbComponentId,
        hole_shape: 'circle',
        hole_diameter: padLayer.drill,
        x: center.x,
        y: center.y,
      })
    }

    if (padLayer.drill === 0 || !padLayer.plated) {
      ctx.elements.push({
        type: 'pcb_smtpad',
        pcb_smtpad_id: ctx.id('pcb_smtpad', `${placement.reference}_${terminal.pinNumber}`),
        pcb_component_id: component.pcbComponentId,
        pcb_port_id: port.pcbPortId,
        port_hints: [String(terminal.pinNumber)],
        layer: mountedLayer,
        x: center.x,
        y: center.y,
        ...smtPadShape(mountedLayer, padLayer.shape, width, height, rotation, padLayer.cornerRadius),
      })
    }

    ctx.elements.push({
      type: 'pcb_port',
      pcb_port_id: port.pcbPortId,
      source_port_id: port.sourcePortId,
      pcb_component_id: component.pcbComponentId,
      x: center.x,
      y: center.y,
      layers: padLayer.drill > 0 && padLayer.plated ? ['top', 'bottom'] : [mountedLayer],
    })
  }

  const box = localPoints.length ? boundingBox(localPoints) : { center: { x: 0, y: 0 }, width: 0.5, height: 0.5 }
  const center = { x: placement.x, y: placement.y }
  ctx.components.push({ reference: placement.reference, center })
  ctx.elements.push({
    type: 'pcb_component',
    pcb_component_id: component.pcbComponentId,
    source_component_id: component.sourceComponentId,
    center,
    width: box.width,
    height: box.height,
    layer: placement.bottom ? 'bottom' : 'top',
    rotation: placement.rotation,
    position_mode: 'none',
    obstructs_within_bounds: false,
  })
}

// Decal graphics: silkscreen outlines and text, plus any copper the footprint
// carries on its own layers. Assembly/mask/paste graphics have no Circuit JSON
// equivalent in this pipeline and are dropped.
function addPlacedPartGraphics(placement, decal, ctx) {
  const side = placement.bottom ? 'bottom' : 'top'
  const pcbComponentId = ctx.componentIds.get(placement.reference)?.pcbComponentId
  for (const piece of decal.pieces) {
    if (SILK_LAYERS.has(piece.layer)) {
      const points = piece.points.map((point) => transformDecalPoint(point, placement))
      if (points.length < 2) continue
      if (CIRCLE_PIECE_KINDS.has(piece.kind)) {
        const [first, second] = points
        ctx.elements.push({
          type: 'pcb_silkscreen_circle',
          pcb_silkscreen_circle_id: ctx.id(
            'pcb_silkscreen_circle',
            `${placement.reference}_${first.x}_${first.y}`,
          ),
          pcb_component_id: pcbComponentId,
          layer: side,
          center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
          radius: Math.hypot(second.x - first.x, second.y - first.y) / 2,
          stroke_width: piece.width || DEFAULT_LINE_WIDTH,
        })
        continue
      }
      ctx.elements.push({
        type: 'pcb_silkscreen_path',
        pcb_silkscreen_path_id: ctx.id(
          'pcb_silkscreen_path',
          `${placement.reference}_${piece.kind}_${points[0].x}_${points[0].y}`,
        ),
        pcb_component_id: pcbComponentId,
        layer: side,
        stroke_width: piece.width || DEFAULT_LINE_WIDTH,
        route: CLOSED_PIECE_KINDS.has(piece.kind) ? [...points, points[0]] : points,
      })
      continue
    }
    if (!COPPER_PIECE_KINDS.has(piece.kind) || NEGATIVE_PIECE_KINDS.has(piece.kind)) continue
    if (piece.points.length < 3) continue
    const layer = copperLayerFor(flipDecalLevel(piece.layer, ctx.layerCount, placement.bottom), ctx.layerCount)
    if (!layer) continue
    ctx.elements.push({
      type: 'pcb_copper_pour',
      pcb_copper_pour_id: ctx.id(
        'pcb_copper_pour',
        `${placement.reference}_${piece.kind}_${piece.points[0].x}_${piece.points[0].y}`,
      ),
      layer,
      shape: 'polygon',
      points: piece.points.map((point) => transformDecalPoint(point, placement)),
    })
  }

  for (const text of decal.texts) {
    if (!text.content || !SILK_LAYERS.has(text.layer)) continue
    ctx.elements.push({
      type: 'pcb_silkscreen_text',
      pcb_silkscreen_text_id: ctx.id(
        'pcb_silkscreen_text',
        `${placement.reference}_${text.content}_${text.x}_${text.y}`,
      ),
      pcb_component_id: pcbComponentId,
      text: text.content,
      font: 'tscircuit2024',
      font_size: text.height,
      anchor_position: transformDecalPoint({ x: text.x, y: text.y }, placement),
      anchor_alignment: 'bottom_left',
      ccw_rotation: normalizeRotation(placement.rotation + text.rotation),
      layer: placement.bottom ? 'bottom' : 'top',
      is_mirrored: placement.bottom,
    })
  }
}

function addRoutes(routes, viaDefinitions, ctx, warnings) {
  const previousByLayer = new Map()
  let unrouted = 0
  let missingVias = 0

  for (const entry of routes) {
    if (entry.kind === 'break') {
      previousByLayer.clear()
      continue
    }
    const net = ensureNet(ctx, entry.net)
    if (entry.kind === 'point') {
      // Layer 0 is an unrouted connection and layers above layerCount are
      // non-copper, so neither is fabrication geometry.
      const layer = copperLayerFor(entry.layer, ctx.layerCount)
      if (entry.layer === 0 || !layer) {
        unrouted += 1
        previousByLayer.delete(entry.layer)
        continue
      }
      const previous = previousByLayer.get(entry.layer)
      if (previous) {
        ctx.elements.push({
          type: 'pcb_trace',
          pcb_trace_id: ctx.id(
            'pcb_trace',
            `${entry.net}_${entry.layer}_${previous.x}_${previous.y}_${entry.x}_${entry.y}`,
          ),
          source_trace_id: net.sourceTraceId,
          route: [
            { route_type: 'wire', x: previous.x, y: previous.y, width: previous.width, layer },
            { route_type: 'wire', x: entry.x, y: entry.y, width: entry.width, layer },
          ],
        })
      }
      previousByLayer.set(entry.layer, entry)
      continue
    }

    previousByLayer.clear()
    const definition = viaDefinitions.get(entry.name)
    if (!definition) {
      missingVias += 1
      continue
    }
    const startLayer = entry.startLayer ?? definition.startLayer ?? 1
    const endLayer = entry.endLayer ?? definition.endLayer ?? ctx.layerCount
    const layers = []
    for (let layer = Math.min(startLayer, endLayer); layer <= Math.max(startLayer, endLayer); layer += 1) {
      const name = copperLayerFor(layer, ctx.layerCount)
      if (name) layers.push(name)
    }
    // Thermal/antipad/annular rows are clearance geometry, not the barrel:
    // taking the largest of every row would turn a 1.0 mm via into a 2.9 mm one.
    const padRadius = definition.layers
      .filter((pad) => !RELIEF_SHAPES.has(pad.shape) && pad.size > 0)
      .reduce((largest, pad) => Math.max(largest, pad.size / 2), 0)
    ctx.elements.push({
      type: 'pcb_via',
      pcb_via_id: ctx.id('pcb_via', `${entry.net}_${entry.x}_${entry.y}`),
      source_net_id: net.sourceNetId,
      x: entry.x,
      y: entry.y,
      outer_diameter: Math.max(padRadius * 2, definition.drill * 1.4),
      hole_diameter: definition.drill,
      layers: layers.length ? layers : ['top', 'bottom'],
    })
  }

  if (unrouted > 0) {
    warnings.push({ level: 'info', message: `${unrouted} 段未布线的连接(层号 0)没有输出为走线。` })
  }
  if (missingVias > 0) {
    warnings.push({ level: 'warn', message: `${missingVias} 个过孔引用的 *VIA* 定义不在文件里,已跳过。` })
  }
}

// Free board text: `<x> <y> <rotation> <layer> <height> <stroke> <N|M>
// <halign> <valign>`, then a font line and the text itself.
function addBoardTexts(parsed, ctx) {
  const lines = parsed.linesOf('TEXT')
  let index = 0
  while (index < lines.length) {
    const tokens = tokenize(lines[index])
    const x = num(tokens[0], NaN)
    const y = num(tokens[1], NaN)
    const rotation = num(tokens[2], NaN)
    const layer = Math.trunc(num(tokens[3], NaN))
    const content = lines[index + 2]?.trim() ?? ''
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(rotation) ||
      !Number.isFinite(layer) ||
      !content ||
      content.startsWith('*')
    ) {
      index += 1
      continue
    }
    index += 3
    if (!SILK_LAYERS.has(layer)) continue
    ctx.elements.push({
      type: 'pcb_silkscreen_text',
      pcb_silkscreen_text_id: ctx.id('pcb_silkscreen_text', `text_${x}_${y}_${content}`),
      text: content,
      font: 'tscircuit2024',
      font_size: Math.abs(num(tokens[4], 0)) * parsed.scale,
      anchor_position: { x: x * parsed.scale, y: y * parsed.scale },
      anchor_alignment: 'bottom_left',
      ccw_rotation: rotation,
      layer: layer === 29 ? 'bottom' : 'top',
      is_mirrored: tokens[6] === 'M',
    })
  }
}

/**
 * Convert a parsed PADS ASCII database into Circuit JSON. `warnings` collects
 * `{ level, message }` entries for everything that had to be simplified.
 */
export function padsToCircuitJson(parsed, warnings = []) {
  const ctx = makeContext(parsed.layerCount)
  const decals = parsePartDecals(parsed, warnings)
  const decalsByType = parsePartTypeDecals(parsed)
  const viaDefinitions = parseViaDefinitions(parsed, warnings)
  const lineObjects = parseLineObjects(parsed)

  // Placements first: net membership only keeps terminals of known references.
  const placements = []
  for (const line of parsed.linesOf('PART')) {
    const tokens = tokenize(line)
    const x = num(tokens[2], NaN)
    const y = num(tokens[3], NaN)
    const rotation = num(tokens[4], NaN)
    if (
      tokens.length < 7 ||
      !tokens[0] ||
      !tokens[1] ||
      Number.isFinite(Number(tokens[0])) ||
      !['G', 'U'].includes(tokens[5]) ||
      !['M', 'N'].includes(tokens[6]) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(rotation)
    ) {
      continue
    }
    const alternateIndex = Math.trunc(num(tokens[7], 0))
    const direct = tokens[1].indexOf('@')
    placements.push({
      reference: tokens[0],
      partType: direct >= 0 ? tokens[1].slice(0, direct) : tokens[1],
      decalName:
        direct >= 0
          ? tokens[1].slice(direct + 1)
          : (decalsByType.get(tokens[1])?.[alternateIndex] ??
            decalsByType.get(tokens[1])?.[0] ??
            tokens[1]),
      x: x * parsed.scale,
      y: y * parsed.scale,
      rotation,
      bottom: tokens[6] === 'M',
    })
  }

  const { netByTerminal, routes } = collectNetsAndRoutes(parsed, placements)

  const boardObject = lineObjects.objects.find(isBoardObject)
  const boardPieces = boardObject?.pieces ?? []
  const outlineRing = boardPieces
    .filter((piece) => !CIRCLE_PIECE_KINDS.has(piece.kind) && piece.points.length >= 3)
    .sort((first, second) => ringArea(second.points) - ringArea(first.points))[0]?.points
  const circlePiece = boardPieces.find((piece) => CIRCLE_PIECE_KINDS.has(piece.kind))
  const outline =
    outlineRing ??
    (circlePiece && circlePiece.points.length >= 2
      ? circleRing(
          {
            x: (circlePiece.points[0].x + circlePiece.points[1].x) / 2,
            y: (circlePiece.points[0].y + circlePiece.points[1].y) / 2,
          },
          Math.hypot(
            circlePiece.points[1].x - circlePiece.points[0].x,
            circlePiece.points[1].y - circlePiece.points[0].y,
          ) / 2,
        )
      : null)

  let missingDecals = 0
  for (const placement of placements) {
    const decal = decals.get(placement.decalName)
    if (!decal) {
      missingDecals += 1
      ensureComponent(ctx, placement.reference, placement.partType)
      ctx.components.push({ reference: placement.reference, center: { x: placement.x, y: placement.y } })
      continue
    }
    addPlacedPart(placement, decal, netByTerminal, ctx)
    addPlacedPartGraphics(placement, decal, ctx)
  }

  addBoard(outline, ctx, warnings)

  for (const piece of boardPieces) {
    if (!outlineRing || piece.points !== outlineRing) {
      if (piece.kind === 'CLOSED' && piece.points.length >= 3) {
        ctx.elements.push({
          type: 'pcb_cutout',
          pcb_cutout_id: ctx.id('pcb_cutout', `cutout_${piece.points.length}_${piece.points[0].x}_${piece.points[0].y}`),
          shape: 'path',
          route: [...piece.points, piece.points[0]],
          slot_width: 0,
        })
      }
    }
  }

  for (const object of lineObjects.objects) {
    if (isBoardObject(object) || !isCopperObject(object) || isKeepoutObject(object)) continue
    for (const piece of object.pieces) {
      if (NEGATIVE_PIECE_KINDS.has(piece.kind) || piece.points.length < 3) continue
      const layer = copperLayerFor(piece.layer, ctx.layerCount)
      if (!layer) continue
      ctx.elements.push({
        type: 'pcb_copper_pour',
        pcb_copper_pour_id: ctx.id(
          'pcb_copper_pour',
          `${object.name}_${piece.points[0].x}_${piece.points[0].y}`,
        ),
        layer,
        shape: 'polygon',
        points: piece.points,
      })
    }
  }

  addRoutes(routes, viaDefinitions, ctx, warnings)
  addBoardTexts(parsed, ctx)

  for (const net of ctx.nets.values()) {
    ctx.elements.push({
      type: 'source_net',
      source_net_id: net.sourceNetId,
      name: net.name,
      member_source_group_ids: [],
    })
    ctx.elements.push({
      type: 'source_trace',
      source_trace_id: net.sourceTraceId,
      connected_source_net_ids: [net.sourceNetId],
      connected_source_port_ids: [...net.portIds],
    })
  }

  if (missingDecals > 0) {
    warnings.push({
      level: 'warn',
      message: `${missingDecals} 个元件引用的封装(PARTDECAL)不在文件里,已跳过:请确认导出时勾选了 Decals。`,
    })
  }
  if (lineObjects.flattenedArcs > 0) {
    warnings.push({ level: 'info', message: `板框里的 ${lineObjects.flattenedArcs} 段圆弧已按折线输出。` })
  }
  if (!ctx.elements.some((element) => element.type === 'pcb_board')) {
    warnings.push({ level: 'warn', message: '文件里没有板框也没有元件,只导出了网表相关内容。' })
  }

  return ctx.elements
}
