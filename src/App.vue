<script setup>
import { computed } from 'vue'

import { useRoute } from '@/router'
import { homeRoute, routeFor, routeHref, routes } from '@/routes'

const path = useRoute()
const active = computed(() => routeFor(path.value))
const page = computed(() => active.value?.component || homeRoute.component)
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a class="brand" :href="routeHref(homeRoute.path)">
        <div class="brand-mark" aria-hidden="true">CB</div>
        <div>
          <h1>convbin</h1>
          <p>二进制工具箱 · SII EEPROM 解析、ESI XML 导出与 EDA 格式转换 · 数据仅在浏览器本地处理</p>
        </div>
      </a>

      <nav class="app-nav" aria-label="主导航">
        <a
          v-for="route in routes"
          :key="route.path"
          :href="routeHref(route.path)"
          :class="{ active: route.path === path }"
          :aria-current="route.path === path ? 'page' : undefined"
        >
          {{ route.label }}
        </a>
      </nav>

      <a class="gh-link" href="https://github.com/Kreedb/test-ai-pr" target="_blank" rel="noreferrer">
        GitHub
      </a>
    </header>

    <component :is="page" />

    <footer class="app-footer">
      <span>convbin · {{ active?.label }} · 数据仅在浏览器本地处理</span>
    </footer>
  </div>
</template>
