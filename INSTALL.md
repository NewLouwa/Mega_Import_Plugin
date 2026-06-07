# MEGA Import Plugin — Install & Operations Guide

> ## ⚠ Status: tested on Alpine Docker + native Windows
>
> Developed and exercised against `stashapp/stash:latest` (Alpine, Python 3.12) in Docker, and also against a **native Windows Stash (`stash-win.exe` v0.31.1, Python 3.11)**. **Other configurations (bare-metal Linux, non-Alpine containers, macOS, NixOS, etc.) are unverified.** It should work — pure Python + JS, no native deps beyond what `mega.py` and `pycryptodome` need — but you may need to adapt the install steps. On Windows, point the plugin's `exec` at a real Python (not the Microsoft Store alias) and install the deps into it.
>
> The plugin is provided **as-is, with no warranty**. Test against a non-critical Stash instance first. Bug reports / PRs welcome via GitHub issues; please include your Stash version, the exact `python --version` of the runtime that runs the plugin, and any `[mega-import]` log lines (`docker logs stash` on Docker, or the Stash log on bare installs).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Stash** | `>= 0.25` (tested through `0.31.1`) | Older versions don't have `runPluginOperation` |
| **Python** | `3.8+` (3.10 recommended; **3.12 works on Alpine**) | Plugin runs as Stash subprocess |
| **`pip` packages** | `mega.py`, `tenacity>=8.0`, `requests`, `urllib3` | Installed automatically by `install.sh` |
| **Network access from Stash host** | Outbound HTTPS to `g.api.mega.co.nz`, `mega.nz`, etc. | MEGA throttles aggressively without an account |
| **A MEGA account** | Free or Pro | Pro is much faster; free downloads cap around ~5 GB/day |

### Known compatibility quirks

- **Alpine + musl**: `mega.py` depends on `pycrypto` (unmaintained) which can't build on modern Python. The plugin avoids this — at runtime we use `pycryptodome` instead, which provides the same `Crypto.*` namespace. `install.sh` handles this on most distros, but on a clean Alpine container you may need:

  ```sh
  apk add py3-cryptography
  pip install --break-system-packages "tenacity>=8.0" pycryptodome
  pip install --break-system-packages --no-deps mega.py
  ```

- **Hashcash proof-of-work**: MEGA's API returns HTTP 402 on first login and demands a SHA-256 PoW (~12 MB buffer hashed millions of times). The plugin solves it in pure Python with multi-threaded `hashlib` (which releases the GIL for large updates). On a 4-core box this takes 2–5 minutes the first time. The session token is then cached so subsequent logins skip it.

- **MAC verification bug in `mega.py`**: many files trip a false-positive `Mismatched mac` error after a successful download. The plugin recovers automatically — finds the orphan temp file in `/tmp/megapy_*` matching the expected size, moves it into place, marks the row as `✓ (mac-skipped)`. The bytes are correct in 99 % of cases.

## Installation

### 1. Clone

```sh
git clone https://github.com/NewLouwa/Mega_Import_Plugin.git
cd Mega_Import_Plugin
```

### 2. Run the installer

**Local Stash on Linux/macOS/WSL**:

```sh
./install.sh                 # auto-detect ~/.stash/plugins
./install.sh /custom/path    # explicit
```

**Remote Stash over SSH** (rsync if available, scp fallback):

```sh
STASH_HOST=user@host ./install.sh
STASH_HOST=user@host STASH_PLUGINS=/var/lib/stash/plugins ./install.sh

# With jump host / custom port / specific key
STASH_HOST=root@stash.example.org SSH_OPTS="-J root@jump.example:2222 -i ~/.ssh/id_ed25519" ./install.sh
```

**Windows host installing to remote Stash**:

```powershell
.\install.ps1
```

The installer:
- Runs `python -m unittest test_mega_import` first — refuses to deploy if tests fail
- Installs/upgrades `mega.py` and `tenacity>=8.0` on the target
- Copies `mega_import.{js,css,py,yml}` + `manifest` + `README.md` + `PROGRESS.md`

### 3. Reload plugins in Stash

```
Settings → Plugins → "Reload Plugins"
```

Or via GraphQL:

```sh
curl -X POST http://localhost:9999/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { reloadPlugins }"}'
```

### 4. Verify

A red MEGA logo appears in the navbar (top-right). Click it to log in.

## First-time configuration

### Login

Two modes:
- **Email + password**: solves Hashcash PoW (~3 min wait), then shows your **session token** — copy it somewhere safe.
- **Session token**: instant login on subsequent runs.

### Default destination

Imports land in `~/.stash/mega_imports/` — a subfolder of Stash's config dir, which:
- Always exists on every Stash install
- Is in your Docker volume mount (so it persists)
- Gets **auto-added to Stash's library paths** on first import (toggle in Settings)

You can override it per-import via Settings → Import destination.

### Auto-pipeline (Settings → Stash integration)

By default each successful import triggers:
1. `metadataScan` on the destination
2. `metadataAutoTag` (filename → existing performers/tags/studios)
3. `metadataIdentify` against TPDB + StashDB stashboxes (scenes only)

Toggle any off if you don't want it. Configure stashbox API keys under **Stash → Settings → Metadata Providers**.

## Operational notes

### Caches

| Cache | Where | TTL | Why |
|---|---|---|---|
| Full MEGA tree | `<tmp>/.mega_tree.sqlite` (server, SQLite index) | 24 h | `mega.py.get_files()` fetches the entire account tree (slow on multi-TB accounts); indexed once so each list/find/download is an indexed query, not a full re-parse |
| Per-folder listing | `localStorage` `mega-import:path-cache` (browser) | 1 h since last use | Stale-while-revalidate so navigation feels instant |
| Session token | `/tmp/.mega_session.json` (server) | until logout | Skips the 3-min Hashcash PoW |

Clear them via Settings panel buttons or `Disconnect`.

### Temp files

`mega.py` writes downloads to `/tmp/megapy_<random>` then moves to dest. Failed/orphaned temps accumulate. The plugin auto-prunes anything older than 1 h on every progress poll, plus there's a manual **"Clean server temp files"** button in Settings.

### Per-file timeouts

| Action | Timeout |
|---|---|
| `login` | 10 min (Hashcash) |
| `list` / `find` / `preview` | 15 min (covers the one-time tree fetch + index ingest) |
| `download` | **no wall-clock timeout** — a stall guard aborts only after ~3 min of zero new bytes (see below) |

Downloads now run in the **background queue** (`enqueue`), and the UI polls `queue_status`. The download itself uses a *stall guard*, not a fixed timeout: it keeps running as long as the temp file is growing and aborts only after a stretch of no new data (tunnel dropped / MEGA throttled to zero). The detached worker survives a closed tab; an interrupted file resumes from its partial blob (byte-level), and already-complete files are skipped on re-run.

### Concurrency

The background worker downloads **sequentially** (NFS-safe). The UI's `concurrency` setting (default 1, cap `MAX_CONCURRENCY = 5`) is retained for the legacy direct-download path; NFS writes are serialized server-side regardless.

## Debugging

### Server-side logs

```sh
docker logs stash 2>&1 | grep '\[mega-import\]'
```

You'll see: `tree fetched`, `cache hit`, `downloading <path> → <target>`, `MAC failed but rescued temp file → ...`, etc.

### Inspect in-flight downloads

```sh
docker exec stash ls -lah /tmp/megapy_*
docker exec stash ls -lah /root/.stash/mega_imports/
```

### Browser-side logs

DevTools console — every line prefixed `[mega-import]`. Includes: render with session, loadPath start/ok/stale, `_runTask` request/response, error context.

### Run tests

```sh
python -m unittest test_mega_import
```

66 tests, all should pass. Covers MEGA base64, Hashcash threshold, parse-header, `_gencash` (rebuilds the 12 MB buffer + verifies SHA-256), session token round-trip in both `bytes` and `uint32-list` shapes, the SQLite tree index (ingest/resolve/children/collect/freshness), NFS detection, and the fsync-paced publish.

## Roadmap (post-v1)

Shipped since v1.0.0 (see [PROGRESS.md](PROGRESS.md)): ✅ **background download queue** (detached worker survives a closed tab), ✅ **byte-level resumable downloads** (custom AES-CTR + HTTP Range), ✅ **SQLite-indexed browsing**, ✅ **anti-NFS-saturation staging**, ✅ **stall-based download timeout**, ✅ **bandwidth cap** (`MEGA_PUBLISH_BWLIMIT`).

Still deferred:

| Feature | Why not yet | Effort |
|---|---|---|
| **Real per-file MEGA progress** (instead of temp-file size polling) | Would require monkey-patching `mega.py.download_file` to report chunk-level progress to a status file. Current polling is good enough; tilde marker (`~`) shows when bar is estimated vs measured. | M |
| **Parallel downloads in the background worker** | The detached worker is sequential (NFS-safe). NFS writes are already serialized via the publish lock, so the worker could run N downloads in parallel; needs per-item progress + careful backpressure. | M |
| **Incremental tree sync** | First browse fetches the full account tree (MEGA sends it all at once). MEGA exposes a sequence number (`sn`) for deltas; persisting the index and syncing only changes would avoid the periodic full fetch. | M |
| **Group/series creation from a folder of scenes** | UI hook is in the preview modal but the plumbing isn't wired (Stash's `Group` entity needs explicit member ordering, which we'd have to infer from filenames). | S |
| **LocalVisage face recognition** | Requires Python 3.10 + DeepFace + ~3 GB of ML deps; the official Stash Alpine image is on Python 3.12. Workaround: rebuild Stash on a `python:3.10-slim` Debian base (the LocalVisage repo ships a Dockerfile that does exactly this). Not part of this plugin. | L (new image, downtime) |
| **Multiple MEGA accounts** | Single session slot. Would need account picker UI + per-account session storage. | M |
| **Search filters: by size, by date, by extension globally** | Current "Search" is just `mega-find` with a glob pattern. Useful enhancement. | S |
| **Browser-side download (no server)** | Out of scope: Stash needs the bytes on its filesystem to scan them, so server-side is correct. | — |
| **Native progress callbacks via mega.py fork** | Same as above; would unlock real chunk-level progress without filesystem polling. | L |
| **Pure-JS rewrite — drop the Python backend entirely** | Use [`megajs`](https://github.com/qgustavor/mega) in the browser + a service worker / WebStream to push downloaded bytes to Stash via a small upload endpoint (or use a Stash plugin task purely as a write-to-disk bridge). Eliminates the Python interpreter dependency, the `pycrypto`/`pycryptodome` mess, and the Hashcash thread pool. Trade-off: browser tab must stay open during downloads, and the bytes round-trip through the user's bandwidth (browser → Stash). Worth it on small-account installs; bad for multi-TB. | XL |

## Architecture quick-reference

```
Browser (mega_import.js)
  ├── PluginApi.register.route("/mega-browser", MegaBrowserPage)
  ├── PluginApi.patch.before("MainNavBar.UtilityItems", …)
  └── Apollo client → Stash GraphQL
        └── runPluginOperation(plugin_id="mega_import", args={action, …})
              │
              ▼
Stash → spawns Python subprocess → mega_import.py
  ├── action_login         (Hashcash PoW solver; session ← token)
  ├── action_list / find   (SQLite tree index — indexed query)
  ├── action_preview       (folder expansion + by-ext stats)
  ├── action_enqueue       (expand → queue → spawn DETACHED worker) ──┐
  ├── action_queue_status  (poll for UI progress)                     │
  ├── action_queue_clear   (cancel pending)                           │
  ├── action_download      (synchronous fallback: mega.py → dest)     │
  ├── action_temp_progress / cleanup_temp / logout / check / whoami   │
  └── __worker (detached, NOT killed on disconnect) ◄─────────────────┘
        └── loop: claim pending → _download_one (stage→publish) → mark done
            on drain → add library path + metadataScan (via server_connection)

  ↳ request actions write JSON `{"output": …, "error": …}` to stdout
```

State files (in the host temp dir; `/tmp` on Linux, `%TEMP%` on Windows):
- `.mega_session.json` — `{sid, master_key}` (uint32 list or raw bytes)
- `.mega_tree.sqlite` — full file tree, indexed (auto-expires after 24 h)
- `mega_queue.json` (+ `.worker.log`) — background download queue + worker output
- `mega_stage/` — local staging dir for NFS-safe publish (network dests only)
- `megapy_*` — in-flight or orphaned downloads

Browser localStorage:
- `mega-import:session` — `{email, sessionToken}` (cross-reload hydration)
- `mega-import:settings` — UI prefs (concurrency, sort, page size, toggles)
- `mega-import:history` — past imports (success/fail/path/dest/timestamp)
- `mega-import:path-cache` — per-folder listings (1 h since last use)

## Contributing

PRs welcome. Please:

1. Run `python -m unittest test_mega_import` and add a test for any new backend action
2. Check the browser console — every error path must `console.error` with a `[mega-import]` prefix and include the original exception
3. Bump `mega_import.yml`'s `version` field for any user-visible change
4. Update this doc and `PROGRESS.md` if you finish a roadmap item
