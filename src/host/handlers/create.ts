/** create-provider handler — creates a new provider in the providers dict. */

import { PLACEHOLDER_MODEL_ID, PROTOS } from '../../shared/constants'
import type { HostCtx } from '../utils'
import { readProviders, readDisabled, checkWritable, writeSection, makeHostPlain } from '../utils'
import { setApiKey } from './updateKey'

export async function createProvider(
  ctx: HostCtx,
  args: { route?: string; displayName?: string; api?: string; baseURL?: string; apiKeyEnv?: string; apiKey?: string },
) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }

  const route = args?.route
  if (!route || typeof route !== 'string' || !route.trim())
    return { ok: false as const, error: '缺少 route' }

  const id = route.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(id))
    return { ok: false as const, error: 'route 仅允许字母数字、下划线、点、横线' }

  const providers = readProviders(st)
  const disabled = readDisabled(st)
  if (Object.prototype.hasOwnProperty.call(providers, id))
    return { ok: false as const, error: `提供商 "${id}" 已存在` }
  if (Object.prototype.hasOwnProperty.call(disabled, id))
    return { ok: false as const, error: `提供商 "${id}" 已存在(已禁用)` }

  const profile: Record<string, unknown> = {}
  if (args.displayName && args.displayName.trim()) profile.displayName = args.displayName.trim()
  if (args.api && PROTOS.indexOf(args.api as any) >= 0) profile.api = args.api
  if (args.baseURL && args.baseURL.trim()) profile.baseURL = args.baseURL.trim()
  else return { ok: false as const, error: '新建提供商必须填写 baseURL' }
  if (args.apiKeyEnv && args.apiKeyEnv.trim()) profile.apiKeyEnv = args.apiKeyEnv.trim()
  // llm-pi-ai refuses a custom provider whose model list is empty. Keep one
  // internal schema sentinel until the first real model is added; every read/UI
  // path filters it, so users never see or test it as an actual model.
  profile.models = [{ id: PLACEHOLDER_MODEL_ID, name: PLACEHOLDER_MODEL_ID }]

  try {
    const next: Record<string, unknown> = {}
    for (const k of Object.keys(providers)) next[k] = (providers as any)[k]
    next[id] = makeHostPlain(profile)

    const existingDisabled: Record<string, unknown> = {}
    for (const k of Object.keys(disabled)) existingDisabled[k] = (disabled as any)[k]

    await writeSection(st, next as any, existingDisabled as any)
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }

  // Persist a real key if one was pasted during the guided create flow
  // (encrypted at rest + authoritative copy in the credentials service).
  let keySaved: boolean | undefined
  if (typeof args.apiKey === 'string' && args.apiKey.trim()) {
    const kr = await setApiKey(ctx, { route: id, apiKey: args.apiKey })
    keySaved = kr.ok === true
  }

  return { ok: true as const, route: id, ...(keySaved !== undefined ? { keySaved } : {}) }
}
