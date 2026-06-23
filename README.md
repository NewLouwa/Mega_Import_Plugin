# MEGA Import Plugin for Stash

Browse your MEGA.nz cloud storage from inside Stash, pick files or whole folders, and have them downloaded onto the Stash server, scanned into your library, auto-tagged, and identified — all without leaving the UI. Built to handle huge accounts and large imports without freezing the host or stopping when you close the tab.

> ⚠ **Developed against Alpine Docker (`stashapp/stash:latest`, Python 3.12); also exercised on a native Windows Stash (Python 3.11).** Pure Python + JS, no native deps beyond what `mega.py`/`pycryptodome` need. Other configurations are unverified. Provided as-is. See [INSTALL.md](INSTALL.md) for the full disclaimer + ops guide.

## Features

- **Tile-grid file explorer** with breadcrumbs, dark theme, double-click to navigate, single-click to select
- **SQLite tree index** — the account tree is ingested once, then every folder click is an indexed query (~ms). Scales to **hundreds of thousands of files** (measured ~85 ms/click on a 724k-node account vs seconds before)
- **Background download queue** — imports run in a **detached worker that survives closing the browser tab**; on completion it auto-adds the destination to the library and triggers a scan, with no UI open
- **Per-file Pause / Resume / Cancel** — each file in the queue has its own controls; pause keeps the partial and resume continues from the exact byte (no data lost), cancel discards it
- **Anti-NFS-saturation** — on a network-filesystem dest, files download to local staging and are published serialized + fsync-paced so a big import can't drive the host into an iowait freeze
- **Stall-based download timeout** — never times out while bytes are flowing; aborts only after a stretch of zero new data (tunnel dropped / throttled to zero)
- **Resumable downloads** — a custom AES-CTR downloader keeps a partial blob per file, so an interrupted transfer **continues from where it stopped** (HTTP Range) instead of restarting; complete files are skipped on re-run; transient failures retry with backoff
- **Folder import preview** — file count, total size, breakdown by extension; uncheck individual files or extensions before downloading
- **Auto-recovery** from `mega.py`'s broken MAC integrity check (rescues the fully-downloaded temp file)
- **UTF-8 / emoji safe** — non-ASCII paths resolve correctly; an emoji-capable font stack renders names; filenames slugified safely for any filesystem
- **Post-import metadata** — bulk apply tags, performers, studio (auto-create missing entities); optional gallery; `metadataScan` + `metadataAutoTag` + `metadataIdentify` (TPDB / StashDB) pipeline
- **Persistent login** — session token stored in `localStorage` + silent server-side restore on load (no re-prompt, no re-solving the PoW); only prompts if the token is rejected
- **Hashcash PoW solver** in pure Python, multi-threaded across all cores — handles MEGA's first-login challenge, then session-cached (paid once)
- **73 unit tests** for the backend (base64, Hashcash, session round-trip, filename parsing, SQLite index, paced publish, NFS detection, queue state-machine)
- **Built-in Help page** — click the **?** button in the action bar for a collapsible reference covering the full workflow, keyboard shortcuts, progress states, settings, and troubleshooting, without leaving Stash
- **Progress rows show the filename**, not the full MEGA path — the basename is displayed in the queue so active downloads are always identifiable (full path visible on hover)
- **Cancel no longer jams the queue** — cancelling a downloading file takes effect immediately when the worker is unresponsive; a stuck `downloading` row can't keep the Import button disabled forever
- **Off-page stall recovery** — uses per-socket **(15 s connect, 60 s read)** timeouts so a half-open CDN connection fails fast, and 256 KiB chunks keep pause/cancel landing within seconds

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
[Browser]                  [Stash server]                         [MEGA.nz]
 React UI ──enqueue──> Stash ──spawns──> mega_import.py
   │                                       │ writes queue.json + spawns
   │                                       ▼
   │                              detached worker (survives tab close)
   │                                       │  mega.py ──HTTPS──> MEGA
   │ poll queue_status                     ▼
   └────────────────────────►  /tmp temp → (stage → publish) → mega_imports/
                                           │  on drain ↓ (Stash GraphQL)
                                           └─► add library path + metadataScan
                                                       │ (browser, if open)
                                                       ▼   autoTag + identify
```

All MEGA traffic is **server-side** — the browser only ever talks to Stash, and only to enqueue + poll. The **detached worker keeps downloading even if you close the tab**; when the queue drains it registers the dest as a library path and triggers a scan itself. Folder navigation is served from a local **SQLite index** of the account tree, so it stays instant on huge accounts.

## Architecture

| File | Role |
| --- | --- |
| [mega_import.js](mega_import.js) | React UI (navbar button, login modal, browser page, preview modal, progress UI) + GraphQL bridge (`MegaApiClient`); enqueues imports and polls queue status |
| [mega_import.py](mega_import.py) | Python backend: Hashcash solver, session persistence, mega.py wrapper, SQLite tree index, local-staging/paced publish, background download queue + detached worker, action dispatch, MAC-mismatch rescue |
| [mega_import.yml](mega_import.yml) | Stash plugin manifest. Single task `MEGA Operation` dispatched via `action` arg |
| [mega_import.css](mega_import.css) | Tile grid + dark theme + modal styling + emoji-capable font stack |
| [test_mega_import.py](test_mega_import.py) | 73 backend tests, no Stash or MEGA needed |
| [install.sh](install.sh) / [install.ps1](install.ps1) | Local + remote installers (rsync/scp fallback over SSH) |

The JS bridge uses **`runPluginOperation`** (synchronous Stash GraphQL mutation) to talk to the Python backend; each call spawns a fresh Python subprocess. Long-running downloads instead run in a **detached worker** spawned by `enqueue` that is *not* a child of the request (Stash kills request subprocesses on client disconnect), so they survive the UI. State persists in the host temp dir: a session JSON, a SQLite tree index, and the download queue JSON.

For deeper architecture (state files, browser localStorage keys, action list), see the **Architecture quick-reference** section in [INSTALL.md](INSTALL.md).

## Roadmap

Tracked in [INSTALL.md § Roadmap](INSTALL.md#roadmap-post-v1). Highlights of what's still deferred:

- Real per-file MEGA progress (instead of temp-file size polling)
- Parallel downloads in the background worker (currently sequential / NFS-safe)
- Incremental tree sync via MEGA sequence numbers (avoid the one-time full fetch)
- LocalVisage face-recognition integration (requires Python 3.10 image)
- Multiple MEGA accounts
- **Pure-JS rewrite** (drop the Python backend entirely, use a browser MEGA library)

Shipped since v1.0.0: ✅ background download queue (survives the tab), ✅ **byte-level resumable downloads**, ✅ SQLite-indexed browsing, ✅ **per-file pause/resume/cancel**, ✅ **queue robustness** (stuck-cancel fix, off-page stall recovery, filename in progress rows), ✅ **built-in help page**.

## Development

```sh
python -m unittest test_mega_import   # 73 tests, pure stdlib
node --check mega_import.js           # JS syntax check
```

## License

MIT. Not affiliated with MEGA.nz.
