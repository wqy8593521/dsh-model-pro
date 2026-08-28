/** The router's request-retry policy: reading the stored budget and shaping it
 * into the `ResolvedRetryPolicy` DSH captures at adapter registration.
 *
 * Kept in its own module so the router adapter and the RPC handlers can both use
 * it without importing each other (`handlers/retryPrefs.ts` needs the router's
 * `applyRetryPrefs`, so the router must not depend on that handler in turn).
 *
 * Background on why this is needed at all: DSH's retry executor (`llm-retry`)
 * only retries failures whose code appears in the provider's `retryableCodes`,
 * and it reads ONE frozen policy per provider route at registration time. A
 * router failure previously surfaced as a plain `Error` → normalized code
 * `UNKNOWN` → not retryable under any default policy, so a routed request never
 * retried no matter what the user configured elsewhere.
 */

import type { HostCtx } from './utils'
import { readRoutesRootKey } from './utils'
import {
  RETRY_KEY,
  DEFAULT_ROUTER_MAX_RETRIES,
  MAX_ROUTER_MAX_RETRIES,
  ROUTE_EXHAUSTED_CODE,
} from '../shared/constants'
import type { RetryPrefs } from '../shared/types'

const DEFAULTS: RetryPrefs = { maxRetries: DEFAULT_ROUTER_MAX_RETRIES }

/** Coerce stored/incoming JSON into a valid budget. Anything unusable falls back
 * to `base` (the default when omitted) instead of throwing: a corrupt settings
 * value must never make the provider fail to register, which would remove it
 * from every model picker.
 *
 * @param base - the value an unusable input falls back to. A PATCH passes the
 *               currently saved prefs so an invalid field keeps the user's
 *               setting rather than silently resetting it to the default. */
export function normalizeRetryPrefs(raw: unknown, base: RetryPrefs = DEFAULTS): RetryPrefs {
  const out: RetryPrefs = { ...base }
  if (raw && typeof raw === 'object') {
    const n = (raw as Record<string, unknown>).maxRetries
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) {
      out.maxRetries = Math.min(n, MAX_ROUTER_MAX_RETRIES)
    }
  }
  return out
}

/** Read the persisted retry budget for the two synthetic routes. */
export function readRetryPrefs(ctx: HostCtx): RetryPrefs {
  return normalizeRetryPrefs(readRoutesRootKey(ctx.get('settings'), RETRY_KEY))
}

/** The policy object handed to DSH from `adapter.providerRetryPolicy()`.
 *
 * Shape must match `ResolvedRetryPolicy` from `@deepseek-ai/dsh-llm` — DSH uses
 * the returned object as-is (no schema pass), reading `mode`, `maxRetries`,
 * `retryableCodes`, `initialDelayMs`, `maxDelayMs` and `jitterRatio`. Returning
 * `undefined` makes DSH resolve its own defaults instead.
 *
 * `retryableCodes` deliberately lists ONLY {@link ROUTE_EXHAUSTED_CODE}: by the
 * time the router throws, every eligible target has already been attempted, so
 * the meaningful unit of retry is the whole sweep. Transient per-target codes
 * are handled inside the sweep by fallback, not here.
 *
 * @returns undefined when the budget is 0, so DSH keeps its own default policy
 *          and nothing about the historical behaviour changes.
 */
export function buildRouterRetryPolicy(ctx: HostCtx): Record<string, unknown> | undefined {
  const { maxRetries } = readRetryPrefs(ctx)
  if (maxRetries <= 0) return undefined
  return {
    mode: 'normal',
    maxRetries,
    retryableCodes: [ROUTE_EXHAUSTED_CODE],
    // Backoff between whole sweeps. Deliberately slower than DSH's 500ms
    // default: a sweep already spent real time on every target, so an immediate
    // repeat would mostly re-hit providers that are still rate-limited.
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }
}
