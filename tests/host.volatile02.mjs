/**
 * tests/host.volatile02.mjs — drives the REAL host handlers against faithful
 * mocks of BOTH settings services:
 *
 *   • the 0.2.x desktop `SettingsForms` — no `get(ns)`, `describe()` projects
 *     each section to its schema-declared fields, and every write is rejected
 *     when the resulting section carries a key that is not below a
 *     `volatile()` node:
 *
 *         Config field "disabledProviders" is not volatile
 *
 *   • the 0.1.x `SettingsProvider` — `get(ns)` returns the raw resolved
 *     section (foreign keys included) and `replace()` accepts any key.
 *
 * The helpers mirror /dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js
 * (`isVolatilePath`, `volatileForm`, `projectForm`, `validatePaths`), so a
 * regression is caught here rather than only on a real desktop boot.
 *
 * Run: node --experimental-strip-types tests/host.volatile02.mjs
 */

import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'

import { toggleProvider } from '../src/host/handlers/toggle.ts'
import { readProviders, readDisabled } from '../src/host/utils.ts'
import { Config, CONFIG_NS, bindConfigAccessor } from '../src/host/config.ts'
import { migrateDisabledLayout } from '../src/host/settings.ts'

/** Volatility marking that works on schemastery 3.18.1 and 3.18.4 alike. */
const volatile = (schema) => schema.extra('volatile', true)

// --- dsh-settings helpers, mirrored -----------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Resolve one hop of a serialized schema.
 *
 * schemastery 3.18.1 (= what this repo and the 0.1 web profile resolve) emits a
 * flat `{uid, refs}` document whose `dict`/`inner` members are numeric refs.
 * 3.18.4 (= what the desktop app bundles) inlines them. The real settings code
 * reads `schema.meta` / `schema.dict[key]` directly, i.e. it expects the
 * inlined form — so resolve the 0.1 shape into it and mirror the runtime.
 */
const resolve = (root, node) => {
  if (typeof node === 'number') return root.refs[node]
  // The serialized document itself is `{uid, refs}`: its root node lives in refs.
  if (node !== null && typeof node === 'object' && node.refs !== undefined && node.uid !== undefined) {
    return node.refs[node.uid]
  }
  return node
}

const isVolatile = (root, schema) => resolve(root, schema)?.meta?.volatile === true

const isVolatilePath = (root, schema, path) => {
  const node = resolve(root, schema)
  if (node?.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : node?.dict?.[key]
  return child !== undefined && isVolatilePath(root, child, rest)
}

/** Keep only schema-declared paths (schema.js `projectForm`). */
const projectForm = (root, schema, value) => {
  const node = resolve(root, schema)
  if (node?.type === 'object' && isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      if (Object.hasOwn(value, key)) out[key] = projectForm(root, child, value[key])
    }
    return out
  }
  return value
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

// --- schemas, built with the real schemastery ------------------------------
/** A provider profile: the fields llm-pi-ai actually validates. Anything else
 * (notably this plugin's `disabled` marker) is drifted away on 0.2. */
const profileSchema = z.object({
  baseURL: z.string(),
  api: z.string(),
  models: z.any(),
  disabled: z.boolean(),
})

/** llm-pi-ai's real 0.2 shape: `providers` is the only declared, volatile key. */
const llmPiAiRaw = z.object({
  providers: volatile(z.dict(profileSchema).default({})),
})

// --- the fake 0.2 settings service ------------------------------------------
class Fake02Settings {
  constructor(entries) {
    this.entries = entries
    this.writable = true
    this.writes = []
  }
  // Deliberately NO get(ns): this is the 0.2 shape.
  #form(ns) {
    return this.entries[ns]?.schema
  }
  #resolved(ns) {
    const e = this.entries[ns]
    if (e === undefined) return undefined
    // `Config({})` applies schema defaults to a section never written.
    const raw = Object.keys(e.section ?? {}).length === 0 && e.raw !== undefined ? e.raw({}) : e.section
    return clone(raw)
  }
  describe() {
    return Object.entries(this.entries).map(([ns, e]) => {
      const form = this.#form(ns)
      return {
        ns,
        schema: form,
        revision: e.revision ?? 0,
        value: projectForm(form, form, this.#resolved(ns)),
        user: projectForm(form, form, e.section ?? {}),
      }
    })
  }
  async replace(ns, section) {
    const form = this.#form(ns)
    if (form === undefined) throw new Error(`No configurable plugin entry "${ns}"`)

    const next = clone(section)
    const validatePaths = (value, n, path = []) => {
      for (const [key, child] of Object.entries(value)) {
        const target = [...path, key]
        if (isVolatilePath(form, form, target)) continue
        const fields = resolve(form, n)?.dict
        const field = fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined
        if (isPlainObject(child) && field !== undefined) validatePaths(child, field, target)
        else throw new Error(`Config field "${target.join('.')}" is not volatile`)
      }
    }
    validatePaths(next, form)

    this.writes.push({ ns, section: next })
    this.entries[ns].section = next
    this.entries[ns].revision = (this.entries[ns].revision ?? 0) + 1
  }
}

/** The 0.1 service: raw `get(ns)`, permissive `replace()`, no guard. */
class Fake01Settings {
  constructor(entries) {
    this.entries = entries
    this.writable = true
    this.writes = []
  }
  get(ns) {
    return clone(this.entries[ns]?.section)
  }
  async replace(ns, section) {
    if (this.entries[ns] === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    this.writes.push({ ns, section: clone(section) })
    this.entries[ns].section = clone(section)
  }
}

const ctxWith = (settings) => ({ get: (name) => (name === 'settings' ? settings : undefined) })

const baseEntries = () => ({
  'llm-pi-ai': {
    schema: llmPiAiRaw.toJSON(),
    raw: llmPiAiRaw,
    section: { providers: { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] } } },
  },
  [CONFIG_NS]: { schema: Config.toJSON(), raw: Config, section: {} },
})

// --- scenarios --------------------------------------------------------------
const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

// 1. 0.2 READ path: no get(ns), so reads must go through describe().
{
  const settings = new Fake02Settings(baseEntries())
  bindConfigAccessor(settings)
  await check('0.2 readProviders works without get(ns)', () => {
    const providers = readProviders(settings)
    assert.equal(typeof providers.alpha, 'object', `expected alpha, got ${JSON.stringify(providers)}`)
  })
}

// 2. 0.2 WRITE path: disabling must not write the foreign key into llm-pi-ai.
{
  const settings = new Fake02Settings(baseEntries())
  bindConfigAccessor(settings)
  const r = await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: false })
  await check('0.2 disable succeeds, llm-pi-ai write carries only `providers`', () => {
    assert.equal(r.ok, true, `handler returned ${JSON.stringify(r)}`)
    for (const w of settings.writes.filter((w) => w.ns === 'llm-pi-ai')) {
      assert.deepEqual(Object.keys(w.section), ['providers'], `llm-pi-ai keys: ${JSON.stringify(Object.keys(w.section))}`)
    }
    assert.ok(!('alpha' in settings.entries['llm-pi-ai'].section.providers), 'alpha must leave providers')
  })
}

// 3. 0.2: the disabled profile is preserved in OUR OWN section.
{
  const settings = new Fake02Settings(baseEntries())
  bindConfigAccessor(settings)
  await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: false })
  await check('0.2 parks the profile in the plugin-owned section', () => {
    const owned = settings.entries[CONFIG_NS].section
    assert.ok(owned.disabledProviders?.alpha, `owned section: ${JSON.stringify(owned)}`)
    assert.equal(owned.disabledProviders.alpha.baseURL, 'https://a.example/v1')
    assert.ok(readDisabled(settings).alpha, 'readDisabled must surface the parked profile')
  })
}

// 4. 0.2 ROAD-TRIP: disable then enable restores the profile intact.
{
  const settings = new Fake02Settings(baseEntries())
  bindConfigAccessor(settings)
  await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: false })
  const r2 = await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: true })
  await check('0.2 disable -> enable round-trips the profile', () => {
    assert.equal(r2.ok, true, `enable returned ${JSON.stringify(r2)}`)
    const providers = readProviders(settings)
    assert.ok(providers.alpha, 'alpha must be back in providers')
    assert.equal(providers.alpha.baseURL, 'https://a.example/v1')
    assert.equal(providers.alpha.models[0].id, 'm1')
    assert.ok(!readDisabled(settings).alpha, 'alpha must no longer be parked')
  })
}

// 5. 0.1 still works: raw get(), foreign key tolerated, round-trips the same.
{
  const settings = new Fake01Settings(baseEntries())
  bindConfigAccessor(settings)
  await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: false })
  const r2 = await toggleProvider(ctxWith(settings), { route: 'alpha', enabled: true })
  await check('0.1 disable -> enable still round-trips (no regression)', () => {
    assert.equal(r2.ok, true, `enable returned ${JSON.stringify(r2)}`)
    assert.ok(readProviders(settings).alpha, 'alpha must be back in providers')
    assert.equal(readProviders(settings).alpha.baseURL, 'https://a.example/v1')
  })
}

// 6. 0.1 LEGACY bag: a profile parked at llm-pi-ai.disabledProviders is still
//    readable, so an upgrade path keeps the parked data reachable.
{
  const entries = baseEntries()
  entries['llm-pi-ai'].section.disabledProviders = { beta: { baseURL: 'https://b.example/v1' } }
  const settings = new Fake01Settings(entries)
  bindConfigAccessor(settings)
  await check('0.1 legacy llm-pi-ai.disabledProviders stays readable', () => {
    assert.ok(readDisabled(settings).beta, `expected beta, got ${JSON.stringify(readDisabled(settings))}`)
  })
}

// 7. 0.1 MARKER migration: a marked profile left in `providers` by an unload is
//    moved out of providers and into the parked bag.
{
  const entries = baseEntries()
  entries['llm-pi-ai'].section.providers.alpha.disabled = true
  const settings = new Fake01Settings(entries)
  bindConfigAccessor(settings)
  const migrated = await migrateDisabledLayout(ctxWith(settings))
  await check('0.1 marked provider is re-parked out of llm-pi-ai.providers', () => {
    assert.equal(migrated.parked, 1, `migration: ${JSON.stringify(migrated)}`)
    assert.ok(!('alpha' in readProviders(settings)), 'alpha must leave providers')
    assert.ok(readDisabled(settings).alpha, 'alpha must be parked')
  })
}

// 8. Idempotence: a second run with nothing to move performs no write.
{
  const settings = new Fake02Settings(baseEntries())
  bindConfigAccessor(settings)
  await migrateDisabledLayout(ctxWith(settings))
  const before = settings.writes.length
  await migrateDisabledLayout(ctxWith(settings))
  await check('migration is idempotent (no write when nothing moved)', () => {
    assert.equal(settings.writes.length, before, `unexpected writes: ${JSON.stringify(settings.writes)}`)
  })
}

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
    ? `PASS: 0.1/0.2 settings contract — ${results.length}/${results.length} green`
    : `FAIL: 0.1/0.2 settings contract — ${failed}/${results.length} failed`,
)
process.exit(failed === 0 ? 0 : 1)
