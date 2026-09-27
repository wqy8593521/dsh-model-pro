/** Opt-in local OpenAI-compatible route gateway for external agents.
 *
 * The HTTP route is always registered when DSH's webServer is available, but
 * answers 404 until the persisted `enabled` switch is on AND a bearer key is
 * available. The key is stored in DSH's host-owned credentials service, never
 * in the settings document, and is cached in memory only after secure resolve.
 */

import type { HostCtx } from './utils'
import { checkWritable, readRoutesRootKey, writeRoutesRootKey } from './utils'
import { LOCAL_GATEWAY_CREDENTIAL_REF, LOCAL_GATEWAY_KEY, LOCAL_GATEWAY_PATH, ROUTER_ROUTE } from '../shared/constants'
import type { LocalGatewayPrefs } from '../shared/types'
import { errorText } from './errorText'

interface IncomingLike extends AsyncIterable<Uint8Array | string> {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
}
interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  write?(body: string): boolean
  end(body?: string): void
}
interface WebServerLike {
  host: string
  port: number
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingLike, res: ResponseLike) => void | Promise<void> }): () => void
}
interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_GATEWAY_TOKENS = 16_384
let persistedKey = ''
let keyLoaded = false

function readPrefs(ctx: HostCtx): LocalGatewayPrefs {
  const raw = readRoutesRootKey(ctx.get('settings'), LOCAL_GATEWAY_KEY)
  return {
    enabled: !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>).enabled === true),
  }
}

function randomKey(): string {
  const c = (globalThis as any).crypto
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(24)
    c.getRandomValues(bytes)
    let out = ''
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
    return `dsh-local-${out}`
  }
  // Sandbox fallback. The key is loopback-scoped and immediately stored in the
  // host credentials service; callers can also replace it with a stronger value.
  return `dsh-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function credentialsOf(ctx: HostCtx): CredentialsLike | undefined {
  return ctx.get('credentials') as CredentialsLike | undefined
}

async function loadPersistedKey(ctx: HostCtx): Promise<string> {
  if (keyLoaded) return persistedKey
  const credentials = credentialsOf(ctx)
  if (!credentials) return ''
  try {
    const resolved = await credentials.resolve(LOCAL_GATEWAY_CREDENTIAL_REF)
    persistedKey = typeof resolved?.value === 'string' ? resolved.value : ''
    keyLoaded = true
  } catch { /* leave unresolved so a later request may retry */ }
  return persistedKey
}

async function storePersistedKey(ctx: HostCtx, key: string): Promise<void> {
  const credentials = credentialsOf(ctx)
  if (!credentials) throw new Error('credentials 服务不可用，无法安全保存本地出口 Key')
  if (key) await credentials.set(LOCAL_GATEWAY_CREDENTIAL_REF, key)
  else if (typeof credentials.unset === 'function') await credentials.unset(LOCAL_GATEWAY_CREDENTIAL_REF)
  else await credentials.set(LOCAL_GATEWAY_CREDENTIAL_REF, '')
  persistedKey = key
  keyLoaded = true
}

function webServerOf(ctx: HostCtx): WebServerLike | undefined {
  return ctx.get('webServer') as WebServerLike | undefined
}

function endpointOf(ctx: HostCtx): string {
  const web = webServerOf(ctx)
  if (!web || !Number.isFinite(web.port)) return LOCAL_GATEWAY_PATH
  const host = web.host === '0.0.0.0' ? '127.0.0.1' : web.host
  return `http://${host}:${web.port}${LOCAL_GATEWAY_PATH}`
}

export function resetLocalGatewayRuntime(): void {
  persistedKey = ''
  keyLoaded = false
}

export async function getLocalGatewayPrefs(ctx: HostCtx) {
  const key = await loadPersistedKey(ctx)
  return {
    ok: true as const,
    prefs: readPrefs(ctx),
    hasTemporaryKey: !!key,
    endpoint: endpointOf(ctx),
  }
}

export async function setLocalGatewayPrefs(ctx: HostCtx, args?: { enabled?: boolean; temporaryKey?: string; generateKey?: boolean }) {
  const st = ctx.get('settings')
  if (!st || !checkWritable(st)) return { ok: false as const, error: '设置只读，无法保存' }
  const current = readPrefs(ctx)
  const enabled = typeof args?.enabled === 'boolean' ? args.enabled : current.enabled
  let issued: string | undefined
  if (typeof args?.temporaryKey === 'string') {
    const key = args.temporaryKey.trim()
    if (key && key.length < 16) return { ok: false as const, error: '本地出口 Key 至少需要 16 个字符' }
    try { await storePersistedKey(ctx, key) } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message || error) }
    }
    if (key) issued = key
  } else if (args?.generateKey === true) {
    const generated = randomKey()
    try { await storePersistedKey(ctx, generated) } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message || error) }
    }
    issued = generated
  }
  await writeRoutesRootKey(st, LOCAL_GATEWAY_KEY, { enabled })
  const key = await loadPersistedKey(ctx)
  return {
    ok: true as const,
    prefs: { enabled },
    hasTemporaryKey: !!key,
    endpoint: endpointOf(ctx),
    ...(issued ? { temporaryKey: issued } : {}),
  }
}

function send(res: ResponseLike, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

function openSse(res: ResponseLike): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

function sse(res: ResponseLike, data: unknown): void {
  if (typeof res.write !== 'function') throw new Error('HTTP 响应不支持流式写入')
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
}

async function readJson(req: IncomingLike): Promise<Record<string, any>> {
  let text = ''
  for await (const chunk of req) {
    text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    if (text.length > MAX_BODY_BYTES) throw new Error('请求体超过 1 MiB')
  }
  if (!text) return {}
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value
}

function bearer(req: IncomingLike): string {
  const raw = req.headers?.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, '').trim() : ''
}

/** Length-aware constant-work comparison for the configured key. */
function sameKey(candidate: string, expected: string): boolean {
  const n = Math.max(candidate.length, expected.length)
  let diff = candidate.length ^ expected.length
  for (let i = 0; i < n; i++) {
    diff |= (candidate.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0)
  }
  return diff === 0
}

function modelAddress(body: Record<string, any>): { provider: string; model: string } | null {
  const raw = typeof body.model === 'string' ? body.model.trim() : ''
  if (!raw) return null
  if (typeof body.provider === 'string' && body.provider.trim()) return { provider: body.provider.trim(), model: raw }
  const slash = raw.indexOf('/')
  if (slash > 0 && slash < raw.length - 1) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
  return { provider: ROUTER_ROUTE, model: raw }
}

function normalizeMessages(raw: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const role = typeof (item as any).role === 'string' ? (item as any).role : ''
    if (!role) return null
    const content = (item as any).content
    if (typeof content === 'string') out.push({ role, content: [{ type: 'text', text: content }] })
    else if (Array.isArray(content)) out.push({ role, content })
    else return null
  }
  return out
}

interface AdvertisedModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name?: string
  description?: string
}

/** Gather every currently advertised provider/model pair from the live LLM
 * catalog. IDs intentionally use the same `provider/model` syntax accepted by
 * chat/completions, while router models also receive a short alias because the
 * endpoint accepts a bare route name as `router/<name>`. */
async function listGatewayModels(ctx: HostCtx): Promise<AdvertisedModel[]> {
  const llm = ctx.get('llm') as any
  if (!llm || typeof llm.listConfigurableProviders !== 'function' || typeof llm.listModels !== 'function') {
    throw new Error('llm 模型目录不可用')
  }
  const providers = llm.listConfigurableProviders()
  const providerIds = Array.from(new Set((Array.isArray(providers) ? providers : [])
    .map((p: any) => typeof p?.provider === 'string' ? p.provider.trim() : '')
    .filter(Boolean))) as string[]
  // Synthetic adapters are not necessarily returned as configurable settings
  // providers, but listModels supports them and they are first-class gateway
  // targets. Try both without making one failure erase the rest of the catalog.
  for (const synthetic of [ROUTER_ROUTE, 'composite']) {
    if (!providerIds.includes(synthetic)) providerIds.push(synthetic)
  }
  const out: AdvertisedModel[] = []
  const seen = new Set<string>()
  const created = Math.floor(Date.now() / 1000)
  for (const provider of providerIds) {
    let models: any[]
    try {
      const listed = await llm.listModels(provider)
      models = Array.isArray(listed) ? listed : []
    } catch { continue }
    for (const model of models) {
      const id = typeof model === 'string' ? model : typeof model?.id === 'string' ? model.id : ''
      if (!id || id === 'placeholder') continue
      const full = `${provider}/${id}`
      if (!seen.has(full)) {
        seen.add(full)
        out.push({
          id: full,
          object: 'model',
          created,
          owned_by: provider,
          ...(typeof model?.name === 'string' ? { name: model.name } : {}),
          ...(typeof model?.description === 'string' ? { description: model.description } : {}),
        })
      }
      if (provider === ROUTER_ROUTE && !seen.has(id)) {
        seen.add(id)
        out.push({ id, object: 'model', created, owned_by: provider, name: typeof model?.name === 'string' ? model.name : id })
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export async function handleLocalGateway(ctx: HostCtx, req: IncomingLike, res: ResponseLike): Promise<void> {
  // Even when the shared Web server was deliberately bound to 0.0.0.0, this
  // plugin's outlet remains local-only. IPv4-mapped IPv6 is a normal loopback
  // representation in Node and is accepted alongside ::1/127.0.0.1.
  const remote = req.socket?.remoteAddress
  if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    send(res, 403, { error: { message: 'local connections only', type: 'permission_error' } })
    return
  }
  const prefs = readPrefs(ctx)
  const key = await loadPersistedKey(ctx)
  if (!prefs.enabled || !key) {
    send(res, 404, { error: { message: 'local gateway disabled', type: 'not_found' } })
    return
  }
  if (!sameKey(bearer(req), key)) {
    send(res, 401, { error: { message: 'invalid bearer key', type: 'authentication_error' } }, { 'www-authenticate': 'Bearer' })
    return
  }

  const rawUrl = req.url || '/'
  const queryAt = rawUrl.indexOf('?')
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)
  if (req.method === 'GET' && pathname === `${LOCAL_GATEWAY_PATH}/health`) {
    send(res, 200, { ok: true, service: 'dsh-model-pro-local-gateway' })
    return
  }
  if (req.method === 'GET' && pathname === `${LOCAL_GATEWAY_PATH}/models`) {
    try {
      send(res, 200, { object: 'list', data: await listGatewayModels(ctx) })
    } catch (error) {
      send(res, 500, { error: { message: String((error as Error)?.message || error), type: 'server_error' } })
    }
    return
  }
  if (req.method !== 'POST' || pathname !== `${LOCAL_GATEWAY_PATH}/chat/completions`) {
    send(res, 404, { error: { message: 'not found', type: 'not_found' } })
    return
  }

  let sseStarted = false
  try {
    const body = await readJson(req)
    const wantsStream = body.stream === true
    const address = modelAddress(body)
    const messages = normalizeMessages(body.messages)
    if (!address || !messages) {
      send(res, 400, { error: { message: 'model and non-empty messages are required', type: 'invalid_request_error' } })
      return
    }
    const llm = ctx.get('llm') as any
    if (!llm || typeof llm.prepareCall !== 'function') throw new Error('llm 服务不可用')
    const requested = {
      provider: address.provider,
      model: address.model,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0,
      maxTokens: typeof body.max_tokens === 'number'
        ? Math.max(1, Math.min(MAX_GATEWAY_TOKENS, Math.floor(body.max_tokens)))
        : 1024,
      ...(typeof body.reasoning_effort === 'string' ? { reasoningEffort: body.reasoning_effort } : {}),
    }
    const prepared = await llm.prepareCall(requested)
    const pc = prepared?.config && typeof prepared.config === 'object' ? prepared.config : requested
    let text = ''
    let finishReason = 'stop'
    let inputTokens = 0
    let outputTokens = 0
    const responseId = `chatcmpl-local-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    if (wantsStream) {
      openSse(res)
      sseStarted = true
      sse(res, {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })
    }
    const stream = prepared.stream({ ...pc, messages, sessionId: typeof body.user === 'string' ? body.user : 'local-gateway' })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (wantsStream) sse(res, {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
        })
      }
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && wantsStream) {
        sse(res, {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }],
        })
      }
      if (chunk?.type === 'usage' && chunk.usage) {
        inputTokens = Number(chunk.usage.inputTokens ?? chunk.usage.input_tokens ?? inputTokens) || 0
        outputTokens = Number(chunk.usage.outputTokens ?? chunk.usage.output_tokens ?? outputTokens) || 0
      }
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        if (reason && typeof reason === 'object' && reason.kind === 'error') throw new Error(errorText(reason.failure ?? reason.message))
        if (typeof reason === 'string') finishReason = reason
        else if (reason && typeof reason.kind === 'string') finishReason = reason.kind
      }
    }
    const usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
    if (wantsStream) {
      sse(res, {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage,
      })
      sse(res, '[DONE]')
      res.end()
      return
    }
    send(res, 200, {
      id: responseId,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
      usage,
    })
  } catch (error) {
    const payload = { error: { message: errorText(error), type: 'server_error' } }
    // Once SSE headers/chunks have started, changing the HTTP status is invalid.
    // Emit an OpenAI-shaped error event and terminate the stream instead.
    try {
      if (sseStarted && typeof res.write === 'function') {
        sse(res, payload)
        sse(res, '[DONE]')
        res.end()
        return
      }
    } catch { /* fall back to a regular JSON error when nothing was committed */ }
    send(res, 500, payload)
  }
}

export function registerLocalGateway(ctx: HostCtx): void {
  const web = webServerOf(ctx)
  const c = ctx as any
  if (!web || typeof web.register !== 'function' || typeof c.effect !== 'function') return
  c.effect(() => web.register({
    kind: 'prefix',
    path: LOCAL_GATEWAY_PATH,
    handler: (req: IncomingLike, res: ResponseLike) => handleLocalGateway(ctx, req, res),
  }), 'dsh-model-pro: local agent gateway')
}
