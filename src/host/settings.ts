/**
 * dsh-model-pro — settings access built on the compatibility layer.
 *
 * The service-shape detection and the two namespace writers live in
 * `src/host/compat.ts` (read its header first: it states the four rules this
 * file follows). What remains here is the part unique to this plugin's data:
 * the parked-provider bag, which is stored in our OWN section on `descriptor`
 * and legacy-union'd with `llm-pi-ai.disabledProviders` on `raw`.
 */

import { NS } from '../shared/constants'
import { CONFIG_NS, OWNED_STATE_KEYS, disabledProvidersFrom, readOwnSection } from './config'
import type { ProviderProfile } from '../shared/types'
import type { HostCtx } from './utils'
import {
  asRecord,
  isDescriptorSettings,
  makeHostPlain,
  readProviderDict,
  readSection,
  partitionOwnedKeys,
  settingsArm,
  writeLLMProviders,
  writeOwnedSection,
  type SettingsArm,
  type SettingsLike,
} from './compat'

// Re-exported so callers keep one import site for settings work.
export { isDescriptorSettings, readProviderDict, readSection, settingsArm }
export type { SettingsArm, SettingsLike }

/** Key this plugin owns; never part of `llm-pi-ai`'s declared schema. */
export const DISABLED_KEY = 'disabledProviders'

/**
 * The DSH release in which this plugin drops support for the 0.1 settings arm.
 *
 * Kept as a single constant so the deprecation notice and the docs cannot drift.
 */
export const LEGACY_ARM_REMOVAL = 'v3'

/** Set once per process: the deprecation notice is a one-shot, not per-apply. */
let legacyNoticeEmitted = false

/** Resolve the optional cordis logger without letting a missing one throw. */
function safeLogger(ctx: HostCtx): { warn?: (msg: string) => void } | undefined {
  try {
    return ctx.get('logger') as { warn?: (msg: string) => void } | undefined
  } catch {
    return undefined
  }
}

/**
 * Warn, once, that this process is running the legacy (0.1.x) settings arm.
 *
 * 0.1 is still fully supported — the plugin is dual-mode on purpose, because the
 * upgrade path on 0.2 is where configuration can be lost, so pushing 0.1 users
 * onto it is not obviously a kindness. But the notice gives them a runway before
 * the branch is deleted in {@link LEGACY_ARM_REMOVAL}.
 *
 * @param ctx - Host context used only for its optional `logger`.
 * @param settings - The mounted settings service; its shape picks the arm.
 * @returns whether the legacy notice was emitted (false when 0.2, or already done).
 */
export function warnIfLegacyArm(ctx: HostCtx, settings: unknown): boolean {
  if (legacyNoticeEmitted) return false
  const arm = settingsArm(settings as SettingsLike | undefined)
  if (arm === 'descriptor') return false

  legacyNoticeEmitted = true
  const logger = safeLogger(ctx)
  if (arm === 'raw') {
    logger?.warn?.(
      `dsh-model-pro: running on the legacy DSH 0.1 settings service — supported, but this ` +
        `compatibility path is scheduled for removal in ${LEGACY_ARM_REMOVAL}. ` +
        `Upgrade DSH when convenient; your providers, routes and disabled list are preserved.`,
    )
    return true
  }

  // 'unknown': a settings service with neither `get(ns)` nor `describe()`. The
  // plugin cannot read OR write configuration against it, so say so plainly
  // instead of degrading into "my providers vanished".
  logger?.warn?.(
    `dsh-model-pro: unrecognised settings service (no get(ns), no describe()). ` +
      `This DSH build is newer than this plugin understands — configuration reads and writes ` +
      `will be no-ops until the plugin is updated. Detected keys: ` +
      `${JSON.stringify(Object.keys(settings ?? {}).slice(0, 12))}.`,
  )
  return true
}

/**
 * Read the parked disabled-provider dict.
 *
 * Two sources, unioned:
 *   • this plugin's OWN section — the only place 0.2 lets us persist it;
 *   • the legacy `llm-pi-ai.disabledProviders` foreign key, so an install
 *     upgraded from an older version keeps the providers it had parked.
 *
 * The union is unconditional. Gating it on `typeof st.get === 'function'` (as an
 * earlier revision did) silently dropped the legacy bag on exactly the runtime
 * that needs it: 0.2 has no `get()`, so the parked providers became unreachable
 * precisely when upgrading.
 *
 * The owned section wins on a route present in both.
 */
export function readDisabledDict(st: SettingsLike | undefined): Record<string, ProviderProfile> {
  const owned = disabledProvidersFrom(readSection(st, CONFIG_NS))
  if (st === undefined) return owned
  const legacy = asRecord(readSection(st, NS)[DISABLED_KEY])
  if (legacy === undefined) return owned
  const merged: Record<string, ProviderProfile> = { ...legacy } as Record<string, ProviderProfile>
  for (const [route, profile] of Object.entries(owned)) merged[route] = profile
  return merged
}

/**
 * Merge keys into this plugin's own section, preserving every key already there.
 *
 * This is the ONLY safe way to write a non-exhaustive patch into our own
 * section on 0.2. `SettingsForms.replace()` is documented as "Reset all live
 * fields, then set the supplied fields", and its write does exactly that:
 * `mergeLayers(strip(raw, form), next)` deletes every declared volatile field
 * from the stored patch and re-materialises only the fields the caller supplied
 * — so a partial `replace()` silently resets every owned key it does not
 * mention. Reading the section first and passing the merged result makes the
 * write exhaustive again (RULE 3, in the write direction).
 *
 * `readOwnSection()` reads the same served value every reader resolves owned
 * state from, so the keys restated here are exactly the keys the next read will
 * look for. Values are wrapped by {@link makeHostPlain} because the services
 * validate patches with a realm-sensitive isPlainObject check.
 *
 * Lives beside the owned-section reader/writer rather than in `utils` so the
 * data layer keeps one direction of dependency (compat ← settings ← utils).
 */
export async function writeOwnedState(
  st: SettingsLike,
  patch: Record<string, unknown>,
): Promise<void> {
  const bag: Record<string, unknown> = { ...readOwnSection() }
  for (const [k, v] of Object.entries(patch)) bag[k] = v
  await writeOwnedSection(st, makeHostPlain(bag) as Record<string, unknown>)
}

/**
 * Write the enabled providers to `llm-pi-ai` and the parked ones to our own
 * section.
 *
 * The split is what makes this legal on 0.2: the `llm-pi-ai` write carries
 * exactly one key — `providers`, the declared volatile field — so the schema
 * guard has nothing to reject. Foreign keys are never carried across from the
 * read side either: on 0.2 they would be invisible, and blindly re-writing them
 * on 0.1 would resurrect stale state.
 *
 * The owned half goes through {@link writeOwnedState}: a bare
 * `{disabledProviders}` section would make 0.2's `replace()` reset every OTHER
 * owned field — routes, composites, uiPrefs, capabilities — on each provider
 * add/edit/toggle/delete (issue #6).
 */
export async function writeSections(
  st: SettingsLike,
  providers: Record<string, ProviderProfile>,
  disabled: Record<string, ProviderProfile>,
): Promise<void> {
  // `llm-pi-ai` is written with `providers` ALONE (see compat.writeLLMProviders).
  // That both satisfies the 0.2 schema guard and drops the legacy foreign keys on
  // 0.1, which is what makes the next `readDisabledDict` come from the owned
  // section only. Callers pass the unioned dict, so nothing is lost in the move.
  await writeLLMProviders(st, providers)

  await writeOwnedState(st, { [DISABLED_KEY]: disabled })
}

/**
 * The set of keys this migration moves out of `llm-pi-ai`.
 *
 * `disabledProviders` is included here even though it is read through the
 * `readDisabledDict` union: the cleanup write below strips the whole set from
 * `llm-pi-ai`, so the parked bag must be persisted into our section in the SAME
 * pass — otherwise cleaning up would silently drop it.
 */
const MIGRATED_KEYS = OWNED_STATE_KEYS

/**
 * Move owned state that an OLDER version of this plugin left as foreign keys
 * inside `llm-pi-ai` into this plugin's own section.
 *
 * Why this exists: older versions squatted `routes`, `composites`, `routeStats`,
 * `uiPrefs`, `routerRetry`, `modelCatalog`, `localGateway`,
 * `modelCapabilities` and `disabledProviders` at the `llm-pi-ai` section root.
 * Readers now resolve those from OUR section — correctly, because 0.2 cannot
 * even serve an undeclared `llm-pi-ai` key — so without this the operator's
 * existing configuration would become invisible (routes and composites gone
 * from the UI, prefs reset, disabled providers resurrected).
 *
 * The move is a copy PLUS a cleanup: `llm-pi-ai` is rewritten holding provider
 * data only, because an undeclared key there is exactly what 0.2's schema guard
 * rejects. Keys this plugin does not own are left strictly alone.
 *
 * Never overwrites a key our section already has, so it is safe to run on every
 * `apply` and cannot clobber newer state with a stale legacy value.
 *
 * Awaitable, and awaited by `apply` before anything reads owned state: a later
 * `writeSections` rewrites all of `llm-pi-ai` from what it just read, so an
 * in-flight migration would otherwise race it and could resurrect the foreign
 * keys or drop the parked bag.
 *
 * @returns the keys actually moved, for logging/diagnostics.
 */
export async function migrateOwnedState(ctx: HostCtx): Promise<string[]> {
  const st = ctx.get('settings') as SettingsLike | undefined
  if (st === undefined || st.writable === false) return []

  const legacy = readSection(st, NS)
  const owned = readSection(st, CONFIG_NS)
  const merged: Record<string, unknown> = { ...owned }
  const moved: string[] = []

  for (const key of MIGRATED_KEYS) {
    if (merged[key] !== undefined) continue
    const value = legacy[key]
    if (value === undefined) continue
    merged[key] = value
    moved.push(key)
  }

  // The parked bag may exist in EITHER location; persist the union.
  merged[DISABLED_KEY] = readDisabledDict(st)

  if (moved.length === 0) return []

  // Drop the migrated foreign keys from `llm-pi-ai`, keeping `providers` and any
  // key this plugin does not own. The write must be EXHAUSTIVE (not just
  // `{providers}`): a namespace write preserves keys the caller does not
  // mention, so omitting them would leave the foreign keys in place — and an
  // undeclared key there is exactly what 0.2's schema guard rejects.
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(legacy)) {
    if (key === 'providers') continue
    if ((MIGRATED_KEYS as readonly string[]).includes(key)) continue
    kept[key] = value
  }
  kept.providers = readProviderDict(st)

  // Restate the section holding `providers` plus any key this plugin does not
  // own, so the cleanup cannot delete an operator's own data (RULE 3).
  const { foreign } = partitionOwnedKeys(legacy, MIGRATED_KEYS)

  try {
    await writeOwnedSection(st, merged as Record<string, unknown>)
    await writeLLMProviders(st, readProviderDict(st), foreign)
  } catch {
    // A failed cleanup leaves the legacy copy in place and the next startup
    // retries; owned state was already made reachable by `readDisabledDict`'s
    // union, so there is nothing else to recover here.
  }

  return moved
}

/**
 * Startup normalisation, run once per `apply`.
 *
 * Profiles sitting in `llm-pi-ai.providers` that still carry our `disabled:
 * true` marker (written by 0.1, or restored by a previous unload) are moved out
 * of `providers` and into the parked bag — that removal is what actually
 * disables the route, since the pi-ai adapter only reads `providers`.
 *
 * The marker itself is not readable through `describe()` on 0.2 (the profile
 * schema does not declare it, so projection drops it) — but the route still
 * appears in the dict with its declared fields, and on 0.1 the marker is
 * readable. Migration therefore keys off the marker where available and leaves
 * an already-correct layout alone.
 *
 * Also performs the general {@link migrateOwnedState} move, so owned state left
 * in `llm-pi-ai` by an older version stays reachable.
 *
 * Idempotent: it writes only when something actually moved.
 */
export async function migrateDisabledLayout(
  ctx: HostCtx,
): Promise<{ parked: number; restored: number; cleaned: boolean }> {
  const st = ctx.get('settings') as SettingsLike | undefined
  if (st === undefined || st.writable === false) return { parked: 0, restored: 0, cleaned: false }

  await migrateOwnedState(ctx)

  const providers: Record<string, ProviderProfile> = { ...readProviderDict(st) }
  const parked: Record<string, ProviderProfile> = { ...readDisabledDict(st) }

  let moved = 0
  for (const [route, profile] of Object.entries(providers)) {
    if (asRecord(profile)?.disabled !== true) continue
    if (parked[route] === undefined) parked[route] = profile
    delete providers[route]
    moved += 1
  }

  if (moved === 0) return { parked: 0, restored: 0, cleaned: false }

  try {
    await writeSections(st, providers, parked)
  } catch {
    return { parked: 0, restored: 0, cleaned: false }
  }
  return { parked: moved, restored: 0, cleaned: true }
}
