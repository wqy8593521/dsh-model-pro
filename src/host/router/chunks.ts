/** Chunk-level helpers: reading DSH stream chunks and bounding one pull.
 *
 * Every function here is pure and stream-shape-only — no settings, no health,
 * no stats — so the dispatch loop's decisions can be read against the chunk
 * vocabulary alone.
 */

/** The error message carried by a terminal error `finish`, if it is one. */
export function firstErrorFrom(chunk: Record<string, any>): string | undefined {
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

export function isProgressChunk(chunk: unknown): boolean {
  return !!chunk && typeof chunk === 'object' && PROGRESS_CHUNK_TYPES.has((chunk as Record<string, any>).type)
}

export function isFinishChunk(chunk: unknown): boolean {
  return !!chunk && typeof chunk === 'object' && (chunk as Record<string, any>).type === 'finish'
}

/** The sentinel a deadline loss is reported with; never leaves this module's
 * caller, which translates it into a user-facing timeout message. */
export const ATTEMPT_TIMEOUT = '__mpro_attempt_timeout__'

/** Pull one chunk, racing an optional per-attempt deadline (ms since epoch).
 * The losing timer is defused so no unhandled rejection leaks; the underlying
 * iterator stays alive and is closed by the caller via tryReturn(). */
export async function nextWithDeadline(
  iterator: AsyncIterator<unknown>,
  deadlineMs: number,
): Promise<IteratorResult<unknown>> {
  if (!Number.isFinite(deadlineMs)) return iterator.next()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    const wait = Math.max(0, deadlineMs - Date.now())
    timer = setTimeout(() => reject(new Error(ATTEMPT_TIMEOUT)), wait)
  })
  timeout.catch(() => { /* defuse when the race is won by next() */ })
  try {
    return await Promise.race([iterator.next(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Usage tokens from a `usage` (or finish) chunk (adapter-optional; best
 * effort). The real DSH stream emits a `{ type: 'usage', usage: TokenUsage }`
 * chunk whose fields are camelCase (`inputTokens` / `outputTokens`, per
 * `@deepseek-ai/dsh-llm`'s `TokenUsage`, which pi-ai's `mapUsage` fills). Older
 * / raw OpenAI-style snake_case names are accepted as a fallback so a
 * non-standard adapter still counts. */
export function tokensFrom(chunk: Record<string, any>): { in?: number; out?: number } {
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

/** Close an iterator, ignoring any error it raises on the way out. */
export async function tryReturn(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    if (typeof iterator.return === 'function') await iterator.return()
  } catch { /* best effort */ }
}
