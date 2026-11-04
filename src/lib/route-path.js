// Route path helpers shared by the router and link builders. Keeping the
// matching rules here lets plain Node tests cover them without Vue components.

function normalizeRoutePath(value) {
  const raw = String(value ?? '')
    .replace(/^#/, '')
    .split('?')[0]
    .trim()
  if (!raw) return '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function routePath(id) {
  return `/${id}`
}

export function pageRouteId(filePath) {
  const name = String(filePath ?? '')
    .split('/')
    .pop()
    .replace(/\.vue$/i, '')
    .replace(/Page$/i, '')
  return name ? name.toLowerCase() : ''
}

export function findRoute(routes, value) {
  const path = normalizeRoutePath(value)
  return routes.find((route) => route.path === path) || null
}
