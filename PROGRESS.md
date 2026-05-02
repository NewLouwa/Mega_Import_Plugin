# Changelog

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
