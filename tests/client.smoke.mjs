/**
 * Client half structural smoke test (static-bundle mode).
 *
 * Loads the REAL built `dist/client.js`. In static-bundle mode that file is a
 * `window.__ModuleLoader__.load({ id, factory })` call; the factory receives a
 * synchronous `require` and returns the CJS module (exporting apply). We
 * provide `require` (React + externals), a minimal `document` for CSS
 * adoption, and a `ctx` whose `remote.$mount` + `reflect.get` expose a mocked
 * `modelPro` remote. The remote's methods return the Gateway envelope
 * `{ ok, value }` wrapping the business `{ ok, ... }` payload — exactly what
 * rpc.ts unwraps. Then renders the registered `settings.section` slot through
 * a tiny React renderer and asserts the redesigned dashboard constructs.
 *
 * Run: `npm test`  (build must be current: `npm run build`)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE = path.join(__dirname, '..', 'dist', 'client.js')

// ---------------------------------------------------------------------------
// tiny React: createElement + function-component renderer with hooks
// (useState persists per instance; useEffect runs once per instance).
// ---------------------------------------------------------------------------
class FakeReact {
  constructor() {
    this.Fragment = Symbol('fragment')
    this.current = null
    this.instances = new Map()
    this.rerender = null
  }

  createElement(type, props, ...children) {
    const flat = []
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue
      if (Array.isArray(c)) flat.push(...c.flat(Infinity).filter(Boolean))
      else flat.push(c)
    }
    return { type, props: props || {}, children: flat }
  }

  useState(init) {
    const inst = this.current
    const i = inst.hookIdx++
    if (i >= inst.hooks.length) inst.hooks.push(typeof init === 'function' ? init() : init)
    const update = (v) => {
      inst.hooks[i] = typeof v === 'function' ? v(inst.hooks[i]) : v
      if (this.rerender) this.rerender()
    }
    return [inst.hooks[i], update]
  }

  useRef(init) {
    const inst = this.current
    const i = inst.hookIdx++
    if (i >= inst.hooks.length) inst.hooks.push({ current: init })
    return inst.hooks[i]
  }

  useEffect(fn) {
    const inst = this.current
    if (!inst.effectsRun) inst.effects.push(fn)
  }

  useCallback(fn) {
    return fn
  }

  useMemo(fn) {
    return fn()
  }

  clone() {
    return Object.create(this)
  }
}

function renderAt(rootVNode, fake, path, out) {
  // Falsy children (&& patterns, ternaries) are legal React — skip them.
  if (!rootVNode || typeof rootVNode !== 'object' || typeof rootVNode.type === 'undefined') return
  const { type, props, children } = rootVNode
  if (type === fake.Fragment) {
    for (let i = 0; i < children.length; i++) renderAt(children[i], fake, `${path}:${i}`, out)
    return
  }
  if (typeof type === 'string') {
    // Keep clickable elements so the test can drive tab switches, plus the raw
    // props so assertions can inspect non-click behaviour (drag handlers, input
    // type/min/max) without a second render pass. Form events are captured too,
    // so capability changes can drive and inspect the RPC payloads.
    out.push({ tag: type, className: props?.className || '', text: collectText(children), onClick: props?.onClick, onChange: props?.onChange, ref: props?.ref, props: props || {} })
    for (let i = 0; i < children.length; i++) renderAt(children[i], fake, `${path}:${i}`, out)
    return
  }
  // function component
  const key = `${path}:${type.name || 'anon'}`
  let inst = fake.instances.get(key)
  if (!inst) { inst = { hooks: [], effects: [], effectsRun: false }; fake.instances.set(key, inst) }
  inst.hookIdx = 0
  const prev = fake.current
  fake.current = inst
  let rendered
  try {
    rendered = type(props)
  } finally {
    fake.current = prev
  }
  inst.effectsRun = true
  const pending = inst.effects.splice(0)
  for (const fn of pending) fn()
  if (rendered && typeof rendered === 'object' && 'type' in rendered) {
    renderAt(rendered, fake, `${key}`, out)
  }
}

function collectText(children) {
  let s = ''
  for (const c of children) {
    if (typeof c === 'string' || typeof c === 'number') s += String(c) + ' '
    else if (c && typeof c === 'object' && 'type' in c) {
      if (typeof c.type === 'string') s += collectText(c.children || [])
    }
  }
  return s.trim()
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
}

// ---------------------------------------------------------------------------
// injected client globals
// ---------------------------------------------------------------------------
const testProviders = [
  { route: 'deepseek', displayName: 'DeepSeek', declared: true, api: 'openai-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DS_KEY', disabled: false, hasHeaders: true, headerCount: 1, modelCount: 2, usesCatalog: false },
  { route: 'my-gw', displayName: 'My Gateway', declared: true, api: 'anthropic-messages', baseURL: 'https://gw.example.com/v1', apiKeyEnv: '', disabled: true, hasHeaders: false, headerCount: 0, modelCount: 0, usesCatalog: true },
]

// ---------------------------------------------------------------------------
// mocked remote: camelCase methods returning the Gateway envelope
// { ok, value } wrapping the business { ok, ... } payload.
// ---------------------------------------------------------------------------
const uiPrefsState = { showRouteBadge: true }
// Model capability display state, as get-provider would return it after the
// host attaches the display-side provenance fields.
let modelState = [
  { id: 'deepseek-v4.1-flash', name: 'Legacy model', contextWindow: 128000, maxTokens: 4096, input: ['text'], requestModel: 'wire-chat', capabilitySource: 'configured' },
  { id: 'known-image-model', input: ['text', 'image'], capabilitySource: 'catalog', capabilityConflict: true, capabilityReference: 'Synthetic catalog reference' },
  { id: 'custom-vision-name' },
]
const discoveredState = [
  { id: 'remote-text', name: 'Remote text', input: ['text'] },
  { id: 'remote-image', name: 'Remote image', input: ['text', 'image'], capabilitySource: 'discovery' },
  { id: 'unknown-vision', name: 'Unknown vision' },
]
const remoteCalls = []
let identifySummary = { image: 1, text: 1, unknown: 1, preserved: 1, updated: 1, rechecked: 2, conflicts: 1, catalogUnavailable: false }
let identifyError = ''
let providerRefreshError = ''
const retryPrefsState = { maxRetries: 0 }
const catalogPrefsState = { enabled: false, url: '' }
const gatewayPrefsState = { enabled: false }
const catalogReply = () => ({
  ok: true,
  prefs: { ...catalogPrefsState },
  effectiveUrl: catalogPrefsState.url || 'https://models.dev/api.json',
  defaultUrl: 'https://models.dev/api.json',
})
const businessFor = (method, payload) => {
  if (method === 'listProviders') return { ok: true, providers: testProviders, protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'], writable: true }
  if (method === 'listRoutes') return { ok: true, routes: { auto: { strategy: 'priority', targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] } } }
  if (method === 'getProvider') return providerRefreshError
    ? { ok: false, error: providerRefreshError }
    : { ok: true, route: payload?.route || 'deepseek', models: modelState.map((m) => ({ ...m })), availableModels: [] }
  if (method === 'discoverModels') return { ok: true, models: discoveredState.map((m) => ({ ...m })) }
  if (method === 'applyModels') {
    // Identify has its own authoritative result; this client mock does not
    // repeat the host's catalog matching or preservation algorithm.
    if (payload.mode === 'identify') return identifyError
      ? { ok: false, error: identifyError }
      : { ok: true, count: modelState.length, ...(identifySummary ? { capabilitySummary: { ...identifySummary } } : {}) }
    const incoming = (payload.models || []).map((m) => {
      // Model updates are partial. Keep fields omitted by an ordinary save;
      // only the explicit UI mutation intent changes this mock's manual state.
      const previous = payload.mode === 'merge' ? modelState.find((entry) => entry.id === m.id) : undefined
      const entry = { ...previous, ...m }
      if (entry.input === null) delete entry.input
      if (entry.requestModel === null) delete entry.requestModel
      if (m.inputMode === 'manual' || m.inputMode === 'auto') {
        delete entry.capabilitySource
        delete entry.capabilityConflict
        delete entry.capabilityReference
      }
      if (m.inputMode === 'manual') entry.capabilitySource = 'manual'
      delete entry.inputMode
      return entry
    })
    if (payload.mode === 'replace') modelState = incoming
    else if (payload.mode === 'remove') modelState = modelState.filter((m) => !incoming.some((other) => other.id === m.id))
    else {
      const entries = new Map(modelState.map((m) => [m.id, m]))
      for (const m of incoming) entries.set(m.id, m)
      modelState = [...entries.values()]
    }
    return { ok: true, count: modelState.length }
  }
  if (method === 'listComposites') return { ok: true, composites: {} }
  if (method === 'getRouteStats') return {
    ok: true,
    byRoute: { 'auto': { calls: 12, errors: 1, latencySum: 4800, latencyN: 12, tokensIn: 100, tokensOut: 200 } },
    byTarget: { 'deepseek\u0000deepseek-chat': { calls: 12, errors: 1, latencySum: 4800, latencyN: 12, tokensIn: 100, tokensOut: 200 } },
    health: { 'deepseek\u0000deepseek-chat': { provider: 'deepseek', model: 'deepseek-chat', status: 'up', latencyMs: 400, consecutiveFails: 0, lastProbeAt: 1700000000000 } },
  }
  if (method === 'getUiPrefs') return { ok: true, prefs: { ...uiPrefsState } }
  if (method === 'setUiPrefs') { Object.assign(uiPrefsState, (payload && payload.prefs) || {}); return { ok: true, prefs: { ...uiPrefsState } } }
  if (method === 'getRetryPrefs') return { ok: true, prefs: { ...retryPrefsState }, max: 20 }
  if (method === 'setRetryPrefs') { Object.assign(retryPrefsState, (payload && payload.prefs) || {}); return { ok: true, prefs: { ...retryPrefsState }, applied: true } }
  if (method === 'getCatalogPrefs') return catalogReply()
  if (method === 'setCatalogPrefs') { Object.assign(catalogPrefsState, (payload && payload.prefs) || {}); return catalogReply() }
  if (method === 'getLocalGatewayPrefs') return { ok: true, prefs: { ...gatewayPrefsState }, hasTemporaryKey: false, endpoint: 'http://127.0.0.1:3080/model-pro/v1' }
  if (method === 'setLocalGatewayPrefs') { if (typeof payload?.enabled === 'boolean') gatewayPrefsState.enabled = payload.enabled; return { ok: true, prefs: { ...gatewayPrefsState }, hasTemporaryKey: !!payload?.generateKey, endpoint: 'http://127.0.0.1:3080/model-pro/v1', ...(payload?.generateKey ? { temporaryKey: 'dsh-local-test-key-123456' } : {}) } }
  // Two entries on purpose: one plain, one whose thinking level the router had
  // to clamp. A clamped call SUCCEEDS, so the effort trace is the only thing in
  // the product that reveals the substitution — both the log column and the
  // conversation badge are asserted against this second entry.
  if (method === 'listRequestLogs') return { ok: true, entries: [
    { ts: 1700000000000, sessionId: 'sess-x', route: 'auto', target: { provider: 'deepseek', model: 'deepseek-chat' }, status: 'ok', tryIndex: 1, latencyMs: 400, tokens: { in: 100, out: 200 } },
    { ts: 1700000000500, sessionId: 'sess-x', route: 'auto', target: { provider: 'deepseek', model: 'deepseek-chat' }, status: 'ok', tryIndex: 1, latencyMs: 410, tokens: { in: 10, out: 20 }, effort: { requested: 'max', sent: 'medium' } },
  ] }
  return { ok: true }
}

// The remote handle: one async method per camelCase RPC name.
const remoteMethods = [
  'listProviders', 'toggleProvider', 'getProvider', 'discoverModels', 'createProvider',
  'deleteProvider', 'updateField', 'updateHeaders', 'applyModels', 'testProvider',
  'setApiKey', 'listRoutes', 'setRoute', 'deleteRoute', 'listComposites', 'setComposite',
  'deleteComposite', 'previewComposite', 'getRouteStats', 'listRequestLogs',
  'clearRequestLogs', 'probeTarget', 'probeAll', 'getUiPrefs', 'setUiPrefs',
  'getRetryPrefs', 'setRetryPrefs',
  'getCatalogPrefs', 'setCatalogPrefs', 'getLocalGatewayPrefs', 'setLocalGatewayPrefs',
]
const remoteHandle = {}
for (const m of remoteMethods) {
  remoteHandle[m] = async (payload) => {
    remoteCalls.push({ method: m, payload: payload && JSON.parse(JSON.stringify(payload)) })
    return { ok: true, value: businessFor(m, payload) }
  }
}

const structures = []
const localeOverrides = {
  badgeRoutePrefix: '路由',
  obsEffortClamped: '{requested} → {sent}',
  obsEffortDropped: '{requested} → 未下发',
  obsEffortClampedTip: '路由请求「{requested}」，但该目标只支持到「{sent}」，已自动降档。',
  obsEffortDroppedTip: '路由请求「{requested}」，但该目标未声明思考档位，本次未下发任何档位。',
  badgeEffort: '{requested}→{sent}',
  badgeEffortNone: '{requested}→无',
}
// Capability copy carries counts/titles the assertions match on, so it
// resolves to the REAL registered English dictionary rather than identity.
let registeredLocale = null
const capabilityKeys = new Set([
  'statusCapabilities', 'statusCapabilitiesCurrent', 'capabilitiesUnconfirmed', 'capabilityCatalogUnavailable',
  'inputCapabilityHint', 'capabilitySourceConfigured', 'capabilitySourceManual', 'capabilitySourceCatalog',
  'capabilitySourceOfficial', 'capabilitySourceProviderDefault', 'capabilitySourceDiscovery', 'capabilitySourceUnknown',
  'capabilityReferenceLabel', 'capabilityConflictHint', 'saveModelConfigFirst',
])
const fake = new FakeReact()
const slotsByName = new Map()

const ctx = {
  get: (name) => {
    if (name === 'locale') return {
      register: (_ns, dictionaries) => { registeredLocale = dictionaries },
      // Mostly identity, because the existing assertions match KEYS. Three
      // exceptions, all load-bearing:
      //   - `badgeRoutePrefix` proves the bound t actually reaches the badge.
      //   - the effort templates carry {placeholders}; an identity t would
      //     erase the very values those assertions check for, so they resolve
      //     to their real templates.
      //   - the capability keys must resolve through the registered EN
      //     dictionary, proving the count templates are actually reachable.
      bind: () => (k) => (k in localeOverrides ? localeOverrides[k]
        : capabilityKeys.has(k) ? registeredLocale?.en?.[k] || k : k),
    }
    if (name === 'slots') return {
      inject: (slotName, fn) => fn(),
      // Multiple slots coexist (settings page + conversation turnTail badge).
      register: (meta, render) => { slotsByName.set(meta.name, { label: meta, render }); return { id: meta.id } },
    }
    return undefined
  },
  // API Gateway remote surface used by the static-bundle client.
  remote: { $mount: async () => () => {} },
  reflect: { get: (key) => (key === 'remote.modelPro' ? remoteHandle : undefined) },
  effect: (fn) => { const c = fn(); if (typeof c === 'function') c(); return c },
}

// document shim for adoptStyles() (the client injects a <style> element).
const documentShim = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) { structures.push(v) }, get textContent() { return '' } }),
  head: { appendChild: () => {} },
}

// Synchronous require the __ModuleLoader__ factory expects.
const requireShim = (spec) => {
  if (spec === 'react') return fake
  if (spec === 'react-dom' || spec === 'react/jsx-runtime') return {}
  throw new Error(`client smoke: unexpected require(${spec})`)
}

const sandbox = {
  console,
  Promise,
  setTimeout,
  clearTimeout,
  Date,
  document: documentShim,
  window: {},
}
sandbox.globalThis = sandbox
// The factory registers itself here; capture it.
let captured = null
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => { captured = { id, factory } },
}

const code = readFileSync(CLIENT_BUNDLE, 'utf8')
vm.runInContext(code, vm.createContext(sandbox), { filename: 'model-pro-client.js' })
assert(captured && captured.id === 'dsh-model-pro', 'client bundle registered under its package id')
const moduleExports = captured.factory(requireShim)
const plugin = moduleExports.apply ? moduleExports : moduleExports.default
const badgeMod = moduleExports
plugin.apply(ctx)

// 详情页应清除最近的纵向滚动容器，不改变更外层的窗口滚动。
const outerScroll = { scrollTop: 80, parentElement: null }
const settingsScroll = { scrollTop: 240, parentElement: outerScroll }
const settingsInner = { parentElement: settingsScroll }
const editorRoot = { parentElement: settingsInner }
sandbox.getComputedStyle = (node) => ({ overflowY: node === outerScroll || node === settingsScroll ? 'auto' : 'visible' })
assert(typeof moduleExports.resetEditorScroll === 'function', 'editor scroll helper is exported')
assert(moduleExports.findScrollableAncestor(editorRoot) === settingsScroll, 'plugin root finds the host settings scroller')
moduleExports.resetEditorScroll(editorRoot)
assert(settingsScroll.scrollTop === 0 && outerScroll.scrollTop === 80, 'editor resets the nearest scrollable ancestor only')

const settingsSlot = slotsByName.get('settings.section')
const badgeSlot = slotsByName.get('conversation.chat.turnTail')
assert(settingsSlot && typeof settingsSlot.render === 'function', 'settings.section slot rendered')
assert(settingsSlot.label && typeof settingsSlot.label.label === 'function', 'slot label registered')
assert(badgeSlot && typeof badgeSlot.render === 'function' && typeof badgeSlot.label.select === 'function', 'turnTail badge slot registered with a select')

// let the async remote $mount effect resolve so `remote` is wired before the
// dashboard's first refresh() fires (the client mounts the remote in an async
// effect; reflect.get is synchronous but the await yields a microtask).
await new Promise((r) => setTimeout(r, 10))

// render the dashboard; allow the async refresh() to settle (the fake remote
// call resolves on a macrotask, not just the microtask queue)
const out = []
fake.rerender = () => {}
let tree = settingsSlot.render()
renderAt(tree, fake, 'root', out)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', out)
await new Promise((r) => setTimeout(r, 10))

const allClassNames = new Set(out.map((n) => n.className).filter(Boolean))
const all = out.map((n) => n.className)

// -- structure assertions on the REBUILT bundle --
const css = structures.join('\n')
for (const rule of ['.mpro-root', '.mpro-segs', '.mpro-pc', '.mpro-pcActive', '.mpro-pcOff', '.mpro-pill', '.mpro-pillActive', '.mpro-pillOff', '.mpro-verdictOk', '.mpro-discoverBar', '.mpro-step', '.mpro-setupCard', '.mpro-routesTab', '.mpro-statCard', '.mpro-hdotUp', '.mpro-routeRow', '.mpro-targetRow', '.mpro-dragHandle', '.mpro-targetRowOver', '.mpro-moveBtn', '.mpro-retryBox', '.mpro-retrySlider', '.mpro-reasonBox', '.mpro-reasonCell', '.mpro-tierExact', '.mpro-checkRow', '.mpro-editorChrome{position:sticky', '.mpro-currentTblWrap{max-height:none']) {
  assert(css.includes(rule), `styles include ${rule}`)
}

// -- i18n safety copy present in bundle (esbuild escapes non-ASCII as \uXXXX
// with UPPERCASE hex; match raw and escaped forms case-insensitively) --
assert(code.includes('卸载') || /\\u5378\\u8f7d/i.test(code), 'bundle carries uninstall-safety copy')
assert(code.includes('测试') || /\\u6d4b\\u8bd5/i.test(code), 'bundle carries test-model copy')

const rendered = JSON.stringify(out)
assert(rendered.includes('mpro-root'), 'renders mpro-root')
assert(all.some((c) => c.includes('mpro-segs')), 'renders segment bar')
assert(all.includes('mpro-pc'), 'renders enabled rail card (plain .mpro-pc)')
assert(all.some((c) => c.includes('mpro-pcOff')), 'renders disabled rail card')
assert(all.some((c) => c.includes('mpro-pillOff')), 'renders disabled pill')
assert(out.some((n) => n.tag === 'button' && /test|测试/i.test(n.text)), 'renders a Test action')

// -- smart-routing page: switch to the routes tab and assert the redesigned UI --
const routesTab = out.find((n) => n.tag === 'button' && /tabRoutes/i.test(n.text || ''))
assert(routesTab && typeof routesTab.onClick === 'function', 'smart-routing tab button present')
routesTab.onClick()
const outR = []
renderAt(tree, fake, 'root', outR)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outR)
assert(outR.some((n) => String(n.className).includes('mpro-routesTabs')), 'renders the 4-tab smart-routing shell')
assert(outR.some((n) => String(n.className).includes('mpro-routesRoot')), 'renders routes root')
assert(outR.some((n) => String(n.className).includes('mpro-routeRow')), 'renders a route row from list-routes')
assert(outR.some((n) => /tabComposites/i.test(n.text || '')), 'renders composite-tab button')
assert(outR.some((n) => /tabObservability/i.test(n.text || '')), 'renders observability-tab button')
assert(outR.some((n) => /tabProbe/i.test(n.text || '')), 'renders probe-tab button')

// -- target rows are drag-reorderable, with keyboard-accessible ↑/↓ equivalents --
// The old UI put a row of "↑1 ↓ ↑2 ↓ …" buttons under the list; reordering now
// lives on each row so the control sits where the thing it moves is.
assert(!outR.some((n) => /^↑\d/.test(String(n.text || ''))), 'the old numbered ↑N reorder buttons are gone')
{
  const openEditor = outR.find((n) => n.tag === 'button' && /routeAdd/i.test(n.text || '') && typeof n.onClick === 'function')
  assert(openEditor, 'route editor can be opened')
  openEditor.onClick()
  const outE = []
  renderAt(tree, fake, 'root', outE)
  await new Promise((r) => setTimeout(r, 10))
  renderAt(tree, fake, 'root', outE)

  const addTarget = outE.find((n) => n.tag === 'button' && /routeAddTarget/i.test(n.text || '') && typeof n.onClick === 'function')
  assert(addTarget, 'editor exposes an add-target button')
  addTarget.onClick()
  addTarget.onClick()
  const outT = []
  renderAt(tree, fake, 'root', outT)
  await new Promise((r) => setTimeout(r, 10))
  renderAt(tree, fake, 'root', outT)

  const rows = outT.filter((n) => String(n.className).includes('mpro-targetRow'))
  assert(rows.length >= 2, 'two target rows render: ' + rows.length)
  assert(rows.every((n) => n.props.draggable === true), 'every target row is draggable')
  assert(rows.every((n) => typeof n.props.onDragStart === 'function' && typeof n.props.onDrop === 'function'), 'rows carry dragStart + drop handlers')
  // onDragOver must exist and preventDefault, or the browser never fires drop.
  assert(rows.every((n) => typeof n.props.onDragOver === 'function'), 'rows carry a dragOver handler (required for drop to fire)')
  assert(outT.some((n) => String(n.className).includes('mpro-dragHandle')), 'each row shows a drag grip')
  assert(outT.filter((n) => String(n.className).includes('mpro-moveBtn')).length >= 4, 'each row keeps ↑/↓ buttons for keyboard users')

  // A drop from row 0 onto row 1 must REORDER (remove+insert), not swap.
  const first = rows[0]
  first.props.onDragStart({ dataTransfer: { effectAllowed: '', setData() {} } })
  const second = rows[1]
  second.props.onDrop({ preventDefault() {}, dataTransfer: {} })
  const outD = []
  renderAt(tree, fake, 'root', outD)
  await new Promise((r) => setTimeout(r, 10))
  assert(outD.filter((n) => String(n.className).includes('mpro-targetRow')).length >= 2, 'rows survive a drop')
}

// -- retry budget: a slider, not a number spinner --
assert(outR.some((n) => String(n.className).includes('mpro-retryBox')), 'renders the retry-budget box')
{
  const slider = outR.find((n) => String(n.className).includes('mpro-retrySlider'))
  assert(slider, 'retry budget uses a slider')
  assert(slider.props.type === 'range', 'the retry control is type=range, not a number spinner')
  assert(Number(slider.props.min) === 0 && Number(slider.props.max) === 20, 'slider bounds come from the host ceiling: ' + slider.props.min + '-' + slider.props.max)
  // Committing on release (not per drag frame) keeps one settings write per edit.
  assert(typeof slider.props.onMouseUp === 'function' && typeof slider.props.onKeyUp === 'function', 'slider commits on release and on keyboard release')
}

// -- external catalog: opt-in, and its URL field only exists once enabled --
// The lookup is the plugin's only third-party request, so "off unless asked" is
// a behavioural guarantee, not a styling detail.
assert(outR.some((n) => String(n.className).includes('mpro-checkRow')), 'renders the catalog opt-in checkbox')
assert(outR.some((n) => String(n.className).includes('mpro-gatewayBox')), 'renders the local agent gateway patch panel')
assert(outR.some((n) => /gatewayOff/i.test(n.text || '')), 'local agent gateway visibly starts OFF')
{
  const box = outR.find((n) => n.props && n.props.type === 'checkbox' && n.props.checked === false)
  assert(box, 'the catalog toggle starts unchecked (no fetch without consent)')
  const urlInputs = outR.filter((n) => n.props && typeof n.props.placeholder === 'string' && /models\.dev/.test(n.props.placeholder))
  assert(urlInputs.length === 0, 'the catalog URL field is hidden while the lookup is disabled')
}

// -- observability tab renders stat cards + request-log table area --
const obsTab = outR.find((n) => n.tag === 'button' && /tabObservability/i.test(n.text || ''))
assert(obsTab && typeof obsTab.onClick === 'function', 'observability tab clickable')
obsTab.onClick()
const outO = []
renderAt(tree, fake, 'root', outO)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outO)
assert(outO.some((n) => String(n.className).includes('mpro-statCard')), 'observability renders stat cards')
assert(outO.some((n) => String(n.className).includes('mpro-tblWrap')), 'observability renders tables')
assert(outO.some((n) => String(n.className).includes('mpro-logOk') || String(n.className).includes('mpro-logErr')), 'request-log status styling present')
// The thinking-level column: a clamped entry must render BOTH levels, because a
// successful downgrade is otherwise invisible everywhere in the product.
assert(outO.some((n) => String(n.className).includes('mpro-logEffortClamped') && /max/.test(n.text || '') && /medium/.test(n.text || '')),
  'request-log marks a clamped thinking level with both levels: ' + JSON.stringify(outO.filter((n) => String(n.className).includes('mpro-logEffort')).map((n) => n.text)))

// -- probe tab renders target health rows with status dots --
const probeTab = outO.find((n) => n.tag === 'button' && /tabProbe/i.test(n.text || ''))
assert(probeTab && typeof probeTab.onClick === 'function', 'probe tab clickable')
probeTab.onClick()
const outP = []
renderAt(tree, fake, 'root', outP)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outP)
assert(outP.some((n) => String(n.className).includes('mpro-hdotUp')), 'probe tab renders health dots')
assert(outP.some((n) => /probeProbe/i.test(n.text || '')), 'probe tab renders per-target probe buttons')

// -- models tab: search inputs, custom-model add form, current-list bulk ops --
// back to the providers dashboard first
const provTab = outP.find((n) => n.tag === 'button' && /tabProviders/i.test(n.text || ''))
assert(provTab && typeof provTab.onClick === 'function', 'providers tab clickable')
provTab.onClick()
const outD = []
renderAt(tree, fake, 'root', outD)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outD)
// open the editor for the first provider card
const editBtn = outD.find((n) => n.tag === 'button' && /^edit$/i.test((n.text || '').trim()))
assert(editBtn && typeof editBtn.onClick === 'function', 'provider card Edit button present')
const dashboardNode = outD.find((n) => n.className === 'mpro-root' && typeof n.ref === 'function')
assert(dashboardNode, 'provider list attaches its scroll restore callback')
dashboardNode.ref(editorRoot)
settingsScroll.scrollTop = 260
editBtn.onClick()
const outE = []
renderAt(tree, fake, 'root', outE)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outE)
assert(outE.some((n) => String(n.className).includes('mpro-editorCard')), 'provider editor has a framed card')
assert(outE.some((n) => String(n.className).includes('mpro-editorChrome')), 'provider header and tabs share the framed chrome')
const editorRootNode = outE.find((n) => String(n.className).includes('mpro-editorRoot'))
assert(typeof editorRootNode?.ref === 'function', 'editor root attaches its scroll reset callback')
settingsScroll.scrollTop = 220
editorRootNode.ref(editorRoot)
assert(settingsScroll.scrollTop === 0, 'entering the editor resets the settings scroll')
// switch to the Models tab
const modelsTab = outE.find((n) => n.tag === 'button' && /tabModels/i.test(n.text || ''))
assert(modelsTab && typeof modelsTab.onClick === 'function', 'models tab clickable')
settingsScroll.scrollTop = 190
modelsTab.onClick()
assert(settingsScroll.scrollTop === 0, 'switching editor tabs resets the settings scroll')
const outM = []
renderAt(tree, fake, 'root', outM)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outM)
assert(outM.some((n) => String(n.className).includes('mpro-currentTblWrap')), 'current model list uses the expanding table wrapper')
const searchInputs = outM.filter((n) => n.tag === 'input' && String(n.className).includes('mpro-searchInput'))
assert(searchInputs.length >= 1, `models tab renders search input(s), got ${searchInputs.length}`)
assert(outM.some((n) => n.tag === 'button' && /^selectAll$/i.test((n.text || '').trim())), 'current list renders select-all')

// -- input capabilities: badges, sources, manual choice, identify ------------
const renderModels = () => {
  const nodes = []
  renderAt(tree, fake, 'root', nodes)
  return nodes
}
const settle = () => new Promise((r) => setTimeout(r, 10))
const formControl = (nodes, tag, label) => nodes.find((n) => n.tag === tag && n.props?.['aria-label'] === label)
const buttonByText = (nodes, text) => nodes.find((n) => n.tag === 'button' && n.text === text)
const lastApply = () => remoteCalls.filter((c) => c.method === 'applyModels').at(-1)
const modelRow = (nodes, id) => nodes.find((n) => n.tag === 'tr' && n.text.includes(id))
let modelNodes = renderModels()
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputTextOnly'), 'known text models have a text-only badge')
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputTextImage'), 'known image models have an image-capability badge')
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputUnknown'), 'missing capability is unconfirmed, not text-only')
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name')?.props.value === 'auto', 'vision-like names without metadata stay automatic/unconfirmed')
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: deepseek-v4.1-flash')?.props.value === 'auto', 'old configured text is not mistaken for a manual selection')
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: known-image-model')?.props.value === 'auto', 'catalog image capability stays in automatic mode')
assert(modelNodes.some((n) => n.text === 'Old configuration (unknown source)') && modelNodes.some((n) => n.text === 'Model catalog'), 'model rows explain legacy and catalog capability sources')
assert(modelNodes.some((n) => n.text.includes('Catalog labels differ')) && modelNodes.some((n) => n.text.includes('Synthetic catalog reference')), 'model rows display conflict and reference metadata')

// Manual capability is carried in the saved model, and automatic resets send
// an explicit release rather than silently keeping the previous choice.
formControl(modelNodes, 'select', 'inputCapabilityCol: known-image-model').onChange({ target: { value: 'text' } })
modelNodes = renderModels()
formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name').onChange({ target: { value: 'image' } })
modelNodes = renderModels()
assert(buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'capability backfill waits for an unsaved manual choice')
assert(buttonByText(modelNodes, 'identifyCapabilities').props.title.includes('Save the model configuration first'), 'the unsaved-configuration requirement is visible as a title hint')
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(lastApply().payload.mode === 'merge', 'model configuration saves through the ordinary merge mode')
assert(lastApply().payload.models.find((m) => m.id === 'known-image-model').inputMode === 'manual' && lastApply().payload.models.find((m) => m.id === 'known-image-model').input.join() === 'text', 'manual choices carry their explicit input values')
assert(lastApply().payload.models.find((m) => m.id === 'custom-vision-name').inputMode === 'manual' && lastApply().payload.models.find((m) => m.id === 'custom-vision-name').inputMode !== undefined, 'manual choices include explicit mutation intent')
assert(lastApply().payload.models.every((m) => !Object.keys(m).some((key) => key.startsWith('capability'))), 'saving model configuration strips all display-only capability metadata')
assert(!Object.hasOwn(lastApply().payload.models.find((m) => m.id === 'deepseek-v4.1-flash'), 'input'), 'saving other fields does not resend the legacy capability as a manual choice')
const untouched = lastApply().payload.models.find((m) => m.id === 'deepseek-v4.1-flash')
assert(untouched.name === 'Legacy model' && untouched.contextWindow === 128000 && untouched.maxTokens === 4096 && untouched.requestModel === 'wire-chat', 'ordinary save retains model names, limits and wire mapping')
modelNodes = renderModels()
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: known-image-model')?.props.value === 'text' && formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name')?.props.value === 'image', 'only confirmed manual sources select manual capability options')
assert(modelNodes.some((n) => n.text === 'Set manually in this plugin'), 'manual source is visible')
formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name').onChange({ target: { value: 'auto' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(lastApply().payload.models.find((m) => m.id === 'custom-vision-name').input === null, 'automatic reset sends input:null')
assert(lastApply().payload.models.find((m) => m.id === 'custom-vision-name').inputMode === 'auto', 'automatic reset explicitly releases the manual selection')

// Clearing the last wire mapping must leave a reachable save action.
modelNodes = renderModels()
formControl(modelNodes, 'input', 'reqModelField: deepseek-v4.1-flash').onChange({ target: { value: '' } })
modelNodes = renderModels()
assert(buttonByText(modelNodes, 'saveModelConfig'), 'save action remains available after clearing the last mapping')
assert(buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'capability backfill waits for an unsaved mapping change')
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(lastApply().payload.models.find((m) => m.id === 'deepseek-v4.1-flash').requestModel === null, 'clearing a mapping sends requestModel:null')
assert(lastApply().payload.models.every((m) => !Object.hasOwn(m, 'input') && !Object.hasOwn(m, 'inputMode')), 'mapping-only save cannot turn any displayed capability into a manual override')

// Identification sends only IDs so displayed/inferred capabilities cannot be
// mistaken for manual choices. Counts come from the authoritative host result.
modelState = modelState.map((m) => m.id === 'deepseek-v4.1-flash' ? { ...m, input: ['text', 'image'], capabilitySource: 'official', capabilityReference: 'Synthetic official model reference', capabilityConflict: true } : m)
modelNodes = renderModels()
buttonByText(modelNodes, 'identifyCapabilities').onClick()
assert(buttonByText(renderModels(), 'identifyCapabilities').props.disabled, 'identify button is disabled while the request is in flight')
await settle()
assert(lastApply().payload.mode === 'identify' && lastApply().payload.models.length === 3, 'detect-and-save invokes the dedicated identify mode')
assert(lastApply().payload.recheckLegacy === true, 're-identification explicitly requests legacy and automatic capability review')
assert(lastApply().payload.route === 'deepseek' && lastApply().payload.models.every((m) => Object.keys(m).length === 1 && typeof m.id === 'string'), 'identify payload contains only the current model IDs')
modelNodes = renderModels()
const inlineStatus = (nodes) => nodes.find((n) => n.className.includes('mpro-inlineStatus'))
assert(inlineStatus(modelNodes)?.text.includes('1 text + image, 1 text only, 1 unconfirmed') && inlineStatus(modelNodes).text.includes('Kept 1 existing settings; rechecked 2 models; updated 1 models; conflicting catalog labels: 1'), 'identify reports capability, existing-setting preservation, rechecked, updated and conflict counts')
assert(modelNodes.some((n) => n.text === 'Official model reference (declared capability)') && modelNodes.some((n) => n.text.includes('Synthetic official model reference')), 'official metadata is visible as a capability declaration')
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: deepseek-v4.1-flash')?.props.value === 'auto', 'official image metadata remains automatic after re-identification')
assert(inlineStatus(modelNodes).text.includes('Set unconfirmed input capabilities manually'), 'unknown models receive a manual-setting explanation')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'identify button restores enabled state after success')
assert(modelNodes.some((n) => n.text.includes('does not send an image test request')), 'catalog identification is distinguished from a real image test')

// A successful write with zero recognized models must describe that outcome.
identifySummary = { image: 0, text: 0, unknown: 3, preserved: 0, updated: 0, catalogUnavailable: false }
modelState = modelState.map(({ input: _input, capabilitySource: _source, capabilityConflict: _conflict, capabilityReference: _reference, ...m }) => m)
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.text.includes('0 text + image, 0 text only, 3 unconfirmed') && inlineStatus(modelNodes).text.includes('updated 0 models'), 'all-unknown zero-update outcome is visible rather than a generic total model count')
assert(inlineStatus(modelNodes).text.includes('rechecked 0 models') && inlineStatus(modelNodes).text.includes('conflicting catalog labels: 0'), 'older summaries without new fields display zero rather than undefined')

identifySummary = { ...identifySummary, catalogUnavailable: true }
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes('temporarily unavailable. Try again later'), 'unavailable catalog shows a visible retry message')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'catalog failure does not leave the button busy')

// RPC failures must remain visible on the editor, whose parent dashboard is
// replaced while selected. This reproduced the previously silent failure.
identifyError = 'simulated identification failure'
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes(identifyError), 'identify business error is displayed in the current editor')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'identify button restores enabled state after business failure')
identifyError = ''

providerRefreshError = 'simulated model refresh failure'
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes(providerRefreshError), 'refresh failure replaces summary with a visible editor error')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'refresh failure does not leave the button busy')
providerRefreshError = ''

// Hosts without an identification summary can still show the freshly read
// current capabilities, without inventing update counts or a live-test verdict.
identifySummary = null
modelState = modelState.map((m) => m.id === 'deepseek-v4.1-flash' ? { ...m, input: ['text'] } : m.id === 'known-image-model' ? { ...m, input: ['text', 'image'] } : m)
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.text.includes('Current list: 1 text + image, 1 text only, 1 unconfirmed') && !inlineStatus(modelNodes).text.includes('updated'), 'legacy response falls back to refreshed capability counts without claiming updates')

// Remote badges also preserve the distinction between absent metadata and text.
modelNodes = renderModels()
buttonByText(modelNodes, 'discover').onClick()
await settle()
modelNodes = renderModels()
const remoteUnknown = modelNodes.find((n) => n.tag === 'tr' && n.text.includes('unknown-vision'))
assert(remoteUnknown?.text.includes('inputUnknown') && !remoteUnknown.text.includes('inputTextOnly'), 'discovery does not infer capability from a vision-like name')
assert(modelNodes.some((n) => n.tag === 'tr' && n.text.includes('remote-image') && n.text.includes('inputTextImage')), 'discovery displays known image capability')
assert(modelNodes.some((n) => n.text === 'Provider metadata'), 'discovery explains provider metadata capability sources')

// open the add-model form and assert its fields + submit button render
const addToggle = outM.find((n) => n.tag === 'button' && /addModelToggle|addModelHide/i.test(n.text || ''))
assert(addToggle && typeof addToggle.onClick === 'function', 'custom-model add toggle present')
addToggle.onClick()
const outA = []
renderAt(tree, fake, 'root', outA)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outA)
assert(outA.some((n) => String(n.className).includes('mpro-addBar')), 'add-model form panel renders')
assert(outA.some((n) => n.tag === 'button' && /addModelBtn/i.test(n.text || '')), 'add-model submit button renders')
modelNodes = renderModels()
const newCapability = formControl(modelNodes, 'select', 'addModelInputLabel')
assert(newCapability?.props.value === 'auto', 'custom model capability defaults to automatic detection')
const newId = modelNodes.find((n) => n.tag === 'input' && n.props?.placeholder === 'addModelIdPlaceholder')
newId.onChange({ target: { value: 'my-custom-model' } })
newCapability.onChange({ target: { value: 'image' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'addModelBtn').onClick()
await settle()
assert(lastApply().payload.models[0].id === 'my-custom-model' && JSON.stringify(lastApply().payload.models[0].input) === JSON.stringify(['text', 'image']), 'custom model add saves manual image capability')
assert(lastApply().payload.models[0].inputMode === 'manual', 'custom model manual choice includes explicit input intent')
modelNodes = renderModels()
modelNodes.find((n) => n.tag === 'input' && n.props?.placeholder === 'addModelIdPlaceholder').onChange({ target: { value: 'automatic-custom-model' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'addModelBtn').onClick()
await settle()
assert(!Object.hasOwn(lastApply().payload.models[0], 'input'), 'custom model add with automatic detection omits input rather than resetting it')

// -- thinking levels: the list states what each model declares, and the editor
// -- opens on demand. The declaration cannot be discovered or probed, so showing
// -- the current value IS the feature, not decoration.
assert(outA.some((n) => String(n.className).includes('mpro-reasonCell')), 'the model list carries a thinking-level column')
{
  // Mocked models declare nothing, so every row must read as "inherit" rather
  // than implying a capability the settings file never stated.
  const tags = outA.filter((n) => String(n.className).includes('mpro-reasonTag'))
  assert(tags.length >= 2, `every model row shows its declaration, got ${tags.length}`)
  assert(tags.every((n) => /reasonInherit/.test(n.text || '')), 'an undeclared model reads as inherit: ' + JSON.stringify(tags.map((n) => n.text)))
  assert(!outA.some((n) => String(n.className).includes('mpro-reasonBox')), 'the editor stays closed until asked')

  const setBtn = outA.find((n) => n.tag === 'button' && /reasonEdit/i.test(n.text || ''))
  assert(setBtn && typeof setBtn.onClick === 'function', 'each row has a thinking-level Set button')
  setBtn.onClick()
  const warm = []
  renderAt(tree, fake, 'root', warm)
  await new Promise((r) => setTimeout(r, 10))
  // Collect the settled pass into its OWN array: renderAt appends, so reusing
  // one array across both passes double-counts every node.
  const outRe = []
  renderAt(tree, fake, 'root', outRe)
  assert(outRe.some((n) => String(n.className).includes('mpro-reasonBox')), 'the thinking-level editor opens')
  // All three states must be reachable: inherit / does-not-reason / declared
  // levels are genuinely different, and collapsing any two loses information.
  const modes = outRe.filter((n) => String(n.className).includes('mpro-pill') && /reasonMode/i.test(n.text || ''))
  assert(modes.length === 3, `the editor offers inherit / none / levels, got ${modes.length}`)

  // The level table (and the catalog button) belong to the "declare levels"
  // mode — an undeclared model opens in inherit, where there is nothing to fill.
  const levelsMode = modes.find((n) => /reasonModeLevels/i.test(n.text || ''))
  assert(levelsMode && typeof levelsMode.onClick === 'function', 'the declare-levels mode is selectable')
  levelsMode.onClick()
  const warm2 = []
  renderAt(tree, fake, 'root', warm2)
  await new Promise((r) => setTimeout(r, 10))
  const outLv = []
  renderAt(tree, fake, 'root', outLv)
  // Every pi-ai level must be offerable, or a model that supports one of them
  // could never be declared.
  const levelChecks = outLv.filter((n) => n.props && n.props.type === 'checkbox')
  assert(levelChecks.length >= 7, `all seven thinking levels are listed, got ${levelChecks.length}`)
  // With the catalog disabled the fetch button must not exist at all.
  assert(!outLv.some((n) => n.tag === 'button' && /reasonLookup\b/i.test(n.text || '')), 'no catalog button while the lookup is disabled')
  assert(outLv.some((n) => /reasonLookupOff/i.test(n.text || '')), 'the editor explains that the lookup is off')
  // Saving must be blocked until the declaration is one llm-pi-ai will accept:
  // a bad value fails the WHOLE provider section, so a round-trip error is a
  // worse teacher than a disabled button.
  const saveBtn = outLv.find((n) => n.tag === 'button' && /^save$/i.test((n.text || '').trim()))
  assert(saveBtn && saveBtn.props.disabled === true, 'save is blocked while no level is selected')
}

const backBtn = outA.find((n) => n.tag === 'button' && /^←\s*back$/i.test((n.text || '').trim()))
assert(backBtn && typeof backBtn.onClick === 'function', 'provider editor has a back button')
backBtn.onClick()
const outBack = []
renderAt(tree, fake, 'root', outBack)
const restoredDashboard = outBack.find((n) => n.className === 'mpro-root' && typeof n.ref === 'function')
assert(restoredDashboard, 'provider list remounts after returning from editor')
restoredDashboard.ref(editorRoot)
assert(settingsScroll.scrollTop === 260, 'returning from editor restores the provider-list scroll position')

// -- conversation badge (turnTail): select + render pipeline --
{
  const sel = badgeSlot.label.select({ turn: { turn: 7, start: { time: 1700000000000 - 5000 }, end: { time: 1700000000000 } }, seq: 42 })
  assert(sel && typeof sel.from === 'number' && typeof sel.to === 'number' && sel.from < 1700000000000 && sel.to >= 1700000000000, 'badge select derives the turn window: ' + JSON.stringify(sel))
  assert(badgeSlot.label.select({}) === null, 'badge select declines turns without boundaries')
  assert(badgeSlot.label.select(null) === null, 'badge select declines a missing owner')

  // positive render: the mocked log entry (sessionId sess-x) sits inside sel.
  const badgeOut = []
  fake.rerender = () => {}
  let btree = badgeSlot.render({ matched: sel, sessionId: 'sess-x' })
  renderAt(btree, fake, 'badge', badgeOut)
  await new Promise((r) => setTimeout(r, 10))
  btree = badgeSlot.render({ matched: sel, sessionId: 'sess-x' })
  renderAt(btree, fake, 'badge', badgeOut)
  await new Promise((r) => setTimeout(r, 10))
  assert(badgeOut.some((n) => String(n.className).includes('mpro-badgeRow')), 'badge row renders for a routed turn')
  assert(badgeOut.some((n) => (n.text || '') === '路由'), 'badge renders the TRANSLATED label, not the raw dictionary key')
  assert(badgeOut.some((n) => String(n.className).includes('mpro-badgeChip') && /deepseek-chat/.test(n.text || '')), 'badge names the serving target: ' + JSON.stringify(badgeOut.filter((n) => String(n.className).includes('mpro-badge')).map((n) => n.text)))
  // The turn ran at `medium` while the selector still says `max`; the chat view
  // has no other place that admits it.
  assert(badgeOut.some((n) => String(n.className).includes('mpro-badgeChipEffort') && /max/.test(n.text || '') && /medium/.test(n.text || '')),
    'badge surfaces the clamped thinking level: ' + JSON.stringify(badgeOut.filter((n) => String(n.className).includes('mpro-badge')).map((n) => n.text)))

  // a turn outside the window renders nothing
  const far = { from: sel.to + 60_000, to: sel.to + 120_000 }
  const badgeOut2 = []
  let btree2 = badgeSlot.render({ matched: far, sessionId: 'sess-x' })
  renderAt(btree2, fake, 'badgeFar', badgeOut2)
  await new Promise((r) => setTimeout(r, 10))
  btree2 = badgeSlot.render({ matched: far, sessionId: 'sess-x' })
  renderAt(btree2, fake, 'badgeFar', badgeOut2)
  await new Promise((r) => setTimeout(r, 10))
  assert(!badgeOut2.some((n) => String(n.className).includes('mpro-badgeRow')), 'badge stays hidden for turns the router did not serve')

  // -- precise per-turn attribution: the window must end at the NEXT turn's
  // start, never overlap it. Overlapping ±slack windows were the cause of
  // "有时候有有时候没有" (adjacent turns stealing/dropping each others' logs). --
  assert(typeof sel.turn === 'number', 'badge select carries the turn number for precise correlation')

  // turnTimings: turn 1 starts at T, turn 2 starts at T+30s.
  const T = 1700000000000
  const timings = new Map([
    [1, { startTime: T, endTime: T + 20_000 }],
    [2, { startTime: T + 30_000, endTime: T + 50_000 }],
  ])
  const snap = { chat: { turnTimings: timings } }
  const useSession = (fn) => fn(snap)

  const k1 = badgeMod.preciseWindowKey(snap, 1)
  const [f1, t1] = k1.split('|').map(Number)
  assert(t1 === T + 30_000, `turn 1 window ends exactly at turn 2 start, got ${t1 - T}ms offset`)
  assert(f1 === T - 1_000, `turn 1 window starts at its own start (small lead-in), got ${f1 - T}`)

  const k2 = badgeMod.preciseWindowKey(snap, 2)
  const [f2, t2b] = k2.split('|').map(Number)
  assert(f2 === T + 29_000, 'turn 2 window starts at its own start')
  assert(t2b > T + 50_000, 'latest turn keeps an open-ended window so late logs still land')
  assert(f2 >= t1 - 1_000, 'adjacent turn windows do not overlap materially')

  // The REAL DSH source is snapshot.chat.timeline.turns (turn objects with
  // start:{time}), not a turnTimings map — reading only the map was why the
  // precise window silently fell back to the coarse ±slack window on the live
  // build. This asserts the timeline.turns path works identically.
  const turnsMap = new Map([
    [1, { turn: 1, start: { time: T }, end: { time: T + 20_000 }, status: 'closed' }],
    [2, { turn: 2, start: { time: T + 30_000 }, status: 'open' }],
  ])
  const snapTimeline = { chat: { timeline: { turns: turnsMap } } }
  const kt1 = badgeMod.preciseWindowKey(snapTimeline, 1)
  const [ft1, tt1] = kt1.split('|').map(Number)
  assert(tt1 === T + 30_000 && ft1 === T - 1_000, 'timeline.turns path yields the same precise window as turnTimings: ' + kt1)
  // legacy.turnTimings path too.
  const snapLegacy = { chat: { legacy: { turnTimings: timings } } }
  assert(badgeMod.preciseWindowKey(snapLegacy, 1) === k1, 'legacy.turnTimings path yields the same precise window')

  assert(badgeMod.preciseWindowKey({}, 1) === '', 'precise window declines a snapshot without any timing source (falls back)')
  assert(badgeMod.preciseWindowKey(snap, 99) === '', 'precise window declines an unknown turn')
  assert(badgeMod.preciseWindowKey(null, 1) === '', 'precise window is throw-free on a missing snapshot')

  // The component must PREFER the precise window over the coarse `matched`:
  // the mocked log entry sits inside sel, but we pass a precise timeline that
  // places this turn's window far away — the badge must then stay hidden.
  const badgeOut3 = []
  const farTimings = new Map([[sel.turn, { startTime: T + 600_000 }], [sel.turn + 1, { startTime: T + 700_000 }]])
  const farUseSession = (fn) => fn({ chat: { turnTimings: farTimings } })
  let btree3 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: farUseSession })
  renderAt(btree3, fake, 'badgePrecise', badgeOut3)
  await new Promise((r) => setTimeout(r, 10))
  btree3 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: farUseSession })
  renderAt(btree3, fake, 'badgePrecise', badgeOut3)
  await new Promise((r) => setTimeout(r, 10))
  assert(!badgeOut3.some((n) => String(n.className).includes('mpro-badgeRow')),
    'precise timeline window overrides the coarse window (no cross-turn attribution)')

  // ...and with a precise window that DOES contain the entry, it renders again.
  const badgeOut4 = []
  const nearTimings = new Map([[sel.turn, { startTime: sel.from + 4_000 }]])
  const nearUseSession = (fn) => fn({ chat: { turnTimings: nearTimings } })
  let btree4 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: nearUseSession })
  renderAt(btree4, fake, 'badgeNear', badgeOut4)
  await new Promise((r) => setTimeout(r, 10))
  btree4 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: nearUseSession })
  renderAt(btree4, fake, 'badgeNear', badgeOut4)
  await new Promise((r) => setTimeout(r, 10))
  assert(badgeOut4.some((n) => String(n.className).includes('mpro-badgeRow')),
    'badge renders when the precise window contains the routed call')
}

console.log('PASS: client structural smoke — slot registered and redesigned dashboard rendered')
console.log('  nodes:', out.length, '| classes seen:', [...allClassNames].filter((c) => c.includes('mpro-')).slice(0, 8).join(', '))
