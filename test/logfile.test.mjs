import assert from 'node:assert/strict'
import test from 'node:test'

import { alignLog, parseLogText } from '../src/lib/replay/logfile.js'

const LOG = [
  '2026-10-20 10:23:52.646 I/robotlogger(mroslaunch)(1509/1509): mros.cpp(459) clk(17.572734277) BUILDTIME: "1"',
  '   continued on the next line',
  '2026-10-20 10:23:52.700 W/mcuagent(mroslaunch)(1511/1511): mros.cpp(462) clk(17.335815652) VERSION: "2"',
  '2026-10-20 10:23:52.600 E/early(mroslaunch)(1/1): main.cpp(1) clk(17.100000000) failed',
].join('\n')

test('parses clk, wall clock and level, keeping continuation lines', () => {
  const { entries, warnings } = parseLogText(LOG)
  assert.equal(entries.length, 3)
  assert.deepEqual(warnings, [])

  const first = entries[0]
  assert.equal(first.clk, 17.572734277)
  assert.equal(first.wall, Date.UTC(2026, 9, 20, 10, 23, 52, 646) / 1000)
  assert.equal(first.level, 'I')
  assert.match(first.text, /continued on the next line/)
  assert.equal(entries[1].level, 'W')
  assert.equal(entries[2].level, 'E')
})

test('aligns clk-based logs with monotonic bag times', () => {
  const { entries } = parseLogText(LOG)
  const aligned = alignLog(entries, 17, 18)
  assert.equal(aligned.basis, 'clk')
  assert.equal(aligned.aligned, true)
  assert.deepEqual(
    aligned.entries.map((entry) => entry.time),
    [17.1, 17.335815652, 17.572734277],
  )
  assert.match(aligned.entries[2].text, /continued on the next line/)
})

test('aligns wall-clock logs with epoch bag times', () => {
  const { entries } = parseLogText(LOG)
  const start = Date.UTC(2026, 9, 20, 10, 23, 0) / 1000
  const aligned = alignLog(entries, start, start + 120)
  assert.equal(aligned.basis, 'wall')
  assert.equal(aligned.aligned, true)
  assert.ok(aligned.entries[0].time >= start)
})

test('reports unaligned logs instead of dropping them', () => {
  const { entries } = parseLogText(LOG)
  const aligned = alignLog(entries, 1e9, 1e9 + 10)
  assert.equal(aligned.aligned, false)
  assert.equal(aligned.entries.length, 3)
})

test('keeps indented continuation lines that mention clk', () => {
  const { entries } = parseLogText(
    [
      '2026-10-20 10:23:52.646 I/robotlogger(1509): mros.cpp(459) clk(17.5) BUILDTIME:',
      '  at Foo::bar() in foo.cpp:12 (cf. clk(0.123) threshold)',
      '2026-10-20 10:23:53.000 I/robotlogger(1509): clk(18) next',
    ].join('\n'),
  )
  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((entry) => entry.clk),
    [17.5, 18],
  )
  assert.match(entries[0].text, /clk\(0\.123\) threshold/)
})

test('reads ROS epoch prefixes and counts orphan lines', () => {
  const { entries, warnings } = parseLogText(
    ['lost line before any timestamp', '[INFO] [1700000000.5]: hello'].join('\n'),
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].wall, 1700000000.5)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /1 行没有时间戳/)
})
