/** ProviderEditor — the tabbed editor for one provider: Overview / Headers /
 * Models / Test. Header carries lifecycle actions (enable/disable/delete). */

import React from '../react'
import type { ProviderData, InfoState, HeaderPair, ModelEntry, DiscoveredModel, StatusMsg, TFunc, CallFn } from '../../shared/types'
import { fmt } from '../labels'
import { OverviewPanel } from './OverviewPanel'
import { HeadersPanel } from './HeadersPanel'
import { ModelsPanel } from './ModelsPanel'
import { TestPanel } from './TestPanel'

export type EditorTab = 'overview' | 'headers' | 'models' | 'test'

interface Props {
  t: TFunc
  call: CallFn
  data: ProviderData
  initialTab?: EditorTab
  onBack: () => void
}

export function ProviderEditor({ t, call, data, initialTab, onBack }: Props) {
  const [tab, setTab] = React.useState<EditorTab>(initialTab || 'overview')
  const [disabled, setDisabled] = React.useState(!!data.disabled)
  const [info, setInfo] = React.useState<InfoState>({
    displayName: data.displayName,
    api: data.api || 'openai-completions',
    baseURL: data.baseURL,
    apiKeyEnv: data.apiKeyEnv,
  })
  const [protocols, setProtocols] = React.useState(['openai-completions', 'openai-responses', 'anthropic-messages'])
  const [headers, setHeaders] = React.useState<HeaderPair[]>(data.headers?.length ? data.headers : [])
  const [models, setModels] = React.useState<ModelEntry[]>(data.models || [])
  const [availableModels, setAvailableModels] = React.useState<string[]>(data.availableModels || [])
  const [discovered, setDiscovered] = React.useState<DiscoveredModel[] | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<Record<string, boolean>>({})
  const [apiKeyProbe, setApiKeyProbe] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState<StatusMsg | null>(null)

  const set = (p: Partial<InfoState>) => setInfo((f) => ({ ...f, ...p }))
  // 编辑页替代父级仪表盘，错误必须写入当前可见页的状态。
  const fail = (e: unknown) => setStatus({ kind: 'err', text: (e as Error)?.message || String(e) })

  React.useEffect(() => {
    call('list-providers').then((r: any) => { if (r.protocols) setProtocols(r.protocols) }).catch(() => {})
  }, [])

  const saveField = async (field: string, value: string) => {
    setBusy(true); setStatus(null)
    try {
      await call('update-field', { route: data.route, field, value })
      setStatus({ kind: 'ok', text: t('statusSaved') })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const saveHeaders = async () => {
    setBusy(true); setStatus(null)
    try {
      await call('update-headers', { route: data.route, headers })
      setStatus({ kind: 'ok', text: t('statusSaved') })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const toggle = async (enable: boolean) => {
    setBusy(true); setStatus(null)
    try {
      const r = await call('toggle-provider', { route: data.route, enabled: enable })
      setDisabled(!enable)
      setStatus({ kind: 'ok', text: fmt(t('statusToggled'), { route: r.route, action: enable ? t('enable') : t('disable') }) })
      // Refresh the advertised model list now that the provider may be registered.
      const fresh = await call('get-provider', { route: data.route }).catch(() => null)
      if (fresh && Array.isArray(fresh.availableModels)) setAvailableModels(fresh.availableModels)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!confirm(fmt(t('deleteConfirm'), { route: data.route }))) return
    setBusy(true); setStatus(null)
    try {
      await call('delete-provider', { route: data.route })
      onBack()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const inlineStatus = status
    ? <div className={status.kind === 'ok' ? 'mpro-inlineStatus mpro-inlineStatusOk' : 'mpro-inlineStatus mpro-inlineStatusErr'}>{status.text}</div>
    : null

  const tabBtn = (id: EditorTab, label: string, count?: number) => (
    <button className={tab === id ? 'mpro-tab mpro-tabActive' : 'mpro-tab'} onClick={() => setTab(id)}>
      {label}
      {count != null && count > 0 ? <span className="mpro-tabCount">({count})</span> : null}
    </button>
  )

  const activePanel =
    tab === 'overview' ? (
      <OverviewPanel
        t={t}
        info={info}
        set={set}
        protocols={protocols}
        route={data.route}
        call={call}
        hasSecret={!!data.hasSecret}
        saveField={saveField}
        modelCount={(models || []).length}
        headerCount={(headers || []).length}
        onGoTest={() => setTab('test')}
        inlineStatus={inlineStatus}
      />
    ) : tab === 'headers' ? (
      <HeadersPanel t={t} headers={headers} setHeaders={setHeaders} busy={busy} saveHeaders={saveHeaders} inlineStatus={inlineStatus} />
    ) : tab === 'models' ? (
      <ModelsPanel
        t={t}
        call={call}
        route={data.route}
        info={info}
        set={set}
        protocols={protocols}
        models={models}
        setModels={setModels}
        discovered={discovered}
        setDiscovered={setDiscovered}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        apiKeyProbe={apiKeyProbe}
        setApiKeyProbe={setApiKeyProbe}
        busy={busy}
        setBusy={setBusy}
        setStatus={setStatus}
        fail={fail}
        inlineStatus={inlineStatus}
      />
    ) : (
      <TestPanel
        t={t}
        call={call}
        route={data.route}
        disabled={disabled}
        modelOptions={availableModels}
        explicitModels={models || []}
        key={data.route}
      />
    )

  return (
    <div className="mpro-root">
      <div className="mpro-card">
        <div className="mpro-editorHead">
          <button className="mpro-btn mpro-btnSm" onClick={onBack}>← {t('back')}</button>
          <h2 className="mpro-editorTitle">{data.displayName || data.route}</h2>
          <span className="mpro-editorRoute">{data.route}</span>
          {disabled ? (
            <span className="mpro-pill mpro-pillOff">{t('stateDisabled')}</span>
          ) : (
            <span className="mpro-pill mpro-pillActive">{t('stateActive')}</span>
          )}
          <div className="mpro-editorActions">
            {!disabled && (
              <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => void toggle(false)}>
                {t('disable')}
              </button>
            )}
            {disabled && (
              <button className="mpro-btn mpro-btnSm" disabled={busy} onClick={() => void toggle(true)}>
                {t('enable')}
              </button>
            )}
            <button className="mpro-btn mpro-btnSm mpro-btnDanger" disabled={busy} onClick={() => void remove()}>
              {t('delete')}
            </button>
          </div>
        </div>
        <div className="mpro-tabs">
          {tabBtn('overview', t('tabOverview'))}
          {tabBtn('headers', t('tabHeaders'), (headers || []).length)}
          {tabBtn('models', t('tabModels'), (models || []).length)}
          {tabBtn('test', t('tabTest'))}
        </div>
        {activePanel}
        {tab === 'test' && inlineStatus}
      </div>
    </div>
  )
}
