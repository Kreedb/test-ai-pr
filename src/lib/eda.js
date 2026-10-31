// EDA -> KiCad conversion engine.
//
// The actual converters are third-party MIT packages from the tscircuit
// project, so every one of them is loaded lazily: the rest of the app (and the
// first paint of the convert page) must not pay for a ~1 MB bundle.
//
// Pipeline: source document -> Circuit JSON -> KiCad S-expression.
// `altium-to-circuit-json` reads Altium PcbDoc/SchDoc, `dsn-to-circuit-json`
// reads Specctra DSN (placement/netlist) and SES (routed board), and
// `./eagle.js` reads EAGLE XML boards and schematics.

const MB = 1024 * 1024

export const MAX_INPUT_BYTES = 40 * MB

// Parsing expands documents many times over (a 1.7 MB PcbDoc becomes 60 MB of
// Circuit JSON), so cap the whole upload as well as each file.
export const MAX_TOTAL_BYTES = 120 * MB

// Formats the page can read today, plus the ones users ask about most often.
// `status: 'planned'` entries are listed in the UI so that the support matrix
// is honest about what is not implemented yet.
export const SOURCE_FORMATS = [
  {
    id: 'altium',
    label: 'Altium Designer',
    extensions: ['.PcbDoc', '.SchDoc'],
    status: 'supported',
    converts: 'PCB + 原理图',
    note: 'PCB 与原理图都支持，可一次选中同一工程的 .PcbDoc 和多张 .SchDoc 一起转换，网表会在两者之间对齐。',
  },
  {
    id: 'specctra',
    label: 'Specctra DSN / SES',
    extensions: ['.dsn', '.ses'],
    status: 'supported',
    converts: 'PCB',
    note: 'Allegro、OrCAD PCB Designer、PADS Layout、Xpedition 都能导出 DSN；.ses 是自动布线结果，需与同工程的 .dsn 一起上传。',
  },
  {
    id: 'eagle',
    label: 'EAGLE XML',
    extensions: ['.brd', '.sch'],
    status: 'supported',
    converts: 'PCB + 原理图',
    note: 'EAGLE 6 及以后版本的 XML 文件；.brd 会按内容区分 EAGLE XML 与 Allegro 二进制。板图和原理图可一起上传，元件按位号对齐。',
  },
  {
    id: 'pads',
    label: 'PADS Layout ASCII',
    extensions: ['.asc'],
    status: 'planned',
    converts: 'PCB',
    note: '暂未支持。PADS Layout 里用 File → Export → DSN 导出 Specctra 文件即可走现有的 DSN 通道。',
  },
  {
    id: 'allegro',
    label: 'Cadence Allegro / OrCAD PCB',
    extensions: ['.brd'],
    status: 'planned',
    converts: 'PCB',
    note: '二进制格式随版本变化且未公开，暂未支持；EAGLE 5 及更早的二进制 .brd 也不支持。Allegro 用 File → Export → Specctra 导出 DSN，或提供 Gerber 再转换。',
  },
  {
    id: 'orcad',
    label: 'OrCAD Capture',
    extensions: ['.dsn', '.edif'],
    status: 'planned',
    converts: '原理图',
    note: 'Capture 的二进制 .dsn 与 Specctra 的文本 .dsn 同名，页面会按内容区分。暂未支持原理图导入，可在 Capture 里导出 EDIF/网表。',
  },
]

// What each supported path is known to lose. These lists are shown verbatim on
// the page; keep them in sync with the converters' documented coverage.
export const LOSS_NOTES = {
  altiumPcb: [
    '只支持最多 10 层铜层（顶层、8 层内层、底层）；层数更多的板会直接转换失败。',
    '3D 模型（STEP/嵌入式模型）不会写入 .kicad_pcb，KiCad 里需要手动重新指定。',
    '设计规则（线宽、间距、差分对、规则优先级）、网络类、Room、层叠材料的设置不导出。',
    '敷铜以 KiCad zone 输出，但填充算法和优先级会重新计算，需要在 KiCad 里重新灌注。',
    '封装按焊盘几何重建，不引用任何 KiCad 封装库；元件库名、封装名、BOM 字段会丢。',
    '丝印/装配层的文字会换成 KiCad 字体，字号、对齐和旋转可能有细微偏差。',
    '尺寸标注、钻孔表、Gerber/装配输出设置、板级变体（variant）配置不导出。',
  ],
  altiumSch: [
    '元件符号重建为通用符号（电阻、电容、二极管等）或“方框 + 引脚”形式，厂商符号的图形、引脚长度和样式会简化。',
    '多张原理图会输出为根图 + 每张子图的层次结构，KiCad 里按同名网络标签保持跨图连接。',
    '总线、总线入口、图纸符号（sheet symbol）与端口会扁平化或转为普通标签。',
    'ERC 标记、掩膜（blanket）、参数集、设计变体、PCB 注释不导出。',
    '文字字体、字号、颜色、线宽按近似值输出，注释框和图片可能丢失。',
    '封装映射只保留名称，符号与封装的绑定需要在 KiCad 里重新确认。',
  ],
  dsn: [
    'DSN 只包含布局（元件位置、焊盘、板框）和网表；走线要另外上传同一工程自动布线后的 .ses。',
    'DSN 里的 rule / clearance 段（默认线宽、间距）不会被导出，需要在 KiCad 里重新设置设计规则。',
    '没有丝印、阻焊/助焊层图形和铜皮。',
    '焊盘只按 DSN 中声明的形状与尺寸重建，焊盘叠层和自定义焊盘会简化。',
  ],
  eaglePcb: [
    '只导出 Dimension 层的主板框，其余闭合轮廓按板内开槽处理；弧形板框会退化成折线。',
    '设计规则、网络类、层叠材料和盲埋孔定义不导出；过孔只按 extent 还原起始/结束层。',
    '铜皮（多边形覆铜）以 KiCad zone 输出，但隔离带和灌注参数会重算，需要在 KiCad 里重新灌注。',
    '焊盘叠层的热焊盘/反焊盘、自定义焊盘（只支持方、圆、椭圆）会简化；八角焊盘按方焊盘输出。',
    '元件属性（manufacturer、MPN、自定义属性）和 3D 封装数据不导出；KiCad 封装的 Value 字段为空，原理图里的符号值仍会保留。',
    'Document（48）等非丝印层的说明文字不导出，避免把工艺备注印到板子上。',
    '丝印按线条和文字重建，EAGLE 矢量字体会被 KiCad 字体替换，弧形导线按直线近似。',
  ],
  eagleSch: [
    '元件符号按 EAGLE 库里的线条、圆和多边形重建；引脚名称/编号默认隐藏，符号样式会与原图有差异。',
    '多张图纸会输出为独立子图，同名网络按全局标签合并；EAGLE 的模块（module）和总线不导出。',
    '网络标签只来自 EAGLE 的 label，自动显示的 N$ 网络名不会额外生成标签。',
    '图纸边框、标题栏和 EAGLE 的 plain 图形不导出。',
    '元件属性、designator 显示样式和 EAGLE 矢量文字字体不保留。',
  ],
}

export class EdaConversionError extends Error {
  constructor(message, detail = '') {
    super(message)
    this.name = 'EdaConversionError'
    this.detail = detail
  }
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function isCompoundFile(bytes) {
  return CFB_MAGIC.every((value, index) => bytes[index] === value)
}

function leadingText(bytes) {
  const sample = bytes.subarray(0, 4096)
  return new TextDecoder('utf-8', { fatal: false }).decode(sample).replace(/^﻿/, '')
}

function isEagleXmlText(text) {
  const trimmed = String(text || '').replace(/^﻿/, '').trimStart()
  return trimmed.startsWith('<') && /<eagle[\s>]/.test(trimmed)
}

/**
 * Identify a source document from its file name and first bytes. Extension
 * alone is not enough: OrCAD Capture and Specctra both use `.dsn`, and `.brd`
 * is EAGLE XML in some tools and a Cadence Allegro binary in others.
 */
export function detectSource(name, bytes) {
  const lower = String(name || '').toLowerCase()

  if (lower.endsWith('.pcbdoc')) return { id: 'altium', kind: 'pcb' }
  if (lower.endsWith('.schdoc')) return { id: 'altium', kind: 'schematic' }

  if (lower.endsWith('.dsn')) {
    if (isCompoundFile(bytes)) return { id: 'orcad', kind: 'schematic' }
    const text = leadingText(bytes).trimStart()
    if (text.startsWith('(pcb')) return { id: 'specctra', kind: 'dsn' }
    return { id: 'orcad', kind: 'schematic' }
  }

  if (lower.endsWith('.ses')) return { id: 'specctra', kind: 'ses' }
  if (lower.endsWith('.asc')) return { id: 'pads', kind: 'pcb' }
  if (lower.endsWith('.brd')) {
    return isEagleXmlText(leadingText(bytes))
      ? { id: 'eagle', kind: 'pcb' }
      : { id: 'allegro', kind: 'pcb' }
  }
  if (lower.endsWith('.sch')) {
    return isEagleXmlText(leadingText(bytes)) ? { id: 'eagle', kind: 'schematic' } : { id: 'unknown', kind: 'unknown' }
  }
  if (lower.endsWith('.edif')) return { id: 'orcad', kind: 'schematic' }

  return { id: 'unknown', kind: 'unknown' }
}

function formatLabel(id) {
  return SOURCE_FORMATS.find((format) => format.id === id)?.label || '未知格式'
}

function unsupportedMessage(source, format) {
  const entry = SOURCE_FORMATS.find((item) => item.id === format.id)
  if (entry?.status === 'planned') {
    return new EdaConversionError(
      `暂不支持 ${source.name}：${formatLabel(format.id)} 尚未接入，本期先集成已有的开源转换器。`,
      entry.note,
    )
  }
  return new EdaConversionError(
    `无法识别 ${source.name}。支持 Altium .PcbDoc/.SchDoc、Specctra .dsn/.ses 与 EAGLE XML .brd/.sch。`,
  )
}

function countByType(circuitJson, type) {
  let total = 0
  for (const element of circuitJson) if (element.type === type) total += 1
  return total
}

function summarize(circuitJson) {
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
    // Footprints on the board and symbols on the sheet are different sets:
    // source components are design-wide and include parts that exist on only
    // one side of the project.
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

function toKicadFiles(circuitJson, summary, baseName) {
  return import('circuit-json-to-kicad').then((kicad) => {
    const files = []
    const add = (name, content) => {
      files.push({ name, content, size: new TextEncoder().encode(content).length })
    }

    // The schematic converter owns the sheet plan (root/sheet UUIDs). Build it
    // first so the project file can reference the same UUIDs, otherwise KiCad
    // drops its cached sheet list.
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
        add(file.filename, file.content)
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
  })
}

function baseNameOf(sources) {
  const preferred =
    sources.find((source) => source.format.kind === 'pcb') || sources[0]
  const stem = String(preferred?.name || '').replace(/\.[^.]+$/, '')
  return stem || 'converted'
}

async function convertAltium(sources, warnings) {
  const [{ parseAltiumFile }, altium] = await Promise.all([
    import('altiumts'),
    import('altium-to-circuit-json'),
  ])

  const documents = { pcb: null, schematics: [] }
  for (const source of sources) {
    const parsed = parseAltiumFile(source.bytes)
    if (source.format.kind === 'pcb') {
      if (documents.pcb) {
        throw new EdaConversionError('一次只能转换一块板：检测到多个 .PcbDoc，请分批转换。')
      }
      documents.pcb = parsed.document
    } else {
      documents.schematics.push(parsed.document)
    }
  }

  let circuitJson
  if (!documents.pcb && documents.schematics.length === 1) {
    circuitJson = altium.convertAltiumSchDocToCircuitJson(documents.schematics[0])
  } else if (!documents.pcb && documents.schematics.length === 0) {
    throw new EdaConversionError('没有找到可转换的 Altium 文档。')
  } else {
    circuitJson = altium.convertAltiumProjectToCircuitJson({
      ...(documents.pcb ? { pcb: { document: documents.pcb } } : {}),
      schematics: documents.schematics.map((document) => ({ document })),
    })
  }

  const summary = summarize(circuitJson)
  if (documents.schematics.length > 1) {
    warnings.push({
      level: 'info',
      message: `检测到 ${documents.schematics.length} 张原理图，将输出层次化工程（根图 + 每张子图各一个 .kicad_sch）。`,
    })
  }
  if (summary.models > 0) {
    warnings.push({
      level: 'info',
      message: `原始设计含 ${summary.models} 个 3D 模型，.kicad_pcb 不携带模型数据，需要在 KiCad 里重新关联。`,
    })
  }
  if (!summary.hasBoard) {
    warnings.push({
      level: 'info',
      message: '本次只转换了原理图，没有板级数据，因此不生成 .kicad_pcb。',
    })
  }

  return { circuitJson, summary }
}

async function convertSpecctra(sources, warnings) {
  const { DsnToCircuitJsonConverter, SesToCircuitJsonConverter } = await import(
    'dsn-to-circuit-json'
  )

  const dsnSources = sources.filter((source) => source.format.kind === 'dsn')
  const dsn = dsnSources[0]
  const ses = sources.find((source) => source.format.kind === 'ses')
  if (!dsn) {
    throw new EdaConversionError('SES 只是自动布线结果，必须同时上传同一工程的 .dsn 才能转换。')
  }
  if (dsnSources.length > 1) {
    warnings.push({
      level: 'warn',
      message: `上传了 ${dsnSources.length} 个 .dsn，只使用了 ${dsn.name}。每块板请单独转换。`,
    })
  }

  const dsnText = new TextDecoder().decode(dsn.bytes)
  let circuitJson
  if (ses) {
    const sesText = new TextDecoder().decode(ses.bytes)
    const converter = new SesToCircuitJsonConverter(sesText, dsnText)
    converter.runUntilFinished()
    circuitJson = converter.getOutput()
  } else {
    const converter = new DsnToCircuitJsonConverter(dsnText)
    converter.runUntilFinished()
    circuitJson = converter.getOutput()
    warnings.push({
      level: 'warn',
      code: 'no-routing',
      message: '只提供了 DSN：只有元件位置、焊盘与网表，走线为空。补上同工程的 .ses 可一并转换布线。',
    })
  }

  return { circuitJson, summary: summarize(circuitJson) }
}

async function convertEagle(sources, warnings) {
  const { looksLikeEagleXml, parseEagleXml, eagleToCircuitJson } = await import('./eagle.js')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let board = null
  let schematic = null

  for (const source of sources) {
    if (source.format.kind !== 'pcb' && source.format.kind !== 'schematic') {
      throw new EdaConversionError(`${source.name} 不是 EAGLE 的板图或原理图，请只选择 .brd / .sch。`)
    }
    const text = decoder.decode(source.bytes)
    if (!looksLikeEagleXml(text)) {
      throw new EdaConversionError(`${source.name} 看起来不是 EAGLE XML，无法解析。`)
    }
    const parsed = parseEagleXml(text)
    if (parsed.version && Number(parsed.version.split('.')[0]) < 6) {
      warnings.push({
        level: 'warn',
        message: `${source.name} 的 EAGLE 版本是 ${parsed.version}，只保证 EAGLE 6 及以后 XML 的解析结果。`,
      })
    }
    if (source.format.kind === 'pcb') {
      if (board) throw new EdaConversionError('一次只能转换一块板：检测到多个 EAGLE .brd，请分批转换。')
      if (!parsed.board) throw new EdaConversionError(`${source.name} 里没有 <board> 节点。`)
      board = parsed.board
    } else {
      if (schematic) {
        throw new EdaConversionError('一次只能转换一张 EAGLE 原理图工程：检测到多个 .sch，请分批转换。')
      }
      if (!parsed.schematic) throw new EdaConversionError(`${source.name} 里没有 <schematic> 节点。`)
      schematic = parsed.schematic
    }
  }

  const circuitJson = eagleToCircuitJson({ board, schematic }, warnings)
  const summary = summarize(circuitJson)
  if (board && schematic) {
    const elementNames = new Set(
      (board.elements?.element ? [board.elements.element].flat() : []).map((element) => element.name),
    )
    const partNames = (schematic.parts?.part ? [schematic.parts.part].flat() : []).map((part) => part.name)
    if (elementNames.size && partNames.length && !partNames.some((name) => elementNames.has(name))) {
      warnings.push({
        level: 'warn',
        message: '板图与原理图的位号没有交集，可能不是同一个工程；封装和符号仍会分别输出，但不会互相关联。',
      })
    }
  }
  if (summary.hasSchematic && !summary.hasBoard) {
    warnings.push({
      level: 'info',
      message:
        '本次只转换了 EAGLE 原理图，没有板级数据，因此不生成 .kicad_pcb；封装只保留名称，需要 PCB 时请把同工程的 .brd 一起上传。',
    })
  }
  return { circuitJson, summary }
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
      throw new EdaConversionError(
        `${source.name} 超过 ${MAX_INPUT_BYTES / MB} MiB，浏览器内转换会卡死，请先删掉不需要的图层或拆分工程。`,
      )
    }
    return { ...source, format: detectSource(source.name, source.bytes) }
  })

  const totalBytes = prepared.reduce((sum, source) => sum + source.bytes.byteLength, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new EdaConversionError(
      `本次上传合计 ${Math.round(totalBytes / MB)} MiB，超过 ${MAX_TOTAL_BYTES / MB} MiB 上限，请分批转换。`,
    )
  }

  const formats = new Set(prepared.map((source) => source.format.id))
  if (formats.has('unknown')) {
    const unknown = prepared.find((source) => source.format.id === 'unknown')
    throw unsupportedMessage(unknown, unknown.format)
  }
  if (formats.size > 1) {
    throw new EdaConversionError(
      '一次只能转换同一类来源的文件，请把 Altium、Specctra 与 EAGLE 文件分开上传。',
    )
  }
  const [formatId] = formats
  if (!['altium', 'specctra', 'eagle'].includes(formatId)) {
    throw unsupportedMessage(prepared[0], prepared[0].format)
  }

  const started = performance.now()
  const warnings = []
  const { circuitJson, summary } =
    formatId === 'altium'
      ? await convertAltium(prepared, warnings)
      : formatId === 'eagle'
        ? await convertEagle(prepared, warnings)
        : await convertSpecctra(prepared, warnings)

  const files = await toKicadFiles(circuitJson, summary, baseNameOf(prepared))

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
    source: formatId,
    files,
    summary,
    warnings,
    elapsedMs: Math.round(performance.now() - started),
    sourceNames: prepared.map((source) => source.name),
  }
}
