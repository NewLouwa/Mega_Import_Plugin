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
| **Storage** | `localStorage` in browser (session, settings, history, path cache); `/tmp/*.json` on Stash host (session, file tree cache) |

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

### Actions in v1.0.0

| Action | Purpose |
| --- | --- |
| `check` | Returns `{version: "mega.py X.Y.Z"}` — sanity check |
| `whoami` | Returns `{email: "..."}` if logged in, else `{email: null}` |
| `login` (email/pass OR session_token) | Authenticates, writes `/tmp/.mega_session.json`, returns `{email, session_token}` |
| `logout` | Clears the session file |
| `list` `{path}` | Returns sorted children of a folder, with `child_count` and `total_size` for sub-folders |
| `find` `{query, path?}` | Glob-pattern recursive search across the whole tree |
| `preview` `{paths}` | Recursively expand paths, return `{total_files, total_size, by_ext, files[]}` for the preview modal |
| `download` `{paths, dest?}` | Download files (single or many), with MAC-rescue + slugified filenames |
| `temp_progress` | Snapshot of `/tmp/megapy_*` files for real-byte progress UI |
| `cleanup_temp` | Delete all `/tmp/megapy_*` (manual cleanup button) |

## Hashcash PoW

MEGA's API returns HTTP 402 with header `X-Hashcash: 1:<easiness>:<ts>:<b64token>` on first login. The client must find a 4-byte nonce such that:

```
SHA-256([nonce_be] + [token_bytes × 262144])[0:4] ≤ threshold(easiness)
```

`threshold(e) = (((e & 63) << 1) + 1) << ((e >> 6) * 7 + 3)`.

Implemented in `_gencash()` using `threading` workers. `hashlib` releases the GIL during large `update()` calls, so threads run in genuine parallel — on a 4-core box first login takes 2-5 minutes. The session token cached in `/tmp/.mega_session.json` skips this on subsequent runs.

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
| Server file tree | 1 h | `mega.py.get_files()` walks the entire account; on a 13 TB account that's 30s-3min — too slow to do on every list |
| Server session | until explicit logout | Hashcash PoW takes 3-5 min; never expire automatically |

Both browser + server caches are scoped by user (the server cache key includes the MEGA `sid`).

## Known frontend quirks

- **`api.utils.navigate` not in older Stash versions** → compat shim `navigateTo()` falls back to `window.location.assign`
- **`api.register.route` takes positional args** `(path, component)`, NOT an options object — passing `{path, component}` silently no-ops
- **`useToast()` only has `success / error / info`** — no `warning`. Plugin uses `error` for warnings
- **Background tab throttling** — when the browser tab is in the background, `setInterval` slows down (so progress bar stops animating) but `fetch` keeps going. **Closing** the tab kills the JS context, so no new downloads in the queue start until the tab is reopened. See Roadmap → backend job queue
