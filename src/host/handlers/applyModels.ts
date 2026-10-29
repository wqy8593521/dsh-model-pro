/** apply-models handler — replace/merge/remove/identify/hide/show models on a provider.
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
 * source writes cannot interleave and overwrite each other.
 *
 * `hide` / `show` are modes of THIS handler rather than handlers of their own,
 * for three reasons that are all load-bearing:
 *   - they must run INSIDE `withCapabilityWrite` (that lock is a promise chain,
 *     so a wrapper that calls back into this function would deadlock itself);
 *   - they must observe the same `unchanged()` snapshot, or a hide could land on
 *     a model list the user has already edited in another tab;
 *   - they reorder two writes that must never lose the entry: hide parks the
 *     archive BEFORE removing the model, show merges the model back BEFORE
 *     clearing the archive. Both orderings are the "never lose it" direction. */

import { NS, PLACEHOLDER_MODEL_ID } from '../../shared/constants'
import type { HostCtx, SettingsService } from '../utils'
import { readProviders, readDisabled, readProfile, readRoutes, checkWritable, writeSection } from '../utils'
import type { ModelCapabilitySummary, ModelEntry } from '../../shared/types'
import { normalizeReasoningEfforts } from '../reasoning'
import { normalizeModelInput, describeModelInput, detectModelInputs, capabilityView } from '../modelCapabilities'
import { readCapabilityState, capabilityBinding, capabilityRecord, capabilityWireId, stateForCapabilities, saveCapabilities, withCapabilityWrite, type CapabilityRecord } from '../capabilityStore'
import { readHiddenState, writeHiddenState, hiddenFor, withHidden, withoutHidden, type HiddenState, type HiddenModelEntry } from '../hiddenModels'

type ApplyMode = 'replace' | 'merge' | 'remove' | 'identify' | 'hide' | 'show'

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

/** 隐藏前的引用检查：智能路由别名指向该模型时必须先解除，否则路由会在请求期
 * 才失败（`UNKNOWN_MODEL`），而不是在这里给出可操作的提示。
 *
 * 组合提供商不需要检查：它们按成员提供商的模型列表取并集，成员少一个模型只是
 * 这个虚拟路由少一个可选项，没有悬空引用。 */
function routeReferences(st: SettingsService, route: string, ids: Set<string>): string[] {
  const out: string[] = []
  try {
    for (const [alias, spec] of Object.entries(readRoutes(st))) {
      const targets = Array.isArray((spec as { targets?: unknown })?.targets)
        ? (spec as { targets: Array<{ provider?: unknown; model?: unknown }> }).targets
        : []
      for (const target of targets) {
        if (target && target.provider === route && typeof target.model === 'string' && ids.has(target.model)) {
          out.push(`路由别名「${alias}」`)
        }
      }
    }
  } catch { /* 路由表读不出来时不阻拦：隐藏本身不动路由数据 */ }
  return out
}

/** 隐藏前的默认模型检查：`agentDefaultModel` 的选择是独立持久化的，隐藏它会让
 * 下一个会话解析不到模型（`UNKNOWN_MODEL`）。服务不可用时跳过 —— 宁可放行，
 * 也不要因为拿不到服务就误报一个用户无法处理的错误。 */
function defaultModelHit(ctx: HostCtx, route: string, ids: Set<string>): string | undefined {
  try {
    const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown } } | undefined)
      ?.currentSelection?.()
    if (selection && selection.provider === route && typeof selection.model === 'string' && ids.has(selection.model)) {
      return selection.model
    }
  } catch { /* 未注入该服务时跳过 */ }
  return undefined
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
  if (!['replace', 'merge', 'remove', 'identify', 'hide', 'show'].includes(mode)) return { ok: false as const, error: `未知 mode: ${mode}` }

  const p = readProfile(readProviders(st), route) || readProfile(readDisabled(st), route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }

  const existing = Array.isArray(p.models) ? p.models.map(toEntry) : []
  const state = readCapabilityState(st)
  // 本路由的能力视图只读一次：下面的协调循环可能对很多条目做描述，而每次
  // `describeModelInput` 若自己重读（0.2 上 describe() 会投影整个设置文档）就会
  // 变成 O(模型数) 次设置读取。
  const view = capabilityView(ctx, route)
  const hiddenBefore = readHiddenState(st)
  // Concurrency snapshots: identify/apply decisions are made against the state
  // read above; if the profile or the source records changed under us, the
  // result would silently mix two generations. Refuse instead of guessing.
  // The hidden archive is part of that snapshot: a hide/show decision made
  // against a stale archive would park or restore the wrong entry set.
  const profileSnapshot = JSON.stringify([p.api, p.baseURL, p.models])
  const sourceSnapshot = JSON.stringify(state[route] ?? null)
  const hiddenSnapshot = JSON.stringify(hiddenBefore[route] ?? null)
  const unchanged = (expectedSource = sourceSnapshot, expectedHidden = hiddenSnapshot) => {
    const fresh = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
    if (
      !fresh ||
      JSON.stringify([fresh.api, fresh.baseURL, fresh.models]) !== profileSnapshot ||
      JSON.stringify(readCapabilityState(st)[route] ?? null) !== expectedSource ||
      JSON.stringify(readHiddenState(st)[route] ?? null) !== expectedHidden
    ) {
      throw new Error('模型列表、能力来源或隐藏列表已变化，请刷新后重新识别')
    }
  }

  // Surviving capability records. `stateForCapabilities` REPLACES the route's
  // record map, so every record that should survive this call must land here.
  const records: Record<string, CapabilityRecord> = Object.create(null)
  let capabilitySummary: ModelCapabilitySummary | undefined
  let next: ModelEntry[]
  // Hidden-archive side effects: `precommit` parks BEFORE the source/model commit
  // (hide), `postcommit` clears AFTER it (show / re-add). Either ordering loses
  // nothing if the later write fails.
  let hiddenAfter: HiddenState = hiddenBefore
  let hiddenCommit: 'none' | 'precommit' | 'postcommit' = 'none'
  // Three separate facts, deliberately not collapsed into one number:
  //   `hidden`   — how many entries the archive holds AFTER this call (state)
  //   `parked`   — how many THIS call parked (action; the status line says it)
  //   `restored` — how many parked entries actually went back into the model list
  //                (a model the user re-added while hidden is skipped, so this is
  //                NOT `wanted.size`)
  let hiddenCount: number | undefined
  let parkedCount: number | undefined
  let restoredCount: number | undefined
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
      } else if (mode === 'hide') {
        // Park the FULL entries, then remove them. Nothing here is derivable
        // later: discovery returns only id/name/contextWindow/maxTokens/input,
        // so `reasoningEfforts` / `compat` / `requestModel` and every hand-typed
        // cap live in the parked copy or nowhere.
        const wanted = new Set(incoming.map((m) => m.id))
        const missing = [...wanted].filter((id) => !existing.some((e) => e.id === id))
        if (missing.length) throw new Error(`模型 ${missing.join('、')} 不在当前列表中，请刷新后重试`)
        // The schema sentinel is not a user-visible model: parking it would hide a
        // placeholder from nobody while making the "at least one model" rule look
        // satisfied by something the adapter cannot serve.
        if (wanted.has(PLACEHOLDER_MODEL_ID)) throw new Error('内部占位条目不是可隐藏的模型，请刷新后重试')
        const remaining = existing.filter((m) => !wanted.has(m.id))
        // The placeholder sentinel is not a visible model, so it cannot satisfy
        // the "at least one model stays" rule (the sentinel block below removes it
        // the moment a real model exists).
        const realRemaining = remaining.filter((m) => m.id !== PLACEHOLDER_MODEL_ID)
        if (!realRemaining.length) {
          // Not a UI nicety: llm-pi-ai's `resolveRouteModels` throws for a route
          // whose model list resolves empty (custom routes), and a catalog route
          // silently falls back to the INSTALLED catalog — so "hiding the last
          // one" either aborts the write or un-hides everything.
          throw new Error(
            '不能隐藏最后一个可见模型: llm-pi-ai 要求每条 route 至少保留一个模型条目（自定义 route 的列表为空会直接让配置校验失败，内置目录 route 的列表为空会静默回落到内置目录）。请先添加另一个模型，再隐藏它。',
          )
        }
        const refs = routeReferences(st, route, wanted)
        if (refs.length) {
          throw new Error(`以下位置仍在引用要隐藏的模型（${[...wanted].join('、')}）：${refs.join('、')}。请先在这些智能路由里解除引用。`)
        }
        const isDefault = defaultModelHit(ctx, route, wanted)
        if (isDefault) {
          throw new Error(`模型 "${isDefault}" 当前是 DSH 的默认模型，隐藏后新会话将无法解析它。请先在模型选择器里切换到其它模型，再隐藏它。`)
        }
        const prior = hiddenFor(hiddenBefore, route)
        const parked: HiddenModelEntry[] = existing.flatMap((entry, index) => {
          if (!wanted.has(entry.id)) return []
          // Already parked (can only happen if a foreign writer re-created the
          // entry): never park the same id twice, or "显示" would insert it twice.
          if (prior?.entries.some((item) => item.model.id === entry.id)) return []
          const saved = capabilityRecord(state, route, p, entry)
          return [{ index, model: stripDisplay(entry), ...(saved ? { capability: saved } : {}) }]
        })
        hiddenAfter = withHidden(hiddenBefore, route, capabilityBinding(p), [...(prior?.entries ?? []), ...parked])
        hiddenCommit = 'precommit'
        parkedCount = parked.length
        hiddenCount = hiddenAfter[route]?.entries.length ?? 0
        next = remaining
      } else if (mode === 'show') {
        const wanted = new Set(incoming.map((m) => m.id))
        const archive = hiddenFor(hiddenBefore, route)
        const parked = (archive?.entries ?? []).filter((item) => wanted.has(item.model.id))
        const unknown = [...wanted].filter((id) => !parked.some((item) => item.model.id === id))
        if (unknown.length) throw new Error(`模型 ${unknown.join('、')} 不在已隐藏列表中，请刷新后重试`)
        // Entry data always comes back; PROVENANCE only comes back when the
        // endpoint binding still matches — a record from another api/baseURL
        // does not describe this route any more.
        const bindingMatches = archive?.binding === capabilityBinding(p)
        const list = existing.map((e) => ({ ...e }))
        const present = new Set(list.map((e) => e.id))
        const restored: HiddenModelEntry[] = []
        for (const item of [...parked].sort((a, b) => a.index - b.index)) {
          // Re-added in the meantime (discovery merge): the LIVE entry wins and
          // the parked copy is simply dropped below, never inserted twice.
          if (present.has(item.model.id)) continue
          const at = Math.max(0, Math.min(item.index, list.length))
          list.splice(at, 0, { ...item.model })
          present.add(item.model.id)
          restored.push(item)
        }
        next = list
        hiddenAfter = withoutHidden(hiddenBefore, route, wanted).state
        hiddenCommit = 'postcommit'
        hiddenCount = hiddenAfter[route]?.entries.length ?? 0
        restoredCount = restored.length
        if (bindingMatches) {
          for (const item of restored) if (item.capability) records[item.model.id] = item.capability
        } else if (restored.length) {
          // Say so instead of silently downgrading: a record that does not match
          // the new endpoint would be rejected by capabilityRecord() anyway.
          ;(ctx.get('logger') as { warn?: (m: string) => void } | undefined)?.warn?.(
            `dsh-model-pro: 提供商 "${route}" 的端点已变更，显示回来的模型不恢复旧的能力来源（避免把别的端点的探测结果挂在它身上）`,
          )
        }
      } else {
        return { ok: false as const, error: `未知 mode: ${mode}` }
      }

      // Re-adding a model through discovery (merge / replace) MEANS showing it:
      // an id must never sit in `models` and in the archive at the same time, or
      // "显示" becomes a no-op duplicate of what the user already has.
      if (mode === 'merge' || mode === 'replace') {
        const parkedIds = new Set((hiddenFor(hiddenBefore, route)?.entries ?? []).map((item) => item.model.id))
        const reAdded = next.map((e) => e.id).filter((id) => parkedIds.has(id))
        if (reAdded.length) {
          hiddenAfter = withoutHidden(hiddenBefore, route, reAdded).state
          hiddenCommit = 'postcommit'
          hiddenCount = hiddenAfter[route]?.entries.length ?? 0
        }
      }

      // Capability reconciliation. A patch may ask for a capability change
      // three ways: `inputMode: 'manual'` (the user picked a value), `input`:
      // null / [] / `inputMode: 'auto'` (reset to automatic detection), or
      // `capabilitySource: 'discovery'` (adopting what discovery reported).
      // Anything else — notably a plain name/mapping save — must NOT turn the
      // displayed capability into a manual claim.
      //
      // hide/show do NOT go through it: their entries are already resolved
      // (parked copies carry their provenance explicitly), and feeding a parked
      // entry through the patch path would treat its restored `input` as a new
      // manual claim and strip the value the archive just restored.
      if (mode === 'replace' || mode === 'merge' || mode === 'remove') {
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
          const described = await describeModelInput(ctx, route, entry, (patch as any).capabilitySource === 'discovery' ? 'discovery' : 'configured', view)
          const input = normalizeModelInput(described.input)
          if (input && described.capabilitySource && described.capabilitySource !== 'configured' && described.capabilitySource !== 'manual') {
            entry.input = input
            records[entry.id] = { wireId: capabilityWireId(entry), input: [...input], source: described.capabilitySource, ...(described.capabilityConflict ? { conflict: true } : {}), ...(described.capabilityReference ? { reference: described.capabilityReference } : {}) }
          } else delete entry.input
          return entry
        }))
      } else {
        // Surviving entries keep their provenance; hide/show move the parked
        // ones in and out of `records` themselves.
        for (const raw of next) {
          const prior = existing.find((entry) => entry.id === raw.id)
          const saved = prior ? capabilityRecord(state, route, p, prior) : undefined
          if (saved) records[raw.id] = saved
        }
        next = next.map((raw) => stripDisplay(raw))
      }

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
    const hiddenChanged = JSON.stringify(hiddenAfter) !== JSON.stringify(hiddenBefore)
    // hide parks the archive BEFORE touching `providers`; if the model write then
    // fails the archive is rolled back, so an entry never exists in neither place.
    //
    // What the archive looks like DURING the commit depends on that ordering:
    // `precommit` already wrote it, `postcommit` still owes it. Comparing against
    // the wrong one would abort every hide/show with a spurious staleness error.
    const archiveDuringCommit = (hiddenCommit === 'precommit' ? hiddenAfter : hiddenBefore)[route] ?? null
    if (hiddenCommit === 'precommit' && hiddenChanged) {
      await writeHiddenState(st, hiddenAfter)
    }
    try {
      // Sources commit first, models second; on failure the sources roll back so
      // no record claims a value that never landed.
      await saveCapabilities(st, before, after, async () => {
        unchanged(JSON.stringify(after[route] ?? null), JSON.stringify(archiveDuringCommit))
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
    } catch (error) {
      if (hiddenCommit === 'precommit' && hiddenChanged) {
        // Best effort: a rollback failure must not mask the ORIGINAL error, which
        // is what the user has to act on.
        try { await writeHiddenState(st, hiddenBefore) } catch { /* keep original error */ }
      }
      throw error
    }
    // show / re-add clear the archive only AFTER the model is back in `providers`.
    if (hiddenCommit === 'postcommit' && hiddenChanged) {
      await writeHiddenState(st, hiddenAfter)
    }
    return {
      ok: true as const,
      route,
      count: next.length,
      ...(capabilitySummary ? { capabilitySummary } : {}),
      ...(hiddenCount !== undefined ? { hidden: hiddenCount } : {}),
      ...(parkedCount !== undefined ? { parked: parkedCount } : {}),
      ...(restoredCount !== undefined ? { restored: restoredCount } : {}),
    }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }
}
