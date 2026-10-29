/** get-provider handler — returns full provider details for the editor view. */

import { readProviders, readDisabled, readProfile, readRealModels } from '../utils'
import type { HostCtx } from '../utils'
import type { HeaderPair } from '../../shared/types'
import { PLACEHOLDER_MODEL_ID } from '../../shared/constants'
import { describeModelInputs } from '../modelCapabilities'
import { readHiddenState, hiddenFor } from '../hiddenModels'
import { decryptSecret } from '../crypto'

export async function getProvider(ctx: HostCtx, args: { route?: string; includeSecret?: boolean }) {
  const st = ctx.get('settings')
  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const p = readProfile(providers, route) || readProfile(disabled, route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }

  const isDisabled =
    (p as any).disabled === true || Object.prototype.hasOwnProperty.call(disabled, route)
  const headers: HeaderPair[] =
    p.headers && typeof p.headers === 'object'
      ? Object.entries(p.headers).map(([k, v]) => ({ name: k, value: String(v) }))
      : []
  // readRealModels already strips the schema sentinel; describeModelInputs then
  // attaches the DISPLAY-side capability fields (source/conflict/reference) from
  // plugin state and the live catalog, reading that state ONCE for the whole
  // list — the per-entry loop made a large provider's editor open slowly on 0.2.
  // Native entries never carry these fields.
  const models = await describeModelInputs(ctx, route, readRealModels(p))
  const hasExplicit = models.length > 0

  // 隐藏区：条目已从 `providers` 摘出，只能从这里读回来。返回完整条目（含
  // description 不提供的 reasoningEfforts / compat / requestModel），显示时原样放回。
  // `capability` 是内部来源记录，展示侧不需要，刻意不返回。
  const hiddenModels = (hiddenFor(readHiddenState(st), route)?.entries ?? []).map((item) => ({
    ...item.model,
    index: item.index,
  }))

  // Advertised model ids for the test dropdown (advisory; may be empty). For a
  // catalog-route (or enabled custom) provider this is the real list the
  // adapter knows, which the explicit `models` array may not carry.
  let availableModels: string[] = []
  if (!isDisabled) {
    const llm = ctx.get('llm')
    if (llm !== undefined) {
      try {
        const m = await (llm as any).listModels(route)
        if (Array.isArray(m)) availableModels = m
          .map((x: any) => (x && typeof x.id === 'string' ? x.id : ''))
          .filter((id: string) => !!id && id !== PLACEHOLDER_MODEL_ID)
      } catch { /* advisory only */ }
    }
  }

  // Encrypted-at-rest marker + optional on-demand reveal. Reveal decrypts the
  // snapshot first, then falls back to the credentials-service copy (in case
  // the snapshot is missing or its key changed mid-flight).
  const hasSecret = !!(p as any).apiKeyEnc
  let secret: string | undefined
  if (args.includeSecret) {
    try {
      const d = await decryptSecret(ctx, (p as any).apiKeyEnc)
      if (d !== null) secret = d
    } catch { /* fall through */ }
    if (secret === undefined && p.apiKeyEnv && typeof p.apiKeyEnv === 'string') {
      const creds = ctx.get('credentials')
      if (creds !== undefined) {
        try {
          const r = await (creds as any).resolve(p.apiKeyEnv)
          if (r && typeof r.value === 'string' && r.value) secret = r.value
        } catch { /* ignore */ }
      }
    }
  }

  return {
    ok: true as const,
    route,
    displayName: p.displayName || '',
    api: p.api || '',
    baseURL: p.baseURL || '',
    apiKeyEnv: p.apiKeyEnv || '',
    disabled: isDisabled,
    headers,
    models,
    hiddenModels,
    usesCatalog: !hasExplicit,
    availableModels,
    hasSecret,
    ...(secret !== undefined ? { secret } : {}),
  }
}
