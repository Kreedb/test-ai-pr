import { EdaConversionError, summarize } from '../eda-shared.js'

// `circuit-json-to-kicad` reads the Value property of a generic chip, diode,
// LED, switch or connector from `manufacturer_part_number`, not from the
// component's display value. `altium-to-circuit-json` keeps the schematic's
// value text in `display_value` and leaves that field unset, so an inductor such
// as `UPZ2012E221` and every diode/LED reached KiCad with an empty Value. Copy
// the display value into the field the writer reads; this is the same text the
// source schematic shows. The writer also derives the library symbol id, the
// footprint name and the PCB `MPN` property from this field, so those now carry
// the schematic value too. That is intentional: the value is the only part
// identity the source provides for these generic types.
const VALUE_FROM_DISPLAY_TYPES = new Set([
  'simple_chip',
  'simple_connector',
  'simple_diode',
  'simple_led',
  'simple_switch',
])

// An Altium field can contain a formula (`='LED-'+Color`) that the converter
// cannot evaluate. Exporting the literal expression is worse than leaving the
// Value empty, so only resolved text is copied.
const isUnresolvedExpression = (value) => String(value).trim().startsWith('=')

export function fillAltiumSchematicValues(circuitJson) {
  for (const element of circuitJson) {
    if (element.type !== 'source_component' || element.manufacturer_part_number) continue
    if (!VALUE_FROM_DISPLAY_TYPES.has(element.ftype)) continue
    if (element.display_value && !isUnresolvedExpression(element.display_value)) {
      element.manufacturer_part_number = element.display_value
    }
  }
  return circuitJson
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

export const altium = {
  id: 'altium',
  label: 'Altium Designer',
  extensions: ['.PcbDoc', '.SchDoc'],
  status: 'supported',
  converts: 'PCB + 原理图',
  note: 'PCB 与原理图都支持,可一次选中同一工程的 .PcbDoc 和多张 .SchDoc 一起转换,网表会在两者之间对齐。',
  samples: [
    {
      label: 'STM32F411 四层板（Altium 项目）',
      files: [
        'samples/altium/stm32-f411-4layer/STM32F411.PcbDoc',
        'samples/altium/stm32-f411-4layer/STM32F411.SchDoc',
      ],
    },
    {
      label: 'STM32F405RGT6 核心板（Altium 项目）',
      files: [
        'samples/altium/stm32f405-core/STM32F405RGT6.PcbDoc',
        'samples/altium/stm32f405-core/00_connectors_power.SchDoc',
        'samples/altium/stm32f405-core/01_stm32f4_min_system.SchDoc',
        'samples/altium/stm32f405-core/02_other.SchDoc',
      ],
    },
    {
      label: 'Altium 工程压缩包（.zip）',
      files: ['samples/altium/stm32-f411-4layer.zip'],
    },
  ],
  losses: [
    {
      id: 'altiumPcb',
      source: 'Altium PCB',
      target: '.kicad_pcb',
      items: [
        {
          category: '层数上限',
          detail: '最多 10 层铜层；层数更多的板直接转换失败。',
        },
        {
          category: '设计规则',
          detail: '线宽、间距、差分对、规则优先级、网络类、Room、层叠材料不导出。',
        },
        { category: '敷铜', detail: '以 zone 输出，填充算法与优先级重算，需在 KiCad 重新灌注。' },
        {
          category: '封装与库',
          detail: '按焊盘几何重建，不引用封装库；库名、封装名、BOM 字段丢失。',
        },
        { category: '3D 模型', detail: 'STEP 与嵌入式模型不写入，需手动重新指定。' },
        { category: '文字与丝印', detail: '换成 KiCad 字体，字号、对齐、旋转有细微偏差。' },
        {
          category: '其他标注',
          detail: '尺寸标注、钻孔表、Gerber/装配输出设置、板级变体不导出。',
        },
      ],
    },
    {
      id: 'altiumSch',
      source: 'Altium 原理图',
      target: '.kicad_sch',
      items: [
        {
          category: '符号图形',
          detail: '重建为通用符号或“方框 + 引脚”，厂商图形、引脚长度与样式被简化。',
        },
        {
          category: '层次结构',
          detail: '输出根图 + 子图；总线、总线入口、图纸符号与端口扁平化为普通标签。',
        },
        { category: '设计数据', detail: 'ERC 标记、掩膜、参数集、设计变体、PCB 注释不导出。' },
        {
          category: '文字与图形',
          detail: '字体、字号、颜色、线宽按近似值输出，注释框和图片可能丢失。',
        },
        {
          category: '封装与库',
          detail: '封装映射只保留名称，符号与封装的绑定需在 KiCad 重新确认。',
        },
      ],
    },
  ],
  detect(name) {
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.pcbdoc')) return { id: 'altium', kind: 'pcb' }
    if (lower.endsWith('.schdoc')) return { id: 'altium', kind: 'schematic' }
    return null
  },
  async convert(sources, warnings) {
    const [{ parseAltiumFile }, altiumConverter] = await Promise.all([
      import('altiumts'),
      import('altium-to-circuit-json'),
    ])

    const documents = { pcb: null, schematics: [] }
    // Prefer the source document name over the converter's generic fallback so
    // a multi-page project shows one readable tab per page instead of repeated
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
        documents.schematics.push({
          document: parsed.document,
          sheetName: sheetNameOf(source.name),
        })
      }
    }

    const convertProject = () =>
      altiumConverter.convertAltiumProjectToCircuitJson({
        ...(documents.pcb ? { pcb: { document: documents.pcb } } : {}),
        schematics: documents.schematics.map(({ document, sheetName }) => ({
          document,
          options: { sheetName },
        })),
      })

    let circuitJson
    if (!documents.pcb && documents.schematics.length === 1) {
      circuitJson = altiumConverter.convertAltiumSchDocToCircuitJson(
        documents.schematics[0].document,
        { sheetName: documents.schematics[0].sheetName },
      )
    } else if (!documents.pcb && documents.schematics.length === 0) {
      throw new EdaConversionError('没有找到可转换的 Altium 文档。')
    } else {
      circuitJson = convertProject()
      if (documents.pcb && documents.schematics.length && hasOversharedTrace(circuitJson)) {
        // Convert the two sides on their own and stack the results. The
        // upstream project converter gives each document its own id prefix so
        // ids across documents stay unique; reproduce those prefixes here or
        // every schematic would emit the same `schematic_sheet_id`.
        circuitJson = [
          ...altiumConverter.convertAltiumPcbDocToCircuitJson(documents.pcb, {
            idPrefix: 'pcb',
          }),
          ...documents.schematics.flatMap(({ document, sheetName }, index) =>
            altiumConverter.convertAltiumSchDocToCircuitJson(document, {
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
  },
}
