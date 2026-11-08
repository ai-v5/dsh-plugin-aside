import assert from 'node:assert/strict'
import test from 'node:test'

import { LinkError, createLinkStore, parseLink } from '../../src/link-store.js'
import { LINK_PATH, handleLinkRequest, registerLinkRoute } from '../../src/link-route.js'

/** Build a POST request carrying a JSON body. */
const post = (body) =>
  new Request(`http://127.0.0.1:1234${LINK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('parseLink accepts a normal pair and trims it', () => {
  assert.deepEqual(parseLink(' session-child ', 'session-parent '), { childId: 'session-child', parentId: 'session-parent' })
})

test('parseLink refuses empty, non-string and self-referential pairs', () => {
  const bad = [
    [undefined, 'p'],
    ['', 'p'],
    ['   ', 'p'],
    [42, 'p'],
    ['c', undefined],
    ['c', ''],
    ['c', 7],
    ['same', 'same'],
  ]
  for (const [child, parent] of bad) {
    assert.throws(() => parseLink(child, parent), (error) => error instanceof LinkError)
  }
})

test('the store round-trips a link', () => {
  const store = createLinkStore()
  assert.equal(store.size, 0)
  store.set('child', 'parent')
  assert.equal(store.get('child'), 'parent')
  assert.equal(store.size, 1)
  assert.deepEqual(store.snapshot(), { child: 'parent' })
})

test('re-linking the same child replaces the parent', () => {
  const store = createLinkStore()
  store.set('child', 'first')
  store.set('child', 'second')
  assert.equal(store.get('child'), 'second')
  assert.equal(store.size, 1)
})

test('an unknown child resolves to undefined rather than throwing', () => {
  const store = createLinkStore()
  assert.equal(store.get('nobody'), undefined)
  assert.equal(store.get(undefined), undefined)
})

test('the store drops corrupted persisted rows instead of failing', () => {
  const store = createLinkStore({ good: 'parent', '': 'parent', bad: 42, self: 'self' })
  assert.deepEqual(store.snapshot(), { good: 'parent' })
})

test('a non-object persisted value is ignored', () => {
  for (const value of [null, 'nope', 7, []]) {
    const store = createLinkStore(value)
    assert.equal(store.size, 0, `expected ${JSON.stringify(value)} to yield an empty store`)
  }
})

test('delete removes one link', () => {
  const store = createLinkStore({ a: 'p' })
  assert.equal(store.delete('a'), true)
  assert.equal(store.delete('a'), false)
  assert.equal(store.size, 0)
})

test('the route records a link and answers 201', async () => {
  const store = createLinkStore()
  const response = await handleLinkRequest(store, post({ childId: 'child', parentId: 'parent' }))
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { ok: true, childId: 'child', parentId: 'parent' })
  assert.equal(store.get('child'), 'parent')
})

test('the route rejects non-POST with 405 and an allow header', async () => {
  const store = createLinkStore()
  const response = await handleLinkRequest(store, new Request(`http://x${LINK_PATH}`, { method: 'GET' }))
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})

test('the route rejects a non-JSON body with 400', async () => {
  const store = createLinkStore()
  const response = await handleLinkRequest(store, post('not json'))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).ok, false)
  assert.equal(store.size, 0)
})

test('the route rejects a JSON array body with 400', async () => {
  const store = createLinkStore()
  const response = await handleLinkRequest(store, post([1, 2]))
  assert.equal(response.status, 400)
  assert.equal(store.size, 0)
})

test('the route rejects a malformed pair with 400 and stores nothing', async () => {
  const store = createLinkStore()
  for (const body of [{}, { childId: 'c' }, { childId: '', parentId: 'p' }, { childId: 'x', parentId: 'x' }]) {
    const response = await handleLinkRequest(store, post(body))
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
  assert.equal(store.size, 0)
})

test('registerLinkRoute waits for the connection instead of probing for it', () => {
  const registrations = []
  const injections = []
  const ctx = {
    inject(names, run) {
      injections.push(names)
      run({ connection: { fetch: { register: (definition) => (registrations.push(definition), () => {}) } }, effect: (fn) => fn() })
    },
  }
  assert.equal(registerLinkRoute(ctx, createLinkStore()), undefined, 'registration is fire-and-forget on the service arrival')
  assert.deepEqual(injections, [['connection']], 'it waits for exactly the connection service')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].path, LINK_PATH)
  assert.deepEqual(registrations[0].methods, ['POST'])
  assert.equal(registrations[0].requestBody, 'buffered')
  assert.equal(typeof registrations[0].fetch, 'function')
})
