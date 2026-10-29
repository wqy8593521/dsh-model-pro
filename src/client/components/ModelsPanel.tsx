/** ModelsPanel — the "模型" tab. Discover remote models, select with bulk
 * operations (search-aware), then replace/merge into the provider; manage the
 * current list with its own search, select-all / batch delete and a manual
 * custom-model add form. */

import React from '../react'
import type { ModelEntry, ModelCapabilitySummary, DiscoveredModel, InfoState, StatusMsg, TFunc, CallFn, ReasoningEfforts } from '../../shared/types'
import { fmt } from '../labels'
import { THINKING_LEVELS } from '../../shared/constants'
import { ReasoningEditor } from './ReasoningEditor'
import { LocalFillPanel } from './LocalFillPanel'

interface Props {
  t: TFunc
  call: CallFn
  route: string
  info: InfoState
  set: (patch: Partial<InfoState>) => void
  protocols: string[]
  models: ModelEntry[]
  setModels: React.Dispatch<React.SetStateAction<ModelEntry[]>>
  /** 已隐藏（寄存的）模型：从模型选择器里摘出，但条目完整保留，可原样放回。 */
  hiddenModels: ModelEntry[]
  setHiddenModels: React.Dispatch<React.SetStateAction<ModelEntry[]>>
  discovered: DiscoveredModel[] | null
  setDiscovered: React.Dispatch<React.SetStateAction<DiscoveredModel[] | null>>
  selectedIds: Record<string, boolean>
  setSelectedIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  apiKeyProbe: string
  setApiKeyProbe: React.Dispatch<React.SetStateAction<string>>
  busy: boolean
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  setStatus: React.Dispatch<React.SetStateAction<StatusMsg | null>>
  fail: (e: unknown) => void
  inlineStatus: React.ReactElement | null
}

/** Case-insensitive substring match over a model's id and display name. */
const matchQ = (m: { id: string; name?: string }, q: string): boolean => {
  const s = q.trim().toLowerCase()
  if (!s) return true
  return `${m.id} ${m.name || ''}`.toLowerCase().includes(s)
}

/** Draft state for the manual custom-model form. */
interface AddDraft {
  id: string
  name: string
  ctx: string
  out: string
  wire: string
  capability: CapabilityChoice
}

/**
 * How many current models render at once.
 *
 * A provider can legitimately own hundreds of models, and every extra row is a
 * checkbox plus badge, select and two inputs in the DOM. Rendering all of them on
 * mount is what made opening the model editor feel sluggish; the rest arrive on
 * demand (or immediately when a search narrows the list down).
 */
const ROW_PAGE = 40

/** The user-facing capability choice: `auto` defers to backend detection. */
type CapabilityChoice = 'auto' | 'text' | 'image'

const EMPTY_DRAFT: AddDraft = { id: '', name: '', ctx: '', out: '', wire: '', capability: 'auto' }

/** 未提供能力与已确认仅支持文本是不同状态，不能根据模型名猜测。 */
const capabilityChoice = (model: ModelEntry): CapabilityChoice =>
  model.input?.includes('image') ? 'image' : model.input?.includes('text') ? 'text' : 'auto'

const capabilityInput = (choice: Exclude<CapabilityChoice, 'auto'>): Array<'text' | 'image'> =>
  choice === 'image' ? ['text', 'image'] : ['text']

export function ModelsPanel({
  t, call, route, info, set, protocols, models, setModels, hiddenModels, setHiddenModels,
  discovered, setDiscovered, selectedIds, setSelectedIds,
  apiKeyProbe, setApiKeyProbe, busy, setBusy, setStatus, fail, inlineStatus,
}: Props) {
  // Search queries for the two lists (independent).
  const [discQ, setDiscQ] = React.useState('')
  const [curQ, setCurQ] = React.useState('')
  // Selection for the CURRENT models list — kept separate from `selectedIds`
  // (which belongs to the discovered list) so the two tables never cross-talk.
  const [curSel, setCurSel] = React.useState<Record<string, boolean>>({})
  // Manual custom-model form.
  const [showAdd, setShowAdd] = React.useState(false)
  const [draft, setDraft] = React.useState<AddDraft>(EMPTY_DRAFT)
  // Per-model capability choices not yet saved; sending them rides the next
  // 保存模型配置 call, so 重新识别 stays blocked while drafts are pending.
  const [capabilityDraft, setCapabilityDraft] = React.useState<Record<string, CapabilityChoice>>({})
  // Whether the wire-name inputs have unsaved edits (same contract as above).
  const [mappingDirty, setMappingDirty] = React.useState(false)
  // Which model's configuration panel is open, and whether its thinking-level
  // editor is revealed inside it. One row at a time: the panel is a detail view,
  // and two open panels could show two drafts of the same list.
  const [configFor, setConfigFor] = React.useState<string | null>(null)
  const [reasonFor, setReasonFor] = React.useState<string | null>(null)
  const toggleConfig = (id: string) => {
    const next = configFor === id ? null : id
    setConfigFor(next)
    // 收起面板时一并收起档位编辑器，避免下次展开时停在半开状态。
    if (next === null) setReasonFor(null)
  }
  // Whether the bulk local-catalog fill panel is open.
  const [fillOpen, setFillOpen] = React.useState(false)
  // Catalog preferences, loaded once. `null` = still loading; the editor treats
  // it as disabled until it arrives, so no fetch can happen before the toggle
  // has actually been read.
  const [catalog, setCatalog] = React.useState<{ enabled: boolean; url: string } | null>(null)
  // How many rows of the current list are rendered (see ROW_PAGE).
  const [shownRows, setShownRows] = React.useState(ROW_PAGE)
  // Whether the user has already been told how hiding works. Defaults to false so
  // a runtime that cannot answer the preference still explains it once per page
  // rather than never; the host value turns it off for good after the first hide.
  const [hideHintSeen, setHideHintSeen] = React.useState(false)

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await call('get-catalog-prefs')
        setCatalog({ enabled: r?.prefs?.enabled === true, url: r?.effectiveUrl || '' })
      } catch { setCatalog({ enabled: false, url: '' }) }
    })()
  }, [call])

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await call('get-ui-prefs')
        setHideHintSeen(r?.prefs?.hiddenModelsHintSeen === true)
      } catch { /* 读不到偏好就当作没看过：多解释一次比永不解释安全 */ }
    })()
  }, [call])

  const curList = models || []
  const hasUnsavedConfig = mappingDirty || Object.keys(capabilityDraft).length > 0
  const draftCapability = (id: string): CapabilityChoice | undefined =>
    Object.prototype.hasOwnProperty.call(capabilityDraft, id) ? capabilityDraft[id] : undefined

  // --- discovered list: search-aware bulk selection -------------------------
  const discVisible = (discovered || []).filter((m) => matchQ(m, discQ))
  const discSelCount = (discovered || []).filter((m) => selectedIds[m.id]).length
  const selectedModels = (discovered || []).filter((m) => selectedIds[m.id])

  const toggleSel = (id: string) =>
    setSelectedIds((s) => ({ ...s, [id]: !s[id] }))
  const selectAllDisc = () => {
    const s: Record<string, boolean> = { ...selectedIds }
    discVisible.forEach((m) => { s[m.id] = true })
    setSelectedIds(s)
  }
  const unselectAllDisc = () => setSelectedIds({})
  const invertDisc = () => {
    const s: Record<string, boolean> = { ...selectedIds }
    discVisible.forEach((m) => { s[m.id] = !selectedIds[m.id] })
    setSelectedIds(s)
  }
  const discChip = discQ.trim()
    ? `${discSelCount}/${discVisible.length} · ${discovered?.length ?? 0}`
    : `${discSelCount}/${discovered?.length ?? 0}`

  // --- current list: search-aware bulk selection ----------------------------
  const curVisible = curList.filter((m) => matchQ(m, curQ))
  const curSelectedCount = curList.filter((m) => curSel[m.id]).length
  const selectedCurrent = curList.filter((m) => curSel[m.id])

  const toggleCurSel = (id: string) =>
    setCurSel((s) => ({ ...s, [id]: !s[id] }))
  const selectAllCur = () => {
    const s: Record<string, boolean> = {}
    curVisible.forEach((m) => { s[m.id] = true })
    setCurSel(s)
  }
  const unselectAllCur = () => setCurSel({})
  const invertCur = () => {
    const s: Record<string, boolean> = {}
    curVisible.forEach((m) => { s[m.id] = !curSel[m.id] })
    setCurSel(s)
  }
  /** Keep only ids still present after a write refreshes `models`. */
  const pruneCurSel = (list: ModelEntry[]) => {
    const alive = new Set(list.map((m) => m.id))
    setCurSel((s) => {
      const next: Record<string, boolean> = {}
      let changed = false
      for (const id of Object.keys(s)) {
        if (alive.has(id) && s[id]) next[id] = true
        else changed = true
      }
      return changed ? next : s
    })
  }

  const discover = async () => {
    setBusy(true); setStatus(null); setDiscovered(null)
    setSelectedIds({}); setCurSel({})
    try {
      const r = await call('discover-models', { route, baseURL: info.baseURL, api: info.api, apiKey: apiKeyProbe })
      const list: DiscoveredModel[] = r.models || []
      setDiscovered(list)
      const sel: Record<string, boolean> = {}
      list.forEach((m) => { sel[m.id] = true })
      setSelectedIds(sel)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const refreshModels = async (): Promise<ModelEntry[]> => {
    const fresh = await call('get-provider', { route })
    const list: ModelEntry[] = fresh.models || []
    setModels(list)
    setHiddenModels(fresh.hiddenModels || [])
    setCapabilityDraft({})
    setMappingDirty(false)
    setShownRows(ROW_PAGE)
    pruneCurSel(list)
    return list
  }

  const applyModels = async (mode: 'replace' | 'merge') => {
    if (!selectedModels.length) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('apply-models', { route, models: selectedModels, mode })
      setStatus({ kind: 'ok', text: fmt(t('statusModels'), { count: r.count }) })
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const removeSelected = async () => {
    const marked = selectedCurrent
    if (!marked.length) return
    if (!confirm(fmt(t('removeModelsConfirm'), { n: marked.length }))) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('apply-models', { route, models: marked, mode: 'remove' })
      setStatus({ kind: 'ok', text: fmt(t('statusModels'), { count: r.count }) })
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  /** Remember that the user has been told how hiding works.
   *
   * Persisted through the shared UI preferences (owned section), so the
   * explanation and the confirmation appear ONCE and then never again — the
   * action is reversible by design, and re-explaining it on every use is noise.
   * Fire-and-forget: a failed write only means the hint returns next page. */
  const markHideHintSeen = () => {
    if (hideHintSeen) return
    setHideHintSeen(true)
    void Promise.resolve(call('set-ui-prefs', { prefs: { hiddenModelsHintSeen: true } })).catch(() => {})
  }

  /** 隐藏：把选中的模型从模型选择器里摘出来，条目完整寄存到插件自有分区。
   * 与「删除选中」的区别是数据去向 —— 隐藏是"原样放回"，删除是丢弃。
   * 第一次会先解释并确认，之后就静默执行（见 markHideHintSeen）。 */
  const hideSelected = async () => {
    const marked = selectedCurrent
    if (!marked.length) return
    if (!hideHintSeen && !confirm(fmt(t('hideModelsConfirm'), { n: marked.length }))) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('apply-models', { route, models: marked.map(({ id }) => ({ id })), mode: 'hide' })
      setStatus({ kind: 'ok', text: fmt(t('statusHidden'), { count: r.parked ?? marked.length }) })
      setCurSel({})
      markHideHintSeen()
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  /** 显示：把寄存的条目按原位插回。来源记录由后端一并恢复。 */
  const showHidden = async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('apply-models', { route, models: ids.map((id) => ({ id })), mode: 'show' })
      setStatus({ kind: 'ok', text: fmt(t('statusShown'), { count: r.restored ?? ids.length }) })
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const setRequestModel = async (id: string, wire: string) => {
    const next = curList.map((m) => (m.id === id ? { ...m, ...(wire.trim() ? { requestModel: wire.trim() } : { requestModel: undefined }) } : m))
    setModels(next)
    setMappingDirty(true)
  }

  /** Save the whole current list — wire names plus any pending capability
   * choices. 能力展示结果不等于人工选择；普通保存只更新其它模型字段，
   * 未选择的能力模型条目不带 input/inputMode，由后端保留或重新判定来源。 */
  const saveModelConfig = async () => {
    const list = curList.map((m) => {
      const choice = draftCapability(m.id)
      const entry: Record<string, unknown> = { ...m, requestModel: m.requestModel?.trim() || null }
      delete entry.input
      delete entry.inputMode
      for (const key of Object.keys(entry)) if (key.startsWith('capability')) delete entry[key]
      if (!choice) return entry
      return { ...entry, inputMode: choice === 'auto' ? 'auto' : 'manual', input: choice === 'auto' ? null : capabilityInput(choice) }
    })
    if (!list.length) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('apply-models', { route, models: list, mode: 'merge' })
      setStatus({ kind: 'ok', text: fmt(t('statusModels'), { count: r.count }) })
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  /** 重新识别并保存能力 — catalog/official/provider-default detection only,
   * no inference requests. Manual choices survive; legacy configs are
   * re-reviewed (recheckLegacy) so an unknown source can be reconciled. */
  const identifyCapabilities = async () => {
    if (!curList.length || hasUnsavedConfig) return
    setBusy(true); setStatus(null)
    try {
      // 识别只发送 ID，避免把读取时附加的推断能力当成用户手动配置。
      const r = await call('apply-models', { route, models: curList.map(({ id }) => ({ id })), mode: 'identify', recheckLegacy: true })
      const fresh = await refreshModels()
      const summary = r.capabilitySummary as ModelCapabilitySummary | undefined
      const counts = summary ?? fresh.reduce((sum, m) => {
        if (m.input?.includes('image')) sum.image++
        else if (m.input?.includes('text')) sum.text++
        else sum.unknown++
        return sum
      }, { image: 0, text: 0, unknown: 0 })
      const result = summary
        ? fmt(t('statusCapabilities'), { image: summary.image, text: summary.text, unknown: summary.unknown, preserved: summary.preserved, updated: summary.updated, rechecked: summary.rechecked ?? 0, conflicts: summary.conflicts ?? 0 })
        : fmt(t('statusCapabilitiesCurrent'), { image: counts.image, text: counts.text, unknown: counts.unknown })
      const hint = counts.unknown > 0 ? ` ${t('capabilitiesUnconfirmed')}` : ''
      const conflictHint = (summary?.conflicts ?? 0) > 0 ? ` ${t('capabilityConflictHint')}` : ''
      setStatus({ kind: summary?.catalogUnavailable ? 'err' : 'ok', text: `${summary?.catalogUnavailable ? `${t('capabilityCatalogUnavailable')} ` : ''}${result}${hint}${conflictHint}` })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  // --- manual custom-model add ----------------------------------------------
  const setDraftField = (p: Partial<AddDraft>) => setDraft((d) => ({ ...d, ...p }))
  const numOrNull = (v: string): number | undefined => {
    const n = Number(v.trim())
    return v.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
  }

  const addCustomModel = async () => {
    const id = draft.id.trim()
    if (!id) { setStatus({ kind: 'err', text: t('needModelId') }); return }
    const entry: ModelEntry = {
      id,
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      ...(numOrNull(draft.ctx) != null ? { contextWindow: numOrNull(draft.ctx) } : {}),
      ...(numOrNull(draft.out) != null ? { maxTokens: numOrNull(draft.out) } : {}),
      ...(draft.wire.trim() ? { requestModel: draft.wire.trim() } : {}),
      ...(draft.capability !== 'auto' ? { input: capabilityInput(draft.capability), inputMode: 'manual' } : {}),
    } as ModelEntry
    setBusy(true); setStatus(null)
    try {
      await call('apply-models', { route, models: [entry], mode: 'merge' })
      setStatus({ kind: 'ok', text: fmt(t('statusModelAdded'), { id }) })
      setDraft(EMPTY_DRAFT)
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  /** Persist one model's reasoning declaration.
   *
   * `null` is sent as an explicit null — the host reads that as "clear the
   * field" (inherit the catalog). Omitting the key would mean "leave it alone",
   * which merge honours, so the two cannot be collapsed. */
  const saveReasoning = async (id: string, value: ReasoningEfforts | false | null) => {
    setBusy(true); setStatus(null)
    try {
      await call('apply-models', { route, models: [{ id, reasoningEfforts: value }], mode: 'merge' })
      setStatus({ kind: 'ok', text: t('reasonSaved') })
      setReasonFor(null)
      await refreshModels()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  /** The declared levels themselves, e.g. `off · minimal · … · max`.
   *
   * This is the string that made the row as wide as the level list, so it is no
   * longer rendered inline: it goes into the tooltip and into the advanced
   * block, while the row shows the SHORT summary below. */
  const reasonDetail = (m: ModelEntry): string => {
    const v = m.reasoningEfforts
    if (v === false) return t('reasonNone')
    if (v && typeof v === 'object') {
      const levels = THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(v, l))
      return levels.length ? levels.join(' · ') : t('reasonInherit')
    }
    return t('reasonInherit')
  }

  /** One-glance summary for the list row: the mode, and how many levels — never
   * the level names. Width stays bounded no matter how many levels a model
   * declares (seven of them spelled out is what overflowed the editor). */
  const reasonLabel = (m: ModelEntry): string => {
    const v = m.reasoningEfforts
    if (v === false) return t('reasonNone')
    if (v && typeof v === 'object') {
      const levels = THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(v, l))
      return levels.length ? fmt(t('reasonLevelCount'), { n: levels.length }) : t('reasonInherit')
    }
    return t('reasonInherit')
  }

  const searchInput = (value: string, onChange: (v: string) => void) => (    <input
      className="mpro-input mpro-inputMono mpro-searchInput"
      value={value}
      placeholder={t('searchPlaceholder')}
      onChange={(e) => onChange(e.target.value)}
    />
  )

  /** Read-only capability display: the value plus WHERE it came from. A
   * missing value renders as 未确认 — never as text-only. */
  const capabilityBadge = (model: ModelEntry) => {
    const choice = capabilityChoice(model)
    let sourceKey = 'capabilitySourceUnknown'
    switch (String(model.capabilitySource)) {
      case 'configured': sourceKey = 'capabilitySourceConfigured'; break
      case 'manual': sourceKey = 'capabilitySourceManual'; break
      case 'catalog': sourceKey = 'capabilitySourceCatalog'; break
      case 'official': sourceKey = 'capabilitySourceOfficial'; break
      case 'provider-default': sourceKey = 'capabilitySourceProviderDefault'; break
      case 'discovery': sourceKey = 'capabilitySourceDiscovery'; break
    }
    return (
      <div>
        <span className={choice === 'auto' ? 'mpro-chip mpro-capabilityUnknown' : 'mpro-chip'}>{t(choice === 'image' ? 'inputTextImage' : choice === 'text' ? 'inputTextOnly' : 'inputUnknown')}</span>
        <div className="mpro-hint">{t(sourceKey)}</div>
        {typeof model.capabilityReference === 'string' && model.capabilityReference && <div className="mpro-hint" style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{t('capabilityReferenceLabel')}: {model.capabilityReference}</div>}
        {model.capabilityConflict && <div className="mpro-hint">{t('capabilityConflictHint')}</div>}
      </div>
    )
  }

  const capabilitySelect = (value: CapabilityChoice, onChange: (value: CapabilityChoice) => void, label: string) => (
    <select
      className="mpro-input mpro-select mpro-capabilitySelect"
      aria-label={label}
      title={t('inputCapabilityHint')}
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value as CapabilityChoice)}
    >
      <option value="auto">{t('inputAuto')}</option>
      <option value="text">{t('inputTextOnly')}</option>
      <option value="image">{t('inputTextImage')}</option>
    </select>
  )

  return (
    <div className="mpro-panel">
      <p className="mpro-hint">{t('modelsHint')}</p>
      <p className="mpro-hint">{t('inputCapabilityHint')}</p>

      {/* discovery bar */}
      <div className="mpro-discoverBar">
        <div className="mpro-field" style={{ flex: 1.4, minWidth: 200 }}>
          <span className="mpro-fieldLabel">{t('baseURLField')}</span>
          <input
            className="mpro-input mpro-inputMono"
            value={info.baseURL}
            placeholder={t('baseURLPlaceholder')}
            onChange={(e) => set({ baseURL: e.target.value })}
          />
        </div>
        <div className="mpro-field" style={{ flex: 1, minWidth: 150 }}>
          <span className="mpro-fieldLabel">{t('apiField')}</span>
          <select
            className="mpro-input mpro-select"
            value={info.api}
            onChange={(e) => set({ api: e.target.value })}
          >
            {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="mpro-field" style={{ flex: 1, minWidth: 170 }}>
          <span className="mpro-fieldLabel">{t('apiKeyProbe')}</span>
          <input
            className="mpro-input mpro-inputMono"
            type="password"
            value={apiKeyProbe}
            placeholder="…"
            onChange={(e) => setApiKeyProbe(e.target.value)}
          />
        </div>
      </div>
      <div className="mpro-discoverBar" style={{ marginTop: -8 }}>
        <button className="mpro-btn mpro-btnPrimary" disabled={busy} onClick={() => void discover()}>
          {busy && discovered === null ? t('discovering') : t('discover')}
        </button>
        <button
          className={showAdd ? 'mpro-btn mpro-btnSm' : 'mpro-btn'}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? t('addModelHide') : t('addModelToggle')}
        </button>
        <span className="mpro-hint">{t('discoverHint')} {t('apiKeyProbeHint')}</span>
      </div>

      {/* manual custom-model add form */}
      {showAdd && (
        <div className="mpro-addBar">
          <div className="mpro-addBarHead">
            <p className="mpro-sectionTitle" style={{ margin: 0 }}>{t('addModelTitle')}</p>
            <span className="mpro-hint">{t('addModelHint')}</span>
          </div>
          <div className="mpro-addBarRow">
          <div className="mpro-field" style={{ flex: 1.6, minWidth: 200 }}>
            <span className="mpro-fieldLabel">{t('addModelIdField')}</span>
            <input
              className="mpro-input mpro-inputMono"
              value={draft.id}
              placeholder={t('addModelIdPlaceholder')}
              onChange={(e) => setDraftField({ id: e.target.value })}
            />
          </div>
          <div className="mpro-field" style={{ flex: 1, minWidth: 140 }}>
            <span className="mpro-fieldLabel">{t('addModelNameField')}</span>
            <input
              className="mpro-input"
              value={draft.name}
              onChange={(e) => setDraftField({ name: e.target.value })}
            />
          </div>
          <div className="mpro-field" style={{ flex: 0.8, minWidth: 110 }}>
            <span className="mpro-fieldLabel">{t('addModelCtxField')}</span>
            <input
              className="mpro-input mpro-inputMono"
              inputMode="numeric"
              value={draft.ctx}
              placeholder="—"
              onChange={(e) => setDraftField({ ctx: e.target.value })}
            />
          </div>
          <div className="mpro-field" style={{ flex: 0.8, minWidth: 110 }}>
            <span className="mpro-fieldLabel">{t('addModelOutField')}</span>
            <input
              className="mpro-input mpro-inputMono"
              inputMode="numeric"
              value={draft.out}
              placeholder="—"
              onChange={(e) => setDraftField({ out: e.target.value })}
            />
          </div>
          <div className="mpro-field" style={{ flex: 1, minWidth: 140 }}>
            <span className="mpro-fieldLabel">{t('addModelWireField')}</span>
            <input
              title={t('reqModelHint')}
              className="mpro-input mpro-inputMono"
              value={draft.wire}
              placeholder="—"
              onChange={(e) => setDraftField({ wire: e.target.value })}
            />
          </div>
          <div className="mpro-field" style={{ flex: 1, minWidth: 150 }}>
            <span className="mpro-fieldLabel">{t('inputCapabilityCol')}</span>
            {capabilitySelect(draft.capability, (capability) => setDraftField({ capability }), t('addModelInputLabel'))}
          </div>
          <button
            className="mpro-btn mpro-btnPrimary"
            disabled={busy || !draft.id.trim()}
            onClick={() => void addCustomModel()}
          >
            {busy ? t('addingModel') : t('addModelBtn')}
          </button>
          </div>
        </div>
      )}

      {/* discovered */}
      {discovered && (
        <>
          <div>
            <div className="mpro-modelBar">
              <p className="mpro-sectionTitle" style={{ margin: 0 }}>{fmt(t('discoveredTitle'), { n: discovered.length })}</p>
              {searchInput(discQ, setDiscQ)}
              <span className="mpro-right" />
              <button className="mpro-btn mpro-btnSm" onClick={selectAllDisc}>{t('selectAll')}</button>
              <button className="mpro-btn mpro-btnSm" onClick={unselectAllDisc}>{t('unselectAll')}</button>
              <button className="mpro-btn mpro-btnSm" onClick={invertDisc}>{t('invert')}</button>
              <span className="mpro-chip mpro-chipSel">{discChip}</span>
            </div>
            {discovered.length === 0 ? (
              <div className="mpro-emptyState">{t('emptyDiscovered')}</div>
            ) : discVisible.length === 0 ? (
              <div className="mpro-emptyState">{fmt(t('searchNoMatch'), { q: discQ.trim() })}</div>
            ) : (
              <div className="mpro-tblWrap">
                <table className="mpro-tbl">
                  <thead>
                    <tr>
                      <th className="mpro-tblCk"></th>
                      <th>{t('idCol')}</th>
                      <th>{t('nameCol')}</th>
                      <th>{t('inputCapabilityCol')}</th>
                      <th>{t('ctxCol')}</th>
                      <th>{t('outCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discVisible.map((m) => (
                      <tr key={m.id}>
                        <td className="mpro-tblCk">
                          <input type="checkbox" checked={!!selectedIds[m.id]} onChange={() => toggleSel(m.id)} />
                        </td>
                        <td className="mpro-id">{m.id}</td>
                        <td>{m.name || m.id}</td>
                        <td>{capabilityBadge(m as ModelEntry)}</td>
                        <td className="mpro-dim">{m.contextWindow ? String(m.contextWindow) : '—'}</td>
                        <td className="mpro-dim">{m.maxTokens ? String(m.maxTokens) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mpro-formFooter">
              <button className="mpro-btn mpro-btnPrimary" disabled={busy || !selectedModels.length} onClick={() => void applyModels('replace')}>
                {t('applyReplace')}
              </button>
              <button className="mpro-btn" disabled={busy || !selectedModels.length} onClick={() => void applyModels('merge')}>
                {t('applyMerge')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* current explicit models */}
      <div>
        <div className="mpro-modelBar">
          <p className="mpro-sectionTitle" style={{ margin: 0 }}>{fmt(t('currentModelsTitle'), { n: curList.length })}</p>
          {curList.length > 0 && searchInput(curQ, (v) => { setCurQ(v); setShownRows(ROW_PAGE) })}
          <span className="mpro-right" />
          {curList.length > 0 && (
            <>
              <button className="mpro-btn mpro-btnSm" onClick={selectAllCur}>{t('selectAll')}</button>
              <button className="mpro-btn mpro-btnSm" onClick={unselectAllCur}>{t('unselectAll')}</button>
              <button className="mpro-btn mpro-btnSm" onClick={invertCur}>{t('invert')}</button>
            </>
          )}
          {(curList || []).length > 0 && (
            <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => void saveModelConfig()}>
              {t('saveModelConfig')}
            </button>
          )}
          {(curList || []).length > 0 && (
            <button
              className="mpro-btn mpro-btnSm"
              disabled={busy || hasUnsavedConfig}
              title={hasUnsavedConfig ? t('saveModelConfigFirst') : undefined}
              onClick={() => void identifyCapabilities()}
            >
              {t('identifyCapabilities')}
            </button>
          )}
          {curList.length > 0 && (
            <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => setFillOpen((v) => !v)}>
              {t('reasonLocalFill')}
            </button>
          )}
          {curSelectedCount > 0 && (
            <button
              className="mpro-btn mpro-btnSm"
              disabled={busy || curSelectedCount >= curList.length}
              title={curSelectedCount >= curList.length ? t('hideLastModelHint') : hideHintSeen ? undefined : t('hideModelsHint')}
              onClick={() => void hideSelected()}
            >
              {t('hideSelected')} ({curSelectedCount})
            </button>
          )}
          {curSelectedCount > 0 && (
            <button className="mpro-btn mpro-btnSm mpro-btnDanger" disabled={busy} onClick={() => void removeSelected()}>
              {t('removeSelected')} ({curSelectedCount})
            </button>
          )}
        </div>
        {fillOpen && (
          <LocalFillPanel
            t={t}
            call={call}
            scope={{ kind: 'provider', route }}
            busy={busy}
            setBusy={setBusy}
            fail={fail}
            setStatus={setStatus}
            onDone={async () => { await refreshModels() }}
            onClose={() => setFillOpen(false)}
          />
        )}
        {!curList.length ? (
          <div className="mpro-emptyState">{t('emptyModels')}</div>
        ) : curVisible.length === 0 ? (
          <div className="mpro-emptyState">{fmt(t('searchNoMatch'), { q: curQ.trim() })}</div>
        ) : (
          <div className="mpro-tblWrap mpro-currentTblWrap">
            <table className="mpro-tbl mpro-currentTbl">
              <thead>
                <tr>
                  <th className="mpro-tblCk"></th>
                  <th>{t('idCol')}</th>
                  <th>{t('nameCol')}</th>
                  <th>{t('configCol')}</th>
                </tr>
              </thead>
              <tbody>
                {curVisible.slice(0, shownRows).map((m) => (
                  <React.Fragment key={m.id}>
                    <tr>
                      <td className="mpro-tblCk">
                        <input type="checkbox" checked={!!curSel[m.id]} onChange={() => toggleCurSel(m.id)} />
                      </td>
                      <td className="mpro-id">{m.id}</td>
                      <td>{m.name || m.id}</td>
                      {/* 行内只有一个入口：能力徽标、来源说明、能力下拉、转发名、档位
                          摘要这些一旦并排就会把表格撑宽（最长的那串是档位名与"来源未
                          确认"），所以它们全部下沉到展开面板，按字段逐行排。 */}
                      <td className="mpro-rowAction">
                        <button
                          className="mpro-btn mpro-btnSm"
                          data-row={m.id}
                          aria-expanded={configFor === m.id}
                          onClick={() => toggleConfig(m.id)}
                        >
                          {configFor === m.id ? t('modelConfigClose') : t('modelConfigOpen')}
                        </button>
                      </td>
                    </tr>
                    {configFor === m.id && (
                      <tr>
                        <td colSpan={4}>
                          <div className="mpro-configPanel">
                            <div className="mpro-configField">
                              <span className="mpro-configLabel">{t('inputCapabilityCol')}</span>
                              <div className="mpro-capabilityCell">
                                {capabilityBadge(m)}
                                {capabilitySelect(
                                  draftCapability(m.id) ?? (m.capabilitySource === 'manual' ? capabilityChoice(m) : 'auto'),
                                  (choice) => setCapabilityDraft((d) => ({ ...d, [m.id]: choice })),
                                  `${t('inputCapabilityCol')}: ${m.id}`,
                                )}
                              </div>
                            </div>
                            <div className="mpro-configField">
                              <span className="mpro-configLabel">{t('reqModelField')}</span>
                              <input
                                aria-label={`${t('reqModelField')}: ${m.id}`}
                                title={t('reqModelHint')}
                                className="mpro-input mpro-inputMono mpro-wireInput"
                                disabled={busy}
                                value={m.requestModel || ''}
                                placeholder="—"
                                onChange={(e) => void setRequestModel(m.id, e.target.value)}
                              />
                            </div>
                            <div className="mpro-configField">
                              <span className="mpro-configLabel">{t('reasonCol')}</span>
                              <code className="mpro-reasonTag" title={reasonDetail(m)}>{reasonLabel(m)}</code>
                              <button
                                className="mpro-btn mpro-btnSm"
                                onClick={() => setReasonFor(reasonFor === m.id ? null : m.id)}
                              >
                                {t('reasonEditLevels')}
                              </button>
                            </div>
                          </div>
                          {reasonFor === m.id && (
                            <ReasoningEditor
                              t={t}
                              call={call}
                              route={route}
                              model={m}
                              catalog={catalog || { enabled: false, url: '' }}
                              busy={busy}
                              onSave={(v) => saveReasoning(m.id, v)}
                              onClose={() => setReasonFor(null)}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {curVisible.length > shownRows && (
              <div className="mpro-moreRows">
                <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => setShownRows((n) => n + ROW_PAGE)}>
                  {fmt(t('showMoreRows'), { n: curVisible.length - shownRows })}
                </button>
                <span className="mpro-dim">{fmt(t('rowsShown'), { shown: Math.min(shownRows, curVisible.length), total: curVisible.length })}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* hidden (parked) models — taken out of the model selector, stored complete.
          Kept visually distinct from the live list: these entries are NOT served by
          the adapter, and a click puts them back at their original position.
          While there is nothing parked, the whole block exists only to explain the
          feature ONCE (see hideHintSeen); afterwards it stays out of the way. */}
      {(hiddenModels.length > 0 || !hideHintSeen) && (
      <div>
        <div className="mpro-modelBar">
          <p className="mpro-sectionTitle" style={{ margin: 0 }}>{fmt(t('hiddenModelsTitle'), { n: hiddenModels.length })}</p>
          <span className="mpro-right" />
          {hiddenModels.length > 0 && (
            <button
              className="mpro-btn mpro-btnSm"
              disabled={busy}
              onClick={() => void showHidden(hiddenModels.map((m) => m.id))}
            >
              {t('showAllHidden')}
            </button>
          )}
        </div>
        {hiddenModels.length === 0 ? (
          <div className="mpro-emptyState">{t('hiddenModelsEmpty')}</div>
        ) : (
          <div className="mpro-tblWrap">
            <table className="mpro-tbl">
              <thead>
                <tr>
                  <th className="mpro-tblCk"></th>
                  <th>{t('idCol')}</th>
                  <th>{t('nameCol')}</th>
                  <th>{t('reqModelField')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hiddenModels.map((m) => (
                  <tr key={m.id}>
                    <td><span className="mpro-hiddenChip" title={t('stateHidden')}>{t('stateHidden')}</span></td>
                    <td className="mpro-id">{m.id}</td>
                    <td>{m.name || m.id}</td>
                    <td className="mpro-dim">{m.requestModel || '—'}</td>
                    <td>
                      <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => void showHidden([m.id])}>
                        {t('showModel')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {inlineStatus}
    </div>
  )
}
