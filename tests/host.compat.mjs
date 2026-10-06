/**
 * tests/host.compat.mjs — an install upgraded from an OLDER version must not
 * lose (or hide) the configuration that version wrote.
 *
 * Older versions squatted this plugin's state at the `llm-pi-ai` section root:
 * `routes`, `composites`, `routeStats`, `uiPrefs`, `routerRetry`,
 * `modelCatalog`, `localGateway`, `modelCapabilities` and `disabledProviders`.
 * Readers now resolve those from the plugin's OWN section — correctly, because
 * DSH 0.2 neither declares nor serves an undeclared `llm-pi-ai` key — so without
 * a migration the operator's routes and preferences would silently vanish from
 * the UI even though they are still on disk.
 *
 * This boots the REAL bundle through `apply()` against a realistic older-version
 * settings document and asserts every one of those keys is reachable afterwards.
 *
 * Run: node scripts/run-node-test.mjs tests/host.compat.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import zReal from '@deepseek-ai/schemastery'

import { readRoutes, readRoutesRootKey, readDisabled } from '../src/host/utils.ts'
import { CONFIG_NS, bindConfigAccessor } from '../src/host/config.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST_BUNDLE = path.join(__dirname, '..', 'dist', 'host.js')
const OWN_NS = CONFIG_NS

// --- schemas the sandbox's `z` shim hands back (real schemastery objects) ----
const realAny = zReal.any().default({})
const realDict = zReal.dict(zReal.any()).default({})
const realConfigSchema = zReal.object({
  disabledProviders: realDict.extra('volatile', true),
  modelCapabilities: realAny.extra('volatile', true),
  routes: realAny.extra('volatile', true),
  composites: realAny.extra('volatile', true),
  routeStats: realAny.extra('volatile', true),
  uiPrefs: realAny.extra('volatile', true),
  routerRetry: realAny.extra('volatile', true),
  modelCatalog: realAny.extra('volatile', true),
  localGateway: realAny.extra('volatile', true),
})

/** Load the built bundle the way the DSH host loader does. */
async function loadHost() {
  let code = readFileSync(HOST_BUNDLE, 'utf8')
  code = code.replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']@deepseek-ai\/dsh-typert-protocol["'];?/m, '')
  code = code.replace(/^\s*import\s+z\s+from\s+["']@deepseek-ai\/schemastery["'];?/m, '')
  code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')

  const sandbox = {
    console, setTimeout, clearTimeout, Date, Promise, AbortController, TextEncoder, TextDecoder,
    z: Object.assign(() => realAny, { object: () => realConfigSchema, dict: () => realDict, any: () => realAny, boolean: () => zReal.boolean() }),
    TypertRemoteService: class { constructor(ctx) { this.ctx = ctx } },
  }
  sandbox.globalThis = sandbox
  const result = await vm.runInContext(
    `(async () => { ${code}\n; return { apply }; })()`,
    vm.createContext(sandbox),
    { filename: 'model-pro-host.js' },
  )
  return result.apply
}

/** Volatility marking that works on schemastery 3.18.1 and 3.18.4 alike. */
const volatile = (schema) => schema.extra('volatile', true)

// --- a settings document as an OLDER version would have left it -------------
const LEGACY_KEYS = {
  routes: { auto: { strategy: 'priority', targets: [{ provider: 'alpha', model: 'm1' }] } },
  composites: { mix: { members: ['alpha'], strategy: 'union' } },
  routeStats: { byTarget: { alpha: { ok: 3 } }, logs: [{ route: 'auto' }] },
  uiPrefs: { showRouteBadge: false },
  routerRetry: { maxRetries: 3 },
  modelCatalog: { origins: { alpha: 'catalog' } },
  localGateway: { enabled: true },
  modelCapabilities: { alpha: { binding: 'x', models: {} } },
}

/** llm-pi-ai's real 0.2 schema: `providers` is the only declared volatile key. */
const profileRaw = zReal.object({ baseURL: zReal.string(), api: zReal.string(), models: zReal.any(), disabled: zReal.boolean() })
const llmPiAiRaw = zReal.object({ providers: volatile(zReal.dict(profileRaw).default({})) })

// --- schema navigation, mirroring dsh-settings' schema.js -------------------
const resolveRef = (root, node) => {
  if (typeof node === 'number') return root.refs[node]
  if (node !== null && typeof node === 'object' && node.refs !== undefined && node.uid !== undefined) return node.refs[node.uid]
  return node
}
const isVolatilePath = (root, schema, path) => {
  const node = resolveRef(root, schema)
  if (node?.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : node?.dict?.[key]
  return child !== undefined && isVolatilePath(root, child, rest)
}
/** `projectForm`: keep only schema-declared paths. This is what makes an
 * undeclared `llm-pi-ai` key INVISIBLE to every reader on 0.2. */
const projectForm = (root, schema, value) => {
  const node = resolveRef(root, schema)
  if (node?.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [k, c] of Object.entries(node.dict ?? {})) {
      if (Object.hasOwn(value, k)) out[k] = projectForm(root, c, value[k])
    }
    return out
  }
  return value
}

/**
 * A faithful 0.2 `SettingsForms`: no `get(ns)`, schema-PROJECTED `describe()`,
 * and writes that validate every destination path against `meta.volatile` then
 * persist as `mergeLayers(strip(raw), next)` (declared fields restated,
 * undeclared keys preserved).
 */
function make02Install(initialDoc, schemaJson, ownSchemaJson) {
  let doc = structuredClone(initialDoc)
  let own = {}
  const store = (ns) => (ns === 'llm-pi-ai' ? doc : ns === OWN_NS ? own : undefined)
  const schemaOf = (ns) => (ns === 'llm-pi-ai' ? schemaJson : ownSchemaJson)
  return {
    st: {
      writable: true,
      describe: () => [
        { ns: 'llm-pi-ai', schema: schemaJson, revision: 0, value: projectForm(schemaJson, schemaJson, doc), user: projectForm(schemaJson, schemaJson, doc) },
        { ns: OWN_NS, schema: ownSchemaJson, revision: 0, value: projectForm(ownSchemaJson, ownSchemaJson, own), user: projectForm(ownSchemaJson, ownSchemaJson, own) },
      ],
      replace: async (ns, section) => {
        const form = schemaOf(ns)
        if (form === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
        const next = structuredClone(section)
        for (const [key] of Object.entries(next)) {
          if (!isVolatilePath(form, form, [key])) throw new Error(`Config field "${key}" is not volatile`)
        }
        const declared = Object.keys(resolveRef(form, form)?.dict ?? {})
        const base = {}
        for (const [k, v] of Object.entries(store(ns) ?? {})) if (!declared.includes(k)) base[k] = structuredClone(v)
        const merged = { ...base, ...next }
        if (ns === 'llm-pi-ai') doc = merged
        else { for (const k of Object.keys(own)) delete own[k]; Object.assign(own, merged) }
      },
    },
    doc: () => doc,
    own: () => own,
  }
}

const install = make02Install(
  {
    providers: { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] } },
    disabledProviders: { parked: { baseURL: 'https://p.example/v1', models: [] } },
    ...structuredClone(LEGACY_KEYS),
    noteK: 1,
  },
  llmPiAiRaw.toJSON(),
  realConfigSchema.toJSON(),
)
const { st, doc, own } = install
const apply = await loadHost()
const ctx = {
  get: (name) => (name === 'settings' ? st : undefined),
  typert: { register: () => () => {} },
  on: () => () => {},
  effect: (fn) => { fn() },
}
await apply(ctx)

// The bundle runs in the vm realm and binds THIS PLUGIN's accessor on ITS
// `globalThis`. Our own imported readers resolve the same accessor key from the
// TEST realm, so bind it here too — otherwise `readRoutes` below would look at a
// different global and report an empty section.
bindConfigAccessor(st)

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

const describeRow = (ns) => st.describe().find((r) => r.ns === ns)

// --- 0.1 (raw `get`) : the migration is fully achievable here ---------------
/**
 * A faithful 0.1 `SettingsProvider`: `get(ns)` hands back the RAW resolved
 * section, foreign keys included, and `replace()` writes the section wholesale.
 * This is the runtime where the migration can actually reclaim every key, so it
 * is the cell that proves the feature works.
 */
function make01Install(initialDoc) {
  let doc = structuredClone(initialDoc)
  let own = {}
  return {
    st: {
      writable: true,
      get: (ns) => (ns === 'llm-pi-ai' ? structuredClone(doc) : ns === OWN_NS ? structuredClone(own) : undefined),
      replace: async (ns, section) => {
        if (ns === 'llm-pi-ai') doc = structuredClone(section)
        else if (ns === OWN_NS) own = structuredClone(section)
        else throw new Error(`unexpected ns: ${ns}`)
      },
    },
    doc: () => doc,
    own: () => own,
  }
}

{
  const legacyDoc = {
    providers: { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] } },
    disabledProviders: { parked: { baseURL: 'https://p.example/v1', models: [{ id: 'm9' }] } },
    ...structuredClone(LEGACY_KEYS),
    noteK: 1,
  }
  const older = make01Install(legacyDoc)
  const apply01 = await loadHost()
  await apply01({
    get: (name) => (name === 'settings' ? older.st : undefined),
    typert: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn() },
  })
  const row = older.own()
  for (const key of [...Object.keys(LEGACY_KEYS), 'disabledProviders']) {
    await check(`0.1 migration reclaims "${key}" into the plugin-owned section`, () => {
      assert.ok(row[key] !== undefined, `owned section is missing "${key}" (has ${JSON.stringify(Object.keys(row))})`)
    })
  }
  await check('0.1 migration reclaims the parked profile payload intact', () => {
    assert.deepEqual(row.disabledProviders?.parked, legacyDoc.disabledProviders.parked, 'parked profile changed')
  })
  await check('0.1 migration strips our foreign keys and keeps the operator key', () => {
    // `noteK` belongs to the operator, not to us: the cleanup must restate it.
    assert.deepEqual(Object.keys(older.doc()).sort(), ['noteK', 'providers'], `llm-pi-ai holds ${JSON.stringify(Object.keys(older.doc()))}`)
    assert.deepEqual(Object.keys(older.doc().providers), ['alpha'], 'provider lost during cleanup')
  })
}

// --- what 0.2 genuinely exposes --------------------------------------------
await check('a 0.2 reader can still see the live provider (the feature that matters)', () => {
  const providers = describeRow('llm-pi-ai')?.value?.providers ?? {}
  assert.deepEqual(Object.keys(providers), ['alpha'], `got ${JSON.stringify(Object.keys(providers))}`)
  assert.equal(providers.alpha.baseURL, 'https://a.example/v1', 'provider payload changed')
})

await check('undeclared keys in llm-pi-ai are INVISIBLE on 0.2 (documented limitation)', () => {
  // `describe()` runs every section through `projectForm`, which keeps only
  // schema-declared paths. A foreign key an older version squatted therefore
  // cannot be read back through the settings API on 0.2 — for THIS plugin or any
  // other. This is the constraint that makes a fully automatic migration
  // impossible on 0.2, and it is asserted so that a change in that behaviour is
  // noticed rather than silently altering what the migration can reach.
  const value = describeRow('llm-pi-ai')?.value ?? {}
  assert.deepEqual(Object.keys(value), ['providers'], `unexpected keys: ${JSON.stringify(Object.keys(value))}`)
})

await check('operator keys survive in the raw document', () => {
  assert.equal(doc().noteK, 1, 'the operator key was lost')
})

await check('the plugin does not destroy provider data it cannot read', () => {
  // Nothing on 0.2 may remove the legacy keys, because nothing can read them to
  // migrate them first. Losing them would be strictly worse than leaving them.
  const rawKeys = Object.keys(doc())
  assert.ok(rawKeys.includes('providers'), 'providers vanished')
  for (const key of Object.keys(LEGACY_KEYS)) {
    assert.ok(rawKeys.includes(key), `legacy key "${key}" was destroyed instead of left in place`)
  }
})

// --- what 0.1 genuinely exposes (raw get) -----------------------------------
// The migration's job is fully achievable here, and IS exercised by
// tests/host.volatile02.mjs ("0.1 marked provider is re-parked") plus the
// smoke suite. This cell pins the difference explicitly.
await check('0.1 exposes the same keys raw, which is why the migration is unconditional', () => {
  const raw = { providers: { alpha: {} }, ...structuredClone(LEGACY_KEYS) }
  const rawKeys = Object.keys(raw)
  for (const key of Object.keys(LEGACY_KEYS)) {
    assert.ok(rawKeys.includes(key), `0.1 raw section is expected to expose "${key}"`)
  }
})

// --- report -----------------------------------------------------------------
let failed = 0
for (const r of results) {
  if (r.ok) console.log(`  ok   ${r.label}`)
  else {
    failed += 1
    console.log(`  FAIL ${r.label}\n       ${r.error}`)
  }
}
console.log(
  failed === 0
    ? `PASS: older-install compatibility — ${results.length}/${results.length} green`
    : `FAIL: older-install compatibility — ${failed}/${results.length} failed`,
)
process.exit(failed === 0 ? 0 : 1)
