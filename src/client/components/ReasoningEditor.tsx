/** ReasoningEditor — per-model thinking-level declaration, with optional prefill.
 *
 * Why a dedicated editor exists: `reasoningEfforts` is the ONLY thing that
 * decides whether a model offers a thinking control, and it cannot be probed
 * (gateways silently ignore unknown parameters, and `off` is byte-identical to
 * "unsupported" on the wire). Hand-authoring is the way in, so the job of this UI
 * is to make hand-authoring cheap and to show what is currently declared — which
 * is also the answer to "how do I know a model's thinking depth".
 *
 * Two prefill sources, in the order they should be tried:
 *
 *   - the INSTALLED pi-ai catalog, read off disk by the host. Offline, already on
 *     the machine, and it is the very table llm-pi-ai itself consults — it just
 *     looks models up by PROVIDER ROUTE, so a custom gateway route never inherits
 *     anything. Reading it by MODEL ID is what makes those declarations reusable,
 *     and it carries the per-level WIRE values, not only the level names.
 *   - models.dev over the network, off by default. Level names only.
 *
 * Both only PREFILL: the catalog describes the model as its FIRST-PARTY provider
 * serves it, and a gateway may expose fewer levels or want a different spelling.
 * So every value stays editable and the evidence behind a suggestion is shown
 * rather than hidden.
 */

import React from '../react'
import { THINKING_LEVELS } from '../../shared/constants'
import type { ThinkingLevel } from '../../shared/constants'
import type { ModelEntry, ReasoningEfforts, TFunc, CallFn } from '../../shared/types'
import { loadCatalog, matchModel, unusableKinds, toEfforts } from '../catalog'
import type { CatalogMatch } from '../catalog'
import { fmt } from '../labels'

/** One candidate the host read out of the installed pi-ai catalog. */
interface LocalCandidate {
  levels: ThinkingLevel[]
  efforts: ReasoningEfforts
  sources: string[]
}

interface Props {
  t: TFunc
  call: CallFn
  /** The provider route this model belongs to (the exact-match key). */
  route: string
  model: ModelEntry
  /** Whether the models.dev lookup is enabled, and where it reads from. */
  catalog: { enabled: boolean; url: string }
  /** Persist a new value: a dict, `false` (does not reason), or null (inherit). */
  onSave: (value: ReasoningEfforts | false | null) => Promise<void>
  onClose: () => void
  busy: boolean
}

/** The three states of the field, as a UI mode. */
type Mode = 'inherit' | 'none' | 'levels'

function modeOf(value: ModelEntry['reasoningEfforts']): Mode {
  if (value === false) return 'none'
  if (value && typeof value === 'object') return 'levels'
  return 'inherit'
}

export function ReasoningEditor({ t, call, route, model, catalog, onSave, onClose, busy }: Props) {
  const saved = model.reasoningEfforts
  const [mode, setMode] = React.useState<Mode>(modeOf(saved))
  // Per-level wire values. `undefined` = level not offered; a string (or null
  // for `off`) = offered with that wire value.
  const [wires, setWires] = React.useState<Record<string, string | null | undefined>>(() => {
    const init: Record<string, string | null | undefined> = {}
    if (saved && typeof saved === 'object') {
      for (const level of THINKING_LEVELS) {
        if (Object.prototype.hasOwnProperty.call(saved, level)) init[level] = (saved as ReasoningEfforts)[level]
      }
    }
    return init
  })
  const [matches, setMatches] = React.useState<CatalogMatch[] | null>(null)
  const [kinds, setKinds] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  // Local (installed pi-ai) suggestions: `null` = not looked up yet.
  const [local, setLocal] = React.useState<LocalCandidate[] | null>(null)
  const [localDir, setLocalDir] = React.useState<string>('')
  const [localBusy, setLocalBusy] = React.useState(false)
  const [localErr, setLocalErr] = React.useState<string | null>(null)

  const offered = THINKING_LEVELS.filter((l) => wires[l] !== undefined || (l === 'off' && Object.prototype.hasOwnProperty.call(wires, l)))

  const toggleLevel = (level: ThinkingLevel) => {
    setWires((w) => {
      const next = { ...w }
      if (Object.prototype.hasOwnProperty.call(next, level)) delete next[level]
      // `off` means "supported, send nothing" — its wire value is null, not the
      // level name, so it is never prefilled with text.
      else next[level] = level === 'off' ? null : level
      return next
    })
    setMode('levels')
  }

  const setWire = (level: ThinkingLevel, value: string) => {
    setWires((w) => ({ ...w, [level]: level === 'off' && !value.trim() ? null : value }))
  }

  const lookup = async () => {
    setLoading(true); setErr(null)
    try {
      const index = await loadCatalog(catalog.url, false)
      setMatches(matchModel(index, route, model.id))
      setKinds(unusableKinds(index, route, model.id))
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }

  const applyMatch = (m: CatalogMatch) => {
    setWires(toEfforts(m.levels))
    setMode('levels')
  }

  /** Ask the host to read the installed pi-ai catalog for this model id. */
  const lookupLocal = async () => {
    setLocalBusy(true); setLocalErr(null)
    try {
      const r = await call('suggest-reasoning', { route, ids: [model.id] })
      const row = Array.isArray(r?.rows) ? r.rows.find((x: any) => x?.id === model.id) : undefined
      setLocal(Array.isArray(row?.candidates) ? row.candidates : [])
      setLocalDir(typeof r?.dir === 'string' ? r.dir : '')
    } catch (e) {
      setLocalErr(String((e as Error)?.message || e))
    } finally {
      setLocalBusy(false)
    }
  }

  /** Adopt a local candidate verbatim — it already carries wire values. */
  const applyLocal = (c: LocalCandidate) => {
    const next: Record<string, string | null | undefined> = {}
    for (const level of THINKING_LEVELS) {
      if (Object.prototype.hasOwnProperty.call(c.efforts, level)) next[level] = c.efforts[level] ?? null
    }
    setWires(next)
    setMode('levels')
  }

  const save = async () => {
    if (mode === 'inherit') { await onSave(null); return }
    if (mode === 'none') { await onSave(false); return }
    const dict: ReasoningEfforts = {}
    for (const level of THINKING_LEVELS) {
      if (!Object.prototype.hasOwnProperty.call(wires, level)) continue
      const v = wires[level]
      dict[level] = level === 'off' && (v === null || v === undefined || v === '') ? null : String(v ?? '')
    }
    await onSave(dict)
  }

  // Mirrors the host's validation so the reason is visible BEFORE saving.
  // Rejecting here is not a substitute for the host check — the host is
  // authoritative because llm-pi-ai fails the whole provider section on a bad
  // value — but a disabled button with a reason beats a round-trip error.
  const problem = ((): string | null => {
    if (mode !== 'levels') return null
    const levels = THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(wires, l))
    if (!levels.length) return t('reasonNeedLevel')
    if (!levels.some((l) => l !== 'off')) return t('reasonNeedBeyondOff')
    for (const l of levels) {
      if (l === 'off') continue
      const v = wires[l]
      if (v === null || v === undefined || String(v).trim() === '') return fmt(t('reasonNeedWire'), { level: l })
    }
    return null
  })()

  return (
    <div className="mpro-reasonBox">
      <div className="mpro-reasonHead">
        <strong>{fmt(t('reasonTitle'), { id: model.id })}</strong>
        <span className="mpro-right" />
        <button className="mpro-btn mpro-btnSm" onClick={onClose}>{t('close')}</button>
      </div>

      <div className="mpro-reasonModes">
        {(['inherit', 'none', 'levels'] as Mode[]).map((m) => (
          <button
            key={m}
            className={`mpro-pill ${mode === m ? 'mpro-pillActive' : ''}`}
            onClick={() => setMode(m)}
          >
            {t(m === 'inherit' ? 'reasonModeInherit' : m === 'none' ? 'reasonModeNone' : 'reasonModeLevels')}
          </button>
        ))}
      </div>
      <p className="mpro-hint">
        {t(mode === 'inherit' ? 'reasonHintInherit' : mode === 'none' ? 'reasonHintNone' : 'reasonHintLevels')}
      </p>

      {mode === 'levels' && (
        <>
          {/* Local prefill first: offline, already installed, and it carries the
              wire values rather than only the level names. */}
          <div className="mpro-reasonLookup">
            <button className="mpro-btn mpro-btnSm" disabled={localBusy} onClick={() => void lookupLocal()}>
              {localBusy ? t('reasonLooking') : t('reasonLocalLookup')}
            </button>
            <span className="mpro-hint">{t('reasonLocalHint')}</span>
          </div>
          {localErr && <p className="mpro-verdictErr">{fmt(t('reasonLocalFail'), { err: localErr })}</p>}
          {local !== null && (
            local.length === 0 ? (
              <p className="mpro-hint">{fmt(t('reasonLocalNoMatch'), { id: model.id })}</p>
            ) : (
              <div className="mpro-reasonCands">
                {local.map((c, i) => (
                  <div className="mpro-reasonCand" key={`local-${i}`}>
                    <span className={`mpro-tierTag ${i === 0 ? 'mpro-tierExact' : ''}`}>
                      {fmt(t('reasonLocalTier'), { n: c.sources.length })}
                    </span>
                    <code className="mpro-reasonLevels">{c.levels.join(' · ')}</code>
                    <span className="mpro-hint mpro-reasonFrom">
                      {c.sources.slice(0, 3).join(', ')}{c.sources.length > 3 ? '…' : ''}
                    </span>
                    <span className="mpro-right" />
                    <button className="mpro-btn mpro-btnSm" onClick={() => applyLocal(c)}>{t('reasonUse')}</button>
                  </div>
                ))}
                <p className="mpro-hint">{t('reasonLocalWarning')}</p>
                {localDir && <p className="mpro-hint mpro-reasonFrom"><code>{localDir}</code></p>}
              </div>
            )
          )}

          {catalog.enabled ? (
            <div className="mpro-reasonLookup">
              <button className="mpro-btn mpro-btnSm" disabled={loading} onClick={() => void lookup()}>
                {loading ? t('reasonLooking') : t('reasonLookup')}
              </button>
              <span className="mpro-hint">{fmt(t('reasonLookupFrom'), { url: catalog.url })}</span>
            </div>
          ) : (
            <p className="mpro-hint">{t('reasonLookupOff')}</p>
          )}
          {err && <p className="mpro-verdictErr">{fmt(t('reasonLookupFail'), { err })}</p>}

          {matches !== null && (
            matches.length === 0 ? (
              <p className="mpro-hint">
                {kinds.length ? fmt(t('reasonOnlyKinds'), { kinds: kinds.join(', ') }) : t('reasonNoMatch')}
              </p>
            ) : (
              <div className="mpro-reasonCands">
                {matches.map((m, i) => (
                  <div className="mpro-reasonCand" key={`${m.tier}-${i}`}>
                    <span className={`mpro-tierTag ${m.tier === 'exact' ? 'mpro-tierExact' : ''}`}>
                      {m.tier === 'exact'
                        ? t('reasonTierExact')
                        : fmt(t('reasonTierById'), { votes: m.votes, total: m.total })}
                    </span>
                    <code className="mpro-reasonLevels">{m.levels.join(' · ')}</code>
                    <span className="mpro-hint mpro-reasonFrom">{m.providers.slice(0, 3).join(', ')}{m.providers.length > 3 ? '…' : ''}</span>
                    <span className="mpro-right" />
                    <button className="mpro-btn mpro-btnSm" onClick={() => applyMatch(m)}>{t('reasonUse')}</button>
                  </div>
                ))}
                <p className="mpro-hint">{t('reasonWireWarning')}</p>
              </div>
            )
          )}

          <div className="mpro-tblWrap">
            <table className="mpro-tbl">
              <thead>
                <tr>
                  <th className="mpro-tblCk"></th>
                  <th>{t('reasonLevelCol')}</th>
                  <th>{t('reasonWireCol')}</th>
                </tr>
              </thead>
              <tbody>
                {THINKING_LEVELS.map((level) => {
                  const on = Object.prototype.hasOwnProperty.call(wires, level)
                  return (
                    <tr key={level}>
                      <td className="mpro-tblCk">
                        <input type="checkbox" checked={on} onChange={() => toggleLevel(level)} />
                      </td>
                      <td className="mpro-id">{level}</td>
                      <td>
                        <input
                          className="mpro-input mpro-inputMono"
                          style={{ width: 180 }}
                          disabled={!on}
                          value={on ? String(wires[level] ?? '') : ''}
                          placeholder={level === 'off' ? t('reasonOffPlaceholder') : level}
                          onChange={(e) => setWire(level, e.target.value)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {offered.length > 0 && <p className="mpro-hint">{fmt(t('reasonSummary'), { levels: offered.join(' · ') })}</p>}
        </>
      )}

      {problem && <p className="mpro-verdictErr">{problem}</p>}
      <div className="mpro-reasonActions">
        <button className="mpro-btn mpro-btnPrimary" disabled={busy || !!problem} onClick={() => void save()}>
          {t('save')}
        </button>
      </div>
    </div>
  )
}
