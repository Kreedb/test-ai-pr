import { EdaConversionError, isEagleXmlText, leadingText, summarize } from '../eda-shared.js'

export const eagle = {
  id: 'eagle',
  label: 'EAGLE XML',
  extensions: ['.brd', '.sch'],
  status: 'supported',
  converts: 'PCB + 原理图',
  note: 'EAGLE 6 及以后版本的 XML 文件；.brd 会按内容区分 EAGLE XML 与 Allegro 二进制。板图和原理图可一起上传，元件按位号对齐。',
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
          detail: '只导出 Dimension 层 wire 组成的主板框，其余闭合轮廓当作开槽；curve 圆弧按直线弦处理。',
          reason: 'addBoardOutline 只读取 wire 端点，不解析 curve 属性；圆弧会静默变成直弦，不会报错或回退到元件外接矩形。',
        },
        {
          category: '设计规则',
          detail: '规则、网络类、层叠材料、盲埋孔定义不导出；过孔只按 extent 还原起止层。',
          reason: 'EAGLE 的 designrules 不进入中间模型，Circuit JSON 也没有网络类与层叠字段；KiCad 规则还要写进 .kicad_pro。',
        },
        {
          category: '敷铜',
          detail: '以 zone 输出，隔离带与灌注参数重算，需在 KiCad 重新灌注。',
          reason: 'polygon 只保留外轮廓，隔离带、热焊盘与灌注结果由 KiCad 按当前规则重新计算。',
        },
        {
          category: '焊盘',
          detail: '热焊盘/反焊盘与自定义焊盘简化，仅支持方、圆、椭圆；八角焊盘按方形输出。',
          reason: 'Circuit JSON 的金属化孔只有圆、矩形与椭圆，EAGLE 的 octagon 只能近似成方形；热焊盘/反焊盘是平面间距，不是铜箔。',
        },
        {
          category: '封装与库',
          detail: '元件的 attribute 与 3D 数据不导出；封装 Value 由元件值回填，封装库/封装名不保留。',
          reason: 'package 的 3D 数据与 element 的 attribute 不解析；封装按焊盘几何重建，Footprint 属性由型号或元件值推导，所以源库名/封装名不保留，Value 由元件值回填。',
        },
        {
          category: '文字与丝印',
          detail: '丝印按直线与文字重建，矢量字体替换为 KiCad 字体，curve 圆弧按直线弦处理。',
          reason: 'EAGLE 的矢量字体没有等价字段；丝印 wire 只按端点画直线，curve 属性不解析，圆弧会变成直弦。',
        },
        {
          category: '其他标注',
          detail: 'Document(48) 等非丝印层说明文字不导出，避免工艺备注印上板。',
          reason: 'Document(48) 等说明层不属于丝印，转换器有意跳过，避免工艺备注印到板上。',
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
          detail: '按库中线条、圆、多边形重建；引脚名不导出，名称与编号默认隐藏，样式与原图有差异。',
          reason: '只按库中的 wire/circle/polygon 重建；EAGLE 的 pin name 没有映射到显示标签，且 KiCad 的非 chip 符号隐藏引脚名与编号。',
        },
        {
          category: '层次结构',
          detail: '多张图纸输出为独立子图，同名网络按全局标签合并；模块不导出。',
          reason: 'EAGLE 没有 KiCad 的层次图纸对象，多张 sheet 只能输出成独立页并用全局标签合并同名网络，module 不导出。',
        },
        {
          category: '网络标签',
          detail: '只来自 EAGLE 的 label，自动显示的 N$ 网络名不额外生成标签。',
          reason: 'EAGLE 的自动网络名 (N$…) 不是 label，转换器只导出显式 label，这些网络在 KiCad 里因此没有标签。',
        },
        {
          category: '文字与图形',
          detail: '图纸边框、标题栏与 plain 图形不导出；矢量字体与 designator 样式不保留。',
          reason: '图纸边框、标题栏和 plain 图形没有进入原理图模型；designator 的字体与旋转样式也没有对应字段。',
        },
        {
          category: '封装与库',
          detail: '元件属性不保留；原理图符号的 Footprint 由元件值推导。',
          reason: 'part/element 的 attribute 不解析，原理图本身也没有封装引用，符号的 Footprint 只能按元件值推导；自定义字段需在 KiCad 重新补。',
        },
      ],
    },
  ],
  detect(name, bytes) {
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.brd')) {
      return isEagleXmlText(leadingText(bytes)) ? { id: 'eagle', kind: 'pcb' } : null
    }
    if (lower.endsWith('.sch')) {
      return isEagleXmlText(leadingText(bytes)) ? { id: 'eagle', kind: 'schematic' } : { id: 'unknown', kind: 'unknown' }
    }
    return null
  },
  async convert(sources, warnings) {
    const { looksLikeEagleXml, parseEagleXml, eagleToCircuitJson } = await import('eagle-to-circuit-json')
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
        if (board) {
          throw new EdaConversionError('一次只能转换一块板：检测到多个 EAGLE .brd，请分批转换。')
        }
        if (!parsed.board) throw new EdaConversionError(`${source.name} 里没有 <board> 节点。`)
        board = parsed.board
      } else {
        if (schematic) {
          throw new EdaConversionError('一次只能转换一张 EAGLE 原理图工程：检测到多个 .sch，请分批转换。')
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
      const elementNames = new Set((board.elements?.element ? [board.elements.element].flat() : []).map((element) => element.name))
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
        message: '本次只转换了 EAGLE 原理图，没有板级数据，因此不生成 .kicad_pcb；封装只保留名称，需要 PCB 时请把同工程的 .brd 一起上传。',
      })
    }
    return { circuitJson, summary }
  },
}
