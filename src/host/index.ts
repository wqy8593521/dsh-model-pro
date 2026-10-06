/**
 * dsh-model-pro — Host half entry point (static-bundle mode).
 *
 * Mounts the `modelPro` Typert Remote service (the client's RPC surface) and
 * registers its manifest, then wires up smart-routing, composites, health
 * probing, observability, and the uninstall-restore safety net — through
 * Cordis `ctx` (there is no dynamic `harness` global in a static plugin).
 *
 * Static-mounted plugins export `apply` (+ optional `name` / `inject`); the
 * loader imports this module and calls apply(ctx).
 *
 * Disabled providers are removed from `llm-pi-ai.providers` — the dict the
 * llm-pi-ai adapter resolves active routes from — and parked in THIS plugin's
 * OWN settings section. They cannot live in `llm-pi-ai` itself: that schema
 * declares only `providers`, and DSH 0.2.x refuses an undeclared destination key
 * with `Config field "disabledProviders" is not volatile`. The host restores
 * them to `providers` on unload, so no model data is lost.
 */

import type { HostCtx } from './utils'
import { ModelProRuntime } from './service'
import { TYPERT_MANIFEST, PACKAGE } from '../shared/contract'
import { registerRouterAdapter } from './router'
import { registerStreamRewrite } from './streamRewrite'
import { restoreDisabledOnUnload, parkDisabledProviders } from './lifecycle'
import { initHealthTracker, resetHealthSingleton } from './health'
import { resetObservabilitySingletons, hydrateObservability, persistStats, setStatsPersistRequester, resetStatsPersistRequester } from './statsStore'
import { registerLocalGateway, resetLocalGatewayRuntime } from './localGateway'
import { Config, bindConfigAccessor } from './config'
import { migrateOwnedState, warnIfLegacyArm } from './settings'
import { selfCheck } from './compat'

/** Loader entry id / client bundle id. */
export const name = PACKAGE

/**
 * This plugin's OWN settings section, declared as a schemastery schema.
 *
 * Exporting `Config` is what registers the `dsh-model-pro` namespace and makes
 * it writable on DSH 0.2.x, whose settings service refuses any destination key
 * that is not below a `volatile()` node. Owned state (the parked
 * `disabledProviders` bag) lives HERE rather than as an undeclared foreign key
 * inside `llm-pi-ai`, whose schema declares only `providers`.
 *
 * Exported after `name`/`inject` for readability; the loader reads it off the
 * module namespace and wires it to `entry.fiber.runtime.Config`.
 */
export { Config }

/** Hard dependencies. `typert` is the RPC registry we register into. `settings`
 * and `llm` gate WHEN apply runs: cordis parks the fiber until every declared
 * service exists (dsh-cordis-host-runner: "a valid unresolved inject may remain
 * pending"), so declaring them guarantees the reinstall re-park below reads a
 * MOUNTED settings service. Without them an early apply would call
 * `ctx.get('settings')` before it is mounted, read an empty section, and the
 * re-park of marked providers would silently no-op — leaving disabled-marked
 * providers sitting in `providers`, where llm-pi-ai's resolveProfiles registers
 * them as fully active routes again (the marker means nothing to it). */
export const inject = ['typert', 'settings', 'llm', 'webServer']

export async function apply(ctx: HostCtx) {
  const c = ctx as any

  // Bind this plugin's own settings section so handlers can read owned state
  // (the parked `disabledProviders` bag) with nothing but the cordis context.
  // The `settings` inject above guarantees the service exists when apply runs.
  bindConfigAccessor(c.get('settings'))

  // Tell a 0.1 runtime — once — that this compatibility path is on a clock. The
  // plugin keeps working; the notice exists so the removal is not a surprise.
  warnIfLegacyArm(ctx, c.get('settings'))

  // Prove, against the live service, that configuration reads and writes
  // actually work — rather than presenting an empty provider list as truth.
  // See src/host/compat.ts RULE 4. Awaited: migration below depends on it.
  {
    const settings = c.get('settings')
    const report = await selfCheck(settings, name)
    if (!report.operational) {
      try {
        ;(c.get('logger') as any)?.warn?.(
          `dsh-model-pro: configuration is NOT operational (${report.code}) — ${report.detail}. ` +
            `Providers, routes and preferences may appear empty until this is resolved.`,
        )
      } catch { /* a missing logger must never break activation */ }
    }
  }

  // Pull owned state an OLDER version left as foreign keys inside `llm-pi-ai`
  // into our own section BEFORE anything reads it — `registerLocalGateway`
  // below snapshots its prefs at apply time, so migrating later would come too
  // late for it. Awaited because several readers snapshot synchronously here,
  // and because a concurrent `writeSections` would race its cleanup write.
  await migrateOwnedState(ctx)

  // Mount the RPC service and register its strict manifest with the Gateway.
  new ModelProRuntime(ctx)
  c.effect(() => c.typert.register(TYPERT_MANIFEST), 'dsh-model-pro: typert manifest')

  // Rebind observability/local-gateway runtime state to this fresh fiber.
  resetHealthSingleton()
  resetObservabilitySingletons()
  resetLocalGatewayRuntime()
  resetStatsPersistRequester()
  initHealthTracker(ctx)
  // Seed the stats recorder + request-log ring from the persisted snapshot so
  // the 观测台 and the conversation route badge are populated after a page
  // refresh / host restart instead of starting blank.
  hydrateObservability(ctx)

  // Persist after each completed request through a coalescing microtask. This
  // works in minimal/sandbox contexts that do not mount the optional timer
  // service, which was why an unload/reinstall could lose the whole log ring.
  // `queueMicrotask` is not guaranteed present (some sandboxed hosts omit it),
  // so fall back to a resolved-promise continuation.
  //
  // Writes are SERIALIZED on a promise chain: `persistStats` reads the prior
  // snapshot before it writes, so two overlapping async writes could otherwise
  // land out of order and leave a stale snapshot last (e.g. a clear-then-record
  // pair persisting the empty state after the fresh one). Chaining guarantees
  // each write observes the previous one's result and the latest write wins.
  const scheduleMicrotask: (fn: () => void) => void =
    typeof (globalThis as any).queueMicrotask === 'function'
      ? (globalThis as any).queueMicrotask.bind(globalThis)
      : (fn) => { void Promise.resolve().then(fn) }
  let flushChain: Promise<unknown> = Promise.resolve()
  let flushQueued = false
  const releaseStatsRequester = setStatsPersistRequester(() => {
    if (flushQueued) return
    flushQueued = true
    scheduleMicrotask(() => {
      flushQueued = false
      flushChain = flushChain.then(() => persistStats(ctx)).catch(() => {})
    })
  })
  // The interval remains a second safety net for runtimes with a timer service.
  const timer = c.get('timer') as { interval?: (fn: () => void, ms: number) => () => void } | undefined
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => { void persistStats(ctx) }, 5000)
  }
  if (typeof c.effect === 'function') {
    c.effect(() => () => {
      releaseStatsRequester()
      return persistStats(ctx, { force: true })
    }, 'dsh-model-pro: stats flush')
  }

  // Register the authenticated local OpenAI-compatible route. It stays inert
  // (404) unless explicitly enabled and backed by a credentials-service key.
  registerLocalGateway(ctx)

  // Smart routing: expose route combos + composites as models on the synthetic
  // "router" / "composite" routes, forwarding calls to real targets.
  registerRouterAdapter(ctx)
  // Per-provider local model mapping: select X, forward requestModel if set.
  registerStreamRewrite(ctx)

  // Reinstall recovery: parked providers keep their `disabled` marker, so on
  // startup re-park them into disabledProviders (adapter keeps ignoring them).
  //
  // Two-phase, because load order is not guaranteed:
  //  1. eager attempt — works when pi-ai already registered its section;
  //  2. `settings/updated` re-park — dsh-settings emits this for the
  //     `llm-pi-ai` namespace when it first commits (pi-ai registering its
  //     section) and on every later write. If the eager attempt ran before
  //     that section resolved (model-pro loaded before pi-ai), this catches
  //     the marked providers as soon as they become readable and parks them.
  //
  // parkDisabledProviders is idempotent and writes only when a marked profile
  // actually moved, so re-firing on our own write settles after one pass.
  // The `unloading` flag stops the listener from fighting the
  // uninstall-restore: restore moves parked providers BACK into `providers`
  // (marker intact) and its write emits settings/updated — without the flag
  // this listener would immediately re-park them behind the safety net's back.
  let unloading = false
  const reparkOnSettings = () => {
    if (unloading) return
    void parkDisabledProviders(ctx)?.catch?.(() => {})
  }
  reparkOnSettings()
  if (typeof c.on === 'function' && typeof c.effect === 'function') {
    c.effect(() => {
      const off = c.on('settings/updated', (ns: string) => {
        try {
          if (ns !== 'llm-pi-ai') return
          reparkOnSettings()
        } catch { /* ignore */ }
      })
      return () => {
        try { off?.() } catch { /* ignore */ }
      }
    }, 'dsh-model-pro: reinstall re-park on settings/updated')
  } else {
    // Fallback for harness contexts without event plumbing: settle async.
    queueMicrotask(reparkOnSettings)
  }

  // Uninstall / disable safety net: restore disabled providers to `providers`
  // (marker travels with them) so nothing is lost when this plugin goes away.
  // We hook the fiber effect's cleanup — the same pattern dsh-settings uses.
  if (typeof c.effect === 'function') {
    c.effect(() => () => {
      unloading = true
      try {
        return restoreDisabledOnUnload(ctx)
      } catch {
        return undefined
      }
    })
  }
}
