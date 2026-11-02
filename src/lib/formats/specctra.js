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
        { category: '走线', detail: 'DSN 只有布局与网表；走线需另传同一工程的 .ses。' },
        {
          category: '设计规则',
          detail: 'rule / clearance 段（默认线宽、间距）不导出，需在 KiCad 重设。',
        },
        { category: '层与图形', detail: '没有丝印、阻焊/助焊层图形和铜皮。' },
        {
          category: '焊盘',
          detail: '只按 DSN 声明的形状与尺寸重建，焊盘叠层与自定义焊盘简化。',
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
      warnings.push({
        level: 'warn',
        code: 'no-routing',
        message:
          '只提供了 DSN:只有元件位置、焊盘与网表,走线为空。补上同工程的 .ses 可一并转换布线。',
      })
    }

    return { circuitJson, summary: summarize(circuitJson) }
  },
}
