/**
 * dsh-model-pro — 隐藏模型（模型级"临时摘下、原样放回"）的寄存区。
 *
 * 为什么必须是"摘出来 + 寄存"，而不是给条目加一个 `hidden: true` 标记：
 * 对话底部模型选择器的分组列表来自 `llm-pi-ai.listModels()`，它对每个 route
 * 无条件返回 `snapshot.models.getModels(provider)` 的完整列表，不读任何 per-model
 * 标记。标记写得进去（`providers` 是 `.volatile()`，`validatePaths` 直接放行，
 * 未声明键也原样透传），但没有任何读侧会因此隐藏条目 —— 所以"隐藏"只能靠把
 * 条目从 `providers[route].models` 里摘出来。
 *
 * 摘出来的条目必须有地方寄存，否则用户手填的数据就没了：`reasoningEfforts` /
 * `compat` / `requestModel` 以及手填的 `contextWindow` / `maxTokens` / `input`
 * 都不是"获取远端模型"能带回来的字段（发现流程只 feeds id/name/contextWindow/
 * maxTokens/input）。寄存位置是本插件自己的分区，理由与 `disabledProviders` 相同：
 * llm-pi-ai 的 schema 只声明 `providers`，0.2 拒绝任何其它目的键。
 *
 * 两处非显然之处，都是实测出来的：
 *   1. 摘除会把该模型的 capability 记录一并从 `capabilityStore` 里删掉 ——
 *      `stateForCapabilities` 是整路由替换，只保留存活条目的记录。所以记录必须
 *      随条目一起寄存，否则显示回来时来源会被降级成 `manual`，从此不再跟随目录更新。
 *   2. `binding`（`[api, baseURL]`）跟着条目一起存：提供商改了地址以后，旧条目可以
 *      按原样放回模型列表，但绝不能复活一个属于旧端点的能力来源。
 */

import { HIDDEN_MODELS_KEY } from '../shared/constants'
import type { ModelEntry } from '../shared/types'
import type { SettingsService } from './utils'
import { readOwnedStateKey, writeOwnedStateKey } from './utils'
import { type CapabilityRecord } from './capabilityStore'

/** 一条被隐藏的模型。 */
export interface HiddenModelEntry {
  /** 摘除时在原列表中的下标；显示时按原位插回，避免顺序抖动。 */
  index: number
  /** 完整条目（含 reasoningEfforts / compat / requestModel / 手填上限）。 */
  model: ModelEntry
  /** 摘除时该模型的来源记录；见文件头第 1 点。 */
  capability?: CapabilityRecord
}

/** 一个 route 的隐藏区。 */
export interface HiddenProviderEntry {
  /** 摘除时的 `capabilityBinding(profile)`；地址变了就不复活旧来源。 */
  binding: string
  entries: HiddenModelEntry[]
}

/** 隐藏区整体：`{ [route]: HiddenProviderEntry }`。 */
export type HiddenState = Record<string, HiddenProviderEntry>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 读隐藏区。容错到"读不出来就当空"，与 `capabilityStore` 同一立场：一个形状
 * 不对的值不能把设置事件处理函数搞崩。
 *
 * 注意 `CapabilityRecord` 的字段在这里**不做**逐字段校验 —— 记录是 llm-pi-ai
 * 实际值绑定的，恢复时由 `capabilityRecord()`（读侧）重新校验 wireId 与 input
 * 签名；此处提前丢弃只会让用户的来源在显示后静默消失。
 */
export function readHiddenState(st: SettingsService | undefined): HiddenState {
  if (st === undefined) return {}
  const value = readOwnedStateKey(st, HIDDEN_MODELS_KEY)
  const root = isRecord(value) ? value : {}
  const out: HiddenState = Object.create(null)
  for (const [route, entry] of Object.entries(root)) {
    if (!isRecord(entry)) continue
    const entries: HiddenModelEntry[] = []
    for (const item of Array.isArray(entry.entries) ? entry.entries : []) {
      if (!isRecord(item) || !isRecord(item.model)) continue
      const model = item.model as ModelEntry
      if (typeof model.id !== 'string' || !model.id) continue
      const index = Number.isInteger(item.index) && (item.index as number) >= 0 ? (item.index as number) : 0
      const capability = isRecord(item.capability) ? (item.capability as unknown as CapabilityRecord) : undefined
      entries.push({ index, model: { ...model }, ...(capability ? { capability } : {}) })
    }
    if (!entries.length) continue
    out[route] = { binding: typeof entry.binding === 'string' ? entry.binding : '', entries }
  }
  return out
}

/** 写隐藏区（整键替换，走自有分区读-合并-写）。 */
export async function writeHiddenState(st: SettingsService, state: HiddenState): Promise<void> {
  await writeOwnedStateKey(st, HIDDEN_MODELS_KEY, state)
}

/** 取一个 route 的隐藏区（无条目视为无）。 */
export function hiddenFor(state: HiddenState, route: string): HiddenProviderEntry | undefined {
  const entry = Object.hasOwn(state, route) ? state[route] : undefined
  return entry && entry.entries.length ? entry : undefined
}

/** 设置或清空一个 route 的隐藏区，返回新状态（不改原对象）。 */
export function withHidden(
  state: HiddenState,
  route: string,
  binding: string,
  entries: HiddenModelEntry[],
): HiddenState {
  const next: HiddenState = { ...state }
  if (entries.length) next[route] = { binding, entries }
  else delete next[route]
  return next
}

/**
 * 从隐藏区摘掉若干个 id（显示、或用户重新加回该模型时用）。
 * 返回新状态与被摘掉的条目，供调用方决定是否回填来源。
 *
 * 保留 `entry.binding` 原值：它记录的是"条目被摘下来那一刻的端点绑定"，用当前
 * profile 重算会把这个事实抹掉，之后就无法判断该不该复活旧来源。
 */
export function withoutHidden(
  state: HiddenState,
  route: string,
  ids: Iterable<string>,
): { state: HiddenState; removed: HiddenModelEntry[] } {
  const entry = hiddenFor(state, route)
  if (!entry) return { state, removed: [] }
  const drop = new Set(ids)
  const removed = entry.entries.filter((item) => drop.has(item.model.id))
  if (!removed.length) return { state, removed: [] }
  const kept = entry.entries.filter((item) => !drop.has(item.model.id))
  return { state: withHidden(state, route, entry.binding, kept), removed }
}

/**
 * Drop a whole route's archive.
 *
 * 提供商被删除、或同 route 被重新创建时用：归档按 route 键控，宿主里已经没有
 * 对应的提供商，这些条目既没有归处、也没有被"显示"的入口 —— 留着只会在设置里
 * 积累看不见的模型数据，或在一个全新的提供商上凭空冒出旧模型。
 */
export function clearHiddenFor(
  state: HiddenState,
  route: string,
): { state: HiddenState; removed: HiddenModelEntry[] } {
  const entry = hiddenFor(state, route)
  if (!entry) return { state, removed: [] }
  const next: HiddenState = { ...state }
  delete next[route]
  return { state: next, removed: entry.entries }
}