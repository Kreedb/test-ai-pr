// Regression tests for zip archive expansion on the convert page and for the
// Altium ASCII record re-joining that the uploaded `.PcbDoc` exports need.
// Run with `npm test` (node:test, no extra dependencies).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { zipSync } from 'fflate'

import {
  MAX_ARCHIVE_ENTRIES,
  expandArchive,
  isZipArchive,
  looksLikeZip,
} from '../src/lib/archive.js'
import { convertEda, hasOversharedTrace, normalizeAltiumAscii } from '../src/lib/eda.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const sample = (path) => new Uint8Array(readFileSync(join(root, path)))
const encode = (text) => new TextEncoder().encode(text)
const decode = (bytes) => new TextDecoder().decode(bytes)
const namesOf = (files) => files.map((file) => file.name).sort()

const padsAsc = sample('public/samples/pads/res0805.asc')

function archive(entries, options) {
  return zipSync(entries, options)
}

test('zip detection accepts the extension and the header magic', () => {
  const bytes = archive({ 'a.asc': padsAsc })
  assert.equal(isZipArchive('project.zip', bytes), true)
  assert.equal(isZipArchive('project.ZIP', bytes), true)
  // A renamed archive is still an archive: drag and drop ignores `accept`.
  assert.equal(isZipArchive('project.asc', bytes), true)
  assert.equal(looksLikeZip(padsAsc), false)
  assert.equal(isZipArchive('board.asc', padsAsc), false)
  assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b])), false)
})

test('an archive expands to its members with junk files dropped', async () => {
  const bytes = archive({
    'project/board.asc': padsAsc,
    'project/readme.txt': encode('notes'),
    'project/': new Uint8Array(0),
    '__MACOSX/project/._board.asc': encode('junk'),
    'project/.DS_Store': encode('junk'),
  })
  const { files, skipped } = await expandArchive('project.zip', bytes)
  assert.deepEqual(namesOf(files), ['board.asc', 'readme.txt'])
  assert.deepEqual(skipped, [])
  assert.equal(decode(files.find((file) => file.name === 'board.asc').bytes), decode(padsAsc))
})

test('same-named documents in different folders are kept apart', async () => {
  const first = encode('first')
  const second = encode('second')
  const bytes = archive({
    'a/board.asc': first,
    'b/board.asc': second,
  })
  const { files } = await expandArchive('two.zip', bytes)
  assert.equal(files.length, 2)
  // The first occurrence keeps the bare base name; later ones gain the shortest
  // distinctive path so the entry list can key them apart.
  assert.deepEqual(namesOf(files), ['b/board.asc', 'board.asc'])
  assert.equal(decode(files.find((file) => file.name === 'board.asc').bytes), 'first')
  assert.equal(decode(files.find((file) => file.name === 'b/board.asc').bytes), 'second')
})

test('entries over the per-file and total caps are skipped without inflating', async () => {
  const bytes = archive({
    'small.asc': encode('x'.repeat(16)),
    'large.asc': encode('y'.repeat(4096)),
    'other.asc': encode('z'.repeat(32)),
  })
  const { files, skipped } = await expandArchive('caps.zip', bytes, {
    maxFileBytes: 1024,
    maxTotalBytes: 40,
  })
  assert.deepEqual(namesOf(files), ['small.asc'])
  assert.deepEqual(
    skipped.map((entry) => [entry.name, entry.reason]).sort(),
    [
      ['large.asc', 'too-large'],
      ['other.asc', 'total-too-large'],
    ],
  )
})

test('nested archives and unsupported compression are reported, not inflated', async () => {
  const bytes = archive({
    'board.asc': padsAsc,
    'inner.zip': archive({ 'deep.asc': padsAsc }),
  })
  const { files, skipped } = await expandArchive('nested.zip', bytes)
  assert.deepEqual(namesOf(files), ['board.asc'])
  assert.deepEqual(skipped, [{ name: 'inner.zip', reason: 'nested' }])
})

test('the entry cap bounds how many documents one archive can add', async () => {
  const entries = {}
  for (let index = 0; index < MAX_ARCHIVE_ENTRIES + 3; index += 1) {
    entries[`file-${index}.asc`] = encode(`content ${index}`)
  }
  const { files, skipped } = await expandArchive('many.zip', archive(entries), {
    maxEntries: MAX_ARCHIVE_ENTRIES,
  })
  assert.equal(files.length, MAX_ARCHIVE_ENTRIES)
  assert.equal(skipped.length, 3)
  assert.ok(skipped.every((entry) => entry.reason === 'too-many'))
})

test('members spelled with backslashes are still extracted', async () => {
  // Windows-built archives can store `dir\file` in the central directory;
  // fflate keys its result map by that raw name.
  const bytes = archive({
    'project\\board.asc': padsAsc,
    'ok.asc': encode('ok'),
  })
  const { files } = await expandArchive('win.zip', bytes)
  assert.deepEqual(namesOf(files), ['board.asc', 'ok.asc'])
  assert.equal(files.find((file) => file.name === 'ok.asc').bytes.length, 2)
})

test('an archive with nothing usable fails with the reason', async () => {
  await assert.rejects(
    () => expandArchive('empty.zip', archive({ 'inner.zip': archive({ 'a.asc': padsAsc }) })),
    /没有可用的文件.*嵌套压缩包/,
  )
  await assert.rejects(
    () => expandArchive('blank.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    /不是有效的 zip 压缩包/,
  )
})

test('a sample archive converts end to end through the archive path', async () => {
  const bytes = sample('public/samples/altium/PA6940-project.zip')
  const { files } = await expandArchive('PA6940-project.zip', bytes, {
    maxFileBytes: 40 * 1024 * 1024,
    maxTotalBytes: 120 * 1024 * 1024,
  })
  assert.deepEqual(namesOf(files), ['M8_Y-adapter.SchDoc', 'PA6940.PcbDoc', 'Project_Information.SchDoc'])
  const outcome = await convertEda(files)
  assert.ok(outcome.summary.board, 'expected a board in the conversion summary')
  assert.ok(outcome.summary.schematic, 'expected a schematic in the conversion summary')
  assert.equal(outcome.files[0].name, 'PA6940.kicad_pcb')
  // The sample project merges cleanly, so the board and schematic keep shared
  // nets and the fallback warning must not fire.
  assert.equal(
    outcome.warnings.some((warning) => warning.message.includes('工程级合并时被串成了同一个网络')),
    false,
  )
})

// An Altium `.PcbDoc` saved as ASCII writes the layer stack across many
// physical lines that all restart with `|RECORD=Board|`. Joining them is what
// gives `altiumts` a single Board record with `LAYER*NAME` fields.
const ASCII_PCB = [
  '|RECORD=Board|UNIQUEID=1|LAYER1NAME=Top Layer|LAYER1NEXT=2|',
  '|RECORD=Board|LAYER2NAME=Mid-Layer 1|LAYER2NEXT=32|',
  '|RECORD=Board|LAYER32NAME=Bottom Layer|LAYER32NEXT=0|',
  '|RECORD=Net|ID=0|NAME=GND|',
  '|RECORD=Board|UNIQUEID=2|LAYER1NAME=Top Layer|',
].join('\r\n')

test('wrapped ASCII Board records are re-joined, real records are not', () => {
  // Binary OLE files keep their bytes untouched.
  const binary = sample('public/samples/altium/PA6940.PcbDoc')
  assert.equal(normalizeAltiumAscii(binary), binary)

  const joined = decode(normalizeAltiumAscii(encode(ASCII_PCB)))
  // The join leaves exactly one separator between the last field of one
  // fragment and the first field of the next.
  assert.equal(
    joined.split('\r\n')[0],
    '|RECORD=Board|UNIQUEID=1|LAYER1NAME=Top Layer|LAYER1NEXT=2|LAYER2NAME=Mid-Layer 1|LAYER2NEXT=32|LAYER32NAME=Bottom Layer|LAYER32NEXT=0|',
  )
  const lines = joined.split('\r\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[1], '|RECORD=Net|ID=0|NAME=GND|')
  // A second record that has its own UNIQUEID starts a new record.
  assert.equal(lines[2], '|RECORD=Board|UNIQUEID=2|LAYER1NAME=Top Layer|')
})

test('an already-normalised ASCII document is returned unchanged', () => {
  const flat = '|RECORD=Board|UNIQUEID=1|LAYER1NAME=Top Layer|LAYER1NEXT=32|\r\n|RECORD=Net|ID=0|\r\n'
  const bytes = encode(flat)
  assert.equal(decode(normalizeAltiumAscii(bytes)), flat)
  // Text that is not an Altium board at all is not rewritten either.
  const other = encode('|HEADER=Protel\r\n|RECORD=1|\r\n')
  assert.equal(normalizeAltiumAscii(other), other)
})

// `circuit-json-to-kicad` aborts with "multiple KiCad nets" on a pad that
// reaches more than one net, which is exactly what the overshared trace does.
// The page falls back to converting each side on its own when it sees one.
test('the overshared project trace is recognised, a healthy project is not', async () => {
  const bytes = sample('public/samples/altium/PA6940-project.zip')
  const { files } = await expandArchive('PA6940-project.zip', bytes)
  const outcome = await convertEda(files)
  assert.equal(hasOversharedTrace(outcome.circuitJson), false)

  const overshared = [
    { type: 'source_net', source_net_id: 'net-a', name: 'GND' },
    { type: 'source_net', source_net_id: 'net-b', name: 'VCC' },
    {
      type: 'source_trace',
      source_trace_id: 'trace-all',
      connected_source_net_ids: ['net-a', 'net-b'],
      connected_source_port_ids: ['port-1', 'port-2'],
    },
  ]
  assert.equal(hasOversharedTrace(overshared), true)
  // A trace with one net and many ports is normal fan-out, not the bug.
  assert.equal(
    hasOversharedTrace([
      { ...overshared[2], connected_source_net_ids: ['net-a'] },
    ]),
    false,
  )
})
