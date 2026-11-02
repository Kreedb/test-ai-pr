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
  MAX_PX_PER_MM,
  SCHEMATIC_MM_PER_UNIT,
  SCHEMATIC_TEXT_SIZE,
  buildPreviewModel,
  buildSearchIndex,
  indexComponents,
  indexNets,
  pxPerMm,
  schematicTextSize,
  searchPreview,
  zoomScaleLimits,
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

const altiumProject = () =>
  convertEda([
    {
      name: 'STM32F411.PcbDoc',
      bytes: read('public/samples/altium/stm32-f411-4layer/STM32F411.PcbDoc'),
    },
    {
      name: 'STM32F411.SchDoc',
      bytes: read('public/samples/altium/stm32-f411-4layer/STM32F411.SchDoc'),
    },
  ])

const coreBoardProject = () =>
  convertEda(
    [
      'STM32F405RGT6.PcbDoc',
      '00_connectors_power.SchDoc',
      '01_stm32f4_min_system.SchDoc',
      '02_other.SchDoc',
    ].map((name) => ({
      name,
      bytes: read('public/samples/altium/stm32f405-core', name),
    })),
  )

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

test('complex STM32 samples keep their four-layer stack and sheet hierarchy', async () => {
  // The F411 sample is a real four-layer board: both inner planes have to reach
  // the preview, not just top/bottom.
  const f411 = await altiumProject()
  const f411Model = buildPreviewModel(f411.circuitJson)
  const f411Copper = f411Model.pcb.layers
    .filter((layer) => layer.group === 'copper')
    .map((layer) => layer.id)
  assert.deepEqual(f411Copper, ['top', 'inner1', 'inner2', 'bottom'])
  // Both inner layers carry real copper (the ground/power pours), so the
  // four-layer claim is not just a stack setting on the board.
  for (const layer of ['inner1', 'inner2']) {
    assert.ok(
      f411Model.pcb.items.some((item) => item.layers.includes(layer)),
      `expected copper on ${layer}`,
    )
  }

  // The F405 core board carries three schematic pages, so the output has a root
  // sheet plus one child sheet per source page.
  const core = await coreBoardProject()
  assert.equal(core.summary.schematic.sheets, 3)
  assert.equal(core.files.filter((file) => file.name.endsWith('.kicad_sch')).length, 4)
  const coreModel = buildPreviewModel(core.circuitJson)
  assert.equal(coreModel.schematic.sheets.length, 3)
  assert.deepEqual(
    coreModel.schematic.sheets.map((sheet) => sheet.name).sort(),
    ['00_connectors_power', '01_stm32f4_min_system', '02_other'],
  )
  assert.equal(coreModel.pcb.components.length, core.summary.board.components)
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

  // The writer keeps a text's own `font_size` (EAGLE's 1.778 mm refdes, for
  // example) only on the path where it also keeps standalone graphics; a
  // missing or falsy size always falls back to the KiCad default.
  assert.equal(schematicTextSize({ font_size: 1.778 / 15 }, true), 1.778 / 15)
  assert.equal(schematicTextSize({ font_size: 1.778 / 15 }, false), SCHEMATIC_TEXT_SIZE)
  assert.equal(schematicTextSize({}, true), SCHEMATIC_TEXT_SIZE)
  assert.equal(schematicTextSize({ font_size: 0 }, true), SCHEMATIC_TEXT_SIZE)

  // Only a truly standalone text keeps its size. Component-owned text becomes
  // a symbol property and trace text an inline label; KiCad writes both at the
  // fixed 1.27 mm default even when standalone graphics are preserved.
  const sized = { font_size: 1.778 / 15 }
  assert.equal(schematicTextSize({ ...sized, schematic_component_id: 'c1' }, true), SCHEMATIC_TEXT_SIZE)
  assert.equal(schematicTextSize({ ...sized, source_trace_id: 't1' }, true), SCHEMATIC_TEXT_SIZE)
})

test('schematic zoom is not 15x weaker than the board', () => {
  // The viewport caps zoom in screen pixels per millimetre and converts with
  // `mmPerUnit`. Schematic units are 1/15 mm, so a bare model-units-per-pixel
  // cap stopped the schematic at 4 px/mm while the board reached 60: 1.27 mm
  // text stayed five pixels tall however far the wheel turned.
  assert.equal(SCHEMATIC_MM_PER_UNIT, 15)
  assert.equal(SCHEMATIC_TEXT_SIZE * SCHEMATIC_MM_PER_UNIT, 1.27)

  const board = zoomScaleLimits(1)
  const schematic = zoomScaleLimits(SCHEMATIC_MM_PER_UNIT)

  // Both tabs must reach the same physical magnification at the cap.
  assert.equal(pxPerMm(board.zoomIn, 1), MAX_PX_PER_MM)
  assert.equal(pxPerMm(schematic.zoomIn, SCHEMATIC_MM_PER_UNIT), MAX_PX_PER_MM)

  // At that cap a default 1.27 mm label is 300+ pixels tall, not five.
  const labelPx = 1.27 * MAX_PX_PER_MM
  assert.ok(labelPx > 300, `label would be ${labelPx}px tall`)

  // The old cap was one number in model units, so the schematic (1/15 mm units)
  // topped out at 60/15 = 4 px/mm while the board reached 60 px/mm.
  assert.equal(pxPerMm(1 / 60, 1), 60)
  assert.equal(pxPerMm(1 / 60, SCHEMATIC_MM_PER_UNIT), 4)

  // The cap still has to stop somewhere: a 60x board zoom is now the floor of
  // what the schematic gets, not its ceiling.
  assert.ok(MAX_PX_PER_MM > 60, `cap ${MAX_PX_PER_MM} must exceed the old 60x`)
  assert.ok(pxPerMm(schematic.zoomOut, SCHEMATIC_MM_PER_UNIT) > 0)
})

test('schematic text keeps its size only where the writer keeps it', async () => {
  // `circuit-json-to-kicad` only honours `font_size` while it also keeps
  // standalone graphics (`preserveStandaloneGraphics`). Component-owned texts
  // become KiCad properties, which are always written at 1.27 mm, so the
  // preview must not scale by the raw `font_size` (0.15..0.55 model units).
  const eagle = buildPreviewModel((await eagleProject()).circuitJson)
  for (const text of eagle.schematic.items.filter((item) => item.kind === 'text')) {
    if (text.element.schematic_component_id) {
      assert.equal(text.fontSize, SCHEMATIC_TEXT_SIZE, `EAGLE text ${text.id} kept its size`)
    } else {
      assert.equal(text.fontSize, text.element.font_size, `EAGLE text ${text.id} lost its size`)
    }
  }

  const altium = buildPreviewModel((await altiumProject()).circuitJson)
  const altiumTexts = altium.schematic.items.filter((item) => item.kind === 'text')
  assert.ok(altiumTexts.length > 0)
  for (const text of altiumTexts) {
    if (text.element.schematic_component_id || text.element.source_trace_id) {
      assert.equal(text.fontSize, SCHEMATIC_TEXT_SIZE, `Altium text ${text.id} kept its size`)
    } else {
      assert.equal(text.fontSize, text.element.font_size, `Altium text ${text.id} lost its size`)
    }
  }
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

test('component-owned text is always written at the KiCad property size', async () => {
  // The F411 sample has one component drawn from primitives, which turns on
  // `preserveStandaloneGraphics`. Its designator/value texts would then look
  // like they keep their source size, but the writer emits them as symbol
  // properties at 1.27 mm. Only standalone texts may keep `font_size`.
  const model = buildPreviewModel((await altiumProject()).circuitJson)
  const texts = model.schematic.items.filter((item) => item.kind === 'text')
  assert.ok(texts.length > 0)
  for (const text of texts) {
    if (text.element.schematic_component_id || text.element.source_trace_id) {
      assert.equal(
        text.fontSize,
        SCHEMATIC_TEXT_SIZE,
        `Altium text ${text.id} should use the KiCad property size`,
      )
    }
  }

  const sch = (await altiumProject()).files.find((file) => file.name === 'stm32f411_2.kicad_sch')
  assert.ok(sch, 'expected the child schematic sheet')
  const sizes = new Set([...sch.content.matchAll(/\(size ([\d.]+) ([\d.]+)\)/g)].map((match) => match[1]))
  assert.deepEqual([...sizes], ['1.27'])
})

test('schematic preview draws the value of parts without value texts', async () => {
  // `altium-to-circuit-json` emits designator/value texts for some symbols but
  // not for ordinary resistors, capacitors and inductors; the KiCad writer fills
  // their Value property from the component itself. The preview used to draw
  // only `schematic_text`, so `4k7`, `100n` and inductor part numbers vanished.
  const model = buildPreviewModel((await altiumProject()).circuitJson)
  const sheet = model.schematic.sheets[0]
  const componentTexts = (refdes) => {
    const component = sheet.items.find((item) => item.kind === 'component' && item.refdes === refdes)
    assert.ok(component, `expected ${refdes} on the sheet`)
    return sheet.items
      .filter((item) => item.kind === 'text' && item.componentId === component.id)
      .map((item) => item.element.text)
  }

  assert.ok(componentTexts('R1').includes('1k'), 'resistor value is missing')
  assert.ok(componentTexts('C16').includes('100n'), 'capacitor value is missing')
  assert.ok(componentTexts('R2').includes('4k7'), 'resistor value is missing')

  // An inductor is a generic chip in the converter, so only its display value
  // carries the part number: the preview must still show it.
  const f405 = buildPreviewModel((await coreBoardProject()).circuitJson)
  const connectors = f405.schematic.sheets.find((entry) => entry.name === '00_connectors_power')
  const inductor = connectors.items.find(
    (item) => item.kind === 'component' && item.refdes === 'L1',
  )
  assert.ok(inductor, 'expected L1 on the first sheet')
  assert.ok(
    connectors.items.some(
      (item) =>
        item.kind === 'text' &&
        item.componentId === inductor.id &&
        item.element.text === 'UPZ2012E221',
    ),
    'inductor value is missing',
  )
})

test('Altium parts without value texts still export a filled KiCad Value', async () => {
  // `altium-to-circuit-json` puts the schematic value in `display_value`, while
  // `circuit-json-to-kicad` reads `manufacturer_part_number` for generic chips,
  // diodes and LEDs. Without the bridge the exported Value was empty for every
  // inductor, diode and LED.
  const f411 = (await altiumProject()).files.find((file) => file.name === 'stm32f411_2.kicad_sch')
  assert.ok(f411, 'expected the F411 child schematic')
  for (const [refdes, value] of [
    ['D1', 'GREEN'],
    ['U1', 'ams1117'],
  ]) {
    assert.match(
      f411.content,
      new RegExp(`\\(property "Reference" "${refdes}"[\\s\\S]*?\\(property "Value" "${value}"`),
      `${refdes} lost its value`,
    )
  }

  const f405 = (await coreBoardProject()).files.find(
    (file) => file.name === '00_connectors_power.kicad_sch',
  )
  assert.ok(f405, 'expected the F405 connector sheet')
  assert.match(f405.content, /\(property "Value" "UPZ2012E221"/)
  assert.match(f405.content, /\(property "Value" "SMAJ5.0A"/)
})

test('KiCad power symbols are rewritten to a token KiCad 9 accepts', async () => {
  const result = await coreBoardProject()
  const schematics = result.files.filter((file) => file.name.endsWith('.kicad_sch'))
  assert.ok(schematics.length > 0)
  // `(power global)` makes KiCad 9 drop every symbol and net in the file, so the
  // literal must not survive anywhere.
  for (const file of schematics) {
    assert.ok(!file.content.includes('(power global)'), `${file.name} still has (power global)`)
  }
  // The F405 project has 17 power symbols; each one must still be emitted.
  const powerSymbols = schematics.reduce(
    (total, file) => total + [...file.content.matchAll(/\(power\)/g)].length,
    0,
  )
  assert.equal(powerSymbols, 17)
})
