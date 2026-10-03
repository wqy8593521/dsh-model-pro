/** 能力来源属于插件状态；原生 Pi 配置只接收 input，不保存展示字段。 */
import type { ModelCapabilitySource, ModelEntry, ModelInput, ProviderProfile } from '../shared/types'
import type { SettingsService } from './utils'
import { readOwnedStateKey, writeOwnedStateKey } from './utils'

export const CAPABILITIES_KEY = 'modelCapabilities'
export interface CapabilityRecord {
  wireId: string
  input: ModelInput[]
  source: Exclude<ModelCapabilitySource, 'configured'>
  conflict?: boolean
  reference?: string
}
interface ProviderCapabilities {
  binding: string
  models: Record<string, CapabilityRecord>
}
export type CapabilityState = Record<string, ProviderCapabilities>
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const signature = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || !value.length || value.some((v) => v !== 'text' && v !== 'image')) return undefined
  return ['text', 'image'].filter((v) => value.includes(v)).join()
}
export const capabilityBinding = (profile: ProviderProfile): string => JSON.stringify([profile.api || '', profile.baseURL || ''])
export const capabilityWireId = (entry: ModelEntry): string => entry.requestModel?.trim() || entry.id

export function readCapabilityState(st: SettingsService): CapabilityState {
  const value = readOwnedStateKey(st, CAPABILITIES_KEY)
  return record(value) ? value as CapabilityState : {}
}

export function capabilityRecord(state: CapabilityState, route: string, profile: ProviderProfile, entry: ModelEntry): CapabilityRecord | undefined {
  const provider = Object.hasOwn(state, route) ? state[route] : undefined
  if (!provider || provider.binding !== capabilityBinding(profile) || !record(provider.models)) return undefined
  const saved = Object.hasOwn(provider.models, entry.id) ? provider.models[entry.id] : undefined
  if (!saved || !record(saved) || saved.wireId !== capabilityWireId(entry) || !['manual', 'catalog', 'discovery', 'official', 'provider-default'].includes(saved.source)) return undefined
  const input = signature(entry.input)
  return input && signature(saved.input) === input ? saved : undefined
}

export function stateForCapabilities(state: CapabilityState, route: string, profile: ProviderProfile, models: Record<string, CapabilityRecord>): CapabilityState {
  if (Object.keys(models).length) return { ...state, [route]: { binding: capabilityBinding(profile), models } }
  const next = { ...state }
  delete next[route]
  return next
}

const writes = new WeakMap<SettingsService, Promise<unknown>>()
/** 本插件的模型保存串行处理，防止不同 route 的来源写入互相覆盖。 */
export async function withCapabilityWrite<T>(st: SettingsService, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(st) ?? Promise.resolve()
  const task = prior.catch(() => {}).then(work)
  writes.set(st, task)
  try { return await task } finally { if (writes.get(st) === task) writes.delete(st) }
}

/** 来源先落盘，再提交 input；记录绑定原生值，任一步失败都不会误认人工来源。 */
export async function saveCapabilities(st: SettingsService, before: CapabilityState, after: CapabilityState, commit: () => Promise<void>): Promise<void> {
  const changed = JSON.stringify(before) !== JSON.stringify(after)
  if (changed) await writeOwnedStateKey(st, CAPABILITIES_KEY, after)
  try { await commit() } catch (error) {
    if (changed) {
      // 外部会话可能在提交期间更新来源；此时不能用旧快照回滚覆盖它。
      try {
        const current = readCapabilityState(st)
        const restored: CapabilityState = Object.assign(Object.create(null), current)
        for (const route of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (JSON.stringify(before[route]) === JSON.stringify(after[route]) || JSON.stringify(current[route]) !== JSON.stringify(after[route])) continue
          if (Object.hasOwn(before, route)) restored[route] = before[route]
          else delete restored[route]
        }
        if (JSON.stringify(current) !== JSON.stringify(restored)) await writeOwnedStateKey(st, CAPABILITIES_KEY, restored)
      } catch { /* 绑定失效的记录不会当成当前能力；保留原错误供重试。 */ }
    }
    throw error
  }
}
