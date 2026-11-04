import { onUnmounted, ref } from 'vue'

import { routeFor } from '@/routes'

// Minimal hash router. The site is a GitHub Pages project page served from a
// subpath, so hash routes avoid any server-side rewrite rules. Unknown paths
// fall back to the home view in App.vue.
function currentPath() {
  return routeFor(window.location.hash)?.path || '/'
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