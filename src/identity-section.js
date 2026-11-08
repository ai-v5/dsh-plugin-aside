/**
 * A side chat's self-knowledge.
 *
 * A fork inherits history but nothing about *itself*: its header says a session
 * was seeded, never what it was seeded from, and the agent inside it assembles
 * the same prompt as the conversation it branched off. So a side chat behaves
 * like a main conversation that happens to have amnesia about where it sits —
 * it has no reason to report anything back, and `aside_tell_main` is a tool it
 * would never think to call.
 *
 * This section supplies the missing self-description. It is registered once,
 * globally, and computes its text per assembly from the link table: a session
 * the host never linked to a parent renders the empty string, and the prompt
 * renderer drops empty sections before joining, so every other conversation is
 * untouched and costs nothing.
 *
 * Rendering per assembly is also what makes this race-free. Attaching a section
 * when the fork is created would race the browser's link announcement; asking
 * the link table at prompt time cannot.
 *
 * @module dsh-plugin-aside/identity-section
 */

/** Section name, unique within its scope. */
export const SECTION_NAME = 'aside:side-chat'

/**
 * Prompt position: just after the deployment persona (`0`) and before the plan
 * and team policies (`500` / `600`). Which conversation you are in should frame
 * the policies that follow it, not trail them.
 */
export const SECTION_ORDER = 100

/**
 * Compose what a side chat is told about itself.
 *
 * Kept to three sentences: this text lands in every request the side chat makes,
 * so it is charged on every turn of that conversation.
 *
 * @param {string} parentSessionId - the conversation this side chat was forked from.
 * @returns {string} the section text.
 */
export function buildSideChatNotice(parentSessionId) {
  return [
    `This conversation is an Aside side chat: it was forked from the conversation "${parentSessionId}".`,
    'That conversation does not see what happens here, and nothing done here changes its next turn.',
    'When this conversation settles something that conversation needs — a conclusion, a decision, a blocker — call aside_tell_main with a complete, self-contained instruction. Otherwise stay here.',
  ].join('\n')
}

/**
 * Build the section definition for `ctx.systemPrompt.section(...)`.
 *
 * @param {{ get(childId: string): string | undefined }} store - the link table.
 * @param {{ order?: number }} [options] - position override, mainly for tests.
 * @returns {{ name: string, order: number, interpolate: boolean, text: (context: object) => string }} the section definition.
 */
export function createIdentitySection(store, options = {}) {
  return {
    name: SECTION_NAME,
    order: options.order ?? SECTION_ORDER,
    // The text is assembled from a session id, not from prompt variables; braces
    // in a generated id must stay literal instead of failing interpolation.
    interpolate: false,
    text(context) {
      const agentId = context === undefined || context === null ? undefined : context.agent?.id
      if (typeof agentId !== 'string' || agentId.length === 0) return ''
      const parent = store.get(agentId)
      return typeof parent === 'string' && parent.length > 0 ? buildSideChatNotice(parent) : ''
    },
  }
}
