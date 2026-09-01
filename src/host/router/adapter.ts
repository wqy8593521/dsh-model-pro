/** The adapter object handed to the llm service.
 *
 * This file is the CONTRACT SURFACE: one method per `LlmAdapter` member the
 * runtime may call, each delegating to a focused module. Keeping it thin and
 * flat is the point — when a future dsh-llm adds a method, the gap is visible
 * here rather than buried in dispatch logic.
 */

import type { HostCtx } from '../utils'
import { readRoutes } from '../utils'
import { COMPOSITE_ROUTE, COMPOSITE_SEP } from '../../shared/constants'
import { readComposites, resolveCompositeModels } from '../composite'
import { buildRouterRetryPolicy } from '../retryPolicy'
import { routeOf, planFor, dedupeModels } from './plan'
import { resolveRouteModel } from './metadata'
import { dispatchRoute } from './dispatch'
import { llmOf, newRouterState } from './types'

export function makeRouterAdapter(ctx: HostCtx): unknown {
  const llm = llmOf(ctx)
  const state = newRouterState()

  // Bound to a const so `prepareCall` can delegate to the sibling methods
  // without relying on `this` (the object is handed to the llm runtime, which
  // may destructure or re-bind it).
  const adapter = {
    providerInfo(provider: string) {
      return { id: provider, name: provider === COMPOSITE_ROUTE ? '组合提供商' : '智能路由' }
    },
    /** DSH's OWN request-retry budget for this synthetic route, read once when
     * the adapter registers (see `applyRetryPrefs` for how an edit takes
     * effect). `undefined` means "use DSH's defaults", which is what a zero
     * budget resolves to. */
    providerRetryPolicy() {
      return buildRouterRetryPolicy(ctx)
    },
    /** Provider-side request-image pricing for one exact route — added to the
     * adapter contract in `@deepseek-ai/dsh-llm` 0.1.2-alpha.1, where the
     * runtime forwards it WITHOUT an existence check:
     *
     *   return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
     *
     * The `?.` only guards an unregistered provider, so an adapter missing the
     * method throws `TypeError`. `token-meter` calls it unconditionally on every
     * `measure()` (image or not), and `compaction-basic` calls `measure()`
     * without a try/catch — both mounted in the base bundle — so a smart-routing
     * session would die once anything measured tokens.
     *
     * `undefined` is the base-class answer and the honest one for a virtual
     * route: pricing belongs to whichever target actually serves the request,
     * and consumers fall back to their own neutral estimate. */
    imageRequestPricing() {
      return undefined
    },
    async listModels(provider: string) {
      const out: Array<{ provider: string; id: string; name: string; description?: string }> = []
      if (provider === COMPOSITE_ROUTE) {
        for (const name of Object.keys(readComposites(ctx))) {
          const res = await resolveCompositeModels(ctx, name)
          if (!res.ok) continue
          for (const id of res.ids) {
            out.push({ provider, id: `${name}${COMPOSITE_SEP}${id}`, name: id, description: `${name} · ${res.mode}` })
          }
        }
        return dedupeModels(out)
      }
      // router route
      const routes = readRoutes(ctx.get('settings'))
      for (const name of Object.keys(routes)) {
        const spec = routeOf(ctx, name)
        if (!spec) continue
        out.push({ provider, id: name, name, description: `${spec.strategy} · ${spec.targets.length} 个目标` })
      }
      return out
    },
    async resolveModel(provider: string, model: string, signal?: AbortSignal) {
      const { spec } = planFor(ctx, provider, model, COMPOSITE_ROUTE)
      return resolveRouteModel(ctx, llm, spec, provider, model, signal)
    },
    /** Bind exact model metadata and the eventual dispatch to one adapter
     * generation — the contract `@deepseek-ai/dsh-llm` >= 0.1.1-rc.2 calls from
     * BOTH its prepared-call and direct-stream paths (`registration.adapter
     * .prepareCall(...)`), where a missing method fails the request outright.
     *
     * Older runtimes (<= 0.1.1-rc.1) never call this and keep using
     * `resolveModel` + `stream` directly, so defining it is purely additive:
     * one build serves both. The shape mirrors `LlmAdapter`'s own default —
     * resolve the model, hand back a stream entry point — because the router
     * reads its table live per call and has no generation state to pin. */
    async prepareCall(provider: string, model: string, signal?: AbortSignal) {
      return {
        model: await adapter.resolveModel(provider, model, signal),
        stream: (options: Record<string, any>) => adapter.stream(options),
      }
    },
    async *stream(options: Record<string, any>): AsyncIterable<unknown> {
      const provider = options.provider
      const model = options.model
      const { spec, routeName } = planFor(ctx, provider, model, COMPOSITE_ROUTE)
      if (!spec || !llm) throw new Error(`智能路由「${model}」未配置或没有可用目标`)
      yield* dispatchRoute(ctx, llm, state, spec, routeName, model, options)
    },
  }
  return adapter
}
