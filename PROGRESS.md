# Changelog

## v1.5.1 — 2026-06-07

### Added
- Import **History** now has a **State** column — a coloured chip showing each entry's state (Done / Failed / Paused / Cancelled / …), so paused and cancelled items are clearly distinguished rather than all looking like failures.

## v1.5.0 — 2026-06-07

Per-file download controls: pause, resume, and cancel each file in the queue.

### Added
- **Per-file Pause / Resume / Cancel.** Each file in the import has its own ⏸ / ▶ / ✕ buttons.
  - **Pause** stops that file mid-download but keeps its partial blob → **Resume** continues from the exact byte where it stopped (via the v1.4.0 resumable engine), no data lost.
  - **Cancel** stops it and discards the partial.
  - Resume also retries a failed/cancelled file.
  Implemented cooperatively: a new `queue_control` action sets a per-item flag the detached worker polls between download chunks (~every 1.5 s), so it stops cleanly at a 16-byte boundary with the partial flushed. A pending (not-yet-started) item is updated directly. New action: `queue_control {id, op}`.
- The progress panel now renders the **actual per-file queue items** (not the pre-expansion selection), each carrying its queue id + MEGA handle. `temp_progress` reports partial blobs with their `handle`, so each row's real-byte progress is matched **exactly** to its partial (no more heuristic guessing).
- The panel stays **live after the import call returns** (polls `queue_status`), so a paused row reflects state when you resume it.

## v1.4.0 — 2026-06-07

Resilient downloads: an interrupted transfer resumes from where it stopped, and the queue heals itself after a crash/restart.

### Added
- **Byte-level resumable downloads** (`_resumable_download`). mega.py can't resume an interrupted file — it restarts from zero and discards the bytes. We now decrypt the AES-CTR stream ourselves (CTR is position-independent) and keep a **deterministic partial blob per file** at `<tmp>/mega_partials/<handle>.part`. On the next attempt — retry, re-import, or queue self-heal — it **resumes from the partial via an HTTP `Range` request** (MEGA returns `206`) at the last full 16-byte block, so no downloaded data is lost. Verified byte-identical to mega.py's full output, and a seeded half-partial reproduces the exact file. Works whether the stop was clean (manual/network/throttle) or a hard kill — resume aligns down to a 16-byte boundary, so a torn tail is just re-fetched. The partial is flushed to the OS every 16 MB so a hard kill keeps (nearly) the latest bytes. This also **retires the unreliable mega.py MAC check** (and its `/tmp` rescue) — CTR decryption is correct by construction.
- **Self-healing queue.** If the worker is killed mid-import (restart / reboot / crash), any stale `downloading` item is requeued and the worker respawns automatically on the next `queue_status` poll or `enqueue` — the queue resumes on its own, and the interrupted file resumes from its partial.
- **Server-side orphan cleanup.** The worker prunes `megapy_*` temps, staging leftovers, and partial blobs older than 1 h on startup (active downloads keep a fresh mtime, so they're never touched) — cleanup happens even with the browser closed, not only when the UI polls `temp_progress`.
- New env var: `MEGA_PARTIALS_DIR` (resumable-download partial blobs).

## v1.3.0 — 2026-06-07

Big reliability + scale release: large imports can't freeze the host or stop when you close the tab, and huge accounts browse instantly. Also verified on a native Windows Stash (Python 3.11), not just Alpine Docker.

### Added
- **Background download queue (survives the browser).** Stash kills a plugin subprocess the moment the client disconnects (verified), so a synchronous download died when you closed the tab. Imports now `enqueue` files to a JSON queue processed by a **detached worker process** (Windows `DETACHED_PROCESS`/`CREATE_NEW_PROCESS_GROUP`, POSIX `start_new_session`) that Stash can't kill — downloads keep running with the tab closed. When the queue drains, the worker registers the destination as a library path and triggers a scan via Stash's GraphQL (using the plugin's `server_connection`), so imports appear without any UI. New actions: `enqueue`, `queue_status`, `queue_clear`; the JS import flow enqueues then polls status. Metadata enrichment (auto-tag / identify / generate) still runs in the browser when it's open.
- **SQLite tree index.** The account tree is ingested **once** into a local SQLite file (keyed by `sid`, 24 h TTL) instead of a flat-JSON blob re-parsed on every call. Each list/find/download answers from indexed queries touching only the needed rows. Measured on a **724k-node / 12 TB** account: per-folder navigation **6.7 s → ~85 ms (root) / ~15 ms (subfolders)**, ~80×. Recursive folder sizes/counts precomputed at ingest; search is an indexed `LIKE`; ingest serialized across processes (flock) + atomic publish (`.building` → `os.replace`). The MEGA API can't list a folder server-side, so the one-time fetch is unchanged — just paid far less often (`MEGA_TREE_TTL`, `MEGA_TREE_DB`).
- **Anti-NFS-saturation batch import.** When the destination is a network filesystem, downloads land in a **local staging dir** and are **published serialized + fsync-paced** (one cross-process writer via `fcntl.flock`, 16 MB chunks, `os.fdatasync` every 128 MB, atomic `.part` → `os.replace`). Bounds kernel dirty pages → no writeback burst → no iowait storm. Auto-detected from `/proc/mounts`; local-disk dests keep the direct fast path. POSIX-only primitives guarded so the module still runs on Windows/macOS. See [TECHNICAL.md](TECHNICAL.md) and `mega-import-batch-redesign.md`.
- **Backpressure** so parallel downloads can't outrun the publisher and fill the local disk (`MEGA_MAX_STAGED_BYTES`, default 8 GB).
- **File-level resume**: a complete file already at the destination (size matches) is skipped, so re-running an interrupted import is idempotent.
- **Retry with exponential backoff** for transient download/publish failures (`MEGA_DOWNLOAD_RETRIES`, default 3).
- **Persistent login + silent restore.** Session token stored in `localStorage` (was `sessionStorage`, wiped on tab close) and re-established server-side from the token on load — no re-prompt, no re-solving the PoW. Only prompts if the token is rejected; a fresh login replaces the token.
- New env vars (see [TECHNICAL.md](TECHNICAL.md)): `MEGA_HASHCASH_THREADS`, `MEGA_DOWNLOAD_RETRIES`, `MEGA_STAGING`, `MEGA_STAGING_DIR`, `MEGA_MAX_STAGED_BYTES`, `MEGA_PUBLISH_CHUNK`, `MEGA_PUBLISH_FSYNC_EVERY`, `MEGA_PUBLISH_BWLIMIT`, `MEGA_TREE_TTL`, `MEGA_TREE_DB`, `MEGA_SESSION_FILE`, `MEGA_QUEUE_FILE`.
- 12 new backend unit tests (staging decision, NFS detection, paced publish, SQLite index ingest/resolve/children/collect/freshness) — **66 total**.

### Changed
- **`download` uses a stall guard instead of a wall-clock timeout.** As long as bytes keep arriving, the download never times out — a multi-GB file on a slow link can take hours. It aborts only after ~3 min of *zero* new data (tunnel dropped / throttled to zero); the idle timer resets on every byte. (`_runTask` gained a `timeoutMs` override.) Backend keeps running past an abort + resume, so aborting is safe.
- **Default download concurrency 3 → 1** (safe for NFS dests; writes are serialized regardless). `MAX_CONCURRENCY` stays 5.
- **Hashcash PoW solver uses all logical CPUs** (was capped at 8) + logs solve time/threads; stderr is line-buffered so progress shows live.
- `list`/`find`/`preview` UI timeout 5 → 15 min so the one-time tree fetch+ingest can't time the UI out mid-ingest.
- Server-side state files use `tempfile.gettempdir()` instead of a hardcoded `/tmp` (works on Windows/macOS; still `/tmp` on Linux). Tree cache moved from flat JSON to SQLite.
- `cleanup_temp` also clears staged-but-unpublished orphans.

### Fixed
- **Non-ASCII paths** (emoji/accented folder names, e.g. `🔞 SiteRip`) returned "Path not found": stdin is now read as UTF-8 instead of the Windows locale codec (cp1252), which mangled the path before the DB lookup.
- **Emoji rendered as tofu boxes**: emoji-capable font stack (Segoe UI Emoji / Apple Color Emoji / Noto Color Emoji), incl. a fallback on `monospace` text. System fonts only — offline-safe, scoped to the plugin.
- **Session didn't persist on Windows/macOS**: the session file silently failed to save under a non-existent `C:\tmp`; now uses the real temp dir.
- **Disconnect button** could appear dead: `logout()` clears local state immediately and runs server cleanup in the background; the page no longer re-pops the login modal the instant you disconnect.

## v1.0.0 — 2026-05-02

First stable release. Fully reworked from the v0.x prototype line.

### Added
- Tile-grid file explorer with breadcrumbs, dark theme, double-click navigation
- Per-folder localStorage cache with stale-while-revalidate (1 h TTL)
- Server-side full-tree cache in `/tmp/.mega_files_cache.json` (1 h TTL)
- Folder import preview modal with per-file and per-extension exclusion
- Folder-name parser → suggested tags / performers / studio / title in preview
- Post-import bulk metadata application with auto-create of missing tags / performers / studios
- Optional gallery creation from imported images
- Auto-pipeline: `metadataScan` + `metadataAutoTag` + `metadataIdentify` (TPDB / StashDB) toggles
- Real-byte progress bars sourced from `/tmp/megapy_*` polling every 2 s
- Size-aware per-file download timeouts
- mega.py MAC-mismatch workaround — recovers the orphan temp file when the library's integrity check trips
- Filename slugification (UTF-8 / emoji / special-char safe)
- Default destination `~/.stash/mega_imports/`, auto-added to Stash library paths via `configureGeneral`
- Hashcash PoW solver (multithreaded SHA-256, GIL release exploited)
- Session token persistence with mega.py uint32-list master-key support
- Stash stashbox configuration helpers (TPDB + StashDB)
- Stale-response dropping in browser (no more old `list` results overwriting current view)
- Single-click select / double-click navigate / Enter to open
- Cleanup actions: server temp files + browser path cache (manual buttons in Settings)
- Settings panel grouped: Stash integration / Downloads / Browser display / Cache
- 54 backend unit tests

### Changed
- Backend rewritten from MEGAcmd subprocess wrapper → direct `mega.py` library
- GraphQL bridge moved from `runPluginTask` + `findJob` polling → synchronous `runPluginOperation`
- Default install destination moved from `<plugin_dir>/mega_imports/` → `~/.stash/mega_imports/`
- Plugin now uses `pycryptodome` instead of unmaintained `pycrypto` (mega.py's declared dep won't build on modern Python)

### Fixed
- `Job N disappeared` race that plagued v0.x
- Multiple races in concurrent download dispatch
- Folder click registering wrong target after sort/filter changes
- Path cache leaking across user logouts

### Documentation
- New [INSTALL.md](INSTALL.md) with prerequisites, ops, debugging, full roadmap
- New [TECHNICAL.md](TECHNICAL.md) with architecture, action protocol, Hashcash details
- README rewritten for v1.0.0
- Sample IPs in install scripts switched to RFC docs (no real personal data in repo or history)

---

## v0.x — historical (2024-2026)

The v0.x line was a series of iterations on a MEGAcmd-based backend. Replaced wholesale by v1.0.0:

- v0.7.0 — concurrent downloads (1-5 in flight)
- v0.6.0 — per-file progress, cancel button, history filter
- v0.5.0 — folder selection + recursive import, search, import history
- v0.4.0 — settings panel, file-type filter, 19 unit tests
- v0.3.0 — MEGAcmd backend + GraphQL bridge + metadataScan + sessionStorage
- v0.2.0 — UI cleanup + integration seams; honest progress note
- v0.1.0 — initial scaffold (UI shell with mocked data)

See git history for the full picture if you need it.
