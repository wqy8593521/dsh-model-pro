/** Route resolution and per-target request shaping.
 *
 * "Plan" is everything decided BEFORE any network call: which spec a model id
 * refers to, and what config/options one target should be called with. Reading
 * the routes table happens here on every call — editing a route or composite
 * never requires re-registering the adapter.
 */

import type { HostCtx } from '../utils'
import { readRoutes } from '../utils'
import { DEFAULT_ROUTE_STRATEGY } from '../../shared/constants'
import type { RouteSpec, RouteTarget } from '../../shared/types'
import { readComposites, decodeCompositeModel, compositeTargetsFor } from '../composite'

/** Resolve a named route spec from storage (routes table).
 *
 * Returns undefined for a route with no VALID targets, which the callers treat
 * as "not a route" — a spec whose targets were all malformed cannot be
 * dispatched, and reporting it as an empty route would only move the failure
 * later. */
export function routeOf(ctx: HostCtx, name: string): RouteSpec | undefined {
  const spec = readRoutes(ctx.get('settings'))[name]
  if (!spec || typeof spec !== 'object') return undefined
  const targets = Array.isArray(spec.targets)
    ? spec.targets
        .filter((t): t is RouteTarget => !!t && typeof t === 'object' && typeof t.provider === 'string' && typeof t.model === 'string')
        .map((t) => ({ provider: t.provider, model: t.model, ...(typeof t.weight === 'number' ? { weight: t.weight } : {}), ...(typeof t.enabled === 'boolean' ? { enabled: t.enabled } : {}) }))
    : []
  if (!targets.length) return undefined
  return { strategy: spec.strategy || DEFAULT_ROUTE_STRATEGY, targets, ...(spec.config ? { config: spec.config } : {}) }
}

/** Resolve targets + strategy for a composite model id. */
export function compositePlan(ctx: HostCtx, model: string): { spec: RouteSpec; routeName: string } | undefined {
  const dec = decodeCompositeModel(model)
  if (!dec) return undefined
  const comp = readComposites(ctx)[dec.composite]
  if (!comp) return undefined
  const targets = compositeTargetsFor(ctx, dec.composite, dec.model)
  if (!targets.length) return undefined
  const spec: RouteSpec = { strategy: comp.strategy || DEFAULT_ROUTE_STRATEGY, targets }
  return { spec, routeName: `${dec.composite}::${dec.model}` }
}

/** The route spec a (provider, model) pair refers to, plus its stats identity.
 *
 * `routeName` is the key rotation cursors, sticky pins, and stats entries are
 * filed under: the plain route name for `router`, and `composite::model` for a
 * composite, so two models of one composite keep separate rotation state. */
export function planFor(
  ctx: HostCtx,
  provider: string,
  model: string,
  compositeRoute: string,
): { spec: RouteSpec | undefined; routeName: string } {
  if (provider === compositeRoute) {
    const plan = compositePlan(ctx, model)
    return plan ? { spec: plan.spec, routeName: plan.routeName } : { spec: undefined, routeName: model }
  }
  return { spec: routeOf(ctx, model), routeName: model }
}

/** The request controls forwarded to one target.
 *
 * Only DSH's own call-config fields are carried; anything else on `options`
 * belongs to the stream call, not the config, and DSH compares the two for
 * drift. Undefined fields are OMITTED rather than passed as undefined, because
 * an explicit undefined would read as "caller asked for no value" downstream. */
export function buildCallConfig(target: RouteTarget, wire: string, options: Record<string, any>): Record<string, unknown> {
  const c: Record<string, unknown> = { provider: target.provider, model: wire }
  if (options.reasoningEffort !== undefined) c.reasoningEffort = options.reasoningEffort
  if (options.temperature !== undefined) c.temperature = options.temperature
  if (options.maxTokens !== undefined) c.maxTokens = options.maxTokens
  if (options.stop !== undefined) c.stop = options.stop
  return c
}

/** The full stream options for one target: its resolved config plus payload. */
export function buildTargetOptions(callConfig: Record<string, unknown>, options: Record<string, any>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...callConfig, messages: options.messages }
  if (options.system !== undefined) o.system = options.system
  if (options.tools !== undefined) o.tools = options.tools
  if (options.signal !== undefined) o.signal = options.signal
  if (options.sessionId !== undefined) o.sessionId = options.sessionId
  if (options.purpose !== undefined) o.purpose = options.purpose
  return o
}

/** Drop duplicate model ids, keeping first-seen order. */
export function dedupeModels(arr: Array<{ provider: string; id: string; name: string; description?: string }>) {
  const seen = new Set<string>()
  return arr.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}
