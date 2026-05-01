# MEGA Import Plugin for Stash

Browse your MEGA.nz cloud storage from inside Stash, select files, and have them downloaded onto the Stash server and scanned into your library — without leaving the UI.

## How it works

```
[Browser]               [Stash server]                [MEGA.nz]
  React UI  --GraphQL--> Stash plugin task
                              |
                              v
                         mega_import.py
                              |
                              v
                         MEGAcmd  <----- HTTPS ----->  MEGA
                              |
                              v
                       <stash>/mega_imports/
                              |
                              v
                       metadataScan triggered
```

All MEGA traffic is **server-side** — the browser only ever talks to Stash. Files land on the same machine that runs Stash, so the auto-triggered metadata scan can pick them up.

## Requirements

- **Stash 0.20+** (for the plugin task GraphQL surface used here)
- **Python 3.8+** on the Stash machine (no extra Python packages — uses stdlib only)
- **MEGAcmd** on the Stash machine. Install from <https://mega.nz/cmd>.
  - Linux/macOS: package installer puts `mega-login`, `mega-ls`, etc. on PATH automatically.
  - **Windows**: install adds binaries to `%LOCALAPPDATA%\MEGAcmd\`. Either add that directory to PATH, or the plugin will auto-detect it from there.
  - Verify with: `mega-version` from a terminal.

## Installation

### Option A — installer script (recommended)

```bash
# Linux / macOS / WSL — local install
./install.sh

# Linux / macOS / WSL — explicit target
./install.sh /path/to/stash/plugins

# Linux / macOS / WSL — remote install over SSH
STASH_HOST=user@server ./install.sh
STASH_HOST=user@server STASH_PLUGINS=/var/lib/stash/plugins ./install.sh
```

```powershell
# Windows
.\install.ps1
.\install.ps1 -Target "C:\path\to\stash\plugins"
```

The installer auto-detects common Stash plugins paths, runs the Python unit tests before copying anything, warns if MEGAcmd isn't installed, then copies files to `<plugins>/mega_import/`.

### Option B — manual

1. Copy this folder into your Stash plugins directory (default `~/.stash/plugins/mega_import/`).
2. In Stash → Settings → Plugins, click **Reload Plugins**.
3. A red MEGA logo appears in the top navigation bar.

## Usage

1. Click the MEGA navbar button → log in with your MEGA email and password.
2. You're sent to the **MEGA Cloud Browser** page. Navigate folders, check files.
3. Click **Import Selected** — the Stash server downloads them and starts a metadata scan.
4. Imported files appear in `<plugin install dir>/mega_imports/` (overridable via the `MEGA_IMPORT_DEST` environment variable on the Stash process).
5. **Disconnect** logs out of MEGA; **Back to Stash** returns without logging out.

## Architecture

| File | Role |
| --- | --- |
| [mega_import.js](mega_import.js) | React UI (navbar button, login modal, browser page) + GraphQL bridge (`MegaApiClient`) |
| [mega_import.py](mega_import.py) | Subprocess wrapper around MEGAcmd. Stdin/stdout JSON protocol |
| [mega_import.yml](mega_import.yml) | Stash plugin manifest. Single task `MEGA Operation` dispatched via `action` arg |
| [mega_import.css](mega_import.css) | Page + modal styling |

### JS ↔ Python bridge

Stash's GraphQL doesn't expose plugin task stdout to the frontend. The bridge encodes results into the only field that *is* exposed (`Job.error`):

- Python writes `{"output": null, "error": "OK:<json>"}` on success or `"ERR:<msg>"` on failure
- JS calls `runPluginTask` → polls `findJob` → strips the prefix → resolves/rejects

Polling interval is 250 ms; first response lands in ~250–500 ms after the job finishes.

### Backend protocol

Run standalone for testing:

```bash
echo '{"action":"check"}' | python mega_import.py
echo '{"action":"login","email":"you@x.com","password":"…"}' | python mega_import.py
echo '{"action":"list","path":"/"}' | python mega_import.py
echo '{"action":"download","paths":["/file.mp4"],"dest":"./out"}' | python mega_import.py
echo '{"action":"logout"}' | python mega_import.py
```

Standalone responses use `{"ok": true, "result": …}` / `{"ok": false, "error": …, "code": …}`. When invoked by Stash (input has an `args` key), responses are wrapped in the `OK:`/`ERR:` envelope above.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `MEGAcmd command 'mega-version' not found` | Install MEGAcmd or add its install dir to PATH on the Stash machine |
| `Apollo client not initialized` | Plugin loaded too late. Reload the page; if persistent, check browser console for `[mega-import]` errors |
| Login succeeds, list fails immediately after | MEGAcmd's daemon (`mega-cmd-server`) may not be running. Try `mega-whoami` in a terminal |
| Import succeeds but files don't appear in Stash | Check the metadata scan job in Stash; verify your library includes the import dest path |
| `Job N disappeared before result was read` | Stash dropped the job from its queue between polls — increase `POLL_INTERVAL_MS` in `mega_import.js` (rare) |

Browser-side errors are prefixed `[mega-import]` in the devtools console.

## Features

- Login modal with session persistence (`sessionStorage` — refresh on `/mega-browser` survives)
- Full-screen browser page with breadcrumb path and folder navigation
- File-type filter (All / Videos / Images / Custom extensions)
- Recursive folder import (select a folder; MEGAcmd downloads it whole)
- Search via `mega-find` (glob patterns across the whole tree)
- Concurrent downloads — configurable 1–5 in flight at once
- Live progress bar with per-file current path and in-flight count
- Cancel button (drains in-flight tasks, no new dispatches)
- Configurable destination folder
- Import history with timestamp, status, path filter, status filter
- "Already imported" green-check badge on file rows
- Auto-trigger Stash `metadataScan` after import so files appear in your library

## Development

Run the Python unit tests (no MEGAcmd or Stash needed — covers the parser,
dispatch, error paths, and Stash envelope encoding):

```bash
python -m unittest test_mega_import -v
```

Syntax-check the JS:

```bash
node --check mega_import.js
```

## License

MIT. Not affiliated with MEGA.nz.
