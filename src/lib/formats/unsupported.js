// Formats users ask about but the converters cannot read yet. Keeping them in
// the registry lets the support matrix stay honest without a second list in the
// page component.

import { isEagleXmlText, leadingText } from '../eda-shared.js'

export const allegro = {
  id: 'allegro',
  label: 'Cadence Allegro / OrCAD PCB',
  extensions: ['.brd'],
  status: 'planned',
  converts: 'PCB',
  note: '二进制格式随版本变化且未公开，暂未支持；EAGLE 5 及更早的二进制 .brd 也不支持。Allegro 用 File → Export → Specctra 导出 DSN，或提供 Gerber 再转换。',
  losses: [],
  detect(name, bytes) {
    if (
      !String(name || '')
        .toLowerCase()
        .endsWith('.brd')
    )
      return null
    // The EAGLE format module claims XML `.brd`; anything else is Allegro.
    return isEagleXmlText(leadingText(bytes)) ? null : { id: 'allegro', kind: 'pcb' }
  },
}

export const orcad = {
  id: 'orcad',
  label: 'OrCAD Capture',
  extensions: ['.dsn', '.edif'],
  status: 'planned',
  converts: '原理图',
  note: 'Capture 的二进制 .dsn 与 Specctra 的文本 .dsn 同名，页面会按内容区分。暂未支持原理图导入，可在 Capture 里导出 EDIF/网表。',
  losses: [],
  detect(name) {
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.edif')) return { id: 'orcad', kind: 'schematic' }
    return null
  },
}
