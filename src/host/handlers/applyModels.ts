/** apply-models handler — replace/merge/remove models on a provider. */

import { NS } from '../../shared/constants'
import type { HostCtx } from '../utils'
import { readProviders, readDisabled, readProfile, checkWritable, writeSection } from '../utils'
import type { ModelEntry } from '../../shared/types'
import { normalizeReasoningEfforts } from '../reasoning'

type ApplyMode = 'replace' | 'merge' | 'remove'

const toEntry = (m: any): ModelEntry =>
  m && typeof m === 'object' ? { ...m } : { id: String(m) }

/** Validate `reasoningEfforts` on every incoming entry before anything is
 * written, and drop the key when it normalizes to "inherit".
 *
 * Rejecting the WHOLE call on one bad entry is deliberate: llm-pi-ai's config
 * schema fails the entire provider section on a malformed value, taking every
 * model of that provider offline. A partial write would leave settings in
 * exactly that state.
 *
 * `cleared` carries the ids that asked to REMOVE the field (key present, value
 * null). Without it a clear would be indistinguishable from "field not
 * mentioned" once the key is dropped, and merge — which preserves unmentioned
 * fields — could never erase a value. */
function checkEfforts(entries: ModelEntry[]):
  | { ok: true; entries: ModelEntry[]; cleared: Set<string> }
  | { ok: false; error: string } {
  const out: ModelEntry[] = []
  const cleared = new Set<string>()
  for (const e of entries) {
    if (!Object.prototype.hasOwnProperty.call(e, 'reasoningEfforts')) { out.push(e); continue }
    const check = normalizeReasoningEfforts(e.reasoningEfforts)
    if (!check.ok) return { ok: false, error: `模型 "${e.id}": ${check.error}` }
    const next = { ...e }
    if (check.value === undefined) { delete next.reasoningEfforts; cleared.add(e.id) }
    else next.reasoningEfforts = check.value
    out.push(next)
  }
  return { ok: true, entries: out, cleared }
}

export async function applyModels(
  ctx: HostCtx,
  args: { route?: string; models?: any[]; mode?: string },
) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }

  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const models = args?.models
  if (!Array.isArray(models)) return { ok: false as const, error: 'models 必须是数组' }

  const mode = (args.mode || 'merge') as ApplyMode
  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const p = readProfile(providers, route) || readProfile(disabled, route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }

  // Validate incoming `reasoningEfforts` BEFORE any write. The normalized
  // entries (not the raw ones) feed the mode switch so replace/merge both act
  // on cleaned values.
  const checked = checkEfforts(models.map(toEntry))
  if (!checked.ok) return { ok: false as const, error: checked.error }
  const incoming = checked.entries
  const cleared = checked.cleared

  const existing = Array.isArray(p.models) ? p.models.map(toEntry) : []

  let next: ModelEntry[]
  if (mode === 'replace') {
    // Replace, but preserve hand-authored fields that discovery cannot provide:
    // `reasoningEfforts` and `requestModel` are only declared in YAML or the
    // model editor, and a discovery-then-replace cycle would wipe them.
    const existingMap = new Map(existing.map((e) => [e.id, e]))
    next = incoming.map((e) => {
      const saved = existingMap.get(e.id)
      if (!saved) return e
      const carried: Record<string, unknown> = {}
      if (saved.reasoningEfforts !== undefined && e.reasoningEfforts === undefined && !cleared.has(e.id)) carried.reasoningEfforts = saved.reasoningEfforts
      if (saved.requestModel !== undefined && e.requestModel === undefined) carried.requestModel = saved.requestModel
      if (!Object.keys(carried).length) return e
      return { ...e, ...carried }
    })
  } else if (mode === 'merge') {
    next = [...existing]
    for (const e of incoming) {
      const idx = next.findIndex((x) => x.id === e.id)
      if (idx >= 0) {
        const merged: ModelEntry = { ...next[idx], ...e }
        // An explicit clear must survive the spread: `e` no longer carries the
        // key, so a plain merge would resurrect the saved value.
        if (cleared.has(e.id)) delete merged.reasoningEfforts
        next[idx] = merged
      } else next.push(e)
    }
  } else if (mode === 'remove') {
    const toRemove = new Set(incoming.map((m) => m.id))
    next = existing.filter((m) => !toRemove.has(m.id))
  } else {
    return { ok: false as const, error: `未知 mode: ${mode}` }
  }

  // Prevent removing all models from custom providers
  if (next.length === 0) {
    const llm = ctx.get('llm')
    let inCatalog = false
    if (llm !== undefined) {
      try {
        inCatalog = llm
          .listConfigurableProviders()
          .some((e) => e.settingsNs === NS && e.provider === route && e.declared !== true)
      } catch { /* ignore */ }
    }
    if (!inCatalog)
      return { ok: false as const, error: '不能删除全部模型: 自定义提供商必须至少保留一个模型条目' }
  }

  const applyMutation = (src: Record<string, unknown>): Record<string, unknown> => {
    const cur: Record<string, unknown> = {}
    for (const fk of Object.keys(src)) cur[fk] = src[fk]
    if (next.length === 0) delete cur.models
    else cur.models = next
    return cur
  }

  try {
    // Re-read fresh state in case it changed
    const srcP2 = readProviders(st)
    const srcD2 = readDisabled(st)
    const nextProviders: Record<string, unknown> = {}
    for (const k of Object.keys(srcP2)) {
      nextProviders[k] = k === route ? applyMutation(srcP2[k] as any) : (srcP2 as any)[k]
    }
    const nextDisabled: Record<string, unknown> = {}
    for (const k of Object.keys(srcD2)) {
      nextDisabled[k] = k === route ? applyMutation(srcD2[k] as any) : (srcD2 as any)[k]
    }
    await writeSection(st, nextProviders as any, nextDisabled as any)
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }

  return { ok: true as const, route, count: next.length }
}
