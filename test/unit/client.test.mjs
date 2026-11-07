import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClientModule } from '../support/loader.mjs'

const { definition, module } = await loadClientModule()
const internals = module.__test

test('the module registers itself under its package name', () => {
  assert.equal(definition.id, 'dsh-plugin-aside')
  assert.equal(typeof definition.factory, 'function')
})

test('the module exports the Cordis plugin shape', () => {
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
  for (const service of ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'resources', 'shortcuts']) {
    assert.ok(module.inject.includes(service), `inject must include ${service}`)
  }
})

test('asideAddress builds the canonical resource address', () => {
  assert.equal(
    internals.asideAddress('session-child', 'session-parent'),
    'dsh-resource://asidechat/session/session-child?parent=session-parent',
  )
  assert.equal(internals.asideAddress('session-child'), 'dsh-resource://asidechat/session/session-child')
})

test('asideAddress percent-encodes ids that are not URL-safe', () => {
  const address = internals.asideAddress('a/b c', 'p&q')
  assert.ok(!address.includes('a/b'), 'slash must be escaped')
  assert.deepEqual(internals.parseAsideAddress(address), { childSessionId: 'a/b c', parentSessionId: 'p&q' })
})

test('parseAsideAddress round-trips a full address', () => {
  assert.deepEqual(internals.parseAsideAddress(internals.asideAddress('child-1', 'parent-1')), {
    childSessionId: 'child-1',
    parentSessionId: 'parent-1',
  })
})

test('parseAsideAddress round-trips an address without a parent', () => {
  assert.deepEqual(internals.parseAsideAddress(internals.asideAddress('child-1')), { childSessionId: 'child-1' })
})

test('parseAsideAddress rejects anything that is not one of our addresses', () => {
  const rejected = [
    undefined,
    null,
    42,
    '',
    'not a url',
    'dsh-resource://subagentchat/session/x',
    'dsh-resource://asidechat',
    'dsh-resource://asidechat/session',
    'dsh-resource://asidechat/session/a/b',
    'dsh-resource://asidechat/tab/x',
    'dsh-resource://asidechat/session/%',
    'https://asidechat/session/x',
    'sidebar://asidechat',
  ]
  for (const value of rejected) {
    assert.equal(internals.parseAsideAddress(value), undefined, `expected ${String(value)} to be rejected`)
  }
})

test('messageOf normalizes thrown values', () => {
  assert.equal(internals.messageOf(new Error('boom')), 'boom')
  assert.equal(internals.messageOf('boom'), 'boom')
  assert.equal(internals.messageOf(17), '17')
})

test('both dictionaries carry exactly the same keys', () => {
  const zh = Object.keys(internals.zh).sort()
  const en = Object.keys(internals.en).sort()
  assert.deepEqual(zh, en)
})

test('every dictionary key still has a placeholder-compatible translation', () => {
  const placeholders = (value) => (value.match(/\{\w+\}/g) ?? []).sort()
  for (const key of Object.keys(internals.zh)) {
    assert.deepEqual(placeholders(internals.zh[key]), placeholders(internals.en[key]), `placeholder mismatch for ${key}`)
  }
})

test('FixedChatView pins the shared conversation factory to the chat view', () => {
  const calls = []
  const element = internals.FixedChatView({
    renderSlot: (name, ownerProps) => {
      calls.push({ name, ownerProps })
      return null
    },
  })
  assert.equal(element.type, Symbol.for('react.fragment'))
  assert.deepEqual(calls, [{ name: 'conversation.session', ownerProps: { view: 'chat' } }])
})
