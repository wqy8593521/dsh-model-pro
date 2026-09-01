/** Smart-routing router adapter — registration and the module's public surface.
 *
 * Registers TWO synthetic provider routes:
 *   - `router`    : models are the NAMED routes from llm-pi-ai[routes]
 *                   (strategy + targets + weights + config)
 *   - `composite` : models are encoded `compositeName::modelId` combos from
 *                   llm-pi-ai[composites] (union / intersection merges)
 *
 * At call time the adapter picks targets by the route's strategy, honours
 * weights, skips probe-down targets when `healthAware`, respects `maxFallbacks`,
 * pins sessions when `sticky`, and records outcome + tokens into the stats
 * recorder / health tracker. Every target is resolved to its wire id
 * (`requestModel` mapping) before forwarding, same as the llm/stream rewrite.
 *
 * Chunks, message blocks, and finish reasons pass through untouched — forwards
 * are a transparent pipe. The table is read LIVE per call — editing a route or
 * composite never requires re-registering.
 *
 * Layout of this directory:
 *   adapter.ts   the LlmAdapter contract surface (one method per member)
 *   dispatch.ts  the per-call attempt state machine (probe → commit → drain)
 *   strategy.ts  pure target ordering for each strategy
 *   plan.ts      route lookup + per-target config/options shaping
 *   metadata.ts  exact-model metadata for a virtual route
 *   chunks.ts    stream-chunk predicates, token extraction, deadline pull
 *   failure.ts   the ROUTE_EXHAUSTED error shape DSH will retry
 *   types.ts     the llm-service surface used, and per-generation state
 */

import type { HostCtx } from '../utils'
import { ROUTER_ROUTE, COMPOSITE_ROUTE } from '../../shared/constants'
import { makeRouterAdapter } from './adapter'
import { llmOf } from './types'

export { makeRouterAdapter }
export { computeTargetOrder } from './strategy'

/** The live registration handle, kept so a retry-budget edit can re-register.
 *
 * DSH freezes a provider's retry policy when the adapter registers, so a new
 * budget is invisible until the registration is replaced. `handle.replace(...)`
 * re-runs `prepareRoutes`, which re-reads `providerRetryPolicy()`. */
let liveRegistration: { replace?: (providers: string[]) => void } | undefined

/** Re-register the router adapter so a changed retry budget takes effect now.
 *
 * @returns true when the running registration picked up the new policy; false
 *          when it could not (no registration yet, or a runtime without
 *          `handle.replace`), in which case the budget still applies after the
 *          next plugin load.
 */
export function applyRetryPrefs(_ctx: HostCtx): boolean {
  const replace = liveRegistration?.replace
  if (typeof replace !== 'function') return false
  try {
    replace([ROUTER_ROUTE, COMPOSITE_ROUTE])
    return true
  } catch {
    // A disposed registration throws REGISTRATION_DISPOSED — the plugin is
    // unloading, so there is nothing to refresh and nothing to report.
    return false
  }
}

/** Register the router adapter on both synthetic routes, tied to the fiber. */
export function registerRouterAdapter(ctx: HostCtx): void {
  const llm = llmOf(ctx)
  if (!llm || typeof llm.registerAdapter !== 'function') return
  const ctxAny = ctx as any
  if (typeof ctxAny.effect !== 'function') return
  ctxAny.effect(() => {
    try {
      const handle = llm.registerAdapter([ROUTER_ROUTE, COMPOSITE_ROUTE], makeRouterAdapter(ctx))
      const owned = handle as unknown as { replace?: (providers: string[]) => void }
      liveRegistration = owned
      return () => {
        // Clear only if this effect still owns the slot: a re-applied fiber
        // registers the new handle BEFORE disposing the old one, so an
        // unconditional clear would drop the live registration.
        if (liveRegistration === owned) liveRegistration = undefined
        handle()
      }
    } catch {
      return () => undefined
    }
  }, 'dsh-model-pro: router adapter')
}
