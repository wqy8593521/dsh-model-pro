/**
 * tests/host.schema.mjs — the plugin's own settings schema must survive on BOTH
 * schemastery versions that ship across the two DSH arms.
 *
 * Why this is a separate test: the failure it guards is SILENT. schemastery
 * 3.18.4 (bundled with the desktop app) validates volatile schemas and, when the
 * dedicated `.volatile()` wrapper is bypassed, quietly falls back to the field's
 * default — so a parked-provider bag would round-trip as `{}` and every disabled
 * provider would vanish on the next write. Only asserting the round-trip catches
 * that; a typecheck and a metadata check both pass.
 *
 * Run: node scripts/run-node-test.mjs tests/host.schema.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import zRepo from '@deepseek-ai/schemastery'
import { buildConfig, OWNED_STATE_KEYS } from '../src/host/config.ts'
import { SELF_CHECK_KEY } from '../src/host/compat.ts'
import { CAPABILITIES_KEY } from '../src/host/capabilityStore.ts'
import {
  ROUTES_KEY,
  COMPOSITES_KEY,
  ROUTE_STATS_KEY,
  UI_PREFS_KEY,
  RETRY_KEY,
  CATALOG_KEY,
  LOCAL_GATEWAY_KEY,
} from '../src/shared/constants.ts'

/**
 * Every key the owned-state writers actually persist.
 *
 * Derived from the modules that own them, NOT re-listed by hand: a new key added
 * to a writer without a matching schema field would otherwise sail through these
 * tests and only surface in production as
 *
 *     Config field "X" is not volatile
 *
 * which aborts the user's operation (that is exactly how `modelCapabilities`
 * shipped broken once).
 */
const WRITTEN_KEYS = [
  'disabledProviders',
  CAPABILITIES_KEY,
  ROUTES_KEY,
  COMPOSITES_KEY,
  ROUTE_STATS_KEY,
  UI_PREFS_KEY,
  RETRY_KEY,
  CATALOG_KEY,
  LOCAL_GATEWAY_KEY,
  // Persisted by compat.selfCheck() (RULE 4): it round-trips this field to prove
  // writes are actually served, so it is a real owned key.
  SELF_CHECK_KEY,
].sort()

/** cosmokit's volatile-reference protocol: `isVolatile(v) === write in v`. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const isVolatile = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value

/**
 * Detach a parsed schema value.
 *
 * On 3.18.4 a `volatile()` node resolves to a volatile REFERENCE, so the bag is
 * reachable only through `get()` — `JSON.stringify` on the reference yields `{}`
 * and would make a correct schema look broken. dsh-settings does the same
 * unwrapping in `plainConfig`, which is why `describe().value` is plain.
 */
const plain = (value) => {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

/** The bag we must never lose: a full provider profile, not a scalar. */
const BAG = {
  alpha: {
    baseURL: 'https://a.example/v1',
    api: 'openai-completions',
    models: [{ id: 'm1', name: 'm1' }],
    headers: { 'x-a': '1' },
    defaultContextWindow: 262144,
    disabled: true,
  },
  beta: { baseURL: 'https://b.example/v1', models: [] },
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

/** Assert one schemastery builds a schema that round-trips owned state intact. */
function assertRoundTrips(label, schemastery) {
  const Config = buildConfig(schemastery)

  // 1. The declared fields must cover every key the writers use — no more (an
  //    unnecessary field is dead config) and no less (a missing one throws
  //    `Config field "X" is not volatile` on the real 0.2 service).
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  assert.deepEqual(
    Object.keys(root.dict ?? {}).sort(),
    WRITTEN_KEYS,
    `${label}: declared schema fields do not match the keys the writers persist`,
  )

  // 2. Every declared field must be volatile, or 0.2 refuses to write it.
  for (const key of WRITTEN_KEYS) {
    const ref = json.refs[root.dict[key]]
    assert.equal(
      ref?.meta?.volatile,
      true,
      `${label}: field "${key}" is not marked volatile — 0.2 will reject writes to it`,
    )
  }

  // 3. Values must survive byte-for-byte, including the deepest shapes.
  const bag = { alpha: { baseURL: 'https://a.example/v1', models: [{ id: 'm1' }], disabled: true } }
  const state = Object.fromEntries(WRITTEN_KEYS.map((k) => [k, { [`${k}-entry`]: BAG.alpha }]))
  state.disabledProviders = BAG
  const parsed = plain(Config(state))
  assert.deepEqual(parsed.disabledProviders, BAG, `${label}: disabledProviders did not round-trip`)
  for (const key of WRITTEN_KEYS) {
    assert.ok(parsed[key] !== undefined, `${label}: field "${key}" came back undefined`)
  }

  // 4. An unwritten section reads as empty bags, not undefined.
  for (const key of WRITTEN_KEYS) {
    assert.deepEqual(plain(Config({}))[key], {}, `${label}: unwritten "${key}" should read as {}`)
  }
}

// --- the version this repo and the 0.1 web profile resolve -------------------
await check(`schemastery ${zRepo.version ?? '3.18.1'} (repo / web profile) round-trips the bag`, () => {
  assertRoundTrips('3.18.1', zRepo)
})

// --- the version the desktop app bundles ------------------------------------
const desktopRoot = path.join(
  homedir(),
  '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery',
)
const desktopEntry = path.join(desktopRoot, 'lib/index.mjs')

if (existsSync(desktopEntry)) {
  const zDesktop = (await import(pathToFileURL(desktopEntry).href)).default
  await check('schemastery 3.18.4 (desktop app) round-trips the bag', () => {
    assertRoundTrips('3.18.4', zDesktop)
  })
} else {
  results.push({ label: 'schemastery 3.18.4 (desktop app) — SKIPPED, not installed here', ok: true, skipped: true })
  console.log(`  note: ${desktopEntry} not found; desktop-version check skipped`)
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
    ? `PASS: settings schema survives both schemastery versions — ${results.length}/${results.length} green`
    : `FAIL: settings schema — ${failed}/${results.length} failed`,
)
process.exit(failed === 0 ? 0 : 1)
