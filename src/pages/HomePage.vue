<script setup>
import { routes } from '@/router'

const tools = [
  {
    path: '/parser',
    tag: 'SII → 结构',
    title: 'EEPROM 解析器',
    description:
      '上传 SII EEPROM 转储，查看固定头、字符串、SyncManager、PDO 与 DC，并导出 JSON、原始 bin 或 ESI XML。',
    action: '打开解析器',
  },
  {
    path: '/generator',
    tag: 'ESI XML → bin',
    title: 'EEPROM 生成器',
    description:
      '从 TwinCAT 导出的 EtherCATInfo XML 构建 SII 二进制镜像，可直接下载烧录或与厂商转储逐字节比对。',
    action: '打开生成器',
  },
  {
    path: '/xml',
    tag: 'SII → ESI XML',
    title: 'ESI XML 生成器',
    description:
      '从 EEPROM 转储生成 EtherCATInfo XML：编辑设备身份、端口与邮箱配置，并用原始转储做逐字节回归校验。',
    action: '打开 XML 生成器',
  },
]

const navRoutes = routes.filter((route) => route.path !== '/')
</script>

<template>
  <main class="app-main">
    <section class="card hero">
      <span class="hero-tag">EtherCAT 工具箱</span>
      <h2>从 ESI 描述文件到 SII EEPROM 镜像</h2>
      <p>
        一组在浏览器本地运行的 EtherCAT 工具：解析从站 EEPROM 转储、生成可烧录的 SII 镜像，并在两种格式之间往返转换。
        所有数据只在本机处理，不会上传。
      </p>
      <div class="hero-actions">
        <a v-for="route in navRoutes" :key="route.path" class="btn" :href="`#${route.path}`">
          {{ route.label }}
        </a>
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
