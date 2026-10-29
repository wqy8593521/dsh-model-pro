/** UI preference handlers — small, profile-scoped UI choices.
 *
 * Preferences persist under this plugin's own settings section (UI_PREFS_KEY,
 * which `Config` declares volatile) so they follow the profile across browsers
 * and reloads. Merged over defaults, so a new key needs no migration.
 */

import type { HostCtx } from '../utils'
import { readRoutesRootKey, writeRoutesRootKey, checkWritable } from '../utils'
import { UI_PREFS_KEY } from '../../shared/constants'

export interface UiPrefs {
  /** Show a small badge under each routed turn naming the provider/model that
   * actually served it (default: true). */
  showRouteBadge: boolean
  /** Whether the model editor has already explained "hide vs delete" and asked
   * for confirmation once. Hiding is reversible by design, so the explanation
   * and the dialog belong to the first use only (default: false). */
  hiddenModelsHintSeen: boolean
}

const DEFAULTS: UiPrefs = { showRouteBadge: true, hiddenModelsHintSeen: false }

function normalize(raw: unknown): UiPrefs {
  const out: UiPrefs = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.showRouteBadge === 'boolean') out.showRouteBadge = r.showRouteBadge
    if (typeof r.hiddenModelsHintSeen === 'boolean') out.hiddenModelsHintSeen = r.hiddenModelsHintSeen
  }
  return out
}

export async function getUiPrefs(ctx: HostCtx) {
  return { ok: true as const, prefs: normalize(readRoutesRootKey(ctx.get('settings'), UI_PREFS_KEY)) }
}

export async function setUiPrefs(ctx: HostCtx, args?: { prefs?: Partial<UiPrefs> }) {
  const st = ctx.get('settings')
  if (!st || !checkWritable(st)) return { ok: false as const, error: '设置只读，无法保存' }
  const patch = args?.prefs && typeof args.prefs === 'object' ? args.prefs : {}
  const merged = normalize({ ...normalize(readRoutesRootKey(st, UI_PREFS_KEY)), ...patch })
  await writeRoutesRootKey(st, UI_PREFS_KEY, merged)
  return { ok: true as const, prefs: merged }
}
