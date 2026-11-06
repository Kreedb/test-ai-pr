// Offline support is generated at build time: the service worker must precache
// every emitted file under the site base and refresh the cache when the build
// changes, otherwise a stale index.html is served forever.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { offlinePlugin, serviceWorkerSource } from '../build/offline.js'

test('the service worker precaches every build asset under the base', () => {
  const source = serviceWorkerSource(['index.html', 'assets/index-abc.js', 'assets/index-abc.css'], '/test-ai-web/')

  for (const url of ['"/test-ai-web/"', '"/test-ai-web/index.html"', '"/test-ai-web/assets/index-abc.js"', '"/test-ai-web/assets/index-abc.css"']) {
    assert.ok(source.includes(url), url)
  }
})

test('the cache version changes when the build changes', () => {
  const files = ['index.html', 'assets/index-abc.js']
  const before = serviceWorkerSource(files, '/test-ai-web/', 'old index')
  const after = serviceWorkerSource(files, '/test-ai-web/', 'new index')

  assert.notEqual(before, after)
})

test('the plugin emits sw.js for the bundle and public files', () => {
  const emitted = []
  const plugin = offlinePlugin('/test-ai-web/', ['convbin.svg'])
  plugin.configResolved({ publicDir: 'public' })
  const bundle = {
    'index.html': { type: 'asset', source: '<html></html>' },
    'assets/index-abc.js': { type: 'chunk' },
  }

  plugin.generateBundle.handler.call({ emitFile: (asset) => emitted.push(asset) }, {}, bundle)

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].fileName, 'sw.js')
  assert.ok(emitted[0].source.includes('/test-ai-web/assets/index-abc.js'))
  assert.ok(emitted[0].source.includes('/test-ai-web/convbin.svg'))
})

test('the cache version changes when a runtime-cached public file changes', () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'convbin-offline-'))
  try {
    writeFileSync(join(publicDir, 'sample.bin'), 'first')
    const bundle = { 'index.html': { type: 'asset', source: '<html></html>' } }
    const emitSource = () => {
      const emitted = []
      const plugin = offlinePlugin('/test-ai-web/')
      plugin.configResolved({ publicDir })
      plugin.generateBundle.handler.call({ emitFile: (asset) => emitted.push(asset) }, {}, bundle)
      return emitted[0].source
    }

    const before = emitSource()
    writeFileSync(join(publicDir, 'sample.bin'), 'second')

    assert.notEqual(before, emitSource())
  } finally {
    rmSync(publicDir, { recursive: true, force: true })
  }
})

test('a missing public file fails the build instead of silently disabling offline', () => {
  const plugin = offlinePlugin('/test-ai-web/', ['samples/missing.bin'])
  plugin.configResolved({ publicDir: 'public' })
  const bundle = { 'index.html': { type: 'asset', source: '<html></html>' } }

  assert.throws(() => plugin.generateBundle.handler.call({ emitFile() {} }, {}, bundle), /missing\.bin/)
})
