// Regression tests for the standalone `sii-parser` package. The parser is
// exercised directly, without the editor or ESI generator.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { crc8Sii, parseSii } from 'sii-parser'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sample = (name) => new Uint8Array(readFileSync(join(root, 'public/samples', name)))

test('parses the Limx EEPROM image', () => {
  const bytes = sample('limx-tron2.bin')
  const result = parseSii(bytes)

  assert.equal(result.byteLength, 2048)
  assert.equal(result.info.vendorId, 668)
  assert.equal(result.info.productCode, 58920962)
  assert.equal(result.info.revisionNumber, 327691)
  assert.equal(result.info.checksumValid, true)
  assert.equal(crc8Sii(bytes, 14), result.info.checksumComputed)
  assert.deepEqual(result.warnings, [])

  assert.equal(result.strings.length, 28)
  assert.ok(result.general)
  assert.equal(result.fmmus.length, 4)
  assert.equal(result.syncManagers.length, 4)
  assert.equal(result.txPdos.length, 3)
  assert.equal(result.rxPdos.length, 3)
  assert.ok(result.dc)
})

test('parses the AKD EEPROM image and keeps its serial number', () => {
  const result = parseSii(sample('akd-eeprom.bin'))
  assert.equal(result.info.vendorId, 106)
  assert.equal(result.info.serialNumber, 2575499411)
  assert.equal(result.info.checksumValid, true)
  assert.equal(result.txPdos.length, 12)
  assert.equal(result.rxPdos.length, 12)
})

test('malformed images report warnings instead of throwing', () => {
  // A truncated image cannot walk its category chain; the parser must still
  // return the fixed header and explain the problem.
  const result = parseSii(new Uint8Array(0x40))
  assert.ok(result.warnings.some((warning) => warning.message.includes('固定头')))
  assert.equal(result.info.checksumValid, false)

  assert.throws(() => parseSii(new Uint8Array(0)), /没有可解析的数据/)
})
