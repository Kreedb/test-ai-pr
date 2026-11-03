import { EdaConversionError, isCompoundFile, leadingText, summarize } from '../eda-shared.js'

export const specctra = {
  id: 'specctra',
  label: 'Specctra DSN / SES',
  extensions: ['.dsn', '.ses'],
  status: 'supported',
  converts: 'PCB',
  note: 'Allegro、OrCAD PCB Designer、PADS Layout、Xpedition 都能导出 DSN;.ses 是自动布线结果,需与同工程的 .dsn 一起上传。',
  samples: [{ label: 'Specctra DSN', files: ['samples/specctra/motor-driver.dsn'] }],
  losses: [
    {
      id: 'dsn',
      source: 'Specctra DSN / SES',
      target: '.kicad_pcb',
      items: [
        {
          category: '走线',
          detail: 'DSN 的 wiring 段若为空则只有布局与网表；自动布线结果需另传同一工程的 .ses。',
          reason:
            'DSN 的 wiring 段可以带已有布线,但不是必需内容,没有时转换器只能输出空走线,补 .ses 才能还原自动布线结果。',
        },
        {
          category: '设计规则',
          detail: 'rule / clearance 段（默认线宽、间距）不导出，需在 KiCad 重设。',
          reason:
            'dsnts 会解析 structure.rule 与 class 规则,但 dsn-to-circuit-json 只映射走线,没有把线宽、间距和差分对写进 Circuit JSON;KiCad 还需要 .kicad_pro/.kicad_dru。',
        },
        {
          category: '层与图形',
          detail: '内层走线与焊盘会落到 top/bottom；没有丝印、阻焊/助焊层图形和铜皮。',
          reason:
            'dsn-to-circuit-json 的 mapLayer 只产出 top/bottom(内层被折叠),而且它忽略 wiring 下的 plane 多边形,所以铜皮/平面没有进入中间模型;DSN 也没有丝印/阻焊/助焊图形。',
        },
        {
          category: '焊盘',
          detail: '只按 circle/rect 重建；polygon/path 焊盘被简化，焊盘叠层不保留。',
          reason:
            'dsnts 能读 polygon/path 焊盘,但 dsn-to-circuit-json 只处理 circle/rect,把 polygon 压成外接矩形、path 当矩形;Circuit JSON 虽支持 polygon 焊盘,这条转换链没有产出,焊盘叠层也没有映射。',
        },
      ],
    },
  ],
  detect(name, bytes) {
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.dsn')) {
      if (isCompoundFile(bytes)) return { id: 'orcad', kind: 'schematic' }
      const text = leadingText(bytes).trimStart()
      if (text.startsWith('(pcb')) return { id: 'specctra', kind: 'dsn' }
      return { id: 'orcad', kind: 'schematic' }
    }
    if (lower.endsWith('.ses')) return { id: 'specctra', kind: 'ses' }
    return null
  },
  async convert(sources, warnings) {
    const { DsnToCircuitJsonConverter, SesToCircuitJsonConverter } = await import(
      'dsn-to-circuit-json'
    )

    const dsnSources = sources.filter((source) => source.format.kind === 'dsn')
    const dsn = dsnSources[0]
    const ses = sources.find((source) => source.format.kind === 'ses')
    if (!dsn) {
      throw new EdaConversionError(
        'SES 只是自动布线结果,必须同时上传同一工程的 .dsn 才能转换。',
      )
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
    }

    const summary = summarize(circuitJson)
    // A DSN can carry its own `(wiring)` block, so only warn about missing
    // routing when the conversion actually produced no tracks.
    if (!ses && summary.hasBoard && summary.board.tracks === 0) {
      warnings.push({
        level: 'warn',
        code: 'no-routing',
        message:
          '只提供了 DSN:只有元件位置、焊盘与网表,走线为空。补上同工程的 .ses 可一并转换布线。',
      })
    }

    return { circuitJson, summary }
  },
}
