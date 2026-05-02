# MEGA Import Plugin for Stash

Browse your MEGA.nz cloud storage from inside Stash, pick files or whole folders, and have them downloaded onto the Stash server, scanned into your library, auto-tagged, and identified — all without leaving the UI.

> ⚠ **v1.0.0 is tested on Alpine Docker (`stashapp/stash:latest`, Python 3.12) only.** It should work elsewhere — pure Python + JS, no native deps — but other configurations are unverified. Provided as-is. See [INSTALL.md](INSTALL.md) for the full disclaimer + ops guide.

## Features

- **Tile-grid file explorer** with breadcrumbs, dark theme, double-click to navigate, single-click to select
- **Per-folder cache** in browser localStorage — instant navigation after the first visit (1 h TTL)
- **Folder import preview** — see file count, total size, breakdown by extension; uncheck individual files or whole extensions before downloading
- **Real-byte progress bars** sampled from the on-disk temp file every 2 s (with size-aware per-file timeouts)
- **Auto-recovery** from `mega.py`'s broken MAC integrity check — if the file size matches expected, the download is accepted
- **Filename slugification** — handles UTF-8, emoji, special chars; safe on every filesystem
- **Post-import metadata** — bulk apply tags, performers, studio (auto-create missing entities); optionally create a gallery
- **Auto-pipeline** after each import — `metadataScan` + `metadataAutoTag` + `metadataIdentify` (TPDB / StashDB) all wired in
- **Default destination** at `~/.stash/mega_imports/` — auto-added to Stash's library paths on first import
- **Configurable concurrency** (1-5 parallel downloads); per-action timeouts; cleanup actions for orphan temp files
- **Hashcash PoW solver** in pure Python — handles MEGA's first-login challenge (~3 min on a 4-core box, then session-cached)
- **54 unit tests** for the backend (base64, Hashcash, session round-trip, filename parsing, etc.)

## Quick start

```sh
git clone https://github.com/NewLouwa/Mega_Import_Plugin.git
cd Mega_Import_Plugin
./install.sh           # local install (auto-detects ~/.stash/plugins)
# Then in Stash: Settings → Plugins → "Reload Plugins"
```

A red MEGA logo appears in the top-right of Stash. Click it to log in.

For remote installs, Windows, prerequisites, and operations — see **[INSTALL.md](INSTALL.md)**.

## How it works

```
[Browser]                       [Stash server]                  [MEGA.nz]
  React UI  ──GraphQL──>  Stash  ──spawns──>  mega_import.py
   ▲                                              │
   │                                              ▼
   └──────────── status JSON ──────────  mega.py library  ──HTTPS──> MEGA
                                               │
                                               ▼
                                  /tmp/megapy_<rand>  ──move──>  ~/.stash/mega_imports/
                                                                       │
                                                                       ▼
                                                          metadataScan + autoTag + identify
```

All MEGA traffic is **server-side** — the browser only ever talks to Stash. Files land on the same machine that runs Stash; the auto-triggered scan picks them up instantly because the dest is auto-added to Stash's library paths.

## Architecture

| File | Role |
| --- | --- |
| [mega_import.js](mega_import.js) | React UI (navbar button, login modal, browser page, preview modal, progress UI) + GraphQL bridge (`MegaApiClient`) |
| [mega_import.py](mega_import.py) | Python backend: Hashcash solver, session persistence, mega.py wrapper, action dispatch, MAC-mismatch rescue |
| [mega_import.yml](mega_import.yml) | Stash plugin manifest. Single task `MEGA Operation` dispatched via `action` arg |
| [mega_import.css](mega_import.css) | Tile grid + dark theme + modal styling |
| [test_mega_import.py](test_mega_import.py) | 54 backend tests, no Stash or MEGA needed |
| [install.sh](install.sh) / [install.ps1](install.ps1) | Local + remote installers (rsync/scp fallback over SSH) |

The JS bridge uses **`runPluginOperation`** (synchronous Stash GraphQL mutation) to talk to the Python backend. Each call spawns a fresh Python subprocess. State is persisted via `/tmp/.mega_session.json` and `/tmp/.mega_files_cache.json` so successive calls reuse session + cached file tree.

For deeper architecture (state files, browser localStorage keys, action list), see the **Architecture quick-reference** section in [INSTALL.md](INSTALL.md).

## Roadmap

Tracked in [INSTALL.md § Roadmap](INSTALL.md#roadmap-post-v1). Highlights of what's deferred to a future release:

- Backend job-queue so closing the browser tab doesn't pause the queue
- Real per-file MEGA progress (instead of temp-file size polling)
- LocalVisage face-recognition integration (requires Python 3.10 image)
- Resumable downloads
- Multiple MEGA accounts
- **Pure-JS rewrite** (drop the Python backend entirely, use a browser MEGA library)

## Development

```sh
python -m unittest test_mega_import   # 54 tests, pure stdlib
node --check mega_import.js           # JS syntax check
```

## License

MIT. Not affiliated with MEGA.nz.
