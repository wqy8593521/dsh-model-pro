/** Validation and normalization for a model entry's `reasoningEfforts`.
 *
 * Why this is not just a type cast: the field crosses into
 * `@deepseek-ai/dsh-llm-pi-ai`, whose config schema REJECTS the whole provider
 * section on a malformed value — an empty dict, a level with an empty string, or
 * a dict offering nothing beyond `off` each raise a config error that takes
 * every model of that provider offline, not just the bad entry. Writing an
 * invalid value is therefore worse than writing none, so this module is the
 * gate: everything reaching settings has already been checked against the same
 * rules llm-pi-ai will apply.
 */

import { THINKING_LEVELS } from '../shared/constants'
import type { ThinkingLevel } from '../shared/constants'
import type { ReasoningEfforts } from '../shared/types'

const LEVELS = new Set<string>(THINKING_LEVELS)

/** Outcome of checking one candidate value. */
export type EffortsCheck =
  | { ok: true; value: false | ReasoningEfforts | undefined }
  | { ok: false; error: string }

/**
 * Normalize one `reasoningEfforts` candidate.
 *
 * Accepts the three legal states and rejects everything else with a message
 * naming the exact problem:
 *   - `undefined` / absent  → undefined (inherit the installed catalog)
 *   - `false`               → false (this model does not reason)
 *   - a dict of levels      → a cleaned dict in canonical level order
 *
 * `null` is accepted as a spelling of "inherit" because YAML renders a valueless
 * key that way, and the client sends `null` to CLEAR the field. It is not a
 * spelling of `false`; conflating them would silently disable reasoning on a
 * model whose author only meant to stop overriding it.
 */
export function normalizeReasoningEfforts(raw: unknown): EffortsCheck {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (raw === false) return { ok: true, value: false }
  if (raw === true) {
    // A bare `true` cannot be honoured: pi-ai needs the per-level wire
    // spellings, and no listing endpoint reports a model's reasoning protocol,
    // so there is nothing to infer them from.
    return { ok: false, error: 'reasoningEfforts 不能是 true：需要逐档给出线上取值，或用 false 表示不推理' }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'reasoningEfforts 必须是档位字典、false，或留空' }
  }

  const src = raw as Record<string, unknown>
  const keys = Object.keys(src)
  if (!keys.length) {
    // An empty dict is exactly what llm-pi-ai rejects, and it is ambiguous
    // anyway: it could mean "inherit" or "no levels". Callers must say which.
    return { ok: false, error: 'reasoningEfforts 不能是空字典：请声明档位，或用 false 表示不推理，或留空表示继承目录' }
  }

  for (const key of keys) {
    if (!LEVELS.has(key)) {
      return { ok: false, error: `未知思考档位 "${key}"：可用档位为 ${THINKING_LEVELS.join(' / ')}` }
    }
    const wire = src[key]
    if (wire === undefined) continue
    if (wire === null) {
      if (key !== 'off') {
        return { ok: false, error: `档位 "${key}" 需要给出线上取值；只有 off 可以留空（留空即「支持该档位但不发送参数」）` }
      }
      continue
    }
    if (typeof wire !== 'string') {
      return { ok: false, error: `档位 "${key}" 的线上取值必须是字符串` }
    }
    if (wire.length === 0) {
      return { ok: false, error: `档位 "${key}" 的线上取值不能是空字符串` }
    }
  }

  // Build in canonical order so the persisted YAML reads low→high regardless of
  // the order keys arrived in.
  const out: ReasoningEfforts = {}
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(src, level)) continue
    const wire = src[level]
    if (wire === undefined) continue
    out[level] = wire === null ? null : String(wire)
  }

  const beyondOff = Object.keys(out).some((level) => level !== 'off')
  if (!beyondOff) {
    // llm-pi-ai rejects this too: a model offering only `off` would advertise a
    // control whose every position sends the same request.
    return { ok: false, error: 'reasoningEfforts 至少要声明一个 off 之外的档位，否则该控件没有任何作用；不推理的模型请用 false' }
  }
  return { ok: true, value: out }
}

/** The levels a normalized value offers, in ascending effort order. */
export function levelsOf(value: false | ReasoningEfforts | undefined): ThinkingLevel[] {
  if (!value) return []
  return THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(value, level))
}
