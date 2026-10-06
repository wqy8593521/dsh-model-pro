/**
 * tests/host.matrix.mjs — compatibility matrix: PLUGIN VERSION × DSH RUNTIME.
 *
 * Boots a real host bundle (old = released `HEAD`, new = current build) through
 * its own exported `apply()` against a faithful mock of each shipped `settings`
 * service, then reports which core operations work.
 *
 * The two runtimes differ in exactly one way that matters here:
 *
 *   0.1.x `SettingsProvider`  — `get(ns)` returns the raw resolved section and
 *                               `replace()` accepts any key.
 *   0.2.x `SettingsForms`     — NO `get(ns)`; `describe()` projects a section to
 *                               its schema-declared fields; every write is
 *                               rejected when the result carries a key that is
 *                               not below a `volatile()` node:
 *
 *                                   Config field "X" is not volatile
 *
 * Usage:
 *   node scripts/run-node-test.mjs tests/host.matrix.mjs
 *   OLD_BUNDLE=/tmp/dsh-model-pro-old/dist/host.js node scripts/run-node-test.mjs tests/host.matrix.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import zReal from '@deepseek-ai/schemastery'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NEW_BUNDLE = path.join(__dirname, '..', 'dist', 'host.js')
const OLD_BUNDLE = process.env.OLD_BUNDLE ?? '/tmp/dsh-model-pro-old/dist/host.js'
const OWN_NS = 'dsh-model-pro'

// ---------------------------------------------------------------------------
// schemastery shim handed to the sandbox: every builder returns a REAL schema
// ---------------------------------------------------------------------------
const volatile = (s) => s.extra('volatile', true)
const anySchema = zReal.any().default({})
const dictSchema = zReal.dict(zReal.any()).default({})
const ownedKeys = [
  'disabledProviders', 'modelCapabilities', 'routes', 'composites', 'routeStats',
  'uiPrefs', 'routerRetry', 'modelCatalog', 'localGateway', 'writeProbe',
]
const configSchema = zReal.object(Object.fromEntries(ownedKeys.map((k) => [k, volatile(zReal.any().default({}))])))

/** llm-pi-ai's real 0.2 schema: `providers` is the only declared volatile key. */
const profileSchema = zReal.object({ baseURL: zReal.string(), api: zReal.string(), models: zReal.any(), disabled: zReal.boolean() })
const llmPiAiRaw = zReal.object({ providers: volatile(zReal.dict(profileSchema).default({})) })

const zShim = Object.assign(() => anySchema, {
  object: () => configSchema,
  dict: () => dictSchema,
  any: () => anySchema,
  boolean: () => zReal.boolean(),
})

// ---------------------------------------------------------------------------
// 0.2 SettingsForms mock — mirrors the real guard, projection and defaults
// ---------------------------------------------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const resolve1 = (root, node) => {
  if (typeof node === 'number') return root.refs[node]
  if (node !== null && typeof node === 'object' && node.refs !== undefined && node.uid !== undefined) return node.refs[node.uid]
  return node
}
const isVolatilePath = (root, schema, p) => {
  const node = resolve1(root, schema)
  if (node?.meta?.volatile) return true
  const [key, ...rest] = p
  const child = key === undefined ? undefined : node?.dict?.[key]
  return child !== undefined && isVolatilePath(root, child, rest)
}
const projectForm = (root, schema, value) => {
  const node = resolve1(root, schema)
  if (node?.type === 'object' && isPlainObject(value)) {
    const out = {}
    for (const [k, c] of Object.entries(node.dict ?? {})) if (Object.hasOwn(value, k)) out[k] = projectForm(root, c, value[k])
    return out
  }
  return value
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

class Settings02 {
  constructor(entries) {
    this.entries = entries
    this.writable = true
  }
  #form(ns) { return this.entries[ns]?.schema }
  #resolved(ns) {
    const e = this.entries[ns]
    if (e === undefined) return undefined
    return clone(Object.keys(e.section ?? {}).length === 0 && e.raw ? e.raw({}) : e.section)
  }
  describe() {
    return Object.entries(this.entries).map(([ns, e]) => {
      const form = this.#form(ns)
      return {
        ns, schema: form, revision: e.revision ?? 0,
        value: projectForm(form, form, this.#resolved(ns)),
        user: projectForm(form, form, e.section ?? {}),
      }
    })
  }
  async replace(ns, section) {
    const form = this.#form(ns)
    if (form === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    const next = clone(section)
    const validate = (value, n, p = []) => {
      for (const [key, child] of Object.entries(value)) {
        const target = [...p, key]
        if (isVolatilePath(form, form, target)) continue
        const fields = resolve1(form, n)?.dict
        const field = fields && Object.hasOwn(fields, key) ? fields[key] : undefined
        if (isPlainObject(child) && field !== undefined) validate(child, field, target)
        else throw new Error(`Config field "${target.join('.')}" is not volatile`)
      }
    }
    validate(next, form)
    const e = this.entries[ns]
    // `mergeLayers(strip(raw), next)`: declared fields are dropped from the raw
    // section and restated from the write; UNDECLARED keys survive untouched.
    const declared = Object.keys(resolve1(form, form)?.dict ?? {})
    const base = {}
    for (const [k, v] of Object.entries(e.section ?? {})) if (!declared.includes(k)) base[k] = clone(v)
    e.section = { ...base, ...next }
    e.revision = (e.revision ?? 0) + 1
  }
  async update(ns, patch) { return this.replace(ns, { ...(this.entries[ns]?.section ?? {}), ...patch }) }
}

/** 0.1 SettingsProvider mock — raw get(), permissive replace(). */
class Settings01 {
  constructor(entries) {
    this.entries = entries
    this.writable = true
  }
  get(ns) { return clone(this.entries[ns]?.section) }
  async replace(ns, section) {
    if (this.entries[ns] === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    // Wholesale: the older code rebuilt the section key by key precisely because
    // a namespace write does not merge.
    this.entries[ns].section = clone(section)
  }
}

// ---------------------------------------------------------------------------
// load + drive a bundle
// ---------------------------------------------------------------------------
async function loadBundle(file) {
  let code = readFileSync(file, 'utf8')
  code = code.replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']@deepseek-ai\/dsh-typert-protocol["'];?/m, '')
  code = code.replace(/^\s*import\s+z\s+from\s+["']@deepseek-ai\/schemastery["'];?/m, '')
  code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')
  const captured = []
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Promise, AbortController, TextEncoder, TextDecoder,
    z: zShim,
    TypertRemoteService: class { constructor(ctx) { this.ctx = ctx; captured.push(this) } },
  }
  sandbox.globalThis = sandbox
  const r = await vm.runInContext(
    // `Config` is absent from the old bundle, so read it off the global safely.
    `(async () => { ${code}\n; return { apply, name, inject, Config: typeof Config === 'undefined' ? undefined : Config }; })()`,
    vm.createContext(sandbox),
    { filename: path.basename(file) },
  )
  return { ...r, captured }
}

const entries = (schema, section) => ({ schema, section })
const baseEntries = () => ({
  'llm-pi-ai': entries(llmPiAiRaw.toJSON(), { providers: { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] } } }),
  [OWN_NS]: entries(configSchema.toJSON(), {}),
})

async function runCell({ bundle, label, runtime }) {
  const loaded = await loadBundle(bundle)
  const ents = baseEntries()
  const st = runtime === '0.2' ? new Settings02(ents) : new Settings01(ents)
  const ctx = {
    get: (n) => (n === 'settings' ? st : n === 'llm' ? { listConfigurableProviders: () => [], discoverModels: async () => [] } : undefined),
    typert: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn() },
  }
  const warnings = []
  ctx.get = ((orig) => (n) => (n === 'logger' ? { warn: (m) => warnings.push(String(m)) } : orig(n)))(ctx.get)
  const out = { label, hasConfig: loaded.Config !== undefined, applyError: null, toggle: null, readsProviders: null, warnings }
  try {
    await loaded.apply(ctx)
  } catch (error) {
    out.applyError = error.message
    return out
  }
  // Does it still see the provider that lives in llm-pi-ai?
  const providers = st.get ? st.get('llm-pi-ai')?.providers ?? {} : (st.describe().find((r) => r.ns === 'llm-pi-ai')?.value?.providers ?? {})
  out.readsProviders = Object.keys(providers)
  // Core operation: disable a provider (the feature this whole exercise is about).
  const rt = loaded.captured[loaded.captured.length - 1] ?? loaded.captured[0]
  if (rt?.toggleProvider) {
    try {
      out.toggle = await rt.toggleProvider({ route: 'alpha', enabled: false })
    } catch (error) {
      out.toggle = { threw: error.message }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
const cells = [
  ...(HAVE_OLD ? [
    { label: 'OLD plugin × 0.1 runtime', bundle: OLD_BUNDLE, runtime: '0.1' },
    { label: 'OLD plugin × 0.2 runtime', bundle: OLD_BUNDLE, runtime: '0.2' },
  ] : []),
  { label: 'NEW plugin × 0.1 runtime', bundle: NEW_BUNDLE, runtime: '0.1' },
  { label: 'NEW plugin × 0.2 runtime', bundle: NEW_BUNDLE, runtime: '0.2' },
]

// ---------------------------------------------------------------------------
// Scenario: LEGACY DATA on a 0.2 runtime driven by the NEW plugin.
//
// A 0.1 install leaves `disabledProviders` sitting in `llm-pi-ai`. On 0.2 that
// key is projected away and refused. The new plugin's `readDisabledDict` unions
// the legacy location, so this exercises the real upgrade path: does the parked
// provider survive, and does the first write clean the foreign key out without
// tripping the guard?
// ---------------------------------------------------------------------------
const LEGACY_PARKED = { baseURL: 'https://parked.example/v1', models: [{ id: 'm9' }] }

function legacyEntries() {
  const e = baseEntries()
  e['llm-pi-ai'].section = {
    providers: { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] } },
    disabledProviders: { parked: LEGACY_PARKED },
    // an operator's own key, which must survive untouched
    noteK: 1,
  }
  return e
}

async function runLegacyUpgradeCell({ bundle, label }) {
  const loaded = await loadBundle(bundle)
  const ents = legacyEntries()
  const st = new Settings02(ents)
  const llm = { listConfigurableProviders: () => [], discoverModels: async () => [] }
  const listeners = {}
  const ctx = {
    get: (n) => (n === 'settings' ? st : n === 'llm' ? llm : undefined),
    typert: { register: () => () => {} },
    on: (name, fn) => { (listeners[name] = listeners[name] ?? []).push(fn); return () => {} },
    effect: (fn) => { fn() },
  }
  const out = { label, applyError: null, llmKeys: null, parkedSurfaced: null, toggle: null }
  try {
    await loaded.apply(ctx)
    // The reinstall re-park fires on the llm-pi-ai settings/updated event.
    await new Promise((r) => setTimeout(r, 5))
    for (const fn of listeners['settings/updated'] ?? []) fn('llm-pi-ai', 1)
    await new Promise((r) => setTimeout(r, 5))
  } catch (error) {
    out.applyError = error.message
    return out
  }
  out.llmKeys = Object.keys(ents['llm-pi-ai'].section ?? {}).sort()
  out.parkedSurfaced = Object.keys(st.describe().find((r) => r.ns === OWN_NS)?.value?.disabledProviders ?? {})
  return out
}

// The OLD-plugin cells need a build of the previously released version. It is
// not committed (dist/ is gitignored), so build it on demand:
//
//   git worktree add --detach /tmp/dsh-model-pro-old HEAD
//   ln -s "$PWD/node_modules" /tmp/dsh-model-pro-old/node_modules
//   (cd /tmp/dsh-model-pro-old && npm run build)
//
// Without it those two cells are skipped rather than failed: the NEW-plugin
// cells — the ones that decide whether this change is shippable — always run.
const HAVE_OLD = existsSync(OLD_BUNDLE)
if (!HAVE_OLD) {
  console.log(`note: OLD_BUNDLE not found (${OLD_BUNDLE}) — skipping the OLD-plugin cells`)
  console.log('      see the header of tests/host.matrix.mjs for how to build it\n')
}

console.log('cell                        | Config | apply | sees provider | disable provider | legacy notice')
console.log('----------------------------|--------|-------|---------------|------------------|--------------')
const results = []
for (const cell of cells) {
  const r = await runCell(cell)
  results.push(r)
  const apply = r.applyError ? `THREW` : 'ok'
  const sees = r.readsProviders === null ? '-' : JSON.stringify(r.readsProviders)
  const dis = r.toggle === null ? '-' : r.toggle.ok === true ? 'ok' : `FAIL: ${r.toggle.error ?? r.toggle.threw}`
  const notice = r.warnings.some((w) => /legacy DSH 0\.1/.test(w)) ? 'yes' : 'no'
  console.log(`${r.label.padEnd(27)} | ${(r.hasConfig ? 'yes' : 'no').padEnd(6)} | ${apply.padEnd(5)} | ${sees.padEnd(13)} | ${dis.padEnd(16)} | ${notice}`)
}

console.log('\n--- legacy-data upgrade on 0.2 (NEW plugin) ---')
const upgrade = await runLegacyUpgradeCell({ bundle: NEW_BUNDLE, label: 'legacy data × NEW plugin × 0.2' })
console.log(`apply: ${upgrade.applyError ?? 'ok'} | llm-pi-ai keys: ${JSON.stringify(upgrade.llmKeys)} | parked surfaced: ${JSON.stringify(upgrade.parkedSurfaced)}`)

// --- unknown settings shape: must be DIAGNOSED, not silently degraded --------
let unknownCell
{
  const loaded = await loadBundle(NEW_BUNDLE)
  const warnings = []
  const bogus = { writable: true, replace: async () => {} }
  const ctx = {
    get: (n) => (n === 'settings' ? bogus : n === 'logger' ? { warn: (m) => warnings.push(String(m)) } : undefined),
    typert: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn() },
  }
  let threw = null
  try { await loaded.apply(ctx) } catch (error) { threw = error.message }
  console.log(`unknown settings shape      | apply: ${threw ?? 'ok'} | diagnostics: ${warnings.length}`)
  unknownCell = { threw, warnings }
}

console.log('\n--- expectations ---')
const byLabel = Object.fromEntries(results.map((r) => [r.label, r]))
let failed = 0
const expect = (label, fn) => {
  try {
    fn(byLabel[label])
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

if (HAVE_OLD) expect('OLD plugin × 0.1 runtime', (r) => {
  assert.equal(r.applyError, null, `apply threw: ${r.applyError}`)
  assert.equal(r.hasConfig, false, 'old bundle should not declare a Config schema')
  assert.deepEqual(r.readsProviders, ['alpha'], 'old plugin must read providers from llm-pi-ai')
  assert.equal(r.toggle?.ok, true, `disable should work on 0.1, got ${JSON.stringify(r.toggle)}`)
})

if (HAVE_OLD) expect('OLD plugin × 0.2 runtime', (r) => {
  // The shipped bug. Depending on the exact service surface the old code fails
  // at one of two points, and BOTH are failures of the disable feature:
  //   • it read providers through `st.get(ns)`, which 0.2 does not expose, so it
  //     cannot even find the route ("提供商不存在"); or
  //   • it reaches the write and the schema guard refuses its foreign key
  //     ("Config field \"disabledProviders\" is not volatile").
  assert.ok(
    r.toggle && r.toggle.ok !== true,
    `EXPECTED the known 0.2 failure, but disable succeeded: ${JSON.stringify(r.toggle)}`,
  )
  const msg = String(r.toggle?.error ?? r.toggle?.threw ?? '')
  assert.ok(
    /is not volatile/.test(msg) || /不存在/.test(msg),
    `expected the documented 0.2 failure mode, got: ${msg}`,
  )
})

expect('NEW plugin × 0.1 runtime', (r) => {
  assert.equal(r.applyError, null, `apply threw: ${r.applyError}`)
  assert.equal(r.hasConfig, true, 'new bundle must declare its own Config schema')
  assert.deepEqual(r.readsProviders, ['alpha'], 'new plugin must still read providers from llm-pi-ai')
  assert.equal(r.toggle?.ok, true, `disable should work on 0.1, got ${JSON.stringify(r.toggle)}`)
  assert.ok(
    r.warnings.some((w) => /legacy DSH 0\.1/.test(w)),
    `expected a 0.1 deprecation notice, got: ${JSON.stringify(r.warnings)}`,
  )
  assert.ok(
    !r.warnings.some((w) => /NOT operational/.test(w)),
    `self-check should pass on 0.1, got: ${JSON.stringify(r.warnings)}`,
  )
})

expect('NEW plugin × 0.2 runtime', (r) => {
  assert.equal(r.applyError, null, `apply threw: ${r.applyError}`)
  assert.deepEqual(r.readsProviders, ['alpha'], 'new plugin must read providers from llm-pi-ai')
  assert.equal(r.toggle?.ok, true, `disable should work on 0.2, got ${JSON.stringify(r.toggle)}`)
  assert.ok(
    !r.warnings.some((w) => /legacy DSH 0\.1/.test(w)),
    `0.2 must NOT emit the 0.1 deprecation notice, got: ${JSON.stringify(r.warnings)}`,
  )
  // The self-check must also be happy on a fully supported runtime.
  assert.ok(
    !r.warnings.some((w) => /NOT operational/.test(w)),
    `self-check should pass on 0.2, got: ${JSON.stringify(r.warnings)}`,
  )
})

expect('unknown settings shape is diagnosed, not silently degraded', () => {
  const cell = unknownCell
  assert.equal(cell.threw, null, `apply must not throw, got: ${cell.threw}`)
  assert.ok(
    cell.warnings.some((w) => /unrecognised settings service/.test(w)),
    `expected an explicit diagnostic, got: ${JSON.stringify(cell.warnings)}`,
  )
})

const total = HAVE_OLD ? 4 : 2
console.log(
  failed === 0
    ? `PASS: plugin × runtime matrix — ${total}/${total} cells behave as specified`
    : `FAIL: plugin × runtime matrix — ${failed}/${total} cells unexpected`,
)
process.exit(failed === 0 ? 0 : 1)
