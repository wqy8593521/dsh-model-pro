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
 */

import type { HostCtx } from './utils'
import { readProviders, readDisabled, checkWritable, writeSection } from './utils'
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
  if (st === undefined) return { restored: 0, skipped: 0 }
  if (!checkWritable(st)) return { restored: 0, skipped: 0 }

  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const disabledRoutes = Object.keys(disabled)
  if (disabledRoutes.length === 0) return { restored: 0, skipped: 0 }

  const nextProviders: Record<string, unknown> = {}
  const nextDisabled: Record<string, unknown> = {}
  let restored = 0
  let skipped = 0

  for (const k of Object.keys(providers)) nextProviders[k] = (providers as any)[k]
  for (const k of Object.keys(disabled)) nextDisabled[k] = (disabled as any)[k]

  for (const route of disabledRoutes) {
    if (Object.prototype.hasOwnProperty.call(nextProviders, route)) {
      // Defensive: never clobber a provider that is already active. Its data is safe.
      skipped += 1
      continue
    }
    // The whole original profile moves back untouched — models, headers, credentials.
    nextProviders[route] = disabled[route]
    delete nextDisabled[route]
    restored += 1
  }

  if (restored === 0) return { restored: 0, skipped }

  try {
    await writeSection(st, nextProviders as any, nextDisabled as any)
  } catch (err) {
    try {
      ;(ctx.get('logger') as any)?.warn?.(`dsh-model-pro: 卸载还原失败 — ${String((err as Error)?.message || err)}`)
    } catch { /* ignore */ }
    return { restored: 0, skipped }
  }

  return { restored, skipped }
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
