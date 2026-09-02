/**
 * Host half end-to-end smoke test.
 *
 * Loads the REAL built `dist/host.js` into a vm sandbox (the same way the
 * dsh-cordis-host-runner evaluates it: wrapped in an async function), with
 * realistic mocks for the `settings` service (persist-on-replace), the `llm`
 * service (listConfigurableProviders / discoverModels / listModels /
 * prepareCall+stream), and the sandboxed `ctx` (get / effect). Then exercises
 * every RPC handler and the unload-restore safety net, asserting each step.
 *
 * Run: `npm test`  (build must be current: `npm run build`)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST_BUNDLE = path.join(__dirname, '..', 'dist', 'host.js')

// ---------------------------------------------------------------------------
// mock settings service — mimics dsh-settings: get() returns the resolved
// section, replace() persists it (null-proto objects from makeHostPlain are
// JSON-safe and stored directly).
// ---------------------------------------------------------------------------
function createSettings(initialDocument) {
  let doc = structuredClone(initialDocument)
  return {
    doc: () => doc,
    get: (ns) => (ns === 'llm-pi-ai' ? doc : undefined),
    writable: true,
    replace: async (ns, section) => {
      if (ns !== 'llm-pi-ai') throw new Error('unexpected ns')
      doc = section
    },
  }
}

/**
 * A settings wrapper that models the REAL dsh-settings timing: the namespace's
 * resolved value is `undefined` until the owning plugin (llm-pi-ai) registers
 * its section, then becomes live. This is the reinstall race — model-pro may
 * apply BEFORE pi-ai, read nothing, and (before the fix) silently skip the
 * re-park of disabled-marked providers sitting in `providers`.
 */
function createLateSettings(store) {
  let registered = false
  const fire = (ns) => { for (const fn of listeners['settings/updated'] || []) try { fn(ns, 1) } catch { /* ignore */ } }
  return {
    get registered() { return registered },
    register: () => {
      registered = true
      // Commit fires settings/updated for the namespace, like dsh-settings.
      queueMicrotask(() => fire('llm-pi-ai'))
    },
    get: (ns) => {
      if (ns === 'llm-pi-ai' && !registered) return undefined
      return store.get(ns)
    },
    get writable() { return store.writable },
    replace: (ns, section) => store.replace(ns, section),
  }
}

// ---------------------------------------------------------------------------
// mock llm service — a catalog provider + an open gateway; prepareCall emits a
// tiny stream like the real pi-ai adapter does.
// ---------------------------------------------------------------------------
function createLlm(log = []) {
  const catalog = [
    { settingsNs: 'llm-pi-ai', provider: 'deepseek', displayName: 'DeepSeek', declared: true },
    { settingsNs: 'llm-pi-ai', provider: 'anthropic', displayName: 'Anthropic', declared: true },
  ]
  const registrations = []
  const failProviders = new Set()
  // Per-provider scripted streams — mimic the REAL pi-ai adapter, which never
  // throws for an unreachable provider: it yields [usage] then finish(error).
  const scriptedStreams = new Map()
  // Per-target model metadata, keyed `provider\0model`. Lets a test give two
  // targets DIFFERENT reasoning efforts / context windows so the router's
  // aggregation and clamping have something real to combine.
  const modelInfo = new Map()
  // Every reasoningEffort the mock was asked to forward, in order, so a test can
  // assert what a target actually received after clamping.
  const effortsSeen = []
  return {
    registrations,
    failProviders,
    scriptedStreams,
    modelInfo,
    effortsSeen,
    listConfigurableProviders: () => catalog,
    discoverModels: async (ns, request) => {
      if (request.api === 'anthropic-messages') return []
      if (!request.baseURL) throw new Error('no baseURL')
      return [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }]
    },
    listModels: async (route) => {
      const p = (log.section().providers || {})[route]
      const ids = Array.isArray(p?.models)
        ? p.models.map((m) => m && typeof m === 'object' ? m.id : String(m))
        : route === 'deepseek' ? ['deepseek-chat', 'deepseek-reasoner'] : []
      return ids.map((id) => ({ id, name: id }))
    },
    registerAdapter: (providers, adapter) => {
      registrations.push({ providers: providers.slice(), adapter })
      return () => {
        const i = registrations.findIndex((r) => r.adapter === adapter)
        if (i >= 0) registrations.splice(i, 1)
      }
    },
    resolveModelInfo: async (provider, model) => {
      const override = modelInfo.get(`${provider}\u0000${model}`)
      if (override === 'throw') throw new Error(`mock: no metadata for ${provider}/${model}`)
      if (override) return { provider, id: model, name: model, ...override }
      return { provider, id: model, name: model, context: { contextWindow: 200000 } }
    },
    prepareCall: async (config, signal) => {
      if (failProviders.has(config.provider)) throw new Error(`mock provider ${config.provider} is down`)
      log.lastConfig = config
      effortsSeen.push({ provider: config.provider, model: config.model, effort: config.reasoningEffort })
      // Mirror the real runtime: an effort the target does not offer is rejected
      // BEFORE any provider I/O, which is exactly what the router's clamp exists
      // to avoid triggering.
      const info = modelInfo.get(`${config.provider}\u0000${config.model}`)
      const offered = info && info !== 'throw' && info.reasoning
        ? info.reasoning.efforts.map((e) => e.id)
        : []
      if (config.reasoningEffort !== undefined && !offered.includes(config.reasoningEffort)) {
        const err = new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${config.reasoningEffort}"`)
        err.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw err
      }
      const scripted = scriptedStreams.get(config.provider)
      // Mirror the real llm runtime: prepareCall exposes the RESOLVED config,
      // and stream() must be dispatched with a config that matches it on the
      // compared fields — the handler now echoes prepared.config back.
      return {
        config: { ...config },
        stream: scripted
          ? (opts) => scripted(opts)
          : async function* (opts) {
              log.lastStreamOpts = opts
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, text: 'pong' }
              yield { type: 'finish', reason: 'stop' }
            },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// load the bundle like the DSH host loader does
//
// Static-bundle mode: dist/host.js is an ESM module that imports
// TypertRemoteService and exports apply/name/inject. The RPC surface is the
// ModelProRuntime service instance created inside apply(). We evaluate the
// bundle in a vm with a stub TypertRemoteService that captures the instance,
// then invoke its camelCase methods (kebab RPC names map to camel via the
// same rule the contract uses).
// ---------------------------------------------------------------------------
const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

async function loadHost() {
  let code = readFileSync(HOST_BUNDLE, 'utf8')
  // Strip the ESM import (stubbed below) and the trailing `export { ... }`.
  code = code.replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']@deepseek-ai\/dsh-typert-protocol["'];?/m, '')
  code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')

  const captured = []
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Promise, AbortController,
    TextEncoder, TextDecoder,
    // stub base: capture each runtime instance so the test can invoke methods
    TypertRemoteService: class {
      constructor(ctx) { this.ctx = ctx; captured.push(this) }
    },
  }
  sandbox.globalThis = sandbox
  const result = await vm.runInContext(
    `(async () => { ${code}\n; return { apply, name, inject }; })()`,
    vm.createContext(sandbox),
    { filename: 'model-pro-host.js' },
  )
  return { apply: result.apply, runtimes: captured }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
}

// ---------------------------------------------------------------------------
// mock credentials service — an in-memory secret store keyed by ref name.
// ---------------------------------------------------------------------------
const credStore = new Map()
const creds = {
  resolve: async (ref) => ({ value: credStore.get(ref) }),
  set: async (ref, value) => { credStore.set(ref, value) },
  unset: async (ref) => { credStore.delete(ref) },
}

// ---------------------------------------------------------------------------
const store = createSettings({ providers: {}, disabledProviders: {}, sectionNote: { hello: 1 } })
const log = { section: () => store.doc() }
const llm = createLlm(log)
const cleanups = []
const listeners = {}
const timerCallbacks = []
const ctx = {
  get: (name) => (
    name === 'settings' ? store
      : name === 'llm' ? llm
        : name === 'credentials' ? creds
          : name === 'timer' ? {
            interval: (fn, _ms) => { timerCallbacks.push(fn); return () => {} },
            timeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
          }
            : undefined
  ),
  // Typert registry stub: apply() registers its manifest through this.
  typert: { register: () => () => {} },
  on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => {} },
  effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
}
/** Fire every registered interval callback once (deterministic flush). */
const tick = async () => { for (const fn of timerCallbacks) { try { await fn() } catch { /* ignore */ } } }
const { apply, runtimes } = await loadHost()
apply(ctx)

// The RPC surface is the captured ModelProRuntime instance. Drive it by the
// same kebab method names the client uses; each maps to a camelCase method.
const runtime = () => runtimes[runtimes.length - 1]
const P = async (name, args) => runtime()[kebabToCamel(name)](args || {})
const provs = () => store.doc().providers || {}
const dis = () => store.doc().disabledProviders || {}

// --- list on empty ---
let r = await P('list-providers')
assert(r.ok && r.providers.length === 0, 'list on empty')
assert(Array.isArray(r.protocols) && r.protocols.includes('openai-completions'), 'protocols returned')

// --- create (validates route + baseURL) ---
r = await P('create-provider', { route: 'my-gw', displayName: 'My Gateway', api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'GW_KEY' })
assert(r.ok, 'create ok: ' + JSON.stringify(r))
assert(/^[A-Za-z0-9_.-]+$/.test(provs()['my-gw'] && 'my-gw'), 'route format kept')
assert(Array.isArray(provs()['my-gw'].models) && provs()['my-gw'].models.length === 1, 'placeholder model added')

r = await P('create-provider', { route: 'bad/', baseURL: 'https://x' })
assert(!r.ok && /字母|route/.test(r.error || ''), 'invalid route rejected')

// --- duplicate ---
r = await P('create-provider', { route: 'my-gw', baseURL: 'https://x' })
assert(!r.ok, 'duplicate route rejected')

// --- list shows active ---
r = await P('list-providers')
assert(r.providers.length === 1 && r.providers[0].disabled === false, 'list shows active provider')

// --- update-field ---
r = await P('update-field', { route: 'my-gw', field: 'baseURL', value: 'https://gw/v2' })
assert(r.ok && provs()['my-gw'].baseURL === 'https://gw/v2', 'update-field persisted')
r = await P('update-field', { route: 'my-gw', field: 'nope', value: 'x' })
assert(!r.ok, 'unknown field rejected')

// --- update-headers (auth skipped) ---
r = await P('update-headers', { route: 'my-gw', headers: [{ name: 'X-Trace', value: 'abc' }, { name: 'authorization', value: 'Bearer x' }] })
assert(r.ok && r.headerCount === 1 && provs()['my-gw'].headers['X-Trace'] === 'abc' && !provs()['my-gw'].headers.authorization, 'headers saved, auth skipped')

// --- discover ---
r = await P('discover-models', { route: 'my-gw', baseURL: 'https://gw/v2', api: 'openai-completions' })
assert(r.ok && r.models.length === 2 && r.models[0].id === 'gpt-4o', 'discover returns models')

// --- apply-models replace ---
r = await P('apply-models', { route: 'my-gw', models: r.models, mode: 'replace' })
assert(r.ok && r.count === 2 && provs()['my-gw'].models.length === 2, 'apply-models replace persisted')

// --- get with availableModels ---
r = await P('get-provider', { route: 'my-gw' })
assert(r.ok && r.disabled === false && r.models.length === 2 && r.availableModels.includes('gpt-4o'), 'get returns models + availableModels')

// --- test-provider (enabled) ---
r = await P('test-provider', { route: 'my-gw', model: 'gpt-4o', prompt: 'ping', maxTokens: 32 })
assert(r.ok && r.reply === 'pong' && r.stopReason === 'stop' && r.latencyMs >= 0, 'test-provider runs: ' + JSON.stringify(r))
assert(log.lastConfig && log.lastConfig.provider === 'my-gw' && log.lastConfig.model === 'gpt-4o' && log.lastConfig.maxTokens === 32, 'prepareCall config shape')
// prepareCall config and the dispatched stream() options must agree on the
// compared fields (this drift was the "prepared LLM call config changed" bug).
assert(log.lastStreamOpts && log.lastStreamOpts.maxTokens === log.lastConfig.maxTokens && log.lastStreamOpts.provider === log.lastConfig.provider && log.lastStreamOpts.model === log.lastConfig.model, 'stream() options match prepared config: ' + JSON.stringify(log.lastStreamOpts))

// --- test-provider on unknown provider ---
r = await P('test-provider', { route: 'ghost' })
assert(!r.ok, 'test unknown route rejected')

// --- set-api-key: encrypted at rest + authoritative copy in credentials ---
const KEY_A = 'sk-test-secret-AAAA'
const KEY_B = 'sk-test-secret-BBBB'
r = await P('set-api-key', { route: 'my-gw', apiKey: KEY_A })
assert(r.ok && r.stored === true && r.envRef === 'GW_KEY', 'set-api-key stores: ' + JSON.stringify(r))
assert(provs()['my-gw'].apiKeyEnc && typeof provs()['my-gw'].apiKeyEnc.ct === 'string', 'apiKeyEnc snapshot written')
assert(!JSON.stringify(provs()['my-gw'].apiKeyEnc).includes('secret-AAAA'), 'plaintext never lands in the config')
assert(credStore.get('GW_KEY') === KEY_A, 'authoritative copy stored in credentials service')
const encKey1 = credStore.get('DSH_MODEL_PRO_ENC_KEY')
assert(typeof encKey1 === 'string' && encKey1.length > 32, 'random encryption key seeded in credentials service')

r = await P('get-provider', { route: 'my-gw' })
assert(r.ok && r.hasSecret === true && r.secret === undefined, 'hasSecret reported, secret hidden by default')
r = await P('get-provider', { route: 'my-gw', includeSecret: true })
assert(r.ok && r.secret === KEY_A, 'get includeSecret decrypts: ' + JSON.stringify(r))
r = await P('list-providers')
assert(r.providers.find((x) => x.route === 'my-gw').hasSecret === true, 'list flags hasSecret')

// --- reinstall stability: enc key is NEVER regenerated, old ciphertext still
// decrypts with the same key (simulate reinstall = settings/credentials persist,
// plugin closure gone; restore the OLD snapshot into the profile). ---
const blobA = structuredClone(provs()['my-gw'].apiKeyEnc)
await P('set-api-key', { route: 'my-gw', apiKey: KEY_B })
assert(credStore.get('DSH_MODEL_PRO_ENC_KEY') === encKey1, 'encryption key unchanged across saves (reinstall-stable)')
assert(credStore.get('GW_KEY') === KEY_B, 'credentials updated to new key')
r = await P('get-provider', { route: 'my-gw', includeSecret: true })
assert(r.ok && r.secret === KEY_B, 'new key decrypts after re-save')
// put the old snapshot back, as a reinstall would (config file unchanged)
store.doc().providers['my-gw'].apiKeyEnc = blobA
r = await P('get-provider', { route: 'my-gw', includeSecret: true })
assert(r.ok && r.secret === KEY_A, 'OLD ciphertext decrypted after reinstall-style restore: ' + JSON.stringify(r))

// --- clear key ---
r = await P('set-api-key', { route: 'my-gw', apiKey: '' })
assert(r.ok && r.stored === false, 'clear key ok')
assert(!provs()['my-gw'].apiKeyEnc, 'clear removes encrypted snapshot')
assert(credStore.get('GW_KEY') === undefined, 'clear removes credential copy')

// --- non-ASCII secret: byte-exact base64 round trip (rejects UTF-8 mangling
// regressions like the real sandbox's utf-8-semanics btoa) ---
const KEY_UA = 'sk-密钥-秘密-secret-中文🙂'
r = await P('set-api-key', { route: 'my-gw', apiKey: KEY_UA })
assert(r.ok && r.stored === true, 'set non-ascii key ok')
r = await P('get-provider', { route: 'my-gw', includeSecret: true })
assert(r.ok && r.secret === KEY_UA, 'non-ascii secret round-trips byte-exact: ' + JSON.stringify(r))
await P('set-api-key', { route: 'my-gw', apiKey: '' }) // leave clean for later sections

// --- disable -> list/get/test ---
r = await P('toggle-provider', { route: 'my-gw', enabled: false })
assert(r.ok && Object.hasOwn(dis(), 'my-gw') && !Object.hasOwn(provs(), 'my-gw'), 'disable moved to disabledProviders')
r = await P('list-providers')
const li = r.providers.find((p) => p.route === 'my-gw')
assert(li && li.disabled === true, 'list flags disabled')
r = await P('get-provider', { route: 'my-gw' })
assert(r.ok && r.disabled === true, 'get flags disabled')
r = await P('test-provider', { route: 'my-gw', model: 'gpt-4o' })
assert(!r.ok && /启用/.test(r.error || ''), 'test on disabled rejected: ' + r.error)

// --- headers/field/model edits still work while disabled ---
r = await P('update-headers', { route: 'my-gw', headers: [] })
assert(r.ok && !dis()['my-gw'].headers, 'headers editable while disabled')

// --- re-enable & test again ---
await P('toggle-provider', { route: 'my-gw', enabled: true })
r = await P('test-provider', { route: 'my-gw', model: 'gpt-4o' })
assert(r.ok && r.reply === 'pong', 'test works after re-enable')

// --- unload safety net: disable a provider, then "uninstall the plugin" ---
await P('toggle-provider', { route: 'my-gw', enabled: false })
assert(Object.hasOwn(dis(), 'my-gw'), 'pre-condition: parked in disabledProviders')
// Re-write the custom header (the earlier "headers editable while disabled"
// check cleared it — update-headers with [] deletes the headers key), so the
// restore check below has real data to verify survives intact.
r = await P('update-headers', { route: 'my-gw', headers: [{ name: 'X-Trace', value: 'abc' }] })
assert(r.ok && dis()['my-gw'].headers && dis()['my-gw'].headers['X-Trace'] === 'abc', 're-arm headers before unload test')
const before = { models: dis()['my-gw'].models.length, headers: dis()['my-gw'].headers, key: dis()['my-gw'].apiKeyEnv }
assert(cleanups.length >= 2, 'unload + router effects registered')
const unloadCleanup = cleanups[cleanups.length - 1]
await Promise.resolve(unloadCleanup())
assert(Object.hasOwn(provs(), 'my-gw'), 'unload restored disabled provider to providers')
assert(!Object.hasOwn(dis(), 'my-gw'), 'unload emptied disabledProviders')
const restored = provs()['my-gw']
assert(restored.models.length === before.models && restored.headers && restored.headers['X-Trace'] === 'abc' && restored.apiKeyEnv === before.key, 'restored data fully intact')
const kept = provs()
assert(!Object.hasOwn(kept, 'deepseek'), 'catalog routes untouched by restore')

// --- delete now that it is active ---
r = await P('delete-provider', { route: 'my-gw' })
assert(r.ok && !Object.hasOwn(provs(), 'my-gw') && !Object.hasOwn(dis(), 'my-gw'), 'delete removes from both dicts')
r = await P('delete-provider', { route: 'my-gw' })
assert(!r.ok, 'delete missing route rejected')

// --- section foreign keys are preserved across every write ---
assert(store.doc().sectionNote && store.doc().sectionNote.hello === 1, 'section foreign keys preserved across writes')

// --- disabled marker lives ON THE PROVIDER PROFILE (not only the dict) ---
await P('create-provider', { route: 'flag-gw', baseURL: 'https://flag/v1' })

// disable -> marker set + parked out of providers
r = await P('toggle-provider', { route: 'flag-gw', enabled: false })
assert(r.ok, 'disable ok')
assert(dis()['flag-gw'] && dis()['flag-gw'].disabled === true, 'disable sets the disabled marker on the profile')
assert(!Object.hasOwn(provs(), 'flag-gw'), 'disabled provider parked out of providers (adapter stops seeing it)')
r = await P('list-providers')
assert(r.providers.find((x) => x.route === 'flag-gw').disabled === true, 'list shows disabled from the marker')

// unload: disabledProviders restored to providers, marker INTACT
await Promise.resolve(cleanups[cleanups.length - 1]())
assert(provs()['flag-gw'] && provs()['flag-gw'].disabled === true, 'unload restores to providers keeping the disabled marker')
assert(!Object.hasOwn(dis(), 'flag-gw'), 'unload empties disabledProviders')
r = await P('list-providers')
assert(r.providers.find((x) => x.route === 'flag-gw').disabled === true, 'still shown disabled (marker) after restore')

// reinstall: a fresh apply re-parks marked providers -> same disabled state
apply(ctx)
await new Promise((res) => setTimeout(res, 5))
assert(Object.hasOwn(dis(), 'flag-gw') && dis()['flag-gw'].disabled === true, 'reinstall re-parks the marked provider')
r = await P('list-providers')
assert(r.providers.find((x) => x.route === 'flag-gw').disabled === true, 'reinstall list still disabled')

// --- reinstall with pi-ai loading AFTER model-pro: the section is not
// resolvable at apply time, so the eager park reads nothing. The
// `settings/updated` re-park must catch the markers the moment the namespace
// commits — otherwise llm-pi-ai's resolveProfiles (which ignores the marker)
// registers them as ACTIVE routes and disabled models resurface. ---
{
  const lateStore = createSettings({
    providers: { lateGw: { baseURL: 'https://late/v1', disabled: true } },
    disabledProviders: {},
    noteK: 1,
  })
  const late = createLateSettings(lateStore)
  listeners['settings/updated'] = []
  const lateCtx = {
    get: (name) => (name === 'settings' ? late : name === 'llm' ? llm : name === 'credentials' ? creds : undefined),
    typert: { register: () => () => {} },
    on: ctx.on,
    effect: ctx.effect,
  }
  apply(lateCtx)
  // Eager attempt ran against an unregistered section -> must NOT have parked yet.
  const lateDoc = () => lateStore.doc()
  assert(!Object.hasOwn(lateDoc().disabledProviders || {}, 'lateGw'), 'eager park no-ops while the section is unregistered')
  assert(
    Object.hasOwn(lateDoc().providers || {}, 'lateGw') && lateDoc().providers.lateGw.disabled === true,
    'marked provider still sits in providers before pi-ai loads',
  )

  // Now pi-ai registers its namespace and commits -> settings/updated fires.
  await Promise.resolve()
  late.register()
  await new Promise((res) => setTimeout(res, 5))

  assert(
    Object.hasOwn(lateDoc().disabledProviders || {}, 'lateGw') && lateDoc().disabledProviders.lateGw.disabled === true,
    'settings/updated re-park parks the marked provider once the namespace commits',
  )
  assert(!Object.hasOwn(lateDoc().providers || {}, 'lateGw'), 'parked provider removed from providers after late registration')
  assert(lateDoc().noteK === 1, 'foreign section keys survive the late re-park write')

  // Restore shared harness state: drop the second runtime + the listeners it
  // registered, so the following tests keep driving the ORIGINAL instance.
  runtimes.pop()
  listeners['settings/updated'] = []
}

// enable: clears the marker and returns it to providers
r = await P('toggle-provider', { route: 'flag-gw', enabled: true })
assert(r.ok && provs()['flag-gw'] && !provs()['flag-gw'].disabled, 'enable clears the disabled marker')
await P('delete-provider', { route: 'flag-gw' })

// --- smart routing: named route combos + router adapter forwarding ---
r = await P('set-route', { alias: 'auto', strategy: 'priority', targets: [{ provider: 'opencode-go', model: 'deepseek-v4-flash' }] })
assert(r.ok, 'set-route ok: ' + JSON.stringify(r))
r = await P('set-route', { alias: 'bad route', strategy: 'priority', targets: [{ provider: 'x', model: 'y' }] })
assert(!r.ok, 'invalid route name rejected')
r = await P('set-route', { alias: 'empty', strategy: 'priority', targets: [] })
assert(!r.ok, 'empty targets rejected')
r = await P('list-routes')
assert(r.ok && r.routes.auto && r.routes.auto.strategy === 'priority' && r.routes.auto.targets[0].provider === 'opencode-go' && r.routes.auto.targets[0].model === 'deepseek-v4-flash', 'list-routes returns route combo: ' + JSON.stringify(r.routes))
assert(store.doc().routes && store.doc().routes.auto && store.doc().routes.auto.targets[0].model === 'deepseek-v4-flash', 'routes persisted under the section foreign key')
assert(store.doc().sectionNote && store.doc().sectionNote.hello === 1, 'route write preserves other section keys')

const rreg = llm.registrations.find((x) => x.providers.includes('router'))
assert(rreg && rreg.adapter, 'router adapter registered for route [router]')
const rm = await rreg.adapter.listModels('router')
assert(Array.isArray(rm) && rm.some((m) => m.id === 'auto'), 'router lists named routes as models')
const rinfo = await rreg.adapter.resolveModel('router', 'auto')
assert(rinfo && rinfo.id === 'auto' && rinfo.context && rinfo.context.contextWindow === 200000, 'router resolves route to aggregated target metadata')

// --- adapter.prepareCall: the contract dsh-llm >= 0.1.1-rc.2 dispatches through.
// That runtime calls `registration.adapter.prepareCall(provider, model, signal)`
// from BOTH its prepared-call and direct-stream paths and uses ONLY the returned
// `stream`, so a router adapter without it fails every request with
// "registration.adapter.prepareCall is not a function" (issue #1).
assert(typeof rreg.adapter.prepareCall === 'function', 'router adapter exposes prepareCall (dsh-llm >= 0.1.1-rc.2 contract)')

// `imageRequestPricing` joined the contract in 0.1.2-alpha.1 and the runtime
// forwards it with no existence check, so a missing method is a TypeError the
// moment token-meter measures a routed session. A virtual route declares none.
assert(typeof rreg.adapter.imageRequestPricing === 'function', 'router adapter exposes imageRequestPricing (dsh-llm >= 0.1.2-alpha.1 contract)')
assert(rreg.adapter.imageRequestPricing('router', 'auto') === undefined, 'virtual route declares no image pricing (consumers use their own estimate)')
const rprep = await rreg.adapter.prepareCall('router', 'auto')
assert(rprep && rprep.model && rprep.model.id === 'auto' && typeof rprep.stream === 'function', 'prepareCall returns { model, stream }: ' + JSON.stringify(rprep && rprep.model))
assert(rprep.model.context && rprep.model.context.contextWindow === 200000, 'prepareCall carries target metadata through')
let sawPreparedPong = false
let pguard = 0
for await (const c of rprep.stream({
  provider: 'router', model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  temperature: 0, maxTokens: 16, signal: undefined,
})) {
  if (c && c.type === 'text-delta' && c.text === 'pong') sawPreparedPong = true
  if (++pguard >= 4) break
}
assert(sawPreparedPong, 'prepareCall().stream() dispatches through the router')
assert(log.lastConfig && log.lastConfig.provider === 'opencode-go', 'prepareCall dispatch still forwards to the route target: ' + JSON.stringify(log.lastConfig))

let sawPong = false
let guard = 0
for await (const c of rreg.adapter.stream({
  provider: 'router', model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  temperature: 0, maxTokens: 16, signal: undefined,
})) {
  if (c && c.type === 'text-delta' && c.text === 'pong') sawPong = true
  if (++guard >= 4) break
}
assert(log.lastConfig && log.lastConfig.provider === 'opencode-go' && log.lastConfig.model === 'deepseek-v4-flash', 'router stream forwarded to target: ' + JSON.stringify(log.lastConfig))
assert(sawPong, 'router stream passes through target chunks')

// --- priority + fallback: a dead first target is skipped ---
llm.failProviders.add('brokengw')
await P('set-route', {
  alias: 'auto', strategy: 'priority',
  targets: [
    { provider: 'brokengw', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
let sawPong2 = false
let guard2 = 0
for await (const c of rreg.adapter.stream({
  provider: 'router', model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  temperature: 0, maxTokens: 16,
})) {
  if (c && c.type === 'text-delta' && c.text === 'pong') sawPong2 = true
  if (++guard2 >= 4) break
}
assert(log.lastConfig && log.lastConfig.provider === 'opencode-go' && log.lastConfig.model === 'deepseek-v4-flash', 'router fell back to healthy target: ' + JSON.stringify(log.lastConfig))
assert(sawPong2, 'fallback target streams through')
llm.failProviders.delete('brokengw')

// --- REAL pi-ai failure shape: unreachable providers NEVER throw; they emit
// [usage] then finish(error). The old router committed on the first chunk
// (the harmless usage) and passed the error straight through — no failover.
// The pre-commit buffer must treat this exactly like a dead target. ---
llm.scriptedStreams.set('piashape', async function* () {
  yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 0 } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'connect ECONNREFUSED 127.0.0.1:9', code: 'TRANSPORT' } } }
})
await P('create-provider', { route: 'piashape', baseURL: 'https://pia/v1' }).catch(() => {})
await P('set-route', {
  alias: 'auto-piashape', strategy: 'priority',
  targets: [
    { provider: 'piashape', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
{
  let sawPong3 = false
  let sawLeak = false
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-piashape',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    temperature: 0, maxTokens: 16, sessionId: 'sess-piashape',
  })) {
    if (c && c.type === 'text-delta' && c.text === 'pong') sawPong3 = true
    if (c && c.type === 'finish' && c.reason && typeof c.reason === 'object' && c.reason.kind === 'error') sawLeak = true
  }
  assert(sawPong3, 'pi-ai-shaped failure falls over to the healthy target')
  assert(!sawLeak, 'error finish from a dead first target never reaches the consumer')
}
// the committed (second-attempt) call is logged with fallback status
{
  const lr = await P('list-request-logs', { sessionId: 'sess-piashape' })
  const okEntries = (lr.entries || []).filter((e) => e.status !== 'error')
  assert(okEntries.some((e) => e.status === 'fallback' && e.target.provider === 'opencode-go'), 'fallback outcome recorded in request log: ' + JSON.stringify(okEntries))
}

// --- timeoutMs: a hung first target must not stall the route; the deadline
// abandons it and the second target answers. ---
llm.scriptedStreams.set('hangup', async function* () {
  await new Promise((resolve) => setTimeout(resolve, 500))
  yield { type: 'block-start', index: 0, blockType: 'text' }
})
await P('create-provider', { route: 'hangup', baseURL: 'https://hang/v1' }).catch(() => {})
await P('set-route', {
  alias: 'auto-timeout', strategy: 'priority', config: { timeoutMs: 60 },
  targets: [
    { provider: 'hangup', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
{
  const t0 = Date.now()
  let sawPong4 = false
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-timeout',
    messages: [], temperature: 0, maxTokens: 16,
  })) {
    if (c && c.type === 'text-delta' && c.text === 'pong') sawPong4 = true
  }
  const took = Date.now() - t0
  assert(sawPong4, 'timeout on a hung target still serves via fallback target')
  assert(took < 400, `timeout budget respected (${took}ms << 500ms hang)`)
}

// --- caller abort mid-negotiation is honored: aborted finish passes through,
// and routing does NOT retry the next target after a caller abort. ---
llm.scriptedStreams.set('abortgw', async function* () {
  yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 0 } }
  yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by caller', code: 'ABORTED' } } }
})
await P('create-provider', { route: 'abortgw', baseURL: 'https://abort/v1' }).catch(() => {})
await P('set-route', {
  alias: 'auto-abort', strategy: 'priority',
  targets: [
    { provider: 'abortgw', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
{
  let sawAborted = false
  let hitSecondTarget = false
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-abort',
    messages: [], temperature: 0, maxTokens: 16,
  })) {
    if (c && c.type === 'finish' && c.reason && typeof c.reason === 'object' && c.reason.kind === 'aborted') sawAborted = true
  }
  hitSecondTarget = log.lastConfig && log.lastConfig.provider === 'opencode-go'
  assert(sawAborted, 'caller abort surfaces as an aborted finish')
  assert(!hitSecondTarget, 'no cross-target retry after an abort')
}

// --- empty-success passthrough: finish(stop) with zero content commits and
// passes through rather than spinning every target. ---
llm.scriptedStreams.set('emptygw', async function* () {
  yield { type: 'usage', usage: { input_tokens: 2, output_tokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})
await P('create-provider', { route: 'emptygw', baseURL: 'https://empty/v1' }).catch(() => {})
await P('set-route', {
  alias: 'auto-empty', strategy: 'priority',
  targets: [
    { provider: 'emptygw', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
{
  let sawStop = false
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-empty',
    messages: [], temperature: 0, maxTokens: 16,
  })) {
    if (c && c.type === 'finish') sawStop = true
  }
  const servedByEmpty = log.lastConfig && log.lastConfig.provider === 'emptygw'
  assert(sawStop, 'clean empty stop passes through to the consumer')
  assert(servedByEmpty, 'empty success commits to its target instead of failing over')
}

// --- MID-STREAM provider death (the new-api 500 shape): the gateway accepts,
// streams a delta, THEN answers "负载已达上限". Content already reached the
// consumer so transparent switching is impossible — but the bookkeeping must
// tell the truth: log entry is an ERROR carrying the message, and the target
// records the failure so the model-level retry can avoid it. ---
llm.scriptedStreams.set('middeath', async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'partial ' }
  yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 1 } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'OpenAI API error (500): 当前模型 gpt-5.6-sol 负载已经达到上限', code: 'SERVER' } } }
})
await P('create-provider', { route: 'middeath', baseURL: 'https://mid/v1' }).catch(() => {})
await P('set-route', {
  alias: 'auto-middeath', strategy: 'priority',
  targets: [{ provider: 'middeath', model: 'x' }],
})
{
  let lastChunk = null
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-middeath',
    messages: [], temperature: 0, maxTokens: 16, sessionId: 'sess-mid',
  })) {
    lastChunk = c
  }
  assert(lastChunk && lastChunk.type === 'finish' && lastChunk.reason && lastChunk.reason.kind === 'error', 'mid-stream error finish reaches the consumer for agent-level handling')
  const lr = await P('list-request-logs', { sessionId: 'sess-mid' })
  const entry = (lr.entries || []).find((e) => e.target && e.target.provider === 'middeath')
  assert(entry && entry.status === 'error' && /负载已经达到上限/.test(String(entry.error || '')), `mid-stream failure logged as ERROR with the message: ${JSON.stringify(entry)}`)
  const gs = await P('get-route-stats')
  const h = (gs.health || {})['middeath\u0000x']
  assert(h && typeof h.lastError === 'string' && /负载/.test(h.lastError), 'mid-stream failure updates target health: ' + JSON.stringify(h))
}

// --- all targets dead -> clean route-level error (no infinite hang) ---
llm.failProviders.add('brokengw')
await P('set-route', { alias: 'dead', strategy: 'priority', targets: [{ provider: 'brokengw', model: 'x' }] })
let deadErr = ''
try {
  const it2 = rreg.adapter.stream({ provider: 'router', model: 'dead', messages: [], signal: undefined })
  const itr = it2[Symbol.asyncIterator]()
  let seen = 0
  while (seen < 3) { const n = await itr.next(); if (n.done) break; seen += 1 }
} catch (e) { deadErr = String((e && e.message) || e) }
assert(/全部目标失败/.test(deadErr), 'all-targets-dead surfaces route error: ' + deadErr)
llm.failProviders.delete('brokengw')

// --- per-provider local mapping: select gpt-4o, forward its requestModel ---
await P('create-provider', { route: 'map-gw', baseURL: 'https://map/v1' })
r = await P('apply-models', { route: 'map-gw', models: [{ id: 'gpt-4o', requestModel: 'wire-4o' }], mode: 'replace' })
assert(r.ok === true, 'requestModel saved on model entry')
const streamListeners = listeners['llm/stream'] || []
assert(streamListeners.length >= 1, 'llm/stream waterfall listener registered')
let forwarded = null
const firstListener = streamListeners[0]
const ret = firstListener(
  { provider: 'map-gw', model: 'gpt-4o', messages: [], temperature: 0 },
  (opts) => { forwarded = opts; return 'NEXTED' },
)
assert(forwarded && forwarded.model === 'wire-4o', 'llm/stream rewrites selectable id to wire id: ' + JSON.stringify(forwarded))
assert(typeof ret === 'string' && ret === 'NEXTED', 'rewrite returns next() result')
// a model without requestModel passes through unchanged
streamListeners[0]({ provider: 'map-gw', model: 'plain', messages: [] }, (opts) => { forwarded = opts })
assert(forwarded.model === 'plain', 'unmapped model passes through unchanged')
// router-provider calls are never rewritten
streamListeners[0]({ provider: 'router', model: 'auto', messages: [] }, (opts) => { forwarded = opts })
assert(forwarded.model === 'auto', 'router calls bypass the rewrite')
await P('delete-provider', { route: 'map-gw' })

// --- reasoningEfforts: validated on the way in, never silently dropped -------
// The field is hand-authored only (no listing endpoint reports a model's
// reasoning protocol), so losing it means losing information the user typed.
await P('create-provider', { route: 'reason-gw', baseURL: 'https://reason/v1' })
const entryOf = (route, id) => {
  const list = (provs()[route] || {}).models
  return (Array.isArray(list) ? list : []).find((m) => m && m.id === id)
}

r = await P('apply-models', {
  route: 'reason-gw',
  models: [{ id: 'r1', reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
  mode: 'replace',
})
assert(r.ok === true, 'a valid reasoningEfforts dict is accepted: ' + JSON.stringify(r))
let re = entryOf('reason-gw', 'r1').reasoningEfforts
assert(re && re.low === 'low' && re.high === 'high', 'reasoningEfforts persisted: ' + JSON.stringify(re))
assert(re.off === null, 'off keeps its null (supported, send nothing)')
assert(JSON.stringify(Object.keys(re)) === JSON.stringify(['off', 'low', 'high']), 'levels persist in canonical ascending order: ' + JSON.stringify(Object.keys(re)))

// `false` is a real value meaning "does not reason", distinct from absence.
r = await P('apply-models', { route: 'reason-gw', models: [{ id: 'r2', reasoningEfforts: false }], mode: 'merge' })
assert(r.ok === true && entryOf('reason-gw', 'r2').reasoningEfforts === false, 'reasoningEfforts:false persists as false')

// The rejections below all mirror llm-pi-ai's own config schema, which fails the
// WHOLE provider section on a bad value — so accepting one would take every
// model of this provider offline, not just the bad entry.
const rejects = [
  [{ id: 'r3', reasoningEfforts: {} }, 'an empty dict is rejected'],
  [{ id: 'r3', reasoningEfforts: { off: null } }, 'a dict offering only off is rejected'],
  [{ id: 'r3', reasoningEfforts: { low: '' } }, 'an empty wire value is rejected'],
  [{ id: 'r3', reasoningEfforts: { high: null } }, 'a null on a non-off level is rejected'],
  [{ id: 'r3', reasoningEfforts: { ultra: 'x' } }, 'an unknown level name is rejected'],
  [{ id: 'r3', reasoningEfforts: true }, 'a bare true is rejected (wire spellings cannot be inferred)'],
  [{ id: 'r3', reasoningEfforts: ['low'] }, 'an array is rejected'],
]
for (const [entry, why] of rejects) {
  const res = await P('apply-models', { route: 'reason-gw', models: [entry], mode: 'merge' })
  assert(res.ok === false && /r3/.test(res.error || ''), why + ': ' + JSON.stringify(res))
  assert(!entryOf('reason-gw', 'r3'), why + ' — and nothing was written')
}

// A rejected call must not partially apply: r1 is valid but shares the call.
r = await P('apply-models', {
  route: 'reason-gw',
  models: [{ id: 'r1', reasoningEfforts: { off: null, medium: 'medium' } }, { id: 'bad', reasoningEfforts: {} }],
  mode: 'merge',
})
assert(r.ok === false, 'one bad entry rejects the whole call')
re = entryOf('reason-gw', 'r1').reasoningEfforts
assert(re.high === 'high' && re.medium === undefined, 'the valid sibling entry was NOT written: ' + JSON.stringify(re))

// Discovery returns id/name/context/maxTokens only. A discover-then-replace
// cycle used to wipe hand-authored fields; they must now survive.
r = await P('apply-models', {
  route: 'reason-gw',
  models: [{ id: 'r1', name: 'R One', contextWindow: 128000 }],
  mode: 'replace',
})
const keptEntry = entryOf('reason-gw', 'r1')
assert(r.ok === true && keptEntry.reasoningEfforts && keptEntry.reasoningEfforts.high === 'high', 'replace preserves reasoningEfforts a discovery payload omits: ' + JSON.stringify(keptEntry))
assert(keptEntry.contextWindow === 128000, 'replace still applies the discovered fields')

// requestModel is hand-authored the same way, and was equally exposed.
await P('apply-models', { route: 'reason-gw', models: [{ id: 'r4', requestModel: 'wire-4' }], mode: 'merge' })
await P('apply-models', { route: 'reason-gw', models: [{ id: 'r4', name: 'R Four' }], mode: 'replace' })
assert(entryOf('reason-gw', 'r4').requestModel === 'wire-4', 'replace preserves requestModel too')

// An explicit null CLEARS the field — otherwise "stop overriding the catalog"
// would be unreachable, since merge preserves whatever it does not mention.
r = await P('apply-models', { route: 'reason-gw', models: [{ id: 'r1', reasoningEfforts: null }], mode: 'merge' })
assert(r.ok === true, 'an explicit null is accepted')
assert(!('reasoningEfforts' in entryOf('reason-gw', 'r1')), 'null clears the field rather than resurrecting the saved value: ' + JSON.stringify(entryOf('reason-gw', 'r1')))
await P('delete-provider', { route: 'reason-gw' })

// deleting a route must work even when the resolved section object is frozen
// (regression: readRoutes used to return the frozen settings object, so
// `delete routes['0']` threw "Cannot delete property of [object Object]")
Object.freeze(store.doc().routes)
r = await P('delete-route', { alias: 'auto' })
assert(r.ok && !(await P('list-routes')).routes.auto, 'delete-route removes mapping on frozen section')
r = await P('delete-route', { alias: 'dead' })
assert(r.ok, 'delete-route removes dead route on frozen section')

// ---------------------------------------------------------------------------
// NEW: multi-strategy routes + route weights
// ---------------------------------------------------------------------------

// --- weighted route: weights accepted and preserved, strategy validated ---
r = await P('set-route', {
  alias: 'wb', strategy: 'round-robin',
  targets: [
    { provider: 'opencode-go', model: 'deepseek-v4-flash', weight: 3 },
    { provider: 'opencode-go', model: 'deepseek-v4-flash-2', weight: 1, enabled: true },
  ],
})
assert(r.ok, 'set-route accepts weights + round-robin: ' + JSON.stringify(r))
const wb = (await P('list-routes')).routes.wb
assert(wb.strategy === 'round-robin' && wb.targets[0].weight === 3 && wb.targets[1].weight === 1, 'route weights persisted')

r = await P('set-route', { alias: 'badstrat', strategy: 'quantum', targets: [{ provider: 'x', model: 'y' }] })
assert(r.ok && r.route.strategy === 'priority', 'unknown strategy falls back to priority (tolerant): ' + JSON.stringify(r))
await P('delete-route', { alias: 'badstrat' })

// --- round-robin rotates across same-provider targets with weights ---
llm.failProviders.delete('opencode-go')
const wbStream = async () => {
  let got = ''
  for await (const c of rreg.adapter.stream({ provider: 'router', model: 'wb', messages: [], temperature: 0 })) {
    if (c && c.type === 'text-delta' && c.text === 'pong') got = 'pong'
  }
  return got
}
assert((await wbStream()) === 'pong', 'round-robin route streams')
assert(log.lastConfig && log.lastConfig.model === 'deepseek-v4-flash', 'first round-robin pick = highest weight: ' + JSON.stringify(log.lastConfig))

// --- health-aware: a down target is skipped when a healthy one exists ---
llm.failProviders.add('brokengw')
await P('probe-target', { provider: 'brokengw', model: 'x' })
await P('set-route', {
  alias: 'healthz', strategy: 'priority',
  targets: [
    { provider: 'brokengw', model: 'x' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  ],
})
let gotHealth = ''
for await (const c of rreg.adapter.stream({ provider: 'router', model: 'healthz', messages: [], signal: undefined })) {
  if (c && c.type === 'text-delta' && c.text === 'pong') gotHealth = 'pong'
}
assert(log.lastConfig && log.lastConfig.provider === 'opencode-go', 'health-aware skips probe-down target: ' + JSON.stringify(log.lastConfig))
assert(gotHealth === 'pong', 'health-aware streams through healthy target')
llm.failProviders.delete('brokengw')

// --- min-latency strategy: order by recorded latency, lowest first ---
await P('set-route', {
  alias: 'ml', strategy: 'min-latency',
  targets: [
    { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4-flash-2' },
  ],
})
let gotMl = ''
for await (const c of rreg.adapter.stream({ provider: 'router', model: 'ml', messages: [] })) {
  if (c && c.type === 'text-delta' && c.text === 'pong') gotMl = 'pong'
}
assert(gotMl === 'pong', 'min-latency route streams')
await P('delete-route', { alias: 'wb' })
await P('delete-route', { alias: 'healthz' })
await P('delete-route', { alias: 'ml' })

// ---------------------------------------------------------------------------
// NEW: composite providers (并集/交集)
// ---------------------------------------------------------------------------

// --- union composite of two explicit-model providers ---
await P('create-provider', { route: 'comp-a', baseURL: 'https://a/v1' })
await P('apply-models', { route: 'comp-a', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }], mode: 'replace' })
await P('create-provider', { route: 'comp-b', baseURL: 'https://b/v1' })
await P('apply-models', { route: 'comp-b', models: [{ id: 'gpt-4o' }, { id: 'claude-3' }], mode: 'replace' })

r = await P('set-composite', { name: 'mixture', members: ['comp-a', 'comp-b'], mode: 'union', strategy: 'priority' })
assert(r.ok, 'set-composite union ok: ' + JSON.stringify(r))
r = await P('set-composite', { name: 'solo', members: ['comp-a'] })
assert(!r.ok, 'composite with 1 member rejected')
r = await P('set-composite', { name: 'ghost', members: ['comp-a', 'nope'] })
assert(!r.ok && /不存在/.test(r.error || ''), 'composite with unknown member rejected')

r = await P('list-composites')
assert(r.ok && r.composites.mixture && r.composites.mixture.mode === 'union', 'list-composites returns mixture')
r = await P('preview-composite', { name: 'mixture' })
assert(r.ok && r.mode === 'union', 'preview union ok')
assert(Array.isArray(r.ids) && r.ids.length === 3 && r.ids.includes('gpt-4o') && r.ids.includes('gpt-4o-mini') && r.ids.includes('claude-3'), 'union resolves all member models: ' + JSON.stringify(r.ids))

// intersection: only ids present in every member
r = await P('set-composite', { name: 'common', members: ['comp-a', 'comp-b'], mode: 'intersection' })
assert(r.ok, 'set-composite intersection ok')
r = await P('preview-composite', { name: 'common' })
assert(r.ok && r.mode === 'intersection' && Array.isArray(r.ids) && r.ids.length === 1 && r.ids[0] === 'gpt-4o', 'intersection resolves shared model only: ' + JSON.stringify(r.ids))

// composite route is registered and streams through a member
const creg = llm.registrations.find((x) => x.providers.includes('composite'))
assert(creg && creg.adapter, 'composite adapter registered for route [composite]')
const cm = await creg.adapter.listModels('composite')
assert(Array.isArray(cm) && cm.some((m) => m.id === 'mixture::gpt-4o') && cm.some((m) => m.id === 'common::gpt-4o'), 'composite lists encoded models: ' + JSON.stringify(cm.map((m) => m.id)))
let gotComp = ''
for await (const c of creg.adapter.stream({ provider: 'composite', model: 'mixture::gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], temperature: 0 })) {
  if (c && c.type === 'text-delta' && c.text === 'pong') gotComp = 'pong'
}
assert(gotComp === 'pong', 'composite streams through owning member')
assert(log.lastConfig && (log.lastConfig.provider === 'comp-a' || log.lastConfig.provider === 'comp-b') && log.lastConfig.model === 'gpt-4o', 'composite forwards to owning member: ' + JSON.stringify(log.lastConfig))

// composite honours the same prepareCall contract as the router route (issue #1)
const cprep = await creg.adapter.prepareCall('composite', 'mixture::gpt-4o')
assert(cprep && cprep.model && cprep.model.id === 'mixture::gpt-4o' && typeof cprep.stream === 'function', 'composite prepareCall returns { model, stream }')
let gotCompPrepared = ''
for await (const c of cprep.stream({ provider: 'composite', model: 'mixture::gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], temperature: 0 })) {
  if (c && c.type === 'text-delta' && c.text === 'pong') gotCompPrepared = 'pong'
}
assert(gotCompPrepared === 'pong', 'composite prepareCall().stream() dispatches through the owning member')

// composite stats + request log recorded
r = await P('get-route-stats')
assert(r.ok && r.byTarget, 'get-route-stats ok')
const targetKey = Object.keys(r.byTarget || {}).find((k) => k.includes('gpt-4o'))
assert(targetKey && r.byTarget[targetKey].calls >= 1, 'routed call recorded in stats: ' + JSON.stringify(r.byTarget[targetKey]))
r = await P('list-request-logs')
assert(r.ok && Array.isArray(r.entries) && r.entries.length >= 1, 'request log has routed entries')
const compLog = r.entries.find((e) => e.route === 'mixture::gpt-4o')
assert(compLog && compLog.status === 'ok' && typeof compLog.latencyMs === 'number', 'composite log entry recorded: ' + JSON.stringify(compLog))
r = await P('clear-request-logs')
assert(r.ok && (await P('list-request-logs')).entries.length === 0, 'clear-request-logs empties ring')

// --- token accounting: the router must read the CANONICAL DSH TokenUsage
// chunk shape (camelCase inputTokens/outputTokens, what pi-ai's mapUsage
// emits), not just the raw snake_case names. This is the "输入输出 token 显示
// 为空 / 统计为空" regression. ---
llm.scriptedStreams.set('camelgw', async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'pong' }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})
await P('create-provider', { route: 'camelgw', baseURL: 'https://camel/v1' }).catch(() => {})
await P('set-route', { alias: 'auto-camel', strategy: 'priority', targets: [{ provider: 'camelgw', model: 'x' }] })
{
  for await (const c of rreg.adapter.stream({
    provider: 'router', model: 'auto-camel',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    temperature: 0, maxTokens: 16, sessionId: 'sess-camel',
  })) { /* drain */ }
  const rs = await P('get-route-stats')
  const tk = Object.keys(rs.byTarget || {}).find((k) => k.includes('camelgw'))
  assert(tk && rs.byTarget[tk].tokensIn === 12 && rs.byTarget[tk].tokensOut === 7,
    'camelCase TokenUsage counted into stats: ' + JSON.stringify(tk && rs.byTarget[tk]))
  const lg = await P('list-request-logs', { sessionId: 'sess-camel' })
  const camelLog = (lg.entries || []).find((e) => e.route === 'auto-camel')
  assert(camelLog && camelLog.tokens && camelLog.tokens.in === 12 && camelLog.tokens.out === 7,
    'camelCase tokens land on the request-log entry: ' + JSON.stringify(camelLog && camelLog.tokens))
}

// --- persistence: stats + a capped request-log tail are written to the
// settings snapshot (routeStats) so the 观测台 and the conversation 尾标 survive
// a page refresh / host restart, and a FRESH fiber re-hydrates them. This is
// the "统计为空 / 尾标不会持久化" regression. ---
{
  await tick() // debounced flush fires the persisted snapshot
  const snap = store.doc().routeStats
  assert(snap && typeof snap === 'object', 'routeStats snapshot persisted to settings: ' + JSON.stringify(Object.keys(store.doc())))
  assert(snap.byTarget && Object.keys(snap.byTarget).some((k) => k.includes('camelgw')), 'aggregate stats persisted: ' + JSON.stringify(snap.byTarget && Object.keys(snap.byTarget)))
  assert(Array.isArray(snap.logs) && snap.logs.some((e) => e.route === 'auto-camel'), 'request-log tail persisted: ' + JSON.stringify(snap.logs && snap.logs.length))

  // Simulate a page refresh / host restart: a brand-new fiber (fresh apply)
  // must re-hydrate the recorder + log ring from that snapshot rather than
  // starting blank.
  apply(ctx)
  const rs2 = await P('get-route-stats')
  assert(rs2.byTarget && Object.keys(rs2.byTarget).some((k) => k.includes('camelgw')), 're-applied fiber re-hydrates stats: ' + JSON.stringify(Object.keys(rs2.byTarget || {})))
  const lg2 = await P('list-request-logs', { sessionId: 'sess-camel' })
  assert((lg2.entries || []).some((e) => e.route === 'auto-camel'), 're-applied fiber re-hydrates request-log tail')
}

// --- ui prefs: badge toggle persists under llm-pi-ai[uiPrefs] and merges ---
r = await P('get-ui-prefs')
assert(r.ok && r.prefs && r.prefs.showRouteBadge === true, 'ui prefs default to showRouteBadge=true: ' + JSON.stringify(r))
r = await P('set-ui-prefs', { prefs: { showRouteBadge: false } })
assert(r.ok && r.prefs.showRouteBadge === false, 'set-ui-prefs flips the badge off')
r = await P('get-ui-prefs')
assert(r.prefs.showRouteBadge === false, 'get-ui-prefs reflects the saved value')
assert(log.section().uiPrefs && typeof log.section().uiPrefs === 'object', 'uiPrefs persisted as a section foreign key: ' + JSON.stringify(Object.keys(log.section())))
r = await P('list-routes')
assert(r.ok && r.routes && Object.keys(r.routes).length >= 1, 'uiPrefs write preserved sibling keys (routes intact)')
r = await P('set-ui-prefs', { prefs: { showRouteBadge: true } })
assert(r.ok && r.prefs.showRouteBadge === true, 'set-ui-prefs restores the default')

// --- retry budget: the policy DSH freezes at adapter registration ------------
// A routed failure used to normalize to code UNKNOWN, which no retry policy
// lists as retryable, so DSH never retried a route no matter how it was
// configured. The adapter now reports a budget and throws a dedicated code.
r = await P('get-retry-prefs')
assert(r.ok && r.prefs && r.prefs.maxRetries === 0, 'retry budget defaults to 0 (historical behaviour): ' + JSON.stringify(r))
assert(typeof r.max === 'number' && r.max > 0, 'get-retry-prefs advertises the UI ceiling')

// 0 must resolve to `undefined` so DSH keeps its own defaults rather than a
// policy that claims zero retries.
assert(rreg.adapter.providerRetryPolicy('router') === undefined, 'a zero budget reports no policy (DSH defaults apply)')

r = await P('set-retry-prefs', { prefs: { maxRetries: 3 } })
assert(r.ok && r.prefs.maxRetries === 3, 'set-retry-prefs stores the budget: ' + JSON.stringify(r))
assert(log.section().routerRetry && log.section().routerRetry.maxRetries === 3, 'budget persisted as a section foreign key: ' + JSON.stringify(Object.keys(log.section())))
r = await P('list-routes')
assert(r.ok && r.routes && Object.keys(r.routes).length >= 1, 'retry write preserved sibling keys (routes intact)')

const pol = rreg.adapter.providerRetryPolicy('router')
assert(pol && pol.mode === 'normal' && pol.maxRetries === 3, 'adapter reports the configured budget: ' + JSON.stringify(pol))
assert(Array.isArray(pol.retryableCodes) && pol.retryableCodes.includes('ROUTE_EXHAUSTED'), 'route exhaustion is the retryable code')
assert(!pol.retryableCodes.includes('UNKNOWN'), 'UNKNOWN stays unretryable — only route exhaustion opts in')
assert(pol.initialDelayMs > 0 && pol.maxDelayMs >= pol.initialDelayMs, 'backoff bounds are coherent: ' + JSON.stringify(pol))

// Out-of-range input is clamped, never rejected: a bad value must not leave the
// provider unregisterable.
r = await P('set-retry-prefs', { prefs: { maxRetries: 9999 } })
assert(r.ok && r.prefs.maxRetries <= 20, 'an oversized budget is clamped to the ceiling: ' + JSON.stringify(r))
r = await P('set-retry-prefs', { prefs: { maxRetries: -5 } })
assert(r.ok && r.prefs.maxRetries === 20, 'a negative budget is ignored, keeping the last good value: ' + JSON.stringify(r))

// The thrown route-exhaustion error must carry the code in the exact shape
// dsh-llm's normalizeLlmFailure trusts: own `code` === own `failure.code`.
{
  llm.failProviders.add('deadgw')
  await P('set-route', { alias: 'all-dead', strategy: 'priority', targets: [{ provider: 'deadgw', model: 'nope' }] })
  let thrown
  try {
    const it = rreg.adapter.stream({ provider: 'router', model: 'all-dead', messages: [] })[Symbol.asyncIterator]()
    for (let n = await it.next(); !n.done; n = await it.next()) { /* drain */ }
  } catch (e) {
    thrown = e
  }
  assert(thrown, 'a route with no reachable target throws')
  assert(thrown.code === 'ROUTE_EXHAUSTED', 'exhaustion carries a retryable code: ' + String(thrown && thrown.code))
  assert(thrown.failure && thrown.failure.code === thrown.code, 'own failure.code agrees with own code (else dsh-llm discards it)')
  assert(typeof thrown.failure.message === 'string' && thrown.failure.message.length > 0, 'carried failure has a non-empty message')
  llm.failProviders.delete('deadgw')
  await P('delete-route', { alias: 'all-dead' })
}
r = await P('set-retry-prefs', { prefs: { maxRetries: 0 } })
assert(r.ok && r.prefs.maxRetries === 0, 'budget restored to the default')

// --- route capability aggregation + per-target effort clamp ------------------
// A route is not a model: whichever target serves the call decides what the call
// can do. Advertising one target's capability for all of them is what makes a
// routed request fail at forward time on a different target.
//
// Each scenario below uses FRESH model ids. Target metadata is memoized for 30s
// keyed by the real provider/model pair (one selector render fans out across
// every target of every route), so reusing an id would assert against the
// previous scenario's cached answer.
{
  const rgw = llm.registrations.find((x) => x.providers.includes('router'))
  const KEY = (p, m) => `${p}\u0000${m}`
  const eff = (...ids) => ({ efforts: ids.map((id) => ({ id, name: id })) })
  await P('create-provider', { route: 'cap-a', baseURL: 'https://a/v1' })
  await P('create-provider', { route: 'cap-b', baseURL: 'https://b/v1' })

  /** Declare one model on both providers, wire a route over them, resolve it. */
  const resolveOver = async (id, aInfo, bInfo, targetOpts = {}) => {
    await P('apply-models', { route: 'cap-a', models: [{ id }], mode: 'merge' })
    await P('apply-models', { route: 'cap-b', models: [{ id }], mode: 'merge' })
    if (aInfo !== undefined) llm.modelInfo.set(KEY('cap-a', id), aInfo)
    if (bInfo !== undefined) llm.modelInfo.set(KEY('cap-b', id), bInfo)
    await P('set-route', {
      alias: 'cap',
      strategy: 'priority',
      targets: [{ provider: 'cap-a', model: id }, { provider: 'cap-b', model: id, ...targetOpts }],
    })
    return rgw.adapter.resolveModel('router', 'cap')
  }

  // Two targets, deliberately unequal on every aggregated field.
  let info = await resolveOver('agg1',
    { context: { contextWindow: 128000 }, defaultMaxTokens: 8192, reasoning: eff('low', 'high') },
    { context: { contextWindow: 32000 }, defaultMaxTokens: 4096, reasoning: eff('medium', 'max') })
  const ids = (info.reasoning?.efforts || []).map((e) => e.id)
  // UNION, because the clamp maps any advertised effort onto whatever the chosen
  // target accepts. Intersecting would hide levels the route can serve — here it
  // would hide all four, since the two targets share none.
  assert(JSON.stringify(ids) === JSON.stringify(['low', 'medium', 'high', 'max']), 'efforts are the UNION of targets, ordered low→high: ' + JSON.stringify(ids))
  // MINIMUM, because these drive upstream overflow checks: advertising 128000
  // would let a request pass validation and then fail on the 32000 target.
  assert(info.context.contextWindow === 32000, 'contextWindow is the MINIMUM across targets: ' + info.context.contextWindow)
  assert(info.defaultMaxTokens === 4096, 'defaultMaxTokens is the MINIMUM across targets: ' + info.defaultMaxTokens)
  assert(info.provider === 'router' && info.id === 'cap' && info.name === 'cap', 'aggregate keeps the VIRTUAL identity (else INVALID_MODEL_INFO drops the route)')

  // A disabled target can never serve a call, so its capability must not be
  // advertised.
  info = await resolveOver('agg2',
    { context: { contextWindow: 128000 }, reasoning: eff('low', 'high') },
    { context: { contextWindow: 32000 }, reasoning: eff('medium', 'max') },
    { enabled: false })
  assert(JSON.stringify((info.reasoning?.efforts || []).map((e) => e.id)) === JSON.stringify(['low', 'high']), 'a disabled target contributes nothing: ' + JSON.stringify(info.reasoning?.efforts))
  assert(info.context.contextWindow === 128000, 'minimum ignores disabled targets: ' + info.context.contextWindow)

  // One unreadable target must degrade the aggregate, not erase it — the
  // pre-aggregation rule discarded ALL metadata on any lookup failure.
  info = await resolveOver('agg3', { context: { contextWindow: 128000 }, reasoning: eff('low', 'high') }, 'throw')
  assert(info.context && info.context.contextWindow === 128000, 'a failed lookup leaves the healthy target\'s metadata intact: ' + JSON.stringify(info.context))
  assert(JSON.stringify((info.reasoning?.efforts || []).map((e) => e.id)) === JSON.stringify(['low', 'high']), 'a failed lookup does not erase reasoning: ' + JSON.stringify(info.reasoning))

  // A route whose every target declares no reasoning must still ADVERTISE the
  // levels — inertly. This is the live bug `router/free` hit: DSH validates the
  // requested effort against the VIRTUAL model inside `llm.prepareCall`
  // (`resolveCallWithInfo`, the `reasoning === undefined` branch) BEFORE the
  // router is dispatched, so an omitted block makes any requested effort a hard
  // UNSUPPORTED_REASONING_EFFORT that the per-target clamp below never gets to
  // prevent. Advertising more than a target serves is recoverable (the clamp
  // drops it at forward time); advertising nothing is not.
  info = await resolveOver('agg4', { context: { contextWindow: 1000 } }, { context: { contextWindow: 2000 } })
  assert(info.reasoning && Array.isArray(info.reasoning.efforts), 'no reasoning-capable target => the field is still PRESENT (an omitted block fails the request upstream): ' + JSON.stringify(info.reasoning))
  assert(JSON.stringify(info.reasoning.efforts.map((e) => e.id)) === JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), 'the inert block offers every known level: ' + JSON.stringify(info.reasoning.efforts.map((e) => e.id)))
  assert(info.reasoning.efforts.every((e) => typeof e.description === 'string' && e.description.length > 0), 'each inert level explains that nothing will be sent, so the menu is not silently useless')
  // No defaultEffort: a default would become the RESOLVED config of requests
  // that asked for nothing, and mobile clients auto-send a defaultEffort on
  // selection — spreading a placeholder into persisted state.
  assert(info.reasoning.defaultEffort === undefined, 'the inert block declares NO defaultEffort: ' + info.reasoning.defaultEffort)

  // The upstream gate, reproduced exactly. This is what actually failed live, so
  // assert against the real rule rather than the shape that feeds it.
  const upstreamRejects = (modelInfo, requested) => {
    const reasoning = modelInfo.reasoning
    if (reasoning === undefined) return requested !== undefined
    const effective = requested ?? reasoning.defaultEffort
    if (effective === undefined) return false
    return !reasoning.efforts.some((e) => e.id === effective)
  }
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert(!upstreamRejects(info, level), `a route with no reasoning-capable target still ACCEPTS "${level}" (this is the live router/free + max failure)`)
  }
  // Same guarantee for the aggregate that DOES have efforts, and the honest
  // rejection for a level nothing offers.
  const agg1Info = await resolveOver('agg4b', { reasoning: eff('low', 'high') }, { reasoning: eff('medium', 'max') })
  assert(!upstreamRejects(agg1Info, 'medium'), 'a real union accepts a level only one target offers')
  assert(upstreamRejects(agg1Info, 'xhigh'), 'a real union still rejects a level NO target offers (the union is not widened silently)')

  // A route that does not exist, and one whose every target is disabled, are
  // real problems with their own diagnostics — but they must fail on THAT, not
  // on the effort, or the message blames a modifier instead of the route.
  const missing = await rgw.adapter.resolveModel('router', 'no-such-route')
  assert(!upstreamRejects(missing, 'max'), 'an unknown route still accepts an effort, so its own error is what surfaces: ' + JSON.stringify(missing.reasoning))

  // defaultEffort is only carried when every reasoning-capable target agrees;
  // otherwise a request that asked for nothing would silently get one target's
  // preference.
  info = await resolveOver('agg5',
    { reasoning: { ...eff('low', 'high'), defaultEffort: 'high' } },
    { reasoning: { ...eff('low', 'high'), defaultEffort: 'low' } })
  assert(info.reasoning.defaultEffort === undefined, 'conflicting target defaults yield NO route default: ' + info.reasoning.defaultEffort)
  info = await resolveOver('agg6',
    { reasoning: { ...eff('low', 'high'), defaultEffort: 'high' } },
    { reasoning: { ...eff('low', 'high'), defaultEffort: 'high' } })
  assert(info.reasoning.defaultEffort === 'high', 'unanimous target defaults become the route default: ' + info.reasoning.defaultEffort)

  // --- the clamp, exercised through REAL dispatch ---------------------------
  // This is the load-bearing half of the union: DSH validates the request
  // against the route (the union), then the router forwards to one target whose
  // own prepareCall validates against ITS list. The mock throws
  // UNSUPPORTED_REASONING_EFFORT exactly as the real runtime does, so an
  // unclamped forward would surface as a target failure here.
  const drain = async (opts) => {
    let guard = 0
    for await (const _ of rgw.adapter.stream(opts)) { if (++guard > 40) break }
  }
  const baseCall = (model, effort) => ({
    provider: 'router', model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  })

  // `medium` is advertised by the route (cap-b offers it) but cap-a, the first
  // priority target, does not. It must be clamped, not forwarded verbatim.
  await resolveOver('clamp1', { reasoning: eff('low', 'high') }, { reasoning: eff('medium', 'max') })
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', 'medium'))
  let seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen.length === 1, 'the first target was tried exactly once (no fallback burned): ' + JSON.stringify(llm.effortsSeen))
  // UP first, mirroring pi-ai's own clampThinkingLevel, so a routed call lands
  // where a direct call to that provider would. Up is also the forgiving
  // direction: over-delivering costs tokens, under-delivering silently returns a
  // weaker answer than was asked for.
  assert(seen[0].effort === 'high', 'an unoffered effort clamps UP to the next level the target offers: ' + seen[0].effort)

  // With nothing above the request, clamp down to the highest offered.
  await resolveOver('clamp2', { reasoning: eff('low', 'medium') }, { reasoning: eff('max') })
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', 'max'))
  seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen[0].effort === 'medium', 'with nothing above, the effort clamps DOWN to the highest offered: ' + seen[0].effort)

  // A target declaring no reasoning rejects ANY effort, so the only way to use
  // it is to send none.
  await resolveOver('clamp3', {}, { reasoning: eff('high') })
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', 'high'))
  seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen[0].effort === undefined, 'a non-reasoning target receives NO effort rather than a rejected one: ' + seen[0].effort)

  // An effort the target does offer must pass through untouched.
  await resolveOver('clamp4', { reasoning: eff('low', 'high') }, { reasoning: eff('low', 'high') })
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', 'high'))
  seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen[0].effort === 'high', 'an offered effort passes through unchanged: ' + seen[0].effort)

  // A caller asking for nothing must stay asking for nothing: inventing an
  // effort here would change the request the user made.
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', undefined))
  seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen[0].effort === undefined, 'no requested effort forwards no effort: ' + seen[0].effort)

  // An adapter may use its own vocabulary; those ids cannot be ordered against
  // the known levels, so guessing a neighbour would be inventing a level.
  await resolveOver('clamp5', { reasoning: eff('turbo', 'ultra') }, { reasoning: eff('high') })
  llm.effortsSeen.length = 0
  await drain(baseCall('cap', 'high'))
  seen = llm.effortsSeen.filter((e) => e.provider === 'cap-a')
  assert(seen[0].effort === undefined, 'an incomparable vocabulary yields no effort rather than a guess: ' + seen[0].effort)

  await P('delete-route', { alias: 'cap' })
  await P('delete-provider', { route: 'cap-a' })
  await P('delete-provider', { route: 'cap-b' })
}

// --- local pi-ai catalog suggestion: must DEGRADE, never throw ---------------
// The suggestion reads files, and a Host half is not guaranteed to be allowed
// to: this very sandbox evaluates the bundle as a classic script with no
// dynamic-import loader, so `await import('node:fs')` fails outright. That is
// the realistic worst case, and the contract is that it turns into a reported
// reason rather than an exception — a thrown RPC would surface in the panel as a
// generic failure and make the models tab look broken.
{
  await P('create-provider', { route: 'pic-gw', baseURL: 'https://pic/v1', api: 'openai-completions' })
  await P('apply-models', { route: 'pic-gw', models: [{ id: 'claude-opus-5' }], mode: 'merge' })
  let res = await P('suggest-reasoning', { route: 'pic-gw' })
  assert(typeof res.ok === 'boolean', 'suggest-reasoning always answers with an envelope, never throws: ' + JSON.stringify(res))
  const available = res.ok
  if (!available) {
    assert(typeof res.error === 'string' && res.error.length > 0, 'an unavailable catalog reports WHY: ' + JSON.stringify(res))
  } else {
    assert(Array.isArray(res.rows) && res.rows.length === 1, 'one row per requested model: ' + JSON.stringify(res.rows))
    assert(res.rows[0].provider === 'pic-gw' && res.rows[0].api === 'openai-completions', 'a row names its provider and the protocol that shaped it: ' + JSON.stringify(res.rows[0]))
    assert(res.rows[0].current === null, 'an undeclared model reports current=null (inherit): ' + JSON.stringify(res.rows[0].current))
  }

  // Route scope: an explicit target list, spanning providers, deduplicated.
  await P('create-provider', { route: 'pic-gw2', baseURL: 'https://pic2/v1', api: 'openai-responses' })
  await P('apply-models', { route: 'pic-gw2', models: [{ id: 'claude-opus-5' }], mode: 'merge' })
  res = await P('suggest-reasoning', {
    targets: [
      { provider: 'pic-gw', model: 'claude-opus-5' },
      { provider: 'pic-gw', model: 'claude-opus-5' },
      { provider: 'pic-gw2', model: 'claude-opus-5' },
    ],
  })
  if (available) {
    assert(res.ok && res.rows.length === 2, 'a repeated target yields ONE row per provider/model pair: ' + JSON.stringify(res.rows?.map((x) => x.provider + '/' + x.id)))
    assert(res.rows[0].api === 'openai-completions' && res.rows[1].api === 'openai-responses', 'each row carries ITS OWN provider protocol: ' + JSON.stringify(res.rows.map((x) => x.api)))
  }
  // An unknown provider inside a target list is reported, not fatal, as long as
  // something else resolved — a route may reference a provider since deleted.
  res = await P('suggest-reasoning', {
    targets: [{ provider: 'pic-gw', model: 'claude-opus-5' }, { provider: 'ghost-gw', model: 'x' }],
  })
  if (available) {
    assert(res.ok && res.rows.length === 1, 'a partially valid target list still answers: ' + JSON.stringify(res))
    assert(Array.isArray(res.unknown) && res.unknown.includes('ghost-gw'), 'the unresolvable provider is named: ' + JSON.stringify(res.unknown))
  }

  // Bad input is rejected on its own terms, whether or not the catalog loaded.
  res = await P('suggest-reasoning', {})
  assert(!res.ok && /route|targets/.test(res.error), 'neither route nor targets is its own error: ' + JSON.stringify(res))
  res = await P('suggest-reasoning', { route: 'no-such-provider' })
  assert(!res.ok, 'an unknown provider is rejected: ' + JSON.stringify(res))
  res = await P('suggest-reasoning', { targets: [{ provider: '', model: '' }] })
  assert(!res.ok, 'an empty target list is rejected: ' + JSON.stringify(res))
  await P('delete-provider', { route: 'pic-gw' })
  await P('delete-provider', { route: 'pic-gw2' })
}

// --- external model catalog prefs -------------------------------------------
// The lookup is the plugin's only third-party request, so the default must be
// off and the stored URL must be something the client can safely hand to fetch.
r = await P('get-catalog-prefs')
assert(r.ok && r.prefs.enabled === false, 'catalog lookup is disabled by default: ' + JSON.stringify(r.prefs))
assert(r.prefs.url === '' && /^https:\/\//.test(r.effectiveUrl), 'an unset URL resolves to the https default: ' + r.effectiveUrl)
assert(r.effectiveUrl === r.defaultUrl, 'effectiveUrl equals the default when nothing is stored')

r = await P('set-catalog-prefs', { prefs: { enabled: true } })
assert(r.ok && r.prefs.enabled === true && r.prefs.url === '', 'enabling alone does not disturb the URL')
r = await P('set-catalog-prefs', { prefs: { url: 'https://mirror.example/api.json' } })
assert(r.ok && r.prefs.url === 'https://mirror.example/api.json', 'a custom mirror URL is stored')
assert(r.prefs.enabled === true, 'a URL-only patch keeps the toggle (patch merges over the saved value)')
assert(r.effectiveUrl === 'https://mirror.example/api.json', 'effectiveUrl follows the override')

// Non-http schemes are refused: the value is handed to the client's fetch, so
// the place that persists it is the place that decides what is fetchable.
for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:application/json,{}', 'not a url']) {
  const res = await P('set-catalog-prefs', { prefs: { url: bad } })
  assert(res.ok === true, 'a bad URL does not fail the write: ' + bad)
  assert(res.prefs.url === 'https://mirror.example/api.json', 'a bad URL leaves the last good value intact: ' + bad + ' -> ' + res.prefs.url)
}
r = await P('set-catalog-prefs', { prefs: { url: '' } })
assert(r.ok && r.prefs.url === '' && r.effectiveUrl === r.defaultUrl, 'clearing the URL falls back to the default')
r = await P('set-catalog-prefs', { prefs: { enabled: false } })
assert(r.ok && r.prefs.enabled === false, 'catalog lookup restored to disabled')

// probe-target marks up a healthy target
r = await P('probe-target', { provider: 'comp-a', model: 'gpt-4o' })
assert(r.ok && r.latencyMs >= 0, 'probe-target ok: ' + JSON.stringify(r))
r = await P('probe-target', { provider: 'ghost', model: 'x' })
assert(!r.ok, 'probe unknown provider rejected')
r = await P('get-route-stats')
assert(r.ok && r.health && Object.keys(r.health).length >= 1, 'probe health recorded')

// disabled member is excluded from composite resolution (intersection over the
// remaining ENABLED members = comp-a's own models here)
await P('toggle-provider', { route: 'comp-b', enabled: false })
r = await P('preview-composite', { name: 'common' })
assert(r.ok && r.ids.length === 2 && r.ids.includes('gpt-4o') && r.ids.includes('gpt-4o-mini'), 'disabled member excluded from intersection: ' + JSON.stringify(r.ids))
await P('toggle-provider', { route: 'comp-b', enabled: true })

// cleanup composites + providers
await P('delete-composite', { name: 'mixture' })
await P('delete-composite', { name: 'common' })
await P('delete-provider', { route: 'comp-a' })
await P('delete-provider', { route: 'comp-b' })

// --- FINAL: uninstall while the settings/updated re-park listener is live ---
// Restore moves parked providers BACK into providers and its write emits
// settings/updated — the unloading flag must keep the listener from
// immediately re-parking them (which would silently break the uninstall
// "no data lost" guarantee). Runs last because it tears down every effect,
// exactly like a real cordis fiber unload.
{
  // Park one provider so restore has real data to move back.
  await P('create-provider', { route: 'unl-gw', baseURL: 'https://unl/v1' })
  r = await P('toggle-provider', { route: 'unl-gw', enabled: false })
  assert(r.ok && Object.hasOwn(dis(), 'unl-gw'), 'pre-condition: unl-gw parked')
  // Simulate the real unload: run every cleanup in LIFO order like cordis.
  const lifo = cleanups.splice(0, cleanups.length)
  for (let i = lifo.length - 1; i >= 0; i--) await Promise.resolve(lifo[i]())
  assert(provs()['unl-gw'] && provs()['unl-gw'].disabled === true, 'unload restored unl-gw to providers (marker intact)')
  // Fire the event after the disposers ran — the way dsh-settings' queued
  // write would commit. The listener is disposed AND the unloading flag set,
  // so nothing may re-park behind the safety net's back.
  for (const fn of listeners['settings/updated'] || []) try { fn('llm-pi-ai', 9) } catch { /* ignore */ }
  await new Promise((res) => setTimeout(res, 5))
  assert(provs()['unl-gw'] && !Object.hasOwn(dis(), 'unl-gw'), 'uninstall-restore is NOT undone by a late settings/updated re-park')
}

console.log('PASS: host end-to-end smoke — all assertions green')
