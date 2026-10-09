/**
 * tests/host.compat-layer.mjs — the compatibility layer's own contract.
 *
 * `src/host/compat.ts` is the single place where settings-service differences
 * live, so its behaviour is specified here rather than inferred from the
 * plugin's end-to-end tests. Each case pins one of the four rules in that
 * module's header, including every FAILURE mode — a compatibility layer that is
 * only tested on happy paths is how "my providers vanished" ships.
 *
 * Run: node scripts/run-node-test.mjs tests/host.compat-layer.mjs
 */

import assert from 'node:assert/strict'
import zReal from '@deepseek-ai/schemastery'

import {
  SELF_CHECK_KEY,
  isDescriptorSettings,
  ownedNamespace,
  readProviderDict,
  readSection,
  selfCheck,
  setOwnedNamespace,
  settingsArm,
  writeLLMProviders,
  writeOwnedSection,
} from '../src/host/compat.ts'
import { buildConfig } from '../src/host/config.ts'

const NS = 'llm-pi-ai'

// --- tiny service doubles ---------------------------------------------------
const rawService = (doc = {}, ns = 'dsh-model-pro') => {
  let store = structuredClone(doc)
  return {
    writable: true,
    get: (n) => structuredClone(n === NS ? store.providers === undefined ? store : store : n === ns ? store : undefined),
    replace: async (n, section) => { if (n === NS || n === ns) store = structuredClone(section) },
    _store: () => store,
  }
}
/**
 * A faithful 0.2 `SettingsForms` double.
 *
 * `describe()` PROJECTS each namespace to the fields its schema declares (that
 * is what `projectForm` does in the real service), so a foreign key placed in a
 * section is genuinely invisible here — which is the property RULE 3 depends on
 * and the reason the migration cannot reclaim what it cannot see.
 */
const descriptorService = (doc = {}, ns = 'dsh-model-pro') => {
  const cfg = buildConfig(zReal).toJSON()
  const cfgRoot = cfg.refs[cfg.uid]
  const declaredOwned = Object.keys(cfgRoot.dict ?? {})
  const llmSchema = zReal.object({ providers: zReal.dict(zReal.any()).default({}) }).toJSON()
  const project = (schemaJson, value) => {
    const root = schemaJson.refs[schemaJson.uid]
    if (root?.type !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const out = {}
    for (const k of Object.keys(root.dict ?? {})) if (Object.hasOwn(value, k)) out[k] = value[k]
    return out
  }
  return {
    writable: true,
    describe: () => [
      { ns, schema: cfg, revision: 0, value: project(cfg, doc), user: project(cfg, doc) },
      // The real host serves BOTH layers projected to the schema: `value` is the
      // resolved config, `user` the profile patch. This double keeps one store
      // for llm-pi-ai, so both rows project it (the projection is what hides
      // foreign keys — RULE 3).
      { ns: NS, schema: llmSchema, revision: 0, value: project(llmSchema, doc.providers ? { providers: doc.providers } : {}), user: project(llmSchema, doc.providers ? { providers: doc.providers } : {}) },
    ],
    // Faithful `SettingsForms.write`: the stored patch becomes
    // mergeLayers(strip(raw, form), next) — DECLARED fields are dropped from the
    // stored section and restated only from the write, so a partial section
    // RESETS every declared field it omits (the issue #6 data-loss mechanism).
    // UNDECLARED keys survive.
    replace: async (n, section) => {
      if (n !== ns) return
      const next = structuredClone(section)
      for (const k of Object.keys(next)) {
        if (!declaredOwned.includes(k)) throw new Error(`Config field "${k}" is not volatile`)
      }
      const stripped = {}
      for (const [k, v] of Object.entries(doc)) {
        if (!declaredOwned.includes(k)) stripped[k] = structuredClone(v)
      }
      doc = { ...stripped, ...next }
    },
    // Faithful `SettingsForms.update`: merge the patch into the CURRENT section.
    update: async (n, patch) => {
      if (n !== ns) return
      const p = structuredClone(patch)
      for (const k of Object.keys(p)) {
        if (!declaredOwned.includes(k)) throw new Error(`Config field "${k}" is not volatile`)
      }
      doc = { ...doc, ...p }
    },
    _store: () => doc,
    _declared: declaredOwned,
  }
}

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

// --- RULE 1: detect by capability, not version ------------------------------
await check('RULE 1 — detects `raw` by get(ns)', () => {
  assert.equal(settingsArm(rawService()), 'raw')
  assert.equal(isDescriptorSettings(rawService()), false)
})
await check('RULE 1 — detects `descriptor` by describe()', () => {
  assert.equal(settingsArm(descriptorService()), 'descriptor')
  assert.equal(isDescriptorSettings(descriptorService()), true)
})
await check('RULE 1 — a service with NEITHER capability is `unknown`, not assumed', () => {
  // The regression this guards: `typeof st.get !== 'function'` would file this
  // under `descriptor`, and the plugin would then read nothing while claiming it
  // had read something.
  assert.equal(settingsArm({ writable: true, replace: async () => {} }), 'unknown')
  assert.equal(settingsArm(undefined), 'unknown')
  assert.equal(settingsArm(null), 'unknown')
})
await check('RULE 1 — detection never throws on a hostile service', () => {
  const hostile = { get: 1, describe: 'nope', replace: async () => {} }
  assert.equal(settingsArm(hostile), 'unknown')
  const thrower = {
    get: () => { throw new Error('boom') },
    get writable() { throw new Error('boom') },
    replace: async () => {},
  }
  assert.equal(settingsArm(thrower), 'raw')
})

// --- RULE 3: never destroy what you cannot read -----------------------------
await check('RULE 3 — `raw` reads expose undeclared foreign keys', () => {
  const st = rawService({ providers: { a: {} }, routes: { r: 1 } })
  assert.deepEqual(Object.keys(readSection(st, NS)).sort(), ['providers', 'routes'])
})
await check('RULE 3 — `descriptor` reads are projected, hiding foreign keys', () => {
  // A faithful descriptor answers with the section it SERVES. Our double returns
  // the raw object, so this asserts the reader does not invent extra reads.
  const st = descriptorService({ providers: { a: {} } })
  assert.deepEqual(Object.keys(readSection(st, NS)), ['providers'])
})
await check('RULE 3 — reads degrade to {} instead of throwing', () => {
  assert.deepEqual(readSection(undefined, NS), {})
  assert.deepEqual(readSection({ writable: true, replace: async () => {}, get: () => undefined }, NS), {})
  assert.deepEqual(readProviderDict({ writable: true, replace: async () => {}, get: () => { throw new Error('x') } }), {})
  assert.deepEqual(readProviderDict(undefined), {})
})

// --- RULE 2: one write path per namespace -----------------------------------
await check('RULE 2 — writeLLMProviders emits EXACTLY the one declared key', async () => {
  const st = rawService({ providers: {} })
  await writeLLMProviders(st, { alpha: { baseURL: 'u' } })
  assert.deepEqual(Object.keys(st._store()), ['providers'], `keys: ${JSON.stringify(Object.keys(st._store()))}`)
  assert.deepEqual(Object.keys(st._store().providers), ['alpha'])
})
await check('RULE 2 — writeOwnedSection writes the resolved owned namespace', async () => {
  const st = rawService({})
  setOwnedNamespace('dsh-model-pro')
  await writeOwnedSection(st, { routes: { r: 1 } })
  assert.equal(ownedNamespace(), 'dsh-model-pro')
  assert.deepEqual(st._store().routes, { r: 1 })
})

// --- RULE 4: the self-check, every failure mode -----------------------------
await check('RULE 4 — happy path reports operational', async () => {
  const st = descriptorService({})
  const r = await selfCheck(st, 'dsh-model-pro')
  assert.equal(r.code, 'ok', JSON.stringify(r))
  assert.equal(r.operational, true)
  assert.equal(r.arm, 'descriptor')
})
await check('RULE 4 — catches a service that ACCEPTS writes it never serves', async () => {
  // The whole point of a round-trip check: this is the `unknown`-shaped failure
  // that otherwise presents as an empty provider list rather than an error.
  const blackHole = { writable: true, describe: () => [], replace: async () => {} }
  const r = await selfCheck(blackHole, 'dsh-model-pro')
  assert.equal(r.code, 'roundtrip-mismatch', JSON.stringify(r))
  assert.equal(r.operational, false)
  assert.match(r.detail, /accepts writes it does not serve/)
})
await check('RULE 4 — reports a rejecting write', async () => {
  const st = {
    writable: true,
    describe: () => [{ ns: 'dsh-model-pro', value: {} }],
    replace: async () => { throw new Error('Config field "writeProbe" is not volatile') },
  }
  const r = await selfCheck(st, 'dsh-model-pro')
  assert.equal(r.code, 'write-failed', JSON.stringify(r))
  assert.match(r.detail, /is not volatile/)
})
await check('RULE 4 — reports an unknown service shape instead of guessing', async () => {
  const r = await selfCheck({ writable: true, replace: async () => {} }, 'dsh-model-pro')
  assert.equal(r.code, 'unknown-arm', JSON.stringify(r))
  assert.equal(r.operational, false)
})
await check('RULE 4 — reports a missing service and a read-only service', async () => {
  assert.equal((await selfCheck(undefined, 'x')).code, 'no-settings-service')
  assert.equal((await selfCheck({ writable: false, replace: async () => {} }, 'x')).code, 'read-only')
})
await check('RULE 4 — the probe leaves a readable token, not wreckage', async () => {
  const st = descriptorService({ routes: { keep: 1 } })
  const r = await selfCheck(st, 'dsh-model-pro')
  assert.equal(r.code, 'ok', JSON.stringify(r))
  assert.ok(typeof st._store()[SELF_CHECK_KEY] === 'string', 'probe token should be persisted')
  assert.deepEqual(st._store().routes, { keep: 1 }, 'self-check must not clobber other owned state')
})

await check('RULE 4 — a descriptor arm WITHOUT update() still preserves owned state', async () => {
  // The fallback for an older/different descriptor service: read what is served,
  // restate it alongside the probe (RULE 3). A one-field replace here would be
  // exactly the issue #6 wipe, because this double's replace() is faithful.
  const st = descriptorService({ routes: { keep: 1 } })
  delete st.update
  const r = await selfCheck(st, 'dsh-model-pro')
  assert.equal(r.code, 'ok', JSON.stringify(r))
  assert.deepEqual(st._store().routes, { keep: 1 }, 'self-check must not clobber other owned state')
  assert.ok(typeof st._store()[SELF_CHECK_KEY] === 'string', 'probe token should be persisted')
})

await check('RULE 4 — a HANGING service cannot block activation (bounded probe)', async () => {
  // Regression: the 0.1 service queued the probe write and never resolved it, so
  // an unbounded self-check hung the entire plugin at startup.
  const hanging = {
    writable: true,
    get: () => ({}),
    replace: () => new Promise(() => {}), // never settles
  }
  const started = Date.now()
  const r = await selfCheck(hanging, 'dsh-model-pro', { timeoutMs: 150 })
  const elapsed = Date.now() - started
  assert.equal(r.code, 'timed-out', JSON.stringify(r))
  assert.equal(r.operational, false)
  assert.ok(elapsed < 1500, `self-check must give up promptly, took ${elapsed}ms`)
  assert.match(r.detail, /did not complete a write\/read round-trip/)
})
await check('RULE 4 — a hanging service does not leave an unhandled rejection', async () => {
  const lateReject = {
    writable: true,
    get: () => ({}),
    replace: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)),
  }
  const r = await selfCheck(lateReject, 'dsh-model-pro', { timeoutMs: 10 })
  assert.equal(r.code, 'timed-out')
  await new Promise((res) => setTimeout(res, 60)) // let the late rejection fire
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
    ? `PASS: compatibility layer contract — ${results.length}/${results.length} green`
    : `FAIL: compatibility layer contract — ${failed}/${results.length} failed`,
)
process.exit(failed === 0 ? 0 : 1)
