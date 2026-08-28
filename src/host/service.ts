/**
 * dsh-model-pro — Host Typert Remote service.
 *
 * `ModelProRuntime` is the Host half's RPC surface for static-bundle mode. Each
 * method takes the single JSON `args` object the client sends and delegates to
 * the SAME handler functions the dynamic build used — the business logic is
 * unchanged; only the transport wrapper differs. The service key `modelPro`
 * matches the Typert manifest and the client's reflect lookup.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SERVICE_KEY } from '../shared/contract'
import type { HostCtx } from './utils'

import { listProviders } from './handlers/list'
import { toggleProvider } from './handlers/toggle'
import { getProvider } from './handlers/get'
import { discoverModels } from './handlers/discover'
import { createProvider } from './handlers/create'
import { deleteProvider } from './handlers/delete'
import { updateField } from './handlers/updateField'
import { updateHeaders } from './handlers/updateHeaders'
import { applyModels } from './handlers/applyModels'
import { testProvider } from './handlers/test'
import { setApiKey } from './handlers/updateKey'
import { listRoutes, setRoute, deleteRoute } from './handlers/routes'
import { listComposites, setComposite, deleteComposite, previewComposite } from './handlers/composites'
import {
  getRouteStats,
  listRequestLogs,
  clearRequestLogs,
  probeTarget,
  probeAll,
} from './handlers/observability'
import { getUiPrefs, setUiPrefs } from './handlers/uiPrefs'
import { getRetryPrefs, setRetryPrefs } from './handlers/retryPrefs'

export class ModelProRuntime extends (TypertRemoteService as any) {
  ctx: HostCtx

  constructor(ctx: HostCtx) {
    super(ctx, SERVICE_KEY)
    this.ctx = ctx
  }

  async listProviders() {
    return listProviders(this.ctx)
  }
  async toggleProvider(args: any) {
    return toggleProvider(this.ctx, args || {})
  }
  async getProvider(args: any) {
    return getProvider(this.ctx, args || {})
  }
  async discoverModels(args: any) {
    return discoverModels(this.ctx, args || {})
  }
  async createProvider(args: any) {
    return createProvider(this.ctx, args || {})
  }
  async deleteProvider(args: any) {
    return deleteProvider(this.ctx, args || {})
  }
  async updateField(args: any) {
    return updateField(this.ctx, args || {})
  }
  async updateHeaders(args: any) {
    return updateHeaders(this.ctx, args || {})
  }
  async applyModels(args: any) {
    return applyModels(this.ctx, args || {})
  }
  async testProvider(args: any) {
    return testProvider(this.ctx, args || {})
  }
  async setApiKey(args: any) {
    return setApiKey(this.ctx, args || {})
  }
  async listRoutes(args: any) {
    return listRoutes(this.ctx, args || {})
  }
  async setRoute(args: any) {
    return setRoute(this.ctx, args || {})
  }
  async deleteRoute(args: any) {
    return deleteRoute(this.ctx, args || {})
  }
  async listComposites() {
    return listComposites(this.ctx)
  }
  async setComposite(args: any) {
    return setComposite(this.ctx, args || {})
  }
  async deleteComposite(args: any) {
    return deleteComposite(this.ctx, args || {})
  }
  async previewComposite(args: any) {
    return previewComposite(this.ctx, args || {})
  }
  async getRouteStats() {
    return getRouteStats(this.ctx)
  }
  async listRequestLogs(args: any) {
    return listRequestLogs(this.ctx, args || {})
  }
  async clearRequestLogs() {
    return clearRequestLogs(this.ctx)
  }
  async probeTarget(args: any) {
    return probeTarget(this.ctx, args || {})
  }
  async probeAll() {
    return probeAll(this.ctx)
  }
  async getUiPrefs() {
    return getUiPrefs(this.ctx)
  }
  async setUiPrefs(args: any) {
    return setUiPrefs(this.ctx, args || {})
  }
  async getRetryPrefs() {
    return getRetryPrefs(this.ctx)
  }
  async setRetryPrefs(args: any) {
    return setRetryPrefs(this.ctx, args || {})
  }
}
