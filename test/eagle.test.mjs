// Regression tests for the EAGLE XML -> Circuit JSON -> KiCad path.
// Run with `npm test` (node:test, no extra dependencies).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { convertEda, detectSource } from '../src/lib/eda.js'
import { eagleToCircuitJson, looksLikeEagleXml, parseEagleXml } from '../src/lib/eagle.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const sample = (name) => new Uint8Array(readFileSync(join(root, 'public/samples/eagle', name)))

const kicad = await import('kicadts')

function findBlock(source, start, keyword) {
  const index = source.indexOf(keyword, start)
  if (index < 0) return null
  let depth = 0
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') depth += 1
    else if (source[cursor] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(index, cursor + 1)
    }
  }
  return source.slice(index)
}

function footprintFor(pcb, reference) {
  let cursor = 0
  let block = null
  while ((block = findBlock(pcb, cursor, '(footprint')) !== null) {
    if (block.includes(`(property "Reference" "${reference}"`)) return block
    cursor = pcb.indexOf('(footprint', cursor) + 1
    if (cursor <= 0) return null
  }
  return null
}

test('detects EAGLE XML instead of treating .brd as Allegro', () => {
  assert.equal(detectSource('board.brd', sample('SOT23-3.brd')).id, 'eagle')
  assert.equal(detectSource('board.brd', sample('SOT23-3.brd')).kind, 'pcb')
  assert.equal(detectSource('sheet.sch', sample('SOT23-3.sch')).id, 'eagle')
  assert.equal(detectSource('sheet.sch', sample('SOT23-3.sch')).kind, 'schematic')

  const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03])
  assert.equal(detectSource('board.brd', binary).id, 'allegro')
  assert.equal(looksLikeEagleXml('<html></html>'), false)
})

test('converts an EAGLE project into a KiCad project', async () => {
  const result = await convertEda([
    { name: 'SOT23-3.brd', bytes: sample('SOT23-3.brd') },
    { name: 'SOT23-3.sch', bytes: sample('SOT23-3.sch') },
  ])

  assert.equal(result.source, 'eagle')
  assert.deepEqual(result.summary.board, {
    components: 4,
    nets: 4,
    pads: 6,
    tracks: 5,
    vias: 1,
    zones: 0,
  })
  assert.equal(result.summary.schematic?.components, 4)
  assert.equal(result.summary.schematic?.nets, 4)

  const names = result.files.map((file) => file.name)
  assert.ok(names.includes('SOT23-3.kicad_pcb'))
  assert.ok(names.includes('SOT23-3.kicad_sch'))
  assert.ok(names.includes('sheet_1.kicad_sch'))
  assert.ok(names.includes('SOT23-3.kicad_pro'))

  const pcb = result.files.find((file) => file.name.endsWith('.kicad_pcb')).content
  assert.doesNotThrow(() => kicad.parseKicadPcb(pcb))
  for (const file of result.files.filter((entry) => entry.name.endsWith('.kicad_sch'))) {
    assert.doesNotThrow(() => kicad.parseKicadSch(file.content))
  }

  // Every pad that EAGLE assigned to a signal must keep that net.
  for (const [pad, net] of [
    ['1', 'N$1'],
    ['2', 'N$3'],
    ['3', 'N$2'],
  ]) {
    const footprint = footprintFor(pcb, 'U$1')
    const padBlock = findBlock(footprint, footprint.indexOf(`(pad "${pad}"`), `(pad "${pad}"`)
    assert.ok(padBlock?.includes(`"${net}"`), `pad ${pad} should be on ${net}`)
  }
})

test('schematic pin positions match the EAGLE wire endpoints', () => {
  const { schematic } = parseEagleXml(new TextDecoder().decode(sample('SOT23-3.sch')))
  const circuitJson = eagleToCircuitJson({ schematic })
  const ports = circuitJson.filter((element) => element.type === 'schematic_port')

  const toArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  const wireEnds = []
  for (const sheet of toArray(schematic.sheets?.sheet)) {
    for (const net of toArray(sheet.nets?.net)) {
      for (const segment of toArray(net.segment)) {
        for (const wire of toArray(segment.wire)) {
          // Schematic Circuit JSON is in 1/15 mm, EAGLE writes millimetres.
          wireEnds.push(
            { x: Number(wire.x1) / 15, y: Number(wire.y1) / 15 },
            { x: Number(wire.x2) / 15, y: Number(wire.y2) / 15 },
          )
        }
      }
    }
  }

  assert.equal(ports.length, 6)
  for (const port of ports) {
    // Compare against the raw source coordinates rather than the snapped trace
    // edges, so a wrong pin transform cannot hide behind snapToPort().
    const attached = wireEnds.some(
      (point) => Math.hypot(point.x - port.center.x, point.y - port.center.y) < 0.02,
    )
    assert.ok(attached, `pin ${port.pin_number} does not line up with an EAGLE wire endpoint`)
  }
})

test('mirrored elements keep their layer, pad positions and nets', async () => {
  // Minimal EAGLE 7 board: two parts from one package, the second mirrored and
  // rotated 90 degrees, one through-hole pad each and a GND signal between them.
  const boardXml = `<?xml version="1.0" encoding="utf-8"?>
<eagle version="7.3.0"><drawing><board>
<plain>
<wire x1="0" y1="0" x2="20" y2="0" width="0" layer="20"/>
<wire x1="20" y1="0" x2="20" y2="20" width="0" layer="20"/>
<wire x1="20" y1="20" x2="0" y2="20" width="0" layer="20"/>
<wire x1="0" y1="20" x2="0" y2="0" width="0" layer="20"/>
<text x="1" y="1" size="1" layer="48">doc note</text>
</plain>
<libraries><library name="lib"><packages><package name="PKG">
<smd name="1" x="0" y="0" dx="1" dy="0.5" layer="1" roundness="50"/>
<pad name="2" x="2" y="0" drill="0.8" diameter="1.6" shape="square"/>
<wire x1="-1" y1="-1" x2="1" y2="-1" width="0.15" layer="21"/>
</package></packages></library></libraries>
<elements>
<element name="U1" library="lib" package="PKG" value="X" x="5" y="5"/>
<element name="U2" library="lib" package="PKG" value="Y" x="15" y="10" rot="MR90"/>
</elements>
<signals><signal name="GND">
<contactref element="U1" pad="1"/>
<contactref element="U2" pad="2"/>
<wire x1="5" y1="5" x2="10" y2="10" width="0.3" layer="1"/>
<via x="10" y="10" drill="0.6" diameter="1.2" extent="1-16"/>
</signal></signals>
</board></drawing></eagle>`

  const bytes = new Uint8Array(Buffer.from(boardXml))
  const result = await convertEda([{ name: 'mirror.brd', bytes }])
  assert.equal(result.summary.board?.components, 2)
  assert.equal(result.summary.board?.pads, 4)
  assert.equal(result.summary.board?.vias, 1)

  const pcb = result.files[0].content
  assert.doesNotThrow(() => kicad.parseKicadPcb(pcb))
  assert.ok(!pcb.includes('doc note'), 'Document-layer notes must not become silkscreen text')

  const mirrored = footprintFor(pcb, 'U2')
  assert.ok(mirrored?.includes('(layer B.Cu)'), 'mirrored part should land on the bottom layer')

  // EAGLE roundness is a fraction of half the short side: 50% on a 1 x 0.5 mm
  // pad is a 0.125 mm corner radius, i.e. a 0.25 roundrect ratio.
  const top = footprintFor(pcb, 'U1')
  const smd = findBlock(top, top.indexOf('(pad "1"'), '(pad "1"')
  assert.ok(smd?.includes('roundrect_rratio 0.25'), `unexpected roundness: ${smd}`)

  // EAGLE rotates counter-clockwise and then mirrors, so U2 at (15, 10) with
  // rot="MR90" puts its through-hole pad (local 2,0) 2 mm above the part.
  // Rebuild the absolute offset the way KiCad renders footprint-local pads.
  const tht = findBlock(mirrored, mirrored.indexOf('(pad "2"'), '(pad "2"')
  assert.ok(tht?.includes('"GND"'), 'through-hole pad should keep the GND net')
  const footprintAt = /^\(footprint[\s\S]*?\(at ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)\)/.exec(mirrored)
  const padAt = /\(at ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)\)/.exec(tht)
  assert.ok(footprintAt && padAt, 'footprint and pad should have a position')
  const angle = (Number(footprintAt[3]) * Math.PI) / 180
  const localX = Number(padAt[1])
  const localY = Number(padAt[2])
  const offsetX = localX * Math.cos(angle) + localY * Math.sin(angle)
  const offsetY = -(-localX * Math.sin(angle) + localY * Math.cos(angle))
  assert.ok(Math.abs(offsetX) < 0.01, 'pad 2 x offset should be 0')
  assert.ok(Math.abs(offsetY - 2) < 0.01, 'pad 2 should sit 2 mm above the mirrored part')
  // KiCad stores pad angles as absolute board angles, so the mirrored part's
  // footprint rotation is part of the pad angle.
  assert.equal(
    ((Number(padAt[3]) % 360) + 360) % 360,
    90,
    'pad angle should include the component rotation',
  )
})
