# Changelog

## v1.2.0 — Unreleased

Local SQLite tree index — large-account browsing goes from seconds-per-click to milliseconds.

### Added
- **Background download queue (survives the browser).** Stash kills a plugin subprocess the moment the client disconnects, so a synchronous download died when you closed the tab. Imports now `enqueue` files to a JSON queue processed by a **detached worker process** (Windows `DETACHED_PROCESS`, POSIX `start_new_session`) that Stash can't kill — downloads keep running with the tab closed. When the queue drains, the worker registers the destination as a library path and triggers a scan via Stash's GraphQL (using the plugin's `server_connection`), so imports appear without the UI. New actions: `enqueue`, `queue_status`, `queue_clear`; the JS import flow enqueues then polls status. Metadata enrichment (auto-tag / identify / generate) still runs in the browser when it's open.
- **SQLite tree index.** The full account tree is ingested **once** into a local SQLite file (keyed by `sid`, 24 h TTL) instead of a flat-JSON blob re-parsed on every call. Each list/find/download now answers from indexed queries that touch only the needed rows. Measured on a **724k-node / 12 TB** account: per-folder navigation **6.7 s → ~85 ms (root) / ~15 ms (subfolders)**, ~80×. Recursive folder sizes/counts are precomputed at ingest; search is an indexed `LIKE`; ingest is serialized across processes (flock) and published atomically (`.building` → `os.replace`). The MEGA API can't list a folder server-side (it sends the whole tree at once), so the one-time fetch is unchanged — but it's now paid far less often (`MEGA_TREE_TTL`, `MEGA_TREE_DB`).
- 5 new backend unit tests for the index (ingest, resolve, children+aggregates, recursive collect, freshness) — 66 total.

### Changed
- Tree caching moved from the flat-JSON `/tmp/.mega_files_cache.json` to `tempfile.gettempdir()/.mega_tree.sqlite`. `cleanup_temp` / re-login behaviour unchanged.
- Session/tree files now use `tempfile.gettempdir()` instead of a hardcoded `/tmp` (works on Windows/macOS; still `/tmp` on Linux).
- `list`/`find`/`preview` UI timeout raised 5 → 15 min so the one-time full-tree fetch+ingest (3-5 min on a large account) can't time the UI out mid-ingest.
- **`download` now uses a stall guard instead of a wall-clock timeout.** As long as bytes keep arriving (the `/tmp/megapy_*` temp file grows), the download never times out — a multi-GB file on a slow link can take hours. It aborts only after ~3 min of *zero* new data (tunnel dropped / throttled to zero); the idle timer resets to 0 on every byte of progress. (`_runTask` gained a `timeoutMs` override; download passes `0` to disable the fixed timeout.) Backend keeps running past an abort and file-level resume skips completed files, so aborting is safe.

### Fixed
- **Disconnect button** could appear dead: `logout()` now clears local state immediately and runs the server-side cleanup in the background, and the browser page no longer re-pops the login modal the instant you disconnect.
- **Non-ASCII paths** (emoji/accented folder names, e.g. `🔞 SiteRip`) returned "Path not found": stdin is now read as UTF-8 instead of the Windows locale codec (cp1252), which had mangled the path before the DB lookup.
- **Emoji rendered as tofu boxes**: the plugin now uses an emoji-capable font stack (Segoe UI Emoji / Apple Color Emoji / Noto Color Emoji), including a fallback appended to the `monospace` path/pill text. System fonts only — no download, offline-safe, scoped to the plugin.

## v1.1.0 — Unreleased

Batch-import hardening: a large import can no longer freeze an NFS-backed host.

### Added
- **Anti-NFS-saturation batch import.** When the destination is a network filesystem, downloads now land in a **local staging dir** and are **published to the dest serialized + fsync-paced** (one cross-process writer via `fcntl.flock`, 16 MB chunks, `os.fdatasync` every 128 MB, atomic `.part` → `os.replace`). Bounds kernel dirty pages → no writeback burst → no iowait storm. Auto-detected from `/proc/mounts`; local-disk dests keep the original direct fast path. POSIX-only primitives are guarded so the module still runs on Windows/macOS. See [TECHNICAL.md](TECHNICAL.md) and `mega-import-batch-redesign.md`.
- **Backpressure** so parallel downloads can't outrun the publisher and fill the local disk (`MEGA_MAX_STAGED_BYTES`, default 8 GB).
- Download **file-level resume**: a complete file already at the destination (size matches) is skipped, so re-running an interrupted multi-file import is idempotent and cheap.
- Download **retry with exponential backoff** for transient failures (`MEGA_DOWNLOAD_RETRIES`, default 3).
- New env vars (see [TECHNICAL.md](TECHNICAL.md)): `MEGA_HASHCASH_THREADS`, `MEGA_DOWNLOAD_RETRIES`, `MEGA_STAGING`, `MEGA_STAGING_DIR`, `MEGA_MAX_STAGED_BYTES`, `MEGA_PUBLISH_CHUNK`, `MEGA_PUBLISH_FSYNC_EVERY`, `MEGA_PUBLISH_BWLIMIT`.
- 7 new backend unit tests (staging decision, NFS detection, paced publish round-trip) — 61 total.

### Changed
- **Default download concurrency 3 → 1.** Safe out-of-the-box for NFS-backed dests; the backend serializes NFS writes regardless, so raising it again only affects download parallelism. `MAX_CONCURRENCY` stays 5.
- Hashcash PoW solver now uses **all** logical CPUs instead of capping at 8 threads (override with `MEGA_HASHCASH_THREADS`); logs solve time + thread count to stderr. Cuts first-login wait on hosts with >8 cores.
- `cleanup_temp` now also clears staged-but-unpublished orphans, not just `/tmp/megapy_*`.

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
