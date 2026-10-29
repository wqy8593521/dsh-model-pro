/** delete-provider handler — removes a provider from both dicts. */

import type { HostCtx } from '../utils'
import { readProviders, readDisabled, checkWritable, writeSection } from '../utils'
import { readCapabilityState, saveCapabilities, withCapabilityWrite } from '../capabilityStore'
import { readHiddenState, writeHiddenState, clearHiddenFor } from '../hiddenModels'

export async function deleteProvider(ctx: HostCtx, args: { route?: string }) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }
  return withCapabilityWrite(st, () => deleteProviderLocked(ctx, args))
}

async function deleteProviderLocked(ctx: HostCtx, args: { route?: string }) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }

  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const providers = readProviders(st)
  const disabled = readDisabled(st)

  if (
    !Object.prototype.hasOwnProperty.call(providers, route) &&
    !Object.prototype.hasOwnProperty.call(disabled, route)
  ) {
    return { ok: false as const, error: `提供商 "${route}" 不存在` }
  }

  try {
    const nextProviders: Record<string, unknown> = {}
    for (const k of Object.keys(providers)) {
      if (k !== route) nextProviders[k] = (providers as any)[k]
    }
    const nextDisabled: Record<string, unknown> = {}
    for (const k of Object.keys(disabled)) {
      if (k !== route) nextDisabled[k] = (disabled as any)[k]
    }
    const before = readCapabilityState(st)
    const after = { ...before }
    delete after[route]
    await saveCapabilities(st, before, after, () => writeSection(st, nextProviders as any, nextDisabled as any))
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }

  // The hidden archive is keyed by route: once the provider is gone, those entries
  // have no owner and no way back into a model list (`restoreDisabledOnUnload`
  // deliberately skips orphan routes). Dropping them here is what keeps the
  // section from accumulating invisible model data forever. Best effort: the
  // deletion itself already succeeded, and a failure only leaves dead state.
  try {
    const cleared = clearHiddenFor(readHiddenState(st), route)
    if (cleared.removed.length) await writeHiddenState(st, cleared.state)
  } catch { /* best effort */ }

  return { ok: true as const, route }
}
