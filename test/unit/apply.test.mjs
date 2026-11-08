import assert from 'node:assert/strict'
import test from 'node:test'

import { createFakeContext } from '../support/fake-context.mjs'
import { loadClientModule } from '../support/loader.mjs'

const { module } = await loadClientModule()
const { PLUGIN_ID, KIND, PROTOCOL, ADDRESS_PREFIX, CONVERSATION_SLOT, SHORTCUT_ID } = module.__test

/**
 * Apply the plugin against a fresh recording context.
 *
 * @param {object} [options] - forwarded to `createFakeContext`.
 * @returns {{ ctx: object, recorded: object }} context and recordings.
 */
function applyPlugin(options) {
  const { ctx, recorded } = createFakeContext(options)
  module.apply(ctx)
  return { ctx, recorded }
}

/**
 * Read the single registration of one slot name.
 *
 * @param {object} recorded - recordings from `applyPlugin`.
 * @param {string} name - slot name.
 * @returns {{ definition: object, component: Function }} the registration.
 */
function slot(recorded, name) {
  const found = recorded.slots.filter((entry) => entry.definition.name === name)
  assert.equal(found.length, 1, `expected exactly one registration of "${name}"`)
  return found[0]
}

test('apply registers the copy, the resource protocol, the tab type, four slots and the shortcut', () => {
  const { recorded } = applyPlugin()
  assert.ok(recorded.dictionaries.aside !== undefined, 'registers the aside dictionary')
  assert.equal(recorded.resources.length, 1)
  assert.equal(recorded.tabTypes.length, 1)
  assert.equal(recorded.slots.length, 4)
  assert.equal(recorded.shortcuts.length, 1)
})

test('the resource provider owns the asidechat protocol', () => {
  const { recorded } = applyPlugin()
  assert.equal(recorded.resources[0].protocol, PROTOCOL)
  assert.equal(typeof recorded.resources[0].open, 'function')
})

test('the resource provider yields a retained reference and releases it on abort', async () => {
  const { recorded } = applyPlugin()
  const provider = recorded.resources[0]
  const controller = new AbortController()
  const stream = provider.open(`${ADDRESS_PREFIX}child-1?parent=parent-1`, { signal: controller.signal })

  const first = await stream.next()
  assert.equal(first.done, false)
  assert.equal(first.value.ok, true)
  assert.equal(first.value.value.address.childSessionId, 'child-1')
  assert.equal(first.value.value.address.parentSessionId, 'parent-1')
  assert.equal(first.value.value.reference.sessionId, 'child-1')
  assert.deepEqual(recorded.retained[0], {
    target: 'child-1',
    retainOptions: { source: 'asideChat', signal: controller.signal },
  })
  assert.equal(recorded.released.length, 0, 'must not release while the tab still holds the address')

  controller.abort()
  const finished = await stream.next()
  assert.equal(finished.done, true)
  assert.deepEqual(recorded.released, ['child-1'], 'aborting the tab must release the reference')
})

test('the resource provider reports a missing session as an error frame instead of throwing', async () => {
  const { recorded } = applyPlugin()
  const provider = recorded.resources[0]
  const controller = new AbortController()
  const stream = provider.open(`${ADDRESS_PREFIX}session-missing`, { signal: controller.signal })
  const first = await stream.next()
  assert.equal(first.done, false)
  assert.equal(first.value.ok, false)
  assert.match(String(first.value.error), /unknown session/)
  controller.abort()
  await stream.next()
})

test('the resource provider refuses addresses it does not own', async () => {
  const { recorded } = applyPlugin()
  const provider = recorded.resources[0]
  const controller = new AbortController()
  const stream = provider.open('dsh-resource://subagentchat/session/child', { signal: controller.signal })
  await assert.rejects(() => stream.next(), /invalid side-chat address/)
})

test('the tab type is a builtin asidechat resource type with one start-page entry', () => {
  const { recorded } = applyPlugin()
  const type = recorded.tabTypes[0]
  assert.equal(type.id, PLUGIN_ID)
  assert.equal(type.kind, KIND)
  assert.equal(type.priority, 'builtin')
  assert.deepEqual(type.patterns, [`${ADDRESS_PREFIX}**`])
  assert.equal(type.canOpen(`${ADDRESS_PREFIX}child-1`), true)
  assert.equal(type.canOpen('dsh-resource://subagentchat/session/child-1'), false)
  assert.equal(type.title(`${ADDRESS_PREFIX}child-1`), '侧聊', 'falls back to the localized name without a catalog row')

  assert.equal(type.guide.length, 1)
  const entry = type.guide[0]
  assert.equal(entry.id, 'new')
  assert.ok(entry.order < 20, 'the side-chat card sorts before the terminal card')
  assert.equal(entry.title(), '新建旁聊')
  assert.equal(entry.description(), '把当前对话分叉到右侧栏')
})

test('the tab body declares its own session-scoped conversation slot', () => {
  const { recorded } = applyPlugin()
  const body = slot(recorded, 'sidebar.right.pane.tab')
  assert.equal(body.definition.key, PLUGIN_ID)
  assert.deepEqual(body.definition.children, { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } })
})

test('the conversation slot is registered under the name the body declares', () => {
  const { recorded } = applyPlugin()
  const conversation = slot(recorded, CONVERSATION_SLOT)
  assert.equal(typeof conversation.component, 'function')
})

test('the guide card is keyed by the plugin id and injects a session-bound fork action', () => {
  const { recorded } = applyPlugin()
  const guide = slot(recorded, 'sidebar.right.tab.guide.entry')
  assert.equal(guide.definition.key, PLUGIN_ID)
  assert.equal(guide.definition.locale, 'aside')
  const injected = guide.definition.inject('session-main')
  assert.equal(typeof injected.startSideChat, 'function')
})

test('the guide card forks the session it belongs to and replaces its own tab', async () => {
  const { recorded } = applyPlugin()
  const guide = slot(recorded, 'sidebar.right.tab.guide.entry')
  const { startSideChat } = guide.definition.inject('session-main')

  const childId = await startSideChat({ replaceTab: 'tab-guide' })

  assert.equal(childId, 'session-child')
  assert.deepEqual(recorded.forks, [{ sessionId: 'session-main', increaseTitle: true }])
  assert.deepEqual(recorded.opened, [
    {
      address: 'dsh-resource://asidechat/session/session-child?parent=session-main',
      placement: { kind: KIND, replaceTab: 'tab-guide' },
    },
  ])
})

test('without a tab to replace the new side chat prefers its own pane', async () => {
  const { recorded } = applyPlugin()
  const guide = slot(recorded, 'sidebar.right.tab.guide.entry')
  const { startSideChat } = guide.definition.inject('session-main')

  await startSideChat()

  assert.deepEqual(recorded.opened, [
    {
      address: 'dsh-resource://asidechat/session/session-child?parent=session-main',
      placement: { kind: KIND, preferNewPane: true },
    },
  ])
})

test('a fork failure rejects and opens nothing', async () => {
  const { recorded } = applyPlugin({ fork: () => Promise.reject(new Error('fork refused')) })
  const guide = slot(recorded, 'sidebar.right.tab.guide.entry')
  const { startSideChat } = guide.definition.inject('session-main')

  await assert.rejects(() => startSideChat(), /fork refused/)
  assert.deepEqual(recorded.opened, [])
})

test('the fork refuses to start without a conversation', async () => {
  const { recorded } = applyPlugin()
  const guide = slot(recorded, 'sidebar.right.tab.guide.entry')
  const { startSideChat } = guide.definition.inject(undefined)

  await assert.rejects(() => startSideChat(), /请先选择一个对话/)
  assert.deepEqual(recorded.forks, [])
})

test('the shortcut refuses without an on-screen conversation', () => {
  const { recorded } = applyPlugin({ commandTarget: () => undefined })
  const resolution = recorded.shortcuts[0].resolve({ target: null })
  assert.equal(resolution.status, 'blocked')
  assert.equal(resolution.reason, '请先选择一个对话')
})

test('the shortcut forks the screen conversation when it is handled', async () => {
  const { recorded } = applyPlugin({ commandTarget: () => ({ sessionId: 'session-screen' }) })
  const resolution = recorded.shortcuts[0].resolve({ target: null })
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(recorded.forks, [{ sessionId: 'session-screen', increaseTitle: true }])
  assert.equal(recorded.opened[0].address, 'dsh-resource://asidechat/session/session-child?parent=session-screen')
})

test('the shortcut is a distinct, page-wide binding', () => {
  const { recorded } = applyPlugin()
  const shortcut = recorded.shortcuts[0]
  assert.equal(shortcut.id, SHORTCUT_ID)
  assert.notEqual(shortcut.id, 'terminal.new')
  for (const region of ['page', 'editable']) assert.ok(shortcut.regions.includes(region), `must work in ${region}`)
  for (const platform of ['desktop:windows', 'desktop:macos', 'desktop:linux', 'web:windows', 'web:macos']) {
    assert.ok(shortcut.defaults[platform] !== undefined, `missing default for ${platform}`)
  }
  assert.deepEqual(
    Object.keys(shortcut.defaults).filter((platform) => platform.startsWith('web:')),
    ['web:macos', 'web:windows'],
    'the Web platform only supports macos and windows',
  )
  for (const platform of ['web:macos', 'web:windows']) {
    // The Web shell rejects bindings outside a small browser-safe allowlist;
    // primary+shift is inside it, a literal control+shift is not.
    assert.deepEqual(shortcut.defaults[platform].modifiers, ['primary', 'shift'], `${platform} must stay browser-safe`)
  }
})

test('a shortcut conflict never takes the rest of the plugin down', () => {
  // `shortcuts.register` throws on a conflicting or reserved default. If that
  // throw escaped, this entry would fail to activate and the Web shell would
  // show "Failed to load plugins" instead of the app. The card must survive.
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  let recorded
  try {
    ;({ recorded } = applyPlugin({ throwOnShortcut: true }))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(recorded.shortcuts.length, 0, 'the shortcut is not registered')
  assert.equal(recorded.tabTypes.length, 1, 'the tab type still registers')
  assert.equal(recorded.resources.length, 1, 'the resource provider still registers')
  assert.equal(recorded.slots.length, 4, 'every slot still registers')
  assert.equal(warnings.length, 1, 'the failure is reported once')
  assert.match(String(warnings[0][0]), /shortcut could not be registered/)
})
