# Changelog

## 2.0.2 — 2026-10-09

- fix(compat) — **a partial write into the plugin's own settings section no longer resets the owned keys it does not mention (#6).** DSH 0.2's `SettingsForms.replace()` is "Reset all live fields, then set the supplied fields" — its write is `mergeLayers(strip(raw, form), next)`, which deletes every declared volatile field from the stored patch and re-materialises only what the caller supplied. Two call sites passed a partial section, so `routes`, `composites`, `uiPrefs`, `routerRetry`, `modelCatalog`, `localGateway`, `modelCapabilities`, `routeStats` and `disabledProviders` were silently reset to their defaults on every provider add/edit/enable/disable/delete, and again on every `dsh` startup.
  - `writeSections()` (every provider write) now goes through the read-merge-write helper `writeOwnedState`, so the stored section is restated in full.
  - `selfCheck()` (every startup) now prefers the host's `update()`, which merges at the patch layer server-side; when a service has no `update()` it falls back to replacing the section MERGED with what it could read (RULE 3 — never destroy what you cannot read) instead of a one-field section.
- fix(compat) — **provider writes no longer pin resolved schema defaults into the user's document (#6, finding B).** On 0.2 the plugin read `describe().value` — the RESOLVED config, with schemastery defaults and `${{…}}` interpolations materialized — and restated it on every write, so one provider operation rewrote every existing profile with eleven fields the user never wrote (`compat`, `defaultContextWindow`, `defaultInput`, …), fixing host-side defaults at the values current at write time. Reads on the descriptor arm now prefer the `user` row (the profile's PATCH layer — `compat.ts` `fromDescribe`, `config.ts` `readOwnSection`), which is also what every write round-trips. Consequences: profiles stay exactly as bare as the user wrote them; providers defined by the composition rather than the user's patch are no longer restated into (or shown by) this plugin — they belong to the native settings page, and their routes keep resolving. Fields an earlier buggy version already pinned stay in the document; they are harmless (equal to the then-current defaults) and cannot be told apart from intentional values.
- fix(create) — **a new provider can no longer take the name of an installed provider (#6, finding C).** `llm-pi-ai` resolves a route to the installed provider and overlays a same-named profile's fields on top, so creating `deepseek-official` with a junk `baseURL` silently replaced DeepSeek's endpoints while the native model page kept showing the built-in as normal — and the delete confirmation could no longer tell them apart. Creation now checks `ll.listConfigurableProviders()` and refuses the name with an explicit error (skipped if the LLM service is unavailable).
- fix(client) — **the provider editor is framed for wide screens (#5).** The header and tabs share one bordered sticky card that pins while the settings page scrolls, the editor expands up to 1200px with wrapping long route names, and scrolling is disciplined: entering the editor or switching tabs resets the host settings scroller, and returning restores the provider-list position. The current-model table drops its 320px inner-scroll cap and follows the page scroll; remote discovery keeps its compact independent scroll.
- refactor(compat) — `makeHostPlain` and the owned-section merge write moved next to the writes they serve (`compat.ts` / `settings.ts`) so the data layer keeps a single dependency direction (`compat ← settings ← utils`); both stay re-exported from `utils` for the handlers' import path. `SettingsLike` now documents the optional `update()` member as the capability that selects the safe partial write (RULE 1: detect by capability, never by version).
- test — the 0.2 doubles in `tests/host.compat-layer.mjs` and `tests/host.volatile02.mjs` now model the REAL `replace()` (declared volatile fields not restated are dropped), expose `update()`, and serve a RESOLVED `value` layer distinct from the raw `user` layer. They previously merged on `replace()` and served only one layer, which is why the suite was green while the data loss shipped. Five regressions were added — provider write preserves sibling owned keys, startup self-check preserves them, the no-`update()` fallback preserves them, provider writes do not pin resolved defaults into the patch, and create refuses an installed-provider name — every one fails against the pre-fix code.

## 2.0.1 — 2026-10-06

- fix(compat): desktop 0.2.0-rc.x rejects plugin activation with "strict codec has no create() factory" (#4) — strict codecs now carry BOTH the 0.1.x shape (`schema.parse`) and the 0.2.x shape (`create()` factory returning a parser), so one bundle activates on either runtime
- fix(compat): disable/enable was structurally broken on DSH 0.2.x desktop — `Config field "disabledProviders" is not volatile`. `llm-pi-ai` declares only `providers` as a volatile field, and 0.2's settings service refuses (and cannot even serve) any other key there, so parking disabled providers in `llm-pi-ai.disabledProviders` could never work. The plugin now declares its OWN settings section (`Config` with every owned key volatile) and writes providers to `llm-pi-ai` / parked profiles to that section. The same split also moves `routes`, `composites`, `routeStats`, `uiPrefs`, `routerRetry`, `modelCatalog`, `localGateway` and `modelCapabilities` out of the foreign-key squat, so those features stop being silently unreadable on 0.2.
- fix(compat): upgrading from an older version no longer hides existing configuration. Older versions kept that state as foreign keys inside `llm-pi-ai`, and readers now resolve it from the plugin's own section, so `migrateOwnedState` (awaited at the top of `apply`) copies every owned key across and then rewrites `llm-pi-ai` holding provider data only — leaving keys this plugin does not own untouched. Nothing is lost and no user action is required.
- fix(compat): `readDisabledDict`'s legacy lookup was gated on `typeof st.get === 'function'`, which silently dropped the parked bag on exactly the runtime that needs it — 0.2 has no `get()`. The union with `llm-pi-ai.disabledProviders` is now unconditional.
- Uninstall-restore is unchanged: parked profiles move back to `llm-pi-ai.providers`, so no model data is lost.
- feat(deprecation): a 0.1.x runtime now logs one notice at activation that the dual-mode compatibility path is scheduled for removal in v3 (`LEGACY_ARM_REMOVAL`). 0.1 stays fully supported in this release — the notice exists so the removal is not a surprise, and because pushing 0.1 users onto 0.2 is where configuration can be lost, a forced upgrade would be actively harmful.
- refactor(compat): settings access is consolidated into a single compatibility layer, `src/host/compat.ts`, which documents four rules and is the ONLY module allowed to call the settings service (`tests/host.architecture.mjs` enforces that mechanically — a new direct call anywhere else fails the suite). The namespace writers `writeLLMProviders` / `writeOwnedSection` are the two write paths, so a future DSH shape is absorbed in one file.
- feat(compat): `selfCheck()` proves against the LIVE service that configuration reads and writes actually work, by round-tripping a declared probe field (`writeProbe`) through this plugin's own section. It reports a precise code (`ok` / `no-settings-service` / `read-only` / `unknown-arm` / `write-failed` / `roundtrip-mismatch` / `timed-out`) and `apply` logs a warning when it is not operational — so a runtime that would present an empty provider list says so instead.
- fix(compat): the self-check is BOUNDED (2s). The 0.1 service queued the probe write and never resolved it, which hung plugin activation; it now times out and activation continues. Regression covered by two tests.
- hardening: the settings-service arm is now classified by TWO independent capabilities (`get(ns)` vs `describe()`) into `raw` / `descriptor` / `unknown` (`settingsArm`), instead of the binary "not raw ⇒ descriptor" test. A future DSH that has neither now logs an explicit `unrecognised settings service` diagnostic rather than silently degrading into no-op configuration reads — which is the failure shape that looks like "my providers vanished". `tests/host.matrix.mjs` covers all three.
- Known limitation (DSH 0.2, no workaround available from a plugin): `describe()` runs every section through `projectForm`, which keeps only schema-declared paths. An undeclared key squatted inside **another** plugin's section is therefore unreadable through the settings API — so on 0.2 the migration can only reclaim keys from `llm-pi-ai` when the runtime exposes them (0.1 does; 0.2 does not). The migration is written to be correct on both and never destroys what it cannot read. On 0.2, recovering a legacy `llm-pi-ai.disabledProviders` bag requires the operator to re-enable those providers once; their profiles are still intact in `llm-pi-ai.providers` / the imported document.
- test: `tests/host.ownedkeys.mjs` recovers every owned-state key from the writer call sites in the source and fails unless the settings schema declares exactly those keys as volatile — the failure mode is a user-facing operation aborting with `Config field "X" is not volatile`, which shipped broken three times during the migration. `tests/host.schema.mjs` builds the schema with BOTH shipped schemastery versions (3.18.1 for the repo/0.1 web profile, 3.18.4 for the desktop app) and asserts owned state round-trips. `tests/host.compat.mjs` boots the real bundle through `apply()` against realistic older-version documents on both service shapes (0.1 raw `get`, 0.2 descriptor) and pins what each runtime can and cannot migrate. `tests/host.matrix.mjs` runs PLUGIN version × RUNTIME as a table, so the shipped old-vs-new behaviour is recorded rather than recalled.

## 1.1.8 — 2026-08-28

- fix(ui): primary button label unreadable in dark mode

## 1.1.7 — 2026-08-24

- feat: enhance turn selection and correlation window handling in RouteBadge component
- feat: enhance observability with persistent stats and request log management
- feat: add links section with Linux community resource

## 1.1.6 — 2026-08-22

- feat(ui): add UI preferences for conversation badge visibility

## 1.1.5 — 2026-08-22

- feat: add custom model management and search functionality in ModelsPanel

## 1.1.4 — 2026-08-21

- fix: drop default export so loader keeps name/inject named exports
- refactor: convert to static bundle plugin (Typert Remote RPC)

## 1.1.3 — 2026-08-21

- fix: mount loader row under package name, not display label
- docs: fix install instructions — use npm: prefix; document git-source allowBuilds

## 1.1.2 — 2026-08-21

- chore: auto-generate CHANGELOG in release script; backfill 1.1.1 notes

## 1.1.1 — 2026-08-21

- **Smart routing** — named routes aggregating multiple providers' models with 5
  strategies (priority / weighted / round-robin / min-latency / sticky),
  per-target weights and enable switches, `healthAware` dispatch, session
  pinning, `maxFallbacks`, and per-target timeout
- **Composite providers** — merge several providers' models into one virtual
  provider with union / intersection modes (`composite / name::model`)
- **Observability & probing** — per-target live health probes (up / down /
  probing + consecutive-fail tracking) and a session-scoped request log with
  by-route / by-target stats (calls, success rate, avg latency, tokens)
- **Encrypted API keys** — paste a key in the GUI; stored AES-256-GCM encrypted
  at rest with the master key held in the DSH credentials service (never
  regenerated, so old ciphertext still decrypts after reinstall)
- **Local wire-name mapping** — forward a mapped model name to the provider via
  the stream-rewrite adapter
- **Automated release** — `prepare` + `prepublishOnly` build hooks and
  `scripts/release.mjs` one-command release; CI now builds, tests, and verifies
  `dist/` is inside the npm tarball before publishing (fixes the missing-entry
  artifact that broke 1.0.x installs)
- **Docs** — rewritten bilingual README with features, screenshots, usage, and
  install / uninstall guides

## 1.1.0

- **Connectivity test** — new "Test" tab (and per-card Test button) runs a tiny
  real inference through the provider's full credential/header/protocol pipeline
  via `llm.prepareCall`, reporting latency, stop reason and the reply, with a
  configurable timeout and clear errors for disabled/unconfigured providers
- **Uninstall safety (no data loss)** — the host listens for its own `dispose`
  event (plugin uninstalled or disabled) and runs the inverse of disable:
  every provider in `disabledProviders` is moved back to `providers` with its
  full profile (models, headers, credentials) untouched, so model data is never
  stranded in the schema-foreign `disabledProviders` key
- **Redesigned UX** — dashboard with All/Enabled/Disabled segments (counts),
  state-rail provider cards with status pills and config chips, a guided 3-step
  create wizard with inline validation and "Create & test", an Overview tab with
  a readiness checklist, and a cleaned-up Models tab (discovery bar + bulk
  apply)
- Friendly protocol labels, mono type for route/baseURL/model ids, responsive
  layout, reduced-motion support

## 1.0.0

- Provider CRUD: create, delete, edit with card-based list UI
- Enable/disable via `disabledProviders` dict (removes from model selector)
- Per-provider custom HTTP headers editor
- Remote model discovery with select-all / unselect-all / invert
- Batch model write (replace / merge modes)
- Tabbed editor: Info / Headers / Models
- Cross-realm safe via `makeHostPlain` (null-proto objects)
