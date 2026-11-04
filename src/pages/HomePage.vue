<script>
export const route = { label: '首页', order: 0 }
</script>

<script setup>
import { routeHref, toolRoutes } from '@/routes'

const tools = toolRoutes.map((route) => ({ path: route.path, ...route.tool }))
const primary = tools[0]
</script>

<template>
  <main class="app-main">
    <section class="card hero">
      <span class="hero-tag">convbin · 二进制工具箱</span>
      <h2>EEPROM、EDA 与机器人包工具</h2>
      <p>
        上传 .bin 转储即可查看并编辑全部 SII 字段，导出 EtherCATInfo XML，并用内置的 EEPROM 生成器重新编译校验；
        也可以把 Altium、Specctra、EAGLE 或 PADS 工程转换成 KiCad 文件，
        或回放 ROS1 bag 里的关节与 IMU 数据来还原机器人姿态。所有数据只在本机处理，不会上传。
      </p>
      <div class="hero-actions">
        <a v-if="primary" class="btn primary" :href="routeHref(primary.path)">
          {{ primary.action }}
        </a>
      </div>
    </section>

    <section class="tool-grid" aria-label="工具列表">
      <a v-for="tool in tools" :key="tool.path" class="tool-card" :href="routeHref(tool.path)">
        <span class="tool-tag">{{ tool.tag }}</span>
        <h2>{{ tool.title }}</h2>
        <p>{{ tool.description }}</p>
        <span class="tool-link">{{ tool.action }} →</span>
      </a>

      <div class="tool-card placeholder">
        <span class="tool-tag">即将推出</span>
        <h2>更多工具</h2>
        <p>后续新增的工具都会挂在导航页下，使用同一套页面框架。</p>
      </div>
    </section>
  </main>
</template>
