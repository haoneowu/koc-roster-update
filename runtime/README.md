# Portable runtime

## Metadata

- Title: Portable KOC runtime dependency and validation report
- Maintainer: KOC Roster Update maintainers
- Status: Offline validated; Windows live acceptance pending
- Updated: 2026-10-08

Runtime release **0.2.59**, skill contract **0.6.1**, Node **26.x**.

This directory contains the daily inventory/contact runner, source capture and add-only Base synchronization, readiness HTTP server/probe, their local dependency closure, and the private JSON-file Lark mutation transport. Dependencies outside this directory are the root package's pinned Playwright, Playwright CLI and Lark CLI packages. No external author checkout, customer files, browser sessions, checkpoints, or node_modules are distributed here.

`shared/config.mjs` reads `KOC_DATA_DIR`, `KOC_PLAYWRIGHT_SESSION` (default `koc-roster`), `KOC_BUYIN_ACCOUNT_MARKER`, and the explicit `KOC_FEISHU_PROFILE`, `KOC_FEISHU_IDENTITY`, `KOC_FEISHU_HOST`, `KOC_FEISHU_BASE_TOKEN`, `KOC_FEISHU_TABLE_ID` route. Identity must be `user`; missing route fields fail before Base dispatch. All state and captured source session files belong under the user's data directory. No credentials are printed by source-session capture.

## Entry points

- `initialize-base.mjs`: read-only schema plan; `--apply` adds only missing fields in the 23-field portable schema, rejects existing type conflicts before creating fields, and verifies readback.
- `bootstrap-background.mjs`: creates only missing background targets up to ten through CDP, then verifies real background/account evidence; closes newly-created targets on failed verification. Unsupported CDP requires manually opening ten Buyin business tabs and leaving them in the background.
- `connect-browser.mjs`: explicit Chrome extension attachment to the named session; sets `saveSession:false`.
- `capture-source-session.mjs`: locally captures the user's already-authorized, unambiguous ChanMama tab.
- `koc-contact/run-koc-one-shot.mjs --mode list-integrated --target 500`: fresh source capture, then add-only Base synchronization.
- `koc-contact/run-daily-inventory.mjs --run`: processes verified pending inventory with up to ten background lanes.
- `koc-contact/readiness-live-server.mjs`: local readiness display, using actual probe/readback evidence.

Legacy one-off creator/record constants were replaced with disabled sentinels; they are not a source of authorization for this distribution. Use the generic daily flow. The business-specific pet/cat ranking scope and Base field schema are retained from the original runtime.

## Portability and safety

Commands prefer installed package JavaScript entrypoints launched with Node. Every browser program uses a private `--filename` file rather than command-line source text, avoiding the Windows command-line length ceiling; synchronous and asynchronous completion remove the file. Source capture respects `CHROME_PATH`, with the installed Chrome channel as its fallback. Windows npm `.cmd` shims are resolved to their JavaScript target with argument arrays, never shell concatenation. The template URL uses the canonical Buyin profile route and no author `/tmp` file. Serialized browser programs embed the configured shop marker.

The source hashes and manifest pin cover the runtime dependency closure. The process lock, source verification, fixed business field allowlists, bounded retry, five-minute rate-limit recovery, unknown-write stop, and verified readback gates remain intact. Windows has no POSIX private permission bits: mode-bit comparisons apply on Unix; Windows deployment must put the data directory behind a private user ACL. Path-boundary, regular-file, and symlink checks remain enabled on Windows.

## Validation

Run from the repository root: `npm run test:runtime`. The 34 offline tests cover real copied inventory logic (including 73 objects, resume, cooldown, unknown writes and readback), readiness routes and projections, explicit route enforcement, shell-free Windows shim resolution with special characters, serialized page configuration, all release hashes, Chrome launch configuration, additive Base initialization, background target provisioning, and actual subprocess transport of a program exceeding 200,000 characters. No live browser/tenant action is performed by these tests. Windows-native and real-tenant behavior requires the Windows CI and user-authorized live acceptance; a macOS test pass is not evidence of a Windows live run.

Regenerate after source edits with `node runtime/koc-contact/update-runtime-release.mjs --write`; review source changes before updating pins.

## Change Log

| Date | Change |
|---|---|
| 2026-10-08 | Added fresh Base/background bootstrap, configured Chrome launch, private file transport for large programs, configured Base links, and removed remaining author target defaults. |
| 2026-10-08 | Bundled portable runtime; parameterized account, tenant, session and storage; added safe Windows process launch, fresh-session bootstrap and offline regression coverage. |
