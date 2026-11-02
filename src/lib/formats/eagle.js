import { EdaConversionError, isEagleXmlText, leadingText, summarize } from '../eda-shared.js'

export const eagle = {
  id: 'eagle',
  label: 'EAGLE XML',
  extensions: ['.brd', '.sch'],
  status: 'supported',
  converts: 'PCB + 原理图',
  note: 'EAGLE 6 及以后版本的 XML 文件;.brd 会按内容区分 EAGLE XML 与 Allegro 二进制。板图和原理图可一起上传,元件按位号对齐。',
  samples: [
    {
      label: 'EAGLE SOT23-3（PCB + 原理图）',
      files: ['samples/eagle/SOT23-3.brd', 'samples/eagle/SOT23-3.sch'],
    },
  ],
  losses: [
    {
      id: 'eaglePcb',
      source: 'EAGLE 板图',
      target: '.kicad_pcb',
      items: [
        {
          category: '板框',
          detail: '只导出 Dimension 层主板框，其余闭合轮廓当作开槽；弧形板框退化为折线。',
        },
        {
          category: '设计规则',
          detail: '规则、网络类、层叠材料、盲埋孔定义不导出；过孔只按 extent 还原起止层。',
        },
        {
          category: '敷铜',
          detail: '以 zone 输出，隔离带与灌注参数重算，需在 KiCad 重新灌注。',
        },
        {
          category: '焊盘',
          detail: '热焊盘/反焊盘与自定义焊盘简化，仅支持方、圆、椭圆；八角焊盘按方形输出。',
        },
        {
          category: '封装与库',
          detail: '元件属性与 3D 数据不导出；封装 Value 为空，原理图符号值保留。',
        },
        {
          category: '文字与丝印',
          detail: '丝印按线条与文字重建，矢量字体替换为 KiCad 字体，弧线按直线近似。',
        },
        {
          category: '其他标注',
          detail: 'Document(48) 等非丝印层说明文字不导出，避免工艺备注印上板。',
        },
      ],
    },
    {
      id: 'eagleSch',
      source: 'EAGLE 原理图',
      target: '.kicad_sch',
      items: [
        {
          category: '符号图形',
          detail: '按库中线条、圆、多边形重建；引脚名称/编号默认隐藏，样式与原图有差异。',
        },
        {
          category: '层次结构',
          detail: '多张图纸输出为独立子图，同名网络按全局标签合并；模块与总线不导出。',
        },
        {
          category: '网络标签',
          detail: '只来自 EAGLE 的 label，自动显示的 N$ 网络名不额外生成标签。',
        },
        {
          category: '文字与图形',
          detail: '图纸边框、标题栏与 plain 图形不导出；矢量字体与 designator 样式不保留。',
        },
        { category: '封装与库', detail: '元件属性不保留。' },
      ],
    },
  ],
  detect(name, bytes) {
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.brd')) {
      return isEagleXmlText(leadingText(bytes)) ? { id: 'eagle', kind: 'pcb' } : null
    }
    if (lower.endsWith('.sch')) {
      return isEagleXmlText(leadingText(bytes))
        ? { id: 'eagle', kind: 'schematic' }
        : { id: 'unknown', kind: 'unknown' }
    }
    return null
  },
  async convert(sources, warnings) {
    const { looksLikeEagleXml, parseEagleXml, eagleToCircuitJson } = await import(
      '../eagle.js'
    )
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let board = null
    let schematic = null

    for (const source of sources) {
      if (source.format.kind !== 'pcb' && source.format.kind !== 'schematic') {
        throw new EdaConversionError(
          `${source.name} 不是 EAGLE 的板图或原理图,请只选择 .brd / .sch。`,
        )
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
        if (board) {
          throw new EdaConversionError(
            '一次只能转换一块板:检测到多个 EAGLE .brd,请分批转换。',
          )
        }
        if (!parsed.board) throw new EdaConversionError(`${source.name} 里没有 <board> 节点。`)
        board = parsed.board
      } else {
        if (schematic) {
          throw new EdaConversionError(
            '一次只能转换一张 EAGLE 原理图工程:检测到多个 .sch,请分批转换。',
          )
        }
        if (!parsed.schematic) {
          throw new EdaConversionError(`${source.name} 里没有 <schematic> 节点。`)
        }
        schematic = parsed.schematic
      }
    }

    const circuitJson = eagleToCircuitJson({ board, schematic }, warnings)
    const summary = summarize(circuitJson)
    if (board && schematic) {
      const elementNames = new Set(
        (board.elements?.element ? [board.elements.element].flat() : []).map(
          (element) => element.name,
        ),
      )
      const partNames = (schematic.parts?.part ? [schematic.parts.part].flat() : []).map(
        (part) => part.name,
      )
      if (
        elementNames.size &&
        partNames.length &&
        !partNames.some((name) => elementNames.has(name))
      ) {
        warnings.push({
          level: 'warn',
          message:
            '板图与原理图的位号没有交集,可能不是同一个工程;封装和符号仍会分别输出,但不会互相关联。',
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
  },
}
