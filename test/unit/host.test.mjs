import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const host = await import(new URL('../../index.js', import.meta.url).href)

test('the host half exposes a named Cordis plugin', () => {
  assert.equal(host.name, 'aside')
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.default.name, 'aside')
  assert.equal(host.default.apply, host.apply)
})

test('the host half registers one tool and waits for the connection, with no prompt surface', () => {
  assert.equal(host.Config, undefined, 'a host config could not affect browser behaviour')
  assert.deepEqual(host.inject, ['tools', 'agents'], 'both are needed by the relay tool and are core')
  assert.equal(host.apply.length, 1, 'apply takes the context only')

  const tools = []
  const injections = []
  const context = {
    inject(names, run) {
      injections.push(names)
      run({ connection: { fetch: { register: () => () => {} } }, effect: (fn) => fn() })
    },
    effect: (fn) => fn(),
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }
  const dispose = host.apply(context)
  assert.equal(typeof dispose, 'function', 'apply returns a composite disposer')
  assert.equal(tools.length, 1, 'exactly one tool is registered')
  assert.equal(tools[0].name, 'aside_tell_main')
  assert.deepEqual(injections, [['connection']], 'the route waits for the connection service')
  assert.doesNotThrow(() => dispose(), 'disposing is safe')
})

test('the manifest names the package the sidebar slots are keyed by', () => {
  assert.equal(manifest.name, 'dsh-plugin-aside')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'AGPL-3.0-or-later')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['.'], './index.js')
})

test('the manifest wires a bundle patch and a web client entry', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(!JSON.stringify(manifest.dsh.client).includes('dsh-plugin-aside'), 'never declare yourself external')
})

test('the bundle patch inserts exactly this package id', () => {
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: aside/)
  assert.match(patch, /name: 'dsh-plugin-aside'/)
  assert.ok(!/^\s+config:/m.test(patch), 'the inert host half must not carry a config block')
})

test('the declared icon and locale files exist and stay small enough', () => {
  for (const relative of [manifest.icon, 'locale/en.json', 'locale/zh.json', 'LICENSE', 'README.md', 'README.zh.md']) {
    const path = new URL(relative, new URL('../../', import.meta.url))
    const content = readFileSync(path)
    assert.ok(content.length > 0, `${relative} must not be empty`)
    if (relative === manifest.icon) assert.ok(content.length <= 256 * 1024, 'the plugin icon must stay under 256 KiB')
    else if (relative.endsWith('.json')) assert.ok(JSON.parse(content.toString('utf8')) !== undefined)
  }
})

test('the published file list ships every runtime file the manifest points at', () => {
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('index.js'))
  assert.ok(manifest.files.includes('src/**/*.js'), 'the relay tool lives under src/')
  for (const shipped of manifest.files.filter((entry) => entry.includes('src/'))) {
    assert.ok(readFileSync(new URL(`../../${shipped.replace('**/*.js', 'tell-main.js')}`, import.meta.url)).length > 0, `${shipped} must match a real file`)
  }
})

test('every image the README embeds exists', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
  assert.ok(images.length > 0, 'the README should show the feature')
  for (const relative of images) {
    assert.ok(readFileSync(new URL(`../../${relative}`, import.meta.url)).length > 0, `${relative} must exist`)
  }
})
