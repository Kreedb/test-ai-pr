import { onUnmounted, ref } from 'vue'

// Minimal hash router. The site is a GitHub Pages project page served from a
// subpath, so hash routes avoid any server-side rewrite rules.
export const routes = [
  { path: '/', label: '首页' },
  { path: '/parser', label: 'EEPROM 解析器' },
  { path: '/generator', label: 'EEPROM 生成器' },
  { path: '/xml', label: 'ESI XML 编辑器' },
]

function currentPath() {
  const raw = window.location.hash.replace(/^#/, '')
  return routes.some((route) => route.path === raw) ? raw : '/'
}

export function useRoute() {
  const path = ref(currentPath())
  const update = () => {
    path.value = currentPath()
    window.scrollTo({ top: 0 })
  }
  window.addEventListener('hashchange', update)
  onUnmounted(() => window.removeEventListener('hashchange', update))
  return path
}
