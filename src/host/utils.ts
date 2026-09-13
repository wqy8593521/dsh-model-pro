/**
 * dsh-model-pro — Host half utilities.
 *
 * makeHostPlain: rebuilds objects with Object.create(null) so they pass
 * the dsh-settings isPlainObject check across the vm sandbox realm boundary.
 *
 * readProviders / readDisabled / readProfile: helpers to read from the
 * llm-pi-ai settings section safely.
 */

import { NS, ROUTES_KEY, PLACEHOLDER_MODEL_ID } from '../shared/constants'
import type { ModelEntry, ProviderProfile, RoutesMap } from '../shared/types'

/** Settings service interface (subset we use) */
export interface SettingsService {
  get(ns: string): Record<string, unknown> | undefined
  readonly writable: boolean
  replace(ns: string, section: unknown): Promise<void>
}

/** LLM service interface (subset we use) */
interface LLMService {
  listConfigurableProviders(): Array<{
    settingsNs: string
    provider: string
    displayName?: string
    declared?: boolean
  }>
  discoverModels(ns: string, request: Record<string, unknown>): Promise<
    Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>
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
 */
export function makeHostPlain(obj: Record<string, unknown>): Record<string, null> {
  const out = Object.create(null) as Record<string, null>
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const v = obj[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = makeHostPlain(v as Record<string, unknown>) as any
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item))
          return makeHostPlain(item as Record<string, unknown>)
        return item
      }) as any
    } else {
      out[k] = v as any
    }
  }
  return out
}

/** Read the `providers` dict from the llm-pi-ai settings section. */
export function readProviders(st: SettingsService | undefined): Record<string, ProviderProfile> {
  if (st === undefined) return {}
  try {
    const section = st.get(NS)
    if (section && typeof section === 'object' && (section as any).providers && typeof (section as any).providers === 'object')
      return (section as any).providers as Record<string, ProviderProfile>
  } catch { /* ignore */ }
  return {}
}

/** Read the `disabledProviders` dict from the llm-pi-ai settings section. */
export function readDisabled(st: SettingsService | undefined): Record<string, ProviderProfile> {
  if (st === undefined) return {}
  try {
    const section = st.get(NS)
    if (section && typeof section === 'object' && (section as any).disabledProviders && typeof (section as any).disabledProviders === 'object')
      return (section as any).disabledProviders as Record<string, ProviderProfile>
  } catch { /* ignore */ }
  return {}
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

/** Read the smart-routing alias table from the llm-pi-ai section.
 * Returns a SHALLOW COPY: the resolved settings object is deep-frozen (so
 * `delete`/assigment on it throws in strict mode — "Cannot delete property"),
 * and callers may restructure the map in place before writing it back. */
export function readRoutes(st: SettingsService | undefined): RoutesMap {
  if (st === undefined) return {}
  try {
    const section = st.get(NS) as Record<string, unknown> | undefined
    const r = section && section[ROUTES_KEY]
    if (r && typeof r === 'object') return { ...(r as RoutesMap) }
  } catch { /* ignore */ }
  return {}
}

/** Write the smart-routing alias table, preserving every other section key. */
export async function writeRoutes(st: SettingsService, routes: RoutesMap): Promise<void> {
  const preserved: Record<string, unknown> = {}
  try {
    const section = st.get(NS) as Record<string, unknown> | undefined
    if (section && typeof section === 'object') {
      for (const k of Object.keys(section)) {
        if (k === ROUTES_KEY) continue
        preserved[k] = section[k]
      }
    }
  } catch { /* nothing to preserve */ }
  await st.replace(NS, makeHostPlain({ ...preserved, routes }) as any)
}

/** Read an arbitrary top-level key from the llm-pi-ai section (foreign-key
 * accessor — e.g. composites / routeStats), returning a plain copy. */
export function readRoutesRootKey(st: SettingsService | undefined, key: string): unknown {
  if (st === undefined) return undefined
  try {
    const section = st.get(NS) as Record<string, unknown> | undefined
    const v = section && section[key]
    if (v && typeof v === 'object') return { ...(v as Record<string, unknown>) }
    return v
  } catch { /* ignore */ }
  return undefined
}

/** Write a top-level key in the llm-pi-ai section, preserving every other key. */
export async function writeRoutesRootKey(st: SettingsService | undefined, key: string, value: unknown): Promise<void> {
  if (st === undefined) return
  const preserved: Record<string, unknown> = {}
  try {
    const section = st.get(NS) as Record<string, unknown> | undefined
    if (section && typeof section === 'object') {
      for (const k of Object.keys(section)) {
        if (k === key) continue
        preserved[k] = section[k]
      }
    }
  } catch { /* nothing to preserve */ }
  await st.replace(NS, makeHostPlain({ ...preserved, [key]: value }) as any)
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
 * Write both provider dicts to the `llm-pi-ai` settings section, PRESERVING
 * every other top-level key (schema-foreign keys that only this plugin or the
 * operator keep at section level) — `settings.replace()` replaces the whole
 * section, so a wholesale rewrite would silently drop them.
 *
 * This is the only write path — every handler that modifies state calls this.
 */
export async function writeSection(
  st: SettingsService,
  providers: Record<string, ProviderProfile>,
  disabled: Record<string, ProviderProfile>,
): Promise<void> {
  const preserved: Record<string, unknown> = {}
  try {
    const section = st.get(NS) as Record<string, unknown> | undefined
    if (section && typeof section === 'object') {
      for (const k of Object.keys(section)) {
        if (k === 'providers' || k === 'disabledProviders') continue
        preserved[k] = section[k]
      }
    }
  } catch { /* nothing to preserve */ }

  await st.replace(NS, makeHostPlain({ ...preserved, providers, disabledProviders: disabled }) as any)
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
