/** create-provider handler — creates a new provider in the providers dict. */

import { PLACEHOLDER_MODEL_ID, PROTOS } from '../../shared/constants'
import type { HostCtx } from '../utils'
import { readProviders, readDisabled, checkWritable, writeSection, makeHostPlain } from '../utils'
import { readCapabilityState, saveCapabilities, withCapabilityWrite } from '../capabilityStore'
import { setApiKey } from './updateKey'

export async function createProvider(
  ctx: HostCtx,
  args: { route?: string; displayName?: string; api?: string; baseURL?: string; apiKeyEnv?: string; apiKey?: string },
) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }
  return withCapabilityWrite(st, () => createProviderLocked(ctx, args))
}

async function createProviderLocked(
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

  // A route named after an INSTALLED provider (dsh-llm-*, e.g. `deepseek-official`)
  // would silently shadow it: pi-ai resolves the route to the installed provider
  // and overlays this profile's fields on top of the built-in endpoints/protocol,
  // while the native model page keeps showing the built-in as if nothing changed
  // (issue #6, finding C). Refuse the name — the dedup above only sees OUR dicts.
  const llm = ctx.get('llm')
  if (llm) {
    try {
      const clash = llm
        .listConfigurableProviders()
        .find((p) => p && typeof p.provider === 'string' && p.provider === id)
      if (clash) {
        const what = clash.displayName && clash.displayName !== clash.provider ? `(${clash.displayName})` : ''
        return {
          ok: false as const,
          error:
            `提供商名 "${id}" 与已安装的内置提供商${what}重名,新建会静默接管其路由;` +
            `请换一个名字,或直接使用该内置提供商`,
        }
      }
    } catch {
      /* 枚举失败(服务异常/旧宿主)时跳过该校验,保持可创建。 */
    }
  }

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

    // 外部配置可能删掉供应商而留下能力来源；同名新建不能继承上一个供应商的人工锁定。
    const before = readCapabilityState(st)
    const after = { ...before }
    delete after[id]
    await saveCapabilities(st, before, after, () => writeSection(st, next as any, existingDisabled as any))
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
