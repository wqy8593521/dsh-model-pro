/** 模型能力使用明确配置或运行时目录；不按名称猜测未知模型是否支持图片。 */
import { NS } from '../shared/constants'
import type { ModelEntry, ModelInput, ModelCapabilitySource, ProviderProfile } from '../shared/types'
import type { HostCtx, LLMService } from './utils'
import { readProviders, readDisabled, readProfile, readSection } from './utils'
import { readCapabilityState, capabilityRecord, type CapabilityRecord, type CapabilityState } from './capabilityStore'

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
  // Kept as its own accessor so single-entry callers stay readable; callers that
  // describe MANY entries of one route must pass the view instead (see
  // `capabilityView`), because this reads the settings service on every call.
  const fromSection = (section: unknown): ModelInput[] | undefined => {
    if (!section || typeof section !== 'object') return undefined
    const providers = (section as Record<string, unknown>).providers
    if (!providers || typeof providers !== 'object') return undefined
    const profile = (providers as Record<string, unknown>)[route]
    return profile && typeof profile === 'object' ? normalizeModelInput((profile as Record<string, unknown>).defaultInput) : undefined
  }
  try {
    // One accessor for both arms: `readSection` uses `get(ns)` on 0.1 and the
    // `describe()` descriptor on 0.2, where a raw `st.get` does not exist.
    return (
      fromSection(readSection(st, NS)) ??
      normalizeModelInput(readProfile(readDisabled(st), route)?.defaultInput)
    )
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

function automaticInput(
  ctx: HostCtx,
  route: string,
  entry: ModelEntry,
  catalog: CatalogInputs | undefined,
  allowTextDefault: boolean,
  defaultInput?: ModelInput[] | null,
): CapabilityDetection {
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
  // `null` = resolved-to-none, `undefined` = caller resolved nothing for us.
  const providerDefault = defaultInput === undefined ? declaredDefaultInput(ctx, route) : defaultInput ?? undefined
  const globalInput = catalog?.byId.get(id) ?? undefined
  if (allowTextDefault && providerDefault) return { input: providerDefault, source: 'provider-default', conflict }
  if (providerDefault?.includes('image') && !conflict) return { input: providerDefault, source: 'provider-default', conflict }
  if (globalInput) return { input: globalInput, source: 'catalog', conflict }
  return { conflict }
}

/**
 * Everything one route's capability lookup needs, read ONCE.
 *
 * Why this exists at all: `describeModelInput` used to read the settings service
 * per entry (profile + disabled dict + capability state + declared default
 * input). On DSH 0.2 every one of those reads is a `describe()` over ALL
 * sections, so describing a 300-model provider cost ~1200 `describe()` calls —
 * the "model editor takes seconds to open" lag. Callers that loop must build the
 * view once and pass it down; single-entry callers keep the one-argument shape.
 */
export interface CapabilityView {
  profile: ProviderProfile | null
  state: CapabilityState
  /** `providers[route].defaultInput`, resolved once.
   *
   * `null` means "resolved, and the profile declares none" — that distinction is
   * load-bearing: `undefined` would send the per-entry path back to the settings
   * service for every model, which is the O(N) read this view exists to remove. */
  defaultInput?: ModelInput[] | null
}

export function capabilityView(ctx: HostCtx, route: string): CapabilityView {
  const st = ctx.get('settings')
  if (!st) return { profile: null, state: {} }
  try {
    const profile = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
    return {
      profile,
      state: readCapabilityState(st),
      ...(profile ? { defaultInput: normalizeModelInput(profile.defaultInput) ?? null } : {}),
    }
  } catch {
    return { profile: null, state: {} }
  }
}

export async function resolveModelInput(ctx: HostCtx, route: string, entry: ModelEntry, view?: CapabilityView): Promise<ModelInput[] | undefined> {
  const configured = normalizeModelInput(entry.input)
  if (configured) return configured
  // Harness 的 schema 会为缺失数组生成 []；与原生 declaredInput 一样视为未声明。
  if (entry.input !== undefined && !(Array.isArray(entry.input) && entry.input.length === 0)) return undefined
  const prepared = view ?? capabilityView(ctx, route)
  const llm = ctx.get('llm')
  return automaticInput(ctx, route, entry, llm ? await catalogInputs(llm) : undefined, true, prepared.defaultInput).input
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
  // 识别是按 route 批量做的，所以默认输入只解析一次（否则每个模型一次 settings 读）。
  const view = capabilityView(ctx, route)
  for (const entry of entries) {
    const result = automaticInput(ctx, route, entry, catalog, false, view.defaultInput)
    results.set(entry.id, result)
    if (result.input) inputs.set(entry.id, [...result.input])
  }
  return { inputs, results, catalogUnavailable: !catalog || !catalog.complete || catalog.byRoute.size === 0 }
}

export function savedModelCapability(ctx: HostCtx, route: string, entry: ModelEntry, view?: CapabilityView): CapabilityRecord | undefined {
  const prepared = view ?? capabilityView(ctx, route)
  return prepared.profile ? capabilityRecord(prepared.state, route, prepared.profile, entry) : undefined
}

/** 读操作附加来源；原生配置只持久化 input，来源另存插件状态。 */
export async function describeModelInput(
  ctx: HostCtx,
  route: string,
  entry: ModelEntry,
  explicitSource: ModelCapabilitySource = 'configured',
  view?: CapabilityView,
): Promise<ModelEntry> {
  const explicit = normalizeModelInput(entry.input)
  const prepared = view ?? capabilityView(ctx, route)
  const saved = explicitSource === 'configured' ? savedModelCapability(ctx, route, entry, prepared) : undefined
  const llm = ctx.get('llm')
  const undeclared = entry.input === undefined || (Array.isArray(entry.input) && entry.input.length === 0)
  // 展示和识别统一：通用文本默认不足以确认某个未知型号只能输入文本。
  const inferred = explicit || !undeclared ? undefined : automaticInput(ctx, route, entry, llm ? await catalogInputs(llm) : undefined, false, prepared.defaultInput)
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

/**
 * Describe MANY entries of one route with ONE settings read.
 *
 * `get-provider` and the discovery path describe whole model lists, and the
 * per-entry version of that loop is what made a large provider's editor take
 * seconds to open on DSH 0.2 (every entry re-read profile + capability state
 * through `describe()`, which projects the whole settings document).
 *
 * Entries are processed in the given order; the catalog promise is shared, so
 * the first call may still resolve it.
 */
export async function describeModelInputs(
  ctx: HostCtx,
  route: string,
  entries: ModelEntry[],
  explicitSource: ModelCapabilitySource = 'configured',
): Promise<ModelEntry[]> {
  if (!entries.length) return []
  const view = capabilityView(ctx, route)
  return Promise.all(entries.map((entry) => describeModelInput(ctx, route, entry, explicitSource, view)))
}
