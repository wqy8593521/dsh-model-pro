/**
 * i18n contract test.
 *
 * Three ways a translation breaks without anyone noticing, because the fallback
 * for a missing key is the KEY ITSELF — a button silently labelled `creating`
 * instead of 创建中… still renders, still passes a structural smoke test, and
 * only looks wrong to a human reading the page:
 *
 *   1. A `t('key')` with no dictionary entry.
 *   2. A key present in one language and not the other.
 *   3. A `{placeholder}` that differs between the two languages, or a `fmt()`
 *      callsite that does not supply the variables its template needs — either
 *      leaves a literal `{n}` on screen in one locale only.
 *
 * Run: `node tests/i18n.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'src', 'client')

const problems = []
const fail = (msg) => problems.push(msg)

/** Every .ts/.tsx file under src/client. */
function sources(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const i18nPath = path.join(CLIENT, 'i18n.ts')
const i18nText = fs.readFileSync(i18nPath, 'utf8')
const lines = i18nText.split('\n')

/**
 * Parse one dictionary into `key -> template`.
 *
 * Values may span several lines (long hints are wrapped), so a key is recorded
 * at its `  key:` line and everything up to the next key — or the closing
 * `} as const` — is its value. A regex keyed on `: '...'` would silently skip
 * every wrapped entry, which is exactly the blind spot that makes a naive audit
 * report false positives.
 */
function parseDict(startLine) {
  const dict = new Map()
  let key = null
  let buf = []
  const flush = () => { if (key !== null) dict.set(key, buf.join('\n')) }
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\} as const/.test(line)) { flush(); return { dict, end: i } }
    const m = /^  ([A-Za-z0-9_]+):(.*)$/.exec(line)
    if (m) { flush(); key = m[1]; buf = [m[2]] }
    else if (key !== null) buf.push(line)
  }
  flush()
  return { dict, end: lines.length }
}

const zhStart = lines.findIndex((l) => /^export const ZH/.test(l))
if (zhStart < 0) fail('i18n.ts: no `export const ZH`')
const zh = parseDict(zhStart + 1)
const enStart = lines.findIndex((l, i) => i > zh.end && /^export const EN/.test(l))
if (enStart < 0) fail('i18n.ts: no `export const EN`')
const en = parseDict(enStart + 1)

// --- 2. both languages carry the same keys, in the same order ---------------
// Order matters only as a review aid: a diff of the two blocks should line up,
// so a reviewer can see at a glance that a new key was added to both.
for (const k of zh.dict.keys()) if (!en.dict.has(k)) fail(`EN is missing key: ${k}`)
for (const k of en.dict.keys()) if (!zh.dict.has(k)) fail(`ZH is missing key: ${k}`)
const zhOrder = [...zh.dict.keys()]
const enOrder = [...en.dict.keys()]
if (zhOrder.length === enOrder.length) {
  const at = zhOrder.findIndex((k, i) => enOrder[i] !== k)
  if (at >= 0) fail(`key order diverges at #${at}: ZH ${zhOrder[at]} vs EN ${enOrder[at]}`)
}

// --- 3a. placeholders agree between the two languages -----------------------
const varsOf = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
for (const [k, zhVal] of zh.dict) {
  const enVal = en.dict.get(k)
  if (enVal === undefined) continue
  const a = [...varsOf(zhVal)].sort().join(',')
  const b = [...varsOf(enVal)].sort().join(',')
  if (a !== b) fail(`placeholders differ for ${k}: ZH {${a}} vs EN {${b}}`)
}

/**
 * Extract the TOP-LEVEL keys of the object literal starting at `open` (the index
 * of its `{`).
 *
 * Written as a scanner rather than a regex because real callsites nest: the
 * arguments contain calls, ternaries, template strings and quoted commas, and a
 * `\{([^{}]*)\}` match either stops early or treats `.join(', ')` as a key. Only
 * commas at depth 0 and outside a string separate properties.
 */
function topLevelKeys(src, open) {
  const keys = []
  let depth = 0
  let quote = null
  let start = open + 1
  const push = (end) => {
    const part = src.slice(start, end).trim()
    if (!part) return
    // `key: value` or the shorthand `key`; anything else (a spread) is ignored.
    const m = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part)
    if (m) keys.push(m[1])
  }
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i += 1; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue }
    if (c === '}' || c === ')' || c === ']') {
      depth -= 1
      if (depth === 0) { push(i); return { keys, end: i } }
      continue
    }
    if (c === ',' && depth === 1) { push(i); start = i + 1 }
  }
  return { keys, end: src.length }
}

// --- 1. every t('key') resolves --------------------------------------------
// `t` is also handed keys built at runtime (`t(\`routeStrategy${...}\`)`), which
// this cannot check statically; those callsites already fall back explicitly.
for (const file of sources(CLIENT)) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file)
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) {
    if (!zh.dict.has(m[1])) fail(`${rel}: t('${m[1]}') has no dictionary entry`)
  }
  // --- 3b. fmt() supplies exactly the variables the template declares -------
  for (const m of src.matchAll(/fmt\(t\('([A-Za-z0-9_]+)'\),\s*\{/g)) {
    const key = m[1]
    const tpl = zh.dict.get(key)
    if (tpl === undefined) continue
    const need = varsOf(tpl)
    const supplied = new Set(topLevelKeys(src, m.index + m[0].length - 1).keys)
    for (const v of need) if (!supplied.has(v)) fail(`${rel}: fmt(t('${key}')) does not supply {${v}}`)
    for (const v of supplied) if (!need.has(v)) fail(`${rel}: fmt(t('${key}')) supplies unused {${v}}`)
  }
}

if (problems.length) {
  for (const p of problems) console.error('  ' + p)
  console.error(`FAIL: i18n contract — ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`PASS: i18n contract — ${zh.dict.size} keys aligned across zh/en, placeholders and fmt() callsites consistent`)
