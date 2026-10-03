/** discover-models handler — calls llm.discoverModels to fetch remote model list. */

import { NS } from '../../shared/constants'
import type { HostCtx } from '../utils'
import { readProviders, readProfile } from '../utils'
import { describeModelInput, normalizeModelInput } from '../modelCapabilities'

export async function discoverModels(
  ctx: HostCtx,
  args: { route?: string; baseURL?: string; api?: string; apiKey?: string },
) {
  const llm = ctx.get('llm')
  if (llm === undefined) return { ok: false as const, error: 'llm 服务不可用' }

  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const st = ctx.get('settings')
  const providers = readProviders(st)
  const p = readProfile(providers, route)

  const request: Record<string, unknown> = {
    provider: route,
    baseURL: args.baseURL || (p && p.baseURL) || undefined,
    api: args.api || (p && p.api) || undefined,
  }
  if (args.apiKey && typeof args.apiKey === 'string' && args.apiKey.length > 0)
    request.apiKey = args.apiKey

  try {
    const disc = await llm.discoverModels(NS, request)
    // 发现结果保留 input 能力并绑定 discovery 来源：发现是元数据，不是人工声明。
    const models = await Promise.all(disc.map((m) => describeModelInput(ctx, route, {
      id: m.id,
      name: m.name || m.id,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(normalizeModelInput(m.inputModalities ?? m.input) ? { input: normalizeModelInput(m.inputModalities ?? m.input) } : {}),
    }, 'discovery')))
    return { ok: true as const, models }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }
}
