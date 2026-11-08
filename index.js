/**
 * dsh-plugin-aside — host entry point.
 *
 * Most of Aside lives in the browser: the right-sidebar tab type, the
 * start-page card, the forked `dsh-resource://` address and the embedded
 * conversation. That half needs nothing from the host, because forking a
 * conversation is `ctx.sessions.fork(...)` — a call the Web client already
 * exposes.
 *
 * This half exists for the one direction the browser cannot reach: a message
 * travelling **from** a side chat **back to** the conversation it was forked
 * from. That needs a live agent inbox, which is a host concern. It is one tool,
 * `aside_tell_main`, and it refuses to do anything outside an Aside side chat.
 *
 * Nothing here touches the system prompt, and no turn is spent unless a side
 * chat's agent decides to call the tool.
 *
 * @module dsh-plugin-aside
 */

import { createTellMainTool } from './src/tell-main.js'

/** Diagnostic name used by the loader, the logger and the plugin inventory. */
export const name = 'aside'

/**
 * `tools` is core in every composition that can host a conversation. The agent
 * registry and session query are read with `ctx.get(...)` instead, so a
 * composition without them still activates and the tool simply reports that it
 * cannot relay.
 */
export const inject = ['tools']

/**
 * Register the side-chat relay tool.
 *
 * @param {object} ctx - plugin context.
 * @returns {() => void} disposer for the registration.
 */
export function apply(ctx) {
  return ctx.tools.register(createTellMainTool(ctx))
}

export default { name, inject, apply }
