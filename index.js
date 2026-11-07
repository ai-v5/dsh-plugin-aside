/**
 * dsh-plugin-aside — host entry point.
 *
 * Aside is a **client-side plugin**. Everything it does happens in the browser:
 * the right-sidebar tab type, the start-page card, the forked `dsh-resource://`
 * address, and the embedded conversation. The fork itself is
 * `ctx.sessions.fork(...)`, a session-controller call the Web client already
 * exposes (the chat's own "branch here" action uses it), so no host RPC, no
 * custom route and no server-side state is involved.
 *
 * This module therefore exists for exactly one reason: a profile bundle row
 * (`dsh.bundle.patch`) must resolve to a Cordis plugin, and that row is what
 * makes the profile — and the Web client's module graph — aware of the package
 * at all. It is deliberately inert:
 *
 *  - it registers no system-prompt section, no tool and no command, so Aside
 *    adds **zero model surface** and costs **zero tokens**;
 *  - it holds no configuration, because a host-side switch could not change a
 *    browser-side behaviour and a switch that lies is worse than none;
 *  - it has no `inject`, so it activates even in headless compositions.
 *
 * If a future version needs host work (for example asking a side chat a
 * question from the main thread), that belongs here — behind a real feature,
 * not as speculative scaffolding.
 *
 * @module dsh-plugin-aside
 */

/** Diagnostic name used by the loader, the logger and the plugin inventory. */
export const name = 'aside'

/**
 * Cordis entry point. Intentionally empty: everything this plugin contributes is
 * registered by the browser half (`./client.js`).
 *
 * @returns {void}
 */
export function apply() {}

export default { name, apply }
