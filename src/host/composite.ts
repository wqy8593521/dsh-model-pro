/** Composite provider engine (组合提供商).
 *
 * A composite merges several members' model lists into one virtual route:
 *   - union: every model any member provides
 *   - intersection: only models ALL members provide
 * The virtual route is exposed on the synthetic `composite` provider, with
 * model ids encoded `compositeName::modelId`. At call time the router resolves
 * which members own the model and routes among them by the composite's strategy.
 *
 * Membership is resolved live per call from the members' ADVERTISED models
 * (`llm.listModels`), falling back to their explicit `models` in the settings
 * section when the llm service has no list. Enabled members only.
 */

import type { HostCtx } from './utils'
import { readProviders, readDisabled, readProfile, readRoutesRootKey, writeRoutesRootKey } from './utils'
import { COMPOSITES_KEY, COMPOSITE_SEP, DEFAULT_ROUTE_STRATEGY } from '../shared/constants'
import type { CompositesMap, CompositeSpec, RouteTarget } from '../shared/types'

export function readComposites(ctx: HostCtx): CompositesMap {
  try {
    const st = ctx.get('settings')
    if (st === undefined) return {}
    const raw = readRoutesRootKey(st, COMPOSITES_KEY)
    const out: CompositesMap = {}
    if (raw && typeof raw === 'object') {
      for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
        const c = normalizeComposite(v)
        if (c) out[name] = c
      }
    }
    return out
  } catch { return {} }
}

export async function writeComposites(ctx: HostCtx, map: CompositesMap): Promise<void> {
  const st = ctx.get('settings')
  if (st === undefined) throw new Error('settings 服务不可用')
  // Owned state — it cannot live in `llm-pi-ai`, whose schema declares only
  // `providers` and whose 0.2 write guard refuses any other key.
  await writeRoutesRootKey(st, COMPOSITES_KEY, map)
}

function normalizeComposite(raw: unknown): CompositeSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const members = Array.isArray(r.members)
    ? (r.members.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim()))
    : []
  if (!members.length) return null
  const mode = r.mode === 'intersection' ? 'intersection' : 'union'
  const strategy = typeof r.strategy === 'string' && r.strategy ? r.strategy as CompositeSpec['strategy'] : DEFAULT_ROUTE_STRATEGY
  return { route: String(r.route || ''), members, mode, strategy }
}

/** Encode a composite model id for the virtual `composite` route. */
export function encodeCompositeModel(composite: string, model: string): string {
  return `${composite}${COMPOSITE_SEP}${model}`
}

/** Decode `composite::model` back into parts. */
export function decodeCompositeModel(id: string): { composite: string; model: string } | null {
  const i = id.indexOf(COMPOSITE_SEP)
  if (i <= 0 || i + COMPOSITE_SEP.length >= id.length) return null
  return { composite: id.slice(0, i), model: id.slice(i + COMPOSITE_SEP.length) }
}

/** The members of a composite that currently own `modelId` (as selectable id). */
export function owningMembers(
  ctx: HostCtx,
  compositeName: string,
  modelId: string,
): string[] {
  const spec = readComposites(ctx)[compositeName]
  if (!spec || !spec.members.length) return []
  const st = ctx.get('settings')
  const providers = readProviders(st)
  const disabled = readDisabled(st)
  return spec.members.filter((m) => {
    if (Object.prototype.hasOwnProperty.call(disabled, m)) return false
    const p = readProfile(providers, m)
    if (!p) return false
    return Array.isArray(p.models) && p.models.some((e) => e && typeof e === 'object' && (e as { id?: unknown }).id === modelId)
  })
}

/** All advertised model ids of one member, with dedupe. */
async function memberModels(ctx: HostCtx, member: string): Promise<string[]> {
  const st = ctx.get('settings')
  const providers = readProviders(st)
  const p = readProfile(providers, member)
  const explicit = Array.isArray(p?.models)
    ? p.models.filter((m): m is { id: string } => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string').map((m) => m.id)
    : []
  const llm = ctx.get('llm') as { listModels?: (provider: string) => Promise<Array<{ id: string }>> } | undefined
  if (llm && typeof llm.listModels === 'function') {
    try {
      const advertised = await llm.listModels(member)
      if (Array.isArray(advertised) && advertised.length) {
        const ids = advertised.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter(Boolean)
        return Array.from(new Set([...explicit, ...ids]))
      }
    } catch { /* fall through to explicit */ }
  }
  return explicit
}

/** Resolve the merged model list of a composite. `mode` union → set union of
 * member models; intersection → ids present in EVERY member. */
export async function resolveCompositeModels(ctx: HostCtx, compositeName: string): Promise<{ ok: boolean; ids: string[]; mode: string; error?: string }> {
  const spec = readComposites(ctx)[compositeName]
  if (!spec) return { ok: false, ids: [], mode: 'union', error: `组合提供商「${compositeName}」不存在` }
  const st = ctx.get('settings')
  const disabled = readDisabled(st)
  const members = spec.members.filter((m) => !Object.prototype.hasOwnProperty.call(disabled, m))
  if (!members.length) return { ok: false, ids: [], mode: spec.mode, error: '该组合没有可用的成员提供商' }

  const perMember: string[][] = []
  for (const m of members) perMember.push(await memberModels(ctx, m))

  let merged: string[]
  if (spec.mode === 'intersection') {
    merged = perMember.reduce<string[]>((acc, cur) => acc.filter((id) => cur.includes(id)), perMember[0])
  } else {
    const set = new Set<string>()
    for (const arr of perMember) for (const id of arr) set.add(id)
    merged = Array.from(set)
  }
  merged.sort()
  return { ok: true, ids: merged, mode: spec.mode }
}

/** Build the ordered target candidates for a composite owning a specific model:
 * every enabled member that owns `modelId`, in member order (the router applies
 * the composite's strategy on top of this list). */
export function compositeTargetsFor(ctx: HostCtx, compositeName: string, modelId: string): RouteTarget[] {
  return owningMembers(ctx, compositeName, modelId).map((m) => ({ provider: m, model: modelId }))
}