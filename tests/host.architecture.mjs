/**
 * tests/host.architecture.mjs — the compatibility layer's boundary is enforced,
 * not merely documented.
 *
 * `src/host/compat.ts` states four rules; RULE 2 is "one write path per
 * namespace". A rule nobody can violate silently is worth more than a comment,
 * so this test fails if any module OTHER than the compat layer reaches into the
 * settings service directly.
 *
 * If this fails, do not add an exception: route the call through
 * `compat.readSection` / `writeLLMProviders` / `writeOwnedSection`. That is the
 * whole point — a new DSH shape must be absorbed in one file.
 *
 * Run: node scripts/run-node-test.mjs tests/host.architecture.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST_SRC = path.join(__dirname, '..', 'src', 'host')

/** The one module allowed to touch the settings service's own methods. */
const COMPAT_LAYER = 'compat.ts'

function hostSources(dir = HOST_SRC) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return hostSources(full)
    return name.endsWith('.ts') ? [full] : []
  })
}

/**
 * A settings-SERVICE call must be recognised on a value the compiler already
 * knows IS the settings service. Two bindings qualify, and together they cover
 * every shape in this codebase:
 *
 *   • `const st = ctx.get('settings')`                  — a resolved lookup
 *   • `function f(st: SettingsLike)` / `=== 'raw'` etc. — a typed parameter
 *
 * Requiring the annotation keeps the guard from flagging identically-named
 * unrelated locals (Maps, arrays), which would make it noisy and then ignored.
 */
const RESOLVED = /(?:const|let)\s+(\w+)\s*=\s*(?:ctx|c|hostCtx|ownerContext)\.get\(['"]settings['"]\)/
const TYPED = /(\w+)\s*:\s*(?:SettingsLike|SettingsService|SettingsArm)\b/
const SERVICE_CALL = (name) =>
  new RegExp(`\\b${name}\\s*\\??\\.\\s*(get|replace|describe|mutate|update)\\s*\\(`)

const violations = []
const compatCalls = []

for (const file of hostSources()) {
  const rel = path.relative(HOST_SRC, file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  // Which locals/params in this file hold the settings service?
  const bindings = new Set()
  for (const line of lines) {
    const r = RESOLVED.exec(line)
    if (r) bindings.add(r[1])
    for (const t of line.matchAll(new RegExp(TYPED, 'g'))) bindings.add(t[1])
  }
  if (bindings.size === 0) continue

  for (const [i, line] of lines.entries()) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
    for (const binding of bindings) {
      if (!SERVICE_CALL(binding).test(line)) continue
      const record = `${rel}:${i + 1}  ${line.trim()}`
      if (rel === COMPAT_LAYER) compatCalls.push(record)
      else violations.push(record)
    }
  }
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

check('only compat.ts calls the settings service directly', () => {
  assert.deepEqual(
    violations,
    [],
    `settings service reached outside ${COMPAT_LAYER} (route these through the compat layer):\n  ` +
      violations.join('\n  '),
  )
})

check('the compat layer is actually the one doing it (guard is not vacuous)', () => {
  assert.ok(
    compatCalls.length >= 4,
    `expected compat.ts to contain the service calls, found ${compatCalls.length}`,
  )
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
  console.log(`  compat.ts service calls: ${compatCalls.length}`)
  console.log(`PASS: compatibility boundary — ${results.length}/${results.length} green`)
} else {
  console.log(`FAIL: compatibility boundary — ${failed}/${results.length} failed`)
}
process.exit(failed === 0 ? 0 : 1)
