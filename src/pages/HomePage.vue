<script setup>
const tools = [
  {
    path: '/parser',
    tag: 'SII → 编辑 → ESI XML',
    title: 'EEPROM 解析器',
    description:
      '上传 .bin 格式的 SII EEPROM 转储，解析并可编辑固定头、General、字符串、FMMU、SyncManager、PDO 与 DC，导出 ESI XML，并用内置生成器重新编译校验。',
    action: '打开解析器',
  },
  {
    path: '/convert',
    tag: 'Altium / Specctra / EAGLE → KiCad',
    title: 'EDA 转 KiCad',
    description:
      '把 Altium .PcbDoc/.SchDoc、Specctra .dsn/.ses 或 EAGLE XML .brd/.sch 转成 .kicad_pcb、.kicad_sch 与 .kicad_pro，页面会逐项说明哪些信息可能无法无损转换。',
    action: '打开转换器',
  },
]
</script>

<template>
  <main class="app-main">
    <section class="card hero">
      <span class="hero-tag">EtherCAT 工具箱</span>
      <h2>SII EEPROM 解析与 EDA 格式转换</h2>
      <p>
        上传 .bin 转储即可查看并编辑全部 SII 字段，导出 EtherCATInfo XML，并用内置的 EEPROM 生成器重新编译校验；
        也可以把 Altium、Specctra 或 EAGLE 工程转换成 KiCad 文件。所有数据只在本机处理，不会上传。
      </p>
      <div class="hero-actions">
        <a class="btn primary" href="#/parser">打开解析器</a>
      </div>
    </section>

    <section class="tool-grid" aria-label="工具列表">
      <a v-for="tool in tools" :key="tool.path" class="tool-card" :href="`#${tool.path}`">
        <span class="tool-tag">{{ tool.tag }}</span>
        <h2>{{ tool.title }}</h2>
        <p>{{ tool.description }}</p>
        <span class="tool-link">{{ tool.action }} →</span>
      </a>

      <div class="tool-card placeholder">
        <span class="tool-tag">即将推出</span>
        <h2>更多工具</h2>
        <p>后续新增的 EtherCAT 工具都会挂在导航页下，使用同一套页面框架。</p>
      </div>
    </section>
  </main>
</template>
