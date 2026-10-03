/** 模型能力使用明确配置或运行时目录；不按名称猜测未知模型是否支持图片。 */
import { NS } from '../shared/constants'
import type { ModelEntry, ModelInput, ModelCapabilitySource } from '../shared/types'
import type { HostCtx, LLMService } from './utils'
import { readProviders, readDisabled, readProfile } from './utils'
import { readCapabilityState, capabilityRecord, type CapabilityRecord } from './capabilityStore'

interface CatalogInputs {
  byRoute: Map<string, Map<string, ModelInput[] | null>>
  byId: Map<string, ModelInput[] | null>
  complete: boolean
  conflicts: Set<string>
}

const catalogs = new WeakMap<LLMService, Promise<CatalogInputs>>()

/** 不把未知/音频/视频能力截断为“仅文本”，避免误判接口尚不支持的模型。 */
export function normalizeModelInput(value: unknown): ModelInput[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => v !== 'text' && v !== 'image')) return undefined
  return (['text', 'image'] as const).filter((v) => value.includes(v))
}

function declaredDefaultInput(ctx: HostCtx, route: string): ModelInput[] | undefined {
  const st = ctx.get('settings')
  if (!st) return undefined
  const fromSection = (section: unknown): ModelInput[] | undefined => {
    if (!section || typeof section !== 'object') return undefined
    const providers = (section as Record<string, unknown>).providers
    if (!providers || typeof providers !== 'object') return undefined
    const profile = (providers as Record<string, unknown>)[route]
    return profile && typeof profile === 'object' ? normalizeModelInput((profile as Record<string, unknown>).defaultInput) : undefined
  }
  try {
    if (typeof st.get === 'function') return fromSection(st.get(NS)) ?? normalizeModelInput(readProfile(readDisabled(st), route)?.defaultInput)
    return undefined
  } catch { return undefined }
}

async function catalogInputs(llm: LLMService): Promise<CatalogInputs> {
  let pending = catalogs.get(llm)
  if (!pending) {
    pending = (async () => {
      const result: CatalogInputs = { byRoute: new Map(), byId: new Map(), complete: true, conflicts: new Set() }
      const providers = llm.listConfigurableProviders().filter((p) => p.settingsNs === NS && p.declared !== true)
      const names = [...new Set(providers.map((p) => p.provider))]
      for (const provider of names) {
        try {
          // 只有 provider，没有 baseURL：pi-ai 返回内置目录，缺失目录时直接失败，不触网。
          const models = await llm.discoverModels(NS, { provider })
          const route = new Map<string, ModelInput[] | null>()
          for (const model of models) {
            const input = normalizeModelInput(model.inputModalities ?? model.input)
            if (!input) {
              route.set(model.id, null)
              result.byId.set(model.id, null)
              continue
            }
            route.set(model.id, input)
            const prior = result.byId.get(model.id)
            if (prior && prior.join() !== input.join()) result.conflicts.add(model.id)
            result.byId.set(model.id, prior === null || (prior && prior.join() !== input.join()) ? null : input)
          }
          result.byRoute.set(provider, route)
        } catch { result.complete = false }
      }
      // 缺失某个目录时无法排除同名冲突，只允许仍可验证的同供应商匹配。
      if (!result.complete) result.byId.clear()
      return result
    })().catch(() => {
      catalogs.delete(llm)
      return { byRoute: new Map(), byId: new Map(), complete: false, conflicts: new Set<string>() }
    })
    catalogs.set(llm, pending)
  }
  const result = await pending
  // 就绪前的空目录或暂时失败允许下次重试，不能将“未确认”缓存到重启。
  if (!result.complete || result.byRoute.size === 0) catalogs.delete(llm)
  return result
}

interface CapabilityDetection {
  input?: ModelInput[]
  source?: Exclude<ModelCapabilitySource, 'configured' | 'manual' | 'discovery'>
  conflict: boolean
  reference?: string
}

/** 已核验的精确型号资料；不用关键字匹配，也不把旧 V4 的所有别名泛化为图片模型。
 * DeepSeek 官方 2026-09-10 发布说明明确 V4.1 Flash 原生视觉，官方 API ID 为 deepseek-flash。
 * third-party 的 deepseek-v4.1-flash 目录 ID 对应同一型号；这里只声明模型能力，端点仍未实测。 */
const officialInputs = new Map<string, ModelInput[]>([
  ['deepseek-flash', ['text', 'image']],
  ['deepseek-v4.1-flash', ['text', 'image']],
])
const DEEPSEEK_REFERENCE = 'https://api-docs.deepseek.com/updates/#deepseek-v41-flash-release'

function automaticInput(ctx: HostCtx, route: string, entry: ModelEntry, catalog: CatalogInputs | undefined, allowTextDefault: boolean): CapabilityDetection {
  const id = typeof entry.requestModel === 'string' && entry.requestModel.trim() ? entry.requestModel.trim() : entry.id
  const own = catalog?.byRoute.get(route)
  const official = officialInputs.get(id)
  const conflict = catalog?.conflicts.has(id) ?? false
  if (own?.has(id)) {
    const input = own.get(id) ?? undefined
    // 同供应商的能力声明优先，官方型号资料与接口目录不一致时直接展示差异。
    return { input, source: input ? 'catalog' : undefined, conflict: conflict || !!(input && official && input.join() !== official.join()) }
  }
  if (official) return { input: [...official], source: 'official', conflict, reference: DEEPSEEK_REFERENCE }
  const providerDefault = declaredDefaultInput(ctx, route)
  const globalInput = catalog?.byId.get(id) ?? undefined
  if (allowTextDefault && providerDefault) return { input: providerDefault, source: 'provider-default', conflict }
  if (providerDefault?.includes('image') && !conflict) return { input: providerDefault, source: 'provider-default', conflict }
  if (globalInput) return { input: globalInput, source: 'catalog', conflict }
  return { conflict }
}

export async function resolveModelInput(ctx: HostCtx, route: string, entry: ModelEntry): Promise<ModelInput[] | undefined> {
  const configured = normalizeModelInput(entry.input)
  if (configured) return configured
  // Harness 的 schema 会为缺失数组生成 []；与原生 declaredInput 一样视为未声明。
  if (entry.input !== undefined && !(Array.isArray(entry.input) && entry.input.length === 0)) return undefined
  const llm = ctx.get('llm')
  return automaticInput(ctx, route, entry, llm ? await catalogInputs(llm) : undefined, true).input
}

/** 按钮显式请求一次目录识别，使用同一份快照处理全部模型，不发推理请求。 */
export async function detectModelInputs(ctx: HostCtx, route: string, entries: ModelEntry[]): Promise<{
  inputs: Map<string, ModelInput[]>
  results: Map<string, CapabilityDetection>
  catalogUnavailable: boolean
}> {
  const inputs = new Map<string, ModelInput[]>()
  const results = new Map<string, CapabilityDetection>()
  if (!entries.length) return { inputs, results, catalogUnavailable: false }
  const llm = ctx.get('llm')
  if (llm) catalogs.delete(llm)
  const catalog = llm ? await catalogInputs(llm) : undefined
  for (const entry of entries) {
    const result = automaticInput(ctx, route, entry, catalog, false)
    results.set(entry.id, result)
    if (result.input) inputs.set(entry.id, [...result.input])
  }
  return { inputs, results, catalogUnavailable: !catalog || !catalog.complete || catalog.byRoute.size === 0 }
}

export function savedModelCapability(ctx: HostCtx, route: string, entry: ModelEntry): CapabilityRecord | undefined {
  const st = ctx.get('settings')
  if (!st) return undefined
  const profile = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
  return profile ? capabilityRecord(readCapabilityState(st), route, profile, entry) : undefined
}

/** 读操作附加来源；原生配置只持久化 input，来源另存插件状态。 */
export async function describeModelInput(ctx: HostCtx, route: string, entry: ModelEntry, explicitSource: ModelCapabilitySource = 'configured'): Promise<ModelEntry> {
  const explicit = normalizeModelInput(entry.input)
  const saved = explicitSource === 'configured' ? savedModelCapability(ctx, route, entry) : undefined
  const llm = ctx.get('llm')
  const undeclared = entry.input === undefined || (Array.isArray(entry.input) && entry.input.length === 0)
  // 展示和识别统一：通用文本默认不足以确认某个未知型号只能输入文本。
  const inferred = explicit || !undeclared ? undefined : automaticInput(ctx, route, entry, llm ? await catalogInputs(llm) : undefined, false)
  const input = explicit ?? inferred?.input
  const out = { ...entry }
  delete out.capabilitySource
  delete out.capabilityConflict
  delete out.capabilityReference
  delete out.input
  if (input) {
    out.input = [...input]
    out.capabilitySource = explicit ? saved?.source ?? explicitSource : inferred?.source
    if (saved?.reference ?? inferred?.reference) out.capabilityReference = saved?.reference ?? inferred?.reference
  }
  if (saved?.conflict ?? inferred?.conflict) out.capabilityConflict = true
  return out
}
