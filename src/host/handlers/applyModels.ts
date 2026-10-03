/** apply-models handler — replace/merge/remove/identify models on a provider.
 *
 * Two invariants shape the write path:
 *   1. Native provider config persists only DECLARED model fields — the
 *      display-side capability fields a read attached are stripped before any
 *      write, and capability PROVENANCE lives in plugin state
 *      (`capabilityStore`), committed before the models themselves so a failed
 *      write can never leave a record claiming a value that was not saved.
 *   2. `reasoningEfforts` is validated on every incoming entry BEFORE anything
 *      is written — llm-pi-ai's config schema fails the whole provider section
 *      on one malformed value, so a partial write is worse than none.
 * All mutating handlers serialize through `withCapabilityWrite` so two routes'
 * source writes cannot interleave and overwrite each other. */

import { NS, PLACEHOLDER_MODEL_ID } from '../../shared/constants'
import type { HostCtx, SettingsService } from '../utils'
import { readProviders, readDisabled, readProfile, checkWritable, writeSection } from '../utils'
import type { ModelCapabilitySummary, ModelEntry } from '../../shared/types'
import { normalizeReasoningEfforts } from '../reasoning'
import { normalizeModelInput, describeModelInput, detectModelInputs } from '../modelCapabilities'
import { readCapabilityState, capabilityRecord, capabilityWireId, stateForCapabilities, saveCapabilities, withCapabilityWrite, type CapabilityRecord } from '../capabilityStore'

type ApplyMode = 'replace' | 'merge' | 'remove' | 'identify'

const toEntry = (m: any): ModelEntry =>
  m && typeof m === 'object' && !Array.isArray(m) ? { ...m } : { id: String(m) }

const sameInput = (a: unknown, b: unknown): boolean =>
  normalizeModelInput(a)?.join() === normalizeModelInput(b)?.join()

/** Remove the display-side fields a read attached. Stripped on EVERY write so
 * a stale client echo can never persist provenance into provider config. */
const stripDisplay = (entry: ModelEntry): ModelEntry => {
  const out = { ...entry }
  delete out.capabilitySource; delete out.capabilityConflict; delete out.capabilityReference
  delete out.inputMode; delete out.inputModalities
  return out
}

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

/** Validate the capability half of one incoming entry (input / inputMode).
 * Throws with a user-facing message; caught by the caller's error envelope. */
function checkCapabilityPatch(patch: ModelEntry): void {
  if (typeof patch.id !== 'string' || !patch.id.trim()) throw new Error('模型 ID 必须是非空字符串')
  const empty = Array.isArray(patch.input) && patch.input.length === 0
  if (patch.input != null && !empty && !normalizeModelInput(patch.input)) throw new Error('输入能力只支持 text / image 列表')
  if (patch.requestModel != null && typeof patch.requestModel !== 'string') throw new Error('转发名必须是字符串')
  const inputMode = (patch as any).inputMode
  if (inputMode !== undefined && inputMode !== 'manual' && inputMode !== 'auto') throw new Error('能力设置模式必须是 manual / auto')
  if (inputMode === 'manual' && !normalizeModelInput(patch.input)) throw new Error('手工能力设置必须包含有效的 input')
}

export async function applyModels(
  ctx: HostCtx,
  args: { route?: string; models?: any[]; mode?: string; recheckLegacy?: boolean },
) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }
  return withCapabilityWrite(st, () => applyModelsLocked(ctx, st, args))
}

async function applyModelsLocked(
  ctx: HostCtx,
  st: SettingsService,
  args: { route?: string; models?: any[]; mode?: string; recheckLegacy?: boolean },
) {
  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const models = args?.models
  if (!Array.isArray(models)) return { ok: false as const, error: 'models 必须是数组' }

  const mode = (args.mode || 'merge') as ApplyMode
  if (!['replace', 'merge', 'remove', 'identify'].includes(mode)) return { ok: false as const, error: `未知 mode: ${mode}` }

  const p = readProfile(readProviders(st), route) || readProfile(readDisabled(st), route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }

  const existing = Array.isArray(p.models) ? p.models.map(toEntry) : []
  const state = readCapabilityState(st)
  // Concurrency snapshots: identify/apply decisions are made against the state
  // read above; if the profile or the source records changed under us, the
  // result would silently mix two generations. Refuse instead of guessing.
  const profileSnapshot = JSON.stringify([p.api, p.baseURL, p.models])
  const sourceSnapshot = JSON.stringify(state[route] ?? null)
  const unchanged = (expectedSource = sourceSnapshot) => {
    const fresh = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
    if (!fresh || JSON.stringify([fresh.api, fresh.baseURL, fresh.models]) !== profileSnapshot || JSON.stringify(readCapabilityState(st)[route] ?? null) !== expectedSource) {
      throw new Error('模型列表或能力来源已变化，请刷新后重新识别')
    }
  }

  // Surviving capability records. `stateForCapabilities` REPLACES the route's
  // record map, so every record that should survive this call must land here.
  const records: Record<string, CapabilityRecord> = Object.create(null)
  let capabilitySummary: ModelCapabilitySummary | undefined
  let next: ModelEntry[]
  try {
    if (mode === 'identify') {
      const patches = models.map(toEntry)
      for (const patch of patches) checkCapabilityPatch(patch)
      const ids = new Set(patches.map((m) => m.id))
      const selected = existing.filter((entry) => ids.has(entry.id))
      if (selected.length !== ids.size) throw new Error('模型列表已变化，请刷新后重新识别')
      // Legacy configs (input present, no record) are only re-checked when the
      // caller asks: their source is unknown, so a silent catalog overwrite
      // could change what the author meant to declare.
      const canRecheck = (entry: ModelEntry) => {
        const saved = capabilityRecord(state, route, p, entry)
        return saved?.source !== 'manual' && (args.recheckLegacy === true || !!saved || !normalizeModelInput(entry.input))
      }
      const candidates = selected.filter(canRecheck)
      const detected = await detectModelInputs(ctx, route, candidates)
      capabilitySummary = { image: 0, text: 0, unknown: 0, preserved: 0, updated: 0, rechecked: candidates.length, conflicts: 0, catalogUnavailable: detected.catalogUnavailable }
      const sum = capabilitySummary
      next = existing.map((entry) => {
        const saved = capabilityRecord(state, route, p, entry)
        if (saved) records[entry.id] = saved
        if (!ids.has(entry.id)) return stripDisplay(entry)
        const detection = detected.results.get(entry.id)
        if (detection?.conflict) sum.conflicts++
        const configured = normalizeModelInput(entry.input)
        const input = canRecheck(entry) ? detection?.input ?? configured : configured
        if (!canRecheck(entry) || (!detection?.input && configured)) sum.preserved++
        if (input?.includes('image')) sum.image++
        else if (input?.includes('text')) sum.text++
        else sum.unknown++
        const out = stripDisplay(entry)
        if (detection?.input && detection.source) {
          out.input = [...detection.input]
          if (!sameInput(configured, detection.input)) sum.updated++
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...detection.input], source: detection.source, ...(detection.conflict ? { conflict: true } : {}), ...(detection.reference ? { reference: detection.reference } : {}) }
        }
        return out
      })
    } else {
      // Validate incoming `reasoningEfforts` BEFORE any write. The normalized
      // entries (not the raw ones) feed the mode switch so replace/merge both
      // act on cleaned values.
      const checked = checkEfforts(models.map(toEntry))
      if (!checked.ok) return { ok: false as const, error: checked.error }
      const incoming = checked.entries
      const cleared = checked.cleared
      for (const patch of incoming) checkCapabilityPatch(patch)

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

      // Capability reconciliation. A patch may ask for a capability change
      // three ways: `inputMode: 'manual'` (the user picked a value), `input`:
      // null / [] / `inputMode: 'auto'` (reset to automatic detection), or
      // `capabilitySource: 'discovery'` (adopting what discovery reported).
      // Anything else — notably a plain name/mapping save — must NOT turn the
      // displayed capability into a manual claim.
      const patchMap = new Map(incoming.map((m) => [m.id, m]))
      next = await Promise.all(next.map(async (raw) => {
        const patch = patchMap.get(raw.id)
        const prior = existing.find((entry) => entry.id === raw.id)
        const saved = prior ? capabilityRecord(state, route, p, prior) : undefined
        const entry = stripDisplay(raw)
        if (mode === 'remove') { if (saved) records[entry.id] = saved; return entry }
        if (!patch) { if (saved) records[entry.id] = saved; return entry }
        // An empty-string / null wire name is a CLEAR, not a value to persist.
        if (patch.requestModel === null || patch.requestModel === '') delete entry.requestModel
        const inputMode = (patch as any).inputMode
        const reset = inputMode === 'auto' || patch.input === null || (Array.isArray(patch.input) && !patch.input.length)
        // 兼容旧 RPC 的直接手工数组；读取附加的 configured/catalog 不当成人工意图。
        const manual = inputMode === 'manual' || (!reset && inputMode === undefined && !(patch as any).capabilitySource && !!normalizeModelInput(patch.input))
        // 转发名改变后不使用旧型号的附加能力：目录按线上 ID 命中。
        const changedWire = !!prior && capabilityWireId(prior) !== capabilityWireId(entry)
        if (manual) {
          entry.input = normalizeModelInput(patch.input)!
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...entry.input], source: 'manual' }
          return entry
        }
        if (reset || changedWire) delete entry.input
        else if (prior && normalizeModelInput(prior.input) && (!saved || saved.source === 'manual')) {
          // The prior entry declared input with no (or manual) provenance:
          // keep the author's value, never let a plain save downgrade it.
          entry.input = prior.input
          if (saved) records[entry.id] = saved
          return entry
        } else if (saved && !(patch as any).capabilitySource) { records[entry.id] = saved; return entry }
        if ((patch as any).capabilitySource !== 'discovery' || reset || changedWire) delete entry.input
        const described = await describeModelInput(ctx, route, entry, (patch as any).capabilitySource === 'discovery' ? 'discovery' : 'configured')
        const input = normalizeModelInput(described.input)
        if (input && described.capabilitySource && described.capabilitySource !== 'configured' && described.capabilitySource !== 'manual') {
          entry.input = input
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...input], source: described.capabilitySource, ...(described.capabilityConflict ? { conflict: true } : {}), ...(described.capabilityReference ? { reference: described.capabilityReference } : {}) }
        } else delete entry.input
        return entry
      }))

      // The sentinel is only needed while no real model exists. Replace/merge must
      // remove it atomically with the first real model, otherwise it leaks into the
      // adapter's advertised catalog and may be selected by other DSH consumers.
      if (next.some((m) => m.id !== PLACEHOLDER_MODEL_ID)) {
        next = next.filter((m) => m.id !== PLACEHOLDER_MODEL_ID)
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
          throw new Error('不能删除全部模型: 自定义提供商必须至少保留一个模型条目')
      }
    }

    unchanged()
    const before = readCapabilityState(st)
    const after = stateForCapabilities(before, route, p, records)
    const modelsChanged = JSON.stringify(next) !== JSON.stringify(p.models)
    // Sources commit first, models second; on failure the sources roll back so
    // no record claims a value that never landed.
    await saveCapabilities(st, before, after, async () => {
      unchanged(JSON.stringify(after[route] ?? null))
      if (!modelsChanged) return
      // 等待目录/来源写入时，密钥引用、请求头和显示名可能已更新；只替换当前模型字段。
      const providers = { ...readProviders(st) }
      const disabled = { ...readDisabled(st) }
      const update = { ...(readProfile(providers, route) ?? readProfile(disabled, route))! }
      if (next.length) update.models = next
      else delete update.models
      if (Object.hasOwn(providers, route)) providers[route] = update
      else disabled[route] = update
      await writeSection(st, providers as any, disabled as any)
    })
    return { ok: true as const, route, count: next.length, ...(capabilitySummary ? { capabilitySummary } : {}) }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }
}
