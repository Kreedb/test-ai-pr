// Regression tests for the SII <-> ESI round trip in src/lib/esi.js.
// Node has no DOMParser, so the test installs @xmldom/xmldom before importing
// the generator. The Limx XML/EEPROM pair is the byte-for-byte reference.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DOMParser } from '@xmldom/xmldom'
import { parseSii } from 'sii-parser'

globalThis.DOMParser = DOMParser

const { generateEsiXml, generateSiiFromEsi, verifyEsiXml } = await import('../../src/lib/esi.js')
const { createEditorModel, editorOptions, editorResult } = await import('../../src/lib/editor.js')

const root = fileURLToPath(new URL('../..', import.meta.url))
const sample = (name) => new Uint8Array(readFileSync(join(root, 'public/samples', name)))
const sampleText = (name) => readFileSync(join(root, 'public/samples', name), 'utf8')

test('the Limx ESI compiles to the reference EEPROM image', () => {
  const compiled = generateSiiFromEsi(sampleText('limx-tron2.xml'))
  assert.deepEqual(Array.from(compiled.bytes), Array.from(sample('limx-tron2.bin')))
})

test('the Limx pair round-trips through the editor byte for byte', () => {
  const bytes = sample('limx-tron2.bin')
  const model = createEditorModel(parseSii(bytes))
  const generated = generateEsiXml(editorResult(model, bytes), editorOptions(model, 'Limx'))

  assert.equal(verifyEsiXml(generated.xml, bytes).identical, true)
})

test('a SyncManager enable byte uses bit 0 and keeps it disabled', () => {
  const bytes = sample('limx-tron2.bin')
  const model = createEditorModel(parseSii(bytes))
  assert.equal(model.syncManagers[2].enable & 0x01, 1)
  model.syncManagers[2].enable = 0x02

  const generated = generateEsiXml(editorResult(model, bytes), editorOptions(model, 'Limx'))
  assert.match(generated.xml, /Enable="0"/)
  assert.ok(generated.warnings.some((warning) => /Enable.*0x2/i.test(warning.message)))

  const recompiled = generateSiiFromEsi(generated.xml)
  assert.equal(parseSii(recompiled.bytes).syncManagers[2].enable & 0x01, 0)
})

test('a 256-byte name is rejected instead of being sliced', () => {
  const xml = sampleText('limx-tron2.xml').replace(/<Name LcId="1033">Limx EtherCAT CiA402<\/Name>/, `<Name LcId="1033">${'x'.repeat(256)}</Name>`)
  assert.throws(() => generateSiiFromEsi(xml), /255 字节/)
})

test('the Sync1 cycle factor survives export and import', () => {
  const bytes = sample('limx-tron2.bin')
  for (const factor of [0, 1, 4]) {
    const model = createEditorModel(parseSii(bytes))
    const element = model.dc.elements[0]
    element.sync1CycleFactor = factor
    // Factor 0 and factor 1 both write Factor="1">0; only SYNC1 being enabled
    // distinguishes 1×SYNC0 from the Limx zero.
    element.assignActivate = factor === 0 ? element.assignActivate & ~0x400 : element.assignActivate | 0x400

    const generated = generateEsiXml(editorResult(model, bytes), editorOptions(model, 'Limx'))
    const attribute = factor === 0 ? 1 : factor
    assert.match(generated.xml, new RegExp(`<CycleTimeSync1 Factor="${attribute}">0</CycleTimeSync1>`))

    const recompiled = generateSiiFromEsi(generated.xml)
    assert.equal(parseSii(recompiled.bytes).dc.elements[0].sync1CycleFactor, factor)
  }
})
