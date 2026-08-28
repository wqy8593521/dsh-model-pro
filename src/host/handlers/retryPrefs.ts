/** Router retry-budget RPC handlers.
 *
 * The budget itself and its policy shaping live in `src/host/retryPolicy.ts`;
 * this file is only the RPC surface. DSH captures a provider's retry policy when
 * the adapter REGISTERS, so persisting a new budget is not enough — the
 * registration has to be replaced, which `applyRetryPrefs` in
 * `src/host/router.ts` does through the registration handle.
 */

import type { HostCtx } from '../utils'
import { writeRoutesRootKey, checkWritable } from '../utils'
import { RETRY_KEY, MAX_ROUTER_MAX_RETRIES } from '../../shared/constants'
import { readRetryPrefs, normalizeRetryPrefs } from '../retryPolicy'
import type { RetryPrefs } from '../../shared/types'
import { applyRetryPrefs } from '../router'

export async function getRetryPrefs(ctx: HostCtx) {
  return { ok: true as const, prefs: readRetryPrefs(ctx), max: MAX_ROUTER_MAX_RETRIES }
}

export async function setRetryPrefs(ctx: HostCtx, args?: { prefs?: Partial<RetryPrefs> }) {
  const st = ctx.get('settings')
  if (!st || !checkWritable(st)) return { ok: false as const, error: '设置只读，无法保存' }

  const patch = args?.prefs && typeof args.prefs === 'object' ? args.prefs : {}
  // Normalize the patch AGAINST the saved value, so an invalid field keeps what
  // the user already had instead of silently snapping back to the default.
  const current = readRetryPrefs(ctx)
  const merged = normalizeRetryPrefs(patch, current)
  await writeRoutesRootKey(st, RETRY_KEY, merged)

  // A failure to re-register is reported but does NOT undo the write: the new
  // budget still applies on the next plugin load, so silently discarding the
  // user's value would be worse than an "effective after reload" notice.
  const applied = applyRetryPrefs(ctx)
  return { ok: true as const, prefs: merged, applied }
}
