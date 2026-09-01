/** The llm-service surface the router adapter depends on, plus its accessor.
 *
 * Deliberately a hand-written structural type rather than `LlmService` from
 * `@deepseek-ai/dsh-llm`: the plugin is built as a static bundle whose only
 * externals are `@deepseek-ai/*` and `cordis`, and the runtime resolves those
 * from the profile's own tree — a type-only import would still be a build-time
 * dependency on a package version the host machine may not have. Naming just
 * the members actually called also documents the coupling surface: anything
 * absent here is something the router does not use.
 */

import type { HostCtx } from '../utils'
import type { RouteTarget } from '../../shared/types'

export type LlmLike = {
  registerAdapter(providers: string[], adapter: unknown): (() => void) & {
    /** Swap the registered route set (and re-read the adapter's retry policy).
     * Present since dsh-llm rc.7; guarded at the call site regardless. */
    replace?: (providers: string[]) => void
  }
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<{
    config?: Record<string, unknown>
    stream: (options: Record<string, unknown>) => AsyncIterable<Record<string, any>>
  }>
}

export function llmOf(ctx: HostCtx): LlmLike | undefined {
  return ctx.get('llm') as unknown as LlmLike | undefined
}

/** Cross-call dispatch state owned by ONE adapter generation.
 *
 * Both maps are per-adapter rather than module-level so a re-registration
 * (which builds a fresh adapter) starts with clean rotation and pinning instead
 * of inheriting a previous generation's cursors.
 */
export interface RouterState {
  /** Smooth weighted round-robin current-weight vector, keyed by route identity. */
  cursor: Record<string, number[]>
  /** Sticky session pins: `routeName\0sessionId` -> last successful target. */
  pin: Record<string, RouteTarget>
}

export function newRouterState(): RouterState {
  return { cursor: {}, pin: {} }
}
