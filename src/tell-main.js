/**
 * `aside_tell_main` — the side chat's way back to the conversation it came from.
 *
 * A side chat is a fork: an ordinary, independent session. DSH does not record
 * the parent anywhere durable, so the browser posts that relationship to the
 * host when it forks (see `link-store.js` / `link-route.js`). This tool is the
 * consumer of that table.
 *
 * Delivery reuses the same admission path the Web client's composer uses
 * (`agent.followup` / `agent.steer` splice into the target agent's inbox), so an
 * injected message behaves exactly like a typed one — and that is precisely why
 * provenance is carried explicitly:
 *
 *  - the message's `source` is `{ kind: 'agent-message', form: 'relay',
 *    senderSessionId }`, the channel DSH already uses for one agent relaying to
 *    another, so nothing invents a new event type;
 *  - the text itself is prefixed, because a reader who only sees the transcript
 *    must not mistake it for the human's own words.
 *
 * If no link is known the tool refuses. It never delivers to a guessed target.
 *
 * @module dsh-plugin-aside/tell-main
 */

import { randomUUID } from 'node:crypto'

/** Tool name as the model sees it. */
export const TOOL_NAME = 'aside_tell_main'

/** Prefix that keeps an injected line from passing as the human's own words. */
export const RELAY_MARK = '【来自旁聊 · from side chat】'

/** Error carrying a stable code, so the tool reply can be specific. */
export class AsideRelayError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'AsideRelayError'
    this.code = code
  }
}

/**
 * Compose the delivered text.
 *
 * @param {string} body - what the side chat wants the main conversation to know.
 * @returns {string} the marked text.
 */
export function buildRelayedText(body) {
  const trimmed = typeof body === 'string' ? body.trim() : ''
  if (trimmed.length === 0) throw new AsideRelayError('EMPTY_MESSAGE', 'The message to the main conversation is empty.')
  return `${RELAY_MARK}\n${trimmed}`
}

/**
 * Build the user-role message the target agent will accept.
 *
 * Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm` (`{ ...input, role:
 * 'user' }` plus a fresh id) without importing it, so this plugin keeps zero
 * runtime dependencies.
 *
 * @param {object} options - message inputs.
 * @param {string} options.body - message text.
 * @param {string} options.senderSessionId - the side chat this came from.
 * @returns {object} a frozen user message.
 */
export function buildRelayedMessage({ body, senderSessionId }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: buildRelayedText(body) }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  })
}

/**
 * Resolve which conversation a side chat reports back to.
 *
 * @param {object} store - the link table.
 * @param {string} childId - the calling session.
 * @returns {string} the parent session id.
 */
export function resolveParentSessionId(store, childId) {
  if (typeof childId !== 'string' || childId.length === 0) {
    throw new AsideRelayError('NO_SESSION', 'The current session could not be read.')
  }
  const parent = store.get(childId)
  if (parent === undefined) {
    throw new AsideRelayError(
      'NOT_A_SIDE_CHAT',
      'This session is not a tracked side chat, so there is no main conversation to report back to. Side chats created before this plugin recorded links cannot relay.',
    )
  }
  return parent
}

/** Output schema shared by the tool definition and its tests. */
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    parentSessionId: { type: 'string' },
    mode: { type: 'string', enum: ['queue', 'steer'] },
  },
  required: ['parentSessionId', 'mode'],
})

/** Parameter schema as the restricted JSON-Schema dialect requires it. */
export const PARAMETERS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        "What the main conversation should know or do. Write it as a complete instruction; the main agent sees it without this conversation's context.",
    },
    mode: {
      type: 'string',
      enum: ['queue', 'steer'],
      description: "queue (default) waits for the main conversation's current turn to finish; steer interrupts it.",
    },
  },
  required: ['message'],
})

/**
 * Deliver one message into a target agent's inbox.
 *
 * @param {object} agent - the live target agent (exposes `followup` / `steer`).
 * @param {object} message - the frozen user message.
 * @param {'queue' | 'steer'} mode - which inbox lane to use.
 * @returns {'queue' | 'steer'} the mode actually used.
 */
export function deliver(agent, message, mode) {
  if (mode === 'steer') {
    if (typeof agent.steer !== 'function') throw new AsideRelayError('UNSUPPORTED', 'This agent cannot be interrupted.')
    agent.steer(message)
    return 'steer'
  }
  if (typeof agent.followup !== 'function') throw new AsideRelayError('UNSUPPORTED', 'This agent cannot accept a queued message.')
  agent.followup(message)
  return 'queue'
}

/**
 * Build the tool definition.
 *
 * Services are read lazily so a composition without agent support still loads
 * this plugin (the tool then reports that fact instead of failing activation).
 *
 * @param {object} ctx - the plugin context.
 * @param {object} store - the link table.
 * @returns {object} a `ctx.tools.register` definition.
 */
export function createTellMainTool(ctx, store) {
  const normalizeMode = (value) => (value === 'steer' ? 'steer' : 'queue')
  return {
    name: TOOL_NAME,
    description:
      'Send a message from this side chat back to the main conversation it was forked from. Only available inside an Aside side chat. The main conversation receives it as a relayed message from this side chat, not as the user typing.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [
          {
            type: 'text',
            text:
              value.mode === 'steer'
                ? `已打断主线程并投递消息（${value.parentSessionId}）`
                : `已排队投递给主线程（${value.parentSessionId}），它在当前轮结束后收到`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) {
        throw new AsideRelayError('NO_AGENT', 'There is no live agent for this session.')
      }
      const agents = ctx.agents
      if (agents === undefined || agents === null) {
        throw new AsideRelayError('UNAVAILABLE', 'This composition exposes no agent registry to relay through.')
      }

      const parentSessionId = resolveParentSessionId(store, agent.id)

      const parentAgent = agents.get(parentSessionId)
      if (parentAgent === undefined || parentAgent === null) {
        throw new AsideRelayError(
          'MAIN_DETACHED',
          `The main conversation "${parentSessionId}" is not currently open, so it cannot receive the message. Reopen it and try again.`,
        )
      }

      const message = buildRelayedMessage({ body: args?.message, senderSessionId: agent.id })
      const mode = deliver(parentAgent, message, normalizeMode(args?.mode))
      return { parentSessionId, mode }
    },
  }
}
