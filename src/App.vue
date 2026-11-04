<script setup>
import { computed } from 'vue'

import { useRoute } from '@/router'
import { routeFor, routeHref, routes, toolRoutes } from '@/routes'

const path = useRoute()
const active = computed(() => routeFor(path.value))
const tools = toolRoutes.map((route) => ({ path: route.path, ...route.tool }))
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a class="brand" :href="routeHref('/')">
        <div class="brand-mark" aria-hidden="true">CB</div>
        <h1>convbin</h1>
      </a>

      <nav class="app-nav" aria-label="主导航">
        <a v-for="route in routes" :key="route.path" :href="routeHref(route.path)" :class="{ active: route.path === path }" :aria-current="route.path === path ? 'page' : undefined">
          {{ route.label }}
        </a>
      </nav>

      <a class="gh-link" href="https://github.com/Kreedb/test-ai-pr" target="_blank" rel="noreferrer"> GitHub </a>
    </header>

    <component :is="active.component" v-if="active" />

    <main v-else class="app-main">
      <section class="card hero">
        <span class="hero-tag">convbin · 二进制工具箱</span>
        <h2>EEPROM、EDA 与机器人包工具</h2>
        <p>所有工具都在浏览器本地运行，文件不会上传到服务器。页面支持 PWA 离线缓存， 首次打开后断网也能继续使用。</p>
      </section>

      <section class="tool-grid" aria-label="工具列表">
        <a v-for="tool in tools" :key="tool.path" class="tool-card" :href="routeHref(tool.path)">
          <span class="tool-tag">{{ tool.tag }}</span>
          <h2>{{ tool.title }}</h2>
          <p>{{ tool.description }}</p>
          <span class="tool-link">{{ tool.action }} →</span>
        </a>
      </section>
    </main>

    <footer class="app-footer">
      <span>convbin · {{ active?.label || '首页' }} · 数据仅在浏览器本地处理</span>
    </footer>
  </div>
</template>
