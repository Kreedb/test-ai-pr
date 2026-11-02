// Regression tests for the explicit format registry. Adding a format should
// require only a module plus one line in the registry; these checks catch a
// module that forgets metadata, loss notes or a detection branch.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CONVERTIBLE_FORMATS,
  FORMATS,
  FORMATS_BY_ID,
  LOSS_GROUPS,
  SAMPLES,
  SOURCE_FORMATS,
  detectSource,
  formatLabel,
} from '../src/lib/formats/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const ids = FORMATS.map((format) => format.id)

test('the registry has one entry per format with complete metadata', () => {
  assert.equal(new Set(ids).size, ids.length, 'format ids must be unique')
  for (const format of FORMATS) {
    assert.ok(format.label, `${format.id} needs a label`)
    assert.ok(Array.isArray(format.extensions) && format.extensions.length, `${format.id} needs extensions`)
    assert.ok(['supported', 'planned'].includes(format.status), `${format.id} has an unknown status`)
    assert.ok(format.converts, `${format.id} needs a converts summary`)
    assert.ok(format.note, `${format.id} needs a note`)
    assert.equal(FORMATS_BY_ID[format.id], format)
  }
  assert.deepEqual(
    SOURCE_FORMATS.map((format) => format.id),
    ids,
    'the support matrix must be derived from the registry order',
  )
})

test('only supported formats are convertible and every one has losses documented', () => {
  assert.deepEqual(CONVERTIBLE_FORMATS, ['altium', 'specctra', 'eagle', 'pads'])
  for (const id of CONVERTIBLE_FORMATS) {
    assert.ok(
      LOSS_GROUPS.some((group) => group.formatId === id),
      `${id} must document at least one loss group`,
    )
  }
})

test('every sample listed by a format exists on disk', () => {
  assert.ok(SAMPLES.length > 0)
  for (const sample of SAMPLES) {
    for (const path of sample.files) {
      assert.ok(existsSync(join(root, 'public', path)), `${sample.label} is missing ${path}`)
    }
  }
})

test('format ids resolve to labels and unknown files stay unknown', () => {
  assert.equal(formatLabel('eagle'), 'EAGLE XML')
  assert.equal(formatLabel('missing'), '未知格式')
  assert.deepEqual(detectSource('notes.txt', new Uint8Array([1, 2, 3])), {
    id: 'unknown',
    kind: 'unknown',
  })
})
