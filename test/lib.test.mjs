// The `lib/` packages are published to npm on their own, so they must not reach
// back into the app. This test fails when a package imports `src/` or a relative
// path that leaves its own folder.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const libRoot = join(root, 'lib')

const packages = readdirSync(libRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.js') ? [path] : []
  })
}

test('every lib package has a README and a package.json', () => {
  assert.ok(packages.length > 0, 'expected at least one lib package')
  for (const name of packages) {
    const dir = join(libRoot, name)
    assert.doesNotThrow(() => readFileSync(join(dir, 'README.md')), `${name} has no README.md`)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.name, name, `${name}/package.json name mismatch`)
    assert.ok(manifest.exports || manifest.main, `${name} has no entry point`)
  }
})

test('lib packages do not import the app', () => {
  for (const name of packages) {
    const packageDir = join(libRoot, name)
    for (const file of sourceFiles(join(libRoot, name, 'src'))) {
      const source = readFileSync(file, 'utf8')
      assert.ok(!/from\s+['"]@\//.test(source), `${file} imports the app alias`)
      for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), match[1])
        assert.ok(
          target.startsWith(packageDir + sep),
          `${file} imports outside its package: ${match[1]}`,
        )
      }
    }
  }
})
