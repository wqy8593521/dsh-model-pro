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

// --- strict codecs -----------------------------------------------------------
// Runtime compatibility: the typert boundary's strict-codec contract changed
// between DSH 0.1.x and 0.2.x (desktop 0.2.0-rc.2+):
//   - 0.1.x registry validates `codec.schema.parse` and the gateway decodes via
//     `codec.schema.parse(value)`;
//   - 0.2.x registry validates `codec.create` (validateCodec) and the gateway
//     decodes via `codec.create().parse(value)`.
// Emit BOTH shapes from the same parse function so one bundle activates on
// either runtime. `create` is a factory returning a fresh parser each call,
// matching how the 0.2.x gateway invokes it.
const parser = (parse: (v: unknown) => unknown) => ({ parse })

const strictCodec = (typeSymbol: string, parse: (v: unknown) => unknown) => ({
  mode: 'strict' as const,
  typeSymbol,
  schema: parser(parse),
  create: () => parser(parse),
})

/** The single JSON object argument every method accepts (missing → {}). */
const argsParser = (v: unknown) => {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('expected an args object')
  return v
}

/** Every business method answers `{ ok, ... }`. */
const resultEnvelopeParser = (v: unknown) => {
  if (v === null || typeof v !== 'object' || typeof (v as any).ok !== 'boolean') {
    throw new TypeError('expected an { ok, ... } envelope')
  }
  return v
}

const argParam = {
  name: 'args',
  wire: 'args',
  source: 'json' as const,
  codec: strictCodec(`${PACKAGE}#Args`, argsParser),
}

/** Strict invocation descriptors — what the client mounts and the host resolves. */
export const INVOCATIONS = METHODS.map(([, method]) => ({
  id: `${PACKAGE}#${SERVICE_KEY}/${method}`,
  service: SERVICE_KEY,
  namespace: SERVICE_KEY,
  method,
  invocation: { kind: 'direct' as const },
  parameters: [argParam],
  result: strictCodec(`${PACKAGE}#${method}Result`, resultEnvelopeParser),
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
