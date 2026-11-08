/**
 * Aside (旁白) — browser half.
 *
 * Adds a first-class right-sidebar tab type that renders a *fork* of the current
 * conversation: a real child session whose history was copied from the main
 * thread at the moment of creation, shown with the native transcript and
 * composer inside the sidebar. Talking to it never touches the main thread.
 *
 * Three registration stages, all owned by this module's Cordis fiber:
 *  1. a `dsh-resource://asidechat/session/<child>?parent=<parent>` resource
 *     provider, which retains the child `SessionReference` for exactly as long
 *     as the tab holds its address;
 *  2. the `asidechat` sidebar tab type plus its start-page (guide) card;
 *  3. the tab body, which binds the retained reference through `SessionProvider`
 *     and then renders the shared `conversation.content` factory in its
 *     `embedded` variant with the Chat view pinned.
 *
 * The fork itself is `ctx.sessions.fork(...)` — the same client API the chat's
 * own "branch here" action uses — so no host RPC, no codegen and no extra
 * dependency is involved.
 *
 * Contract notes (verified against `@deepseek-ai/dsh-client-ui-subagent`, which
 * ships the same shape for subagent children):
 *  - the factory id equals the package name;
 *  - React and the UI primitives come from the browser module table;
 *  - `renderSlot` / `SessionProvider` are injected only for child slots this
 *    entry declares itself;
 *  - every resource is registered through `ctx.effect`.
 *
 * @module dsh-plugin-aside/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-aside',
  factory(require) {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace of this plugin's visible strings. */
    const NS = 'aside'
    /** Identity of this module: the sidebar tab type id and every slot key. */
    const PLUGIN_ID = 'dsh-plugin-aside'
    /** The single sidebar tab kind this plugin owns. */
    const KIND = 'asidechat'
    /** Resource protocol carrying one forked session per address. */
    const PROTOCOL = 'asidechat'
    /** Canonical resource address prefix. */
    const ADDRESS_PREFIX = 'dsh-resource://asidechat/session/'
    /** Child slot this tab body declares for its own conversation surface. */
    const CONVERSATION_SLOT = 'aside.chat.conversation'
    /** Shortcut id of "new side chat". */
    const SHORTCUT_ID = 'aside.new'
    /** Document-relative host route that records the fork relationship. */
    const LINK_ANNOUNCE_PATH = 'api/aside/link'

    /** Simplified Chinese copy. */
    const zh = {
      'guide.new': '新建旁聊',
      'guide.description': '把当前对话分叉到右侧栏',
      'guide.working': '正在分叉…',
      'guide.failed': '分叉失败：{message}',
      'guide.retry': '重试',
      'guide.noSession': '请先选择一个对话',
      'tab.title': '旁白',
      'tab.fallbackTitle': '侧聊',
      'tab.loading': '正在打开旁聊…',
      'tab.unavailable': '这个旁聊已经不存在了',
    }

    /** English copy. */
    const en = {
      'guide.new': 'New side chat',
      'guide.description': 'Fork this conversation into the sidebar',
      'guide.working': 'Forking…',
      'guide.failed': 'Fork failed: {message}',
      'guide.retry': 'Retry',
      'guide.noSession': 'Select a conversation first',
      'tab.title': 'Aside',
      'tab.fallbackTitle': 'Side chat',
      'tab.loading': 'Opening the side chat…',
      'tab.unavailable': 'This side chat no longer exists',
    }

    // ---------------------------------------------------------------- address

    /**
     * Build the canonical sidebar address for one forked session.
     *
     * @param {string} childSessionId - the forked session.
     * @param {string} [parentSessionId] - the conversation it was forked from.
     * @returns {string} `dsh-resource://asidechat/session/<child>?parent=<parent>`.
     */
    function asideAddress(childSessionId, parentSessionId) {
      const query = parentSessionId === undefined ? '' : `?${new URLSearchParams({ parent: parentSessionId })}`
      return `${ADDRESS_PREFIX}${encodeURIComponent(childSessionId)}${query}`
    }

    /**
     * Parse one sidebar address back into the identities it carries.
     *
     * @param {unknown} value - possible address.
     * @returns {{ childSessionId: string, parentSessionId?: string } | undefined} the address, or `undefined` when it belongs to another protocol or is malformed.
     */
    function parseAsideAddress(value) {
      if (typeof value !== 'string' || value.length === 0) return undefined
      let url
      try {
        url = new URL(value)
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      let childSessionId
      try {
        childSessionId = decodeURIComponent(parts[1])
      } catch {
        return undefined
      }
      if (childSessionId.length === 0) return undefined
      const parent = url.searchParams.get('parent')
      return parent === null || parent.length === 0 ? { childSessionId } : { childSessionId, parentSessionId: parent }
    }

    /**
     * Format a thrown value for display.
     *
     * @param {unknown} error - anything thrown.
     * @returns {string} a short human-readable message.
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      if (typeof error === 'string') return error
      return String(error)
    }

    /**
     * Resolve once the given signal aborts.
     *
     * @param {AbortSignal} signal - resource lifetime.
     * @returns {Promise<void>} resolved on abort.
     */
    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    /**
     * Tell the host which conversation a side chat was forked from.
     *
     * DSH does not persist that relationship (`sessions.fork` writes
     * `isSeeded: true` and an end-seed event of `{ inherited: true }`, but no
     * parent id), so the host cannot answer "who is this side chat's parent?"
     * on its own. This is the one fact the browser has to hand over; the host
     * keeps it in `links.json` and `aside_tell_main` reads it from there.
     *
     * Best effort by design: a failure here costs the relay tool for this side
     * chat, never the side chat itself.
     *
     * @param {string} childId - the forked session.
     * @param {string} parentId - the conversation it was forked from.
     * @returns {Promise<boolean>} whether the host accepted the link.
     */
    async function announceLink(childId, parentId) {
      if (typeof document === 'undefined' || typeof fetch !== 'function') return false
      try {
        // Document-relative, mirroring `dsh-client-file-upload`, so a path prefix
        // in front of the UI keeps working.
        const url = new URL(LINK_ANNOUNCE_PATH, document.baseURI)
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ childId, parentId }),
        })
        if (!response.ok) {
          console.warn(`[aside] the host rejected the side-chat link (${response.status}); aside_tell_main will be unavailable in this tab.`)
          return false
        }
        return true
      } catch (error) {
        console.warn('[aside] could not tell the host which conversation this side chat came from; aside_tell_main will be unavailable here.', error)
        return false
      }
    }

    // ----------------------------------------------------------------- styles

    /** Unique class prefix; the injected stylesheet is deduplicated by tag id. */
    const CSS_TAG_ID = `${PLUGIN_ID}/aside.module.css`
    /** Card and body styling. Tokens only, so light and dark follow the host theme. */
    const CSS_TEXT = [
      '.aside-guide-entry{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsl-guide-entry-radius);background:var(--dsw-alias-bg-layer-1);align-items:center;gap:14px;width:100%;min-height:56px;padding:14px 20px;display:flex;position:relative;overflow:hidden}',
      '.aside-guide-main{border-radius:0;width:100%;height:100%;position:absolute;inset:0}',
      '.aside-guide-main:focus-visible{outline-offset:-2px}',
      '.aside-guide-icon{width:26px;height:26px;color:var(--dsw-alias-label-secondary);pointer-events:none;flex:none;justify-content:center;align-items:center;display:flex;position:relative}',
      '.aside-guide-text{pointer-events:none;flex-direction:column;flex:1;gap:3px;min-width:0;display:flex;position:relative}',
      '.aside-guide-title{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:1.4;overflow:hidden}',
      '.aside-guide-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:1.4;overflow:hidden}',
      '.aside-guide-status{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:1.4;overflow:hidden}',
      '.aside-guide-status[data-tone="error"]{color:var(--dsw-alias-label-error,var(--dsw-alias-label-secondary))}',
      '.aside-tab-root{width:100%;min-width:0;height:100%;min-height:0;display:flex}',
      '.aside-tab-notice{box-sizing:border-box;align-items:center;justify-content:center;width:100%;height:100%;padding:24px;display:flex;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    ].join('\n')

    /**
     * Install the stylesheet once per document.
     *
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------- components

    /**
     * Fork marker drawn in the card: a main thread with a branch leaving it.
     * Inline so it follows `currentColor` in both themes.
     *
     * @param {{ size?: number }} props - glyph edge length in pixels.
     * @returns {import('react').ReactElement} the glyph.
     */
    function AsideGlyph({ size = 22 }) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M4 5.5h6.6a1.6 1.6 0 0 1 1.6 1.6v9.8a1.6 1.6 0 0 1-1.6 1.6H4a1.6 1.6 0 0 1-1.6-1.6V7.1A1.6 1.6 0 0 1 4 5.5Z' }),
          jsx('path', { d: 'M15.4 8.4h4.2a1.6 1.6 0 0 1 1.6 1.6v3.4a1.6 1.6 0 0 1-1.6 1.6h-1.7l-1.9 2v-2h-.6a1.6 1.6 0 0 1-1.6-1.6V10a1.6 1.6 0 0 1 1.6-1.6Z' }),
          jsx('path', { d: 'M12.2 12h3.2' }),
          jsx('path', { d: 'M5.2 9.5h4M5.2 12h2.9M5.2 14.5h4' }),
        ],
      })
    }

    /**
     * Start-page card: forks the conversation the guide belongs to, then swaps
     * this card's tab for the side chat it produced.
     *
     * @param {object} props - owner props (`title`/`description`), the standard kit and our injected `startSideChat`.
     * @returns {import('react').ReactElement} the card.
     */
    function AsideGuideCard(props) {
      const { title, description, useTabInfo, t, startSideChat } = props
      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState('')
      const { tab } = useTabInfo()
      const tabId = tab === undefined ? undefined : tab.id
      const busy = phase === 'working'

      const start = React.useCallback(() => {
        setPhase((current) => {
          if (current === 'working') return current
          Promise.resolve()
            .then(() => startSideChat({ replaceTab: tabId }))
            .then(
              () => setPhase('idle'),
              (error) => {
                setMessage(messageOf(error))
                setPhase('failed')
              },
            )
          return 'working'
        })
      }, [startSideChat, tabId])

      const status =
        phase === 'working'
          ? { text: t('guide.working'), tone: undefined }
          : phase === 'failed'
            ? { text: t('guide.failed', { message }), tone: 'error' }
            : description === undefined
              ? undefined
              : { text: description, tone: undefined }

      return jsxs('div', {
        className: 'aside-guide-entry',
        'data-sidebar-right-guide-entry': KIND,
        children: [
          jsx(primitives.Button, {
            variant: 'ghost',
            className: 'aside-guide-main',
            'aria-label': description === undefined ? title : `${title} ${description}`,
            onClick: start,
          }),
          jsx('span', {
            className: 'aside-guide-icon',
            'aria-hidden': 'true',
            children: jsx(AsideGlyph, { size: status === undefined ? 22 : 26 }),
          }),
          jsxs('span', {
            className: 'aside-guide-text',
            children: [
              jsx('span', { className: 'aside-guide-title', 'aria-hidden': 'true', children: title }),
              status === undefined
                ? null
                : jsx('span', {
                    className: status.tone === 'error' ? 'aside-guide-status' : 'aside-guide-description',
                    'data-tone': status.tone,
                    'aria-hidden': 'true',
                    children: status.text,
                  }),
            ],
          }),
        ],
      })
    }

    /**
     * Sidebar tab body: bind the retained fork reference, then render this
     * entry's own conversation slot underneath it.
     *
     * @param {object} props - standard kit plus the session-scoped `useTabInfo` / `SessionProvider` / `renderSlot` injectables.
     * @returns {import('react').ReactElement} the tab body.
     */
    function AsideTabBody(props) {
      const { useTabInfo, useResource, SessionProvider, renderSlot, t } = props
      const { tab } = useTabInfo()
      const resource = useResource(tab.contentId)
      if (resource.value === undefined || resource.value.reference === undefined) {
        return jsx('div', {
          className: 'aside-tab-notice',
          'data-aside-status': resource.status,
          children: resource.status === 'failed' ? t('tab.unavailable') : t('tab.loading'),
        })
      }
      return jsx('div', {
        className: 'aside-tab-root',
        'data-aside-chat': resource.value.address.childSessionId,
        children: jsx(SessionProvider, {
          session: resource.value.reference,
          children: renderSlot(CONVERSATION_SLOT, {}),
        }),
      })
    }

    /**
     * Pin the shared conversation factory to its Chat view. The factory owns the
     * transcript, composer, queue and attachment pipeline; pinning `views` is
     * what turns an embedded occurrence into a plain chat surface.
     *
     * @param {object} props - local factory-kit props including `renderSlot`.
     * @returns {import('react').ReactElement} the chat view.
     */
    function FixedChatView(props) {
      return jsx(React.Fragment, { children: props.renderSlot('conversation.session', { view: 'chat' }) })
    }

    /**
     * Render the shared `conversation.content` factory against the session this
     * tab is bound to.
     *
     * The `helix` is copied from the shipped subagent sidebar chat rather than
     * invented: `phase`/`hero` are the factory's own shell contract, and
     * `variant: 'embedded'` is what drops the width drag handles.
     *
     * @param {object} props - session-scoped standard sources plus `renderFactorySlot`.
     * @returns {import('react').ReactElement} the embedded conversation.
     */
    function AsideConversationPanel(props) {
      const { sessionId, useSession, useSessions, useConversation, renderFactorySlot } = props
      const session = useSession((value) => value)
      const hasActiveTargets = useConversation === undefined ? false : useConversation((value) => value.activeTargets.size > 0)
      const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
      const shellPhase =
        hasActiveTargets || (!session.blank && !session.awaitingFirstTurn) || session.running
          ? 'active'
          : session.promptAttempted
            ? 'engaging'
            : 'blank'
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      return renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero },
        { slots: { views: FixedChatView } },
      )
    }

    /**
     * Tab chip text: the fork's live title, caught from the session catalog.
     *
     * @param {object} props - standard kit plus `useTabInfo`.
     * @returns {import('react').ReactElement} the title node.
     */
    function AsideTabTitle(props) {
      const { useTabInfo, useSessions, t } = props
      const { tab } = useTabInfo()
      const address = parseAsideAddress(tab.contentId)
      const title = useSessions((state) => (address === undefined ? undefined : state.byId[address.childSessionId]?.title))
      return jsx(React.Fragment, {
        children: typeof title === 'string' && title.length > 0 ? title : t('tab.fallbackTitle'),
      })
    }

    // ------------------------------------------------------------------ apply

    /**
     * Register the resource protocol, the tab type, the guide card, the body and
     * the shortcut.
     *
     * @param {object} ctx - client root context.
     * @returns {void}
     */
    function apply(ctx) {
      try {
        register(ctx)
      } catch (error) {
        console.error('[aside] activation failed:', error)
        throw error
      }
    }

    /**
     * The registration body, separated so a failure carries a message the user
     * can quote instead of a bare "did not activate".
     *
     * @param {object} ctx - client root context.
     * @returns {void}
     */
    function register(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aside:copy')
      const t = ctx.locale.bind(NS)

      /**
       * Fork a conversation and reveal the result in the right sidebar.
       *
       * @param {string} parentSessionId - conversation to fork.
       * @param {{ replaceTab?: string }} [placement] - tab to swap out, as the guide card does.
       * @returns {Promise<string>} the forked session id.
       */
      const startSideChat = async (parentSessionId, placement = {}) => {
        if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) throw new Error(t('guide.noSession'))
        const childSessionId = await ctx.sessions.fork({ sessionId: parentSessionId, increaseTitle: true })
        // Record the fork before the tab can be used, so the relay tool is
        // available the moment the side chat's agent looks for it.
        await announceLink(childSessionId, parentSessionId)
        ctx.sidebarRight.openResource(asideAddress(childSessionId, parentSessionId), {
          kind: KIND,
          ...(placement.replaceTab === undefined ? {} : { replaceTab: placement.replaceTab }),
          ...(placement.replaceTab === undefined ? { preferNewPane: true } : {}),
        })
        return childSessionId
      }

      ctx.effect(
        () =>
          ctx.resources.register({
            protocol: PROTOCOL,
            async *open(resourceAddress, { signal }) {
              const address = parseAsideAddress(resourceAddress)
              if (address === undefined) throw new Error(`aside: invalid side-chat address "${resourceAddress}"`)
              if (signal.aborted) return
              let reference
              try {
                reference = ctx.sessions.retain(address.childSessionId, { source: 'asideChat', signal })
              } catch (error) {
                yield { ok: false, error }
                return
              }
              try {
                yield { ok: true, value: { address, reference } }
                await waitForAbort(signal)
              } finally {
                reference.release()
              }
            },
          }),
        'aside:resource',
      )

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: KIND,
            priority: 'builtin',
            patterns: [`${ADDRESS_PREFIX}**`],
            canOpen: (address) => parseAsideAddress(address) !== undefined,
            title: (address) => {
              const parsed = parseAsideAddress(address)
              const summary = parsed === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[parsed.childSessionId]
              return typeof summary?.title === 'string' && summary.title.length > 0 ? summary.title : t('tab.fallbackTitle')
            },
            guide: [
              {
                id: 'new',
                order: 15,
                title: () => t('guide.new'),
                description: () => t('guide.description'),
              },
            ],
          }),
        'aside:type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.guide.entry',
                key: PLUGIN_ID,
                locale: NS,
                inject: (sessionId) => ({
                  startSideChat: (placement) => startSideChat(sessionId, placement),
                }),
              },
              AsideGuideCard,
            ),
          ),
        'aside:guide',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: PLUGIN_ID,
                locale: NS,
                children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
              },
              AsideTabBody,
            ),
          ),
        'aside:body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID, locale: NS }, AsideTabTitle),
          ),
        'aside:title',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(CONVERSATION_SLOT, () =>
            ctx.slots.register({ name: CONVERSATION_SLOT, locale: NS }, AsideConversationPanel),
          ),
        'aside:conversation',
      )

      // The shortcut is a convenience, not the feature. `shortcuts.register`
      // throws on a conflicting or reserved default, and a throw here would
      // abort this entry's activation — which the Web shell reports as
      // "Failed to load plugins" and an unusable page. A key binding must never
      // be able to take the whole UI down, so this one registration degrades to
      // a console warning instead.
      ctx.effect(() => {
        try {
          return ctx.shortcuts.register({
            id: SHORTCUT_ID,
            label: () => t('guide.new'),
            aliases: ['new aside', 'new side chat', '旁聊'],
            // Web shells only accept a small allowlist of browser-safe bindings;
            // `primary`+`shift` is one of them on both Web platforms, while a
            // literal `control` is not (it is not the mac primary modifier).
            defaults: {
              'desktop:macos': { code: 'Backquote', modifiers: ['control', 'shift'] },
              'desktop:windows': { code: 'Backquote', modifiers: ['control', 'shift'] },
              'desktop:linux': { code: 'Backquote', modifiers: ['control', 'shift'] },
              'web:macos': { code: 'Backquote', modifiers: ['primary', 'shift'] },
              'web:windows': { code: 'Backquote', modifiers: ['primary', 'shift'] },
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: ({ target: element }) => {
              const target = ctx.sidebarRight.commandTarget(element)
              if (target === undefined || target.sessionId === undefined) {
                return { status: 'blocked', reason: t('guide.noSession') }
              }
              return {
                status: 'handled',
                run: () => {
                  startSideChat(target.sessionId).catch((error) => {
                    console.error('aside: shortcut fork failed', error)
                  })
                },
              }
            },
          })
        } catch (error) {
          console.warn('[aside] the side-chat shortcut could not be registered; the start-page card still works.', error)
          return undefined
        }
      }, 'aside:shortcut')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'resources', 'shortcuts'],
      apply,
      /** Exposed for tests only: pure helpers and the identifiers tests assert on. */
      __test: {
        asideAddress,
        parseAsideAddress,
        messageOf,
        ensureStyles,
        announceLink,
        CSS_TAG_ID,
        LINK_ANNOUNCE_PATH,
        zh,
        en,
        AsideGuideCard,
        AsideConversationPanel,
        AsideTabTitle,
        AsideTabBody,
        FixedChatView,
        NS,
        PLUGIN_ID,
        KIND,
        PROTOCOL,
        ADDRESS_PREFIX,
        CONVERSATION_SLOT,
        SHORTCUT_ID,
      },
    }
  },
})
