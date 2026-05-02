# MEGA Import Plugin — Install & Operations Guide

> ## ⚠ Status: tested on Alpine docker container only
>
> v1.0.0 has been developed and exercised against `stashapp/stash:latest` (Alpine, Python 3.12) running in Docker. **Other configurations (bare-metal, non-Alpine containers, Windows-host Stash, NixOS, etc.) are unverified.** It probably works — the plugin is pure Python + JS with no native deps beyond what `mega.py` and `pycryptodome` need — but you may need to adapt the install steps.
>
> The plugin is provided **as-is, with no warranty**. Test against a non-critical Stash instance first. Bug reports / PRs welcome via GitHub issues; please include your Stash version, the exact `python --version` of the runtime that runs the plugin, and any `[mega-import]` log lines from `docker logs stash`.

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
| Full MEGA tree | `/tmp/.mega_files_cache.json` (server) | 1 h | `mega.py.get_files()` fetches the entire account tree (slow on multi-TB accounts); we re-use it across plugin invocations |
| Per-folder listing | `localStorage` `mega-import:path-cache` (browser) | 1 h since last use | Stale-while-revalidate so navigation feels instant |
| Session token | `/tmp/.mega_session.json` (server) | until logout | Skips the 3-min Hashcash PoW |

Clear them via Settings panel buttons or `Disconnect`.

### Temp files

`mega.py` writes downloads to `/tmp/megapy_<random>` then moves to dest. Failed/orphaned temps accumulate. The plugin auto-prunes anything older than 1 h on every progress poll, plus there's a manual **"Clean server temp files"** button in Settings.

### Per-file timeouts

| Action | Timeout |
|---|---|
| `login` | 10 min (Hashcash) |
| `list` / `find` / `preview` | 5 min |
| `download` (size known) | `max(2 min, 60s + size/200KB·s)` capped at 1 h |
| `download` (size unknown) | 30 min |

If MEGA throttles you hard (free account hitting daily cap), bump the constant in `_timeoutMs` (currently `200_000` bytes/sec assumed).

### Concurrency

Default 3 parallel downloads. Cap is 5 (constant `MAX_CONCURRENCY`). Lower it if your MEGA account is being throttled — fewer concurrent streams often means higher per-stream throughput.

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

54 tests, all should pass. Covers MEGA base64, Hashcash threshold, parse-header, `_gencash` (rebuilds the 12 MB buffer + verifies SHA-256), session token round-trip in both `bytes` and `uint32-list` shapes.

## Roadmap (post-v1)

These were considered and explicitly **not** shipped in v1:

| Feature | Why not yet | Effort |
|---|---|---|
| **Backend job-queue** so closing the browser tab doesn't pause the queue | Current flow uses synchronous `runPluginOperation`. Refactoring to `runPluginTask` + status polling is ~1 day of work. Workaround for now: keep the tab open. | M |
| **Real per-file MEGA progress** (instead of temp-file size polling) | Would require monkey-patching `mega.py.download_file` to report chunk-level progress to a status file. Current polling is good enough; tilde marker (`~`) shows when bar is estimated vs measured. | M |
| **Group/series creation from a folder of scenes** | UI hook is in the preview modal but the plumbing isn't wired (Stash's `Group` entity needs explicit member ordering, which we'd have to infer from filenames). | S |
| **LocalVisage face recognition** | Requires Python 3.10 + DeepFace + ~3 GB of ML deps; the official Stash Alpine image is on Python 3.12. Workaround documented in chat history: rebuild Stash on `python:3.10-slim` Debian base. Not part of the plugin proper. | L (new image, downtime) |
| **Resumable downloads** | `mega.py` doesn't expose chunked resume. A failed multi-GB download has to start over. Could fork `mega.py` to fix. | L |
| **Bandwidth limit / scheduled downloads** | Not built in. User can throttle at the firewall or via tc/iptables on the Stash host. | M |
| **Multiple MEGA accounts** | Single `_session.json` slot. Would need account picker UI + per-account session storage. | M |
| **Search filters: by size, by date, by extension globally** | Current "Search" is just `mega-find` with a glob pattern. Useful enhancement. | S |
| **Browser-side download (no server)** | Out of scope: Stash needs the bytes on its filesystem to scan them, so server-side is correct. | — |
| **Native progress callbacks via mega.py fork** | Same as above; would unlock real chunk-level progress without filesystem polling. | L |

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
  ├── action_login        (with Hashcash PoW solver)
  ├── action_list / find  (cached MEGA tree)
  ├── action_preview      (folder expansion + by-ext stats)
  ├── action_download     (mega.py → /tmp/megapy_* → dest)
  ├── action_temp_progress (real-byte sampling for UI)
  ├── action_cleanup_temp (prune orphans)
  ├── action_logout
  └── action_check / whoami

  ↳ writes JSON `{"output": …, "error": …}` to stdout
  ↳ Stash returns it to the browser via runPluginOperation
```

State files (all in `/tmp` on the Stash host):
- `.mega_session.json` — `{sid, master_key}` (uint32 list or raw bytes)
- `.mega_files_cache.json` — full file tree (auto-expires after 1 h)
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
