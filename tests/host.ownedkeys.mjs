/**
 * tests/host.ownedkeys.mjs — every key the owned-state writers persist MUST be
 * declared in this plugin's settings schema.
 *
 * Why this is its own test, and why it scans the SOURCE:
 *
 * DSH 0.2 validates every settings write against the target entry's schema and
 * rejects any destination key that is not below a `volatile()` node:
 *
 *     Config field "modelCapabilities" is not volatile
 *
 * Because the plugin persists its state into its OWN section, a key missing from
 * `OWNED_STATE_KEYS` breaks the user-facing operation that writes it — creating a
 * provider, toggling one, saving a route, recording stats. That is not a
 * hypothetical: `modelCapabilities`, `routerRetry`, `localGateway` and
 * `modelCatalog` each shipped undeclared and failed in production one at a time.
 *
 * A key list duplicated by hand in the test would drift from the writers exactly
 * like the schema did, so this test recovers the keys from the call sites
 * themselves and fails on any key the schema does not declare. Add a writer with
 * a new key and this test goes red until the schema is updated.
 *
 * Run: node scripts/run-node-test.mjs tests/host.ownedkeys.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { OWNED_STATE_KEYS, buildConfig } from '../src/host/config.ts'
import { DISABLED_KEY } from '../src/host/settings.ts'
import zRepo from '@deepseek-ai/schemastery'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'src')
const HOST_SRC = path.join(SRC, 'host')

/** Every .ts under src (the key constants live in src/shared). */
function tsSources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return tsSources(full)
    return name.endsWith('.ts') ? [full] : []
  })
}

/**
 * Keys persisted through the owned-state writers, recovered from source.
 *
 * Two call shapes are recognised, so the test cannot drift from the writers:
 *
 *   writeRoutesRootKey(st, 'routeStats', snap)          ← literal key
 *   writeOwnedStateKey(st, CAPABILITIES_KEY, after)     ← key constant
 *   writeOwnedState(st, { [ROUTES_KEY]: routes })       ← object literal,
 *                                                          possibly multi-line
 *
 * Key constants are resolved against the `export const X_KEY = '<value>'`
 * declarations across the sources.
 */
function keysUsedByWriters() {
  // Constants are gathered from all of src (the `*_KEY` literals live in
  // src/shared/constants.ts); call sites only from src/host.
  const constantSources = tsSources(SRC)
  const sources = tsSources(HOST_SRC)
  const constants = new Map()
  const texts = new Map()
  for (const file of constantSources) {
    const text = readFileSync(file, 'utf8')
    for (const [, name, value] of text.matchAll(/export const (\w+)\s*=\s*'([^']+)'/g)) {
      constants.set(name, value)
    }
  }

  for (const file of sources) texts.set(file, readFileSync(file, 'utf8'))

  const used = new Set()
  const unresolved = []
  // The compat layer's self-check persists its own key (RULE 4) through a
  // dynamic key, so the call-site scan cannot see that write. Recover it from
  // the constant that names it — it is a real write, by the module that owns it.
  for (const [name, value] of constants) {
    if (name.endsWith('_KEY') && /probe/i.test(value)) used.add(value)
  }
  const note = (file, token) => {
    if (token.startsWith("'") || token.startsWith('"')) used.add(token.slice(1, -1))
    else if (constants.has(token)) used.add(constants.get(token))
    else unresolved.push(`${path.relative(SRC, file)}: ${token}`)
  }
  /**
   * Character ranges of the generic plumbing whose `key` is a PARAMETER rather
   * than a literal: `writeRoutesRootKey`, `writeOwnedStateKey` and
   * `writeOwnedState`. Skipping only these keeps the real call sites in the same
   * file (`writeRoutes` writes the literal `routes`) in scope.
   */
  const plumbingRanges = (text) => {
    const ranges = []
    for (const name of ['writeRoutesRootKey', 'writeOwnedStateKey', 'writeOwnedState']) {
      const decl = new RegExp(`(?:export (?:async )?function ${name}\\s*\\()`)
      const m = decl.exec(text)
      if (!m) continue
      let depth = 0
      let started = false
      for (let i = m.index; i < text.length; i++) {
        if (text[i] === '{') { depth++; started = true }
        else if (text[i] === '}' && --depth === 0 && started) { ranges.push([m.index, i]); break }
      }
    }
    return ranges
  }
  /** Collect `[...]` keys from the `{ … }` block starting at `from`. */
  const noteObjectLiteral = (file, text, from) => {
    const open = text.indexOf('{', from)
    if (open < 0) return
    let depth = 0
    let end = text.length
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) { end = i; break }
    }
    for (const [, token] of text.slice(open, end).matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:/g)) note(file, token)
  }

  for (const [file, text] of texts) {
    const ranges = plumbingRanges(text)
    const inPlumbing = (index) => ranges.some(([a, b]) => index >= a && index <= b)

    // Direct key argument: `writeXRootKey(<ctx>, KEY, …)`
    for (const m of text.matchAll(/\bwrite(?:RoutesRootKey|OwnedStateKey)\(/g)) {
      if (inPlumbing(m.index)) continue
      const rest = text.slice(m.index + m[0].length)
      const comma = rest.indexOf(',')
      if (comma < 0) continue
      const afterFirst = rest.slice(comma + 1)
      const arg = afterFirst.match(/^\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*,/)
      if (arg) note(file, arg[1])
      else unresolved.push(`${path.relative(SRC, file)}: unparsed key argument`)
    }
    // Object-literal patch: `writeOwnedState(<ctx>, { [KEY]: value })`
    for (const m of text.matchAll(/\bwriteOwnedState\(/g)) {
      if (inPlumbing(m.index)) continue
      const rest = text.slice(m.index + m[0].length)
      const comma = rest.indexOf(',')
      if (comma >= 0) noteObjectLiteral(file, text, m.index + m[0].length + comma)
    }
  }
  return { used, unresolved, constants }
}

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

const { used, unresolved } = keysUsedByWriters()

// The parked-provider bag is persisted by the settings adapter (`writeSections`)
// rather than through the generic helpers, so it is declared here explicitly —
// `DISABLED_KEY` is the single source of truth for that key.
used.add(DISABLED_KEY)

check('every owned-state key at a writer call site is resolvable', () => {
  assert.deepEqual(unresolved, [], `could not resolve key(s) from source: ${unresolved.join(', ')}`)
})

check('schema declares EXACTLY the keys the writers persist', () => {
  const declared = [...OWNED_STATE_KEYS].sort()
  const written = [...used].sort()
  const missing = written.filter((k) => !declared.includes(k))
  const extra = declared.filter((k) => !written.includes(k))
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `missing from OWNED_STATE_KEYS (0.2 will reject these writes): ${missing.join(', ') || 'none'}; ` +
      `declared but never written: ${extra.join(', ') || 'none'}`,
  )
})

check('the recovered writer keys are non-trivial (scan actually works)', () => {
  assert.ok(used.size >= 8, `scan found only ${used.size} keys — the source patterns probably changed`)
})

check('every declared field serializes as volatile', () => {
  const json = buildConfig(zRepo).toJSON()
  const root = json.refs[json.uid]
  for (const key of OWNED_STATE_KEYS) {
    const ref = json.refs[root.dict[key]]
    assert.ok(ref, `field "${key}" missing from the serialized schema`)
    assert.equal(ref.meta?.volatile, true, `field "${key}" is not volatile`)
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
if (failed === 0) {
  console.log(`  keys  : ${[...used].sort().join(', ')}`)
  console.log(`PASS: owned-state key coverage — ${results.length}/${results.length} green`)
} else {
  console.log(`FAIL: owned-state key coverage — ${failed}/${results.length} failed`)
}
process.exit(failed === 0 ? 0 : 1)
