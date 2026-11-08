/**
 * dsh-plugin-aside — host entry point.
 *
 * Most of Aside lives in the browser: the right-sidebar tab type, the
 * start-page card, the forked `dsh-resource://` address and the embedded
 * conversation. That half needs nothing from the host, because forking a
 * conversation is `ctx.sessions.fork(...)` — a call the Web client already
 * exposes.
 *
 * This half exists for the one direction the browser cannot reach on its own: a
 * message travelling **from** a side chat **back to** the conversation it was
 * forked from. DSH records no parent link on a fork (its header carries only
 * `isSeeded`, its end-seed event only `{ inherited: true }`), so the browser
 * posts the relationship here and the host keeps it in a small durable table.
 * One tool, `aside_tell_main`, reads that table; outside a tracked side chat it
 * refuses.
 *
 * Nothing here touches the system prompt, and no tokens are spent unless a side
 * chat's agent decides to call the tool.
 *
 * @module dsh-plugin-aside
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createLinkStore } from './src/link-store.js'
import { registerLinkRoute } from './src/link-route.js'
import { createTellMainTool } from './src/tell-main.js'

/** Diagnostic name used by the loader, the logger and the plugin inventory. */
export const name = 'aside'

/**
 * `tools` and `agents` are core in every composition that can host a
 * conversation: the tool needs both, and Cordis only exposes an injected service
 * on `ctx`. The connection is optional and waited for separately inside the
 * route registration, so a headless composition still activates.
 */
export const inject = ['tools', 'agents']

/**
 * Read the persisted link table, tolerating a missing or corrupt file.
 *
 * @param {string} path - JSON file path.
 * @returns {Record<string, string>} the links, or an empty record.
 */
function readLinks(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write the link table atomically (temp file + rename), so a crash mid-write
 * cannot leave a truncated table behind.
 *
 * @param {string} path - JSON file path.
 * @param {Record<string, string>} links - the links.
 * @returns {void}
 */
function writeLinks(path, links) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(links), 'utf8')
    renameSync(temporary, path)
  } catch {
    // Persistence is a convenience (it survives restarts); losing it must never
    // break the live relay, which only needs the in-memory table.
  }
}

/**
 * Register the link route and the relay tool.
 *
 * @param {object} ctx - plugin context.
 * @returns {() => void} composite disposer.
 */
export function apply(ctx) {
  const home = typeof ctx.dshHomePath === 'function' ? ctx.dshHomePath('aside') : undefined
  const path = home === undefined ? undefined : join(home, 'links.json')
  const store = createLinkStore(path === undefined ? {} : readLinks(path))

  let timer
  const persist = () => {
    if (path === undefined) return
    if (timer !== undefined) clearTimeout(timer)
    // Coalesce bursts (a user opening several side chats) into one write.
    timer = setTimeout(() => {
      timer = undefined
      writeLinks(path, store.snapshot())
    }, 250)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // The route writes through the store; wrap `set` before anything can call it
  // so persistence follows every accepted link without the route knowing about
  // the filesystem.
  const setLink = store.set
  store.set = (childId, parentId) => {
    const link = setLink(childId, parentId)
    persist()
    return link
  }

  registerLinkRoute(ctx, store)
  const disposeTool = ctx.tools.register(createTellMainTool(ctx, store))

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    try {
      disposeTool()
    } catch {}
    persist()
  }
}

export default { name, inject, apply }
