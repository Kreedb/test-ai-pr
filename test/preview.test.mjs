// Regression tests for the read-only preview model (`src/lib/preview.js`).
// Run with `npm test` (node:test, no extra dependencies).
//
// The preview is what the convert page draws, so the assertions here are about
// the numbers it derives: a pad that is one millimetre off, a net that is
// missing a pin, or a layer that is not offered all show up as a wrong picture
// rather than a crash.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { convertEda } from '../src/lib/eda.js'
import {
  SCHEMATIC_TEXT_SIZE,
  buildPreviewModel,
  buildSearchIndex,
  indexComponents,
  indexNets,
  schematicTextSize,
  searchPreview,
} from '../src/lib/preview.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (...parts) => new Uint8Array(readFileSync(join(root, ...parts)))

const eagleProject = () =>
  convertEda([
    { name: 'SOT23-3.brd', bytes: read('public/samples/eagle/SOT23-3.brd') },
    { name: 'SOT23-3.sch', bytes: read('public/samples/eagle/SOT23-3.sch') },
  ])

const padsProject = () =>
  convertEda([{ name: 'res0805.asc', bytes: read('public/samples/pads/res0805.asc') }])

test('preview model covers both sides of an EAGLE project', async () => {
  const result = await eagleProject()
  const model = buildPreviewModel(result.circuitJson)

  assert.equal(model.hasBoard, true)
  assert.equal(model.hasSchematic, true)
  assert.equal(model.pcb.components.length, result.summary.board.components)
  assert.equal(model.schematic.components.length, result.summary.schematic.components)

  // Every board pad the converter emitted has to be drawn somewhere, on a
  // copper layer that the layer panel offers.
  const copperIds = new Set(
    model.pcb.layers.filter((layer) => layer.group === 'copper').map((layer) => layer.id),
  )
  assert.equal(model.pcb.pads.length, result.summary.board.pads)
  for (const pad of model.pcb.pads) {
    assert.ok(pad.layers.some((layer) => copperIds.has(layer)), `pad ${pad.id} has no copper layer`)
    assert.ok(pad.bounds, `pad ${pad.id} has no drawable bounds`)
  }

  // The board outline drives the initial fit, so it must be the same rectangle
  // the source sample describes (9.83 x 12.69 mm). The union over every item is
  // wider: silkscreen text and designators sit outside the edge cut.
  const board = model.pcb.items.find((item) => item.kind === 'board')
  assert.ok(Math.abs(board.bounds.width - 9.83) < 0.05, `width ${board.bounds.width}`)
  assert.ok(Math.abs(board.bounds.height - 12.69) < 0.05, `height ${board.bounds.height}`)
  assert.deepEqual(model.pcb.boardBounds, board.bounds, 'the fit must frame the outline')
  assert.ok(model.pcb.bounds.width >= board.bounds.width)
})

test('nets join the board and the schematic through the shared port ids', async () => {
  const result = await eagleProject()
  const model = buildPreviewModel(result.circuitJson)
  const nets = indexNets(model)

  // N$4 only carries a via in this sample, so it reaches no pad but must still
  // be listed: the count is the declared nets, not the reachable ones.
  assert.equal(nets.length, result.summary.board.nets)
  assert.ok(nets.some((net) => net.name === 'N$4'))
  for (const net of nets) {
    assert.ok(net.name, 'every net needs a name to be searchable')
  }
  const connected = nets.filter((net) => net.pcbPads.length || net.schematicPins.length)
  assert.ok(connected.length >= 3, `only ${connected.length} nets reach a pad or pin`)

  // SOT23-3.brd routes N$1 with a pad on the board and a pin on the sheet; a
  // net that only resolved on one side would break the cross-probe button.
  const n1 = nets.find((net) => net.name === 'N$1')
  assert.ok(n1, 'expected the N$1 net')
  assert.ok(n1.pcbPads.length >= 2, `N$1 pcb pads: ${n1.pcbPads.length}`)
  assert.ok(n1.schematicPins.length >= 2, `N$1 schematic pins: ${n1.schematicPins.length}`)
  assert.ok(
    n1.pcbPads.every((pad) => pad.refdes && pad.pin !== ''),
    'pads should carry their refdes and pin so the net list is readable',
  )

  // The same reference designator has to appear on both sides for component
  // selection to jump between views.
  const components = indexComponents(model)
  const bothSides = components.filter((component) => component.pcb && component.schematic)
  assert.ok(bothSides.length >= 4, `only ${bothSides.length} parts are on both sides`)
})

test('layer toggles only offer copper layers that carry geometry', async () => {
  const result = await eagleProject()
  const model = buildPreviewModel(result.circuitJson)
  const copper = model.pcb.layers.filter((layer) => layer.group === 'copper').map((layer) => layer.id)

  // EAGLE writes through-hole vias with the full 1-16 extent, but the sample is
  // a two-layer board: offering inner1..16 would be sixteen empty checkboxes.
  assert.deepEqual(copper, ['top', 'bottom'])
  assert.ok(model.pcb.layers.some((layer) => layer.id === 'edge'))
  assert.ok(model.pcb.layers.some((layer) => layer.id === 'silk-top'))

  // Each switchable layer must actually control something.
  for (const layer of model.pcb.layers) {
    const drawn = model.pcb.items.filter((item) => item.layers.includes(layer.id))
    assert.ok(drawn.length > 0, `layer ${layer.id} has nothing drawn on it`)
  }
})

test('PADS boards preview without a schematic and keep silkscreen text', async () => {
  const result = await padsProject()
  const model = buildPreviewModel(result.circuitJson)

  assert.equal(model.hasBoard, true)
  assert.equal(model.hasSchematic, false)
  assert.equal(model.schematic, null)
  assert.ok(model.pcb.items.some((item) => item.kind === 'text' || item.kind === 'graphic'))
  assert.ok(model.pcb.components.length > 0)
  // The board is a few centimetres, not a schematic-sized canvas.
  assert.ok(model.pcb.bounds.width > 1 && model.pcb.bounds.width < 100)
})

test('search ranks exact and prefix matches above substring hits', async () => {
  const result = await eagleProject()
  const model = buildPreviewModel(result.circuitJson)
  const entries = buildSearchIndex(model, indexNets(model))

  const n1 = searchPreview(entries, 'N$1')
  assert.equal(n1[0]?.label, 'N$1', 'an exact net name should come first')

  const u1 = searchPreview(entries, 'u$1')
  assert.equal(u1[0]?.label, 'U$1')
  assert.ok(
    u1.some((entry) => entry.label === 'U$1.1'),
    'pins should be searchable as REF.PIN',
  )

  assert.deepEqual(searchPreview(entries, '   '), [])
  assert.deepEqual(searchPreview(entries, 'no-such-net'), [])
})

test('schematic text uses the size the KiCad writer draws', () => {
  // `circuit-json-to-kicad` scales schematic coordinates by 15 and draws text
  // at 1.27 mm, so text with no size of its own must be 1.27 / 15 model units.
  // The preview used to floor text at 0.25 (symbol text) and 0.4 (net labels),
  // which made labels several times larger than the symbols they annotate.
  assert.ok(Math.abs(SCHEMATIC_TEXT_SIZE * 15 - 1.27) < 1e-9)
  // A size the converter knows (EAGLE's 1.778 mm refdes text) is kept; a
  // missing or falsy one falls back to the KiCad default.
  assert.equal(schematicTextSize({ font_size: 1.778 / 15 }), 1.778 / 15)
  assert.equal(schematicTextSize({}), SCHEMATIC_TEXT_SIZE)
  assert.equal(schematicTextSize({ font_size: 0 }), SCHEMATIC_TEXT_SIZE)
})

test('preview survives a hand-built model with missing optional fields', () => {
  // Converters in the wild omit `schematic_sheet_id`, pad `layer` and the
  // silkscreen layer; the preview must not assume any of them.
  const circuitJson = [
    { type: 'pcb_board', pcb_board_id: 'b', center: { x: 0, y: 0 }, width: 10, height: 5 },
    {
      type: 'pcb_component',
      pcb_component_id: 'c1',
      source_component_id: 's1',
      center: { x: 1, y: 1 },
      width: 2,
      height: 1,
      layer: 'top',
    },
    { type: 'source_component', source_component_id: 's1', name: 'R1' },
    {
      type: 'pcb_smtpad',
      pcb_smtpad_id: 'p1',
      pcb_component_id: 'c1',
      shape: 'rect',
      width: 1,
      height: 0.5,
      x: 0.5,
      y: 1,
    },
    { type: 'pcb_trace', pcb_trace_id: 't1', route: [{ route_type: 'wire', x: 0, y: 0, width: 0.2 }] },
    {
      type: 'schematic_component',
      schematic_component_id: 'sc1',
      source_component_id: 's1',
      center: { x: 10, y: 10 },
      size: { width: 2, height: 2 },
    },
    // A label whose source net never made it into the model: it must still
    // render, but it has no net to index (it used to crash the net sort).
    { type: 'schematic_net_label', schematic_net_label_id: 'l1', text: 'ORPHAN', anchor_position: { x: 0, y: 0 } },
  ]
  const model = buildPreviewModel(circuitJson)

  assert.equal(model.hasBoard, true)
  assert.equal(model.hasSchematic, true)
  // One undeclared sheet is synthesised so the schematic tab can render.
  assert.equal(model.schematic.sheets.length, 1)
  assert.equal(model.schematic.sheets[0].items.filter((item) => item.kind === 'component').length, 1)
  assert.equal(model.pcb.items.find((item) => item.kind === 'pad').refdes, 'R1')
  assert.ok(model.schematic.items.some((item) => item.kind === 'label' && item.text === 'ORPHAN'))
  assert.deepEqual(indexNets(model), [])
})
