/**
 * Local pi-ai catalog contract test.
 *
 * The host smoke test can only prove the DEGRADED path: it evaluates the bundle
 * as a classic script, where `await import('node:fs')` fails, so the suggestion
 * always reports "unavailable" there. This file covers the other half — the
 * rules that decide what a borrowed declaration turns into — by building
 * `src/host/piCatalog.ts` as a real ESM module and running it against whatever
 * pi-ai is installed on this machine.
 *
 * Two things are asserted, and both exist because they are invisible in the JSON:
 *
 *   1. pi-ai's ASYMMETRIC support rule. An absent `thinkingLevelMap` key means
 *      "supported" for the five base levels and "unsupported" for `xhigh`/`max`
 *      (`getSupportedThinkingLevels` in pi-ai's models.js). Getting this backwards
 *      would either offer levels the model rejects or hide ones it takes, and
 *      nothing else in the pipeline would notice.
 *   2. The same/cross-protocol split for wire values. Same protocol reproduces
 *      what pi-ai would have sent (including the Anthropic effort table, where
 *      `minimal` collapses to `low`); a different protocol falls back to the
 *      neutral level name, because a vendor spelling like `LOW` or `default` means
 *      nothing to another API shape.
 *
 * When pi-ai is not installed the file reports SKIP and exits 0: it is a contract
 * test for this plugin's logic, not a check that the machine has a catalog.
 *
 * Run: `node tests/picatalog.mjs`
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
}

const outfile = path.join(os.tmpdir(), `mpro-picatalog-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(ROOT, 'src', 'host', 'piCatalog.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['@deepseek-ai/*', 'cordis'],
  logLevel: 'error',
})

try {
  const mod = await import(`file://${outfile}`)
  const { levelsFromMap, effortsFrom, suggestFor, catalogStatus } = mod

  // --- rule 1: the asymmetric support rule, on synthetic maps ---------------
  assert(
    JSON.stringify(levelsFromMap({})) === JSON.stringify(['off', 'minimal', 'low', 'medium', 'high']),
    'an empty map supports the five base levels but NOT xhigh/max: ' + JSON.stringify(levelsFromMap({})),
  )
  assert(
    JSON.stringify(levelsFromMap({ xhigh: 'xhigh', max: 'max' })) ===
      JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    'declaring xhigh/max opts them in (this is the real claude-opus-5 shape): ' +
      JSON.stringify(levelsFromMap({ xhigh: 'xhigh', max: 'max' })),
  )
  assert(
    JSON.stringify(levelsFromMap({ minimal: null, off: null })) === JSON.stringify(['low', 'medium', 'high']),
    'an explicit null removes a level: ' + JSON.stringify(levelsFromMap({ minimal: null, off: null })),
  )

  // --- rule 2: wire values, same protocol vs across protocols ---------------
  // The real anthropic claude-opus-5 entry: only xhigh/max are spelled out, and
  // pi-ai's own effort table fills the rest.
  const anthropicOpus = {
    provider: 'anthropic',
    api: 'anthropic-messages',
    map: { xhigh: 'xhigh', max: 'max' },
    levels: levelsFromMap({ xhigh: 'xhigh', max: 'max' }),
  }
  const same = effortsFrom(anthropicOpus, 'anthropic-messages')
  assert(same.off === null, 'off always carries null unless the source spells it out: ' + JSON.stringify(same.off))
  assert(
    same.minimal === 'low' && same.low === 'low' && same.medium === 'medium' && same.high === 'high',
    "same protocol reproduces Anthropic's effort table (minimal collapses to low): " + JSON.stringify(same),
  )
  assert(same.xhigh === 'xhigh' && same.max === 'max', 'declared values are copied verbatim: ' + JSON.stringify(same))

  const cross = effortsFrom(anthropicOpus, 'openai-completions')
  assert(
    cross.minimal === 'minimal' && cross.low === 'low' && cross.high === 'high',
    'across protocols the neutral LEVEL NAME is used, not the source vendor spelling: ' + JSON.stringify(cross),
  )
  assert(cross.off === null, 'off stays null across protocols: ' + JSON.stringify(cross.off))

  // A vendor spelling must never leak into another protocol.
  const vertex = {
    provider: 'google-vertex',
    api: 'google-vertex',
    map: { low: 'LOW', high: 'HIGH' },
    levels: levelsFromMap({ low: 'LOW', high: 'HIGH' }),
  }
  assert(effortsFrom(vertex, 'google-vertex').low === 'LOW', 'same protocol keeps the vendor spelling')
  assert(
    effortsFrom(vertex, 'openai-completions').low === 'low',
    'a vendor spelling is NOT carried across protocols: ' + JSON.stringify(effortsFrom(vertex, 'openai-completions')),
  )

  // --- against the installed catalog, when there is one ---------------------
  const status = await catalogStatus()
  if (!status.ok) {
    console.log(`SKIP: no installed pi-ai catalog (${status.error}) — rule assertions above still ran`)
  } else {
    assert(status.models > 0 && fs.existsSync(status.dir), 'the located catalog directory exists: ' + status.dir)

    // Every suggestion must be a value `normalizeReasoningEfforts` accepts:
    // at least one level beyond `off`, no empty strings, null only on `off`.
    // A violation here would fail llm-pi-ai's config schema for the WHOLE
    // provider section, taking every model of that provider offline.
    let checked = 0
    for (const id of ['claude-opus-5', 'claude-sonnet-4-6', 'gpt-5.6-luna', 'deepseek-v4-pro']) {
      for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
        for (const cand of await suggestFor(id, api)) {
          checked += 1
          const levels = Object.keys(cand.efforts)
          assert(levels.length > 0, `${id}@${api}: a candidate declares at least one level`)
          assert(levels.some((l) => l !== 'off'), `${id}@${api}: a candidate offers something beyond off`)
          for (const [level, wire] of Object.entries(cand.efforts)) {
            if (wire === null) assert(level === 'off', `${id}@${api}: only off may be null, got ${level}`)
            else assert(typeof wire === 'string' && wire.length > 0, `${id}@${api}: ${level} has a non-empty wire value`)
          }
          assert(cand.sources.length > 0, `${id}@${api}: every candidate names its evidence`)
        }
      }
    }
    assert(checked > 0, 'at least one known reasoning model was found in the installed catalog')

    // The same-protocol-first ordering is what the bulk panel pre-selects, so a
    // regression would silently change the default write.
    const luna = await suggestFor('gpt-5.6-luna', 'openai-responses')
    if (luna.length > 1) {
      const firstFalse = luna.findIndex((c) => !c.samePro)
      const lastTrue = luna.reduce((acc, c, i) => (c.samePro ? i : acc), -1)
      assert(firstFalse === -1 || lastTrue < firstFalse, 'same-protocol candidates sort before translated ones')
    }

    // A gateway-prefixed id must still find its declaration: 590 of the
    // catalog's own ids are vendor-prefixed, and a gateway typically re-exports
    // the same model under its own prefix. Exact match wins; the tail is only a
    // fallback.
    const prefixed = await suggestFor('some-gateway/claude-opus-5', 'openai-completions')
    const plain = await suggestFor('claude-opus-5', 'openai-completions')
    if (plain.length > 0) {
      assert(prefixed.length > 0, 'a vendor-prefixed id falls back to its tail: some-gateway/claude-opus-5')
      assert(
        JSON.stringify(prefixed[0].efforts) === JSON.stringify(plain[0].efforts),
        'the fallback yields the same declaration as the bare id: ' + JSON.stringify(prefixed[0].efforts),
      )
    }
    assert((await suggestFor('totally-made-up-model-xyz', 'openai-completions')).length === 0, 'an unknown id yields no candidates rather than a wrong one')

    console.log(`ok: ${status.models} reasoning ids indexed from ${status.dir}; ${checked} candidates validated`)
  }

  console.log('PASS: local pi-ai catalog contract — all assertions green')
} finally {
  try { fs.unlinkSync(outfile) } catch { /* best effort */ }
}
