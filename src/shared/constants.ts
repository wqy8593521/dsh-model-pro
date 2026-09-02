/** Shared constants used by both host and client halves. */

/** llm-pi-ai settings namespace */
export const NS = 'llm-pi-ai'

/** Client locale namespace */
export const CLIENT_NS = 'settings.dsh-model-pro'

/** Supported API protocols */
export const PROTOS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const

export type Protocol = (typeof PROTOS)[number]

/** Fields that can be updated via update-field handler */
export const EDITABLE_FIELDS = ['displayName', 'api', 'baseURL', 'apiKeyEnv'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

/**
 * Stable credential-ref (in the DSH `credentials` service) that holds the
 * random AES-256 key this plugin uses to encrypt provider API keys at rest.
 * It is created once and NEVER regenerated once stored, so decrypting
 * previously written ciphertext keeps working after a plugin reinstall — the
 * credentials service is host-owned and keyed by this ref, not by the plugin.
 */
export const ENC_KEY_REF = 'DSH_MODEL_PRO_ENC_KEY'

/**
 * Foreign key (inside the llm-pi-ai settings section) holding the smart-routing
 * alias table: `{ alias: { provider, model } }`. Only this plugin reads it.
 */
export const ROUTES_KEY = 'routes'

/** The synthetic provider route this plugin registers its router adapter on. */
export const ROUTER_ROUTE = 'router'

/** The synthetic provider route for composite providers (组合提供商). All
 * composites share this one route; their model ids encode `composite::model`. */
export const COMPOSITE_ROUTE = 'composite'

/** Separator used to encode `composite::model` ids on the composite route. */
export const COMPOSITE_SEP = '::'

/** Every routing strategy the dispatch engine implements. */
export const ROUTE_STRATEGIES = [
  'priority',
  'weighted',
  'round-robin',
  'min-latency',
  'sticky',
] as const
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number]

/** The default strategy (kept for backward-compatible legacy routes). */
export const DEFAULT_ROUTE_STRATEGY: RouteStrategy = 'priority'

/** Foreign key (inside the llm-pi-ai settings section) holding the composite
 * provider table: `{ alias: CompositeSpec }`. Only this plugin reads it. */
export const COMPOSITES_KEY = 'composites'

/** Foreign key (inside the llm-pi-ai settings section) holding a light snapshot
 * of route/target stats + probe health, so the smart-routing page surfaces them
 * without a separate store. High-frequency logs go to the in-memory ring
 * instead (the Host sandbox withholds node fs), bounded per session. */
export const ROUTE_STATS_KEY = 'routeStats'

/** Foreign key (inside the llm-pi-ai settings section) holding this plugin's
 * UI preferences — e.g. whether the conversation badge that shows which
 * provider actually served each turn is displayed. */
export const UI_PREFS_KEY = 'uiPrefs'

/** Foreign key (inside the llm-pi-ai settings section) holding the global
 * request-retry budget this plugin reports for its two synthetic routes. */
export const RETRY_KEY = 'routerRetry'

/**
 * The failure code the router attaches once every target of a route has been
 * tried and failed.
 *
 * A dedicated code is required, not cosmetic: DSH's retry executor only retries
 * codes the provider's own policy lists as retryable, and an adapter that
 * throws a plain `Error` normalizes to `UNKNOWN`, which no default policy
 * lists. Declaring THIS code retryable in `providerRetryPolicy()` lets a routed
 * request retry the whole target sweep without widening the meaning of the
 * shared transient codes (RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT).
 */
export const ROUTE_EXHAUSTED_CODE = 'ROUTE_EXHAUSTED'

/** Retry budget applied when nothing is configured: none. DSH's own default is
 * 5, but a routed request has ALREADY tried every target by the time it fails,
 * so retrying was historically a no-op here — the thrown code was never
 * retryable. Defaulting to 0 keeps that exact behaviour until a user opts in. */
export const DEFAULT_ROUTER_MAX_RETRIES = 0

/** Upper bound offered by the UI. DSH accepts any non-negative safe integer,
 * but a routed retry re-runs the ENTIRE target sweep, so a large budget
 * multiplies wall-clock time by the number of targets. */
export const MAX_ROUTER_MAX_RETRIES = 20

/**
 * Reasoning levels pi-ai recognizes, in ascending order of effort.
 *
 * The order is load-bearing, not decorative: it is what "the nearest lower
 * level" means when a requested effort has to be clamped for a target that does
 * not offer it. Mirrors pi-ai's own `EXTENDED_THINKING_LEVELS`.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * The model-entry field holding per-level wire spellings, consumed by
 * `@deepseek-ai/dsh-llm-pi-ai` and translated into pi-ai's `thinkingLevelMap`.
 *
 * Three states, all distinct and none interchangeable:
 *   - absent  : inherit whatever the installed catalog entry declares
 *   - `false` : this model does not reason
 *   - a dict  : the offered levels, each mapped to the value dispatch sends
 *
 * Within the dict, pi-ai's defaulting is asymmetric — an absent key means
 * "supported" for the five base levels but "unsupported" for `xhigh`/`max` — so
 * llm-pi-ai pins every undeclared level to `null` when materializing the map.
 * A declared `off` with an empty value is the one legal null: it means
 * "supported, send nothing", which is what not thinking IS on the wire.
 */
export const REASONING_EFFORTS_FIELD = 'reasoningEfforts'
