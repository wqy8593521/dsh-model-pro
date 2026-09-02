/** External model-catalog preference handlers (models.dev lookup).
 *
 * Only the PREFERENCES live on the host; the fetch itself happens in the client,
 * because the Host sandbox withholds the Web globals a bounded HTTP request
 * needs (`AbortController` in particular — see `handlers/test.ts`), and the
 * catalog is a plain public GET with `access-control-allow-origin: *` that the
 * browser can read directly. Routing 4 MB through the RPC boundary would buy
 * nothing.
 *
 * The URL is user-settable so a deployment can point at a mirror, a pinned
 * snapshot, or a LAN cache instead of the public endpoint.
 */

import type { HostCtx } from '../utils'
import { readRoutesRootKey, writeRoutesRootKey, checkWritable } from '../utils'
import { CATALOG_KEY, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_ENABLED } from '../../shared/constants'
import type { CatalogPrefs } from '../../shared/types'

const DEFAULTS: CatalogPrefs = { enabled: DEFAULT_CATALOG_ENABLED, url: '' }

/** Only `http(s)` is accepted.
 *
 * A stored `file:`/`data:`/`javascript:` URL would be handed to the client's
 * `fetch`, so validating here keeps the one place that persists it as the one
 * place that decides what is fetchable. An invalid value falls back to the last
 * good one rather than failing the write, so a bad edit can never leave the
 * panel unable to load its own preferences.
 *
 * Checked by hand rather than with `URL`: the Host sandbox's global set is
 * deliberately narrow (it withholds `AbortController`, `setTimeout` and more —
 * see `handlers/test.ts`), and this file must not be the one that discovers
 * another absent global at runtime. A scheme-plus-authority test is all that is
 * needed and cannot throw. */
function normalizeUrl(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Whitespace or control characters anywhere disqualify it outright; the rest
  // must be scheme + a non-empty authority.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return fallback
  if (!/^https?:\/\/[^/?#]+/i.test(trimmed)) return fallback
  return trimmed
}

function normalize(raw: unknown, base: CatalogPrefs = DEFAULTS): CatalogPrefs {
  const out: CatalogPrefs = { ...base }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.enabled === 'boolean') out.enabled = r.enabled
    if (Object.prototype.hasOwnProperty.call(r, 'url')) out.url = normalizeUrl(r.url, base.url)
  }
  return out
}

function read(ctx: HostCtx): CatalogPrefs {
  return normalize(readRoutesRootKey(ctx.get('settings'), CATALOG_KEY))
}

export async function getCatalogPrefs(ctx: HostCtx) {
  const prefs = read(ctx)
  // `effectiveUrl` saves every caller from re-implementing the empty-means-default
  // rule, and makes the resolved value visible in the UI.
  return {
    ok: true as const,
    prefs,
    effectiveUrl: prefs.url || DEFAULT_CATALOG_URL,
    defaultUrl: DEFAULT_CATALOG_URL,
  }
}

export async function setCatalogPrefs(ctx: HostCtx, args?: { prefs?: Partial<CatalogPrefs> }) {
  const st = ctx.get('settings')
  if (!st || !checkWritable(st)) return { ok: false as const, error: '设置只读，无法保存' }
  const patch = args?.prefs && typeof args.prefs === 'object' ? args.prefs : {}
  // Normalize the patch AGAINST the saved value so a partial update (toggle
  // only, or URL only) keeps the other field instead of resetting it.
  const merged = normalize(patch, read(ctx))
  await writeRoutesRootKey(st, CATALOG_KEY, merged)
  return {
    ok: true as const,
    prefs: merged,
    effectiveUrl: merged.url || DEFAULT_CATALOG_URL,
    defaultUrl: DEFAULT_CATALOG_URL,
  }
}
