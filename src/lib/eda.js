// EDA -> KiCad conversion engine.
//
// The actual converters are third-party MIT packages from the tscircuit
// project, so every one of them is loaded lazily: the rest of the app (and the
// first paint of the convert page) must not pay for a ~1 MB bundle.
//
// Pipeline: source document -> Circuit JSON -> KiCad S-expression.
// Format-specific work lives in `./formats/<id>.js`; this file owns the shared
// upload limits, format validation and result envelope.

import { baseNameOf, EdaConversionError, fillSchematicValues, toKicadFiles } from './eda-shared.js'
import { CONVERTIBLE_FORMATS, FORMATS_BY_ID, detectSource, formatLabel } from './formats/index.js'

export { EdaConversionError } from './eda-shared.js'
export { detectSource } from './formats/index.js'
export { normalizeAltiumAscii, hasOversharedTrace } from './formats/altium.js'

const MB = 1024 * 1024

export const MAX_INPUT_BYTES = 40 * MB

// Parsing expands documents many times over (a 1.7 MB PcbDoc becomes 60 MB of
// Circuit JSON), so cap the whole upload as well as each file.
export const MAX_TOTAL_BYTES = 120 * MB

function unsupportedMessage(source, format) {
  const entry = FORMATS_BY_ID[format.id]
  if (entry?.status === 'planned') {
    return new EdaConversionError(`暂不支持 ${source.name}:${formatLabel(format.id)} 尚未接入，本期先集成已有的开源转换器。`, entry.note)
  }
  const supported = CONVERTIBLE_FORMATS.map((id) => FORMATS_BY_ID[id].label).join('、')
  return new EdaConversionError(`无法识别 ${source.name}。当前支持 ${supported}。`)
}

/**
 * Convert the uploaded documents. `sources` is `[{ name, bytes }]` where
 * `bytes` is a Uint8Array. Resolves to `{ files, summary, warnings, elapsedMs }`.
 */
export async function convertEda(sources) {
  if (!sources.length) {
    throw new EdaConversionError('请先选择要转换的文件。')
  }

  const prepared = sources.map((source) => {
    if (source.bytes.byteLength > MAX_INPUT_BYTES) {
      throw new EdaConversionError(`${source.name} 超过 ${MAX_INPUT_BYTES / MB} MiB，浏览器内转换会卡死，请先删掉不需要的图层或拆分工程。`)
    }
    return { ...source, format: detectSource(source.name, source.bytes) }
  })

  const totalBytes = prepared.reduce((sum, source) => sum + source.bytes.byteLength, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new EdaConversionError(`本次上传合计 ${Math.round(totalBytes / MB)} MiB，超过 ${MAX_TOTAL_BYTES / MB} MiB 上限，请分批转换。`)
  }

  const formats = new Set(prepared.map((source) => source.format.id))
  if (formats.has('unknown')) {
    const unknown = prepared.find((source) => source.format.id === 'unknown')
    throw unsupportedMessage(unknown, unknown.format)
  }
  if (formats.size > 1) {
    throw new EdaConversionError('一次只能转换同一类来源的文件，请把 Altium、Specctra、EAGLE 与 PADS 文件分开上传。')
  }
  const [formatId] = formats
  const format = FORMATS_BY_ID[formatId]
  if (!format || !CONVERTIBLE_FORMATS.includes(formatId)) {
    throw unsupportedMessage(prepared[0], prepared[0].format)
  }

  const started = performance.now()
  const warnings = []
  const { circuitJson, summary } = await format.convert(prepared, warnings)

  if (formatId === 'altium' || formatId === 'eagle') fillSchematicValues(circuitJson)
  const files = await toKicadFiles(circuitJson, summary, baseNameOf(prepared))
  return finish(files, circuitJson, formatId, summary, warnings, started)
}

function finish(files, circuitJson, source, summary, warnings, started) {
  if (!files.length) {
    throw new EdaConversionError('转换器没有产生任何 KiCad 文件，原始文档可能不包含设计内容。')
  }
  if (summary.board && summary.board.tracks === 0 && !warnings.some((warning) => warning.code === 'no-routing')) {
    warnings.push({
      level: 'warn',
      message: '输出里没有走线，只有焊盘和放置信息；如果原设计有布线，请检查来源是否完整。',
    })
  }

  return {
    source,
    files,
    circuitJson,
    summary,
    warnings,
    elapsedMs: Math.round(performance.now() - started),
  }
}
