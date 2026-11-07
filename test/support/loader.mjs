/**
 * Test harness: load the real browser bundle under a stubbed module loader.
 *
 * `client.js` is a classic script that hands a factory to
 * `window.__ModuleLoader__.load(...)`. That is exactly what the harness fakes,
 * so the tests exercise the shipped file rather than a copy of its logic.
 *
 * @module test/support/loader
 */

/** Minimal React surface the bundle touches at module scope. */
const reactStub = {
  Fragment: Symbol.for('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
}

/** `react/jsx-runtime` stub: records the element tree as plain objects. */
const jsxRuntimeStub = {
  Fragment: reactStub.Fragment,
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}

/** UI primitives stub: only names the bundle resolves at module scope. */
const primitivesStub = {
  Button: function Button() {},
}

/** Modules the bundle is allowed to require. */
const MODULES = {
  react: reactStub,
  'react/jsx-runtime': jsxRuntimeStub,
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}

/**
 * Load `client.js` through a fake module loader.
 *
 * @returns {Promise<{ definition: { id: string, factory: Function }, module: object }>} the captured module definition and the object its factory returned.
 */
export async function loadClientModule() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const url = new URL('../../client.js', import.meta.url)
  await import(url.href)
  if (captured === undefined) throw new Error('client.js did not register a module')
  const require = (id) => {
    const found = MODULES[id]
    if (found === undefined) throw new Error(`unexpected require("${id}") from client.js`)
    return found
  }
  return { definition: captured, module: captured.factory(require) }
}
