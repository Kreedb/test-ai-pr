// Hash-route normalization keeps every link on a registered page. These checks
// cover the path forms the browser can hand us: bare hashes, query suffixes,
// trailing slashes and unknown paths.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findRoute,
  normalizeRoutePath,
  pageRouteId,
  routePath,
} from '../src/lib/route-path.js'

const routes = [
  { id: 'home', path: '/' },
  { id: 'parser', path: '/parser' },
  { id: 'convert', path: '/convert' },
]

test('route paths are derived from stable ids', () => {
  assert.equal(routePath('home'), '/')
  assert.equal(routePath('parser'), '/parser')
})

test('page ids come from the file name', () => {
  assert.equal(pageRouteId('./pages/HomePage.vue'), 'home')
  assert.equal(pageRouteId('./pages/ParserPage.vue'), 'parser')
  assert.equal(pageRouteId('/pages/Settings.vue'), 'settings')
})

test('hash paths normalize before matching', () => {
  assert.equal(normalizeRoutePath(''), '/')
  assert.equal(normalizeRoutePath('#/'), '/')
  assert.equal(normalizeRoutePath('#/parser/'), '/parser')
  assert.equal(normalizeRoutePath('#/convert?sample=1'), '/convert')
  assert.equal(normalizeRoutePath('parser'), '/parser')
})

test('only registered paths match', () => {
  assert.equal(findRoute(routes, '#/parser')?.id, 'parser')
  assert.equal(findRoute(routes, '#/parser/')?.id, 'parser')
  assert.equal(findRoute(routes, '#/missing'), null)
})
