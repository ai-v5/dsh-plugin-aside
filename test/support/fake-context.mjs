/**
 * Test harness: a recording stand-in for the client Cordis context.
 *
 * Every service the bundle injects is present, every registration is captured,
 * and async behaviour the bundle depends on (`sessions.fork`) is a resolvable
 * promise the test decides the outcome of.
 *
 * @module test/support/fake-context
 */

/**
 * Interpolate `{name}` placeholders the way the host locale service does.
 *
 * @param {string} template - dictionary value.
 * @param {Record<string, unknown>} [params] - interpolation values.
 * @returns {string} formatted text.
 */
function interpolate(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * Build a recording client context.
 *
 * @param {object} [options] - overrides for the fakes.
 * @param {string} [options.locale] - active locale tag (defaults to `zh`).
 * @param {(options: object) => Promise<string>} [options.fork] - fork implementation.
 * @param {(target: unknown, options: object) => object} [options.retain] - session retain implementation.
 * @param {(element?: unknown) => object | undefined} [options.commandTarget] - shortcut target resolution.
 * @param {boolean} [options.throwOnShortcut] - make `shortcuts.register` throw, as a real key conflict does.
 * @returns {object} `{ ctx, recorded }` where `recorded` holds every registration.
 */
export function createFakeContext(options = {}) {
  const locale = options.locale ?? 'zh'
  const recorded = {
    effects: [],
    dictionaries: {},
    tabTypes: [],
    slots: [],
    resources: [],
    shortcuts: [],
    opened: [],
    forks: [],
    retained: [],
    released: [],
    errors: [],
  }

  const translate = (namespace, key, params) => {
    const dictionary = recorded.dictionaries[namespace]
    const table = dictionary === undefined ? undefined : dictionary[locale.toLowerCase().startsWith('zh') ? 'zh' : 'en']
    if (table === undefined) return key
    return interpolate(table[key] ?? key, params)
  }

  const disposer = () => {}

  const ctx = {
    effect(fn, label) {
      recorded.effects.push(label)
      const result = fn()
      return result
    },
    locale: {
      register(namespace, dictionary) {
        recorded.dictionaries[namespace] = dictionary
        return disposer
      },
      bind(namespace) {
        return (key, params) => translate(namespace, key, params)
      },
    },
    slots: {
      inject(name, factory) {
        recorded.effects.push(`inject:${name}`)
        return factory()
      },
      register(definition, component) {
        recorded.slots.push({ definition, component })
        return disposer
      },
    },
    resources: {
      register(provider) {
        recorded.resources.push(provider)
        return disposer
      },
    },
    sidebarRightTabs: {
      register(type) {
        recorded.tabTypes.push(type)
        return disposer
      },
    },
    sidebarRight: {
      openResource(address, placement) {
        recorded.opened.push({ address, placement })
      },
      openTab(kind, placement) {
        recorded.opened.push({ kind, placement })
      },
      commandTarget(element) {
        return options.commandTarget === undefined ? { sessionId: 'session-parent' } : options.commandTarget(element)
      },
      openTabs: { getSnapshot: () => [] },
    },
    sessions: {
      fork(request) {
        recorded.forks.push(request)
        return options.fork === undefined ? Promise.resolve('session-child') : options.fork(request)
      },
      retain(target, retainOptions) {
        recorded.retained.push({ target, retainOptions })
        if (options.retain !== undefined) return options.retain(target, retainOptions)
        if (target === 'session-missing') throw new Error(`sessions.retain: unknown session ${target}`)
        return {
          sessionId: target,
          released: false,
          release() {
            this.released = true
            recorded.released.push(target)
          },
        }
      },
      list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) },
    },
    shortcuts: {
      register(shortcut) {
        if (options.throwOnShortcut === true) throw new Error(`Conflicting shortcut defaults: ${shortcut.id}`)
        recorded.shortcuts.push(shortcut)
        return disposer
      },
    },
  }

  return { ctx, recorded }
}
