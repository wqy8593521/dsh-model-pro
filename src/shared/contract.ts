/**
 * dsh-model-pro wire contract (static-bundle mode).
 *
 * Static-mounted DSH plugins (installed via `dsh plugin add`) do NOT get the
 * dynamic-plugin `harness.handle` / `host.call` bridge. Host↔Client RPC instead
 * flows through a Typert Remote service registered on the Host and mounted on
 * the Client through the API Gateway. This module is the single source of truth
 * for that boundary, imported by BOTH halves:
 *   - the Host imports TYPERT_MANIFEST (registered via ctx.typert.register),
 *   - the Client imports INVOCATIONS (mounted via ctx.remote.$mount).
 *
 * Every business method takes exactly ONE JSON object argument and returns the
 * `{ ok: true, ... }` / `{ ok: false, error }` envelope the handlers already
 * produce, so the existing handler files are reused verbatim.
 */

/** Typert Remote service key (also the wire namespace + client reflect key). */
export const SERVICE_KEY = 'modelPro'

/** Plugin/package id — must match the loader entry id and client bundle id. */
export const PACKAGE = 'dsh-model-pro'

/**
 * Every RPC method, as [wireMethod (kebab, used by the client call() facade),
 * remoteMethod (camel, the actual service method / typert method name)].
 * The client call() facade maps kebab → camel through METHOD_MAP below.
 */
export const METHODS: ReadonlyArray<readonly [string, string]> = [
  ['list-providers', 'listProviders'],
  ['toggle-provider', 'toggleProvider'],
  ['get-provider', 'getProvider'],
  ['discover-models', 'discoverModels'],
  ['create-provider', 'createProvider'],
  ['delete-provider', 'deleteProvider'],
  ['update-field', 'updateField'],
  ['update-headers', 'updateHeaders'],
  ['apply-models', 'applyModels'],
  ['test-provider', 'testProvider'],
  ['set-api-key', 'setApiKey'],
  ['list-routes', 'listRoutes'],
  ['set-route', 'setRoute'],
  ['delete-route', 'deleteRoute'],
  ['list-composites', 'listComposites'],
  ['set-composite', 'setComposite'],
  ['delete-composite', 'deleteComposite'],
  ['preview-composite', 'previewComposite'],
  ['get-route-stats', 'getRouteStats'],
  ['list-request-logs', 'listRequestLogs'],
  ['clear-request-logs', 'clearRequestLogs'],
  ['probe-target', 'probeTarget'],
  ['probe-all', 'probeAll'],
  ['get-ui-prefs', 'getUiPrefs'],
  ['set-ui-prefs', 'setUiPrefs'],
  ['get-retry-prefs', 'getRetryPrefs'],
  ['set-retry-prefs', 'setRetryPrefs'],
  ['get-catalog-prefs', 'getCatalogPrefs'],
  ['set-catalog-prefs', 'setCatalogPrefs'],
  ['get-local-gateway-prefs', 'getLocalGatewayPrefs'],
  ['set-local-gateway-prefs', 'setLocalGatewayPrefs'],
  ['suggest-reasoning', 'suggestReasoning'],
] as const

/** Client-facade kebab → camel map. */
export const METHOD_MAP: Record<string, string> = Object.fromEntries(METHODS)

// --- strict codecs (only `parse` is consumed by the typert boundary) --------
const schema = (parse: (v: unknown) => unknown) => ({ parse })

/** The single JSON object argument every method accepts (missing → {}). */
const argsSchema = schema((v: unknown) => {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('expected an args object')
  return v
})

/** Every business method answers `{ ok, ... }`. */
const resultEnvelopeSchema = schema((v: unknown) => {
  if (v === null || typeof v !== 'object' || typeof (v as any).ok !== 'boolean') {
    throw new TypeError('expected an { ok, ... } envelope')
  }
  return v
})

const argParam = {
  name: 'args',
  wire: 'args',
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: `${PACKAGE}#Args`, schema: argsSchema },
}

/** Strict invocation descriptors — what the client mounts and the host resolves. */
export const INVOCATIONS = METHODS.map(([, method]) => ({
  id: `${PACKAGE}#${SERVICE_KEY}/${method}`,
  service: SERVICE_KEY,
  namespace: SERVICE_KEY,
  method,
  invocation: { kind: 'direct' as const },
  parameters: [argParam],
  result: {
    mode: 'strict' as const,
    typeSymbol: `${PACKAGE}#${method}Result`,
    schema: resultEnvelopeSchema,
  },
}))

/** Host manifest registered through ctx.typert.register. */
export const TYPERT_MANIFEST = {
  package: PACKAGE,
  face: 'host' as const,
  schemas: [],
  model: {
    services: [
      {
        key: SERVICE_KEY,
        exportName: 'ModelProRuntime',
        description:
          'Model Pro — llm-pi-ai provider lifecycle, smart routing, composites, observability and connectivity tests.',
        tags: [],
        members: METHODS.map(([, method]) => ({
          kind: 'method' as const,
          name: method,
          signature: `${method}(args: object): Promise<object>`,
        })),
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: INVOCATIONS,
}
