/**
 * dsh-model-pro — the settings compatibility layer. READ THIS FIRST.
 *
 * This plugin's whole job is reading and writing another plugin's
 * configuration, so configuration access is its most load-bearing code and the
 * place where a DSH upgrade can silently destroy user data. Every settings-
 * service difference lives HERE, and nowhere else.
 *
 *
 * THE FOUR RULES
 *
 * 1. DETECT BY CAPABILITY, NEVER BY VERSION.
 *    A version string is a guess about behaviour. We instead probe two
 *    independent capabilities and classify:
 *
 *      `raw`        — `get(ns)` returns the section verbatim, `replace()`
 *                     accepts any key.  (DSH 0.1.x `SettingsProvider`)
 *      `descriptor` — no `get`; `describe()` serves schema-projected sections
 *                     and writes are guarded by `meta.volatile`.
 *                     (DSH 0.2.x `SettingsForms`)
 *      `unknown`    — neither capability. A build we have never met.
 *
 *    `unknown` is a FIRST-CLASS outcome, not an error path. It is what stops a
 *    future DSH from degrading into "my providers vanished" — the exact failure
 *    that cost this project real user configuration.
 *
 * 2. ONE WRITE PATH PER NAMESPACE, DERIVED FROM THE ARM.
 *    Writes are never spread across call sites. `writeLLMProviders` and
 *    `writeOwnedSection` own the two namespaces this plugin touches, so a change
 *    in service semantics is a change in one file.
 *
 * 3. NEVER DESTROY WHAT YOU CANNOT READ.
 *    On `descriptor`, `describe()` projects a foreign section to its declared
 *    fields, so an undeclared key another version squatted is invisible. The
 *    migration may therefore only move what it can actually see, and must leave
 *    everything else exactly where it is. Data that cannot be read is still the
 *    user's data.
 *
 * 4. FAIL LOUDLY, DEGRADE QUIETLY-NEVER.
 *    `selfCheck()` performs a REAL round-trip against the live service and
 *    reports what works. A plugin that cannot read or write configuration says
 *    so at startup, once, with a diagnosable message — it does not present an
 *    empty provider list as though that were the truth.
 *
 *
 * WHEN DSH CHANGES AGAIN
 *
 * Add a case to {@link SettingsArm} and a branch in {@link settingsArm}. If the
 * new service has a different write shape, add it to the two writers below. The
 * tests that protect this file are `tests/host.matrix.mjs` (arm × version
 * behaviour), `tests/host.compat.mjs` (upgrade paths) and
 * `tests/host.ownedkeys.mjs` (schema coverage).
 */

import type { ProviderProfile } from '../shared/types'

// ---------------------------------------------------------------------------
// capability detection
// ---------------------------------------------------------------------------

/**
 * The minimum surface this plugin consumes. Every member is optional except
 * `replace`, because that is the one method both shipped services have.
 */
export interface SettingsLike {
  /** 0.1 only. */
  get?(ns: string): Record<string, unknown> | undefined
  replace(ns: string, section: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
  /** 0.2 only: the served namespace descriptors. */
  describe?(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value?: unknown
    user?: unknown
    revision?: number
  }>
}

/** Which settings-service shape is mounted. See RULE 1. */
export type SettingsArm = 'raw' | 'descriptor' | 'unknown'

/** Classify the mounted settings service. Total, and never throws. */
export function settingsArm(st: SettingsLike | undefined): SettingsArm {
  if (st === undefined || st === null) return 'unknown'
  if (typeof (st as { get?: unknown }).get === 'function') return 'raw'
  if (typeof (st as { describe?: unknown }).describe === 'function') return 'descriptor'
  return 'unknown'
}

/** True only for the 0.2 descriptor service. */
export function isDescriptorSettings(st: SettingsLike | undefined): boolean {
  return settingsArm(st) === 'descriptor'
}

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** Pull one namespace's served values out of a `descriptor` answer. */
function fromDescribe(st: SettingsLike, ns: string): Record<string, unknown> {
  try {
    const describe = st.describe
    if (typeof describe !== 'function') return {}
    const row = describe.call(st)?.find((r) => r?.ns === ns)
    if (row === undefined) return {}
    return asRecord(row.value) ?? asRecord(row.user) ?? {}
  } catch {
    return {}
  }
}

/**
 * Read a section's served values.
 *
 * `raw` → `get(ns)`, which includes undeclared foreign keys.
 * `descriptor` → the matching `describe()` row, PROJECTED to schema-declared
 * fields (RULE 3).
 * `unknown` → `{}`. There is no safe read to attempt.
 *
 * Never throws: a partially-mounted runtime degrades to empty state rather than
 * failing inside a settings event handler.
 */
export function readSection(st: SettingsLike | undefined, ns: string): Record<string, unknown> {
  if (st === undefined || st === null) return {}
  if (typeof st.get === 'function') {
    try {
      return asRecord(st.get(ns)) ?? {}
    } catch {
      return {}
    }
  }
  return fromDescribe(st, ns)
}

/** The LLM provider dict — the adapter's storage, and this plugin's subject. */
export function readProviderDict(st: SettingsLike | undefined): Record<string, ProviderProfile> {
  const providers = asRecord(readSection(st, 'llm-pi-ai').providers)
  return (providers ?? {}) as Record<string, ProviderProfile>
}

// ---------------------------------------------------------------------------
// writes (RULE 2)
// ---------------------------------------------------------------------------

/**
 * Write the enabled providers to `llm-pi-ai`.
 *
 * `providers` is the ONE key that namespace's schema declares as volatile, so
 * this is the only shape the `descriptor` guard accepts. Foreign keys are
 * deliberately not restated: on `descriptor` they are invisible anyway, and
 * blindly re-writing them on `raw` would resurrect stale state.
 */
export async function writeLLMProviders(
  st: SettingsLike,
  providers: Record<string, ProviderProfile>,
  /**
   * Keys this plugin does NOT own but must not drop. On `raw` a namespace write
   * replaces the section, so a migration that restates only `providers` would
   * delete another party's data; on `descriptor` unknown keys are preserved by
   * `strip()` regardless, so passing them is harmless there.
   */
  preserveKeys: Record<string, unknown> = {},
): Promise<void> {
  // Null-prototype copies: the resolved section is deep-frozen on `raw`, and a
  // cross-realm object literal fails dsh-settings' isPlainObject check.
  const section: Record<string, unknown> = Object.create(null)
  for (const [k, v] of Object.entries(preserveKeys)) section[k] = v
  const plain: Record<string, unknown> = Object.create(null)
  for (const [route, profile] of Object.entries(providers)) plain[route] = profile
  section.providers = plain
  await st.replace('llm-pi-ai', section as unknown)
}

/**
 * Split a section into the keys this plugin owns and everything else.
 *
 * Used by the migration to restate a section without dropping an operator's own
 * keys (RULE 3, in the write direction).
 */
export function partitionOwnedKeys(
  section: Record<string, unknown>,
  ownedKeys: readonly string[],
): { owned: Record<string, unknown>; foreign: Record<string, unknown> } {
  const owned: Record<string, unknown> = {}
  const foreign: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(section)) {
    if (k === 'providers' || ownedKeys.includes(k)) owned[k] = v
    else foreign[k] = v
  }
  return { owned, foreign }
}

/** Write this plugin's OWN section. Every key must be declared in `Config`. */
export async function writeOwnedSection(
  st: SettingsLike,
  section: Record<string, unknown>,
): Promise<void> {
  await st.replace(ownedNamespace(), section as unknown)
}

// ---------------------------------------------------------------------------
// self-check (RULE 4)
// ---------------------------------------------------------------------------

/**
 * Key the self-check round-trips. Declared in `Config` like every other owned
 * field, so writing it is legal on both arms; it carries no meaning beyond
 * "this write landed".
 */
export const SELF_CHECK_KEY = 'writeProbe'

export type SelfCheckCode =
  | 'ok'
  | 'no-settings-service'
  | 'read-only'
  | 'unknown-arm'
  | 'unreadable'
  | 'write-failed'
  | 'roundtrip-mismatch'
  | 'timed-out'

export interface SelfCheckResult {
  code: SelfCheckCode
  arm: SettingsArm
  /** Human-readable, ready to log as-is. */
  detail: string
  /** True only when configuration reads AND writes both demonstrably work. */
  operational: boolean
}

/**
 * Prove, against the LIVE service, that this plugin can read and write
 * configuration — instead of assuming it and discovering otherwise from an
 * empty provider list.
 *
 * Writes a unique token into the plugin's own section and reads it back, so a
 * service that accepts writes but never serves them (the `unknown`-shape
 * failure mode) is caught. The probe is left in place: removing it would need a
 * second write, and a stale one-field token is cheaper than a second failure
 * mode. It is overwritten on every startup.
 *
 * Only OUR own namespace is exercised: an empty provider list is a legitimate
 * state, so "the model adapter is not served" must not be reported as a
 * configuration failure. What is provable is that this plugin can persist and
 * re-read its own section.
 *
 * @param st - The mounted settings service, or undefined when absent.
 * @param runtimeNamespace - Namespace `Config` is registered under; supplied by
 *   the caller because only the host entry knows its own loader id.
 */
export async function selfCheck(
  st: SettingsLike | undefined,
  runtimeNamespace: string,
  options: { timeoutMs?: number } = {},
): Promise<SelfCheckResult> {
  // Activation must NEVER wait on this. A settings service that queues a write
  // and never resolves it would otherwise hang the whole plugin — which is
  // exactly what the 0.1 service did when the probe targeted our own
  // not-yet-registered namespace. Bound it and report the timeout.
  const timeoutMs = options.timeoutMs ?? DEFAULT_SELF_CHECK_TIMEOUT_MS
  return withTimeout(selfCheckInner(st, runtimeNamespace), timeoutMs)
}

/** How long activation will wait for the round-trip before giving up. */
export const DEFAULT_SELF_CHECK_TIMEOUT_MS = 2000

/** Resolve to a failure result instead of hanging when `work` outlives `ms`. */
async function withTimeout(work: Promise<SelfCheckResult>, ms: number): Promise<SelfCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<SelfCheckResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              code: 'timed-out',
              arm: 'unknown',
              operational: false,
              detail:
                `the settings service did not complete a write/read round-trip within ${ms}ms — ` +
                `activation continues, but configuration may not persist on this runtime`,
            }),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Swallow a late rejection so a timed-out probe cannot surface later.
    void work.catch(() => {})
  }
}

async function selfCheckInner(
  st: SettingsLike | undefined,
  runtimeNamespace: string,
): Promise<SelfCheckResult> {
  const arm = settingsArm(st)
  if (st === undefined || st === null) {
    return { code: 'no-settings-service', arm, operational: false, detail: 'no settings service is mounted' }
  }
  if (st.writable === false) {
    return { code: 'read-only', arm, operational: false, detail: 'the settings service reports read-only' }
  }
  if (arm === 'unknown') {
    return {
      code: 'unknown-arm',
      arm,
      operational: false,
      detail:
        'unrecognised settings service (neither get(ns) nor describe()) — configuration reads ' +
        'and writes cannot be performed',
    }
  }

  // NOTE: the self-check deliberately inspects only OUR OWN namespace. An empty
  // provider list is a legitimate state (the model adapter may not be installed,
  // or the user may have none configured), so treating "llm-pi-ai is not served"
  // as a failure would cry wolf on fresh installs. What must be provable is that
  // THIS plugin can persist and re-read its own configuration.
  const token = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await st.replace(runtimeNamespace, { [SELF_CHECK_KEY]: token } as unknown)
  } catch (error) {
    return {
      code: 'write-failed',
      arm,
      operational: false,
      detail: `writing to '${runtimeNamespace}' failed: ${String((error as Error)?.message ?? error)}`,
    }
  }

  // Read it back through a FRESH describe() so we test what the service
  // actually serves, not what we just handed it.
  const raw = readSection(st, runtimeNamespace)[SELF_CHECK_KEY]
  const value = typeof raw === 'string' ? raw : undefined
  if (value !== token) {
    return {
      code: 'roundtrip-mismatch',
      arm,
      operational: false,
      detail:
        `wrote ${SELF_CHECK_KEY}='${token}' to '${runtimeNamespace}' but read back ` +
        `${value === undefined ? 'nothing' : `'${value}'`} — this runtime accepts writes it does not serve`,
    }
  }

  return {
    code: 'ok',
    arm,
    operational: true,
    detail: `settings round-trip verified on the '${arm}' service`,
  }
}

// ---------------------------------------------------------------------------
// lazily-resolved namespace
// ---------------------------------------------------------------------------

/**
 * This plugin's own settings namespace, which equals its loader entry id.
 *
 * Held in module state so the compat layer can write the owned section without
 * every caller threading the id through. Imported lazily to avoid a cycle
 * (`config.ts` <- `compat.ts` <- `settings.ts`).
 */
let namespace = 'dsh-model-pro'

/** @param id - The loader entry id / namespace this plugin is mounted under. */
export function setOwnedNamespace(id: string): void {
  if (typeof id === 'string' && id.trim()) namespace = id
}

export function ownedNamespace(): string {
  return namespace
}
