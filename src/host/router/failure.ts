/** The error thrown when a route has no target left to try.
 *
 * Isolated in its own module because the shape is load-bearing in a way the
 * name does not suggest: it is the ONLY reason DSH will retry a routed request
 * at all, and getting one property wrong silently downgrades it to unretryable.
 */

import { ROUTE_EXHAUSTED_CODE } from '../../shared/constants'

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
