/**
 * dsh-model-pro — Host half utilities.
 *
 * A thin façade over the settings data layer (`settings.ts` / `config.ts` /
 * `compat.ts`): typed readers and per-key writers for handlers. The settings
 * SERVICE itself is only ever touched in `compat.ts` (RULE 2); the
 * cross-realm interop helper and the owned-section merge write live there and
 * in `settings.ts` respectively, re-exported here for the handlers' import
 * path stability.
 *
 * readProviders / readDisabled / readProfile: helpers to read from the
 * llm-pi-ai settings section safely.
 */

import { NS, ROUTES_KEY, PLACEHOLDER_MODEL_ID } from '../shared/constants'
import type { ModelEntry, ProviderProfile, RoutesMap } from '../shared/types'
import {
  readProviderDict,
  readDisabledDict,
  readSection,
  writeOwnedState,
  writeSections,
} from './settings'
export { readSection, writeOwnedState } from './settings'
export { makeHostPlain } from './compat'
import type { SettingsLike } from './settings'
import { readOwnSection } from './config'

/** Settings service interface (subset we use).
 *
 * The `get` member is OPTIONAL because DSH 0.2's settings service
 * (`SettingsForms`) has no such accessor — see `src/host/settings.ts`. Every
 * accessor below goes through that module rather than touching `get` directly. */
export interface SettingsService extends SettingsLike {
  get?(ns: string): Record<string, unknown> | undefined
  readonly writable: boolean
  replace(ns: string, section: unknown, expectedRevision?: number): Promise<void>
}

/** LLM service interface (subset we use) */
export interface LLMService {
  listConfigurableProviders(): Array<{
    settingsNs: string
    provider: string
    displayName?: string
    declared?: boolean
  }>
  discoverModels(ns: string, request: Record<string, unknown>): Promise<
    Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: import('../shared/types').ModelInput[]; input?: unknown }>
  >
}

/** Cordis context (subset) */
export interface HostCtx {
  get(name: 'settings'): SettingsService | undefined
  get(name: 'llm'): LLMService | undefined
  get(name: string): unknown
}

/**
 * Recursively rebuild an object with Object.create(null) prototype.
 * The dsh-settings isPlainObject check (proto === Object.prototype || proto === null)
 * rejects sandbox-realm object literals because vm contexts have their own
 * Object.prototype. Object.create(null) produces a null-proto object that passes.
 *
 * Implemented in `compat.ts` (it exists for the settings write path); re-exported
 * above so handlers keep importing it from this module.
 */

/** Read the `providers` dict from the llm-pi-ai settings section. */
export function readProviders(st: SettingsService | undefined): Record<string, ProviderProfile> {
  return readProviderDict(st)
}

/** Read the `disabledProviders` dict — OUR owned state, not an llm-pi-ai key.
 *
 * 0.1 kept it at `llm-pi-ai.disabledProviders` as a foreign key; 0.2's schema
 * guard refuses that write, so it now lives in this plugin's own section.
 * `migrateDisabledLayout` normalises the old layout at startup. */
export function readDisabled(st: SettingsService | undefined): Record<string, ProviderProfile> {
  return readDisabledDict(st)
}

/** Read a single provider profile from a dict by route. */
export function readProfile(
  providers: Record<string, ProviderProfile>,
  route: string,
): ProviderProfile | null {
  const p = providers[route]
  if (!p || typeof p !== 'object') return null
  return p
}

/** True only for the internal model that keeps a new custom provider valid. */
export function isPlaceholderModel(model: unknown): boolean {
  if (model && typeof model === 'object') return (model as { id?: unknown }).id === PLACEHOLDER_MODEL_ID
  return String(model) === PLACEHOLDER_MODEL_ID
}

/** Return configured models as copies, excluding the internal schema sentinel. */
export function readRealModels(profile: ProviderProfile | null): ModelEntry[] {
  if (!Array.isArray(profile?.models)) return []
  return profile.models
    .filter((model) => !isPlaceholderModel(model))
    .map((model) => (model && typeof model === 'object' ? { ...model } : { id: String(model) }))
}

/** Read the smart-routing alias table from THIS PLUGIN'S OWN section.
 * Returns a SHALLOW COPY: the resolved settings object is deep-frozen (so
 * `delete`/assigment on it throws in strict mode — "Cannot delete property"),
 * and callers may restructure the map in place before writing it back. */
export function readRoutes(st: SettingsService | undefined): RoutesMap {
  if (st === undefined) return {}
  const r = readOwnSection()[ROUTES_KEY]
  if (r && typeof r === 'object') return { ...(r as RoutesMap) }
  return {}
}

/** Write the smart-routing alias table into OUR OWN section.
 *
 * Not `llm-pi-ai`: that schema declares only `providers`, and 0.2's write guard
 * refuses any other destination key. Our section is writable on both arms. */
export async function writeRoutes(st: SettingsService, routes: RoutesMap): Promise<void> {
  await writeOwnedState(st, { [ROUTES_KEY]: routes })
}

/** Read an arbitrary owned top-level key (composites / routeStats / …).
 *
 * 0.2 cannot see undeclared `llm-pi-ai` keys at all (its section is
 * schema-normalized), so owned state lives in our section on both arms. */
export function readRoutesRootKey(st: SettingsService | undefined, key: string): unknown {
  if (st === undefined) return undefined
  const v = readOwnSection()[key]
  if (v && typeof v === 'object') return { ...(v as Record<string, unknown>) }
  return v
}

/** Write one owned top-level key, preserving our other owned keys. */
export async function writeRoutesRootKey(st: SettingsService | undefined, key: string, value: unknown): Promise<void> {
  if (st === undefined) return
  await writeOwnedState(st, { [key]: value })
}

/**
 * Merge keys into this plugin's own section, preserving what is already there.
 *
 * Implemented in `settings.ts` (next to the owned-section reader/writer it
 * composes) and re-exported above; see the full rationale there for why a
 * non-exhaustive owned write MUST read-merge-write on 0.2.
 */

/** Owned plugin-state keys (capability provenance, …) read from the llm-pi-ai
 * section root on the current Harness settings API.
 *
 * This is the 0.1-only half of a deliberately narrow seam: the upstream PR
 * ships a dual-mode variant that retargets these two accessors at the plugin's
 * OWN namespace via Harness 0.2's describe()/mutate() when `st.get` is absent.
 * Only this half is ported — the 0.2 branch is dead code until this plugin
 * actually runs on 0.2 — but every caller is already written against these
 * two names, so adding the modern branch later touches exactly this file. */
export function readOwnedStateKey(st: SettingsService, key: string): unknown {
  return readRoutesRootKey(st, key)
}

export async function writeOwnedStateKey(st: SettingsService, key: string, value: unknown): Promise<void> {
  return writeRoutesRootKey(st, key, value)
}

/** The wire model id for a provider/model: `requestModel` when the provider's
 * model entry declares one, else the selectable id itself. */
export function wireModelOf(st: SettingsService | undefined, provider: string, model: string): string {
  if (!model) return model
  try {
    const providers = readProviders(st)
    const p = readProfile(providers as Record<string, ProviderProfile>, provider)
    const entry = Array.isArray(p?.models)
      ? (p.models as Array<Record<string, unknown>>).find((m) => m && m.id === model)
      : undefined
    if (entry && typeof entry.requestModel === 'string' && entry.requestModel.trim()) {
      return entry.requestModel.trim()
    }
  } catch { /* fall through */ }
  return model
}

/** Check if settings are writable, defaulting to true. */
export function checkWritable(st: SettingsService | undefined): boolean {
  if (st === undefined) return false
  try {
    return st.writable !== false
  } catch {
    return true
  }
}

/**
 * Write the provider dicts to their two homes.
 *
 * `providers` goes to `llm-pi-ai` (the only key that namespace's schema
 * declares, so 0.2's write guard accepts it); the parked `disabled` dict goes to
 * OUR OWN section, because parking it in `llm-pi-ai` is exactly what 0.2
 * refuses with `Config field "disabledProviders" is not volatile`.
 *
 * The `llm-pi-ai` write deliberately carries ONLY `providers`: preserving other
 * keys there would carry foreign keys into a schema-checked write and, on 0.2,
 * they are not even readable back.
 *
 * This is the only provider write path — every handler that modifies state
 * calls this.
 */
export async function writeSection(
  st: SettingsService,
  providers: Record<string, ProviderProfile>,
  disabled: Record<string, ProviderProfile>,
): Promise<void> {
  await writeSections(st, providers, disabled)
}

/**
 * Update a single provider in-place within the correct dict (providers or disabled),
 * then write both dicts.
 */
export async function updateProviderInPlace(
  st: SettingsService,
  route: string,
  mutator: (profile: ProviderProfile) => ProviderProfile,
): Promise<void> {
  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const nextProviders: Record<string, ProviderProfile> = {}
  const nextDisabled: Record<string, ProviderProfile> = {}

  for (const k of Object.keys(providers)) {
    if (k === route) nextProviders[k] = mutator({ ...providers[k] })
    else nextProviders[k] = providers[k]
  }
  for (const k of Object.keys(disabled)) {
    if (k === route) nextDisabled[k] = mutator({ ...disabled[k] })
    else nextDisabled[k] = disabled[k]
  }

  await writeSection(st, nextProviders, nextDisabled)
}
