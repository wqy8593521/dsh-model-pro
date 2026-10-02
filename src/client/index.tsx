/**
 * dsh-model-pro — Client half entry point (static-bundle mode).
 *
 * Exports a Cordis `apply(ctx)` that:
 *   - registers ZH/EN locale dictionaries,
 *   - injects the page CSS (no `styles` closure in static mode — we adopt a
 *     <style> element directly),
 *   - mounts the `modelPro` Typert Remote service through the API Gateway
 *     (ctx.remote.$mount) and resolves its handle via ctx.reflect, and
 *   - registers the settings.section Slot rendering ModelProPage.
 *
 * All data operations go through the mounted remote (see rpc.ts).
 */

import { CLIENT_NS, ZH, EN } from './i18n'
import { CSS } from './styles'
import { createCall } from './rpc'
import { ModelProPage } from './components/ModelProPage'
import { registerRouteBadge } from './components/RouteBadge'
import { INVOCATIONS, PACKAGE, SERVICE_KEY } from '../shared/contract'
import type { TFunc } from '../shared/types'
import React from './react'

/** Loader entry id / bundle id. */
export const name = PACKAGE

/** Client services this plugin reads. */
export const inject = ['slots', 'remote', 'locale']

const STYLE_ID = 'dsh-model-pro-styles'

function adoptStyles(cssText: string) {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.appendChild(style)
}

export function apply(ctx: any) {
  const locale = ctx.get('locale') ?? ctx.locale
  if (locale !== undefined) {
    ctx.effect(() => {
      try {
        return locale.register(CLIENT_NS, { zh: ZH, en: EN })
      } catch (_e) {
        // namespace already registered from a prior run — safe to ignore
      }
    }, 'dsh-model-pro: dictionaries')
  }

  const t: TFunc = locale !== undefined ? locale.bind(CLIENT_NS) : (k: string) => k

  adoptStyles(CSS)

  // Mount the remote service and resolve its handle. The handle appears under
  // reflect key `remote.<SERVICE_KEY>` once $mount resolves.
  let remote: Record<string, (args: unknown) => Promise<any>> | null = null
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
    const handle = ctx.reflect.get(`remote.${SERVICE_KEY}`)
    if (handle === undefined) {
      throw new Error(`dsh-model-pro: the ${SERVICE_KEY} Remote namespace did not mount`)
    }
    remote = handle
    return () => {
      remote = null
      void dispose()
    }
  }, 'dsh-model-pro: remote')

  const call = createCall(t, () => remote)

  const slots = ctx.get('slots') ?? ctx.slots
  if (slots === undefined) return

  slots.inject('settings.section', () => {
    return slots.register(
      { name: 'settings.section', id: 'dsh-model-pro', order: 12, label: () => t('nav') },
      () => React.createElement(ModelProPage, { t, call }),
    )
  })

  // Conversation badge: under each completed turn, show which provider/model
  // actually served it (smart routes + composites only). No-op on hosts that
  // don't declare the turnTail slot. The bound `t` is passed explicitly so the
  // badge never renders raw dictionary keys.
  registerRouteBadge(slots, call, t)
}

// NOTE: no `default` export here — the loader's unwrapExports prefers a
// default export and would swallow the `name`/`inject` named exports.

/** Test-only re-export: the smoke harness asserts the per-turn correlation
 * window directly (it is pure and the badge's correctness hinges on it). */
export { preciseWindowKey } from './components/RouteBadge'

/** 测试设置页切换时的滚动容器定位。 */
export { findScrollableAncestor, resetEditorScroll } from './components/ProviderEditor'
