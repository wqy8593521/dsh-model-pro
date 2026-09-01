/** Exact-model metadata for a virtual route.
 *
 * A route is not a model, so its capabilities have to be derived from the
 * targets that will actually serve it. This module owns that derivation.
 *
 * The current rule is the pre-split one: report the FIRST target's metadata.
 * It is kept deliberately unchanged here so the split stays behaviour-neutral —
 * but it is wrong in two ways that are worth naming, because this is where the
 * fix belongs:
 *
 *   - It ignores `enabled` and health, so the advertised capability can come
 *     from a target dispatch would never pick.
 *   - On any lookup failure it discards ALL metadata (context window, max
 *     tokens, modalities, reasoning) rather than the failed part.
 *
 * The planned replacement aggregates every eligible target — union of reasoning
 * efforts, minimum of context windows — which is why this lives in its own file
 * rather than inline in the adapter.
 */

import type { HostCtx } from '../utils'
import { wireModelOf } from '../utils'
import type { RouteSpec } from '../../shared/types'
import type { LlmLike } from './types'

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
  const base = { provider, id: model, name: model }
  if (!spec || !llm || !spec.targets.length) return base
  const first = spec.targets[0]
  try {
    const wire = wireModelOf(ctx.get('settings'), first.provider, first.model)
    const info = await llm.resolveModelInfo(first.provider, wire, signal)
    return { ...info, provider, id: model, name: model }
  } catch {
    return base
  }
}
