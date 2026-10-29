/**
 * dsh-model-pro — Host half lifecycle hooks.
 *
 * restoreDisabledOnUnload: the inverse of the disable (toggle) operation, run
 * when the plugin is unloaded — i.e. when it is uninstalled or disabled. Every
 * provider parked in `disabledProviders` is moved back into `providers` with
 * its full original profile untouched, so the data lives where llm-pi-ai
 * actually persists and resolves it. `disabledProviders` is a foreign key to
 * llm-pi-ai's schema — only this plugin understands it — so without this the
 * disabled providers (models included) would be silently lost the moment this
 * plugin is removed. Restoring is the "no data lost on uninstall" guarantee.
 *
 * The HIDDEN model bag is the same promise at model granularity, and it is the
 * more dangerous of the two: a parked provider is still VISIBLE as a disabled
 * card, while a parked model exists nowhere but this plugin's section. Its
 * entries are merged back into whichever dict holds the route BEFORE the
 * provider restore runs (so a hidden model of a disabled provider travels back
 * with that provider), in the SAME write — one `writeSection` call, because a
 * failure between two writes would leave "provider restored, models still
 * parked" with the plugin already gone. The archive is cleared only after that
 * write succeeds; a failure keeps it (data intact, retried on the next unload,
 * and idempotent because merging skips ids that are already present).
 */

import type { HostCtx } from './utils'
import { readProviders, readDisabled, isPlaceholderModel, checkWritable, writeSection } from './utils'
import { readHiddenState, writeHiddenState, hiddenFor, withoutHidden } from './hiddenModels'
import { migrateDisabledLayout } from './settings'

/**
 * On unload (uninstall / disable of this plugin): every parked provider is
 * moved back into `providers` with its full original profile UNTOUCHED — this
 * plugin's `disabled: true` marker travels with it. The adapter stops caring
 * once the plugin is gone, but the marker is what lets a REINSTALL land in the
 * same disabled state (see parkDisabledProviders). `disabledProviders` is only
 * ever the operational parking slot, never the source of truth.
 */
export async function restoreDisabledOnUnload(ctx: HostCtx) {
  const st = ctx.get('settings')
  if (st === undefined) return { restored: 0, skipped: 0, hiddenRestored: 0 }
  if (!checkWritable(st)) return { restored: 0, skipped: 0, hiddenRestored: 0 }

  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const hidden = readHiddenState(st)
  const disabledRoutes = Object.keys(disabled)
  const hiddenRoutes = Object.keys(hidden).filter((route) => hiddenFor(hidden, route) !== undefined)
  if (disabledRoutes.length === 0 && hiddenRoutes.length === 0) return { restored: 0, skipped: 0, hiddenRestored: 0 }

  const nextProviders: Record<string, unknown> = {}
  const nextDisabled: Record<string, unknown> = {}
  let restored = 0
  let skipped = 0
  let hiddenRestored = 0

  for (const k of Object.keys(providers)) nextProviders[k] = (providers as any)[k]
  for (const k of Object.keys(disabled)) nextDisabled[k] = (disabled as any)[k]

  // 1) Hidden models FIRST, into whichever dict currently owns the route — so a
  //    hidden model of a DISABLED provider is merged into the parked profile and
  //    then travels back with it in step 2. Idempotent: an id already present in
  //    the live list is skipped (it was re-added by the user while hidden).
  let hiddenAfter = hidden
  for (const route of Object.keys(hidden)) {
    const parked = hiddenFor(hidden, route)
    if (!parked) continue
    const target = Object.prototype.hasOwnProperty.call(nextProviders, route)
      ? nextProviders
      : Object.prototype.hasOwnProperty.call(nextDisabled, route)
        ? nextDisabled
        : null
    if (!target) continue // 提供商已被删除：模型没有归处，保持归档，不制造孤儿 route
    const profile = { ...(target[route] as Record<string, unknown>) }
    const list = Array.isArray(profile.models) ? [...(profile.models as unknown[])] : []
    const present = new Set(list.map((m) => (m && typeof m === 'object' ? String((m as { id?: unknown }).id ?? '') : String(m))))
    const merged: unknown[] = []
    for (const item of [...parked.entries].sort((a, b) => a.index - b.index)) {
      if (present.has(item.model.id)) continue
      merged.push({ ...item.model })
      present.add(item.model.id)
      hiddenRestored += 1
    }
    if (merged.length) {
      // 去掉占位哨兵：真实模型回来了，哨兵不再需要，留着会污染适配器的模型目录。
      profile.models = [...list.filter((m) => !isPlaceholderModel(m)), ...merged]
      target[route] = profile
      hiddenAfter = withoutHidden(hiddenAfter, route, parked.entries.map((item) => item.model.id)).state
    }
  }

  // 2) The parked providers, with their models (including the ones merged above)
  //    and this plugin's `disabled: true` marker untouched.
  for (const route of disabledRoutes) {
    if (Object.prototype.hasOwnProperty.call(nextProviders, route)) {
      // Defensive: never clobber a provider that is already active. Its data is safe.
      skipped += 1
      continue
    }
    // The whole original profile moves back untouched — models, headers, credentials.
    nextProviders[route] = nextDisabled[route]
    delete nextDisabled[route]
    restored += 1
  }

  const hiddenChanged = JSON.stringify(hiddenAfter) !== JSON.stringify(hidden)
  if (restored === 0 && !hiddenChanged) return { restored: 0, skipped, hiddenRestored: 0 }

  try {
    await writeSection(st, nextProviders as any, nextDisabled as any)
  } catch (err) {
    try {
      ;(ctx.get('logger') as any)?.warn?.(`dsh-model-pro: 卸载还原失败 — ${String((err as Error)?.message || err)}`)
    } catch { /* ignore */ }
    return { restored: 0, skipped, hiddenRestored: 0 }
  }

  // Clear the archive only AFTER the models are back in the provider section; on
  // failure they stay parked (data intact) and the next unload retries.
  if (hiddenChanged) {
    try {
      await writeHiddenState(st, hiddenAfter)
    } catch (err) {
      try {
        ;(ctx.get('logger') as any)?.warn?.(`dsh-model-pro: 隐藏模型归档清理失败（模型已还原，归档保留）— ${String((err as Error)?.message || err)}`)
      } catch { /* ignore */ }
    }
  }

  return { restored, skipped, hiddenRestored }
}

/**
 * On plugin startup: bring the disabled-provider layout to the 0.1/0.2-neutral
 * form — profiles carrying our `disabled` marker are moved OUT of
 * `llm-pi-ai.providers` (the adapter only reads that dict, so an unmarked
 * removal is what actually disables a route) and INTO this plugin's own
 * settings section, which both arms accept.
 *
 * It also recovers the legacy 0.1 location: a bag left at
 * `llm-pi-ai.disabledProviders` is moved into our section, and any profile
 * parked there that is missing from `providers` is put back — so an upgrade
 * from a 0.1 install lands with every provider intact.
 *
 * See `src/host/settings.ts` for why the bag cannot stay in `llm-pi-ai` on 0.2.
 */
export async function parkDisabledProviders(ctx: HostCtx) {
  const result = await migrateDisabledLayout(ctx)
  return { parked: result.parked + result.restored }
}
