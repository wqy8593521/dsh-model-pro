/** LocalFillPanel — bulk-fill `reasoningEfforts` from the installed pi-ai catalog.
 *
 * This is the one-click half of the missing-thinking-levels fix. The per-model
 * editor can already borrow a declaration, but the situation that actually bites
 * is a ROUTE whose every target is a gateway: llm-pi-ai looks its catalog up by
 * PROVIDER ROUTE NAME, so no gateway model inherits anything, all of them resolve
 * to `reasoning: false`, and the route's union of levels comes out empty — which
 * is what made `router/free` reject `max` outright. Repairing that by hand means
 * opening one editor per model per provider.
 *
 * Hence two scopes. `provider` fills one provider's model list (the 模型 tab);
 * `route` fills every target of a route, across providers, which is the shape the
 * failure actually has.
 *
 * It previews before it writes, and that is not politeness — the catalog
 * describes each model as its FIRST-PARTY provider serves it. A gateway may
 * expose fewer levels, or want a different spelling, and a wrong value fails
 * llm-pi-ai's config schema for the WHOLE provider section. So: the proposal is
 * shown per model with the evidence behind it, models that already declare
 * something are left unchecked, and an id with several conflicting declarations
 * gets a switcher instead of a silent winner.
 *
 * Writes are grouped into ONE `apply-models` merge per provider, because that
 * handler validates all of a provider's entries before touching settings. A
 * per-model loop could fail halfway and leave a provider section in exactly the
 * broken state described above.
 */

import React from '../react'
import { THINKING_LEVELS } from '../../shared/constants'
import type { ThinkingLevel } from '../../shared/constants'
import type { ReasoningEfforts, TFunc, CallFn } from '../../shared/types'
import { fmt } from '../labels'

interface Candidate {
  levels: ThinkingLevel[]
  efforts: ReasoningEfforts
  sources: string[]
  samePro: boolean
}

/** One row as the host reports it. */
interface Row {
  provider: string
  id: string
  api: string
  current: null | false | ReasoningEfforts
  candidates: Candidate[]
}

/** What to fill: one provider's models, or one route's targets. */
export type FillScope =
  | { kind: 'provider'; route: string }
  | { kind: 'route'; name: string; targets: Array<{ provider: string; model: string }> }

interface Props {
  t: TFunc
  call: CallFn
  scope: FillScope
  /** Re-read whatever the caller shows after a successful write. */
  onDone: () => Promise<void>
  onClose: () => void
  busy: boolean
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  fail: (e: unknown) => void
  setStatus: (s: { kind: 'ok' | 'err'; text: string }) => void
}

/** What a model currently declares, as a short label. */
function currentLabel(current: Row['current'], t: TFunc): string {
  if (current === false) return t('reasonNone')
  if (current && typeof current === 'object') {
    const levels = THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(current, l))
    return levels.length ? levels.join(' · ') : t('reasonInherit')
  }
  return t('reasonInherit')
}

/** True when the model has no opinion yet — the safe case to fill by default. */
const inherits = (row: Row): boolean => row.current === null

/** Stable row key: a route scope can hold the same model id on two providers. */
const keyOf = (row: { provider: string; id: string }): string => `${row.provider}\u0000${row.id}`

export function LocalFillPanel({
  t, call, scope, onDone, onClose, busy, setBusy, fail, setStatus,
}: Props) {
  const [rows, setRows] = React.useState<Row[] | null>(null)
  const [dir, setDir] = React.useState('')
  const [err, setErr] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  /** key -> checked. */
  const [picked, setPicked] = React.useState<Record<string, boolean>>({})
  /** key -> which candidate index is chosen. */
  const [choice, setChoice] = React.useState<Record<string, number>>({})

  // The request payload is derived from the scope, and is also what the effect
  // keys on: re-running on unrelated re-renders would reset a review in progress.
  const payload = React.useMemo(
    () => (scope.kind === 'provider'
      ? { route: scope.route }
      : { targets: scope.targets.map((x) => ({ provider: x.provider, model: x.model })) }),
    [scope.kind, scope.kind === 'provider' ? scope.route : JSON.stringify(scope.targets)],
  )

  React.useEffect(() => {
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const r = await call('suggest-reasoning', payload)
        const list: Row[] = Array.isArray(r?.rows) ? r.rows : []
        setRows(list)
        setDir(typeof r?.dir === 'string' ? r.dir : '')
        // Default: fill exactly the models that have no declaration yet and do
        // have a candidate. Anything already declared stays untouched unless the
        // user opts in — overwriting a hand-tuned value silently would be worse
        // than doing nothing.
        const pick: Record<string, boolean> = {}
        const pickIdx: Record<string, number> = {}
        for (const row of list) {
          pickIdx[keyOf(row)] = 0
          if (row.candidates.length && inherits(row)) pick[keyOf(row)] = true
        }
        setPicked(pick)
        setChoice(pickIdx)
      } catch (e) {
        setErr(String((e as Error)?.message || e))
      } finally {
        setLoading(false)
      }
    })()
  }, [payload])

  const withCandidates = (rows || []).filter((r) => r.candidates.length > 0)
  const withoutCandidates = (rows || []).filter((r) => r.candidates.length === 0)
  const selectedKeys = Object.keys(picked).filter((k) => picked[k])

  const toggle = (key: string) => setPicked((p) => ({ ...p, [key]: !p[key] }))
  const selectAll = () => {
    const next: Record<string, boolean> = {}
    for (const r of withCandidates) next[keyOf(r)] = true
    setPicked(next)
  }
  const selectNone = () => setPicked({})

  const write = async () => {
    // Group by provider: one validated merge per provider section.
    const byProvider = new Map<string, Array<{ id: string; reasoningEfforts: ReasoningEfforts }>>()
    for (const row of withCandidates) {
      const key = keyOf(row)
      if (!picked[key]) continue
      const cand = row.candidates[choice[key] ?? 0]
      if (!cand) continue
      const list = byProvider.get(row.provider) || []
      list.push({ id: row.id, reasoningEfforts: cand.efforts })
      byProvider.set(row.provider, list)
    }
    if (!byProvider.size) return
    setBusy(true)
    let written = 0
    try {
      for (const [provider, models] of byProvider) {
        await call('apply-models', { route: provider, models, mode: 'merge' })
        written += models.length
      }
      setStatus({ kind: 'ok', text: fmt(t('reasonLocalWrote'), { n: written }) })
      await onDone()
      onClose()
    } catch (e) {
      // A later provider can fail after an earlier one committed. Say so, rather
      // than reporting a clean failure that hides the partial write.
      if (written > 0) setStatus({ kind: 'err', text: fmt(t('reasonLocalPartial'), { n: written }) })
      fail(e)
    } finally { setBusy(false) }
  }

  const multiProvider = new Set((rows || []).map((r) => r.provider)).size > 1

  return (
    <div className="mpro-reasonBox">
      <div className="mpro-reasonHead">
        <strong>
          {scope.kind === 'provider'
            ? t('reasonLocalFillTitle')
            : fmt(t('reasonLocalFillRouteTitle'), { name: scope.name })}
        </strong>
        <span className="mpro-right" />
        <button className="mpro-btn mpro-btnSm" onClick={onClose}>{t('close')}</button>
      </div>

      <p className="mpro-hint">{t('reasonLocalFillHint')}</p>
      {err && <p className="mpro-verdictErr">{fmt(t('reasonLocalFail'), { err })}</p>}
      {loading && <p className="mpro-hint">{t('reasonLooking')}</p>}

      {rows !== null && !loading && !err && (
        <>
          {withCandidates.length === 0 ? (
            <p className="mpro-hint">{t('reasonLocalFillNone')}</p>
          ) : (
            <>
              <div className="mpro-modelBar">
                <span className="mpro-hint">{fmt(t('reasonLocalFillFound'), { n: withCandidates.length })}</span>
                <span className="mpro-right" />
                <button className="mpro-btn mpro-btnSm" onClick={selectAll}>{t('selectAll')}</button>
                <button className="mpro-btn mpro-btnSm" onClick={selectNone}>{t('unselectAll')}</button>
              </div>
              <div className="mpro-tblWrap">
                <table className="mpro-tbl">
                  <thead>
                    <tr>
                      <th className="mpro-tblCk"></th>
                      {multiProvider && <th>{t('providerCol')}</th>}
                      <th>{t('idCol')}</th>
                      <th>{t('reasonCurrentCol')}</th>
                      <th>{t('reasonProposedCol')}</th>
                      <th>{t('reasonSourceCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withCandidates.map((row) => {
                      const key = keyOf(row)
                      const idx = choice[key] ?? 0
                      const cand = row.candidates[idx]
                      const declared = !inherits(row)
                      return (
                        <tr key={key}>
                          <td className="mpro-tblCk">
                            <input type="checkbox" checked={!!picked[key]} onChange={() => toggle(key)} />
                          </td>
                          {multiProvider && <td className="mpro-dim">{row.provider}</td>}
                          <td className="mpro-id">{row.id}</td>
                          <td className={declared ? 'mpro-reasonTag' : 'mpro-dim'}>{currentLabel(row.current, t)}</td>
                          <td>
                            <code className="mpro-reasonLevels">{cand.levels.join(' · ')}</code>
                            {row.candidates.length > 1 && (
                              <span className="mpro-reasonAlt">
                                {row.candidates.map((c, i) => (
                                  <button
                                    key={i}
                                    className={`mpro-pill mpro-pillSm ${i === idx ? 'mpro-pillActive' : ''}`}
                                    title={`${c.levels.join(' · ')} — ${c.sources.join(', ')}`}
                                    onClick={() => setChoice((s) => ({ ...s, [key]: i }))}
                                  >
                                    {c.levels.length}
                                  </button>
                                ))}
                              </span>
                            )}
                          </td>
                          <td className="mpro-hint mpro-reasonFrom" title={cand.sources.join(', ')}>
                            {cand.samePro ? '' : `${t('reasonLocalXProto')} · `}
                            {cand.sources.slice(0, 2).join(', ')}{cand.sources.length > 2 ? ` +${cand.sources.length - 2}` : ''}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mpro-hint">{t('reasonLocalWarning')}</p>
            </>
          )}

          {withoutCandidates.length > 0 && (
            <p className="mpro-hint">
              {fmt(t('reasonLocalFillMissing'), {
                n: withoutCandidates.length,
                ids: withoutCandidates.slice(0, 6).map((r) => r.id).join(', ') + (withoutCandidates.length > 6 ? '…' : ''),
              })}
            </p>
          )}
          {dir && <p className="mpro-hint mpro-reasonFrom"><code>{dir}</code></p>}

          <div className="mpro-reasonActions">
            <button
              className="mpro-btn mpro-btnPrimary"
              disabled={busy || !selectedKeys.length}
              onClick={() => void write()}
            >
              {fmt(t('reasonLocalWrite'), { n: selectedKeys.length })}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
