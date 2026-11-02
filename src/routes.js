// Single source for hash routes, navigation labels, page components and the
// home-page tool cards. Adding a page is one record here.

import ConvertPage from '@/pages/ConvertPage.vue'
import HomePage from '@/pages/HomePage.vue'
import ParserPage from '@/pages/ParserPage.vue'

export const routes = [
  { path: '/', label: '首页', component: HomePage },
  {
    path: '/parser',
    label: 'EEPROM 解析器',
    component: ParserPage,
    tool: {
      tag: 'SII → 编辑 → ESI XML',
      title: 'EEPROM 解析器',
      description:
        '上传 .bin 格式的 SII EEPROM 转储，解析并可编辑固定头、General、字符串、FMMU、SyncManager、PDO 与 DC，导出 ESI XML，并用内置生成器重新编译校验。',
      action: '打开解析器',
    },
  },
  {
    path: '/convert',
    label: 'EDA 转 KiCad',
    component: ConvertPage,
    tool: {
      tag: 'Altium / Specctra / EAGLE / PADS → KiCad',
      title: 'EDA 转 KiCad',
      description:
        '把 Altium .PcbDoc/.SchDoc、Specctra .dsn/.ses、EAGLE XML .brd/.sch 或 PADS Layout ASCII .asc 转成 .kicad_pcb、.kicad_sch 与 .kicad_pro，页面会逐项说明哪些信息可能无法无损转换。',
      action: '打开转换器',
    },
  },
]

export const toolRoutes = routes.filter((route) => route.tool)
