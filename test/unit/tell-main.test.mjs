import assert from 'node:assert/strict'
import test from 'node:test'

import { createLinkStore } from '../../src/link-store.js'
import {
  AsideRelayError,
  OUTPUT_SCHEMA,
  PARAMETERS_SCHEMA,
  RELAY_MARK,
  TOOL_NAME,
  buildRelayedMessage,
  buildRelayedText,
  createTellMainTool,
  deliver,
  resolveParentSessionId,
} from '../../src/tell-main.js'

/**
 * Build a plugin context whose agent registry is a recording fake.
 *
 * @param {object} [options] - overrides.
 * @param {boolean} [options.noAgents] - omit the agent registry.
 * @param {object} [options.parentAgent] - explicit parent agent.
 * @returns {object} `{ ctx, calls }`.
 */
function fakeCtx(options = {}) {
  const calls = { got: [], followups: [], steers: [] }
  const parentAgent =
    options.parentAgent === undefined
      ? {
          followup: (message) => calls.followups.push(message),
          steer: (message) => calls.steers.push(message),
        }
      : options.parentAgent
  const ctx = {
    get: () => undefined,
    tools: { register: (definition) => definition },
  }
  if (options.noAgents !== true) {
    ctx.agents = {
      get(id) {
        calls.got.push(id)
        return parentAgent
      },
    }
  }
  return { calls, ctx }
}

/** A store that knows one side chat. */
const linkedStore = () => createLinkStore({ 'session-side': 'session-main' })

/** A stand-in tool execution context carrying the side-chat agent. */
const exec = { agent: { id: 'session-side' } }

test('the message text always carries the side-chat mark', () => {
  assert.equal(buildRelayedText('do it'), `${RELAY_MARK}\ndo it`)
  assert.ok(buildRelayedText('  padded  ').endsWith('padded'))
})

test('an empty body is refused instead of sending a blank turn', () => {
  for (const value of ['', '   ', undefined, null, 42]) {
    assert.throws(() => buildRelayedText(value), (error) => error instanceof AsideRelayError && error.code === 'EMPTY_MESSAGE')
  }
})

test('the message is a user-role message with agent-message provenance', () => {
  const message = buildRelayedMessage({ body: 'hello', senderSessionId: 'session-side' })
  assert.equal(message.role, 'user')
  assert.ok(Object.isFrozen(message))
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.content, [{ type: 'text', text: `${RELAY_MARK}\nhello` }])
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'session-side' })
})

test('two messages never share an id', () => {
  const a = buildRelayedMessage({ body: 'x', senderSessionId: 's' })
  const b = buildRelayedMessage({ body: 'x', senderSessionId: 's' })
  assert.notEqual(a.id, b.id)
})

test('resolveParentSessionId reads the link table', () => {
  assert.equal(resolveParentSessionId(linkedStore(), 'session-side'), 'session-main')
})

test('resolveParentSessionId refuses an unlinked session', () => {
  assert.throws(
    () => resolveParentSessionId(createLinkStore(), 'session-side'),
    (error) => error instanceof AsideRelayError && error.code === 'NOT_A_SIDE_CHAT',
  )
})

test('resolveParentSessionId refuses a missing session id', () => {
  assert.throws(
    () => resolveParentSessionId(linkedStore(), undefined),
    (error) => error.code === 'NO_SESSION',
  )
})

test('deliver uses the queue lane by default and steer on request', () => {
  const calls = []
  const agent = { followup: (m) => calls.push(['followup', m]), steer: (m) => calls.push(['steer', m]) }
  const message = { id: 'm' }
  assert.equal(deliver(agent, message, 'queue'), 'queue')
  assert.equal(deliver(agent, message, 'steer'), 'steer')
  assert.deepEqual(calls, [
    ['followup', message],
    ['steer', message],
  ])
})

test('deliver refuses an agent that cannot take the requested lane', () => {
  assert.throws(() => deliver({}, {}, 'queue'), (error) => error.code === 'UNSUPPORTED')
  assert.throws(() => deliver({ followup() {} }, {}, 'steer'), (error) => error.code === 'UNSUPPORTED')
})

test('the schemas stay in the restricted dialect', () => {
  assert.equal(PARAMETERS_SCHEMA.additionalProperties, false)
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false)
  assert.deepEqual(PARAMETERS_SCHEMA.required, ['message'])
  assert.equal(TOOL_NAME, 'aside_tell_main')
})

test('executing relays into the parent agent by default', async () => {
  const { ctx, calls } = fakeCtx()
  const tool = createTellMainTool(ctx, linkedStore())
  const value = await tool.execute({ message: 'please merge the PR' }, exec)

  assert.deepEqual(value, { parentSessionId: 'session-main', mode: 'queue' })
  assert.deepEqual(calls.got, ['session-main'])
  assert.equal(calls.steers.length, 0)
  assert.equal(calls.followups.length, 1)
  const [message] = calls.followups
  assert.equal(message.source.senderSessionId, 'session-side')
  assert.ok(message.content[0].text.startsWith(RELAY_MARK))
  assert.ok(message.content[0].text.includes('please merge the PR'))
})

test('executing with mode=steer interrupts the main conversation', async () => {
  const { ctx, calls } = fakeCtx()
  const tool = createTellMainTool(ctx, linkedStore())
  assert.deepEqual(await tool.execute({ message: 'stop, wrong branch', mode: 'steer' }, exec), {
    parentSessionId: 'session-main',
    mode: 'steer',
  })
  assert.equal(calls.followups.length, 0)
  assert.equal(calls.steers.length, 1)
})

test('an unknown mode falls back to queue rather than failing', async () => {
  const { ctx, calls } = fakeCtx()
  const tool = createTellMainTool(ctx, linkedStore())
  assert.deepEqual(await tool.execute({ message: 'hi', mode: 'nonsense' }, exec), {
    parentSessionId: 'session-main',
    mode: 'queue',
  })
  assert.equal(calls.followups.length, 1)
})

test('executing outside a tracked side chat refuses and sends nothing', async () => {
  const { ctx, calls } = fakeCtx()
  const tool = createTellMainTool(ctx, createLinkStore())
  await assert.rejects(() => tool.execute({ message: 'hi' }, exec), (error) => error.code === 'NOT_A_SIDE_CHAT')
  assert.equal(calls.followups.length, 0)
})

test('executing while the main conversation is closed reports that instead of dropping the message', async () => {
  const ctx = { get: () => undefined, tools: {}, agents: { get: () => undefined } }
  const tool = createTellMainTool(ctx, linkedStore())
  await assert.rejects(() => tool.execute({ message: 'hi' }, exec), (error) => error.code === 'MAIN_DETACHED')
})

test('executing without an agent fails cleanly', async () => {
  const { ctx } = fakeCtx()
  const tool = createTellMainTool(ctx, linkedStore())
  await assert.rejects(() => tool.execute({ message: 'hi' }, {}), (error) => error.code === 'NO_AGENT')
})

test('executing without the agent registry reports unavailability', async () => {
  const { ctx } = fakeCtx({ noAgents: true })
  const tool = createTellMainTool(ctx, linkedStore())
  await assert.rejects(() => tool.execute({ message: 'hi' }, exec), (error) => error.code === 'UNAVAILABLE')
})

test('an empty message is refused before any delivery', async () => {
  const { ctx, calls } = fakeCtx()
  const tool = createTellMainTool(ctx, linkedStore())
  await assert.rejects(() => tool.execute({ message: '   ' }, exec), (error) => error.code === 'EMPTY_MESSAGE')
  assert.equal(calls.followups.length, 0)
})

test('the output renderer speaks both lanes', () => {
  const tool = createTellMainTool(fakeCtx().ctx, linkedStore())
  for (const mode of ['queue', 'steer']) {
    const blocks = tool.output.render({}, { parentSessionId: 'session-main', mode })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('session-main'))
  }
})
