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

/** A model entry in a provider's models array. `requestModel`, when set, is the
 * real model id forwarded to the provider (the wire id differs from the
 * selectable `id` — see the llm/stream rewrite in the host half). */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
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

/** A discovered model from the llm.discoverModels API */
export interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
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
