import assert from 'node:assert/strict'
import test from 'node:test'

import { createLinkStore } from '../../src/link-store.js'
import {
  SECTION_NAME,
  SECTION_ORDER,
  buildSideChatNotice,
  createIdentitySection,
} from '../../src/identity-section.js'

const PARENT = 'session-main-0001'
const CHILD = 'session-side-0002'

/**
 * Build a store with one side chat registered.
 *
 * @returns {object} the link store.
 */
function storeWithOneSideChat() {
  const store = createLinkStore()
  store.set(CHILD, PARENT)
  return store
}

test('the section has a stable name and sits right after the deployment persona', () => {
  assert.equal(SECTION_NAME, 'aside:side-chat')
  // DEPLOYMENT_PERSONA_PREFIX is 0 and PLAN_POLICY is 500 in dsh-system-prompt.
  assert.ok(SECTION_ORDER > 0 && SECTION_ORDER < 500, 'between the persona and the plan policy')
})

test('the notice names the parent conversation and the way back', () => {
  const notice = buildSideChatNotice(PARENT)
  assert.ok(notice.includes(PARENT), 'the parent id is what makes the relay actionable')
  assert.ok(notice.includes('aside_tell_main'), 'the agent must learn which tool reports back')
  assert.ok(notice.split('\n').length <= 3, 'this text is charged on every turn; keep it short')
})

test('a linked side chat renders its notice', () => {
  const section = createIdentitySection(storeWithOneSideChat())
  const text = section.text({ agent: { id: CHILD } })
  assert.equal(text, buildSideChatNotice(PARENT))
})

test('an ordinary conversation renders nothing', () => {
  // This is the property that keeps the section from costing main conversations
  // anything: an empty string, which renderPrompt() filters out before joining.
  const section = createIdentitySection(storeWithOneSideChat())
  assert.equal(section.text({ agent: { id: 'session-unrelated' } }), '')
  assert.equal(section.text({ agent: { id: PARENT } }), '', 'the parent is not itself a side chat')
})

test('a global assembly renders nothing', () => {
  const section = createIdentitySection(storeWithOneSideChat())
  assert.equal(section.text({}), '')
  assert.equal(section.text({ agent: undefined }), '')
  assert.equal(section.text(undefined), '')
  assert.equal(section.text({ agent: { id: '' } }), '')
  assert.equal(section.text({ agent: { id: 42 } }), '')
})

test('the text is literal, so generated ids are never interpolated', () => {
  const section = createIdentitySection(storeWithOneSideChat())
  assert.equal(section.interpolate, false)
})

test('each side chat sees its own parent', () => {
  const store = createLinkStore()
  store.set('side-a', 'main-a')
  store.set('side-b', 'main-b')
  const section = createIdentitySection(store)
  assert.ok(section.text({ agent: { id: 'side-a' } }).includes('main-a'))
  assert.ok(section.text({ agent: { id: 'side-b' } }).includes('main-b'))
  assert.ok(!section.text({ agent: { id: 'side-a' } }).includes('main-b'))
})

test('the section reads the live table, so a link registered after activation still works', () => {
  // The browser announces the link after the fork exists, which may be after
  // this plugin activated. Asking the table at prompt time is what makes that
  // ordering harmless.
  const store = createLinkStore()
  const section = createIdentitySection(store)
  assert.equal(section.text({ agent: { id: CHILD } }), '')
  store.set(CHILD, PARENT)
  assert.equal(section.text({ agent: { id: CHILD } }), buildSideChatNotice(PARENT))
})
