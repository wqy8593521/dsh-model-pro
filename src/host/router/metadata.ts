/** Exact-model metadata for a virtual route.
 *
 * A route is not a model, so its capabilities have to be derived from the
 * targets that will actually serve it. This module is the entry point for that
 * derivation; the aggregation rules themselves live in `./reasoning`, next to
 * the forwarding clamp that makes them safe.
 *
 * History worth keeping, because it explains the shape: the original rule
 * reported the FIRST target's metadata verbatim and discarded everything on any
 * lookup failure. Both were wrong — the first target may be disabled, and a
 * single dead target erased a route's entire capability. The union/minimum
 * aggregation replaced it; see `./reasoning` for why each field aggregates in
 * the direction it does.
 */

import type { HostCtx } from '../utils'
import type { RouteSpec } from '../../shared/types'
import type { LlmLike } from './types'
import { aggregateRouteInfo } from './reasoning'

/** Resolve one virtual model id to exact model metadata.
 *
 * `provider`/`id`/`name` are always overwritten with the VIRTUAL identity: DSH's
 * `normalizeModelInfo` rejects a result whose provider/id do not match what it
 * asked for (`INVALID_MODEL_INFO`), which would take the whole route out of
 * every selector. */
export async function resolveRouteModel(
  ctx: HostCtx,
  llm: LlmLike | undefined,
  spec: RouteSpec | undefined,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return aggregateRouteInfo(ctx, llm, spec, provider, model, signal)
}
