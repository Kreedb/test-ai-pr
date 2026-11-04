// Hash-route normalization keeps every link on a registered page. These checks
// cover the path forms the browser can hand us: bare hashes, query suffixes,
// trailing slashes and unknown paths. `/` is the App.vue home view, not a
// registered page.

import assert from 'node:assert/strict'
import test from 'node:test'

import { findRoute, pageRouteId, routePath } from '../src/lib/route-path.js'

const routes = [
  { id: 'parser', path: '/parser' },
  { id: 'convert', path: '/convert' },
]

test('route paths are derived from stable ids', () => {
  assert.equal(routePath('parser'), '/parser')
  assert.equal(routePath('convert'), '/convert')
})

test('page ids come from the file name', () => {
  assert.equal(pageRouteId('./pages/ParserPage.vue'), 'parser')
  assert.equal(pageRouteId('/pages/Settings.vue'), 'settings')
})

test('hash paths normalize before matching', () => {
  // '/' is the home view rendered by App.vue, not a registered page.
  assert.equal(findRoute(routes, ''), null)
  assert.equal(findRoute(routes, '#/'), null)
  assert.equal(findRoute(routes, '#/parser/')?.id, 'parser')
  assert.equal(findRoute(routes, '#/convert?sample=1')?.id, 'convert')
  assert.equal(findRoute(routes, 'parser')?.id, 'parser')
  assert.equal(findRoute(routes, '#/missing'), null)
})
