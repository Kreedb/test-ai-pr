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

const { generateEsiXml, generateSiiFromEsi, verifyEsiXml } = await import('../src/lib/esi.js')
const { createEditorModel, editorOptions, editorResult } = await import('../src/lib/editor.js')

const root = fileURLToPath(new URL('..', import.meta.url))
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

test('the Sync1 cycle factor survives export and import', () => {
  const bytes = sample('limx-tron2.bin')
  for (const factor of [0, 1, 4]) {
    const model = createEditorModel(parseSii(bytes))
    model.dc.elements[0].sync1CycleFactor = factor

    const generated = generateEsiXml(editorResult(model, bytes), editorOptions(model, 'Limx'))
    const attribute = factor === 0 ? 1 : factor
    const text = factor === 1 ? 1 : 0
    assert.match(
      generated.xml,
      new RegExp(`<CycleTimeSync1 Factor="${attribute}">${text}</CycleTimeSync1>`),
    )

    const recompiled = generateSiiFromEsi(generated.xml)
    assert.equal(parseSii(recompiled.bytes).dc.elements[0].sync1CycleFactor, factor)
  }
})
