# Technical Notes

For users / installers, see [INSTALL.md](INSTALL.md).
For repo overview, see [README.md](README.md).
For changelog, see [PROGRESS.md](PROGRESS.md).

This file is internal architecture detail for contributors.

## Stack

| Layer | What |
| --- | --- |
| **Frontend** | Vanilla `React.createElement` (no JSX, no build step) — Stash plugins ship a single JS file loaded as-is. Bootstrap + FontAwesome via Stash's `PluginApi.libraries`. Apollo client for GraphQL via `useApolloClient` |
| **Bridge** | GraphQL `runPluginOperation(plugin_id, args)` — synchronous, returns the Python script's stdout JSON `output` field directly |
| **Backend** | Python 3.8+ stdlib + `mega.py` + `tenacity` + `pycryptodome`. One subprocess per plugin invocation. Stateless across calls except for `/tmp/.mega_*.json` persistence files |
| **Storage** | `localStorage` in browser (session, settings, history, path cache); on the Stash host: session JSON + a SQLite tree index in the temp dir |

## Why no build step

Stash plugins are loaded as raw `<script>` tags. Anything requiring transpilation (JSX, TypeScript, ES module imports) would need a build pipeline that ships separately. Sticking to `React.createElement` calls keeps the plugin a single drop-in JS file with zero npm dependencies.

## Why mega.py and not MEGAcmd / megajs

| Option | Why not |
| --- | --- |
| **MEGAcmd** | Native binary, must be installed separately on the Stash host. Adds an external runtime dependency and won't work on Alpine without extra effort. |
| **megajs** | Browser-side. Files would download into the browser, then need to be uploaded to the Stash server — defeats the point (Stash needs them on its filesystem to scan). |
| **mega.py** ✓ | Pure Python, installable via pip, runs anywhere the Stash plugin Python can run. Has bugs (MAC verification, pycrypto dep) but they're patchable from outside. |

If `mega.py` ever becomes unmaintained or the bugs become unfixable, the next move is a small JS-only rewrite using `megajs` + a service worker for streamed downloads (see Roadmap in INSTALL.md).

## Action protocol

Every `runPluginOperation` call is dispatched on the Python side via `ACTIONS[args["action"]](args)`. The Python script reads one JSON document from stdin, writes one JSON document to stdout in the form:

```json
{ "output": <result>, "error": null }
```

or on failure:

```json
{ "output": null, "error": "<message>" }
```

Stash returns `output` directly to the JS caller; `error` is converted to a GraphQL error.

### Actions

| Action | Purpose |
| --- | --- |
| `check` | Returns `{version: "mega.py X.Y.Z"}` — sanity check |
| `whoami` | Returns `{email: "..."}` if logged in, else `{email: null}` |
| `login` (email/pass OR session_token) | Authenticates, writes the session file, returns `{email, session_token}` |
| `logout` | Clears the session file |
| `list` `{path}` | Children of a folder (indexed query), with `child_count` and `total_size` for sub-folders |
| `find` `{query, path?}` | Recursive name search (indexed `LIKE`) across the tree |
| `preview` `{paths}` | Recursively expand paths → `{total_files, total_size, by_ext, files[]}` for the preview modal |
| `download` `{paths, dest?}` | Synchronous download (single or many) — MAC-rescue, resume, retry/backoff, staging. Used directly; the UI prefers `enqueue` |
| `enqueue` `{paths, dest?}` | Expand paths to files, append to the background queue, ensure the detached worker is running. Returns `{queued, ids, errors, worker_pid}` immediately |
| `queue_status` | `{items[], counts, worker_alive, updated_at}` — polled by the UI |
| `queue_clear` `{only_done?}` | Drop queued items (keeps the in-flight one; `only_done` keeps pending+downloading) |
| `temp_progress` | Snapshot of `megapy_*` temp files for real-byte progress UI |
| `cleanup_temp` | Delete all `megapy_*` temps + staging orphans (manual cleanup button) |
| `__worker` (internal) | Entry point for the detached background worker — not called by the UI |

## Hashcash PoW

MEGA's API returns HTTP 402 with header `X-Hashcash: 1:<easiness>:<ts>:<b64token>` on first login. The client must find a 4-byte nonce such that:

```
SHA-256([nonce_be] + [token_bytes × 262144])[0:4] ≤ threshold(easiness)
```

`threshold(e) = (((e & 63) << 1) + 1) << ((e >> 6) * 7 + 3)`.

Implemented in `_gencash()` using `threading` workers. `hashlib` releases the GIL during large `update()` calls, so threads run in genuine parallel. Each nonce attempt SHA-256-hashes the full ~12 MB buffer and a login challenge routinely needs tens-to-hundreds of thousands of attempts, so the only lever is core count — the solver uses **all** logical CPUs (override with `MEGA_HASHCASH_THREADS`). The nonce is at the *front* of the buffer, so SHA-256's Merkle–Damgård chaining forbids precomputing the constant tail: every attempt genuinely re-hashes all 12 MB, there is no algorithmic shortcut. It logs the solve time + thread count to stderr. The session token cached in `/tmp/.mega_session.json` makes this a one-time cost — `list`/`download`/`whoami` reuse the SID and never re-solve.

## MAC-mismatch workaround

`mega.py.Mega._download_file` runs an integrity check after the download completes:

```python
if (file_mac[0] ^ file_mac[1], file_mac[2] ^ file_mac[3]) != meta_mac:
    raise ValueError('Mismatched mac')
output_path = Path(dest_path + file_name)
shutil.move(temp_output_file.name, output_path)   # never reached on mismatch
```

The MAC algorithm is buggy for many files — see [odwyersoftware/mega.py#61](https://github.com/odwyersoftware/mega.py/issues/61). When it raises, the fully-downloaded bytes are sitting in `/tmp/megapy_<random>` (created with `delete=False`). Our wrapper:

1. Catches `ValueError("Mismatched mac")`
2. Lists `/tmp/megapy_*` and finds files with size matching the expected `node["s"]`
3. `shutil.move`s the matching one to the final destination
4. Marks the import row `✓ (mac-skipped)` in the UI

## Download resilience

`_download_one()` wraps each per-file transfer with:

- **File-level resume** — if a complete copy (size == `node["s"]`) already sits at the destination, the transfer is skipped and the row is marked `skipped`. mega.py downloads to a `/tmp` temp file and only moves on success, so a file at the destination is genuinely complete, never partial. Re-running an interrupted multi-file import is therefore cheap and idempotent.
- **Retry with backoff** — transient failures (network blips, mega.py request errors, publish errors) are retried up to `MEGA_DOWNLOAD_RETRIES` times (default 3) with exponential backoff (1s, 2s, 4s, … capped at 15s). The MAC-rescue path counts as success and short-circuits the retries.

## Background download queue (detached worker)

Stash runs a plugin via `runPluginOperation` as a subprocess tied to the HTTP request context, and **kills it the moment the client disconnects** (verified empirically: a sleeping probe action stopped exactly when the browser request was aborted). So a synchronous download dies when the tab closes. Since Stash and the downloads run on the same host, the browser should only be a remote control.

Flow:

1. **`enqueue`** expands the requested paths to individual files (via the SQLite index), appends them to a queue JSON (`MEGA_QUEUE_FILE`, default `<tmp>/mega_queue.json`), and calls `_ensure_worker()`.
2. **`_ensure_worker`** checks the recorded `worker_pid` for liveness (`_pid_alive`, `OpenProcess`+`STILL_ACTIVE` on Windows / `os.kill(pid,0)` on POSIX) under a flock; if none is running it **spawns a detached worker** — `subprocess.Popen([python, mega_import.py])` fed `{"action":"__worker"}` on stdin, with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (Windows) or `start_new_session=True` (POSIX). Being detached, it is **not** a child of the request subprocess, so Stash can't kill it.
3. **The worker loop** claims the next `pending` item under the flock, marks it `downloading`, runs it through the same `_download_one()` (staging, resume, retry, MAC-rescue), records the result, and repeats until the queue drains. Queue writes are atomic (`.tmp` → `os.replace`).
4. **On drain** the worker calls `_post_import()` — it reads the current library paths, adds any missing destinations, and triggers `metadataScan`, all via Stash's GraphQL using the `server_connection` (scheme/port/session cookie) captured in `main()`. So imports land in the library with no UI open.

The UI (`downloadFiles`) just `enqueue`s, then polls `queue_status` to drive the progress bar; it filters by the returned `ids` so it only tracks its own batch. Metadata enrichment (auto-tag / identify / generate) still runs browser-side when open. Worker concurrency is sequential (NFS-safe). The detached-worker primitives (`DETACHED_PROCESS`, `start_new_session`, `/proc`-free liveness) are all guarded so the module imports on any platform.

## Anti-NFS-saturation (local staging + serialized publish)

A full import once froze the whole host. Root cause: mega.py downloads to a local `/tmp` temp, then `shutil.move`s to the dest. When the dest is on **NFS** (a *different* filesystem) that move becomes a full copy to NFS, and several concurrent downloads stack multi-GB writes onto a `hard,timeo=600` mount → unbounded kernel dirty pages → writeback burst → **iowait storm** → the VM hangs (recoverable only by power-cycle). The post-import scan was *not* the culprit (no generate flags). See `mega-import-batch-redesign.md` for the full incident write-up.

Fix, in `_download_one()` / `_publish()`:

1. **Local staging** — when the dest is a network filesystem, mega.py downloads into a local staging dir (`MEGA_STAGING_DIR`, default `<tmp>/mega_stage`) on the fast local disk. Parallel downloads never touch NFS.
2. **Serialized + fsync-paced publish** — `_publish()` moves each staged file to the dest **one at a time across all concurrent download *processes*** (a `fcntl.flock` lockfile — each download is a separate `python mega_import.py` process, so the lock must be cross-process). It copies in 16 MB chunks and `os.fdatasync`s every 128 MB so dirty pages stay bounded, then `os.replace`s a `.part` sidecar → atomic publish (Stash never scans a half-written file). Optional MB/s cap via `MEGA_PUBLISH_BWLIMIT`.
3. **Backpressure** — before each download, `_await_staging_capacity()` blocks while staged-but-unpublished bytes exceed `MEGA_MAX_STAGED_BYTES` (8 GB), so parallel downloads can't outrun the publisher and fill the local disk.
4. **Auto-detect** — `_is_network_fs()` parses `/proc/mounts` (Linux only). On a **local-disk dest** (or any non-Linux host) staging is skipped entirely — download straight to dest, the original fast path, zero penalty. Force/disable with `MEGA_STAGING=force|off`.

Portability: `fcntl`, `os.fdatasync`, and `/proc/mounts` are POSIX/Linux-only and are all guarded, so the module imports and runs on Windows/macOS (where it always takes the local fast path).

## Tree index (SQLite)

`get_files()` returns the **entire** account node tree in one request — the MEGA API can't list a single folder server-side. On a large account that's hundreds of thousands of nodes. The old flat-JSON cache re-parsed that whole blob (hundreds of MB) on *every* navigation, because each plugin call is a fresh subprocess — measured ~6.7 s per folder click on a 724k-node account.

Instead the tree is ingested **once** into a local SQLite file (`_tree_ingest`), and every list/find/download answers from indexed queries (`_db_resolve` / `_db_children` / `_db_collect_files`):

- `nodes(handle PK, parent, type, name, name_lower, size, path, rcount, rsize, node_json)` with indexes on `parent`, `name_lower`, `path`.
- Plaintext fields (structure, sizes) come straight from the API; **names are decrypted once at ingest** and stored, so search is an indexed `LIKE` and recursive folder size/count (`rcount`/`rsize`) are precomputed in one pass.
- `node_json` (the decrypted key/iv/meta_mac) is stored per **file** so downloads need no re-fetch.
- Ingest is **serialized across processes** (the same flock used by publish) and published atomically (`<db>.building` → `os.replace`), so concurrent download tasks never double-fetch or read a half-built index.
- Keyed by `sid` with a long TTL (`MEGA_TREE_TTL`, default 24 h) since re-fetching is expensive.

Result on a 724k-node / 12 TB account: per-click navigation **6.7 s → ~85 ms (root) / ~15 ms (subfolders)**. The one-time fetch+ingest (~220 s) is unchanged in nature (MEGA sends the whole tree) but paid far less often.

## Environment variables

| Var | Default | Effect |
| --- | --- | --- |
| `MEGA_IMPORT_DEST` | `<stash-config>/mega_imports` | Override download destination |
| `MEGA_SESSION_FILE` | `<tmp>/.mega_session.json` | Override session-cache path |
| `MEGA_TREE_DB` | `<tmp>/.mega_tree.sqlite` | Override tree-index DB path |
| `MEGA_TREE_TTL` | `86400` (24 h) | Tree-index freshness before re-fetch |
| `MEGA_QUEUE_FILE` | `<tmp>/mega_queue.json` | Background download-queue file path |
| `MEGA_HASHCASH_THREADS` | all logical CPUs | PoW solver thread count |
| `MEGA_DOWNLOAD_RETRIES` | `3` | Per-file download attempts before giving up |
| `MEGA_STAGING` | auto (NFS→on) | `force`/`off` to override staging decision |
| `MEGA_STAGING_DIR` | `<tmp>/mega_stage` | Local staging dir for the NFS-safe path |
| `MEGA_MAX_STAGED_BYTES` | `8589934592` (8 GB) | Backpressure cap on staged-but-unpublished bytes |
| `MEGA_PUBLISH_CHUNK` | `16777216` (16 MB) | Publish copy chunk size |
| `MEGA_PUBLISH_FSYNC_EVERY` | `134217728` (128 MB) | fdatasync cadence during publish |
| `MEGA_PUBLISH_BWLIMIT` | `0` (off) | Publish bandwidth cap, MB/s |

## Filename slugification

MEGA filenames can contain anything (emoji, slashes, spaces, NFD-normalized unicode). The slugifier:

1. Strips path separators
2. NFKD-normalizes + ASCII-encodes (best-effort transliteration: `café` → `cafe`)
3. Replaces any non-`[A-Za-z0-9._-]` run with `_`
4. Strips leading dots / trailing punctuation
5. Caps at 200 chars (preserves extension)

Tested with: emoji-only filenames, mixed RTL+LTR, unbroken 300-char names, `..` traversal attempts.

## Cache TTLs (rationale)

| Cache | TTL | Why this number |
| --- | --- | --- |
| Browser path cache | 1 h since last use | Long enough to survive a full browsing session; short enough that returning the next day re-fetches |
| Server tree index (SQLite) | 24 h (`MEGA_TREE_TTL`) | `mega.py.get_files()` walks the entire account; on a 12 TB / 724k-node account the fetch is ~3 min — too slow to repeat often, so the index lives a full day |
| Server session | until explicit logout | Hashcash PoW takes 3-5 min; never expire automatically |

Both browser + server caches are scoped by user (the server cache key includes the MEGA `sid`).

## Known frontend quirks

- **`api.utils.navigate` not in older Stash versions** → compat shim `navigateTo()` falls back to `window.location.assign`
- **`api.register.route` takes positional args** `(path, component)`, NOT an options object — passing `{path, component}` silently no-ops
- **`useToast()` only has `success / error / info`** — no `warning`. Plugin uses `error` for warnings
- **Background tab throttling** — when the browser tab is in the background, `setInterval` slows down (so progress bar stops animating) but `fetch` keeps going. **Closing** the tab kills the JS context, so no new downloads in the queue start until the tab is reopened. See Roadmap → backend job queue
