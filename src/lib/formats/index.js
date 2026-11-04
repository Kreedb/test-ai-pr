// Explicit format registry. Each format owns its metadata, loss notes, content
// detection and converter entry point, so adding one is a new file plus one line
// here. Keep the imports explicit: the regression tests run these modules under
// plain Node ESM, where `import.meta.glob` does not exist.

import { altium } from './altium.js'
import { eagle } from './eagle.js'
import { pads } from './pads.js'
import { specctra } from './specctra.js'
import { allegro, orcad } from './unsupported.js'

export const FORMATS = [altium, specctra, eagle, pads, allegro, orcad]

export const FORMATS_BY_ID = Object.fromEntries(FORMATS.map((format) => [format.id, format]))

// The support matrix in the convert page derives from this list.
export const SOURCE_FORMATS = FORMATS.map(({ id, label, extensions, status, converts, note }) => ({
  id,
  label,
  extensions,
  status,
  converts,
  note,
}))

export const CONVERTIBLE_FORMATS = FORMATS.filter((format) => format.status === 'supported').map((format) => format.id)

export const SAMPLES = FORMATS.flatMap((format) => format.samples || [])

// One group per supported output kind. The page flattens these into table rows.
export const LOSS_GROUPS = FORMATS.flatMap((format) => (format.losses || []).map((group) => ({ ...group, formatId: format.id })))

export function formatLabel(id) {
  return FORMATS_BY_ID[id]?.label || '未知格式'
}

/**
 * Identify a source document from its file name and first bytes. Extension
 * alone is not enough: OrCAD Capture and Specctra both use `.dsn`, `.brd` is
 * EAGLE XML in some tools and a Cadence Allegro binary in others, and `.asc` is
 * used by unrelated netlist formats.
 */
export function detectSource(name, bytes) {
  for (const format of FORMATS) {
    const detected = format.detect?.(name, bytes)
    if (detected) return detected
  }
  return { id: 'unknown', kind: 'unknown' }
}
