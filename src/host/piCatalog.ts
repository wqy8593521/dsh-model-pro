/** The INSTALLED pi-ai model catalog, read straight off disk.
 *
 * Why this exists. `reasoningEfforts` is the only thing that gives a
 * hand-declared model a thinking control, and until now the only way to fill it
 * was by hand or from models.dev over the network. But the answer is already on
 * this machine: pi-ai ships a catalog of ~1200 models, ~860 of them with a
 * `thinkingLevelMap`, and `@deepseek-ai/dsh-llm-pi-ai` consults it for every
 * model whose `reasoningEfforts` is absent — keyed by the PROVIDER ROUTE NAME
 * (`catalogModels(provider)`). That last detail is the whole problem: a custom
 * gateway route (`justwoker`, `vyceai`, …) has no installed catalog, so
 * `resolveModelReasoning` falls through to `reasoning: false` and every model on
 * it becomes non-reasoning — even when the SAME model id under its first-party
 * provider declares six levels. This module reads the catalog by MODEL ID
 * instead of by route, which is what makes those declarations reusable.
 *
 * It only ever SUGGESTS. The catalog describes the model as its first-party
 * provider serves it; a gateway may expose less, spell a parameter differently,
 * or ignore it. So the result is a prefill for the editor, never an automatic
 * write, and the evidence (which provider, which protocol) travels with it.
 *
 * Availability is best-effort by construction. Node builtins are imported
 * dynamically inside a try/catch because a Host half may be evaluated in a
 * sandbox that withholds them (`dsh-cordis-host-runner` traps `require` and
 * evaluates without a dynamic-import loader); there, this module reports
 * "unavailable" and every caller degrades to manual entry rather than failing.
 */

import { THINKING_LEVELS } from '../shared/constants'
import type { ThinkingLevel } from '../shared/constants'
import type { ReasoningEfforts } from '../shared/types'

/** One model id's declaration as some installed provider describes it. */
export interface PiCatalogEntry {
  /** The pi-ai provider whose catalog carries this declaration. */
  provider: string
  /** The wire protocol that provider speaks for this model. */
  api: string
  /** Levels the model supports, in ascending order. */
  levels: ThinkingLevel[]
  /** pi-ai's raw map, kept so a caller can re-derive with another protocol. */
  map: Record<string, string | null | undefined>
}

/** Where the catalog was found, or why it was not. */
export interface PiCatalogStatus {
  ok: boolean
  /** The data directory, when located. */
  dir?: string
  /** Model ids indexed (only those declaring reasoning). */
  models?: number
  /** Why the lookup is unavailable, when it is. */
  error?: string
}

/** Relative location of the catalog data inside any pi-ai install. */
const REL = ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data']

/** Node builtins this module needs, resolved once, or `undefined` in a sandbox
 * that withholds them. */
interface NodeBits {
  fs: {
    existsSync(p: string): boolean
    readdirSync(p: string): string[]
    readFileSync(p: string, enc: string): string
    realpathSync(p: string): string
  }
  path: { join(...parts: string[]): string; dirname(p: string): string }
  /** The DSH home (`DSH_HOME`, else `~/.dsh`) — NOT the user home; the two are
   * different roots and joining `.dsh` onto DSH_HOME would double it. */
  dshHome?: string
  argv1?: string
}

let bits: NodeBits | null | undefined
/** The in-flight or completed index build, so concurrent callers share one read. */
let pending: Promise<Map<string, PiCatalogEntry[]>> | undefined
let status: PiCatalogStatus | undefined

/** Load the node builtins once. `null` means this environment has none. */
async function nodeBits(): Promise<NodeBits | null> {
  if (bits !== undefined) return bits
  try {
    const fs = (await import('node:fs')) as any
    const path = (await import('node:path')) as any
    const proc = (globalThis as any).process
    const env = proc?.env || {}
    const dshHome =
      typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()
        ? env.DSH_HOME
        : typeof env.HOME === 'string' && env.HOME
          ? path.join(env.HOME, '.dsh')
          : undefined
    bits = {
      fs: {
        existsSync: fs.existsSync,
        readdirSync: fs.readdirSync,
        readFileSync: fs.readFileSync,
        realpathSync: fs.realpathSync,
      },
      path: { join: path.join, dirname: path.dirname },
      ...(dshHome ? { dshHome } : {}),
      ...(typeof proc?.argv?.[1] === 'string' ? { argv1: proc.argv[1] } : {}),
    }
  } catch {
    bits = null
  }
  return bits
}

/** Walk up from `dir` looking for pi-ai's catalog data directory. */
function walkUp(n: NodeBits, dir: string): string | undefined {
  let cur = dir
  for (let i = 0; i < 12; i += 1) {
    const cand = n.path.join(cur, ...REL)
    try {
      if (n.fs.existsSync(cand)) return cand
    } catch { /* unreadable ancestor — keep walking */ }
    const up = n.path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return undefined
}

/**
 * Locate the catalog data directory.
 *
 * Two anchors, tried in order, because neither holds in every layout:
 *
 *   1. `<DSH_HOME>/profiles` — where an installed profile keeps its own
 *      `node_modules`, which is where pi-ai lands for a profile-installed
 *      plugin. Independent of how the process was launched, and the anchor that
 *      resolves in a normal install.
 *   2. `process.argv[1]`, realpath'd so `~/.npm-global/bin/dsh` becomes the
 *      package's own `lib/bin.js` — inside the DSH INSTALL, whose `node_modules`
 *      also carries pi-ai. Covers a DSH_HOME with no profile-level copy.
 *
 * The module's own location is deliberately NOT an anchor. A plugin developed
 * from a checkout is loaded through a symlink Node resolves away, so it points
 * into the checkout where no pi-ai exists; and `import.meta` cannot be referenced
 * at all when the bundle is evaluated as a classic script, which is how the host
 * smoke test loads it.
 *
 * The catalog belongs to the DSH INSTALLATION that is running, not to this
 * plugin — hence both anchors are install-shaped.
 */
function locate(n: NodeBits): string | undefined {
  const anchors: string[] = []
  if (n.dshHome) anchors.push(n.path.join(n.dshHome, 'profiles'))
  if (n.argv1) {
    try { anchors.push(n.path.dirname(n.fs.realpathSync(n.argv1))) } catch { anchors.push(n.path.dirname(n.argv1)) }
  }
  for (const anchor of anchors) {
    const hit = walkUp(n, anchor)
    if (hit) return hit
  }
  return undefined
}

/**
 * Build the model-id -> declarations index.
 *
 * Shape of each data file is `{ [api]: { [modelId]: entry } }` — a dict of
 * dicts, not the `{ models: [...] }` a listing endpoint would return. Only
 * entries with `reasoning: true` are indexed; a non-reasoning entry carries no
 * information this plugin can act on.
 *
 * Memoized as a PROMISE so the panel's per-model calls (and the bulk fill, which
 * asks about every model at once) read the ~38 files once instead of once per
 * question. A FAILED load is not memoized: the reason is transient in principle
 * (an unreadable directory, a pi-ai installed after the plugin loaded), and
 * caching it would make the button permanently dead until a restart.
 */
async function loadIndex(): Promise<Map<string, PiCatalogEntry[]>> {
  if (pending === undefined) {
    pending = buildIndex().catch((e) => {
      status = { ok: false, error: `读取本地目录失败：${String((e as Error)?.message || e)}` }
      pending = undefined
      return new Map<string, PiCatalogEntry[]>()
    })
  }
  const built = await pending
  if (status && !status.ok) pending = undefined
  return built
}

async function buildIndex(): Promise<Map<string, PiCatalogEntry[]>> {
  const index = new Map<string, PiCatalogEntry[]>()
  const n = await nodeBits()
  if (!n) {
    status = { ok: false, error: '当前运行环境不提供文件读取能力，无法读取本地 pi-ai 目录' }
    return index
  }
  const dir = locate(n)
  if (!dir) {
    status = { ok: false, error: '未找到已安装的 pi-ai 模型目录（@earendil-works/pi-ai）' }
    return index
  }
  let files: string[]
  try {
    files = n.fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch (e) {
    status = { ok: false, error: `读取目录失败：${String((e as Error)?.message || e)}` }
    return index
  }
  for (const file of files) {
    let doc: Record<string, Record<string, any>>
    try {
      doc = JSON.parse(n.fs.readFileSync(n.path.join(dir, file), 'utf8'))
    } catch { continue }
    if (!doc || typeof doc !== 'object') continue
    for (const api of Object.keys(doc)) {
      const models = doc[api]
      if (!models || typeof models !== 'object') continue
      for (const id of Object.keys(models)) {
        const m = models[id]
        if (!m || typeof m !== 'object' || m.reasoning !== true) continue
        const map = (m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object' ? m.thinkingLevelMap : {}) as Record<string, string | null>
        const entry: PiCatalogEntry = {
          provider: typeof m.provider === 'string' ? m.provider : file.replace(/\.json$/, ''),
          api: typeof m.api === 'string' ? m.api : api,
          levels: levelsFromMap(map),
          map,
        }
        const list = index.get(id)
        if (list) list.push(entry)
        else index.set(id, [entry])
      }
    }
  }
  status = { ok: true, dir, models: index.size }
  return index
}

/**
 * The levels one pi-ai map declares, applying pi-ai's own asymmetric rule
 * (`getSupportedThinkingLevels`): an explicit `null` means unsupported, an
 * ABSENT key means supported for the five base levels but unsupported for
 * `xhigh`/`max`. Mirrored rather than simplified — a divergence here would offer
 * levels the model rejects, or hide ones it takes.
 *
 * Exported for the contract test: this asymmetry is the single rule most likely
 * to drift when pi-ai is upgraded, and it is invisible in the JSON.
 */
export function levelsFromMap(map: Record<string, string | null | undefined>): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * The wire value to declare for one supported level, given the protocol of the
 * route that will RECEIVE the request.
 *
 * Two cases, because a borrowed declaration is only a verbatim copy when nothing
 * is being translated:
 *
 *   - SAME protocol as the source. Reproduce exactly what pi-ai would have sent:
 *     the declared string when there is one, else the fallback that protocol
 *     applies to an absent key. That fallback is not uniform —
 *     `anthropic-messages` and `bedrock-converse-stream` run an absent level
 *     through their own effort table (`mapThinkingLevelToEffort`: `minimal` and
 *     `low` both become `low`, anything unrecognized becomes `high`), while the
 *     OpenAI-shaped protocols send the level name itself (`mapped ?? level`).
 *     Reproducing it matters because this plugin's `reasoningEfforts` dict pins
 *     every undeclared level to `null`, so an absent key cannot be re-expressed —
 *     each level has to carry its string or the request would change.
 *   - DIFFERENT protocol (the usual case: borrowing an Anthropic declaration for
 *     an OpenAI-compatible gateway). A vendor-specific spelling is not
 *     transferable — `LOW`, `default` and a token budget mean nothing to another
 *     protocol — so the neutral LEVEL NAME is used, which is what the receiving
 *     side's own fallback would have produced.
 *
 * `off` is special either way: it carries `null`, which llm-pi-ai turns back into
 * an absent key, i.e. "supported, send nothing" — what not thinking IS on the
 * wire. The one exception is a same-protocol source that declares an explicit
 * spelling for it (OpenAI's `off: "none"`), which is copied so the borrow stays
 * faithful.
 */
function wireFor(level: ThinkingLevel, entry: PiCatalogEntry, api: string): string | null {  const declared = entry.map[level]
  const samePr = entry.api === api
  if (level === 'off') return samePr && typeof declared === 'string' ? declared : null
  if (!samePr) return level
  if (typeof declared === 'string') return declared
  if (api === 'anthropic-messages' || api === 'bedrock-converse-stream') {
    return level === 'minimal' || level === 'low' ? 'low' : level === 'medium' ? 'medium' : 'high'
  }
  return level
}

/** Turn one catalog declaration into a `reasoningEfforts` dict for `api`. */
export function effortsFrom(entry: PiCatalogEntry, api: string): ReasoningEfforts {
  const out: ReasoningEfforts = {}
  for (const level of entry.levels) out[level] = wireFor(level, entry, api)
  return out
}

/** One suggestion: a set of levels, the providers declaring exactly it, and the
 * ready-to-save dict for the asking route's protocol. */
export interface PiSuggestion {
  levels: ThinkingLevel[]
  efforts: ReasoningEfforts
  /** `provider (api)` pairs backing this candidate, for display. */
  sources: string[]
  /** Whether at least one source speaks the SAME protocol as the asking route,
   * i.e. its wire values were reproduced rather than translated. */
  samePro: boolean
}

/**
 * Candidate declarations for one model id, grouped by the levels they offer.
 *
 * Grouping matters because the same id genuinely differs between deployments:
 * of 559 reasoning ids in the installed catalog, 502 agree everywhere, 24 differ
 * only across protocols, and 33 differ even within one protocol. A single
 * "answer" would be a guess, so identical declarations are merged and the rest
 * are returned in descending order of support for the caller to choose from.
 *
 * The id is matched exactly first, then — only if nothing matched — by the tail
 * after the last `/`. Gateways routinely prefix a vendor onto the same model
 * (`some-gw/claude-opus-5`), and 590 of the catalog's own 1234 ids are prefixed
 * that way, so a strict-only match would miss the common case. The loose tier is
 * a fallback rather than a merge because a prefix occasionally distinguishes real
 * deployments; when it fires, the source list still names where each declaration
 * came from.
 *
 * `api` is the protocol of the route being edited, not of the source entry: the
 * gateway is what receives the parameter, so its shape decides the wire value.
 */
export async function suggestFor(id: string, api: string): Promise<PiSuggestion[]> {
  const idx = await loadIndex()
  const tail = id.split('/').pop() || id
  const entries = idx.get(id) || (tail !== id ? idx.get(tail) : undefined) || []
  const groups = new Map<string, PiSuggestion>()
  for (const entry of entries) {
    if (!entry.levels.length) continue
    const efforts = effortsFrom(entry, api)
    const key = JSON.stringify(efforts)
    const source = `${entry.provider} (${entry.api})`
    const hit = groups.get(key)
    if (hit) {
      if (!hit.sources.includes(source)) hit.sources.push(source)
      // A same-protocol source is stronger evidence than a translated one, so
      // record it even when the resulting dict happens to coincide.
      if (entry.api === api) hit.samePro = true
    } else {
      groups.set(key, { levels: entry.levels, efforts, sources: [source], samePro: entry.api === api })
    }
  }
  // Same-protocol candidates first (their wire values are reproduced rather than
  // translated), then by how many providers agree. A borrowed declaration is a
  // guess either way, but a guess that did not have to cross protocols is the
  // better default for the pre-checked row.
  return [...groups.values()].sort(
    (a, b) => Number(b.samePro) - Number(a.samePro) || b.sources.length - a.sources.length,
  )
}

/** Where the catalog was found, or why it is unavailable. */
export async function catalogStatus(): Promise<PiCatalogStatus> {
  await loadIndex()
  return status || { ok: false, error: '未知状态' }
}

/** Drop the cached index (tests, and a pi-ai upgrade within one process). */
export function clearPiCatalogCache(): void {
  pending = undefined
  status = undefined
  bits = undefined
}
