/** Stats + probe-health + bounded request-log store.
 *
 * Sandbox constraint: the dynamic Host half has NO node `fs`/`require`/`fetch`;
 * only settings + cordis services. So aggregation that must survive the session
 * lives in the `llm-pi-ai` settings section under ROUTE_STATS_KEY (a bounded,
 * small object — call counts, latency, tokens, probe health, and a capped tail
 * of the per-request log). `settings.replace` is not hammered per call: writes
 * are DEBOUNCED onto a timer (see index.ts) and on unload, so a burst of routed
 * calls costs at most one persisted write per interval. Persisting the log tail
 * (not just aggregates) is what lets the conversation route badge and the 观测台
 * survive a page refresh or a host restart — without it both go blank because
 * the in-memory ring/recorder start empty on every fresh fiber.
 */

import type { HostCtx } from './utils'
import { readRoutesRootKey, writeRoutesRootKey } from './utils'
import type { RouteStats, RequestLogEntry, TargetHealth, EffortTrace } from '../shared/types'

/** Bounded request-log ring capacity (in memory). Sized generously so a long
 * conversation — where a single agent turn can fire dozens of tool-loop LLM
 * calls — keeps enough recent turns' routing evidence for the badge to light
 * up when the user scrolls back. Memory cost is small (~150 bytes/entry). */
export const LOG_RING_CAPACITY = 2000

/** How many request-log entries are persisted to settings. Smaller than the
 * in-memory ring so the settings section stays bounded, while still covering
 * enough recent turns for the badge to light up after a reload. */
export const LOG_PERSIST_CAP = 400

/** Snapshot shape stored under llm-pi-ai[ROUTE_STATS_KEY]. */
export interface StatsSnapshot {
  /** Aggregate per-route-tuple `provider\u0000model` -> stats (also covers
   * composites addressed by their own route key). */
  byTarget: Record<string, RouteStats>
  /** Per-route-name -> stats. */
  byRoute: Record<string, RouteStats>
  /** Probe health per target. */
  health: Record<string, TargetHealth>
  /** Capped tail of the per-request log, so the badge/观测台 survive a reload. */
  logs?: RequestLogEntry[]
}

export function readStatsSnapshot(ctx: HostCtx): StatsSnapshot {
  const raw = readRoutesRootKey(ctx.get('settings'), 'routeStats')
  const s: StatsSnapshot = { byTarget: {}, byRoute: {}, health: {} }
  if (!raw || typeof raw !== 'object') return s
  const r = raw as Record<string, unknown>
  const byTargetRaw = r.byTarget as Record<string, unknown> | undefined
  if (byTargetRaw && typeof byTargetRaw === 'object') {
    for (const k of Object.keys(byTargetRaw)) {
      const v = byTargetRaw[k] as Record<string, unknown> | undefined
      if (v && typeof v === 'object') s.byTarget[k] = normalizeStats(v as Record<string, number>)
    }
  }
  const byRouteRaw = r.byRoute as Record<string, unknown> | undefined
  if (byRouteRaw && typeof byRouteRaw === 'object') {
    for (const k of Object.keys(byRouteRaw)) {
      const v = byRouteRaw[k] as Record<string, unknown> | undefined
      if (v && typeof v === 'object') s.byRoute[k] = normalizeStats(v as Record<string, number>)
    }
  }
  if (r.health && typeof r.health === 'object') s.health = r.health as Record<string, TargetHealth>
  if (Array.isArray(r.logs)) {
    const logs: RequestLogEntry[] = []
    for (const raw of r.logs as unknown[]) {
      const e = normalizeLogEntry(raw)
      if (e) logs.push(e)
    }
    if (logs.length) s.logs = logs.slice(-LOG_PERSIST_CAP)
  }
  return s
}

export async function writeStatsSnapshot(ctx: HostCtx, snap: StatsSnapshot): Promise<void> {
  await writeRoutesRootKey(ctx.get('settings'), 'routeStats', snap)
}

/** Validate/rebuild one persisted request-log entry (drops undefineds so the
 * host->client RPC boundary and settings persistence both stay JSON-clean). */
function normalizeLogEntry(raw: unknown): RequestLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const target = r.target as Record<string, unknown> | undefined
  if (typeof r.ts !== 'number' || !target || typeof target.provider !== 'string' || typeof target.model !== 'string') return null
  const status = r.status === 'ok' || r.status === 'error' || r.status === 'fallback' ? r.status : 'ok'
  const tokensRaw = r.tokens as Record<string, unknown> | undefined
  const tokens: { in?: number; out?: number } = {}
  if (tokensRaw && typeof tokensRaw === 'object') {
    if (typeof tokensRaw.in === 'number') tokens.in = tokensRaw.in
    if (typeof tokensRaw.out === 'number') tokens.out = tokensRaw.out
  }
  const entry: RequestLogEntry = {
    ts: r.ts,
    route: typeof r.route === 'string' ? r.route : '',
    target: { provider: target.provider, model: target.model },
    status,
    tryIndex: typeof r.tryIndex === 'number' ? r.tryIndex : 1,
    latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : 0,
    tokens,
  }
  if (typeof r.sessionId === 'string') entry.sessionId = r.sessionId
  if (typeof r.error === 'string') entry.error = r.error
  if (r.effort && typeof r.effort === 'object') {
    const e = r.effort as Record<string, unknown>
    if (typeof e.requested === 'string') {
      entry.effort = {
        requested: e.requested,
        ...(typeof e.sent === 'string' ? { sent: e.sent as string } : {}),
      }
    }
  }
  return entry
}

function normalizeStats(v: Record<string, number>): RouteStats {
  return {
    calls: typeof v.calls === 'number' ? v.calls : 0,
    errors: typeof v.errors === 'number' ? v.errors : 0,
    latencySum: typeof v.latencySum === 'number' ? v.latencySum : 0,
    latencyN: typeof v.latencyN === 'number' ? v.latencyN : 0,
    tokensIn: typeof v.tokensIn === 'number' ? v.tokensIn : 0,
    tokensOut: typeof v.tokensOut === 'number' ? v.tokensOut : 0,
  }
}

/** Accumulate one completed call into a stats object. */
export function accumulateStats(s: RouteStats, opts: { ok: boolean; latencyMs: number; tokensIn?: number; tokensOut?: number }): RouteStats {
  const next: RouteStats = {
    calls: s.calls + 1,
    errors: s.errors + (opts.ok ? 0 : 1),
    latencySum: s.latencySum + opts.latencyMs,
    latencyN: s.latencyN + 1,
    tokensIn: s.tokensIn + (typeof opts.tokensIn === 'number' ? opts.tokensIn : 0),
    tokensOut: s.tokensOut + (typeof opts.tokensOut === 'number' ? opts.tokensOut : 0),
  }
  return next
}

/** In-memory bounded request log shared across the fiber. */
export interface LogRing {
  push(entry: RequestLogEntry): void
  entries(): RequestLogEntry[]
  clear(): void
  /** Seed the ring from persisted entries (dedup by ts+target+tryIndex so a
   * re-hydrate never double-counts). Called once on apply. */
  hydrate(entries: RequestLogEntry[]): void
}

export function createLogRing(capacity = LOG_RING_CAPACITY): LogRing {
  const buf: RequestLogEntry[] = []
  const keyOf = (e: RequestLogEntry) => `${e.ts}\u0000${e.target.provider}\u0000${e.target.model}\u0000${e.tryIndex}`
  return {
    push(entry) {
      buf.push(entry)
      if (buf.length > capacity) buf.splice(0, buf.length - capacity)
    },
    entries: () => buf.slice(),
    clear: () => { buf.length = 0 },
    hydrate(entries) {
      if (!entries.length) return
      const seen = new Set(buf.map(keyOf))
      const merged = [...entries.filter((e) => !seen.has(keyOf(e))), ...buf]
      merged.sort((a, b) => a.ts - b.ts)
      buf.length = 0
      buf.push(...merged.slice(-capacity))
    },
  }
}

/** Session-scoped stats accumulator (union of route + target dimensions). */
export interface StatsRecorder {
  record(opts: {
    route: string
    provider: string
    model: string
    ok: boolean
    latencyMs: number
    tokensIn?: number
    tokensOut?: number
    tryIndex: number
    sessionId?: string
    error?: string
    /** Explicit log status override — e.g. 'fallback' for a call that only
     * succeeded on tryIndex > 1. Defaults to ok ? 'ok' : 'error'. */
    status?: RequestLogEntry['status']
    /** Requested vs actually-forwarded thinking level (see EffortTrace in
     * shared/types). Optional: present only when the caller requested an effort. */
    effort?: EffortTrace
  }): void
  byRoute(): Record<string, RouteStats>
  byTarget(): Record<string, RouteStats>
  reset(): void
  /** True since the last `clearDirty()` if any call was recorded — the
   * debounced persister uses this to skip no-op writes. */
  isDirty(): boolean
  clearDirty(): void
  /** Seed the aggregates from a persisted snapshot (called once on apply so
   * the 观测台 is not blank after a reload). Never marks dirty. */
  hydrate(snap: { byRoute?: Record<string, RouteStats>; byTarget?: Record<string, RouteStats> }): void
}

export function createStatsRecorder(): StatsRecorder {
  const byRoute: Record<string, RouteStats> = {}
  const byTarget: Record<string, RouteStats> = {}
  let dirty = false
  const bump = (m: Record<string, RouteStats>, k: string, opts: { ok: boolean; latencyMs: number; tokensIn?: number; tokensOut?: number }) => {
    const cur: RouteStats = m[k] || { calls: 0, errors: 0, latencySum: 0, latencyN: 0, tokensIn: 0, tokensOut: 0 }
    m[k] = accumulateStats(cur, opts)
  }
  return {
    record({ route, provider, model, ok, latencyMs, tokensIn, tokensOut, tryIndex, sessionId, error, status, effort }) {
      bump(byRoute, route, { ok, latencyMs, tokensIn, tokensOut })
      bump(byTarget, `${provider}\u0000${model}`, { ok, latencyMs, tokensIn, tokensOut })
      getLogRing().push({
        ts: Date.now(),
        ...(sessionId ? { sessionId } : {}),
        route,
        target: { provider, model },
        status: status || (ok ? 'ok' : 'error'),
        tryIndex,
        latencyMs,
        tokens: {
          ...(typeof tokensIn === 'number' ? { in: tokensIn } : {}),
          ...(typeof tokensOut === 'number' ? { out: tokensOut } : {}),
        },
        ...(error ? { error } : {}),
        ...(effort ? { effort } : {}),
      })
      dirty = true
      requestStatsPersist?.()
    },
    byRoute: () => ({ ...byRoute }),
    byTarget: () => ({ ...byTarget }),
    reset: () => {
      for (const k of Object.keys(byRoute)) delete byRoute[k]
      for (const k of Object.keys(byTarget)) delete byTarget[k]
      getLogRing().clear()
      dirty = true
    },
    isDirty: () => dirty,
    clearDirty: () => { dirty = false },
    hydrate: (snap) => {
      if (snap.byRoute) for (const [k, v] of Object.entries(snap.byRoute)) if (!byRoute[k]) byRoute[k] = v
      if (snap.byTarget) for (const [k, v] of Object.entries(snap.byTarget)) if (!byTarget[k]) byTarget[k] = v
    },
  }
}

/** Fiber-scoped singletons so the router and the handlers share one recorder. */
let _logRing: LogRing | undefined
export function getLogRing(): LogRing {
  _logRing ||= createLogRing()
  return _logRing
}

let _statsRecorder: StatsRecorder | undefined
export function getStatsRecorder(): StatsRecorder {
  _statsRecorder ||= createStatsRecorder()
  return _statsRecorder
}

/** Rebind the singletons (used by the smoke harness to reset between scenarios). */
export function resetObservabilitySingletons(): void {
  _logRing = undefined
  _statsRecorder = undefined
}

/** Hydrate the in-memory recorder + log ring from the persisted snapshot so the
 * 观测台 and the conversation route badge are populated on a fresh fiber (page
 * refresh / host restart). Idempotent — safe to call once per apply. Health is
 * hydrated separately by the health tracker. */
export function hydrateObservability(ctx: HostCtx): void {
  try {
    const snap = readStatsSnapshot(ctx)
    getStatsRecorder().hydrate({ byRoute: snap.byRoute, byTarget: snap.byTarget })
    if (snap.logs && snap.logs.length) getLogRing().hydrate(snap.logs)
    // The recorder is now seeded from disk, not from a live call — do not let
    // that count as a pending write.
    getStatsRecorder().clearDirty()
  } catch { /* best effort */ }
}

/** Persist the aggregate stats + a capped tail of the request log into the
 * settings snapshot, PRESERVING the health map the health tracker owns. Skips
 * the write entirely when nothing changed since the last flush. Returns true
 * when a write happened. */
export async function persistStats(ctx: HostCtx, opts?: { force?: boolean }): Promise<boolean> {
  const rec = getStatsRecorder()
  if (!opts?.force && !rec.isDirty()) return false
  try {
    const prev = readStatsSnapshot(ctx)
    const logs = getLogRing().entries().slice(-LOG_PERSIST_CAP)
    await writeStatsSnapshot(ctx, {
      byRoute: rec.byRoute(),
      byTarget: rec.byTarget(),
      health: prev.health || {},
      logs,
    })
    rec.clearDirty()
    return true
  } catch {
    return false
  }
}

/** Requester function dispatched after each completed call, to coalesce
 * persistence writes via a microtask queue. Set once per fiber (index.ts's
 * apply hook) and reset here when the fiber goes away. */
export let requestStatsPersist: (() => void) | undefined

/** Install a requester that coalesces writes onto a microtask queue.
 * The previous requester is replaced; returning the release function
 * allows the caller to clean up when the fiber is disposed. */
export function setStatsPersistRequester(fn: () => void): () => void {
  requestStatsPersist = fn
  return () => { requestStatsPersist = undefined }
}

/** Reset the persistence requester (used by index.ts on fresh fibers). */
export function resetStatsPersistRequester(): void {
  requestStatsPersist = undefined
}
