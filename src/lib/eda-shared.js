// Shared pieces of the EDA pipeline. Format modules import this file; it never
// imports a format, so adding one cannot create an import cycle.

export class EdaConversionError extends Error {
  constructor(message, detail = '') {
    super(message)
    this.name = 'EdaConversionError'
    this.detail = detail
  }
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export function isCompoundFile(bytes) {
  return CFB_MAGIC.every((value, index) => bytes[index] === value)
}

export function leadingText(bytes) {
  const sample = bytes.subarray(0, 4096)
  return new TextDecoder('utf-8', { fatal: false }).decode(sample).replace(/^﻿/, '')
}

export function isEagleXmlText(text) {
  const trimmed = String(text || '').replace(/^﻿/, '').trimStart()
  return trimmed.startsWith('<') && /<eagle[\s>]/.test(trimmed)
}

export function isPadsAsciiText(text) {
  return /^[!*]PADS-POWERPCB-/i.test(
    String(text || '').replace(/^﻿/, '').trimStart().slice(0, 512),
  )
}

function countByType(circuitJson, type) {
  let total = 0
  for (const element of circuitJson) if (element.type === type) total += 1
  return total
}

export function summarize(circuitJson) {
  const nets = countByType(circuitJson, 'source_net')
  const pads =
    countByType(circuitJson, 'pcb_smtpad') +
    countByType(circuitJson, 'pcb_plated_hole') +
    countByType(circuitJson, 'pcb_hole')
  const tracks = countByType(circuitJson, 'pcb_trace')
  const vias = countByType(circuitJson, 'pcb_via')
  const zones = countByType(circuitJson, 'pcb_copper_pour')
  const sheets = countByType(circuitJson, 'schematic_sheet')
  const hasBoard = countByType(circuitJson, 'pcb_board') > 0
  const hasSchematic = sheets > 0 || countByType(circuitJson, 'schematic_component') > 0

  return {
    hasBoard,
    hasSchematic,
    // Footprints and symbols are different sets: source components are
    // design-wide and include parts that exist on only one side of the project.
    board: hasBoard
      ? {
          components: countByType(circuitJson, 'pcb_component'),
          nets,
          pads,
          tracks,
          vias,
          zones,
        }
      : null,
    schematic: hasSchematic
      ? {
          sheets: Math.max(sheets, 1),
          components: countByType(circuitJson, 'schematic_component'),
          nets,
        }
      : null,
    models: countByType(circuitJson, 'cad_component'),
  }
}

export function baseNameOf(sources) {
  const preferred = sources.find((source) => source.format.kind === 'pcb') || sources[0]
  const stem = String(preferred?.name || '').replace(/\.[^.]+$/, '')
  return stem || 'converted'
}

export async function toKicadFiles(circuitJson, summary, baseName) {
  const kicad = await import('circuit-json-to-kicad')
  const files = []
  const add = (name, content) => {
    files.push({ name, content, size: new TextEncoder().encode(content).length })
  }

  // `circuit-json-to-kicad` writes power symbols as `(power global)`. KiCad 9's
  // parser only understands bare `(power)` and aborts the whole schematic
  // (0 symbols, 0 nets) on the extra token; `(power global)`/`(power local)`
  // were added in KiCad 10. Bare `(power)` also means a global power symbol in
  // 10, so drop the suffix and keep the symbol.
  const repairSchematicText = (content) =>
    content.replace(/^(\s*)\(power global\)$/gm, '$1(power)')

  // The schematic converter owns the sheet plan (root/sheet UUIDs). Build it
  // first so the project file can reference the same UUIDs.
  let sch = null
  if (summary.hasSchematic) {
    sch = new kicad.CircuitJsonToKicadSchConverter(circuitJson)
    sch.runUntilFinished()
  }

  if (summary.hasBoard) {
    const pcb = new kicad.CircuitJsonToKicadPcbConverter(circuitJson)
    pcb.runUntilFinished()
    add(`${baseName}.kicad_pcb`, pcb.getOutputString())
  }

  if (sch) {
    for (const file of sch.getOutputFiles({ schematicFilename: `${baseName}.kicad_sch` })) {
      add(file.filename, repairSchematicText(file.content))
    }
  }

  if (sch && summary.hasBoard) {
    const pro = new kicad.CircuitJsonToKicadProConverter(circuitJson, {
      projectName: baseName,
      pcbFilename: `${baseName}.kicad_pcb`,
      schematicFilename: `${baseName}.kicad_sch`,
      schematicSheetPlan: sch.schematicSheetPlan,
    })
    pro.runUntilFinished()
    add(`${baseName}.kicad_pro`, pro.getOutputString())
  }

  return files
}
