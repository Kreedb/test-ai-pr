import { EdaConversionError, summarize } from '../eda-shared.js'

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
// claims every net at once. `circuit-json-to-kicad` refuses to pick a net for a
// pad connected to more than one (`multiple KiCad nets`), so the whole board
// fails to export. A healthy trace always belongs to exactly one net, so any
// trace spanning more than one is the malformed merge regardless of how many
// ports it carries.
export function hasOversharedTrace(circuitJson) {
  return circuitJson.some(
    (element) =>
      element.type === 'source_trace' && (element.connected_source_net_ids?.length ?? 0) > 1,
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
          reason:
            'Circuit JSON 只定义 top/bottom/inner1–inner8 十个铜层,超过 10 层的板在中间模型里没有可用的图层名。',
        },
        {
          category: '设计规则',
          detail: '只导出全局最小线宽与过孔尺寸；间距、差分对、规则优先级、网络类、Room、层叠材料不导出。',
          reason:
            'altiumts 会解析规则表,但 altium-to-circuit-json 只把全局 Width 与 RoutingVias 的最小值写进 pcb_board;其余规则、网络类与层叠材料没有进入 Circuit JSON,而且 KiCad 侧还要写进 .kicad_pro/.kicad_dru。',
        },
        {
          category: '敷铜',
          detail: '以 zone 输出，填充算法与优先级重算，需在 KiCad 重新灌注。',
          reason:
            'zone 的填充结果由 KiCad 按当前规则重新计算,源文件里的灌注多边形和优先级不能直接复用。',
        },
        {
          category: '封装与库',
          detail: '按焊盘几何重建，不引用封装库；库名、封装名不保留，BOM 字段只保留型号。',
          reason:
            'altiumts 能读出 footprint 与 footprintLibrary,但 altium-to-circuit-json 没有把它们写进中间模型;写出器只能按焊盘重建封装并保留型号,其他 BOM 字段也没有映射。',
        },
        {
          category: '3D 模型',
          detail: 'STEP 与嵌入式模型不写入，需手动重新指定。',
          reason:
            '模型是独立的 STEP 文件(或 Altium 内嵌压缩流),浏览器转换只产出文本工程,不携带二进制模型资源。',
        },
        {
          category: '文字与丝印',
          detail: '换成 KiCad 字体，字号、对齐、旋转有细微偏差。',
          reason: 'KiCad 只能用内置笔画字体,源字体、字距与对齐没有等价字段。',
        },
        {
          category: '其他标注',
          detail: '尺寸标注、钻孔表、Gerber/装配输出设置、板级变体不导出。',
          reason:
            'Gerber/装配输出与板级变体不在板图数据里;尺寸标注虽有 pcb_fabrication_note_dimension 元素,但 circuit-json-to-kicad 尚未写出它。',
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
          reason:
            '外部 .SchLib 符号库不解析,只有内置映射或方框 + 引脚两种重建方式,厂商图形、引脚长度与样式因此被简化。',
        },
        {
          category: '层次结构',
          detail: '多张 .SchDoc 输出根图 + 子图，但根图没有图纸引脚；图纸符号、端口与总线入口只重画为图形，总线不导出。',
          reason:
            'Circuit JSON 没有总线对象,altium-to-circuit-json 也不产出图纸引脚;图纸符号与端口只按图形和文字重画,所以层间连接只能靠网络名/电源符号合并。',
        },
        {
          category: '设计数据',
          detail: 'ERC 标记、掩膜、参数集、设计变体、PCB 注释不导出。',
          reason: 'ERC 标记、掩膜、参数集与设计变体只存在于 Altium 工程数据库,不进入中间模型。',
        },
        {
          category: '文字与图形',
          detail: '字体、字号、颜色、线宽按近似值输出，注释框和图片可能丢失。',
          reason:
            '字体、颜色与线宽需要 KiCad 的对应字段,转换器只按位置近似重建;注释框和图片没有原理图图形元素。',
        },
        {
          category: '封装与库',
          detail: '封装映射只保留名称，符号与封装的绑定需在 KiCad 重新确认。',
          reason:
            'altiumts 的 Implementation 记录带有封装名,但 altium-to-circuit-json 没有把它写进 source_component;写出器只能按型号或符号名推导 Footprint 属性,无法与源封装库对应。',
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
        // Convert the two sides on their own and stack the results. Each
        // document needs its own id prefix or every schematic would emit the
        // same `schematic_sheet_id`; our own spelling keeps this fallback
        // independent of the upstream project converter's private convention.
        circuitJson = [
          ...altiumConverter.convertAltiumPcbDocToCircuitJson(documents.pcb, {
            idPrefix: 'p1',
          }),
          ...documents.schematics.flatMap(({ document, sheetName }, index) =>
            altiumConverter.convertAltiumSchDocToCircuitJson(document, {
              idPrefix: `s${index + 1}`,
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
