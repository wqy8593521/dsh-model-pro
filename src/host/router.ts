/** Smart-routing router adapter — the dispatch engine.
 *
 * Registers TWO synthetic provider routes:
 *   - `router`    : models are the NAMED routes from llm-pi-ai[routes]
 *                   (strategy + targets + weights + config)
 *   - `composite` : models are encoded `compositeName::modelId` combos from
 *                   llm-pi-ai[composites] (union / intersection merges)
 *
 * At call time the adapter picks targets by the route's strategy, honours
 * weights, skips probe-down targets when `healthAware`, respects `maxFallbacks`,
 * pins sessions when `sticky`, and records outcome + tokens into the stats
 * recorder / health tracker. Every target is resolved to its wire id
 * (`requestModel` mapping) before forwarding, same as the llm/stream rewrite.
 *
 * Chunks, message blocks, and finish reasons pass through untouched — forwards
 * are a transparent pipe. The table is read LIVE per call — editing a route or
 * composite never requires re-registering.
 */

import type { HostCtx } from './utils'
import { readRoutes, wireModelOf } from './utils'
import { ROUTER_ROUTE, COMPOSITE_ROUTE, COMPOSITE_SEP, DEFAULT_ROUTE_STRATEGY, ROUTE_EXHAUSTED_CODE } from '../shared/constants'
import type { RouteSpec, RouteTarget, RouteStrategy, TargetHealth } from '../shared/types'
import { readComposites, decodeCompositeModel, compositeTargetsFor, resolveCompositeModels } from './composite'
import { getHealthTracker } from './health'
import { getStatsRecorder } from './statsStore'
import { buildRouterRetryPolicy } from './retryPolicy'

type LlmLike = {
  registerAdapter(providers: string[], adapter: unknown): (() => void) & {
    /** Swap the registered route set (and re-read the adapter's retry policy).
     * Present since dsh-llm rc.7; guarded at the call site regardless. */
    replace?: (providers: string[]) => void
  }
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<{
    config?: Record<string, unknown>
    stream: (options: Record<string, unknown>) => AsyncIterable<Record<string, any>>
  }>
}

function llmOf(ctx: HostCtx): LlmLike | undefined {
  return ctx.get('llm') as unknown as LlmLike | undefined
}

function firstErrorFrom(chunk: Record<string, any>): string | undefined {
  if (!chunk || chunk.type !== 'finish') return undefined
  const reason = chunk.reason
  if (reason && typeof reason === 'object') {
    if (reason.kind === 'error') {
      return String((reason.failure && reason.failure.message) || reason.message || '未知错误')
    }
  }
  return undefined
}

/** Chunks that prove a target is actually producing output. Real pi-ai
 * adapters NEVER throw for an unreachable provider — they yield a harmless
 * `usage` chunk followed by a terminal error finish. So the only trustworthy
 * "this target works" signal is visible progress: a content delta. */
const PROGRESS_CHUNK_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])

function isProgressChunk(chunk: unknown): boolean {
  return !!chunk && typeof chunk === 'object' && PROGRESS_CHUNK_TYPES.has((chunk as Record<string, any>).type)
}

function isFinishChunk(chunk: unknown): boolean {
  return !!chunk && typeof chunk === 'object' && (chunk as Record<string, any>).type === 'finish'
}

/** Pull one chunk, racing an optional per-attempt deadline (ms since epoch).
 * The losing timer is defused so no unhandled rejection leaks; the underlying
 * iterator stays alive and is closed by the caller via tryReturn(). */
async function nextWithDeadline(
  iterator: AsyncIterator<unknown>,
  deadlineMs: number,
): Promise<IteratorResult<unknown>> {
  if (!Number.isFinite(deadlineMs)) return iterator.next()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    const wait = Math.max(0, deadlineMs - Date.now())
    timer = setTimeout(() => reject(new Error('__mpro_attempt_timeout__')), wait)
  })
  timeout.catch(() => { /* defuse when the race is won by next() */ })
  try {
    return await Promise.race([iterator.next(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function buildCallConfig(target: RouteTarget, wire: string, options: Record<string, any>): Record<string, unknown> {
  const c: Record<string, unknown> = { provider: target.provider, model: wire }
  if (options.reasoningEffort !== undefined) c.reasoningEffort = options.reasoningEffort
  if (options.temperature !== undefined) c.temperature = options.temperature
  if (options.maxTokens !== undefined) c.maxTokens = options.maxTokens
  if (options.stop !== undefined) c.stop = options.stop
  return c
}

function buildTargetOptions(callConfig: Record<string, unknown>, options: Record<string, any>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...callConfig, messages: options.messages }
  if (options.system !== undefined) o.system = options.system
  if (options.tools !== undefined) o.tools = options.tools
  if (options.signal !== undefined) o.signal = options.signal
  if (options.sessionId !== undefined) o.sessionId = options.sessionId
  if (options.purpose !== undefined) o.purpose = options.purpose
  return o
}

/** Usage tokens from a `usage` (or finish) chunk (adapter-optional; best
 * effort). The real DSH stream emits a `{ type: 'usage', usage: TokenUsage }`
 * chunk whose fields are camelCase (`inputTokens` / `outputTokens`, per
 * `@deepseek-ai/dsh-llm`'s `TokenUsage`, which pi-ai's `mapUsage` fills). Older
 * / raw OpenAI-style snake_case names are accepted as a fallback so a
 * non-standard adapter still counts. */
function tokensFrom(chunk: Record<string, any>): { in?: number; out?: number } {
  const u = chunk && chunk.usage
  if (!u || typeof u !== 'object') return {}
  const out: { in?: number; out?: number } = {}
  // Canonical DSH TokenUsage shape (camelCase) — the production path.
  if (typeof u.inputTokens === 'number') out.in = u.inputTokens
  if (typeof u.outputTokens === 'number') out.out = u.outputTokens
  // Raw provider shapes (snake_case) — accepted as a fallback.
  if (out.in === undefined && typeof u.prompt_tokens === 'number') out.in = u.prompt_tokens
  if (out.in === undefined && typeof u.input_tokens === 'number') out.in = u.input_tokens
  if (out.out === undefined && typeof u.completion_tokens === 'number') out.out = u.completion_tokens
  if (out.out === undefined && typeof u.output_tokens === 'number') out.out = u.output_tokens
  return out
}

/* --------------------------------------------------------------------------
 * Strategy ordering
 * ------------------------------------------------------------------------ */

/** Rotated copy of targets starting at `start` so fallbacks walk a stable cycle. */
function rotate<T>(arr: T[], start: number): T[] {
  if (!arr.length) return arr
  const i = ((start % arr.length) + arr.length) % arr.length
  return arr.slice(i).concat(arr.slice(0, i))
}

/** Deterministic weighted pick -> `start` index (smooth weighted round robin). */
function weightedStart(targets: RouteTarget[], cursor: Record<string, number[]>, route: string): number {
  const weights = targets.map((t) => (typeof t.weight === 'number' && t.weight > 0 ? t.weight : 1))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return Math.floor(Math.random() * targets.length)
  // Smooth weighted round-robin: keep a per-route current-weight vector.
  const cur = cursor[route] || (cursor[route] = weights.slice())
  if (cur.length !== weights.length) cursor[route] = weights.slice()
  let best = 0
  for (let j = 1; j < weights.length; j++) {
    if ((cursor[route] as number[])[j] > (cursor[route] as number[])[best]) best = j
  }
  const current = cursor[route] as number[]
  current[best] -= total
  for (let j = 0; j < weights.length; j++) current[j] += weights[j]
  return best
}

/** Build the ordered candidate list for a strategy, returning `{order, cursorKey}`. */
function orderTargets(
  spec: RouteSpec,
  targets: RouteTarget[],
  health: { entry(p: string, m: string): TargetHealth | undefined },
  cursor: Record<string, number[]>,
  cursorKey: string,
  options: Record<string, any>,
): RouteTarget[] {
  const strategy: RouteStrategy = spec.strategy || DEFAULT_ROUTE_STRATEGY
  const targetsArr = targets.filter((t) => t.enabled !== false)

  switch (strategy) {
    case 'priority':
      return targetsArr
    case 'weighted':
    case 'round-robin': {
      const start = weightedStart(targetsArr, cursor, cursorKey)
      return rotate(targetsArr, start)
    }
    case 'min-latency': {
      const withLat = targetsArr.map((t, i) => {
        const e = health.entry(t.provider, t.model)
        const lat = e && typeof e.latencyMs === 'number' ? e.latencyMs : Number.MAX_SAFE_INTEGER
        return { t, lat, i }
      })
      withLat.sort((a, b) => (a.lat === b.lat ? a.i - b.i : a.lat - b.lat))
      return withLat.map((x) => x.t)
    }
    case 'sticky': {
      // Actual session pinning is applied by the stream loop (which owns the
      // pin map); here sticky behaves as priority-order fallback for previews.
      return targetsArr
    }
    default:
      return targetsArr
  }
}

/** Expose the picker (used by tests / future preview). */
export function computeTargetOrder(
  spec: RouteSpec,
  targets: RouteTarget[],
  health: { entry(p: string, m: string): TargetHealth | undefined },
  options: Record<string, any>,
  cursor: Record<string, number[]> = {},
  cursorKey = spec.strategy,
): RouteTarget[] {
  return orderTargets(spec, targets, health, cursor, cursorKey, options)
}

/* --------------------------------------------------------------------------
 * The adapter
 * ------------------------------------------------------------------------ */

export function makeRouterAdapter(ctx: HostCtx): unknown {
  const llm = llmOf(ctx)
  const st = () => ctx.get('settings')
  const health = () => getHealthTracker(ctx)
  const stats = () => getStatsRecorder()

  /** Resolve a named route spec from storage (routes table). */
  const routeOf = (name: string): RouteSpec | undefined => {
    const spec = readRoutes(st())[name]
    if (!spec || typeof spec !== 'object') return undefined
    const targets = Array.isArray(spec.targets)
      ? spec.targets
          .filter((t): t is RouteTarget => !!t && typeof t === 'object' && typeof t.provider === 'string' && typeof t.model === 'string')
          .map((t) => ({ provider: t.provider, model: t.model, ...(typeof t.weight === 'number' ? { weight: t.weight } : {}), ...(typeof t.enabled === 'boolean' ? { enabled: t.enabled } : {}) }))
      : []
    if (!targets.length) return undefined
    return { strategy: spec.strategy || DEFAULT_ROUTE_STRATEGY, targets, ...(spec.config ? { config: spec.config } : {}) }
  }

  /** Resolve targets + strategy for a composite model id. */
  const compositePlan = (model: string): { spec: RouteSpec; routeName: string } | undefined => {
    const dec = decodeCompositeModel(model)
    if (!dec) return undefined
    const comp = readComposites(ctx)[dec.composite]
    if (!comp) return undefined
    const targets = compositeTargetsFor(ctx, dec.composite, dec.model)
    if (!targets.length) return undefined
    const spec: RouteSpec = { strategy: comp.strategy || DEFAULT_ROUTE_STRATEGY, targets }
    return { spec, routeName: `${dec.composite}::${dec.model}` }
  }

  /** 24h-ish cursor key for round-robin/weighted state (per route identity). */
  const cursor: Record<string, number[]> = {}
  const pin: Record<string, RouteTarget> = {}

  // Bound to a const so `prepareCall` can delegate to the sibling methods
  // without relying on `this` (the object is handed to the llm runtime, which
  // may destructure or re-bind it).
  const adapter = {
    providerInfo(provider: string) {
      return { id: provider, name: provider === COMPOSITE_ROUTE ? '组合提供商' : '智能路由' }
    },
    /** DSH's OWN request-retry budget for this synthetic route, read once when
     * the adapter registers (see `applyRetryPrefs` for how an edit takes
     * effect). `undefined` means "use DSH's defaults", which is what a zero
     * budget resolves to. */
    providerRetryPolicy() {
      return buildRouterRetryPolicy(ctx)
    },
    /** Provider-side request-image pricing for one exact route — added to the
     * adapter contract in `@deepseek-ai/dsh-llm` 0.1.2-alpha.1, where the
     * runtime forwards it WITHOUT an existence check:
     *
     *   return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
     *
     * The `?.` only guards an unregistered provider, so an adapter missing the
     * method throws `TypeError`. `token-meter` calls it unconditionally on every
     * `measure()` (image or not), and `compaction-basic` calls `measure()`
     * without a try/catch — both mounted in the base bundle — so a smart-routing
     * session would die once anything measured tokens.
     *
     * `undefined` is the base-class answer and the honest one for a virtual
     * route: pricing belongs to whichever target actually serves the request,
     * and consumers fall back to their own neutral estimate. */
    imageRequestPricing() {
      return undefined
    },
    async listModels(provider: string) {
      const out: Array<{ provider: string; id: string; name: string; description?: string }> = []
      if (provider === COMPOSITE_ROUTE) {
        for (const name of Object.keys(readComposites(ctx))) {
          const res = await resolveCompositeModels(ctx, name)
          if (!res.ok) continue
          for (const id of res.ids) {
            out.push({ provider, id: `${name}${COMPOSITE_SEP}${id}`, name: id, description: `${name} · ${res.mode}` })
          }
        }
        return dedupeModels(out)
      }
      // router route
      const routes = readRoutes(st())
      for (const name of Object.keys(routes)) {
        const spec = routeOf(name)
        if (!spec) continue
        out.push({ provider, id: name, name, description: `${spec.strategy} · ${spec.targets.length} 个目标` })
      }
      return out
    },
    async resolveModel(provider: string, model: string, signal?: AbortSignal) {
      const base = { provider, id: model, name: model }
      let spec: RouteSpec | undefined
      if (provider === COMPOSITE_ROUTE) {
        const plan = compositePlan(model)
        if (plan) spec = plan.spec
      } else {
        spec = routeOf(model)
      }
      if (!spec || !llm || !spec.targets.length) return base
      const first = spec.targets[0]
      try {
        const wire = wireModelOf(st(), first.provider, first.model)
        const info = await llm.resolveModelInfo(first.provider, wire, signal)
        return { ...info, provider, id: model, name: model }
      } catch {
        return base
      }
    },
    /** Bind exact model metadata and the eventual dispatch to one adapter
     * generation — the contract `@deepseek-ai/dsh-llm` >= 0.1.1-rc.2 calls from
     * BOTH its prepared-call and direct-stream paths (`registration.adapter
     * .prepareCall(...)`), where a missing method fails the request outright.
     *
     * Older runtimes (<= 0.1.1-rc.1) never call this and keep using
     * `resolveModel` + `stream` directly, so defining it is purely additive:
     * one build serves both. The shape mirrors `LlmAdapter`'s own default —
     * resolve the model, hand back a stream entry point — because the router
     * reads its table live per call and has no generation state to pin. */
    async prepareCall(provider: string, model: string, signal?: AbortSignal) {
      return {
        model: await adapter.resolveModel(provider, model, signal),
        stream: (options: Record<string, any>) => adapter.stream(options),
      }
    },
    async *stream(options: Record<string, any>): AsyncIterable<unknown> {
      const provider = options.provider
      const model = options.model

      let spec: RouteSpec | undefined
      let routeName = model
      if (provider === COMPOSITE_ROUTE) {
        const plan = compositePlan(model)
        if (plan) { spec = plan.spec; routeName = plan.routeName }
      } else {
        spec = routeOf(model)
      }
      if (!spec || !llm) throw new Error(`智能路由「${model}」未配置或没有可用目标`)

      const healthAware = spec.config?.healthAware !== false
      const maxFallbacks = typeof spec.config?.maxFallbacks === 'number' && spec.config.maxFallbacks >= 0
        ? Math.floor(spec.config.maxFallbacks)
        : spec.targets.length

      // Healthy + enabled candidate list (skip probe-down unless everything is).
      const candidates = spec.targets.filter((t) => t.enabled !== false)
      const healthFiltered = healthAware
        ? candidates.filter((t) => health().isHealthy(t.provider, t.model))
        : candidates
      const pool = healthFiltered.length ? healthFiltered : candidates
      if (!pool.length) throw new Error(`智能路由「${model}」全部目标失败：无可用目标`)

      const ordered = orderTargets(spec, pool, health(), cursor, routeName, options)
      const attemptList = ordered.slice(0, maxFallbacks)

      const sid = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : ''
      const pinKey = sid ? `${routeName}\u0000${sid}` : ''
      // Sticky pin: reuse the last successful target of this session when healthy.
      const pinned = pin[pinKey]
      if (pinned && attemptList.some((t) => t.provider === pinned.provider && t.model === pinned.model) && health().isHealthy(pinned.provider, pinned.model)) {
        attemptList.sort((a, b) => {
          const ap = a.provider === pinned.provider && a.model === pinned.model ? 0 : 1
          const bp = b.provider === pinned.provider && b.model === pinned.model ? 0 : 1
          return ap - bp
        })
      }

      const t0 = Date.now()
      let lastErr = ''
      let tryIndex = 0
      let committed = false
      // Per-attempt time-to-first-progress budget (RouteConfig.timeoutMs).
      // 0/undefined = wait indefinitely (pi-ai's own idle watchdog still bounds hangs).
      const attemptTimeoutMs =
        typeof spec.config?.timeoutMs === 'number' && spec.config.timeoutMs > 0 ? spec.config.timeoutMs : 0

      for (const target of attemptList) {
        tryIndex += 1
        const wire = wireModelOf(st(), target.provider, target.model)
        const attemptStart = Date.now()
        try {
          const callConfig = buildCallConfig(target, wire, options)
          const prepared = await llm.prepareCall(callConfig, options.signal)
          // The resolver may clamp/normalize the config (e.g. a model maxTokens
          // cap). DSH compares stream() options against `prepared.config` on
          // provider/model/temperature/maxTokens/reasoningEffort/stop and throws
          // "prepared LLM call config changed before adapter dispatch" on drift,
          // so dispatch with the RESOLVED config, not our requested one.
          const resolvedConfig = (prepared && typeof (prepared as any).config === 'object' && (prepared as any).config)
            ? (prepared as any).config as Record<string, unknown>
            : callConfig
          const iterator = prepared.stream(buildTargetOptions(resolvedConfig, options))[Symbol.asyncIterator]()

          // ---- Pre-commit probe: buffer chunks until the target PROVES it can
          // serve this request (a content delta), or fails cleanly. A dead
          // provider surfaces here as [usage] then finish(error) — or a throw —
          // never touching the consumer, so switching is seamless.
          const buffered: Array<Record<string, any>> = []
          let progressChunk: Record<string, any> | undefined
          let terminal: Record<string, any> | undefined
          let endedEmpty = false
          const deadline = attemptTimeoutMs > 0 ? attemptStart + attemptTimeoutMs : Infinity

          while (progressChunk === undefined && terminal === undefined) {
            let item
            try {
              item = await nextWithDeadline(iterator, deadline)
            } catch (error) {
              // Caller cancellation must never be retried against another
              // target — surface the abort and stop.
              if (options.signal?.aborted) {
                void tryReturn(iterator)
                yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已被调用方中止', code: 'ABORTED' } } }
                return
              }
              // Fire-and-forget close: the underlying generator may still have
              // an in-flight next() parked on a hung socket — awaiting its
              // return() would stall this attempt past the deadline itself.
              void tryReturn(iterator)
              const timedOut = String((error as Error)?.message || error) === '__mpro_attempt_timeout__'
              const why = timedOut ? `连接超时（${attemptTimeoutMs}ms 内无响应）` : '连接失败'
              health().markDown(target.provider, target.model, why)
              stats().record({
                route: routeName, provider: target.provider, model: wire, ok: false,
                latencyMs: Date.now() - attemptStart, tryIndex, sessionId: sid,
                error: `目标 ${target.provider}/${wire} ${why}`,
              })
              lastErr = `目标 ${target.provider}/${wire}: ${why}`
              break
            }
            if (item.done) { endedEmpty = true; break }
            const chunk = item.value as Record<string, any>
            if (isFinishChunk(chunk)) { terminal = chunk; break }
            buffered.push(chunk)
            if (isProgressChunk(chunk)) { progressChunk = chunk; break }
          }

          // Pre-commit failure → try the next target.
          if (progressChunk === undefined && (terminal === undefined || firstErrorFrom(terminal) !== undefined)) {
            if (terminal === undefined) {
              // Throw / timeout / empty-stream path (loop exited without progress).
              if (!endedEmpty) continue // already handled (throw/timeout recorded)
              health().markDown(target.provider, target.model, '空响应')
              stats().record({
                route: routeName, provider: target.provider, model: wire, ok: false,
                latencyMs: Date.now() - attemptStart, tryIndex, sessionId: sid,
                error: `目标 ${target.provider}/${wire} 空响应`,
              })
              lastErr = `目标 ${target.provider}/${wire}: 空响应`
              continue
            }
            // A terminal finish arrived with zero visible output.
            const errText = firstErrorFrom(terminal)
            if (typeof errText === 'string') {
              // Real failure from the provider — switch to the next target.
              // (Caller aborts surface as kind 'aborted', which firstErrorFrom
              // does not match — they fall through to the commit path below and
              // propagate verbatim, so a cancel is never retried elsewhere.)
              await tryReturn(iterator)
              health().markDown(target.provider, target.model, errText)
              stats().record({
                route: routeName, provider: target.provider, model: wire, ok: false,
                latencyMs: Date.now() - attemptStart, tryIndex, sessionId: sid,
                error: `目标 ${target.provider}/${wire}: ${errText}`,
              })
              lastErr = `目标 ${target.provider}/${wire}: ${errText}`
              continue
            }
            // A clean stop/max-tokens/tool-calls finish with no content at all:
            // pass it through rather than spinning every target on an empty answer.
          }

          // ---- Committed to this target — replay buffered chunks, then drain.
          health().markUp(target.provider, target.model, Date.now() - attemptStart)
          committed = true
          if (pinKey) pin[pinKey] = target

          let tokens: { in?: number; out?: number } = {}
          for (const c of buffered) {
            const tk = tokensFrom(c)
            if (tk.in !== undefined) tokens.in = tk.in
            if (tk.out !== undefined) tokens.out = tk.out
            yield c
          }
          if (terminal !== undefined) {
            // Committed-but-terminal (empty success or caller abort): forward
            // the terminal chunk, record, stop — no further targets.
            stats().record({
              route: routeName, provider: target.provider, model: wire, ok: true,
              latencyMs: Date.now() - t0, tokensIn: tokens.in, tokensOut: tokens.out,
              tryIndex, sessionId: sid, status: tryIndex > 1 ? 'fallback' : 'ok',
            })
            yield terminal
            return
          }
          // Drain the committed stream. A provider can still die MID-STREAM
          // (e.g. a gateway that accepts the connection then answers 500):
          // pi-ai delivers that as a terminal error finish, which passes
          // through to the consumer (content already shown — switching now
          // would duplicate/mix output), but the bookkeeping must tell the
          // truth: the log entry is an ERROR, and the target is marked down
          // so the agent-loop's model retry prefers another target.
          let terminalReason: Record<string, any> | undefined
          while (true) {
            let item
            try {
              item = await iterator.next()
            } catch (error) {
              health().markDown(target.provider, target.model, String((error as Error)?.message || error))
              stats().record({
                route: routeName, provider: target.provider, model: wire, ok: false,
                latencyMs: Date.now() - t0, tryIndex, sessionId: sid,
                error: `传输中断: ${String((error as Error)?.message || error)}`,
              })
              throw new Error(`目标 ${target.provider}/${wire} 传输中断: ${String((error as Error)?.message || error)}`)
            }
            if (item.done) {
              const reason = terminalReason && typeof terminalReason === 'object' ? terminalReason : undefined
              const errText = reason && reason.kind === 'error'
                ? String((reason.failure && reason.failure.message) || (reason as any).message || '未知错误')
                : undefined
              const aborted = !!reason && reason.kind === 'aborted'
              if (errText !== undefined) {
                health().markDown(target.provider, target.model, errText)
                stats().record({
                  route: routeName, provider: target.provider, model: wire, ok: false,
                  latencyMs: Date.now() - t0, tokensIn: tokens.in, tokensOut: tokens.out,
                  tryIndex, sessionId: sid,
                  error: `目标 ${target.provider}/${wire} 中途返回错误: ${errText}`,
                })
              } else {
                stats().record({
                  route: routeName, provider: target.provider, model: wire, ok: aborted ? false : true,
                  latencyMs: Date.now() - t0, tokensIn: tokens.in, tokensOut: tokens.out,
                  tryIndex, sessionId: sid, status: tryIndex > 1 ? 'fallback' : 'ok',
                  ...(aborted ? { error: '已中止' } : {}),
                })
              }
              return
            }
            const chunk = item.value as Record<string, any>
            if (isFinishChunk(chunk)) terminalReason = (chunk as any).reason
            const tk = tokensFrom(chunk)
            if (tk.in !== undefined) tokens.in = tk.in
            if (tk.out !== undefined) tokens.out = tk.out
            yield chunk
          }
        } catch (error) {
          // prepareCall / dispatch failure for this target — but a caller abort
          // ends the whole route instead of moving on.
          if (options.signal?.aborted) return
          stats().record({
            route: routeName, provider: target.provider, model: wire, ok: false,
            latencyMs: Date.now() - t0, tryIndex, sessionId: sid,
            error: String((error as Error)?.message || error),
          })
          lastErr = `目标 ${target.provider}/${wire}: ${String((error as Error)?.message || error)}`
        }
      }

      if (!committed) {
        // Final report for the aggregate failure. The code matters: DSH's retry
        // executor only retries failures whose code the provider's policy lists
        // as retryable, and a plain Error normalizes to `UNKNOWN` — which no
        // policy lists — so route exhaustion could never be retried.
        //
        // `normalizeLlmFailure` trusts a carried failure ONLY when the error's
        // own `code` and own `failure.code` agree, so both are set to the same
        // value; anything else is discarded and falls back to `UNKNOWN`.
        throw routeExhausted(`智能路由「${model}」全部目标失败：${lastErr || '无可用目标'}`)
      }
    },
  }
  return adapter
}

/** Build the error thrown when every eligible target has failed.
 *
 * Carries {@link ROUTE_EXHAUSTED_CODE} in the exact shape
 * `normalizeLlmFailure` (dsh-llm) accepts: it reads the error's OWN `code` and
 * OWN `failure` data properties and trusts the carried snapshot only when
 * `failure.code === code`. A mismatch — or a plain Error — degrades to
 * `UNKNOWN`, which no retry policy lists, making the failure unretryable. */
function routeExhausted(message: string): Error {
  const error = new Error(message)
  Object.defineProperties(error, {
    code: { value: ROUTE_EXHAUSTED_CODE, enumerable: false, configurable: true, writable: true },
    failure: {
      value: Object.freeze({ message, code: ROUTE_EXHAUSTED_CODE }),
      enumerable: false,
      configurable: true,
      writable: true,
    },
  })
  return error
}

async function tryReturn(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    if (typeof iterator.return === 'function') await iterator.return()
  } catch { /* best effort */ }
}

function dedupeModels(arr: Array<{ provider: string; id: string; name: string; description?: string }>) {
  const seen = new Set<string>()
  return arr.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}

/** The live registration handle, kept so a retry-budget edit can re-register.
 *
 * DSH freezes a provider's retry policy when the adapter registers, so a new
 * budget is invisible until the registration is replaced. `handle.replace(...)`
 * re-runs `prepareRoutes`, which re-reads `providerRetryPolicy()`. */
let liveRegistration: { replace?: (providers: string[]) => void } | undefined

/** Re-register the router adapter so a changed retry budget takes effect now.
 *
 * @returns true when the running registration picked up the new policy; false
 *          when it could not (no registration yet, or a runtime without
 *          `handle.replace`), in which case the budget still applies after the
 *          next plugin load.
 */
export function applyRetryPrefs(_ctx: HostCtx): boolean {
  const replace = liveRegistration?.replace
  if (typeof replace !== 'function') return false
  try {
    replace([ROUTER_ROUTE, COMPOSITE_ROUTE])
    return true
  } catch {
    // A disposed registration throws REGISTRATION_DISPOSED — the plugin is
    // unloading, so there is nothing to refresh and nothing to report.
    return false
  }
}

/** Register the router adapter on both synthetic routes, tied to the fiber. */
export function registerRouterAdapter(ctx: HostCtx): void {
  const llm = llmOf(ctx)
  if (!llm || typeof llm.registerAdapter !== 'function') return
  const ctxAny = ctx as any
  if (typeof ctxAny.effect !== 'function') return
  ctxAny.effect(() => {
    try {
      const handle = llm.registerAdapter([ROUTER_ROUTE, COMPOSITE_ROUTE], makeRouterAdapter(ctx))
      const owned = handle as unknown as { replace?: (providers: string[]) => void }
      liveRegistration = owned
      return () => {
        // Clear only if this effect still owns the slot: a re-applied fiber
        // registers the new handle BEFORE disposing the old one, so an
        // unconditional clear would drop the live registration.
        if (liveRegistration === owned) liveRegistration = undefined
        handle()
      }
    } catch {
      return () => undefined
    }
  }, 'dsh-model-pro: router adapter')
}