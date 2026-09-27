/** RouteBadge — 对话下方「本回合实际由哪个提供商服务」的角标。
 *
 * Registers a `conversation.chat.turnTail` CHAIN slot entry (the same seam the
 * deliverables plugin uses): the chat view renders the chain under each
 * completed turn, before its action row. The host half already records one
 * request-log entry per routed call (`ts`, `sessionId`, route, target,
 * tryIndex, status); this component correlates those entries with the turn's
 * time window via `list-request-logs` and renders one chip per target that
 * served the turn — including 无感切换 evidence (`切换 ×N`) when routing had
 * to fall back.
 *
 * Everything degrades silently: unknown slot, RPC failure, empty matches, or
 * a disabled preference all render nothing.
 */

import React from '../react'
import type { CallFn } from '../../shared/types'
import { fmt } from '../labels'
import { COMPOSITE_SEP, CLIENT_NS } from '../../shared/constants'

/** One aggregated serving target for a turn. */
interface ServingTarget {
  provider: string
  model: string
  /** True when any log entry shows this target was NOT the first attempt. */
  fellBack: boolean
  /** The clamp the router applied for this target, when the level it was sent
   * differs from the one requested. Surfaced here because the substitution is
   * otherwise invisible: the route advertises the UNION of its targets' levels,
   * so a turn can succeed at a lower level than the selector shows. First
   * observed clamp wins — a turn's tool-loop calls all carry the same request. */
  clamped?: { requested: string; sent?: string }
}

interface SelectionLogEntry {
  ts: number
  sessionId?: string
  route: string
  target: { provider: string; model: string }
  status: string
  tryIndex?: number
  effort?: { requested?: string; sent?: string }
}

// --- tiny caches so a page of historical turns costs at most one RPC --------
//
// The log cache is keyed BY SESSION and fetched WITH the sessionId, so the
// host's `limit` applies within this conversation instead of across every
// session. This is what fixes "长对话尾标不显示": an agent turn fires many
// tool-loop LLM calls, so a global last-200 window is quickly eaten by the
// most recent turns and older turns in the same long conversation lose their
// routing evidence. Scoping the fetch to the session (and asking for the whole
// ring) keeps far more turns covered.

const PREF_TTL_MS = 30_000
let prefCache: { value: boolean; at: number } | null = null

const LOG_TTL_MS = 2_000
/** How many entries to pull for one session — the full host ring capacity, so
 * a long conversation keeps as many turns' worth of evidence as the host
 * retains (the host caps this at 500). */
const LOG_FETCH_LIMIT = 500
const logCache = new Map<string, { entries: SelectionLogEntry[]; at: number }>()

async function fetchBadgeData(call: CallFn, sessionId: string, force = false): Promise<{ show: boolean; entries: SelectionLogEntry[] }> {
  const now = Date.now()
  let show = true
  if (prefCache === null || now - prefCache.at > PREF_TTL_MS) {
    try {
      const r = await call('get-ui-prefs')
      show = r?.prefs?.showRouteBadge !== false
      prefCache = { value: show, at: now }
    } catch { /* keep default show */ }
  } else {
    show = prefCache.value
  }
  if (!show) return { show: false, entries: [] }

  const cached = logCache.get(sessionId)
  if (!force && cached && now - cached.at <= LOG_TTL_MS) {
    return { show: true, entries: cached.entries }
  }
  const entries: SelectionLogEntry[] = []
  try {
    // Filter by sessionId HOST-SIDE so the limit is per-conversation, not global.
    const r = await call('list-request-logs', { sessionId, limit: LOG_FETCH_LIMIT })
    for (const e of (r?.entries || []) as SelectionLogEntry[]) {
      if (!e || typeof e.ts !== 'number' || !e.target) continue
      entries.push(e)
    }
  } catch { /* empty */ }
  logCache.set(sessionId, { entries, at: Date.now() })
  return { show: true, entries }
}

/** Test hook — drop all caches. */
export function resetRouteBadgeCaches(): void {
  prefCache = null
  logCache.clear()
}

// --- slot wiring ------------------------------------------------------------

export interface TurnTailOwnerLike {
  turn?: { turn?: number; start?: { time?: number }; end?: { time?: number } }
  seq?: number
}

/** Elect this turn's tail. Returns a coarse gate window PLUS the turn number so
 * the component can refine it precisely against the session timeline. Pure +
 * throw-free: runs during render for EVERY completed turn of every
 * conversation. Returning non-null only means "this entry is eligible" — the
 * real correlation window is recomputed in the component from `turnTimings`,
 * which is the only source that knows where the NEXT turn begins (and thus
 * where this turn's calls must stop), eliminating the ±slack overlap that made
 * adjacent turns steal or drop each other's routing evidence. */
export function selectTurnSelection(owner: TurnTailOwnerLike): { from: number; to: number; turn: number } | null {
  try {
    const t = owner && owner.turn
    if (!t || typeof t !== 'object') return null
    const turnNo = typeof t.turn === 'number' ? t.turn : -1
    const start = t.start && typeof t.start.time === 'number' ? t.start.time : undefined
    const end = t.end && typeof t.end.time === 'number' ? t.end.time : undefined
    // Coarse fallback window (used only when turnTimings is unavailable).
    const SLACK = 5_000
    const from = (start !== undefined ? start : end !== undefined ? end - 10 * 60_000 : 0) - SLACK
    const to = (end !== undefined ? end : Date.now()) + SLACK
    if (!(to > from)) return null
    return { from, to, turn: turnNo }
  } catch {
    return null
  }
}

/** Precise correlation window for a turn, read from the session chat snapshot.
 * The window is `[thisTurnStart, nextTurnStart)` so a routed call is attributed
 * to exactly one turn with NO overlap — the fix for "有时候有有时候没有".
 * Encoded as a stable "from|to" string so a uSES selector never re-renders on
 * identity churn. Returns '' when the snapshot can't answer (caller falls back
 * to the coarse window).
 *
 * Source of truth: `snapshot.chat.timeline.turns` — a Map<turnNo, {turn,
 * start:{time,seq}, end?:{time,seq}, status}> the conversation runtime keeps.
 * We also accept the derived `snapshot.chat.legacy.turnTimings` (turnNo ->
 * {startTime, endTime?}) and a top-level `turnTimings`, since which one is
 * populated varies by DSH build. Reading the WRONG path (an earlier bug) made
 * this silently fall back to the ±slack coarse window every time, so the
 * overlap it was meant to remove never actually went away. */
export function preciseWindowKey(snapshot: any, turnNo: number): string {
  try {
    if (turnNo < 0 || !snapshot || typeof snapshot !== 'object') return ''
    const chat = snapshot.chat && typeof snapshot.chat === 'object' ? snapshot.chat : undefined

    // Collect (turnNo -> startTime) from whichever source this build exposes.
    // Prefer the live timeline.turns (has start.time), then legacy.turnTimings
    // / turnTimings (startTime), then a bare top-level turnTimings.
    const starts = new Map<number, number>()

    const fromTurnsMap = (turns: any) => {
      if (!turns || typeof turns.values !== 'function') return
      for (const tn of turns.values()) {
        if (tn && typeof tn.turn === 'number' && tn.start && typeof tn.start.time === 'number') {
          if (!starts.has(tn.turn)) starts.set(tn.turn, tn.start.time)
        }
      }
    }
    const fromTimings = (timings: any) => {
      if (!timings || typeof timings.entries !== 'function') return
      for (const [k, v] of timings.entries()) {
        if (typeof k === 'number' && v && typeof v.startTime === 'number' && !starts.has(k)) {
          starts.set(k, v.startTime)
        }
      }
    }

    if (chat) {
      fromTurnsMap(chat.timeline && chat.timeline.turns)
      fromTimings(chat.legacy && chat.legacy.turnTimings)
      fromTimings(chat.turnTimings)
    }
    fromTimings(snapshot.turnTimings)

    const start = starts.get(turnNo)
    if (start === undefined) return ''

    // Smallest start strictly after this turn = where this turn's calls stop.
    let nextStart = Infinity
    for (const [k, s] of starts) {
      if (k > turnNo && s > start && s < nextStart) nextStart = s
    }
    // Open-ended (latest turn): allow up to now + small slack so a just-finished
    // turn's late-recorded log still lands inside.
    const to = nextStart === Infinity ? Date.now() + 5_000 : nextStart
    // Tiny lead-in slack so a call logged a hair before turn.start (clock
    // granularity) is not lost; capped well under a typical turn gap.
    const from = start - 1_000
    if (!(to > from)) return ''
    return `${from}|${to}`
  } catch {
    return ''
  }
}

function targetsInWindow(entries: SelectionLogEntry[], win: { from: number; to: number }): { targets: ServingTarget[]; routes: Set<string>; fallbacks: number } {
  const order: string[] = []
  const byKey = new Map<string, ServingTarget>()
  const routes = new Set<string>()
  let fallbacks = 0
  for (const e of entries) {
    if (e.ts < win.from || e.ts > win.to) continue
    if (e.status === 'error') continue // failed attempts are noise here
    routes.add(e.route || '')
    const key = `${e.target.provider}\u0000${e.target.model}`
    let t = byKey.get(key)
    if (!t) {
      t = { provider: e.target.provider, model: e.target.model, fellBack: false }
      byKey.set(key, t)
      order.push(key)
    }
    if (e.status === 'fallback' || (typeof e.tryIndex === 'number' && e.tryIndex > 1)) {
      t.fellBack = true
      fallbacks += 1
    }
    // Record the clamp only when the level actually changed; an effort forwarded
    // as requested is the normal case and deserves no chip.
    if (t.clamped === undefined && e.effort && typeof e.effort.requested === 'string' && e.effort.requested) {
      const sent = typeof e.effort.sent === 'string' && e.effort.sent ? e.effort.sent : undefined
      if (sent !== e.effort.requested) t.clamped = { requested: e.effort.requested, ...(sent ? { sent } : {}) }
    }
  }
  return { targets: order.map((k) => byKey.get(k) as ServingTarget), routes, fallbacks }
}

function routeLabel(route: string): string {
  // composite ids encode `name::model` — keep the readable head.
  const i = route.indexOf(COMPOSITE_SEP)
  return i > 0 ? `${route.slice(0, i)}::…` : route
}

/** The badge view. Renders nothing unless the pref is on AND this turn was
 * served through the smart router / a composite. */
export function RouteBadgeView(props: any & { matched: { from: number; to: number; turn: number } | null; call: CallFn }) {
  const { matched, call } = props
  const sessionId = props.sessionId as string | undefined
  const useSession = typeof props.useSession === 'function' ? (props.useSession as (sel: (s: any) => any) => any) : undefined
  const fallbackT = (k: string) => k
  const t = (props.t || fallbackT) as (k: string) => string
  const [state, setState] = React.useState<{ show: boolean; targets: ServingTarget[]; routes: Set<string> } | null>(null)

  // Precise per-turn window read from the session timeline (turn -> next turn).
  // Falls back to the coarse `matched` window when the timeline can't answer
  // (older DSH build, missing timings, or a partial snapshot). Encoded as a
  // string so this uSES selector is identity-stable and only re-renders when
  // the boundary actually moves (e.g. a NEW turn starts after this one, which
  // finally closes this turn's open-ended window — exactly when a late log
  // could otherwise be misattributed).
  const preciseKey: string = useSession && matched
    ? useSession((snap: any) => preciseWindowKey(snap, matched.turn))
    : ''

  // Resolve the effective correlation window from precise key or coarse matched.
  const win = React.useMemo(() => {
    if (preciseKey) {
      const [f, to] = preciseKey.split('|')
      const from = Number(f); const t2 = Number(to)
      if (Number.isFinite(from) && Number.isFinite(t2) && t2 > from) return { from, to: t2 }
    }
    return matched ? { from: matched.from, to: matched.to } : null
  }, [preciseKey, matched && matched.from, matched && matched.to])

  React.useEffect(() => {
    if (!win || !sessionId) return
    let alive = true
    // Bounded retry schedule (ms). The host records a turn's routing log entry
    // only AFTER the LLM stream fully drains, which can land a few hundred ms
    // AFTER turn/end fires and this tail first renders. A single fetch (or even
    // one immediate cache-bypassing retry) can fall entirely inside that gap
    // and then give up forever, because the effect deps never change again —
    // THAT is the "有时候不显示" race. So we poll a few times with backoff,
    // bypassing the cache, until the evidence shows up (or we exhaust retries).
    const RETRY_DELAYS = [0, 500, 1200, 2500, 4500]
    const timers: any[] = []
    const canTimeout = typeof setTimeout === 'function'

    const attempt = async (i: number): Promise<void> => {
      if (!alive) return
      let show = true
      let agg = { targets: [] as ServingTarget[], routes: new Set<string>(), fallbacks: 0 }
      try {
        const res = await fetchBadgeData(call, sessionId, i > 0)
        show = res.show
        agg = targetsInWindow(res.entries, win)
      } catch {
        show = false
      }
      if (!alive) return
      // Pref off → render nothing and stop retrying.
      if (!show) { setState({ show: false, targets: [], routes: new Set() }); return }
      // Got evidence → render and stop.
      if (agg.targets.length > 0) { setState({ show: true, targets: agg.targets, routes: agg.routes }); return }
      // No evidence yet. Keep whatever we already show (avoid flicker), and
      // schedule the next attempt if any remain.
      if (i + 1 < RETRY_DELAYS.length && canTimeout) {
        timers.push(setTimeout(() => { void attempt(i + 1) }, RETRY_DELAYS[i + 1]))
      } else {
        // Exhausted: only now commit an empty (non-rendering) state.
        setState((prev) => (prev && prev.targets.length > 0 ? prev : { show: true, targets: [], routes: new Set() }))
      }
    }
    void attempt(0)
    return () => {
      alive = false
      for (const id of timers) { try { clearTimeout(id) } catch { /* ignore */ } }
    }
  }, [win && win.from, win && win.to, sessionId])

  if (!win || !state || !state.show || state.targets.length === 0) return null

  const anyFallback = state.targets.some((x) => x.fellBack)
  return (
    <div className="mpro-badgeRow" data-mpro-route-badge="">
      <span className="mpro-badgeIcon">⇄</span>
      <span className="mpro-badgeLabel">{t('badgeRoutePrefix')}</span>
      {state.routes.size > 0 ? (
        Array.from(state.routes).map((r) => (
          <span key={r} className="mpro-badgeChip mpro-badgeChipRoute">{routeLabel(r)}</span>
        ))
      ) : null}
      {state.targets.map((x) => (
        <span key={`${x.provider}\u0000${x.model}`} className="mpro-badgeChip mpro-badgeChipMono">
          {x.provider}/{x.model}
          {anyFallback && x.fellBack ? <span className="mpro-badgeFb" title={t('badgeFallbackTitle')}> ⟲</span> : null}
        </span>
      ))}
      {anyFallback ? <span className="mpro-badgeFbText">{t('badgeFallback')}</span> : null}
      {/* One chip per distinct clamp: the turn ran at a level other than the one
          selected, which nothing else in the chat view reveals. */}
      {state.targets.map((x) => (
        x.clamped ? (
          <span
            key={`eff\u0000${x.provider}\u0000${x.model}`}
            className="mpro-badgeChip mpro-badgeChipEffort"
            title={x.clamped.sent
              ? fmt(t('obsEffortClampedTip'), { requested: x.clamped.requested, sent: x.clamped.sent })
              : fmt(t('obsEffortDroppedTip'), { requested: x.clamped.requested })}
          >
            {x.clamped.sent
              ? fmt(t('badgeEffort'), { requested: x.clamped.requested, sent: x.clamped.sent })
              : fmt(t('badgeEffortNone'), { requested: x.clamped.requested })}
          </span>
        ) : null
      ))}
    </div>
  )
}

/** Register the turnTail chain entry on the client slot registry. Fully
 * defensive: a DSH build without this slot simply skips the feature.
 * `locale: CLIENT_NS` lets the framework inject a bound `t`; the caller ALSO
 * passes its own bound `t` via `explicitT`, which wins — either way the badge
 * never renders raw dictionary keys. */
export function registerRouteBadge(slots: any, call: CallFn, explicitT?: (k: string) => string): void {
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('conversation.chat.turnTail', () => {
    try {
      return slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'dsh-model-pro-route-badge',
          select: (owner: TurnTailOwnerLike) => selectTurnSelection(owner),
          locale: CLIENT_NS,
        },
        (componentProps: any) =>
          React.createElement(RouteBadgeView, { ...componentProps, ...(explicitT ? { t: explicitT } : {}), call }),
      )
    } catch {
      return () => undefined
    }
  })
}
