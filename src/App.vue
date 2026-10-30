<script setup>
import { computed } from 'vue'

import GeneratorPage from '@/pages/GeneratorPage.vue'
import HomePage from '@/pages/HomePage.vue'
import ParserPage from '@/pages/ParserPage.vue'
import XmlGeneratorPage from '@/pages/XmlGeneratorPage.vue'
import { routes, useRoute } from '@/router'

const pages = {
  '/': HomePage,
  '/parser': ParserPage,
  '/generator': GeneratorPage,
  '/xml': XmlGeneratorPage,
}

const path = useRoute()
const page = computed(() => pages[path.value] || HomePage)
const active = computed(() => routes.find((route) => route.path === path.value))
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a class="brand" href="#/">
        <div class="brand-mark" aria-hidden="true">EC</div>
        <div>
          <h1>EtherCAT 工具箱</h1>
          <p>SII EEPROM 解析与生成 · 数据仅在浏览器本地处理</p>
        </div>
      </a>

      <nav class="app-nav" aria-label="主导航">
        <a
          v-for="route in routes"
          :key="route.path"
          :href="`#${route.path}`"
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
      <span>EtherCAT 工具箱 · {{ active?.label }} · 数据仅在浏览器本地处理</span>
    </footer>
  </div>
</template>
