/** Capability aggregation for virtual routes, and the per-target effort clamp.
 *
 * A route is not a model: whichever target actually serves a call decides what
 * the call can do. Two consequences, and this module owns both.
 *
 * ADVERTISING (`aggregateRouteInfo`). The capability reported for a virtual model
 * must hold no matter which target dispatch picks, so each field aggregates in
 * the direction that keeps that promise:
 *
 *   - `reasoning.efforts` — UNION. An effort offered by any target is reachable,
 *     because the forwarding clamp below maps it onto whatever the chosen target
 *     accepts. Intersecting would hide levels the route can genuinely serve.
 *   - `context.contextWindow` / `defaultMaxTokens` — MINIMUM. These drive
 *     overflow checks upstream. Advertising the largest would let a request pass
 *     validation and then fail at forward time on a smaller target, which is the
 *     failure this aggregation exists to prevent.
 *   - `inputModalities` — INTERSECTION, and only when every target declares it.
 *     Upstream reads an explicit omission as NEGATIVE capability, so a guess here
 *     would assert something false; when any target is silent the field is
 *     omitted (= unknown) rather than narrowed.
 *
 * FORWARDING (`clampEffort`). DSH validates the requested effort against the
 * VIRTUAL model (the union), then the router forwards to one real target whose
 * own `prepareCall` validates again — against that target's actual list. An
 * effort the union offers but this target does not throws
 * `UNSUPPORTED_REASONING_EFFORT` there, and the dispatch loop cannot tell that
 * apart from a dead provider: it would mark a healthy target down and burn a
 * fallback slot on a configuration mismatch. Clamping to the nearest level the
 * target does offer is what makes the union safe to advertise.
 */

import type { HostCtx } from '../utils'
import { wireModelOf } from '../utils'
import { THINKING_LEVELS } from '../../shared/constants'
import type { RouteSpec, RouteTarget } from '../../shared/types'
import type { LlmLike } from './types'

/** One reasoning effort as the llm contract describes it. */
interface EffortInfo {
  id: string
  name: string
  description?: string
}

/** The subset of `LlmResolvedModelInfo` this module reads. */
interface TargetInfo {
  context?: { contextWindow?: unknown }
  defaultMaxTokens?: unknown
  inputModalities?: readonly unknown[]
  reasoning?: { efforts?: readonly EffortInfo[]; defaultEffort?: string }
}

/**
 * Per-target metadata cache.
 *
 * `resolveModel` runs once per virtual model on every selector render, and each
 * call fans out across that route's targets, so an uncached implementation turns
 * one panel open into dozens of provider lookups. Keyed by the REAL
 * provider/model pair, which is what the lookup actually depends on — editing the
 * route table changes which entries are combined, never an entry itself, so no
 * route-change invalidation is needed.
 *
 * TTL is checked lazily against `Date.now()` rather than scheduled: the Host
 * sandbox does not reliably provide timers (see `handlers/test.ts`), and a lazy
 * check needs none.
 */
const TTL_MS = 30_000
const cache = new Map<string, { at: number; info: TargetInfo | null }>()

const keyOf = (provider: string, model: string) => `${provider}\u0000${model}`

/** Resolve one real target's metadata, memoized.
 *
 * A failure is cached as `null` for the same TTL, on purpose: a broken or
 * unreachable target would otherwise be re-queried on every render, turning a
 * dead provider into a per-keystroke stall. */
async function targetInfo(
  ctx: HostCtx,
  llm: LlmLike,
  target: RouteTarget,
  signal?: AbortSignal,
): Promise<TargetInfo | null> {
  const wire = wireModelOf(ctx.get('settings'), target.provider, target.model)
  const key = keyOf(target.provider, wire)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at <= TTL_MS) return hit.info
  let info: TargetInfo | null = null
  try {
    info = (await llm.resolveModelInfo(target.provider, wire, signal)) as TargetInfo
  } catch {
    info = null
  }
  cache.set(key, { at: now, info })
  return info
}

/** Forget every memoized lookup. Called when a fresh adapter generation
 * registers, so a reinstall or settings reload never reuses stale capability. */
export function clearModelInfoCache(): void {
  cache.clear()
}

/** The targets whose capability a route may advertise.
 *
 * `enabled === false` targets are excluded — they can never serve a call, so
 * advertising their capability is simply wrong.
 *
 * Probe health is deliberately NOT applied here, which corrects the intent noted
 * when this logic was split out. Capability is a property of the configuration;
 * health is transient. Filtering by it would let a momentary probe failure
 * RETRACT an effort the user has already selected, changing a request's validity
 * mid-session — and dispatch already ignores health when every target is down,
 * so a health-filtered advertisement could exclude a target that will still be
 * tried. */
const eligible = (spec: RouteSpec): RouteTarget[] => spec.targets.filter((t) => t.enabled !== false)

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** Canonical index of a level id, or -1 when the adapter uses its own vocabulary. */
const levelIndex = (id: string): number => (THINKING_LEVELS as readonly string[]).indexOf(id)

/** Order efforts low→high when every id is a known level, else keep first-seen
 * order. Upstream treats the array as "adapter-preferred display order", so an
 * unknown vocabulary must not be reshuffled into a meaningless sequence. */
function orderEfforts(efforts: EffortInfo[]): EffortInfo[] {
  if (!efforts.every((e) => levelIndex(e.id) >= 0)) return efforts
  return [...efforts].sort((a, b) => levelIndex(a.id) - levelIndex(b.id))
}

/**
 * Aggregate every eligible target's metadata into one virtual model info.
 *
 * `provider`/`id`/`name` are always the VIRTUAL identity: `normalizeModelInfo`
 * rejects a result whose provider/id differ from what it asked for
 * (`INVALID_MODEL_INFO`), and that rejection removes the whole route from every
 * selector.
 *
 * Unlike the pre-split rule this no longer discards everything when a lookup
 * fails — each field is aggregated over the targets that DID answer, so one dead
 * target degrades the numbers instead of erasing the route's capability.
 */
export async function aggregateRouteInfo(
  ctx: HostCtx,
  llm: LlmLike | undefined,
  spec: RouteSpec | undefined,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = { provider, id: model, name: model }
  if (!spec || !llm) return base
  const targets = eligible(spec)
  if (!targets.length) return base

  const infos = (await Promise.all(targets.map((t) => targetInfo(ctx, llm, t, signal)))).filter(Boolean) as TargetInfo[]
  if (!infos.length) return base

  let minContext: number | undefined
  let minMaxTokens: number | undefined
  // Effort id -> display info, first-seen name wins. A Map keeps insertion order
  // for the unknown-vocabulary case, where that order is all we have.
  const efforts = new Map<string, EffortInfo>()
  const defaults = new Set<string>()
  let reasoningTargets = 0
  let modalities: string[] | undefined
  let everyTargetDeclaredModalities = true

  for (const info of infos) {
    const ctxWindow = info.context?.contextWindow
    if (isPosInt(ctxWindow)) minContext = minContext === undefined ? ctxWindow : Math.min(minContext, ctxWindow)
    if (isPosInt(info.defaultMaxTokens)) {
      minMaxTokens = minMaxTokens === undefined ? info.defaultMaxTokens : Math.min(minMaxTokens, info.defaultMaxTokens)
    }

    const list = info.reasoning?.efforts
    if (Array.isArray(list) && list.length) {
      reasoningTargets += 1
      for (const e of list) {
        if (!e || typeof e.id !== 'string' || !e.id) continue
        if (!efforts.has(e.id)) {
          efforts.set(e.id, {
            id: e.id,
            name: typeof e.name === 'string' && e.name ? e.name : e.id,
            ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
          })
        }
      }
      if (typeof info.reasoning?.defaultEffort === 'string' && info.reasoning.defaultEffort) {
        defaults.add(info.reasoning.defaultEffort)
      }
    }

    if (Array.isArray(info.inputModalities)) {
      const declared = info.inputModalities.filter((m): m is string => typeof m === 'string')
      modalities = modalities === undefined ? declared : modalities.filter((m) => declared.includes(m))
    } else {
      everyTargetDeclaredModalities = false
    }
  }

  const out: Record<string, unknown> = { ...base }
  if (minContext !== undefined) out.context = { contextWindow: minContext }
  if (minMaxTokens !== undefined) out.defaultMaxTokens = minMaxTokens
  if (everyTargetDeclaredModalities && modalities !== undefined) out.inputModalities = modalities

  if (efforts.size) {
    // An empty `efforts` array is rejected upstream (INVALID_MODEL_REASONING),
    // so `reasoning` is omitted entirely rather than emitted empty.
    const reasoning: Record<string, unknown> = { efforts: orderEfforts([...efforts.values()]) }
    // A default is only carried when EVERY reasoning-capable target agrees on
    // it. Picking one target's default for a route served by several would
    // silently change the effort of a request that asked for none.
    if (defaults.size === 1 && reasoningTargets === infos.length) {
      const only = [...defaults][0]
      if (efforts.has(only)) reasoning.defaultEffort = only
    }
    out.reasoning = reasoning
  }
  return out
}

/**
 * Map a requested effort onto one the given target actually offers.
 *
 * Returns the effort to forward, or `undefined` to forward none (letting the
 * target apply its own default) — which is the only safe answer when the two
 * vocabularies cannot be compared.
 *
 * Direction: search UP first, then down. This mirrors pi-ai's own
 * `clampThinkingLevel`, so a routed request lands on the same level a direct
 * call to that provider would. Preferring the next level up also fails in the
 * more forgiving direction — over-delivering on a reasoning request costs
 * tokens, while under-delivering silently returns a weaker answer than asked
 * for.
 */
export function clampEffort(requested: string, offered: readonly string[]): string | undefined {
  if (!offered.length) return undefined
  if (offered.includes(requested)) return requested
  const want = levelIndex(requested)
  if (want < 0) return undefined
  const known = offered.filter((id) => levelIndex(id) >= 0)
  if (!known.length) return undefined
  for (let i = want + 1; i < THINKING_LEVELS.length; i += 1) {
    const candidate = THINKING_LEVELS[i]
    if (known.includes(candidate)) return candidate
  }
  for (let i = want - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVELS[i]
    if (known.includes(candidate)) return candidate
  }
  return undefined
}

/**
 * The effort to forward to one specific target, or `undefined` for none.
 *
 * Resolving the target's own metadata first is what avoids the mismatch: without
 * it, an effort valid for the union but not for this target throws inside the
 * target's `prepareCall`, and the dispatch loop would record a healthy provider
 * as failed. On a lookup failure the effort is passed through UNCHANGED rather
 * than dropped — the target may well support it, and dropping it would quietly
 * downgrade a request whose only real problem was an unreadable model list.
 */
export async function effortForTarget(
  ctx: HostCtx,
  llm: LlmLike,
  target: RouteTarget,
  requested: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (requested === undefined) return undefined
  const info = await targetInfo(ctx, llm, target, signal)
  if (!info) return requested
  const offered = (info.reasoning?.efforts || [])
    .map((e) => (e && typeof e.id === 'string' ? e.id : ''))
    .filter(Boolean)
  // A target that declares no reasoning at all rejects ANY effort
  // (UNSUPPORTED_REASONING_EFFORT), so the only way to use it is to send none.
  if (!offered.length) return undefined
  return clampEffort(requested, offered)
}
