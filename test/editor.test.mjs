// Regression tests for the editor table <-> string sync in src/lib/editor.js.
// The parser tests in sii.test.mjs never exercise setName/removeString, which
// is where a shared string index can silently rewrite the wrong field.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseSii } from 'sii-parser'

import {
  createEditorModel,
  removeString,
  setName,
  setStringText,
  unreferencedStrings,
} from '../src/lib/editor.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const sample = (name) => new Uint8Array(readFileSync(join(root, 'public/samples', name)))

test('createEditorModel keeps the string indices the parser read', () => {
  const parsed = parseSii(sample('limx-tron2.bin'))
  const model = createEditorModel(parsed)

  assert.equal(model.general.groupStringIndex, parsed.general.groupStringIndex)
  assert.equal(model.general.imageStringIndex, parsed.general.imageStringIndex)
  assert.equal(model.general.orderStringIndex, parsed.general.orderStringIndex)
  assert.equal(model.general.nameStringIndex, parsed.general.nameStringIndex)

  const pdo = model.txPdos[0]
  assert.equal(pdo.nameIndex, parsed.txPdos[0].nameIndex)
  assert.equal(pdo.entries[0].nameIndex, parsed.txPdos[0].entries[0].nameIndex)
  const element = model.dc.elements[0]
  assert.equal(element.nameIndex, parsed.dc.elements[0].nameIndex)
  assert.equal(element.descIndex, parsed.dc.elements[0].descIndex)
})

test('setting a string text updates only the slots that reference its index', () => {
  const model = createEditorModel(parseSii(sample('limx-tron2.bin')))
  const target = model.strings[0].index
  const before = new Map()
  for (const pdo of [...model.txPdos, ...model.rxPdos]) {
    before.set(pdo, pdo.name)
    for (const entry of pdo.entries) before.set(entry, entry.name)
  }
  const generalBefore = { ...model.general }

  setStringText(model, target, 'CHANGED')

  for (const [owner, name] of before) {
    if (owner.nameIndex === target) assert.equal(owner.name, 'CHANGED')
    else assert.equal(owner.name, name)
  }
  for (const key of ['groupName', 'imageName', 'orderName', 'deviceName']) {
    const indexKey = {
      groupName: 'groupStringIndex',
      imageName: 'imageStringIndex',
      orderName: 'orderStringIndex',
      deviceName: 'nameStringIndex',
    }[key]
    if (model.general[indexKey] === target) assert.equal(model.general[key], 'CHANGED')
    else assert.equal(model.general[key], generalBefore[key])
  }
})

test('renaming a name that shares a deduped string detaches it and leaves the other name', () => {
  // Build a model where a device name and a PDO name point at the same entry.
  const model = createEditorModel(null)
  model.strings = [
    { index: 1, length: 2, text: 'AB', raw: [65, 66] },
    { index: 2, length: 2, text: 'CD', raw: [67, 68] },
  ]
  model.general.nameStringIndex = 1
  model.general.deviceName = 'AB'
  model.txPdos = [{ name: 'AB', nameIndex: 1, entries: [] }]
  model.rxPdos = []

  const pdo = model.txPdos[0]
  setName(model, model.general, 'deviceName', 'nameStringIndex', 'Renamed')

  assert.equal(model.general.deviceName, 'Renamed')
  assert.notEqual(model.general.nameStringIndex, 1)
  // The shared original entry now belongs to the PDO alone and is untouched.
  assert.equal(pdo.nameIndex, 1)
  assert.equal(pdo.name, 'AB')
  assert.equal(model.strings.find((entry) => entry.index === 1).text, 'AB')
})

test('removeString clears only the slot that owns the entry and remaps the rest', () => {
  const model = createEditorModel(null)
  model.strings = [
    { index: 1, length: 2, text: 'AB', raw: [65, 66] },
    { index: 2, length: 2, text: 'CD', raw: [67, 68] },
    { index: 3, length: 2, text: 'EF', raw: [69, 70] },
  ]
  model.general.nameStringIndex = 1
  model.general.deviceName = 'AB'
  model.txPdos = [{ name: 'CD', nameIndex: 2, entries: [{ name: 'EF', nameIndex: 3 }] }]
  model.rxPdos = []

  removeString(model, 1)

  assert.equal(model.general.deviceName, '')
  assert.equal(model.general.nameStringIndex, 0)
  // The surviving entries shift down by one along with every reference.
  assert.equal(model.txPdos[0].nameIndex, 1)
  assert.equal(model.txPdos[0].entries[0].nameIndex, 2)
  assert.deepEqual(
    model.strings.map((entry) => entry.index),
    [1, 2],
  )
  assert.deepEqual(
    unreferencedStrings(model).map((entry) => entry.text),
    [],
  )
})
