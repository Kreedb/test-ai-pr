// EDA -> KiCad conversion engine.
//
// The actual converters are third-party MIT packages from the tscircuit
// project, so every one of them is loaded lazily: the rest of the app (and the
// first paint of the convert page) must not pay for a ~1 MB bundle.
//
// Pipeline: source document -> Circuit JSON -> KiCad S-expression.
// `altium-to-circuit-json` reads Altium PcbDoc/SchDoc, `dsn-to-circuit-json`
// reads Specctra DSN (placement/netlist) and SES (routed board), `./eagle.js`
// reads EAGLE XML boards and schematics, and `./pads.js` reads PADS Layout ASCII.

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
    note: 'PCB 与原理图都支持,可一次选中同一工程的 .PcbDoc 和多张 .SchDoc 一起转换,网表会在两者之间对齐。',
  },
  {
    id: 'specctra',
    label: 'Specctra DSN / SES',
    extensions: ['.dsn', '.ses'],
    status: 'supported',
    converts: 'PCB',
    note: 'Allegro、OrCAD PCB Designer、PADS Layout、Xpedition 都能导出 DSN;.ses 是自动布线结果,需与同工程的 .dsn 一起上传。',
  },
  {
    id: 'eagle',
    label: 'EAGLE XML',
    extensions: ['.brd', '.sch'],
    status: 'supported',
    converts: 'PCB + 原理图',
    note: 'EAGLE 6 及以后版本的 XML 文件;.brd 会按内容区分 EAGLE XML 与 Allegro 二进制。板图和原理图可一起上传,元件按位号对齐。',
  },
  {
    id: 'pads',
    label: 'PADS Layout ASCII',
    extensions: ['.asc'],
    status: 'supported',
    converts: 'PCB',
    note: 'PADS Layout 的 File → Export → ASCII 导出文件;二进制 .pcb 与 PADS Logic 原理图不支持。元件、焊盘、走线、过孔、敷铜和丝印会按下面列出的有损项转换。',
  },
  {
    id: 'allegro',
    label: 'Cadence Allegro / OrCAD PCB',
    extensions: ['.brd'],
    status: 'planned',
    converts: 'PCB',
    note: '二进制格式随版本变化且未公开,暂未支持;EAGLE 5 及更早的二进制 .brd 也不支持。Allegro 用 File → Export → Specctra 导出 DSN,或提供 Gerber 再转换。',
  },
  {
    id: 'orcad',
    label: 'OrCAD Capture',
    extensions: ['.dsn', '.edif'],
    status: 'planned',
    converts: '原理图',
    note: 'Capture 的二进制 .dsn 与 Specctra 的文本 .dsn 同名,页面会按内容区分。暂未支持原理图导入,可在 Capture 里导出 EDIF/网表。',
  },
]

// What each supported path is known to lose, one row per lossy category. These
// rows are what the page's loss table shows; keep them in sync with the
// converters' documented coverage. `category` is shared across formats so the
// same kind of loss reads the same way everywhere, and `detail` stays short
// because the table is for scanning, not for exhaustive documentation.
export const LOSS_NOTES = {
  altiumPcb: [
    {
      category: '层数上限',
      detail: '最多 10 层铜层；层数更多的板直接转换失败。',
    },
    { category: '设计规则', detail: '线宽、间距、差分对、规则优先级、网络类、Room、层叠材料不导出。' },
    { category: '敷铜', detail: '以 zone 输出，填充算法与优先级重算，需在 KiCad 重新灌注。' },
    { category: '封装与库', detail: '按焊盘几何重建，不引用封装库；库名、封装名、BOM 字段丢失。' },
    { category: '3D 模型', detail: 'STEP 与嵌入式模型不写入，需手动重新指定。' },
    { category: '文字与丝印', detail: '换成 KiCad 字体，字号、对齐、旋转有细微偏差。' },
    { category: '其他标注', detail: '尺寸标注、钻孔表、Gerber/装配输出设置、板级变体不导出。' },
  ],
  altiumSch: [
    { category: '符号图形', detail: '重建为通用符号或“方框 + 引脚”，厂商图形、引脚长度与样式被简化。' },
    { category: '层次结构', detail: '输出根图 + 子图；总线、总线入口、图纸符号与端口扁平化为普通标签。' },
    { category: '设计数据', detail: 'ERC 标记、掩膜、参数集、设计变体、PCB 注释不导出。' },
    { category: '文字与图形', detail: '字体、字号、颜色、线宽按近似值输出，注释框和图片可能丢失。' },
    { category: '封装与库', detail: '封装映射只保留名称，符号与封装的绑定需在 KiCad 重新确认。' },
  ],
  dsn: [
    { category: '走线', detail: 'DSN 只有布局与网表；走线需另传同一工程的 .ses。' },
    { category: '设计规则', detail: 'rule / clearance 段（默认线宽、间距）不导出，需在 KiCad 重设。' },
    { category: '层与图形', detail: '没有丝印、阻焊/助焊层图形和铜皮。' },
    { category: '焊盘', detail: '只按 DSN 声明的形状与尺寸重建，焊盘叠层与自定义焊盘简化。' },
  ],
  eaglePcb: [
    { category: '板框', detail: '只导出 Dimension 层主板框，其余闭合轮廓当作开槽；弧形板框退化为折线。' },
    { category: '设计规则', detail: '规则、网络类、层叠材料、盲埋孔定义不导出；过孔只按 extent 还原起止层。' },
    { category: '敷铜', detail: '以 zone 输出，隔离带与灌注参数重算，需在 KiCad 重新灌注。' },
    { category: '焊盘', detail: '热焊盘/反焊盘与自定义焊盘简化，仅支持方、圆、椭圆；八角焊盘按方形输出。' },
    { category: '封装与库', detail: '元件属性与 3D 数据不导出；封装 Value 为空，原理图符号值保留。' },
    { category: '文字与丝印', detail: '丝印按线条与文字重建，矢量字体替换为 KiCad 字体，弧线按直线近似。' },
    { category: '其他标注', detail: 'Document(48) 等非丝印层说明文字不导出，避免工艺备注印上板。' },
  ],
  eagleSch: [
    { category: '符号图形', detail: '按库中线条、圆、多边形重建；引脚名称/编号默认隐藏，样式与原图有差异。' },
    { category: '层次结构', detail: '多张图纸输出为独立子图，同名网络按全局标签合并；模块与总线不导出。' },
    { category: '网络标签', detail: '只来自 EAGLE 的 label，自动显示的 N$ 网络名不额外生成标签。' },
    { category: '文字与图形', detail: '图纸边框、标题栏与 plain 图形不导出；矢量字体与 designator 样式不保留。' },
    { category: '封装与库', detail: '元件属性不保留。' },
  ],
  pads: [
    { category: '输入范围', detail: '只读 ASCII .asc；二进制 .pcb 与 PADS Logic 原理图不支持，导出时需勾选全部内容。' },
    { category: '敷铜', detail: '内层铜箔按 net/面积输出为 zone，隔离带、热焊盘参数与灌注结果重算，需重新灌注。' },
    { category: '焊盘', detail: '热焊盘(RT/ST)、反焊盘(RA/SA)、环形焊盘(A)不输出；叠层只取元件面那一层。' },
    { category: '内层', detail: '内层(-1)焊盘与内层走线缺少单层信息，会落到最近铜层或被跳过。' },
    { category: '走线', detail: '只在同层相邻线段间成对连线；弧线走线与圆弧板框断成折线。' },
    { category: '设计数据', detail: '设计规则、网络类、层叠材料、盲埋孔、装配/阻焊/助焊层图形与文本不导出。' },
    { category: '封装与库', detail: '元件属性、3D 模型、封装库名不导出，需在 KiCad 重新关联。' },
    { category: '文字与丝印', detail: '用 KiCad 字体重排，矢量字体、字宽比例与对齐方式有偏差。' },
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

function isPadsAsciiText(text) {
  return /^[!*]PADS-POWERPCB-/i.test(String(text || '').replace(/^﻿/, '').trimStart().slice(0, 512))
}

/**
 * Identify a source document from its file name and first bytes. Extension
 * alone is not enough: OrCAD Capture and Specctra both use `.dsn`, `.brd` is
 * EAGLE XML in some tools and a Cadence Allegro binary in others, and `.asc` is
 * used by unrelated netlist formats.
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
  if (lower.endsWith('.asc')) {
    // Any ASCII text is a plausible `.asc`, so only accept the ones that carry
    // the PADS-POWERPCB banner as a PADS board.
    return isPadsAsciiText(leadingText(bytes))
      ? { id: 'pads', kind: 'pcb' }
      : { id: 'unknown', kind: 'unknown' }
  }
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
      `暂不支持 ${source.name}:${formatLabel(format.id)} 尚未接入,本期先集成已有的开源转换器。`,
      entry.note,
    )
  }
  return new EdaConversionError(
    `无法识别 ${source.name}。支持 Altium .PcbDoc/.SchDoc、Specctra .dsn/.ses、EAGLE XML .brd/.sch 与 PADS ASCII .asc。`,
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

// `circuit-json-to-kicad` reads the Value property of a generic chip, diode,
// LED, switch or connector from `manufacturer_part_number`, not from the
// component's display value. `altium-to-circuit-json` keeps the schematic's
// value text in `display_value` and leaves that field unset, so an inductor such
// as `UPZ2012E221` and every diode/LED reached KiCad with an empty Value. Copy
// the display value into the field the writer reads; this is the same text the
// source schematic shows.
const VALUE_FROM_DISPLAY_TYPES = new Set([
  'simple_chip',
  'simple_connector',
  'simple_diode',
  'simple_led',
  'simple_switch',
])

export function fillAltiumSchematicValues(circuitJson) {
  for (const element of circuitJson) {
    if (element.type !== 'source_component' || element.manufacturer_part_number) continue
    if (!VALUE_FROM_DISPLAY_TYPES.has(element.ftype)) continue
    if (element.display_value) element.manufacturer_part_number = element.display_value
  }
  return circuitJson
}

function toKicadFiles(circuitJson, summary, baseName) {
  return import('circuit-json-to-kicad').then((kicad) => {
    const files = []
    const add = (name, content) => {
      files.push({ name, content, size: new TextEncoder().encode(content).length })
    }

    // `circuit-json-to-kicad` writes power symbols as `(power global)`. KiCad 9's
    // parser only understands bare `(power)` and aborts the whole schematic
    // (0 symbols, 0 nets) on the extra token; `(power global)`/`(power local)`
    // were added in KiCad 10. Bare `(power)` also means a global power symbol in
    // 10, so drop the suffix and keep the symbol. Rewrite the serialized text
    // because the token comes from kicadts, not from a field on the converter.
    const repairSchematicText = (content) =>
      content.replace(/^(\s*)\(power global\)$/gm, '$1(power)')

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
  })
}

function baseNameOf(sources) {
  const preferred =
    sources.find((source) => source.format.kind === 'pcb') || sources[0]
  const stem = String(preferred?.name || '').replace(/\.[^.]+$/, '')
  return stem || 'converted'
}

// Some tools export `.PcbDoc` as the plain `|RECORD=Board|` text instead of the
// OLE compound file. Such exports wrap the Board record - the layer stack alone
// runs to tens of kilobytes - across several physical lines, each of which
// restarts with `|RECORD=Board|` but repeats no field of its own. `altiumts`
// reads each line as a separate record, so the merged board never sees
// `LAYER*NAME` and every copper layer becomes "absent from the board stack".
// Re-join the continuations before parsing; binary compound files are untouched.
const ASCII_PCB_MAGIC = '|RECORD=Board|'

const startsWithAsciiBoard = (bytes) => {
  if (bytes.length < ASCII_PCB_MAGIC.length) return false
  for (let index = 0; index < ASCII_PCB_MAGIC.length; index += 1) {
    if (bytes[index] !== ASCII_PCB_MAGIC.charCodeAt(index)) return false
  }
  return true
}

export function normalizeAltiumAscii(bytes) {
  // Binary OLE compound files make up the bulk of Altium uploads; a 14-byte
  // prefix test keeps them from being decoded into a 2x-size string first.
  if (!startsWithAsciiBoard(bytes)) return bytes

  const lines = decodeLatin1(bytes).split(/\r\n|\r|\n/)
  const merged = []
  let joined = 0
  for (const line of lines) {
    const previous = merged[merged.length - 1]
    // A wrapped fragment repeats only the record banner; a Board record that
    // starts a new one always carries its own UNIQUEID. Drop the repeated
    // banner (and its trailing pipe) so the join leaves one separator.
    if (
      previous?.startsWith(ASCII_PCB_MAGIC) &&
      line.startsWith(ASCII_PCB_MAGIC) &&
      !/\|UNIQUEID=/i.test(line)
    ) {
      merged[merged.length - 1] = previous + line.slice(ASCII_PCB_MAGIC.length)
      joined += 1
      continue
    }
    merged.push(line)
  }
  if (!joined) return bytes
  return encodeLatin1(merged.join('\r\n'))
}

function decodeLatin1(bytes) {
  let text = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return text
}

// Re-encode byte-for-byte so a re-joined document keeps its original encoding.
function encodeLatin1(text) {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff
  }
  return bytes
}

// The project-level merge joins the board's net table with the schematic's net
// graph. On designs whose schematic has the same net under two labels (a local
// label plus a global one) it ends up emitting a single `source_trace` that
// claims every net and every port at once. `circuit-json-to-kicad` refuses to
// pick a net for a pad connected to more than one (`multiple KiCad nets`), so
// the whole board fails to export. Detection is deliberately narrow: one trace,
// several nets, several ports.
export function hasOversharedTrace(circuitJson) {
  return circuitJson.some(
    (element) =>
      element.type === 'source_trace' &&
      (element.connected_source_net_ids?.length ?? 0) > 1 &&
      (element.connected_source_port_ids?.length ?? 0) > 1,
  )
}

async function convertAltium(sources, warnings) {
  const [{ parseAltiumFile }, altium] = await Promise.all([
    import('altiumts'),
    import('altium-to-circuit-json'),
  ])

  const documents = { pcb: null, schematics: [] }
  // Prefer the source document name over the converter's generic fallback so a
  // multi-page project shows one readable tab per page instead of repeated
  // "Altium schematic" labels.
  const sheetNameOf = (name) => String(name || '').split('/').pop().replace(/\.[^.]+$/, '')
  for (const source of sources) {
    const parsed = parseAltiumFile(normalizeAltiumAscii(source.bytes))
    if (source.format.kind === 'pcb') {
      if (documents.pcb) {
        throw new EdaConversionError('一次只能转换一块板:检测到多个 .PcbDoc,请分批转换。')
      }
      documents.pcb = parsed.document
    } else {
      documents.schematics.push({ document: parsed.document, sheetName: sheetNameOf(source.name) })
    }
  }

  const convertProject = () =>
    altium.convertAltiumProjectToCircuitJson({
      ...(documents.pcb ? { pcb: { document: documents.pcb } } : {}),
      schematics: documents.schematics.map(({ document, sheetName }) => ({
        document,
        options: { sheetName },
      })),
    })

  let circuitJson
  if (!documents.pcb && documents.schematics.length === 1) {
    circuitJson = altium.convertAltiumSchDocToCircuitJson(documents.schematics[0].document, {
      sheetName: documents.schematics[0].sheetName,
    })
  } else if (!documents.pcb && documents.schematics.length === 0) {
    throw new EdaConversionError('没有找到可转换的 Altium 文档。')
  } else {
    circuitJson = convertProject()
    if (documents.pcb && documents.schematics.length && hasOversharedTrace(circuitJson)) {
      // Convert the two sides on their own and stack the results. The upstream
      // project converter gives each document its own id prefix so ids across
      // documents stay unique; reproduce those prefixes here or every schematic
      // would emit the same `schematic_sheet_id` and the KiCad writer would
      // produce one duplicated sheet per input document.
      circuitJson = [
        ...altium.convertAltiumPcbDocToCircuitJson(documents.pcb, { idPrefix: 'pcb' }),
        ...documents.schematics.flatMap(({ document, sheetName }, index) =>
          altium.convertAltiumSchDocToCircuitJson(document, {
            idPrefix: `schematic_${index + 1}`,
            sheetName,
          }),
        ),
      ]
      warnings.push({
        level: 'warn',
        message:
          '板图与原理图的网络表在工程级合并时被串成了同一个网络(上游转换器的已知问题),已改为分别转换再合并:两侧的网络名和网络标签保持正确,但 KiCad 里封装与符号不会按位号自动绑定,需要手动关联。',
      })
    }
  }

  const summary = summarize(circuitJson)
  if (documents.schematics.length > 1) {
    warnings.push({
      level: 'info',
      message: `检测到 ${documents.schematics.length} 张原理图,将输出层次化工程(根图 + 每张子图各一个 .kicad_sch)。`,
    })
  }
  if (summary.models > 0) {
    warnings.push({
      level: 'info',
      message: `原始设计含 ${summary.models} 个 3D 模型,.kicad_pcb 不携带模型数据,需要在 KiCad 里重新关联。`,
    })
  }
  if (!summary.hasBoard) {
    warnings.push({
      level: 'info',
      message: '本次只转换了原理图,没有板级数据,因此不生成 .kicad_pcb。',
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
    throw new EdaConversionError('SES 只是自动布线结果,必须同时上传同一工程的 .dsn 才能转换。')
  }
  if (dsnSources.length > 1) {
    warnings.push({
      level: 'warn',
      message: `上传了 ${dsnSources.length} 个 .dsn,只使用了 ${dsn.name}。每块板请单独转换。`,
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
      message: '只提供了 DSN:只有元件位置、焊盘与网表,走线为空。补上同工程的 .ses 可一并转换布线。',
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
      throw new EdaConversionError(`${source.name} 不是 EAGLE 的板图或原理图,请只选择 .brd / .sch。`)
    }
    const text = decoder.decode(source.bytes)
    if (!looksLikeEagleXml(text)) {
      throw new EdaConversionError(`${source.name} 看起来不是 EAGLE XML,无法解析。`)
    }
    const parsed = parseEagleXml(text)
    if (parsed.version && Number(parsed.version.split('.')[0]) < 6) {
      warnings.push({
        level: 'warn',
        message: `${source.name} 的 EAGLE 版本是 ${parsed.version},只保证 EAGLE 6 及以后 XML 的解析结果。`,
      })
    }
    if (source.format.kind === 'pcb') {
      if (board) throw new EdaConversionError('一次只能转换一块板:检测到多个 EAGLE .brd,请分批转换。')
      if (!parsed.board) throw new EdaConversionError(`${source.name} 里没有 <board> 节点。`)
      board = parsed.board
    } else {
      if (schematic) {
        throw new EdaConversionError('一次只能转换一张 EAGLE 原理图工程:检测到多个 .sch,请分批转换。')
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
        message: '板图与原理图的位号没有交集,可能不是同一个工程;封装和符号仍会分别输出,但不会互相关联。',
      })
    }
  }
  if (summary.hasSchematic && !summary.hasBoard) {
    warnings.push({
      level: 'info',
      message:
        '本次只转换了 EAGLE 原理图,没有板级数据,因此不生成 .kicad_pcb;封装只保留名称,需要 PCB 时请把同工程的 .brd 一起上传。',
    })
  }
  return { circuitJson, summary }
}

async function convertPads(sources, warnings) {
  const { looksLikePadsAscii, parsePadsAscii, padsToCircuitJson } = await import('./pads.js')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let parsed = null

  for (const source of sources) {
    if (source.format.kind !== 'pcb') {
      throw new EdaConversionError(`${source.name} 不是 PADS 板级导出文件,请只选择 .asc。`)
    }
    const text = decoder.decode(source.bytes)
    if (!looksLikePadsAscii(text)) {
      throw new EdaConversionError(
        `${source.name} 没有 PADS-POWERPCB 版本头。请用 PADS Layout 的 File → Export → ASCII 重新导出,并确认导出时勾选了所有需要的段落。`,
      )
    }
    if (parsed) {
      throw new EdaConversionError('一次只能转换一块板:检测到多个 PADS .asc,请分批转换。')
    }
    parsed = parsePadsAscii(text)
  }

  const majorVersion = Number(/^V?(\d+)/.exec(parsed.version || '')?.[1])
  if (Number.isFinite(majorVersion) && majorVersion < 9) {
    warnings.push({
      level: 'warn',
      message: `PADS 版本是 ${parsed.version},字段顺序按 V9 及以后校验,请对照板图后再使用。`,
    })
  }
  if (parsed.units === 'BASIC') {
    warnings.push({
      level: 'info',
      message: '文件使用 PADS 内部单位(BASIC),已按 1/38100 mil 换算成毫米。',
    })
  }

  const circuitJson = padsToCircuitJson(parsed, warnings)
  const summary = summarize(circuitJson)
  if (summary.hasBoard && summary.board.tracks === 0) {
    warnings.push({
      level: 'info',
      message: '文件里没有 *ROUTE* 走线段,输出只有元件、焊盘和板框;请在 PADS 里确认已布线并勾选 Routing。',
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
        `${source.name} 超过 ${MAX_INPUT_BYTES / MB} MiB,浏览器内转换会卡死,请先删掉不需要的图层或拆分工程。`,
      )
    }
    return { ...source, format: detectSource(source.name, source.bytes) }
  })

  const totalBytes = prepared.reduce((sum, source) => sum + source.bytes.byteLength, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new EdaConversionError(
      `本次上传合计 ${Math.round(totalBytes / MB)} MiB,超过 ${MAX_TOTAL_BYTES / MB} MiB 上限,请分批转换。`,
    )
  }

  const formats = new Set(prepared.map((source) => source.format.id))
  if (formats.has('unknown')) {
    const unknown = prepared.find((source) => source.format.id === 'unknown')
    throw unsupportedMessage(unknown, unknown.format)
  }
  if (formats.size > 1) {
    throw new EdaConversionError(
      '一次只能转换同一类来源的文件,请把 Altium、Specctra、EAGLE 与 PADS 文件分开上传。',
    )
  }
  const [formatId] = formats
  if (!['altium', 'specctra', 'eagle', 'pads'].includes(formatId)) {
    throw unsupportedMessage(prepared[0], prepared[0].format)
  }

  const started = performance.now()
  const warnings = []
  const { circuitJson, summary } =
    formatId === 'altium'
      ? await convertAltium(prepared, warnings)
      : formatId === 'eagle'
        ? await convertEagle(prepared, warnings)
        : formatId === 'pads'
          ? await convertPads(prepared, warnings)
          : await convertSpecctra(prepared, warnings)

  if (formatId === 'altium') fillAltiumSchematicValues(circuitJson)
  const files = await toKicadFiles(circuitJson, summary, baseNameOf(prepared))
  return finish(files, circuitJson, formatId, summary, warnings, started, prepared)
}

function finish(files, circuitJson, source, summary, warnings, started, prepared) {
  if (!files.length) {
    throw new EdaConversionError('转换器没有产生任何 KiCad 文件,原始文档可能不包含设计内容。')
  }
  if (
    summary.board &&
    summary.board.tracks === 0 &&
    !warnings.some((warning) => warning.code === 'no-routing' || warning.level === 'info')
  ) {
    warnings.push({
      level: 'warn',
      message: '输出里没有走线,只有焊盘和放置信息;如果原设计有布线,请检查来源是否完整。',
    })
  }

  return {
    source,
    files,
    circuitJson,
    summary,
    warnings,
    elapsedMs: Math.round(performance.now() - started),
    sourceNames: prepared.map((source) => source.name),
  }
}
