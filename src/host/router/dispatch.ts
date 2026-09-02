/** The dispatch loop — one route call's attempt state machine.
 *
 * The shape worth knowing before reading: each attempt runs in TWO phases.
 *
 *   1. Pre-commit probe. Chunks are buffered, not yielded, until the target
 *      proves it can serve the request (a content delta) or fails. Nothing has
 *      reached the consumer yet, so switching targets here is invisible.
 *   2. Committed drain. Once a target has produced visible output, its stream
 *      is forwarded verbatim to the end — including a MID-STREAM failure, which
 *      cannot be retried elsewhere without duplicating already-shown content.
 *
 * That split is why a dead provider is seamless while a provider that dies
 * halfway is not: the boundary is the first byte the user can see. Bookkeeping
 * still tells the truth in both cases — a mid-stream failure logs as an error
 * and marks the target down even though the chunk passes through.
 */

import type { HostCtx } from '../utils'
import { wireModelOf } from '../utils'
import type { RouteSpec, RouteTarget } from '../../shared/types'
import { getHealthTracker } from '../health'
import { getStatsRecorder } from '../statsStore'
import { orderTargets } from './strategy'
import { buildCallConfig, buildTargetOptions } from './plan'
import { effortForTarget } from './reasoning'
import { routeExhausted } from './failure'
import {
  ATTEMPT_TIMEOUT, firstErrorFrom, isFinishChunk, isProgressChunk,
  nextWithDeadline, tokensFrom, tryReturn,
} from './chunks'
import type { LlmLike, RouterState } from './types'

/** Build the attempt list: enabled targets, health-filtered, ordered by
 * strategy, capped by `maxFallbacks`, with a sticky pin floated to the front.
 *
 * Health filtering falls back to the unfiltered pool when EVERY target is
 * probe-down: a stale probe must not turn a working route into a hard failure,
 * so "all down" is treated as "no useful health data". */
function attemptListFor(
  ctx: HostCtx,
  spec: RouteSpec,
  routeName: string,
  state: RouterState,
  options: Record<string, any>,
  sid: string,
): { list: RouteTarget[]; pinKey: string; poolEmpty: boolean } {
  const health = getHealthTracker(ctx)
  const healthAware = spec.config?.healthAware !== false
  const maxFallbacks = typeof spec.config?.maxFallbacks === 'number' && spec.config.maxFallbacks >= 0
    ? Math.floor(spec.config.maxFallbacks)
    : spec.targets.length

  const candidates = spec.targets.filter((t) => t.enabled !== false)
  const healthFiltered = healthAware
    ? candidates.filter((t) => health.isHealthy(t.provider, t.model))
    : candidates
  const pool = healthFiltered.length ? healthFiltered : candidates
  // An empty POOL and an empty attempt list are different failures: no pool
  // means every target is disabled (a config problem retrying cannot fix),
  // while `maxFallbacks: 0` empties the list from a healthy pool and is
  // reported as ordinary exhaustion. The caller needs to tell them apart.
  if (!pool.length) return { list: [], pinKey: '', poolEmpty: true }

  const ordered = orderTargets(spec, pool, health, state.cursor, routeName, options)
  const list = ordered.slice(0, maxFallbacks)

  const pinKey = sid ? `${routeName}\u0000${sid}` : ''
  const pinned = state.pin[pinKey]
  if (pinned
    && list.some((t) => t.provider === pinned.provider && t.model === pinned.model)
    && health.isHealthy(pinned.provider, pinned.model)) {
    list.sort((a, b) => {
      const ap = a.provider === pinned.provider && a.model === pinned.model ? 0 : 1
      const bp = b.provider === pinned.provider && b.model === pinned.model ? 0 : 1
      return ap - bp
    })
  }
  return { list, pinKey, poolEmpty: false }
}

/** Run one route call: walk targets until one commits, then forward its stream. */
export async function* dispatchRoute(
  ctx: HostCtx,
  llm: LlmLike,
  state: RouterState,
  spec: RouteSpec,
  routeName: string,
  model: string,
  options: Record<string, any>,
): AsyncGenerator<unknown> {
  const st = () => ctx.get('settings')
  const health = () => getHealthTracker(ctx)
  const stats = () => getStatsRecorder()

  const sid = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : ''
  const { list: attemptList, pinKey, poolEmpty } = attemptListFor(ctx, spec, routeName, state, options, sid)
  // Preserved from before the split: an empty pool throws a PLAIN Error, so it
  // normalizes to `UNKNOWN` and is not retried. That is the right outcome —
  // every target being disabled is a config problem no retry can fix — while
  // genuine exhaustion below carries ROUTE_EXHAUSTED and is retryable.
  if (poolEmpty) throw new Error(`智能路由「${model}」全部目标失败：无可用目标`)
  if (!attemptList.length) throw routeExhausted(`智能路由「${model}」全部目标失败：无可用目标`)
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
      // The requested effort is valid for the ROUTE (the union of its targets'
      // efforts), but this one target may not offer it. Clamping before
      // `prepareCall` is what keeps that from throwing
      // UNSUPPORTED_REASONING_EFFORT here — which this loop cannot distinguish
      // from a dead provider, and would therefore charge to the target's health.
      const effort = await effortForTarget(ctx, llm, target, options.reasoningEffort, options.signal)
      const callConfig = buildCallConfig(target, wire, { ...options, reasoningEffort: effort })
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
          const timedOut = String((error as Error)?.message || error) === ATTEMPT_TIMEOUT
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
      if (pinKey) state.pin[pinKey] = target

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
    throw routeExhausted(`智能路由「${model}」全部目标失败：${lastErr || '无可用目标'}`)
  }
}
