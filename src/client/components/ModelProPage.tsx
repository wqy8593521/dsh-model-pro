/** ModelProPage — the dashboard. Segments (all/enabled/disabled), a guided
 * create flow (with "create & test"), and state-rail provider cards. */

import React from '../react'
import type { BootState, CreateFormState, StatusMsg, TFunc, CallFn, ProviderData } from '../../shared/types'
import { fmt } from '../labels'
import { CreateForm } from './CreateForm'
import { ProviderCard } from './ProviderCard'
import { ProviderEditor, type EditorTab } from './ProviderEditor'
import { RoutesPanel } from './RoutesPanel'

interface Props {
  t: TFunc
  call: CallFn
}

type Segment = 'all' | 'active' | 'disabled'

const EMPTY_FORM = (): CreateFormState => ({
  route: '', displayName: '', api: 'openai-completions', baseURL: '', apiKeyEnv: '', apiKey: '',
})

const validRoute = (r: string) => /^[A-Za-z0-9_.-]+$/.test(r)
const validBaseURL = (u: string) => /^https?:\/\/.+/i.test(u)

export function ModelProPage({ t, call }: Props) {
  const [boot, setBoot] = React.useState<BootState>({ providers: [], protocols: [], writable: true, error: '' })
  const [selected, setSelected] = React.useState<ProviderData | null>(null)
  const [view, setView] = React.useState<'providers' | 'routes'>('providers')
  const [initTab, setInitTab] = React.useState<EditorTab>('overview')
  const [creating, setCreating] = React.useState(false)
  const [form, setForm] = React.useState<CreateFormState>(EMPTY_FORM())
  const [errors, setErrors] = React.useState<{ route?: string; baseURL?: string }>({})
  const [segment, setSegment] = React.useState<Segment>('all')
  const [status, setStatus] = React.useState<StatusMsg | null>(null)
  const [busy, setBusy] = React.useState(false)

  const set = (p: Partial<CreateFormState>) => setForm((f) => ({ ...f, ...p }))
  const fail = (e: unknown) => setStatus({ kind: 'err', text: (e as Error)?.message || String(e) })

  const refresh = async () => {
    try {
      const r = await call('list-providers')
      setBoot((b) => ({ ...b, providers: r.providers || [], protocols: r.protocols || [], writable: r.writable !== false, error: '' }))
    } catch (e) { fail(e) }
  }

  React.useEffect(() => { void refresh() }, [])

  const validate = (): boolean => {
    const e: { route?: string; baseURL?: string } = {}
    if (!form.route.trim()) e.route = t('needRoute')
    else if (!validRoute(form.route.trim())) e.route = t('routeInvalid')
    if (!form.baseURL.trim()) e.baseURL = t('needBaseURL')
    else if (!validBaseURL(form.baseURL.trim())) e.baseURL = t('needBaseURLValid')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const openEdit = async (route: string, tab?: EditorTab) => {
    setBusy(true); setStatus(null)
    try {
      const r = await call('get-provider', { route })
      setInitTab(tab || 'overview')
      setSelected(r)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const onCreate = async (mode: 'config' | 'test') => {
    if (!validate()) return
    setBusy(true); setStatus(null)
    try {
      const r = await call('create-provider', form as unknown as Record<string, unknown>)
      setStatus({ kind: 'ok', text: fmt(t('statusCreated'), { route: r.route }) })
      setForm(EMPTY_FORM()); setErrors({}); setCreating(false)
      await refresh()
      const got = await call('get-provider', { route: r.route })
      const hasTestableModel = (Array.isArray(got.models) && got.models.length > 0)
        || (Array.isArray(got.availableModels) && got.availableModels.length > 0)
      // A new custom provider initially has only an internal schema sentinel.
      // If no real model was discovered/configured, "create & test" must lead
      // to model setup instead of opening an unusable test page.
      setInitTab(mode === 'test' && hasTestableModel ? 'test' : 'models')
      setSelected(got)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const onDelete = async (route: string) => {
    if (!confirm(fmt(t('deleteConfirm'), { route }))) return
    setBusy(true); setStatus(null)
    try {
      await call('delete-provider', { route })
      setStatus({ kind: 'ok', text: fmt(t('statusDeleted'), { route }) })
      await refresh()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const onToggle = async (route: string, enable: boolean) => {
    setBusy(true); setStatus(null)
    try {
      const r = await call('toggle-provider', { route, enabled: enable })
      setStatus({ kind: 'ok', text: fmt(t('statusToggled'), { route: r.route, action: enable ? t('enable') : t('disable') }) })
      await refresh()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  if (selected) {
    return (
      <ProviderEditor
        t={t}
        call={call}
        data={selected}
        initialTab={initTab}
        onBack={() => { setSelected(null); void refresh() }}
        fail={fail}
      />
    )
  }

  const { providers, protocols, writable } = boot
  const counts = {
    all: providers.length,
    active: providers.filter((p) => !p.disabled).length,
    disabled: providers.filter((p) => p.disabled).length,
  }
  const visible = providers.filter((p) =>
    segment === 'all' ? true : segment === 'active' ? !p.disabled : p.disabled,
  )

  let banner: React.ReactElement | null = null
  if (writable === false) {
    banner = <div className="mpro-banner mpro-bannerWarn">{t('readOnly')}</div>
  } else if (status) {
    banner = <div className={status.kind === 'ok' ? 'mpro-banner mpro-bannerOk' : 'mpro-banner mpro-bannerErr'}>{status.text}</div>
  }

  const segBtn = (id: Segment, label: string) => (
    <button className={segment === id ? 'mpro-seg mpro-segActive' : 'mpro-seg'} onClick={() => setSegment(id)}>
      {label}
      <span className="mpro-segCount">{counts[id]}</span>
    </button>
  )

  return (
    <div className="mpro-root">
      <div className="mpro-head">
        <div className="mpro-headLeft">
          <h2 className="mpro-title">{t('title')}</h2>
          {writable === false ? <p className="mpro-titleNote">{t('readOnly')}</p> : null}
        </div>
        <div className="mpro-headActions">
          <button className="mpro-btn" onClick={() => void refresh()}>{t('refresh')}</button>
          {writable !== false && (
            <button className="mpro-btn mpro-btnPrimary" onClick={() => { setCreating((c) => !c); setErrors({}) }}>
              {creating ? t('cancel') : t('newProvider')}
            </button>
          )}
        </div>
      </div>
      <p className="mpro-intro">{t('intro')}</p>
      {banner}
      <div className="mpro-tabs" style={{ marginBottom: 14 }}>
        <button className={view === 'providers' ? 'mpro-tab mpro-tabActive' : 'mpro-tab'} onClick={() => setView('providers')}>
          {t('tabProviders')}
        </button>
        <button className={view === 'routes' ? 'mpro-tab mpro-tabActive' : 'mpro-tab'} onClick={() => setView('routes')}>
          {t('tabRoutes')}
        </button>
      </div>
      {view === 'routes' ? (
        <RoutesPanel t={t} call={call} providers={providers} />
      ) : (
        <>
          <div className="mpro-segs">
            {segBtn('all', t('segAll'))}
            {segBtn('active', t('segActive'))}
            {segBtn('disabled', t('segDisabled'))}
          </div>
          {creating && (
            <div style={{ marginBottom: 16 }}>
              <CreateForm
                t={t}
                form={form}
                set={set}
                protocols={protocols}
                busy={busy}
                errors={errors}
                onCreate={onCreate}
                onCancel={() => { setCreating(false); setForm(EMPTY_FORM()); setErrors({}) }}
              />
            </div>
          )}
          {visible.length === 0 ? (
            <div className="mpro-emptyState">
              {providers.length === 0 ? t('empty') : segment === 'active' ? t('emptyActive') : t('emptyDisabled')}
            </div>
          ) : (
            <div className="mpro-pcList">
              {visible.map((p) => (
                <ProviderCard
                  key={p.route}
                  p={p}
                  t={t}
                  busy={busy}
                  writable={writable !== false}
                  onEdit={(route) => void openEdit(route)}
                  onTest={(route) => void openEdit(route, 'test')}
                  onToggle={onToggle}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
