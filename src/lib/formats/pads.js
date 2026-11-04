import { EdaConversionError, isPadsAsciiText, leadingText, summarize } from '../eda-shared.js'

export const pads = {
  id: 'pads',
  label: 'PADS Layout ASCII',
  extensions: ['.asc'],
  status: 'supported',
  converts: 'PCB',
  note: 'PADS Layout 的 File → Export → ASCII 导出文件；二进制 .pcb 与 PADS Logic 原理图不支持。元件、焊盘、走线、过孔、敷铜和丝印会按下面列出的有损项转换。',
  samples: [{ label: 'PADS ASCII（0805 + 排针）', files: ['samples/pads/res0805.asc'] }],
  losses: [
    {
      id: 'pads',
      source: 'PADS Layout ASCII',
      target: '.kicad_pcb',
      items: [
        {
          category: '输入范围',
          detail: '只读 ASCII .asc；二进制 .pcb 与 PADS Logic 原理图不支持，导出时需勾选全部内容。',
          reason:
            'PADS 二进制 .pcb 未公开且随版本变化，PADS Logic 原理图是另一种数据库；只有 ASCII 导出包含可解析的板级数据。',
        },
        {
          category: '敷铜',
          detail: '内层铜箔按 net/面积输出为 zone，隔离带、热焊盘参数与灌注结果重算，需重新灌注。',
          reason: 'copper pour 只保留外轮廓，隔离带与热焊盘参数由 KiCad 按当前规则重新计算。',
        },
        {
          category: '焊盘',
          detail: '热焊盘（RT/ST）、反焊盘（RA/SA）、环形焊盘（A）不输出；叠层只取元件面那一层。',
          reason:
            'RT/ST/RA/SA/A 是平面间距或环形层，不是焊盘铜箔；PADS 的逐层焊盘栈在 Circuit JSON 里只有元件面一层外径。',
        },
        {
          category: '内层',
          detail: '内层（-1）焊盘与内层走线缺少单层信息，会落到最近铜层或被跳过。',
          reason: 'PADS 的 -1 层表示“所有内层”，没有具体层号，无法还原成 innerN。',
        },
        {
          category: '走线',
          detail: '只在同层相邻线段间成对连线；弧线走线按直线段输出，圆弧板框按折线近似。',
          reason:
            'route 段只给端点与 CW/CCW 方向，不给圆心与半径；板框圆弧会被展平成 16 段折线。',
        },
        {
          category: '设计数据',
          detail: '设计规则、网络类、层叠材料、盲埋孔、装配/阻焊/助焊层图形与文本不导出。',
          reason:
            'PADS ASCII 的规则、层叠与装配/阻焊/助焊图形不在解析范围，Circuit JSON 也没有对应字段。',
        },
        {
          category: '封装与库',
          detail: '元件属性与 3D 模型不导出；封装名会保留。',
          reason:
            'PARTDECAL 名已写入 Footprint 属性，但元件 attribute 与 3D 模型没有中间字段。',
        },
        {
          category: '文字与丝印',
          detail: '用 KiCad 字体重排，矢量字体、字宽比例与对齐方式有偏差。',
          reason: 'KiCad 笔画字体与原 PADS 矢量字体不同，字宽与对齐只能近似。',
        },
      ],
    },
  ],
  detect(name, bytes) {
    if (!String(name || '').toLowerCase().endsWith('.asc')) return null
    // Any ASCII text is a plausible `.asc`, so only accept the ones that carry
    // the PADS-POWERPCB banner as a PADS board.
    return isPadsAsciiText(leadingText(bytes))
      ? { id: 'pads', kind: 'pcb' }
      : { id: 'unknown', kind: 'unknown' }
  },
  async convert(sources, warnings) {
    const { looksLikePadsAscii, parsePadsAscii, padsToCircuitJson } = await import(
      'pads-to-circuit-json'
    )
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let parsed = null

    for (const source of sources) {
      if (source.format.kind !== 'pcb') {
        throw new EdaConversionError(
          `${source.name} 不是 PADS 板级导出文件，请只选择 .asc。`,
        )
      }
      const text = decoder.decode(source.bytes)
      if (!looksLikePadsAscii(text)) {
        throw new EdaConversionError(
          `${source.name} 没有 PADS-POWERPCB 版本头。请用 PADS Layout 的 File → Export → ASCII 重新导出，并确认导出时勾选了所有需要的段落。`,
        )
      }
      if (parsed) {
        throw new EdaConversionError('一次只能转换一块板：检测到多个 PADS .asc，请分批转换。')
      }
      parsed = parsePadsAscii(text)
    }

    const majorVersion = Number(/^V?(\d+)/.exec(parsed.version || '')?.[1])
    if (Number.isFinite(majorVersion) && majorVersion < 9) {
      warnings.push({
        level: 'warn',
        message: `PADS 版本是 ${parsed.version}，字段顺序按 V9 及以后校验，请对照板图后再使用。`,
      })
    }
    if (parsed.units === 'BASIC') {
      warnings.push({
        level: 'info',
        message: '文件使用 PADS 内部单位（BASIC），已按 1/38100 mil 换算成毫米。',
      })
    }

    const circuitJson = padsToCircuitJson(parsed, warnings)
    const summary = summarize(circuitJson)
    if (summary.hasBoard && summary.board.tracks === 0) {
      warnings.push({
        level: 'info',
        code: 'no-routing',
        message:
          '文件里没有 *ROUTE* 走线段，输出只有元件、焊盘和板框；请在 PADS 里确认已布线并勾选 Routing。',
      })
    }
    return { circuitJson, summary }
  },
}
