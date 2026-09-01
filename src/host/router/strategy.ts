/** Strategy ordering — turning a route spec into an ordered attempt list.
 *
 * Pure functions over the spec, the candidate targets, and health data. No I/O
 * and no settings access, so an ordering decision can be reproduced from its
 * arguments alone (which is what makes `computeTargetOrder` usable as a preview
 * and from tests).
 */

import { DEFAULT_ROUTE_STRATEGY } from '../../shared/constants'
import type { RouteSpec, RouteTarget, RouteStrategy, TargetHealth } from '../../shared/types'

/** Rotated copy of targets starting at `start` so fallbacks walk a stable cycle. */
function rotate<T>(arr: T[], start: number): T[] {
  if (!arr.length) return arr
  const i = ((start % arr.length) + arr.length) % arr.length
  return arr.slice(i).concat(arr.slice(0, i))
}

/** Deterministic weighted pick -> `start` index (smooth weighted round robin). */
function weightedStart(targets: RouteTarget[], cursor: Record<string, number[]>, route: string): number {
  const weights = targets.map((t) => (typeof t.weight === 'number' && t.weight > 0 ? t.weight : 1))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return Math.floor(Math.random() * targets.length)
  // Smooth weighted round-robin: keep a per-route current-weight vector.
  const cur = cursor[route] || (cursor[route] = weights.slice())
  if (cur.length !== weights.length) cursor[route] = weights.slice()
  let best = 0
  for (let j = 1; j < weights.length; j++) {
    if ((cursor[route] as number[])[j] > (cursor[route] as number[])[best]) best = j
  }
  const current = cursor[route] as number[]
  current[best] -= total
  for (let j = 0; j < weights.length; j++) current[j] += weights[j]
  return best
}

/** Build the ordered candidate list for a strategy. */
export function orderTargets(
  spec: RouteSpec,
  targets: RouteTarget[],
  health: { entry(p: string, m: string): TargetHealth | undefined },
  cursor: Record<string, number[]>,
  cursorKey: string,
  options: Record<string, any>,
): RouteTarget[] {
  const strategy: RouteStrategy = spec.strategy || DEFAULT_ROUTE_STRATEGY
  const targetsArr = targets.filter((t) => t.enabled !== false)

  switch (strategy) {
    case 'priority':
      return targetsArr
    case 'weighted':
    case 'round-robin': {
      const start = weightedStart(targetsArr, cursor, cursorKey)
      return rotate(targetsArr, start)
    }
    case 'min-latency': {
      const withLat = targetsArr.map((t, i) => {
        const e = health.entry(t.provider, t.model)
        const lat = e && typeof e.latencyMs === 'number' ? e.latencyMs : Number.MAX_SAFE_INTEGER
        return { t, lat, i }
      })
      withLat.sort((a, b) => (a.lat === b.lat ? a.i - b.i : a.lat - b.lat))
      return withLat.map((x) => x.t)
    }
    case 'sticky': {
      // Actual session pinning is applied by the stream loop (which owns the
      // pin map); here sticky behaves as priority-order fallback for previews.
      return targetsArr
    }
    default:
      return targetsArr
  }
}

/** Expose the picker (used by tests / future preview). */
export function computeTargetOrder(
  spec: RouteSpec,
  targets: RouteTarget[],
  health: { entry(p: string, m: string): TargetHealth | undefined },
  options: Record<string, any>,
  cursor: Record<string, number[]> = {},
  cursorKey = spec.strategy,
): RouteTarget[] {
  return orderTargets(spec, targets, health, cursor, cursorKey, options)
}
