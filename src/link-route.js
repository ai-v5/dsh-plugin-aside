/**
 * The one HTTP route Aside registers: the browser telling the host which
 * conversation a side chat was forked from.
 *
 * Same shape DSH's own file upload uses — an exact path on the connection's
 * fetch registry, a standard `Request` in, a standard `Response` out, owner-only
 * by construction because the registry already refuses other principals.
 *
 * @module dsh-plugin-aside/link-route
 */

import { LinkError } from './link-store.js'

/** Exact route path; must start with `/api/` and use only URL-safe segments. */
export const LINK_PATH = '/api/aside/link'

/**
 * JSON response helper.
 *
 * @param {unknown} body - payload.
 * @param {number} status - HTTP status.
 * @returns {Response} the response.
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Handle one link request.
 *
 * Kept free of plugin state beyond the store so it can be exercised directly.
 *
 * @param {object} store - the link table (`createLinkStore`).
 * @param {Request} request - the incoming request.
 * @returns {Promise<Response>} the response.
 */
export async function handleLinkRequest(store, request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })

  let payload
  try {
    payload = await request.json()
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ ok: false, error: 'body must be a JSON object' }, 400)
  }

  try {
    const link = store.set(payload.childId, payload.parentId)
    return json({ ok: true, ...link }, 201)
  } catch (error) {
    if (error instanceof LinkError) return json({ ok: false, error: error.message }, 400)
    return json({ ok: false, error: 'link rejected' }, 400)
  }
}

/**
 * Register the route once this composition has a connection.
 *
 * `connection` is a service other plugins *inject*, not one that
 * `ctx.get('connection')` reaches from an arbitrary scope, so the registration
 * waits for it through `ctx.inject` instead of probing for it. Headless and CLI
 * compositions never provide it: there the effect simply never runs, no route
 * exists, and the tool has no links and fails closed — the correct degradation.
 *
 * @param {object} ctx - plugin context.
 * @param {object} store - the link table.
 * @returns {void}
 */
export function registerLinkRoute(ctx, store) {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () =>
        connectionCtx.connection.fetch.register({
          path: LINK_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleLinkRequest(store, request),
        }),
      'aside:link-route',
    )
  })
}
