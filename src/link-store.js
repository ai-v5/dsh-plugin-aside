/**
 * The side-chat link table: which conversation each side chat was forked from.
 *
 * DSH does not persist this relationship. A fork's session header carries
 * `isSeeded: true` but no parent, and its `session/end-seed` event records only
 * `{ inherited: true }`. The parent identity lives in the browser, which encodes
 * it in the tab's resource address — so the browser has to tell the host, and
 * this is what it tells it to.
 *
 * Kept deliberately dumb: a validated map plus a snapshot the plugin persists.
 * No TTL, no eviction — a side chat is a real session and its link is as durable
 * as the session itself.
 *
 * @module dsh-plugin-aside/link-store
 */

/**
 * Error raised for a malformed link request, so the route can answer 400 without
 * leaking internals.
 */
export class LinkError extends Error {
  /**
   * @param {string} message - what is wrong.
   */
  constructor(message) {
    super(message)
    this.name = 'LinkError'
  }
}

/**
 * Validate two session ids that are supposed to be linked.
 *
 * @param {unknown} childId - the side chat.
 * @param {unknown} parentId - the conversation it was forked from.
 * @returns {{ childId: string, parentId: string }} the trimmed pair.
 */
export function parseLink(childId, parentId) {
  if (typeof childId !== 'string' || childId.trim().length === 0) throw new LinkError('childId must be a non-empty string')
  if (typeof parentId !== 'string' || parentId.trim().length === 0) throw new LinkError('parentId must be a non-empty string')
  const child = childId.trim()
  const parent = parentId.trim()
  if (child === parent) throw new LinkError('a session cannot be forked from itself')
  return { childId: child, parentId: parent }
}

/**
 * Create the link table.
 *
 * @param {Record<string, string>} [initial] - persisted links to start from.
 * @returns {object} the store.
 */
export function createLinkStore(initial = {}) {
  const links = new Map()
  if (initial !== null && typeof initial === 'object') {
    for (const [childId, parentId] of Object.entries(initial)) {
      try {
        const parsed = parseLink(childId, parentId)
        links.set(parsed.childId, parsed.parentId)
      } catch {
        // A corrupted row is dropped rather than failing plugin activation.
      }
    }
  }

  return {
    /**
     * Record one link, replacing any previous row for the same side chat.
     *
     * @param {unknown} childId - the side chat.
     * @param {unknown} parentId - the conversation it was forked from.
     * @returns {{ childId: string, parentId: string }} the stored pair.
     */
    set(childId, parentId) {
      const parsed = parseLink(childId, parentId)
      links.set(parsed.childId, parsed.parentId)
      return parsed
    },

    /**
     * Resolve the conversation a side chat was forked from.
     *
     * @param {string} childId - the side chat.
     * @returns {string | undefined} the parent session id.
     */
    get(childId) {
      return typeof childId === 'string' ? links.get(childId) : undefined
    },

    /**
     * Drop one link.
     *
     * @param {string} childId - the side chat.
     * @returns {boolean} whether a row was removed.
     */
    delete(childId) {
      return links.delete(childId)
    },

    /** How many links are known. */
    get size() {
      return links.size
    },

    /**
     * A plain object suitable for JSON persistence.
     *
     * @returns {Record<string, string>} every link.
     */
    snapshot() {
      return Object.fromEntries(links)
    },
  }
}
