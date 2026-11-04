// File-based page registry. A page owns its route metadata in a plain
// `<script>` block; the file name supplies the id, so adding a page only
// touches the new file. The home view lives in App.vue, not in pages/.

import { findRoute, pageRouteId, routePath } from '@/lib/route-path'

const pages = import.meta.glob('./pages/*Page.vue', { eager: true })

export const routes = Object.entries(pages)
  .map(([file, page]) => {
    const id = pageRouteId(file)
    return { id, ...page.route, component: page.default, path: routePath(id) }
  })
  .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))

export const toolRoutes = routes.filter((route) => route.tool)

export function routeFor(value) {
  return findRoute(routes, value)
}

export function routeHref(value) {
  return `#${(routeFor(value) || { path: '/' }).path}`
}
