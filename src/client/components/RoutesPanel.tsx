/** RoutesPanel — 智能路由页（重设计：4 个分段）。
 *
 *  ① 路由台   — 命名路由清单 + 编辑器（策略/权重/目标开关/路由参数）
 *  ② 组合提供商 — 并集/交集 合并多个 provider 的模型成虚拟 provider
 *  ③ 观测台   — 本次会话的路由统计（调用/成功率/平均耗时/token）+ 请求日志
 *  ④ 探活     — 每个目标（provider+model）的健康状态 + 批量/单点探测
 *
 * 数据均来自 Host 端 RPC（list-routes / set-route / delete-route，
 * list-composites / set-composite / delete-composite / preview-composite，
 * get-route-stats / list-request-logs / clear-request-logs，
 * probe-target / probe-all）。 */

import React from '../react'
import type { ProviderListItem, RouteSpec, RouteTarget, TFunc, CallFn, TargetHealth } from '../../shared/types'

interface Props {
  t: TFunc
  call: CallFn
  providers: ProviderListItem[]
}

type RoutesTab = 'routes' | 'composites' | 'obs' | 'probe'

const STRATEGIES = ['priority', 'weighted', 'round-robin', 'min-latency', 'sticky'] as const
const HEALTH_DOT: Record<TargetHealth['status'], string> = {
  up: 'mpro-hdotUp',
  down: 'mpro-hdotDown',
  unknown: 'mpro-hdotUnknown',
  probing: 'mpro-hdotProbing',
}

const EMPTY_TARGETS = (): RouteTarget[] => []

function strategyLabel(t: TFunc, s: string): string {
  const key = `routeStrategy${s.charAt(0).toUpperCase()}${s.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`
  const label = t(key)
  return label === key ? s : label
}

export function RoutesPanel({ t, call, providers }: Props) {
  const [tab, setTab] = React.useState<RoutesTab>('routes')

  return (
    <div className="mpro-routesRoot">
      <div className="mpro-routesTabs">
        {([
          ['routes', 'tabRoutesMain'],
          ['composites', 'tabComposites'],
          ['obs', 'tabObservability'],
          ['probe', 'tabProbe'],
        ] as Array<[RoutesTab, string]>).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'mpro-routesTab mpro-routesTabActive' : 'mpro-routesTab'}
            onClick={() => setTab(id)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {tab === 'routes' ? (
        <RouteListPanel t={t} call={call} providers={providers} />
      ) : tab === 'composites' ? (
        <CompositePanel t={t} call={call} providers={providers} />
      ) : tab === 'obs' ? (
        <ObservabilityPanel t={t} call={call} />
      ) : (
        <ProbePanel t={t} call={call} />
      )}
    </div>
  )
}

/* --------------------------------------------------------------------------
 * ① Route dashboard — list + editor
 * ------------------------------------------------------------------------ */

function RouteListPanel({ t, call, providers }: Props) {
  const [routes, setRoutes] = React.useState<Record<string, RouteSpec>>({})
  const [name, setName] = React.useState('')
  const [strategy, setStrategy] = React.useState('priority')
  const [targets, setTargets] = React.useState<RouteTarget[]>(EMPTY_TARGETS())
  const [config, setConfig] = React.useState<{ healthAware: boolean; sticky: boolean; maxFallbacks: string; timeoutMs: string }>({
    healthAware: true, sticky: false, maxFallbacks: '', timeoutMs: '',
  })
  const [modelsByProvider, setModelsByProvider] = React.useState<Record<string, string[]>>({})
  const [editing, setEditing] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  /** Row index being dragged, and the row currently hovered as a drop target. */
  const [dragFrom, setDragFrom] = React.useState<number | null>(null)
  const [dragOver, setDragOver] = React.useState<number | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const r = await call('list-routes')
      setRoutes(r.routes || {})
    } catch (e) {
      setMsg(t('routeLoadErr') + String((e as Error)?.message || e))
    }
  }, [call, t])

  React.useEffect(() => { void refresh() }, [refresh])

  const ensureModels = async (p: string) => {
    if (!p || modelsByProvider[p]) return
    try {
      const r = await call('get-provider', { route: p })
      const ids: string[] = [
        ...((r.models || []).map((m: any) => (m && typeof m.id === 'string' ? m.id : '')).filter(Boolean)),
        ...((r.availableModels || []).filter(Boolean)),
      ]
      setModelsByProvider((m) => ({ ...m, [p]: Array.from(new Set(ids)) }))
    } catch {
      setModelsByProvider((m) => ({ ...m, [p]: [] }))
    }
  }

  const resetForm = () => {
    setEditing(null)
    setName('')
    setStrategy('priority')
    setTargets(EMPTY_TARGETS())
    setConfig({ healthAware: true, sticky: false, maxFallbacks: '', timeoutMs: '' })
  }

  const startEdit = (n: string) => {
    const spec = routes[n]
    if (!spec) return
    setEditing(n)
    setName(n)
    setStrategy(spec.strategy || 'priority')
    setTargets(spec.targets.map((x) => ({ ...x })))
    setConfig({
      healthAware: spec.config?.healthAware !== false,
      sticky: !!spec.config?.sticky,
      maxFallbacks: spec.config?.maxFallbacks != null ? String(spec.config.maxFallbacks) : '',
      timeoutMs: spec.config?.timeoutMs != null ? String(spec.config.timeoutMs) : '',
    })
    spec.targets.forEach((x) => void ensureModels(x.provider))
  }

  const setTarget = (i: number, patch: Partial<RouteTarget>) => {
    setTargets((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
    if (patch.provider) void ensureModels(patch.provider)
  }
  const addTarget = () => setTargets((arr) => [...arr, { provider: '', model: '', weight: 1, enabled: true }])
  const removeTarget = (i: number) => setTargets((arr) => arr.filter((_, idx) => idx !== i))
  const moveTarget = (i: number, delta: -1 | 1) => {
    setTargets((arr) => {
      const j = i + delta
      if (j < 0 || j >= arr.length) return arr
      const next = [...arr]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  /** Drag-and-drop reorder: REMOVE then INSERT, so dragging row 0 to the end
   * shifts everything between up by one. A swap (like moveTarget) would be wrong
   * for non-adjacent drops — it would scramble the priority order. */
  const reorderTarget = (from: number, to: number) => {
    setTargets((arr) => {
      if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
      const next = [...arr]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const submit = async () => {
    const valid = targets.filter((x) => x.provider && x.model)
    if (!name.trim() || !valid.length) return
    setBusy(true)
    setMsg('')
    try {
      const sent = valid.map((x) => ({
        provider: x.provider,
        model: x.model,
        ...(typeof x.weight === 'number' && x.weight > 0 ? { weight: x.weight } : {}),
        ...(typeof x.enabled === 'boolean' ? { enabled: x.enabled } : {}),
      }))
      const cfgPayload: Record<string, unknown> = {}
      if (config.healthAware === false) cfgPayload.healthAware = false
      if (config.sticky) cfgPayload.sticky = true
      if (config.maxFallbacks.trim() !== '' && Number(config.maxFallbacks) >= 0) cfgPayload.maxFallbacks = Math.floor(Number(config.maxFallbacks))
      if (config.timeoutMs.trim() !== '' && Number(config.timeoutMs) > 0) cfgPayload.timeoutMs = Number(config.timeoutMs)
      await call('set-route', {
        alias: name.trim(),
        strategy,
        targets: sent,
        ...(Object.keys(cfgPayload).length ? { config: cfgPayload } : {}),
      })
      resetForm()
      setMsg(t('routeSaved'))
      await refresh()
    } catch (e) {
      setMsg(String((e as Error)?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (n: string) => {
    try {
      await call('delete-route', { alias: n })
      setMsg(t('routeDeleted'))
      if (editing === n) resetForm()
      await refresh()
    } catch (e) {
      setMsg(String((e as Error)?.message || e))
    }
  }

  const entries = Object.entries(routes)
  const weightHints = strategy === 'weighted' || strategy === 'round-robin'

  return (
    <div className="mpro-card">
      <div className="mpro-cardHead">
        <div>
          <h3 className="mpro-cardTitle">{t('routesTitle')}</h3>
          <p className="mpro-hint" style={{ marginTop: 2 }}>{t('routesHint')}</p>
        </div>
        <button className="mpro-btn mpro-btnPrimary" onClick={() => { resetForm(); setEditing('') }} disabled={!!editing}>
          {t('routeAdd')}
        </button>
      </div>
      <div className="mpro-cardBody">
        {entries.length ? (
          <div>
            {entries.map(([n, spec]) => (
              <div key={n} className="mpro-routeRow">
                <div className="mpro-routeMain">
                  <div className="mpro-routeNameRow">
                    <span className="mpro-routeName">{n}</span>
                    <span className="mpro-chip mpro-chipMono">{strategyLabel(t, spec.strategy)}</span>
                    {spec.config?.healthAware === false ? <span className="mpro-chip mpro-chipMiss">{t('routeCfgHealthAware')} ×</span> : null}
                  </div>
                  <span className="mpro-routeChain">
                    {spec.targets.map((x, i) => (
                      <span key={i}>
                        {i > 0 ? ' → ' : ''}
                        {x.provider}/{x.model}
                        {typeof x.weight === 'number' && x.weight > 0 ? <span className="mpro-routeW"> ·{x.weight}</span> : null}
                        {x.enabled === false ? <span className="mpro-routeW"> ·⛔</span> : null}
                      </span>
                    ))}
                  </span>
                </div>
                <div className="mpro-routeActions">
                  <button className="mpro-btn mpro-btnSm" onClick={() => startEdit(n)}>{t('edit')}</button>
                  <button className="mpro-btn mpro-btnSm mpro-btnDanger" onClick={() => void remove(n)}>{t('routeDelete')}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mpro-emptyState" style={{ padding: '16px 12px' }}>{t('routeEmpty')}</div>
        )}

        {editing !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 14 }}>
            <div className="mpro-hdrAdd">
              <input
                className="mpro-input mpro-inputMono"
                style={{ width: 140 }}
                value={name}
                placeholder={t('routeNamePlaceholder')}
                disabled={!!editing && editing !== ''}
                onChange={(e) => setName(e.target.value)}
              />
              <select className="mpro-input mpro-select" style={{ width: 200 }} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                {STRATEGIES.map((s) => <option key={s} value={s}>{strategyLabel(t, s)}</option>)}
              </select>
              <button className="mpro-btn" onClick={addTarget}>+ {t('routeAddTarget')}</button>
            </div>

            {targets.map((row, i) => (
              <div
                key={i}
                className={dragOver === i && dragFrom !== null && dragFrom !== i ? 'mpro-targetRow mpro-targetRowOver' : 'mpro-targetRow'}
                draggable
                onDragStart={(e) => {
                  setDragFrom(i)
                  // Firefox refuses to start a drag without transfer data.
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', String(i)) } catch { /* ignore */ }
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault() // required, or the drop event never fires
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOver !== i) setDragOver(i)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragFrom !== null) reorderTarget(dragFrom, i)
                  setDragFrom(null)
                  setDragOver(null)
                }}
                onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
              >
                <span className="mpro-dragHandle" title={t('routeDragHint')} aria-hidden="true">⠿</span>
                <span className="mpro-targetIdx" title={t('routeOrderHint')}>{i + 1}</span>
                <select
                  className="mpro-input mpro-select"
                  value={row.provider}
                  onChange={(e) => setTarget(i, { provider: e.target.value, model: '' })}
                >
                  <option value="">{t('routeProvider')}</option>
                  {providers.filter((p) => !p.disabled).map((p) => <option key={p.route} value={p.route}>{p.displayName || p.route}</option>)}
                </select>
                <select
                  className="mpro-input mpro-select"
                  value={row.model}
                  onChange={(e) => setTarget(i, { model: e.target.value })}
                >
                  <option value="">{row.provider ? t('routeModel') : t('routePickProviderFirst')}</option>
                  {(modelsByProvider[row.provider] || []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input
                  className="mpro-input mpro-inputMono mpro-weight"
                  type="number"
                  min={1}
                  value={row.weight ?? 1}
                  disabled={!weightHints}
                  title={weightHints ? t('routeWeight') : t('routeStrategyHint')}
                  onChange={(e) => setTarget(i, { weight: Number(e.target.value) || 1 })}
                />
                <label className="mpro-enabledCk" title={t('routeEnabled')}>
                  <input
                    type="checkbox"
                    checked={row.enabled !== false}
                    onChange={(e) => setTarget(i, { enabled: e.target.checked })}
                  />
                </label>
                {/* Keyboard-accessible equivalent of dragging: a pointer-only
                    reorder would lock out keyboard and screen-reader users. */}
                <span className="mpro-moveBtns">
                  <button
                    className="mpro-moveBtn"
                    disabled={i === 0}
                    title={t('routeMoveUp')}
                    aria-label={t('routeMoveUp')}
                    onClick={() => moveTarget(i, -1)}
                  >↑</button>
                  <button
                    className="mpro-moveBtn"
                    disabled={i === targets.length - 1}
                    title={t('routeMoveDown')}
                    aria-label={t('routeMoveDown')}
                    onClick={() => moveTarget(i, 1)}
                  >↓</button>
                </span>
                <button className="mpro-btn mpro-btnSm mpro-btnDanger" onClick={() => removeTarget(i)}>×</button>
              </div>
            ))}

            {targets.length > 1 ? <p className="mpro-hint">{t('routeDragHint')}</p> : null}

            <div className="mpro-cfgGrid">
              <label className="mpro-toggleCk">
                <input
                  type="checkbox"
                  checked={config.healthAware}
                  onChange={(e) => setConfig((c) => ({ ...c, healthAware: e.target.checked }))}
                />
                {t('routeCfgHealthAware')}
              </label>
              <label className="mpro-toggleCk">
                <input
                  type="checkbox"
                  checked={config.sticky}
                  onChange={(e) => setConfig((c) => ({ ...c, sticky: e.target.checked }))}
                />
                {t('routeCfgSticky')}
              </label>
              <div className="mpro-field">
                <span className="mpro-fieldLabel">{t('routeCfgMaxFallbacks')}</span>
                <input
                  className="mpro-input mpro-inputMono"
                  type="number"
                  min={0}
                  value={config.maxFallbacks}
                  onChange={(e) => setConfig((c) => ({ ...c, maxFallbacks: e.target.value }))}
                  placeholder="∞"
                />
              </div>
              <div className="mpro-field">
                <span className="mpro-fieldLabel">{t('routeCfgTimeout')}</span>
                <input
                  className="mpro-input mpro-inputMono"
                  type="number"
                  min={0}
                  value={config.timeoutMs}
                  onChange={(e) => setConfig((c) => ({ ...c, timeoutMs: e.target.value }))}
                  placeholder="—"
                />
              </div>
            </div>
            <p className="mpro-hint">{t('routeCfgHint')}</p>
            {weightHints ? <p className="mpro-hint">{t('routeStrategyHint')}</p> : null}

            <div className="mpro-hdrAdd">
              <button
                className="mpro-btn mpro-btnPrimary"
                disabled={busy || !name.trim() || !targets.some((x) => x.provider && x.model)}
                onClick={() => void submit()}
              >
                {editing === '' ? t('routeAdd') : t('routeUpdate')}
              </button>
              <button className="mpro-btn mpro-btnGhost" onClick={resetForm}>{t('cancel')}</button>
            </div>
          </div>
        )}

        {/* Retry budget is GLOBAL to the router/composite provider routes (DSH
            reads one policy per provider route, frozen at registration), so it
            belongs beside the route list rather than inside one route's editor. */}
        <RetryBudget t={t} call={call} />

        {msg ? <span className="mpro-inlineStatus" style={{ marginTop: 6, display: 'inline-block' }}>{msg}</span> : null}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Retry budget — DSH's own request-retry ceiling for the router routes
 * ------------------------------------------------------------------------ */

/** DSH retries a failed model request through its `llm-retry` plugin, using ONE
 * policy per provider route that is frozen when the adapter registers. A router
 * failure used to normalize to code `UNKNOWN`, which no policy lists as
 * retryable, so a routed request never retried. The host now throws a dedicated
 * retryable code and reports this budget; saving re-registers the adapter so the
 * change applies without a reload. */
function RetryBudget({ t, call }: { t: TFunc; call: CallFn }) {
  const [value, setValue] = React.useState('0')
  const [saved, setSaved] = React.useState('0')
  const [max, setMax] = React.useState(20)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState('')

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await call('get-retry-prefs')
        const n = String(r?.prefs?.maxRetries ?? 0)
        setValue(n)
        setSaved(n)
        if (typeof r?.max === 'number') setMax(r.max)
      } catch { /* keep defaults — the control still saves */ }
    })()
  }, [call])

  const commit = async (next: string) => {
    const n = Math.max(0, Math.min(max, Math.floor(Number(next) || 0)))
    setBusy(true)
    setNote('')
    try {
      const r = await call('set-retry-prefs', { prefs: { maxRetries: n } })
      const applied = String(r?.prefs?.maxRetries ?? n)
      setValue(applied)
      setSaved(applied)
      // `applied: false` means the running registration could not be swapped, so
      // the value is stored but only takes effect after the next load.
      setNote(r?.applied === false ? t('retryNeedsReload') : t('retrySaved'))
    } catch (e) {
      setValue(saved)
      setNote(String((e as Error)?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mpro-retryBox">
      <div className="mpro-retryHead">
        <span className="mpro-fieldLabel">{t('retryTitle')}</span>
        {note ? <span className="mpro-inlineStatus">{note}</span> : null}
      </div>
      <div className="mpro-retryRow">
        <input
          className="mpro-retrySlider"
          type="range"
          min={0}
          max={max}
          step={1}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          // Commit on release, not on every drag frame: each save writes settings
          // and re-registers the adapter.
          onMouseUp={(e) => void commit((e.target as HTMLInputElement).value)}
          onTouchEnd={(e) => void commit((e.target as HTMLInputElement).value)}
          onKeyUp={(e) => void commit((e.target as HTMLInputElement).value)}
        />
        <span className="mpro-retryValue">{value === '0' ? t('retryOff') : value}</span>
      </div>
      <p className="mpro-hint">{t('retryHint')}</p>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * ② Composite providers — union / intersection
 * ------------------------------------------------------------------------ */

interface CompositeFormState {
  name: string
  members: string[]
  mode: 'union' | 'intersection'
  strategy: string
}

const EMPTY_COMPOSITE = (): CompositeFormState => ({ name: '', members: [], mode: 'union', strategy: 'priority' })

function CompositePanel({ t, call, providers }: Props) {
  const [composites, setComposites] = React.useState<Record<string, { members: string[]; mode: string; strategy: string }>>({})
  const [form, setForm] = React.useState<CompositeFormState>(EMPTY_COMPOSITE())
  const [preview, setPreview] = React.useState<{ ids: string[]; mode: string; loading: boolean; ran: boolean }>({ ids: [], mode: 'union', loading: false, ran: false })
  const [editing, setEditing] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')

  const refresh = React.useCallback(async () => {
    try {
      const r = await call('list-composites')
      setComposites(r.composites || {})
    } catch (e) {
      setMsg(t('compositeLoadErr') + String((e as Error)?.message || e))
    }
  }, [call, t])

  React.useEffect(() => { void refresh() }, [refresh])

  const runPreview = async (name: string, mode: string) => {
    setPreview({ ids: [], mode, loading: true, ran: true })
    try {
      const r = await call('preview-composite', { name })
      setPreview({ ids: r.ids || [], mode: r.mode || mode, loading: false, ran: true })
    } catch {
      setPreview({ ids: [], mode, loading: false, ran: true })
    }
  }

  const resetForm = () => {
    setEditing(null)
    setForm(EMPTY_COMPOSITE())
    setPreview({ ids: [], mode: 'union', loading: false, ran: false })
  }

  const startEdit = (n: string) => {
    const c = composites[n]
    if (!c) return
    setEditing(n)
    setForm({ name: n, members: [...c.members], mode: c.mode === 'intersection' ? 'intersection' : 'union', strategy: c.strategy || 'priority' })
    setPreview({ ids: [], mode: c.mode === 'intersection' ? 'intersection' : 'union', loading: false, ran: false })
  }

  const toggleMember = (m: string) => {
    setForm((f) => ({
      ...f,
      members: f.members.includes(m) ? f.members.filter((x) => x !== m) : [...f.members, m],
    }))
  }

  const submit = async () => {
    if (form.members.length < 2) { setMsg(t('compositeNeedTwo')); return }
    setBusy(true)
    setMsg('')
    try {
      await call('set-composite', {
        name: form.name.trim(),
        members: form.members,
        mode: form.mode,
        strategy: form.strategy,
      })
      resetForm()
      setMsg(t('compositeSaved'))
      await refresh()
    } catch (e) {
      setMsg(String((e as Error)?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (n: string) => {
    try {
      await call('delete-composite', { name: n })
      setMsg(t('compositeDeleted'))
      if (editing === n) resetForm()
      await refresh()
    } catch (e) {
      setMsg(String((e as Error)?.message || e))
    }
  }

  const entries = Object.entries(composites)
  const enabledProviders = providers.filter((p) => !p.disabled)

  return (
    <div className="mpro-card">
      <div className="mpro-cardHead">
        <div>
          <h3 className="mpro-cardTitle">{t('compositeTitle')}</h3>
          <p className="mpro-hint" style={{ marginTop: 2 }}>{t('compositeHint')}</p>
        </div>
        <button className="mpro-btn mpro-btnPrimary" onClick={() => { resetForm(); setEditing('') }} disabled={!!editing}>
          {t('compositeAdd')}
        </button>
      </div>
      <div className="mpro-cardBody">
        {entries.length ? (
          <div>
            {entries.map(([n, c]) => (
              <div key={n} className="mpro-routeRow">
                <div className="mpro-routeMain">
                  <div className="mpro-routeNameRow">
                    <span className="mpro-routeName">{n}</span>
                    <span className="mpro-chip mpro-chipMono">{c.mode}</span>
                    <span className="mpro-chip mpro-chipMono">{strategyLabel(t, c.strategy)}</span>
                  </div>
                  <span className="mpro-routeChain">{c.members.join(' + ')}</span>
                </div>
                <div className="mpro-routeActions">
                  <button className="mpro-btn mpro-btnSm" onClick={() => startEdit(n)}>{t('edit')}</button>
                  <button className="mpro-btn mpro-btnSm" onClick={() => void runPreview(n, c.mode)}>
                    {t('compositePreview')}
                  </button>
                  <button className="mpro-btn mpro-btnSm mpro-btnDanger" onClick={() => void remove(n)}>{t('routeDelete')}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mpro-emptyState" style={{ padding: '16px 12px' }}>{t('compositeEmpty')}</div>
        )}

        {preview.ran && preview.loading ? (
          <div className="mpro-hint">{t('compositePreviewing')}</div>
        ) : preview.ran && !preview.loading && preview.ids.length ? (
          <div className="mpro-previewBox">
            <span className="mpro-previewCount">{t('compositePreviewCount').replace('{n}', String(preview.ids.length))}</span>
            <div className="mpro-previewChips">
              {preview.ids.map((id) => (
                <span key={id} className="mpro-chip mpro-chipMono">{id}</span>
              ))}
            </div>
          </div>
        ) : preview.ran && !preview.loading ? (
          <div className="mpro-hint">{t('compositePreviewEmpty')}</div>
        ) : null}

        {editing !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 14 }}>
            <input
              className="mpro-input mpro-inputMono"
              style={{ width: 180 }}
              value={form.name}
              placeholder={t('compositeNamePlaceholder')}
              disabled={editing !== ''}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div className="mpro-field">
              <span className="mpro-fieldLabel">{t('compositeMembers')}（{enabledProviders.length} 可用）</span>
              <div className="mpro-hdrAdd">
                {enabledProviders.map((p) => (
                  <label key={p.route} className="mpro-chip" style={{ cursor: 'pointer', ...(form.members.includes(p.route) ? { color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } : {}) }}>
                    <input
                      type="checkbox"
                      style={{ accentColor: 'var(--dsw-alias-brand-primary)' }}
                      checked={form.members.includes(p.route)}
                      onChange={() => toggleMember(p.route)}
                    />
                    {p.displayName || p.route}
                  </label>
                ))}
              </div>
            </div>
            <div className="mpro-grid2">
              <div className="mpro-field">
                <span className="mpro-fieldLabel">{t('compositeMode')}</span>
                <select
                  className="mpro-input mpro-select"
                  value={form.mode}
                  onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as 'union' | 'intersection' }))}
                >
                  <option value="union">{t('compositeModeUnion')}</option>
                  <option value="intersection">{t('compositeModeIntersection')}</option>
                </select>
              </div>
              <div className="mpro-field">
                <span className="mpro-fieldLabel">{t('compositeStrategy')}</span>
                <select
                  className="mpro-input mpro-select"
                  value={form.strategy}
                  onChange={(e) => setForm((f) => ({ ...f, strategy: e.target.value }))}
                >
                  {STRATEGIES.map((s) => <option key={s} value={s}>{strategyLabel(t, s)}</option>)}
                </select>
              </div>
            </div>
            <div className="mpro-hdrAdd">
              <button
                className="mpro-btn mpro-btnPrimary"
                disabled={busy || !form.name.trim() || form.members.length < 2}
                onClick={() => void submit()}
              >
                {editing === '' ? t('compositeAdd') : t('compositeUpdate')}
              </button>
              <button
                className="mpro-btn"
                disabled={!form.name.trim()}
                onClick={() => void runPreview(form.name.trim(), form.mode)}
              >
                {t('compositePreview')}
              </button>
              <button className="mpro-btn mpro-btnGhost" onClick={resetForm}>{t('cancel')}</button>
            </div>
            {preview.ran && !preview.loading && preview.ids.length ? (
              <div className="mpro-previewBox">
                <span className="mpro-previewCount">{t('compositePreviewCount').replace('{n}', String(preview.ids.length))}</span>
                <div className="mpro-previewChips">
                  {preview.ids.map((id) => (
                    <span key={id} className="mpro-chip mpro-chipMono">{id}</span>
                  ))}
                </div>
              </div>
            ) : preview.ran && !preview.loading ? (
              <div className="mpro-hint">{t('compositePreviewEmpty')}</div>
            ) : null}
          </div>
        )}

        {msg ? <span className="mpro-inlineStatus" style={{ marginTop: 6, display: 'inline-block' }}>{msg}</span> : null}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * ③ Observability — stats + request log
 * ------------------------------------------------------------------------ */

interface StatsShape {
  calls?: number
  errors?: number
  latencySum?: number
  latencyN?: number
  tokensIn?: number
  tokensOut?: number
}

function statsRow(s: StatsShape): { calls: number; successRate: number; avg: number; tokensIn: number; tokensOut: number } {
  const calls = s.calls || 0
  const errors = s.errors || 0
  const n = s.latencyN || 0
  return {
    calls,
    successRate: calls ? Math.round(((calls - errors) / calls) * 100) : 100,
    avg: n ? Math.round((s.latencySum || 0) / n) : 0,
    tokensIn: s.tokensIn || 0,
    tokensOut: s.tokensOut || 0,
  }
}

const LOG_PAGE_SIZES = [20, 50, 100]

export function ObservabilityPanel({ t, call }: { t: TFunc; call: CallFn }) {
  const [stats, setStats] = React.useState<{ byRoute: Record<string, StatsShape>; byTarget: Record<string, StatsShape> }>({ byRoute: {}, byTarget: {} })
  const [logs, setLogs] = React.useState<any[]>([])
  const [msg, setMsg] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'ok' | 'error'>('all')
  const [pageSize, setPageSize] = React.useState(20)
  const [page, setPage] = React.useState(0)
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())
  // Conversation badge preference (persisted host-side under llm-pi-ai[uiPrefs]).
  const [showBadge, setShowBadge] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await call('get-ui-prefs')
        setShowBadge(r?.prefs?.showRouteBadge !== false)
      } catch { /* default stays on */ }
    })()
  }, [call])

  const toggleBadge = async () => {
    const next = !(showBadge !== false)
    setShowBadge(next)
    try {
      await call('set-ui-prefs', { prefs: { showRouteBadge: next } })
      setMsg(t('uiPrefsSaved'))
    } catch (e) {
      setMsg(t('uiPrefsErr') + String((e as Error)?.message || e))
    }
  }

  const refresh = React.useCallback(async () => {
    try {
      const [s, l] = await Promise.all([call('get-route-stats'), call('list-request-logs')])
      setStats({ byRoute: s.byRoute || {}, byTarget: s.byTarget || {} })
      setLogs(l.entries || [])
    } catch (e) {
      setMsg(t('obsLoadErr') + String((e as Error)?.message || e))
    }
  }, [call, t])

  React.useEffect(() => { void refresh() }, [refresh])

  const clear = async () => {
    try {
      await call('clear-request-logs')
      await refresh()
    } catch (e) {
      setMsg(String((e as Error)?.message || e))
    }
  }

  const all: StatsShape = {}
  for (const s of Object.values(stats.byRoute)) {
    all.calls = (all.calls || 0) + (s.calls || 0)
    all.errors = (all.errors || 0) + (s.errors || 0)
    all.latencySum = (all.latencySum || 0) + (s.latencySum || 0)
    all.latencyN = (all.latencyN || 0) + (s.latencyN || 0)
    all.tokensIn = (all.tokensIn || 0) + (s.tokensIn || 0)
    all.tokensOut = (all.tokensOut || 0) + (s.tokensOut || 0)
  }
  const sum = statsRow(all)

  const ts = (v: number) => {
    const d = new Date(v)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  // ---- request-log filtering + pagination (newest first) ----
  const ordered = React.useMemo(() => logs.slice().reverse(), [logs])
  const filtered = React.useMemo(
    () => (statusFilter === 'all' ? ordered : ordered.filter((e) => (statusFilter === 'error' ? e.status !== 'ok' : e.status === 'ok'))),
    [ordered, statusFilter],
  )
  const errorCount = React.useMemo(() => ordered.filter((e) => e.status !== 'ok').length, [ordered])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageStart = safePage * pageSize
  const pageRows = filtered.slice(pageStart, pageStart + pageSize)

  React.useEffect(() => { setPage(0); setExpanded(new Set()) }, [statusFilter, pageSize])

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <div className="mpro-card">
      <div className="mpro-cardHead">
        <div>
          <h3 className="mpro-cardTitle">{t('obsTitle')}</h3>
          <p className="mpro-hint" style={{ marginTop: 2 }}>{t('obsHint')}</p>
        </div>
        <div className="mpro-routeActions">
          <label className="mpro-toggleCk" title={t('uiShowBadgeHint')} style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showBadge !== false}
              onChange={() => void toggleBadge()}
            />
            {t('uiShowBadge')}
          </label>
          <button className="mpro-btn mpro-btnSm" onClick={() => void refresh()}>{t('obsReload')}</button>
          <button className="mpro-btn mpro-btnSm mpro-btnDanger" onClick={() => void clear()}>{t('obsClearLogs')}</button>
        </div>
      </div>
      <div className="mpro-cardBody">
        <div className="mpro-statGrid">
          <div className="mpro-statCard">
            <span className="mpro-statLabel">{t('obsCalls')}</span>
            <span className="mpro-statValue">{sum.calls}{t('statCalls')}</span>
          </div>
          <div className="mpro-statCard">
            <span className="mpro-statLabel">{t('obsSuccessRate')}</span>
            <span className={sum.successRate >= 90 ? 'mpro-statValue mpro-statValueGood' : 'mpro-statValue mpro-statValueBad'}>{sum.successRate}%</span>
          </div>
          <div className="mpro-statCard">
            <span className="mpro-statLabel">{t('obsAvgLatency')}</span>
            <span className="mpro-statValue">{sum.avg}{t('statMs')}</span>
          </div>
          <div className="mpro-statCard">
            <span className="mpro-statLabel">{t('obsTokens')}</span>
            <span className="mpro-statValue">{sum.tokensIn + sum.tokensOut}</span>
            <span className="mpro-statSub">↑{sum.tokensIn} ↓{sum.tokensOut}</span>
          </div>
        </div>

        <div className="mpro-obsGrid">
          <div>
            <p className="mpro-sectionTitle">{t('obsByRoute')}</p>
            {Object.keys(stats.byRoute).length ? (
              <div className="mpro-tblWrap">
                <table className="mpro-tbl">
                  <thead>
                    <tr>
                      <th>{t('obsRoute')}</th>
                      <th>{t('obsCalls')}</th>
                      <th>%</th>
                      <th>{t('obsLatency')}</th>
                      <th>{t('obsOut')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.byRoute).map(([k, s]) => {
                      const row = statsRow(s)
                      return (
                        <tr key={k}>
                          <td className="mpro-id">{k}</td>
                          <td>{row.calls}</td>
                          <td className="mpro-pctCell">{row.successRate}%</td>
                          <td>{row.avg}ms</td>
                          <td className="mpro-dim">{row.tokensOut}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mpro-hint">{t('obsLogEmpty')}</div>
            )}
          </div>
          <div>
            <p className="mpro-sectionTitle">{t('obsByTarget')}</p>
            {Object.keys(stats.byTarget).length ? (
              <div className="mpro-tblWrap">
                <table className="mpro-tbl">
                  <thead>
                    <tr>
                      <th>{t('obsTarget')}</th>
                      <th>{t('obsCalls')}</th>
                      <th>%</th>
                      <th>{t('obsLatency')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.byTarget).map(([k, s]) => {
                      const row = statsRow(s)
                      return (
                        <tr key={k}>
                          <td className="mpro-id">{k.replace('\u0000', ' / ')}</td>
                          <td>{row.calls}</td>
                          <td className="mpro-pctCell">{row.successRate}%</td>
                          <td>{row.avg}ms</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mpro-hint">{t('obsLogEmpty')}</div>
            )}
          </div>
        </div>

        <div>
          <div className="mpro-logHead">
            <p className="mpro-sectionTitle" style={{ margin: 0 }}>{t('obsLogTitle')}</p>
            <div className="mpro-logFilters">
              <div className="mpro-segGroup">
                <button
                  className={statusFilter === 'all' ? 'mpro-seg mpro-segOn' : 'mpro-seg'}
                  onClick={() => setStatusFilter('all')}
                >{t('logAll')} <span className="mpro-segNum">{ordered.length}</span></button>
                <button
                  className={statusFilter === 'error' ? 'mpro-seg mpro-segOn mpro-segErr' : 'mpro-seg'}
                  onClick={() => setStatusFilter('error')}
                >{t('logErrorsOnly')} <span className="mpro-segNum">{errorCount}</span></button>
                <button
                  className={statusFilter === 'ok' ? 'mpro-seg mpro-segOn' : 'mpro-seg'}
                  onClick={() => setStatusFilter('ok')}
                >{t('logOkOnly')} <span className="mpro-segNum">{ordered.length - errorCount}</span></button>
              </div>
              <select
                className="mpro-input mpro-select mpro-pageSizeSel"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value) || 20)}
                title={t('logPageSize')}
              >
                {LOG_PAGE_SIZES.map((n) => <option key={n} value={n}>{t('logPerPage').replace('{n}', String(n))}</option>)}
              </select>
            </div>
          </div>
          {filtered.length ? (
            <>
              <div className="mpro-tblWrap">
                <table className="mpro-tbl mpro-logTbl">
                  <thead>
                    <tr>
                      <th style={{ width: 26 }}></th>
                      <th>{t('obsTime')}</th>
                      <th>{t('obsRoute')}</th>
                      <th>{t('obsTarget')}</th>
                      <th>{t('obsStatus')}</th>
                      <th>{t('obsLatency')}</th>
                      <th>{t('obsIn')}</th>
                      <th>{t('obsOut')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((e, i) => {
                      const idx = pageStart + i
                      const isErr = e.status !== 'ok'
                      const hasDetail = !!e.error
                      const open = expanded.has(idx)
                      return (
                        <React.Fragment key={idx}>
                          <tr
                            className={(isErr ? 'mpro-logRowErr' : '') + (hasDetail ? ' mpro-logRowClickable' : '')}
                            onClick={hasDetail ? () => toggleExpand(idx) : undefined}
                          >
                            <td className="mpro-logCaret">{hasDetail ? (open ? '▾' : '▸') : ''}</td>
                            <td className="mpro-dim">{ts(e.ts)}</td>
                            <td className="mpro-id">{e.route}</td>
                            <td className="mpro-id">{e.target.provider}/{e.target.model}</td>
                            <td className={e.status === 'ok' ? 'mpro-logStatus mpro-logOk' : 'mpro-logStatus mpro-logErr'}>
                              {e.status === 'ok' ? t('obsStateOk') : e.status === 'fallback' ? t('obsStateFallback') : t('obsStateError')}
                            </td>
                            <td>{e.latencyMs}ms</td>
                            <td className="mpro-dim">{e.tokens && e.tokens.in != null ? e.tokens.in : '—'}</td>
                            <td className="mpro-dim">{e.tokens && e.tokens.out != null ? e.tokens.out : '—'}</td>
                          </tr>
                          {open && hasDetail ? (
                            <tr className="mpro-logDetailRow">
                              <td colSpan={8}>
                                <div className="mpro-logDetail">
                                  <div className="mpro-logDetailLabel">{t('logErrorDetail')}</div>
                                  <div className="mpro-errorBlock">{e.error}</div>
                                  {typeof e.tryIndex === 'number' ? (
                                    <div className="mpro-logDetailMeta">{t('logTryIndex')}: <b>#{e.tryIndex + 1}</b>{e.sessionId ? <> · session <b>{String(e.sessionId).slice(0, 12)}</b></> : null}</div>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mpro-pager">
                <span className="mpro-pagerInfo">
                  {t('logRange')
                    .replace('{from}', String(filtered.length ? pageStart + 1 : 0))
                    .replace('{to}', String(Math.min(pageStart + pageSize, filtered.length)))
                    .replace('{total}', String(filtered.length))}
                </span>
                <div className="mpro-pagerBtns">
                  <button className="mpro-btn mpro-btnSm" disabled={safePage <= 0} onClick={() => setPage(0)}>«</button>
                  <button className="mpro-btn mpro-btnSm" disabled={safePage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ {t('logPrev')}</button>
                  <span className="mpro-pagerPos">{safePage + 1} / {pageCount}</span>
                  <button className="mpro-btn mpro-btnSm" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>{t('logNext')} ›</button>
                  <button className="mpro-btn mpro-btnSm" disabled={safePage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>»</button>
                </div>
              </div>
            </>
          ) : (
            <div className="mpro-hint">{statusFilter === 'all' ? t('obsLogEmpty') : t('logNoneMatch')}</div>
          )}
        </div>

        {msg ? <span className="mpro-inlineStatus mpro-inlineStatusErr">{msg}</span> : null}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * ④ Probe — target health + batch probe
 * ------------------------------------------------------------------------ */

interface HealthEntry {
  provider: string
  model: string
  status: string
  lastProbeAt?: number
  latencyMs?: number
  consecutiveFails?: number
  lastError?: string
}

export function ProbePanel({ t, call }: { t: TFunc; call: CallFn }) {
  const [health, setHealth] = React.useState<Record<string, HealthEntry>>({})
  const [probingAll, setProbingAll] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [probeBusy, setProbeBusy] = React.useState<Record<string, boolean>>({})
  const [openErr, setOpenErr] = React.useState<Set<string>>(new Set())

  const refresh = React.useCallback(async () => {
    try {
      const r = await call('get-route-stats')
      setHealth(r.health || {})
    } catch (e) {
      setMsg(t('probeLoadErr') + String((e as Error)?.message || e))
    }
  }, [call, t])

  React.useEffect(() => { void refresh() }, [refresh])

  const probe = async (provider: string, model: string) => {
    const k = `${provider}\u0000${model}`
    setProbeBusy((m) => ({ ...m, [k]: true }))
    setMsg('')
    try {
      const r = await call('probe-target', { provider, model })
      if (!r.ok) setMsg(t('probeExecErr') + (r.error || '') )
    } catch (e) {
      setMsg(t('probeExecErr') + String((e as Error)?.message || e))
    } finally {
      setProbeBusy((m) => ({ ...m, [k]: false }))
      await refresh()
    }
  }

  const probeAll = async () => {
    setProbingAll(true)
    setMsg('')
    try {
      // Host awaits the full sweep before resolving, so refresh right after.
      await call('probe-all')
      await refresh()
    } catch (e) {
      setMsg(t('probeExecErr') + String((e as Error)?.message || e))
    } finally {
      setProbingAll(false)
    }
  }

  const entries = Object.values(health)
  const statusLabel = (s: string) =>
    s === 'up' ? t('probeUp') : s === 'down' ? t('probeDown') : s === 'probing' ? t('probeProbing') : t('probeUnknown')

  return (
    <div className="mpro-card">
      <div className="mpro-cardHead">
        <div>
          <h3 className="mpro-cardTitle">{t('probeTitle')}</h3>
          <p className="mpro-hint" style={{ marginTop: 2 }}>{t('probeHint')}</p>
        </div>
        <div className="mpro-routeActions">
          <button className="mpro-btn mpro-btnPrimary mpro-btnSm" disabled={probingAll} onClick={() => void probeAll()}>
            {probingAll ? t('probeProbingAll') : t('probeAll')}
          </button>
        </div>
      </div>
      <div className="mpro-cardBody">
        {entries.length ? (
          <div className="mpro-tblWrap">
            <table className="mpro-tbl">
              <thead>
                <tr>
                  <th>{t('obsTarget')}</th>
                  <th>{t('probeStatus')}</th>
                  <th>{t('probeLatency')}</th>
                  <th>{t('probeFails')}</th>
                  <th>{t('probeLastAt')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((h) => {
                  const k = `${h.provider}\u0000${h.model}`
                  const open = openErr.has(k)
                  return (
                    <React.Fragment key={k}>
                      <tr className={h.status === 'down' ? 'mpro-logRowErr' : ''}>
                        <td className="mpro-id">{h.provider}/{h.model}</td>
                        <td>
                          <span className="mpro-hdotRow">
                            <span className={'mpro-hdot ' + (HEALTH_DOT[h.status as TargetHealth['status']] || 'mpro-hdotUnknown')} />
                            <span className="mpro-healthText">{statusLabel(h.status)}</span>
                            {h.lastError ? (
                              <button
                                className="mpro-errToggle"
                                title={t('probeErrDetail')}
                                onClick={() => setOpenErr((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })}
                              >⚠ {open ? '▾' : '▸'}</button>
                            ) : null}
                          </span>
                        </td>
                        <td>{typeof h.latencyMs === 'number' ? `${h.latencyMs}ms` : '—'}</td>
                        <td>{h.consecutiveFails || 0}</td>
                        <td className="mpro-dim">{h.lastProbeAt ? new Date(h.lastProbeAt).toLocaleTimeString() : '—'}</td>
                        <td>
                          <button
                            className="mpro-btn mpro-btnSm"
                            disabled={probeBusy[k]}
                            onClick={() => void probe(h.provider, h.model)}
                          >
                            {probeBusy[k] ? '…' : t('probeProbe')}
                          </button>
                        </td>
                      </tr>
                      {open && h.lastError ? (
                        <tr className="mpro-logDetailRow">
                          <td colSpan={6}>
                            <div className="mpro-logDetail">
                              <div className="mpro-logDetailLabel">{t('probeErrDetail')}</div>
                              <div className="mpro-errorBlock">{h.lastError}</div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mpro-emptyState" style={{ padding: '16px 12px' }}>{t('probeNoTargets')}</div>
        )}
        {msg ? <span className="mpro-inlineStatus mpro-inlineStatusErr">{msg}</span> : null}
      </div>
    </div>
  )
}