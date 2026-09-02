/** suggest-reasoning handler — fill `reasoningEfforts` from the INSTALLED pi-ai catalog.
 *
 * This is the root-cause half of the missing-thinking-level problem. llm-pi-ai
 * only consults its installed catalog under the PROVIDER ROUTE NAME, so a custom
 * gateway route never inherits anything and every model on it resolves to
 * `reasoning: false` — which is why a router route aggregating six gateway
 * targets could advertise no levels at all. The declarations for those same model
 * ids are already on disk under their first-party providers; this handler reads
 * them by id and hands them back as an editable prefill.
 *
 * Two ways to ask, because the problem shows up at two scopes:
 *   - `route` (+ optional `ids`): one provider's models, for the 模型 tab.
 *   - `targets`: an explicit `{provider, model}` list, for a ROUTE — the case
 *     that actually bites, where the empty union comes from targets spread across
 *     several gateways and fixing them one provider at a time is the tedious part.
 *
 * It never writes. The client shows the candidates with their evidence and the
 * user applies them through the existing `apply-models` path, so every value
 * still passes `normalizeReasoningEfforts`. That matters because the catalog
 * describes the model as its HOME provider serves it: a gateway may expose fewer
 * levels or want a different spelling, and a wrong `reasoningEfforts` fails
 * llm-pi-ai's config schema for the WHOLE provider section.
 */

import type { HostCtx } from '../utils'
import { readProviders, readDisabled, readProfile } from '../utils'
import { suggestFor, catalogStatus } from '../piCatalog'
import type { ThinkingLevel } from '../../shared/constants'
import type { ReasoningEfforts } from '../../shared/types'

/** One model's candidate declarations, as sent to the client. */
export interface SuggestionRow {
  /** Which provider route this model belongs to. */
  provider: string
  id: string
  /** That provider's wire protocol, which decided the candidates' wire values. */
  api: string
  /** What the entry declares today: `null` = inherit, `false` = does not reason. */
  current: null | false | ReasoningEfforts
  candidates: Array<{
    levels: ThinkingLevel[]
    efforts: ReasoningEfforts
    sources: string[]
    samePro: boolean
  }>
}

/** A provider profile plus the two things a row needs from it. */
interface ProviderView {
  api: string
  models: Map<string, any>
}

function viewOf(ctx: HostCtx, route: string): ProviderView | undefined {
  const st = ctx.get('settings')
  const p = readProfile(readProviders(st), route) || readProfile(readDisabled(st), route)
  if (!p) return undefined
  const models = new Map<string, any>()
  if (Array.isArray(p.models)) {
    for (const m of p.models) {
      if (m && typeof m === 'object' && typeof m.id === 'string') models.set(m.id, m)
      else if (typeof m === 'string') models.set(m, { id: m })
    }
  }
  return { api: typeof p.api === 'string' ? p.api : '', models }
}

/** Normalize a stored value into the three states the UI shows. */
function currentOf(entry: any): null | false | ReasoningEfforts {
  const v = entry?.reasoningEfforts
  if (v === false) return false
  if (v && typeof v === 'object') return v as ReasoningEfforts
  return null
}

export async function suggestReasoning(
  ctx: HostCtx,
  args: { route?: string; ids?: unknown; targets?: unknown },
) {
  // Build the (provider, model) work list FIRST. A malformed call must report
  // what is wrong with the call, not "the catalog is unavailable" — otherwise the
  // panel blames the machine for a bug in the request.
  //
  // Targets win when both are given: a caller sending an explicit list means it,
  // and silently preferring `route` would fill the wrong models.
  const pairs: Array<{ provider: string; id: string }> = []
  let ids: string[] | undefined
  if (Array.isArray(args?.targets)) {
    const seen = new Set<string>()
    for (const raw of args.targets as any[]) {
      if (!raw || typeof raw !== 'object') continue
      const provider = String(raw.provider || '')
      const id = String(raw.model || raw.id || '')
      if (!provider || !id) continue
      const key = `${provider}\u0000${id}`
      // A route may list the same pair twice (different weights); one row is
      // enough, and two would let the user check contradicting candidates.
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ provider, id })
    }
    if (!pairs.length) return { ok: false as const, error: 'targets 里没有有效的 provider/model' }
  } else {
    const route = args?.route
    if (!route) return { ok: false as const, error: '缺少 route 或 targets' }
    const view = viewOf(ctx, route)
    if (!view) return { ok: false as const, error: `提供商 "${route}" 不存在` }
    ids = Array.isArray(args?.ids)
      ? (args.ids as unknown[]).map((x) => String(x)).filter(Boolean)
      : [...view.models.keys()]
    if (!ids.length) return { ok: false as const, error: '该提供商没有显式声明的模型条目' }
    for (const id of ids) pairs.push({ provider: route, id })
  }

  const status = await catalogStatus()
  if (!status.ok) return { ok: false as const, error: status.error || '本地模型目录不可用' }

  // One profile read per distinct provider, not per pair.
  const views = new Map<string, ProviderView | undefined>()
  const rows: SuggestionRow[] = []
  const unknown: string[] = []
  for (const { provider, id } of pairs) {
    if (!views.has(provider)) views.set(provider, viewOf(ctx, provider))
    const view = views.get(provider)
    if (!view) {
      if (!unknown.includes(provider)) unknown.push(provider)
      continue
    }
    rows.push({
      provider,
      id,
      api: view.api,
      current: currentOf(view.models.get(id)),
      // The protocol of the RECEIVING provider decides the wire value, not the
      // protocol of the provider the declaration was borrowed from.
      candidates: await suggestFor(id, view.api),
    })
  }
  if (!rows.length) {
    return { ok: false as const, error: `提供商不存在：${unknown.join(', ') || '(空)'}` }
  }

  return {
    ok: true as const,
    /** Where the catalog was read from, so the source is auditable in the UI. */
    dir: status.dir,
    indexed: status.models,
    /** Providers named by the caller that do not exist — reported, not fatal. */
    ...(unknown.length ? { unknown } : {}),
    rows,
  }
}
