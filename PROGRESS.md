# Implementation Progress

## Status: [Iteration 6 complete — concurrent downloads]
Last Updated: 2026-05-01
Version: 0.7.0

## Honest Summary
Previous progress notes overstated the state. As of now the plugin is a clean
**UI shell with mocked data**. There is no real MEGA.nz auth, listing, or
download. The Python backend is a stub. Iteration 1 focused on cleaning up the
UI and laying a single integration seam (`MegaApiClient` in `mega_import.js`)
so the real backend work can land without further frontend churn.

## Iteration 1 — Done
- [x] Plugin loads, navbar button appears
- [x] Modal is login-only (removed File Browser / Results tabs)
- [x] `/mega-browser` is the single browsing surface; old duplicate mocks removed
- [x] Login state shared via `MegaApiClient` singleton + `useSession` hook
- [x] Unauthenticated visit to `/mega-browser` redirects home and pops the login modal
- [x] Disconnect button on browser page (in addition to Back to Stash)
- [x] Consistent `[mega-import]` error logging + user-visible `Alert`/toast on every catch
- [x] CSS dead-code (modal tab styles, `.file-browser` height) removed

## Iteration 2 — Done
Architectural decisions:
- **Backend**: MEGAcmd subprocess wrapper (chosen over `mega.py` for being officially maintained).
- **Bridge**: `runPluginTask` GraphQL mutation + `findJob` polling. Result transported through `Job.error` with `OK:`/`ERR:` prefix because Stash doesn't expose plugin-task stdout to the frontend.
- **Default import target**: `mega_imports/` (relative to Stash CWD), overridable via `MEGA_IMPORT_DEST` env var.

Done:
- [x] `mega_import.py` rewritten as MEGAcmd wrapper (login/logout/list/download/whoami/check)
- [x] Stdin/stdout JSON protocol with auto-detected standalone vs. Stash envelopes
- [x] `mega_import.yml` simplified to single `MEGA Operation` task; CSP block removed (no browser-side MEGA traffic)
- [x] JS `MegaApiClient._runTask` real bridge: mutation → poll → decode envelope
- [x] Apollo client captured into client via `ApolloCapture` component
- [x] `metadataScan` triggered automatically after successful download
- [x] `sessionStorage` persistence so `/mega-browser` survives page refresh
- [x] README rewritten with architecture diagram, MEGAcmd install instructions, troubleshooting

Verification still owed (user-side, can't be done from this environment):
- [ ] Install MEGAcmd, run `echo '{"action":"check"}' | python mega_import.py` — should report a version
- [ ] Real login → list `/` → import a small file → confirm it lands in `mega_imports/` and Stash scans it
- [ ] Confirm `mega-ls -l` output parsing on the user's MEGAcmd version (parser is best-effort)

## Iteration 3 — Done
- [x] User-configurable destination folder via collapsible Settings panel (localStorage-persisted, passed through to backend `download` action)
- [x] File-type filter dropdown (All / Videos / Images / Custom comma-separated extensions); empty-state message when filter hides everything
- [x] Select-all-visible / Clear-selection toolbar buttons
- [x] Python unit tests (`test_mega_import.py`) — 19 tests covering ls parser, path normalization, dispatch, MEGAcmd-missing path, list parsing+sorting, download dest+per-file status, Stash envelope. All green.

## Iteration 4 — Done
- [x] **Folder selection + recursive import** — folders now show a checkbox; selecting a folder downloads it recursively via `mega-get`. In browse mode, clicking the row name still navigates into the folder; in search mode, clicking selects.
- [x] **Search** — new backend `find` action wraps `mega-find` (with positional-pattern fallback for older MEGAcmd versions). Frontend gets a search bar in the toolbar; results replace the file list with full paths shown.
- [x] **Import history** — localStorage-backed (`HistoryStore`), capped at 500 entries. Collapsible History panel with timestamps + status. "Previously imported" green checkmark badge + green left-border on file rows for paths in the history.
- [x] Tests expanded to 23 (added 4 for `find`: missing query, parsing, fallback path, non-path-line skipping).

## Iteration 5 — Done
- [x] **Per-file chunked downloads** — `MegaApiClient.downloadFiles` now dispatches one task per file instead of one task for the whole batch. Trade-off: ~250 ms polling overhead per file, but the UI shows live progress.
- [x] **Live progress bar + counter** in MegaBrowserPage — "Importing N / M — /current/path" with a red MEGA-themed progress bar.
- [x] **Cancel button** replaces the Import button while in flight. Uses `AbortController`; honored between files (not mid-`mega-get`). Cancelled imports are recorded in history with whatever's already been completed.
- [x] **History filter** — text input + status dropdown (All / Successful / Failed) on the History panel. Header shows "filtered count of total".
- [x] Live import history: each completed file is recorded immediately, so the green "previously imported" indicator appears in real time during long imports.

## Iteration 6 — Done
- [x] **Concurrent downloads** — `MegaApiClient.downloadFiles` replaces the serial for-loop with an N-worker promise pool. Workers pull from a shared index, dispatch their `_runTask` independently. Capped at MAX_CONCURRENCY (5).
- [x] **Concurrency setting** — dropdown in the Settings panel (1 sequential / 2 / 3 / 4 / 5). Default 3. Persists in localStorage.
- [x] **Progress shows in-flight count** — "Importing 12 / 50 (3 in flight) — /current/file" so users see the parallelism is happening.
- [x] **Cancel still correct** — workers check `signal.aborted` before grabbing next file. In-flight tasks finish naturally (mid-file cancel needs subprocess kill, out of scope), but no NEW work starts. Result still flagged `cancelled: true`.

## Iteration 7+ — Planned
- [ ] Subscription-based job notification (replace polling, cuts ~250 ms × N overhead)
- [ ] Mid-file cancel (would require killing the `mega-get` subprocess from Python)
- [ ] Import scheduling
- [ ] Migrate destination folder to a Stash-native plugin setting
- [ ] Verify Stash actually parallelizes plugin tasks (if it serializes, JS-side concurrency provides only progress benefit, not speed)

## Known Issues
- `mega-ls -l` output parsing is best-effort; column widths vary across MEGAcmd versions and locales. May need `--time-format` tuning or refactor to use `--show-handles`.
- File sizes are passed through as MEGAcmd display strings (`1.5M`, `2.2 KB`) rather than parsed to bytes. Fine for display; bad for sorting by size.
- Bridge polls `findJob` every 250 ms — adds latency on top of MEGAcmd round trips. Subscription-based notification would be cleaner.
- Concurrent MEGA tasks share one MEGAcmd daemon — second login would clobber the first. UI prevents this naturally but it's not enforced.

## Cross-References
- [README.md](README.md)
- [INSTALL.md](INSTALL.md)
- [TECHNICAL.md](TECHNICAL.md)

## Changelog
- v0.7.0 (2026-05-01) — Iteration 6: concurrent downloads (1-5 in-flight), in-flight progress counter, configurable concurrency
- v0.6.0 (2026-05-01) — Iteration 5: per-file progress, cancel, history filter, live history updates
- v0.5.0 (2026-05-01) — Iteration 4: folder selection + recursive import, search via mega-find, import history with already-imported indicator
- v0.4.0 (2026-05-01) — Iteration 3: settings panel, file-type filter, select-all/clear, 19 Python unit tests
- v0.3.0 (2026-04-30) — Iteration 2: real MEGAcmd backend + GraphQL bridge + metadataScan + sessionStorage
- v0.2.0 (2026-04-30) — Iteration 1: UI cleanup + integration seams; honest progress
- v1.0.0 (2024-03-22) — Initial scaffold (overstated as "complete" — see honest summary above)
