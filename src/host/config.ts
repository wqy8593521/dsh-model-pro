/**
 * dsh-model-pro — this plugin's OWN settings section.
 *
 * DSH serves a settings namespace per loader entry that declares a schemastery
 * `Config`. Declaring one is what makes the section WRITABLE on 0.2.x: the
 * `SettingsForms` guard rejects any destination key that is not below a
 * `volatile()` node, and every field declared here is volatile by construction.
 *
 * That is the whole point of owning a section: plugin state stops squatting as
 * an undeclared foreign key inside `llm-pi-ai` (whose schema declares only
 * `providers`), and lives somewhere both 0.1 and 0.2 accept.
 *
 * `Config` is re-exported from the host entry (`src/host/index.ts`) — the loader
 * reads it off the plugin module and wires it to `entry.fiber.runtime.Config`.
 */

import z from '@deepseek-ai/schemastery'
import type { ProviderProfile } from '../shared/types'

/** Loader entry id — must equal {@link PACKAGE} and the profile bundle id. */
export const CONFIG_NS = 'dsh-model-pro'

/** Key holding the parked (disabled) provider profiles. */
export const DISABLED_PROVIDERS_KEY = 'disabledProviders'

/**
 * Mark a schema node live-editable (`meta.volatile`).
 *
 * `.extra('volatile', true)` is used rather than the dedicated `.volatile()`
 * helper because that helper only exists from schemastery 3.18.4, while this
 * repo and the 0.1 web profile resolve 3.18.1. On 3.18.4 the helper is literally
 * `this.extra("volatile", true)`, so both spellings write the SAME
 * `meta.volatile` — which is all dsh-settings' `isVolatilePath` reads.
 *
 * (Verified against both versions by tests/host.schema.mjs. Note that a
 * `volatile()` node resolves to a cosmokit volatile REFERENCE, so reading one
 * back requires `get()` — `JSON.stringify` on the reference yields `{}`.)
 */
const volatile = <T extends object>(schema: T): T =>
  (schema as unknown as { extra(key: string, value: unknown): T }).extra('volatile', true)

/**
 * Every key this plugin persists into its own section.
 *
 * The list is EXHAUSTIVE on purpose: DSH 0.2 rejects any destination key that is
 * not below a `volatile()` node, so a key missing here is not merely unwritable —
 * the write throws `Config field "X" is not volatile` and aborts the user
 * operation (creating a provider, toggling one, saving a route…). Keep it in
 * sync with the `*_KEY` constants in `src/shared/constants.ts` and
 * `CAPABILITIES_KEY` in `capabilityStore.ts`; `tests/host.schema.mjs` asserts
 * every key routed through the owned-state writers is declared here.
 */
export const OWNED_STATE_KEYS = [
  'disabledProviders',
  'modelCapabilities',
  'routes',
  'composites',
  'routeStats',
  'uiPrefs',
  'routerRetry',
  'modelCatalog',
  'localGateway',
  // Round-tripped by compat.selfCheck() to prove writes are actually served.
  // Declared like any other owned field so the 0.2 guard accepts it.
  'writeProbe',
] as const

/** The schemastery module shape this builder needs (callable + `object`/`dict`/`any`). */
export type Schemastery = typeof z

/**
 * Build the plugin's owned-state schema against a given schemastery.
 *
 * Exported as a pure function of the module so tests can build it with BOTH
 * shipped schemastery versions and assert owned state survives each — the arms
 * differ here in a way that silently loses data if it regresses.
 *
 * Each value is `z.any()`: this is state we must round-trip byte-for-byte, so a
 * concrete type would let schemastery normalise (and drop fields of) data it
 * does not model — a provider profile, a route spec, a stats snapshot.
 */
export function buildConfig(schemastery: Schemastery): unknown {
  const fields: Record<string, unknown> = {}
  for (const key of OWNED_STATE_KEYS) {
    fields[key] = volatile(schemastery.any().default({}))
  }
  return schemastery.object(fields)
}

export const Config = buildConfig(z) as ReturnType<Schemastery['object']>

/** Narrow view of a settings service able to read a served namespace. */
interface DescribingSettings {
  describe?(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value?: unknown
    user?: unknown
    revision?: number
  }>
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/**
 * Extract the parked provider dict from a raw settings section value.
 *
 * Tolerant on purpose: this runs against whatever the runtime hands back, from
 * a full section to `undefined`, and a malformed value must degrade to "nothing
 * parked" rather than throwing inside a settings event handler.
 */
export function disabledProvidersFrom(section: unknown): Record<string, ProviderProfile> {
  const bag = asRecord(asRecord(section)?.[DISABLED_PROVIDERS_KEY])
  return (bag ?? {}) as Record<string, ProviderProfile>
}

/** Late-bound accessor for our own section, captured at `apply` time. */
const accessorKey = Symbol.for('dsh-model-pro.settings-accessor')

/** Register the plugin's own-section accessor so handlers can read owned state
 * with nothing but the cordis context. Called once from `apply`. */
export function bindConfigAccessor(settings: unknown): void {
  try {
    ;(globalThis as Record<symbol, unknown>)[accessorKey] = settings
  } catch {
    /* best effort: owned state simply reads as empty */
  }
}

/**
 * Read this plugin's own section through the bound settings service.
 *
 * 0.1 → `get(ns)`; 0.2 → the plugin's own `describe()` row. `value` is the
 * resolved section (defaults applied), which is what we want to preserve.
 */
export function readOwnSection(): Record<string, unknown> {
  let settings: unknown
  try {
    settings = (globalThis as Record<symbol, unknown>)[accessorKey]
  } catch {
    return {}
  }
  if (settings === undefined || settings === null) return {}

  const svc = settings as { get?: (ns: string) => unknown } & DescribingSettings
  try {
    if (typeof svc.get === 'function') return asRecord(svc.get(CONFIG_NS)) ?? {}
    const row = svc.describe?.()?.find((r) => r.ns === CONFIG_NS)
    return asRecord(row?.value) ?? asRecord(row?.user) ?? {}
  } catch {
    return {}
  }
}
