import { onUnmounted, ref } from 'vue'

import { homeRoute, routeFor } from '@/routes'

// Minimal hash router. The site is a GitHub Pages project page served from a
// subpath, so hash routes avoid any server-side rewrite rules.
function currentPath() {
  return (routeFor(window.location.hash) || homeRoute).path
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
