/** The error thrown when a route has no target left to try.
 *
 * Isolated in its own module because the shape is load-bearing in a way the
 * name does not suggest: it is the ONLY reason DSH will retry a routed request
 * at all, and getting one property wrong silently downgrades it to unretryable.
 */

import { ROUTE_EXHAUSTED_CODE, UNSUPPORTED_EFFORT_CODE } from '../../shared/constants'

/** Build the error thrown when every eligible target has failed.
 *
 * Carries {@link ROUTE_EXHAUSTED_CODE} in the exact shape
 * `normalizeLlmFailure` (dsh-llm) accepts: it reads the error's OWN `code` and
 * OWN `failure` data properties and trusts the carried snapshot only when
 * `failure.code === code`. A mismatch — or a plain Error — degrades to
 * `UNKNOWN`, which no retry policy lists, making the failure unretryable.
 *
 * Both properties are non-enumerable so the error still serializes and logs
 * like an ordinary Error, and `failure` is frozen because the runtime treats
 * the snapshot as a value it may hold past the throw. */
export function routeExhausted(message: string): Error {
  const error = new Error(message)
  Object.defineProperties(error, {
    code: { value: ROUTE_EXHAUSTED_CODE, enumerable: false, configurable: true, writable: true },
    failure: {
      value: Object.freeze({ message, code: ROUTE_EXHAUSTED_CODE }),
      enumerable: false,
      configurable: true,
      writable: true,
    },
  })
  return error
}

/** Wording that identifies a thinking-level rejection in prose.
 *
 * Needed alongside the code check because the two ways this failure reaches the
 * router carry different amounts of structure: DSH's own pre-flight validation
 * throws with the code attached, while a gateway that rejects the parameter
 * itself comes back as an HTTP error that pi-ai turns into a terminal error
 * `finish` — a message and nothing else. */
const EFFORT_MESSAGE_RE = /reasoning[\s_-]?effort|thinking[\s_-]?level|思考档位|思考等级/i

/** True when an error MESSAGE reads as a thinking-level rejection.
 *
 * Callers must also know that an effort was actually forwarded: the wording
 * alone cannot separate "we sent a level this target refused" from a provider
 * mentioning efforts for some unrelated reason. */
export function looksLikeUnsupportedEffortText(text: unknown): boolean {
  return typeof text === 'string' && EFFORT_MESSAGE_RE.test(text)
}

/**
 * True when a target rejected the call because of the reasoning effort.
 *
 * Checked on the error's own `code`, on its `failure.code` snapshot (the shape
 * `normalizeLlmFailure` produces), and finally on the message — the code is
 * attached by the DSH runtime, but a raw gateway error only says it in prose,
 * and treating this as a generic dispatch failure is what made the router
 * forward the misleading "does not support reasoning effort" report verbatim.
 */
export function isUnsupportedEffortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; failure?: { code?: unknown }; message?: unknown }
  if (e.code === UNSUPPORTED_EFFORT_CODE) return true
  if (e.failure && typeof e.failure === 'object' && e.failure.code === UNSUPPORTED_EFFORT_CODE) return true
  return looksLikeUnsupportedEffortText(e.message)
}
