# Aside — design

Why the plugin is shaped the way it is, and which DSH contract each step leans on.
Written against DeepSeek Harness `0.2.1-rc.5` (Web client).

## The one decision that matters: client-side, not host-side

The obvious plan for "a chat that is a fork of another chat" is a host plugin: read the
parent's log, clone it, then render the clone somewhere. That plan is both larger and
worse than what DSH already offers.

The Web client already exposes the whole chain:

| Need | Client API | Where it comes from |
|---|---|---|
| Clone a conversation | `ctx.sessions.fork({ sessionId, atSeq?, increaseTitle? })` → `childId` | the same call the chat's "branch from here" action makes |
| Hold a session open | `ctx.sessions.retain(id, { source, signal })` → `SessionReference` | `dsh-api-session-controller` |
| Render its chat | `renderFactorySlot('conversation.content', …, { slots })` under a `SessionProvider` | `dsh-client-ui-conversation` |
| Put it in a sidebar tab | `ctx.sidebarRightTabs.register(...)` + a `dsh-resource://` provider | `dsh-client-ui-sidebar-right` |

So Aside is a **browser-only plugin**. There is no session cloning code here, no HTTP
route, no typed RPC, no server state to migrate, and nothing to keep in sync. The
precedent inside DSH itself is `@deepseek-ai/dsh-client-ui-subagent`, which renders a
subagent child's conversation in a sidebar tab with the same five pieces.

The host half exists for exactly one gap the browser cannot close, and it is worth being
blunt about why: **DSH records no parent link on a fork.** A forked session's header
carries `isSeeded: true` and nothing else; its `session/end-seed` event records only
`{ inherited: true }`. The parent identity lives in the browser, which encodes it in the
tab's resource address — so the browser has to tell the host, and the host keeps a small
durable table. Two things read it: the prompt section that tells a side chat what it is,
and the `aside_tell_main` tool that carries one message back.

That is the whole host surface. No command, no config, and no prompt text reaches a
conversation that is not a tracked side chat.

## The five registrations

### 1. Resource provider — one address, one retained session

```
dsh-resource://asidechat/session/<childSessionId>?parent=<parentSessionId>
```

`open(address, { signal })` is an async generator that yields `{ ok: true, value }` once,
then parks until `signal` aborts, and releases the reference in `finally`. Aborting the
signal is the *only* release path, which is what makes closing a tab free the reference
without any bookkeeping in the component.

A `retain` of an unknown id throws synchronously, so the provider catches it and yields
`{ ok: false, error }` instead — a failure frame. Throwing out of the generator would
surface as a broken resource instead of a message the tab body can render.

The protocol name `asidechat` must be globally unique; the registry rejects a second
provider for the same protocol.

### 2. Tab type — a resource type with a start-page card

```js
ctx.sidebarRightTabs.register({
  id: 'dsh-plugin-aside',            // also the slot key for the body and the title
  kind: 'asidechat',
  priority: 'builtin',
  patterns: ['dsh-resource://asidechat/session/**'],
  canOpen: (address) => parseAsideAddress(address) !== undefined,
  title: (address) => …,             // captured when the tab opens
  guide: [{ id: 'new', order: 15, title, description }],
})
```

`order: 15` sorts the card above the terminal card (`order: 20`). The card content itself
is contributed through the `sidebar.right.tab.guide.entry` seat rather than the default
card, because the default card can only `openTab(kind)` — it cannot fork first. The
custom card keeps the terminal's card geometry (same tokens, same 56 px minimum, same
absolute-fill ghost button) so the start page stays visually uniform.

### 3. Guide card — fork, then navigate

The card receives `startSideChat` from its own `inject(sessionId)`. The `sessionId` is the
one the sidebar's session scope is bound to, i.e. the conversation on screen — the only
reliable source. (The tab's `contentId` is a resource address, not a session id; using it
would be a bug.)

```js
const childSessionId = await ctx.sessions.fork({ sessionId, increaseTitle: true })
ctx.sidebarRight.openResource(asideAddress(childSessionId, sessionId), {
  kind: 'asidechat',
  replaceTab: tab.id,     // the card's own tab steps aside, exactly like the terminal card
})
```

`increaseTitle` renames the child so it is distinguishable in the session list. The
failure path renders the error inside the card's description line and leaves the button
live, so a second click retries; nothing is thrown at the user.

### 4. Tab body — bind a reference, then render the native factory

The body declares one child slot of its own:

```js
ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-plugin-aside',
  locale: 'aside',
  children: { 'aside.chat.conversation': { kind: 'single', scope: 'session' } },
}, AsideTabBody)
```

Declaring a non-root child slot is what makes the framework inject `SessionProvider` and
`renderSlot`; neither is importable. `renderSlot` only resolves keys this entry declared,
so the child slot name has to be ours and cannot be borrowed from another package.

```jsx
<SessionProvider session={resource.value.reference}>
  {renderSlot('aside.chat.conversation', {})}
</SessionProvider>
```

### 5. Conversation panel — the native chat, pinned to Chat

```js
renderFactorySlot(
  'conversation.content',
  { variant: 'embedded', phase, hero },
  { slots: { views: (props) => props.renderSlot('conversation.session', { view: 'chat' }) } },
)
```

`variant: 'embedded'` drops the width drag handles; pinning `views` replaces the View tab
strip with plain Chat. Everything else — transcript, composer, optimistic submit, queue,
attachments, stop — is the factory's own and binds to whatever `SessionProvider` above it
supplies. That is the whole trick: Aside does not implement a chat, it points the existing
one at a different session.

`phase` / `hero` come from the factory's shell contract. They are not documented as a
public API; the values here are copied from the shipped subagent sidebar chat rather than
invented, and this is the one place to re-check when DSH changes.

## Pitfalls paid for during implementation

- **The Web shortcut allowlist is narrow.** A default of `control+shift+Backquote` throws
  `Unsupported Web shortcut` because the Web shell only accepts a small browser-safe set;
  `primary+shift` is inside it and resolves per platform. The plugin therefore declares
  `control+shift` for desktop and `primary+shift` for Web, and does not declare
  `web:linux` at all — the Web shell has no Linux entry.
- **`fork` needs a completed turn.** On a conversation whose only turn is still streaming,
  `fork` answers `session/fork-unavailable: has no completed turn to fork from`. The card
  surfaces that verbatim instead of pretending to work.
- **The client module graph is order-sensitive.** `package.json`'s `dsh.client.inject`
  lists bundle *package names*, and `client.js` exports a Cordis `inject` of *service
  names*; they are different things. A typo in the former fails silently, and the symptom
  is a blank side chat because the `conversation.content` factory was not registered yet.
- **A failed activation is opaque.** The boot screen only says "1 entry did not activate",
  so `apply` wraps its body and logs `[aside] activation failed:` with the real error
  before rethrowing. Keep that wrapper.

## Deliberate non-goals

- **Hiding side chats from the session list.** A fork is a session; pretending otherwise
  would mean either subagent-owned sessions (which reject ordinary prompts) or a
  host-side filter that the catalogue does not offer. Showing them is also useful: a side
  chat can be resumed in the main pane.
- **A host config block.** Nothing on the host can change what the browser does.
- **`aside_ask`: the main conversation interrogating a side chat.** The reverse arrow is
  still absent on purpose. It needs the main agent to address one of N side chats, wait
  for an answer, and splice it back into its own context — a different feature from the
  one-message hand-off `aside_tell_main` provides, and one that is much easier to get
  wrong (double-model turns, no natural cancellation point). Ship the hand-off first.
