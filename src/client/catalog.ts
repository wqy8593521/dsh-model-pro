/** models.dev catalog lookup — the optional prefill source for reasoning levels.
 *
 * Runs in the CLIENT, not the host: the Host sandbox withholds the Web globals a
 * bounded HTTP request needs (`AbortController`; see `host/handlers/test.ts`),
 * while the catalog is a plain public GET serving
 * `access-control-allow-origin: *` that the browser reads directly. Routing
 * ~4 MB through the RPC boundary would buy nothing.
 *
 * What the catalog can and cannot answer, since the UI's shape follows from it:
 *
 *   - It lists which EFFORT LEVELS a model offers. That is genuinely useful:
 *     the levels cannot be probed (pi-ai spells reasoning nine different ways
 *     per protocol, gateways silently ignore unknown parameters, and `off` is
 *     byte-identical to "unsupported" on the wire) and no listing endpoint
 *     reports them.
 *   - It does NOT give the wire spelling each level must send. `values` are
 *     level NAMES; llm-pi-ai needs the string dispatch puts on the wire. They
 *     usually coincide, which is why the names are offered as defaults — and why
 *     the result must stay editable rather than being written straight through.
 *   - Its providers DISAGREE about the same model id. `deepseek-v4-flash` has 18
 *     distinct declarations across 50 providers. Sub-deployments really do
 *     differ, so there is no single truth to pick; the UI shows the split
 *     instead of guessing.
 */

import { THINKING_LEVELS } from '../shared/constants'
import type { ThinkingLevel } from '../shared/constants'

/** One model's reasoning declaration, reduced to what this plugin can consume. */
export interface CatalogEntry {
  /** models.dev provider id this declaration came from. */
  provider: string
  /** Effort levels, canonical order, `none` already mapped to `off`. */
  levels: ThinkingLevel[]
  /** Control types the source declared, for reporting what was dropped. */
  kinds: string[]
}

/** Candidate declarations for one model id, ranked with their evidence. */
export interface CatalogMatch {
  /** How this candidate was found. */
  tier: 'exact' | 'byId'
  /** Effort levels offered. */
  levels: ThinkingLevel[]
  /** Providers declaring exactly these levels. */
  providers: string[]
  /** How many providers agree (== providers.length; kept explicit for display). */
  votes: number
  /** Total providers declaring effort levels for this model id. */
  total: number
}

/** The reduced index kept in memory (and mirrored to sessionStorage). */
interface CatalogIndex {
  /** `provider\0modelId` -> entry, for the exact-match tier. */
  exact: Record<string, CatalogEntry>
  /** bare model id -> every entry declaring it, for the fallback tier. */
  byId: Record<string, CatalogEntry[]>
  /** When this index was built (ms epoch). */
  builtAt: number
  /** The URL it was built from, so a URL change invalidates it. */
  url: string
}

const SESSION_KEY = 'mpro.catalog.v1'
/** Bound the cached index's life so a corrected upstream declaration is picked
 * up without asking the user to clear anything; a day is far longer than a
 * setup session and far shorter than the data's churn. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

let memoryIndex: CatalogIndex | undefined

/** Map models.dev's level vocabulary onto pi-ai's.
 *
 * Only `none` -> `off` differs. Unknown words (the payload carries a couple of
 * `default` and null strays) are dropped rather than guessed at: a level pi-ai
 * does not know cannot be written to `reasoningEfforts` anyway. */
function toThinkingLevel(raw: unknown): ThinkingLevel | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw === 'none' ? 'off' : raw
  return (THINKING_LEVELS as readonly string[]).includes(name) ? (name as ThinkingLevel) : undefined
}

/** Reduce one model's `reasoning_options` to effort levels plus the kinds seen.
 *
 * `toggle` (on/off only) and `budget_tokens` (a numeric range) cannot be
 * expressed as `thinkingLevelMap` entries, so their levels are not invented —
 * but the kind is reported so the UI can say why a reasoning model produced no
 * levels, instead of looking broken. */
function reduceOptions(raw: unknown): { levels: ThinkingLevel[]; kinds: string[] } {
  const kinds: string[] = []
  const found = new Set<ThinkingLevel>()
  if (Array.isArray(raw)) {
    for (const opt of raw) {
      if (!opt || typeof opt !== 'object') continue
      const o = opt as Record<string, unknown>
      if (typeof o.type === 'string' && !kinds.includes(o.type)) kinds.push(o.type)
      if (o.type !== 'effort' || !Array.isArray(o.values)) continue
      for (const v of o.values) {
        const level = toThinkingLevel(v)
        if (level) found.add(level)
      }
    }
  }
  return { levels: THINKING_LEVELS.filter((l) => found.has(l)), kinds }
}

/** Build the reduced index from a raw catalog document.
 *
 * Only models that declare SOMETHING about reasoning are indexed: the rest would
 * triple the index for no answer it could give. */
function buildIndex(doc: unknown, url: string): CatalogIndex {
  const exact: Record<string, CatalogEntry> = {}
  const byId: Record<string, CatalogEntry[]> = {}
  if (doc && typeof doc === 'object') {
    for (const [providerId, provider] of Object.entries(doc as Record<string, any>)) {
      const models = provider && typeof provider === 'object' ? provider.models : undefined
      if (!models || typeof models !== 'object') continue
      for (const [modelId, model] of Object.entries(models as Record<string, any>)) {
        if (!model || typeof model !== 'object') continue
        if (!model.reasoning && !model.reasoning_options) continue
        const { levels, kinds } = reduceOptions(model.reasoning_options)
        if (!levels.length && !kinds.length) continue
        const entry: CatalogEntry = { provider: providerId, levels, kinds }
        exact[`${providerId}\u0000${modelId}`] = entry
        // Catalog ids are sometimes namespaced (`deepseek/deepseek-v4-flash`);
        // the bare tail is what a gateway's own model list uses.
        const bare = modelId.split('/').pop() as string
        ;(byId[bare] || (byId[bare] = [])).push(entry)
        if (bare !== modelId) (byId[modelId] || (byId[modelId] = [])).push(entry)
      }
    }
  }
  return { exact, byId, builtAt: Date.now(), url }
}

function loadSession(url: string): CatalogIndex | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CatalogIndex
    if (!parsed || parsed.url !== url) return undefined
    if (!parsed.builtAt || Date.now() - parsed.builtAt > MAX_AGE_MS) return undefined
    if (!parsed.exact || !parsed.byId) return undefined
    return parsed
  } catch {
    // Quota, disabled storage, or a shape change — the fetch path still works.
    return undefined
  }
}

function saveSession(index: CatalogIndex): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(index))
  } catch { /* over quota or storage disabled: memory cache still applies */ }
}

/** Fetch and index the catalog, reusing a cached index when one is valid.
 *
 * `force` skips both caches, for an explicit refresh. */
export async function loadCatalog(url: string, force = false): Promise<CatalogIndex> {
  // Guard the empty/relative case explicitly. `fetch('')` resolves against the
  // GUI's own origin, so a missing URL would silently request this page and fail
  // as a JSON parse error — a misleading symptom for a configuration problem.
  if (!/^https?:\/\/[^/?#]+/i.test(url)) throw new Error('目录地址无效（需要 http(s) 绝对地址）')
  if (!force) {
    if (memoryIndex && memoryIndex.url === url && Date.now() - memoryIndex.builtAt <= MAX_AGE_MS) return memoryIndex
    const cached = loadSession(url)
    if (cached) { memoryIndex = cached; return cached }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const doc = await res.json()
    const index = buildIndex(doc, url)
    if (!Object.keys(index.exact).length) throw new Error('目录中没有任何推理声明，可能不是 models.dev 格式')
    memoryIndex = index
    saveSession(index)
    return index
  } finally {
    clearTimeout(timer)
  }
}

const levelKey = (levels: ThinkingLevel[]) => levels.join(',')

/**
 * Candidate declarations for one provider/model pair, best first.
 *
 * Tier order is the honest one:
 *   1. `exact` — this very provider declares this very model. Most trustworthy,
 *      because sub-deployment differences are exactly what disagreement is about.
 *   2. `byId`  — other providers declaring the same model id, GROUPED by the
 *      levels they claim and sorted by how many agree.
 *
 * The groups are returned rather than reduced to a winner. An 81%-agreement
 * model and a 20%-agreement model would otherwise look identical at the call
 * site, and the second is a case where picking silently is guessing.
 */
export function matchModel(index: CatalogIndex, provider: string, modelId: string): CatalogMatch[] {
  const out: CatalogMatch[] = []
  const bare = modelId.split('/').pop() as string

  const exact = index.exact[`${provider}\u0000${modelId}`] || index.exact[`${provider}\u0000${bare}`]
  if (exact && exact.levels.length) {
    out.push({ tier: 'exact', levels: exact.levels, providers: [exact.provider], votes: 1, total: 1 })
  }

  const all = (index.byId[bare] || []).filter((e) => e.levels.length)
  if (all.length) {
    const groups = new Map<string, { levels: ThinkingLevel[]; providers: string[] }>()
    for (const entry of all) {
      const key = levelKey(entry.levels)
      const g = groups.get(key) || { levels: entry.levels, providers: [] }
      if (!g.providers.includes(entry.provider)) g.providers.push(entry.provider)
      groups.set(key, g)
    }
    const total = all.length
    const ranked = [...groups.values()].sort((a, b) => b.providers.length - a.providers.length)
    for (const g of ranked) {
      // Skip a byId group identical to the exact match: it is the same answer
      // with weaker evidence, and showing both invites picking the weaker one.
      if (exact && levelKey(exact.levels) === levelKey(g.levels)) continue
      out.push({ tier: 'byId', levels: g.levels, providers: g.providers, votes: g.providers.length, total })
    }
  }
  return out
}

/** Control kinds declared for a model that yielded no usable effort levels.
 *
 * Lets the UI explain "this model reasons, but through a toggle/budget control
 * that `reasoningEfforts` cannot express" instead of reporting nothing found. */
export function unusableKinds(index: CatalogIndex, provider: string, modelId: string): string[] {
  const bare = modelId.split('/').pop() as string
  const entries = [
    index.exact[`${provider}\u0000${modelId}`],
    index.exact[`${provider}\u0000${bare}`],
    ...(index.byId[bare] || []),
  ].filter(Boolean) as CatalogEntry[]
  const kinds: string[] = []
  for (const e of entries) {
    if (e.levels.length) continue
    for (const k of e.kinds) if (!kinds.includes(k)) kinds.push(k)
  }
  return kinds
}

/** Turn chosen levels into a `reasoningEfforts` dict.
 *
 * The wire value defaults to the level NAME, which is right for most `effort`
 * providers but is a guess — the panel keeps it editable. `off` maps to null,
 * meaning "supported, send nothing", which is what not thinking is on the wire.
 */
export function toEfforts(levels: ThinkingLevel[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const level of THINKING_LEVELS) {
    if (!levels.includes(level)) continue
    out[level] = level === 'off' ? null : level
  }
  return out
}
