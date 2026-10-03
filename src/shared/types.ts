/** Shared types used by both host and client halves. */

import type { ThinkingLevel } from './constants'

/** A resolver alias whose real model lives on "provider route / model id". */
export interface RouteTarget {
  provider: string
  model: string
  /** Weight used by weighted / round-robin strategies (default 1). */
  weight?: number
  /** Target-level switch (default true). Disabled targets are skipped. */
  enabled?: boolean
}

/** Routing strategies implemented by the dispatch engine. */
export type RouteStrategy =
  | 'priority'    // ordered, fall back on failure
  | 'weighted'    // probabilistic sampling by `weight`
  | 'round-robin' // smooth weighted round-robin
  | 'min-latency' // prefer lowest historical latency
  | 'sticky'      // pin a session to its last successful target

/** Per-route behaviour knobs shared by every strategy. */
export interface RouteConfig {
  /** Max targets tried before giving up (default: all). */
  maxFallbacks?: number
  /** Skip targets probe-marked down when routing (default true). */
  healthAware?: boolean
  /** Pin a sessionId to its last successful target across strategies. */
  sticky?: boolean
  /** Optional per-call soft timeout override. */
  timeoutMs?: number
}

/** Global retry preferences for the two synthetic router routes.
 *
 * This is DSH's OWN request-retry budget — executed by the `llm-retry` plugin on
 * the `agent/request-error` extension point — not the router's internal target
 * fallback. DSH reads one resolved policy per PROVIDER route at registration
 * time, so this value is global to `router` + `composite` rather than per-route. */
export interface RetryPrefs {
  /** Retries allowed AFTER the first attempt. 0 preserves the historical
   * behaviour: a routed request fails as soon as every target has been tried. */
  maxRetries: number
}

/** External model-catalog preferences.
 *
 * The catalog is an OPTIONAL convenience: it prefills reasoning levels that
 * cannot be probed or discovered, saving hand-entry. It is also the plugin's
 * only outbound request to a third-party domain, which is why it ships disabled
 * and carries its own URL rather than hardcoding one. */
export interface CatalogPrefs {
  /** Whether the lookup UI appears and may fetch at all (default false). */
  enabled: boolean
  /** The catalog document to read. Empty string means "use the built-in default". */
  url: string
}

/** Persisted state for the opt-in local endpoint. Its temporary bearer key is
 * process-memory only and deliberately absent from this shape. */
export interface LocalGatewayPrefs {
  enabled: boolean
}

/** One named smart route: a bundle of targets picked by a strategy. */export interface RouteSpec {
  strategy: RouteStrategy
  targets: RouteTarget[]
  config?: RouteConfig
}

/** The smart-routing table: route name -> spec. */
export type RoutesMap = Record<string, RouteSpec>

/** A composite provider: merge several providers' model lists into one virtual
 * route. `union` exposes every model any member provides; `intersection` only
 * exposes models ALL members provide. An optional per-strategy config decides
 * which member serves a model when several own it. */
export interface CompositeSpec {
  /** Virtual route name (consumer-facing, e.g. `mixture`). */
  route: string
  /** Member providers whose models are merged. */
  members: string[]
  /** union (default) or intersection. */
  mode: 'union' | 'intersection'
  /** How to pick among members that own the same model (default priority). */
  strategy: RouteStrategy
}

/** The composite table: composite route -> spec. */
export type CompositesMap = Record<string, CompositeSpec>

/** Probe / health state for a target. */
export interface TargetHealth {
  provider: string
  model: string
  status: 'unknown' | 'up' | 'down' | 'probing'
  lastProbeAt?: number
  latencyMs?: number
  consecutiveFails: number
  lastError?: string
}

/** Aggregated throughput/stats for one route/target. */
export interface RouteStats {
  calls: number
  errors: number
  latencySum: number
  latencyN: number
  tokensIn: number
  tokensOut: number
}

/** What a routed call ASKED for versus what the chosen target was actually
 * sent, after `router/reasoning.effortForTarget` clamped it.
 *
 * Recorded because the clamp is otherwise invisible. A route advertises the
 * UNION of its targets' efforts, so selecting `max` is legal even when the
 * target that ends up serving the turn only offers `medium` — the request
 * succeeds, quietly, at a lower level than was asked for. Without this field
 * the downgrade appears nowhere (not the log, not the turn badge) and the only
 * symptom is a weaker answer.
 *
 * Three states, all distinct:
 *   - absent          : the caller requested no effort
 *   - `sent` present  : forwarded as-is when equal to `requested`, DOWNGRADED
 *                       (or upgraded) when different
 *   - `sent` absent   : the clamp resolved to "send none" — the target declares
 *                       no reasoning, or a vocabulary that cannot be compared.
 *                       Not the same as a downgrade, and must read differently. */
export interface EffortTrace {
  requested: string
  sent?: string
}

/** One persisted request-log entry. */
export interface RequestLogEntry {
  ts: number
  sessionId?: string
  route: string
  target: { provider: string; model: string }
  status: 'ok' | 'error' | 'fallback'
  tryIndex: number
  latencyMs: number
  tokens: { in?: number; out?: number }
  error?: string
  /** Requested vs actually-forwarded thinking level (see {@link EffortTrace}).
   * Optional: entries persisted before this field existed simply lack it, and a
   * call that requested no effort never carries it. */
  effort?: EffortTrace
}

/** AES-256-GCM encrypted secret snapshot stored in a provider profile.
 * `iv`/`ct` are base64; the random AES key lives in the DSH credentials
 * service under ENC_KEY_REF (stable across plugin reinstall). */
export interface EncryptedSecret {
  v: 1
  iv: string
  ct: string
}

/** A provider entry in the providers / disabledProviders dict. `disabled` is
 * this plugin's marker (source of truth): disabling moves the profile into
 * `disabledProviders` AND sets `disabled: true`; unload restores it to
 * `providers` KEEPING the marker, so a reinstall re-parks it and the disabled
 * state persists. Other consumers only ever read `providers`, so they simply
 * don't see a "disabled" concept at all. */
export interface ProviderProfile {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  /** Encrypted-at-rest snapshot of the real API key (see EncryptedSecret). */
  apiKeyEnc?: EncryptedSecret
  headers?: Record<string, string>
  models?: ModelEntry[]
  /** This plugin's disabled marker (true = disabled). */
  disabled?: boolean
  [key: string]: unknown
}

/** Per-level wire spellings for one model's reasoning efforts.
 *
 * `null` is only legal on `off`, where it means "this level is supported, and
 * dispatch sends nothing" — the wire form of not thinking. Every other level
 * needs the exact string the provider expects (often the level name, but some
 * gateways want a token budget or a vendor-specific spelling), which is why this
 * cannot be derived from the level list alone. */
export type ReasoningEfforts = Partial<Record<ThinkingLevel, string | null>>

/** One input modality a model accepts. Missing from a model entry means
 * UNDECLARED — nothing is known — which is a different thing from text-only. */
export type ModelInput = 'text' | 'image'

/** Where a model's displayed input capability came from.
 *
 * `configured` is the display fallback for an entry whose native config carries
 * `input` but whose plugin-state record is missing (pre-provenance config):
 * the value is shown, its ORIGIN is marked unknown. The other five are
 * recorded provenance: `manual` is protected by every later save, the rest can
 * be re-derived by 重新识别. */
export type ModelCapabilitySource = 'configured' | 'manual' | 'discovery' | 'catalog' | 'official' | 'provider-default'

/** Aggregate result of one 重新识别 run, for the status line. */
export interface ModelCapabilitySummary {
  image: number
  text: number
  unknown: number
  preserved: number
  updated: number
  catalogUnavailable: boolean
  rechecked: number
  conflicts: number
}

/** A model entry in a provider's models array. `requestModel`, when set, is the
 * real model id forwarded to the provider (the wire id differs from the
 * selectable `id` — see the llm/stream rewrite in the host half). */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** The input types this model accepts, as DECLARED. Persisted on the native
   * entry; an absent key (or a schema-generated `[]`) means undeclared, not
   * text-only. Display-only provenance fields live in plugin state, never
   * here. */
  input?: ModelInput[]
  /** DISPLAY ONLY (attached at read time): where `input` came from. Never
   * persisted — stripDisplay removes it before any write. */
  capabilitySource?: ModelCapabilitySource
  capabilityConflict?: boolean
  capabilityReference?: string
  /** Optional wire model id different from `id`. */
  requestModel?: string
  /** Reasoning capability: absent = inherit the catalog, `false` = does not
   * reason, dict = the offered levels and their wire spellings. */
  reasoningEfforts?: false | ReasoningEfforts
  [key: string]: unknown
}

/** Result from list-providers handler */
export interface ProviderListItem {
  route: string
  displayName: string
  declared: boolean
  api: string
  baseURL: string
  apiKeyEnv: string
  disabled: boolean
  hasHeaders: boolean
  headerCount: number
  modelCount: number
  usesCatalog: boolean
  /** Whether an encrypted API-key snapshot is stored for this provider. */
  hasSecret: boolean
}

/** Result from get-provider handler */
export interface ProviderData {
  ok: true
  route: string
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
  disabled: boolean
  headers: HeaderPair[]
  models: ModelEntry[]
  usesCatalog: boolean
  /** Advertised model ids for the test dropdown (advisory; may be empty). */
  availableModels?: string[]
  /** Whether an encrypted API-key snapshot is stored. */
  hasSecret?: boolean
  /** Decrypted API key — present only when the caller passed `includeSecret`. */
  secret?: string
}

/** Result from test-provider handler */
export interface TestResult {
  ok: boolean
  model?: string
  latencyMs?: number
  stopReason?: string
  reply?: string
  truncated?: boolean
  error?: string
}

/** A header name-value pair as used in the UI */
export interface HeaderPair {
  name: string
  value: string
}

/** A discovered model from the ll.discoverModels API. `inputModalities` is the
 * live catalog's spelling of the declared input types; `input` is what the
 * rest of the plugin uses once the value has been adopted. */
export interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ModelInput[]
}

/** RPC response wrapper */
export interface RPCResult<T = unknown> {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** The boot state for the ModelProPage component */
export interface BootState {
  providers: ProviderListItem[]
  protocols: string[]
  writable: boolean
  error: string
}

/** Status banner */
export interface StatusMsg {
  kind: 'ok' | 'err'
  text: string
}

/** The create-form state */
export interface CreateFormState {
  route: string
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
  /** Optional real API key to persist (encrypted) on create. */
  apiKey: string
}

/** The info-panel editable state in the editor */
export interface InfoState {
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
}

/** Translation function type */
export type TFunc = (key: string) => string

/** The RPC call function provided to components */
export type CallFn = (method: string, payload?: Record<string, unknown>) => Promise<any>
