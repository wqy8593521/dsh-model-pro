/** Observability handlers — probe health, route/target stats, request log.
 *
 * The smart-routing page's ④ 观测台 pulls from:
 *   - `get-route-stats`   : aggregated stats (byRoute/byTarget) + probe health
 *   - `list-request-logs` : bounded in-memory request-log ring
 *   - `probe-target`      : run one live probe against a target, update health
 *
 * Stats accumulate in memory during the session (shared ring + snapshot built
 * by the stats recorder); the probe-health snapshot is mirrored into settings
 * so the page can show last-known status across page reloads. */

import type { HostCtx } from '../utils'
import { getLogRing, getStatsRecorder, persistStats } from '../statsStore'
import { readProviders, readDisabled, readRoutesRootKey } from '../utils'
import { getHealthTracker } from '../health'
import { errorText } from '../errorText'

/** Recursively drop `undefined` values (arrays/objects) so the result is
 * lossless JSON: the cordis host->client RPC boundary rejects `undefined`
 * (and class instances / Map / Set / Date). Health entries keep optional
 * fields as `undefined` in memory (lastError, lastProbeAt, latencyMs), so the
 * table must be sanitized before it crosses to the client half. */
function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = jsonSafe(v)
    }
    return out as unknown as T
  }
  return value
}

export async function getRouteStats(ctx: HostCtx) {
  const rec = getStatsRecorder()
  return jsonSafe({
    ok: true as const,
    byRoute: rec.byRoute(),
    byTarget: rec.byTarget(),
    health: getHealthTracker(ctx).table(),
  })
}

export async function listRequestLogs(ctx: HostCtx, args?: { limit?: number; route?: string; status?: string; sessionId?: string }) {
  const route = typeof args?.route === 'string' ? args.route.trim() : ''
  const status = typeof args?.status === 'string' ? args.status.trim() : ''
  const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
  let entries = getLogRing().entries()
  if (route) entries = entries.filter((e) => e.route === route || e.target.provider === route)
  if (status) entries = entries.filter((e) => e.status === status)
  // Exact session match when provided (the conversation badge uses this to
  // correlate a turn's calls with the targets that actually served them).
  if (sessionId) entries = entries.filter((e) => e.sessionId === sessionId)
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : 200
  return jsonSafe({ ok: true as const, entries: entries.slice(-limit) })
}

export async function clearRequestLogs(ctx?: HostCtx) {
  getLogRing().clear()
  getStatsRecorder().reset()
  // Persist the cleared state immediately so a reload does not resurrect the
  // logs/stats from the last snapshot.
  if (ctx) await persistStats(ctx, { force: true })
  return { ok: true as const }
}

export async function probeTarget(ctx: HostCtx, args: { provider?: string; model?: string; prompt?: string }) {
  const llm = ctx.get('llm')
  const st = ctx.get('settings')
  if (llm === undefined) return { ok: false as const, error: 'llm 服务不可用' }

  const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
  const model = typeof args?.model === 'string' ? args.model.trim() : ''
  if (!provider || !model) return { ok: false as const, error: '缺少 provider 或 model' }

  const providers = readProviders(st)
  const disabled = readDisabled(st)
  if (Object.prototype.hasOwnProperty.call(disabled, provider))
    return { ok: false as const, error: `提供商 "${provider}" 已禁用，无法探测` }
  if (!Object.prototype.hasOwnProperty.call(providers, provider))
    return { ok: false as const, error: `提供商 "${provider}" 不存在或未启用` }

  const h = getHealthTracker(ctx)
  h.markProbing(provider, model)

  const timer = ctx.get('timer') as { timeout?: (fn: () => void, ms: number) => () => void } | undefined
  const t0 = Date.now()
  let cancelDeadline: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    if (timer && typeof timer.timeout === 'function') cancelDeadline = timer.timeout(() => reject(new Error('探测超时')), 15000)
  })

  const run = (async () => {
    // Tiny completion call through the full credential/header/protocol pipeline.
    // The stream() config must match `prepared.config` on the fields DSH compares
    // (provider/model/temperature/maxTokens/reasoningEffort/stop) or the pipeline
    // throws "prepared LLM call config changed before adapter dispatch" — the
    // resolver may clamp/normalize our request, so echo prepared.config back.
    const prepared = await (llm as any).prepareCall({ provider, model, maxTokens: 4, temperature: 0 })
    const pc = (prepared && typeof prepared === 'object' && prepared.config && typeof prepared.config === 'object')
      ? prepared.config as { provider?: string; model?: string; temperature?: number; maxTokens?: number; reasoningEffort?: unknown; stop?: string[] }
      : {}
    const stream = prepared.stream({
      provider: typeof pc.provider === 'string' ? pc.provider : provider,
      model: typeof pc.model === 'string' ? pc.model : model,
      temperature: typeof pc.temperature === 'number' ? pc.temperature : 0,
      maxTokens: typeof pc.maxTokens === 'number' ? pc.maxTokens : 4,
      ...(pc.reasoningEffort !== undefined ? { reasoningEffort: pc.reasoningEffort } : {}),
      ...(Array.isArray(pc.stop) ? { stop: pc.stop } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })
    let stopReason = ''
    for await (const chunk of stream as any) {
      if (chunk && typeof chunk === 'object' && chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason && typeof reason === 'object' && reason.kind === 'error') {
          const msg = errorText(reason.failure ?? reason.message, '探测失败')
          throw new Error(msg)
        }
        stopReason = typeof reason === 'string' ? reason : (reason && typeof reason.kind === 'string' ? reason.kind : '')
      }
    }
    return { ok: true as const, provider, model, latencyMs: Date.now() - t0, stopReason }
  })()
  run.catch(() => { /* swallow late rejection after deadline win */ })

  try {
    const r = await Promise.race([run, deadline])
    h.markUp(provider, model, r.latencyMs)
    return r
  } catch (err) {
    const msg = errorText(err, '探测失败')
    h.markDown(provider, model, msg)
    return { ok: false as const, provider, model, error: msg }
  } finally {
    if (typeof cancelDeadline === 'function') cancelDeadline()
  }
}

/** Run a probe sweep across every route target + composite member (batch
 * "探测全部"). Awaits the whole sweep so the caller can refresh once it
 * resolves — the client no longer needs a timer to guess when results land
 * (browser timer globals are unavailable to a dynamic client half). Each
 * probeTarget is already bounded by its own 15s deadline. */
export async function probeAll(ctx: HostCtx) {
  const targets = collectProbeTargets(ctx)
  // Probe sequentially to avoid bursting hosts; each has its own timeout.
  for (const t of targets) {
    await probeTarget(ctx, t)
  }
  return { ok: true as const, started: true, probed: targets.length }
}

function collectProbeTargets(ctx: HostCtx): Array<{ provider: string; model: string }> {
  const out: Array<{ provider: string; model: string }> = []
  const st = ctx.get('settings')
  // `routes` lives in this plugin's OWN section: it is not part of llm-pi-ai's
  // schema, so on 0.2 it is neither writable nor even readable from there.
  const routesRaw = (st === undefined ? undefined : readRoutesRootKey(st, 'routes')) as
    | Record<string, { targets?: Array<{ provider: string; model: string }> }>
    | undefined
  if (routesRaw && typeof routesRaw === 'object') {
    for (const spec of Object.values(routesRaw)) {
      if (spec && Array.isArray(spec.targets)) {
        for (const t of spec.targets) {
          if (t?.provider && t?.model) out.push({ provider: t.provider, model: t.model })
        }
      }
    }
  }
  const compositesRaw = (st === undefined ? undefined : readRoutesRootKey(st, 'composites')) as
    | Record<string, { members?: string[] }>
    | undefined
  if (compositesRaw && typeof compositesRaw === 'object') {
    const providers = readProviders(st)
    for (const spec of Object.values(compositesRaw)) {
      if (spec && Array.isArray(spec.members)) {
        for (const m of spec.members) {
          const p = providers[m]
          if (p && Array.isArray(p.models)) {
            for (const me of p.models) {
              if (me && typeof me === 'object' && typeof (me as { id?: unknown }).id === 'string') {
                out.push({ provider: m, model: (me as { id: string }).id })
              }
            }
          }
        }
      }
    }
  }
  // Dedupe.
  const seen = new Set<string>()
  return out.filter((t) => {
    const k = `${t.provider}\u0000${t.model}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}