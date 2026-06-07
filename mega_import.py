#!/usr/bin/env python3
"""
MEGA Import Plugin — backend (mega.py edition).

Replaces MEGAcmd with the mega.py library (pip install mega.py), which works
on Alpine Linux containers and needs no native binaries.

Hashcash PoW
------------
MEGA's API returns HTTP 402 when it wants the client to prove it is not a bot.
The response carries an "X-Hashcash: 1:<easiness>:<ts>:<b64token>" header.
The client must find a 4-byte nonce such that

    SHA-256([nonce_be] + [token_bytes × 262144])[0:4] ≤ threshold(easiness)

and retry the request with "X-Hashcash: 1:<token>:<solved_prefix_b64>".
This module implements the solver in pure Python + hashlib (multithreaded,
since hashlib releases the GIL for large updates).

Protocol
--------
Reads one JSON document from stdin.

  Standalone (testing):
    {"action": "list", "path": "/"}

  From Stash (plugin task wraps args):
    {"args": {"action": "list", "path": "/"}, "server_connection": {...}}

Always writes {"output": <result|null>, "error": <null|"message">} to stdout.
This format works with Stash's runPluginOperation (v0.25+): Stash returns
output.output directly to the JS caller and turns output.error into a
GraphQL error.

Session persistence
-------------------
The Python process is spawned fresh for every plugin call.  We persist the
MEGA session (SID + master-key) in a temp file so repeated calls don't need
to re-authenticate.  The session_token returned by `login` is a base64 JSON
blob of those same fields — the JS can store it in sessionStorage and pass it
back to authenticate without a password.

Actions
-------
  check                              -> {"version": "mega.py X.Y.Z"}
  whoami                             -> {"email": "…"} | {"email": null}
  login  {email, password}           -> {"email": "…", "session_token": "…"}
  login  {session_token}             -> {"email": "…", "session_token": "…"}
  logout                             -> {}
  list   {path}                      -> [{type, name, size, path}, …]
  find   {query, path?}              -> [{type, name, path}, …]
  download {paths, dest?}            -> {dest, items: [{path, status, error?}]}
"""

import base64
import json
import os
import random
import sys
from pathlib import Path

# Stash captures the plugin subprocess's stderr through a pipe, which makes
# Python block-buffer it — so progress lines (e.g. the multi-minute "Solving
# hashcash…") only surface when the process exits, making a slow login look
# frozen.  Force line buffering so every [mega-import] line appears live.
try:
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

# The args JSON arrives on stdin as UTF-8, but on Windows Python defaults stdin
# to the locale codec (cp1252) for a pipe — which mangles non-ASCII names
# (e.g. an emoji folder "🔞 …" → "Ã°ÂŸÂ”Âž …") so path lookups miss.  Force UTF-8.
try:
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Compatibility: asyncio.coroutine was removed in Python 3.11.
# tenacity ≤ 5.x (and some older mega.py deps) still use it at import time.
# Patch it back in as a no-op decorator so the import doesn't crash.
# ---------------------------------------------------------------------------
import asyncio as _asyncio
if not hasattr(_asyncio, "coroutine"):
    _asyncio.coroutine = lambda f: f

# ---------------------------------------------------------------------------
# Force IPv4 for all requests/urllib3 calls.
# Many Docker/container setups have no IPv6 routing: DNS resolves MEGA's API
# to IPv6 first, the TCP connect hangs (no RST, just silence), and the login
# blocks for 120 s before timing out.  Forcing AF_INET bypasses that.
# ---------------------------------------------------------------------------
import socket as _socket
try:
    import urllib3.util.connection as _u3conn
    _u3conn.allowed_gai_family = lambda: _socket.AF_INET
except Exception:
    pass  # urllib3 not yet installed — noop, mega.py import will fail later anyway

# ---------------------------------------------------------------------------
# MEGA base64 helpers.
# MEGA uses a modified base64 alphabet: A-Za-z0-9 then '-' then '_'
# (URL-safe variant, no padding characters).
# ---------------------------------------------------------------------------
_M64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_M64_MAP = {c: i for i, c in enumerate(_M64)}
_M64_MAP['+'] = 62   # accept standard base64 '+' as alias for '-'
_M64_MAP['/'] = 63   # accept standard base64 '/' as alias for '_'


def _mega_b64_decode(s: str) -> bytes:
    """Decode MEGA base64 (A-Za-z0-9-_) to bytes.  No '=' padding required."""
    s = s.rstrip("=")
    result = bytearray()
    acc, bits = 0, 0
    for c in s:
        v = _M64_MAP.get(c, -1)
        if v < 0:
            continue
        acc = (acc << 6) | v
        bits += 6
        if bits >= 8:
            bits -= 8
            result.append((acc >> bits) & 0xFF)
    return bytes(result)


def _mega_b64_encode(b: bytes) -> str:
    """Encode bytes to MEGA base64 (no '=' padding)."""
    out, acc, bits = [], 0, 0
    for byte in b:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 6:
            bits -= 6
            out.append(_M64[(acc >> bits) & 63])
    if bits:
        out.append(_M64[(acc << (6 - bits)) & 63])
    return "".join(out)


# ---------------------------------------------------------------------------
# MEGA Hashcash proof-of-work solver.
#
# When MEGA's API returns HTTP 402 it includes a response header:
#   X-Hashcash: 1:<easiness>:<timestamp>:<b64token>
#
# The client must solve a SHA-256 PoW and retry with:
#   X-Hashcash: 1:<b64token>:<solved_prefix_b64>
#
# Algorithm (from MEGA SDK src/hashcash.cpp):
#   buffer = [4-byte nonce (big-endian)] + [token_bytes repeated 262144 times]
#   Find nonce such that: struct.unpack('>I', sha256(buffer)[:4])[0] <= threshold
#   threshold = (((easiness & 63) << 1) + 1) << ((easiness >> 6) * 7 + 3)
# ---------------------------------------------------------------------------
_HC_TOKEN_BYTES = 48
_HC_REPEAT = 262144                              # 12 MB / 48 B
_HC_BUF_SIZE = 4 + _HC_REPEAT * _HC_TOKEN_BYTES  # 12,582,916 bytes


def _hc_threshold(easiness: int) -> int:
    """Max allowed first 32-bit word (big-endian) of SHA-256 for the given easiness."""
    return (((easiness & 63) << 1) + 1) << ((easiness >> 6) * 7 + 3)


def _gencash(token_b64: str, easiness: int) -> str:
    """
    Solve MEGA's hashcash PoW.
    Returns the 4-byte nonce encoded in MEGA base64.
    Uses one thread per logical CPU core; hashlib releases the GIL so threads
    run truly in parallel.
    """
    import hashlib
    import struct
    import threading

    token_bin = _mega_b64_decode(token_b64)
    if len(token_bin) != _HC_TOKEN_BYTES:
        raise MegaError(
            f"Hashcash token must be {_HC_TOKEN_BYTES} bytes, got {len(token_bin)}",
            code="bad_hashcash",
        )

    # Build the 12 MB token area (index 0..3 is the nonce slot; 4.. is the
    # token repeated 262144 times).  We only pre-build indices 4..end once.
    token_area = bytearray(_HC_BUF_SIZE)
    token_area[4 : 4 + _HC_TOKEN_BYTES] = token_bin
    filled = _HC_TOKEN_BYTES
    while filled < _HC_REPEAT * _HC_TOKEN_BYTES:
        chunk = min(filled, _HC_REPEAT * _HC_TOKEN_BYTES - filled)
        token_area[4 + filled : 4 + filled + chunk] = token_area[4 : 4 + filled]
        filled += chunk

    # Pre-slice the two fixed parts of every SHA-256 call:
    #   block0 = [4B nonce] + block0_suffix  (exactly 64 bytes — one SHA-256 block)
    #   tail   = everything from byte 64 onwards (constant for all nonces)
    block0_suffix = bytes(token_area[4:64])  # 60 bytes
    tail = bytes(token_area[64:])            # 12,582,852 bytes

    threshold = _hc_threshold(easiness)
    # PoW is the login bottleneck: every nonce attempt SHA-256-hashes the full
    # ~12 MB buffer, and login challenges routinely need tens/hundreds of
    # thousands of attempts.  hashlib releases the GIL for large updates, so
    # threads scale ~linearly with cores — use ALL of them (was capped at 8,
    # which throttled bigger hosts).  Override with MEGA_HASHCASH_THREADS.
    try:
        num_workers = int(os.environ.get("MEGA_HASHCASH_THREADS") or 0)
    except ValueError:
        num_workers = 0
    if num_workers <= 0:
        num_workers = os.cpu_count() or 4
    import time as _hc_time
    _hc_t0 = _hc_time.time()
    stop = threading.Event()
    result_holder: list = [None]
    lock = threading.Lock()

    def _worker(start: int) -> None:
        n = start
        while not stop.is_set():
            nonce_bytes = struct.pack(">I", n & 0xFFFFFFFF)
            h = hashlib.sha256()
            h.update(nonce_bytes + block0_suffix)
            h.update(tail)
            first_word, = struct.unpack(">I", h.digest()[:4])
            if first_word <= threshold:
                with lock:
                    if result_holder[0] is None:
                        result_holder[0] = _mega_b64_encode(nonce_bytes)
                stop.set()
                return
            n += num_workers
            if n > 0xFFFFFFFF * num_workers:
                stop.set()
                return

    threads = [
        threading.Thread(target=_worker, args=(i,), daemon=True)
        for i in range(num_workers)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if result_holder[0] is None:
        raise MegaError("Hashcash PoW: nonce space exhausted", code="hashcash_failed")
    print(
        f"[mega-import] Hashcash solved in {_hc_time.time() - _hc_t0:.1f}s "
        f"using {num_workers} threads",
        file=sys.stderr,
    )
    return result_holder[0]


def _parse_hashcash_header(value: str):
    """
    Parse MEGA's X-Hashcash response header.
    Expected format: 1:<easiness>:<timestamp>:<b64token>
    Returns (token_b64, easiness) or None on failure.
    """
    parts = value.strip().split(":")
    if len(parts) != 4 or parts[0] != "1":
        return None
    try:
        easiness = int(parts[1])
        if not 0 <= easiness <= 255:
            return None
    except ValueError:
        return None
    token = parts[3]
    if len(token) != 64:
        return None
    return token, easiness


# ---------------------------------------------------------------------------
# Patch requests.Session.request to handle MEGA's HTTP 402 / Hashcash PoW.
# When MEGA returns 402 it expects the client to solve a proof-of-work and
# retry the *exact same* request with the solution in an X-Hashcash header.
# The patch is skipped gracefully if requests is not installed (e.g. during
# local unit tests that mock all network calls).
# ---------------------------------------------------------------------------
try:
    import requests as _requests
    _orig_session_request = _requests.Session.request
except ImportError:
    _requests = None  # type: ignore[assignment]
    _orig_session_request = None


def _session_request_with_hashcash(self, method, url, **kwargs):
    """Transparently handle MEGA's HTTP 402 Hashcash challenge-response."""
    resp = _orig_session_request(self, method, url, **kwargs)

    if resp.status_code == 402 and (
        "mega.co.nz" in str(url) or "mega.nz" in str(url)
    ):
        hc_val = resp.headers.get("X-Hashcash") or resp.headers.get("x-hashcash") or ""
        parsed = _parse_hashcash_header(hc_val)
        if parsed:
            token_b64, easiness = parsed
            threshold = _hc_threshold(easiness)
            avg_attempts = (2**32) // max(threshold, 1)
            print(
                f"[mega-import] Hashcash challenge: easiness={easiness} "
                f"threshold=0x{threshold:08x} ~{avg_attempts:,} attempts expected. Solving…",
                file=sys.stderr,
            )
            try:
                prefix_b64 = _gencash(token_b64, easiness)
                retry_headers = dict(kwargs.get("headers") or {})
                retry_headers["X-Hashcash"] = f"1:{token_b64}:{prefix_b64}"
                retry_kwargs = {**kwargs, "headers": retry_headers}
                resp = _orig_session_request(self, method, url, **retry_kwargs)
                print(
                    f"[mega-import] Hashcash retry → HTTP {resp.status_code}",
                    file=sys.stderr,
                )
            except Exception as e:
                print(f"[mega-import] Hashcash PoW error: {e}", file=sys.stderr)

    return resp


if _requests is not None:
    _requests.Session.request = _session_request_with_hashcash

# Use the platform temp dir (gettempdir() == /tmp on Linux, so media-vm is
# unchanged; on Windows/macOS a hardcoded "/tmp" resolves to a non-existent
# C:\tmp and the session/cache silently fail to persist).
import tempfile as _tempfile
SESSION_FILE = Path(
    os.environ.get("MEGA_SESSION_FILE")
    or (Path(_tempfile.gettempdir()) / ".mega_session.json")
)

# Default download location.  We want a path that:
#   1. Always exists / is creatable on any Stash install (Linux/macOS/Windows)
#   2. Is writable by the Stash process (the user running stash)
#   3. Survives container restarts (i.e. lives in something that's typically
#      bind-mounted in dockerized installs)
#
# Stash's config dir (`~/.stash` or wherever the YAML lives) ticks all three:
# every install has it, every install can write to it, and dockerized installs
# universally mount it as a volume so files inside persist.  The plugin folder
# itself is inside that config dir, so taking `<plugin_dir>/../mega_imports`
# lands us in `~/.stash/mega_imports/`.
#
# Override priority:
#   1. Explicit `dest` arg from the JS Settings panel
#   2. MEGA_IMPORT_DEST environment variable
#   3. <stash-config-dir>/mega_imports/  ← this default
def _default_dest():
    env = os.environ.get("MEGA_IMPORT_DEST")
    if env:
        return env
    # Plugin file lives at <stash-config>/plugins/mega_import/mega_import.py
    here = Path(__file__).resolve().parent
    # Walk up until we find the "plugins" directory; its parent is the config dir.
    p = here
    for _ in range(4):
        if p.name == "plugins":
            return str(p.parent / "mega_imports")
        p = p.parent
    # Fallback: alongside the plugin folder.
    return str(here.parent / "mega_imports")

DEFAULT_DEST = _default_dest()


class MegaError(Exception):
    def __init__(self, message, code="mega_error"):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Session management — persist SID + master-key across subprocess calls.
# ---------------------------------------------------------------------------

def _session_to_token(sid, master_key):
    """Encode session credentials as a portable base64 token string.

    mega.py stores master_key as a list of 4 × uint32 (its internal AES
    key format), NOT as raw bytes.  We store exactly that list so the
    restored value can be handed back to mega.py without conversion.
    """
    if master_key is None:
        mk_serialised = []
    elif isinstance(master_key, (bytes, bytearray)):
        # Rare: caller passed raw bytes → store as plain byte list (all 0-255).
        mk_serialised = list(master_key)
    else:
        # Normal path: mega.py's list-of-uint32.
        mk_serialised = list(master_key)
    data = {"sid": sid, "mk": mk_serialised}
    return base64.b64encode(json.dumps(data, separators=(",", ":")).encode()).decode()


def _token_to_session(token):
    """Decode a session token back to (sid, master_key).

    master_key is returned in whatever format was stored — typically a
    list of uint32 as produced by mega.py's login(), which can be
    assigned directly back to Mega().master_key.
    """
    try:
        data = json.loads(base64.b64decode(token.encode()).decode())
        sid = data.get("sid") or ""
        mk_raw = data.get("mk") or []
        if not sid:
            raise ValueError("empty sid")
        # Detect format: if all values fit in a byte we stored raw bytes,
        # otherwise we stored mega.py's uint32 list — return it as-is.
        if mk_raw and max(mk_raw) <= 255:
            master_key = bytes(mk_raw)
        else:
            master_key = mk_raw or None
        return sid, master_key
    except Exception as e:
        raise MegaError(f"Invalid session token: {e}", code="bad_token")


def _save_session(sid, master_key):
    """Persist session to temp file. Returns the session token string."""
    token = _session_to_token(sid, master_key)
    try:
        SESSION_FILE.write_text(json.dumps({"token": token}))
        SESSION_FILE.chmod(0o600)
    except Exception:
        pass
    return token


def _load_saved_token():
    """Load persisted session token from temp file, or None."""
    try:
        if SESSION_FILE.exists():
            data = json.loads(SESSION_FILE.read_text())
            return data.get("token")
    except Exception:
        pass
    return None


def _make_mega(sid, master_key):
    """Create a Mega() instance from existing session credentials (no login)."""
    from mega import Mega
    m = Mega()
    m.sid = sid
    m.master_key = master_key
    m.sequence_num = random.randint(0, 0xFFFFFF)
    return m


def _get_mega():
    """Return an authenticated Mega instance from the saved session."""
    token = _load_saved_token()
    if not token:
        raise MegaError("Not logged in — please log in first", code="not_logged_in")
    try:
        sid, master_key = _token_to_session(token)
    except MegaError:
        # Corrupted or unreadable session file → treat as logged out.
        raise MegaError("Not logged in — please log in first", code="not_logged_in")
    return _make_mega(sid, master_key)


# ---------------------------------------------------------------------------
# Local SQLite tree index.
#
# mega.py.get_files() pulls the ENTIRE account node tree in one request (the
# MEGA API cannot list a single folder server-side), and on a large account
# that's hundreds of thousands of nodes — slow to fetch (minutes) AND, with the
# old flat-JSON cache, slow on *every* navigation: each plugin subprocess
# re-parsed the whole multi-hundred-MB blob and re-walked all nodes just to
# show one folder (measured ~6.7s per click on a 724k-node account).
#
# Instead we ingest the tree ONCE into a local SQLite file (keyed by sid, long
# TTL) and answer each list/find/download from indexed queries that touch only
# the rows they need — turning multi-second navigations into milliseconds.
# Structure and sizes are plaintext in the API response; names are decrypted
# once at ingest and stored, so search is a simple indexed LIKE.
# ---------------------------------------------------------------------------
_TREE_SCHEMA = """
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE nodes (
    handle     TEXT PRIMARY KEY,
    parent     TEXT,
    type       INTEGER,
    name       TEXT,
    name_lower TEXT,
    size       INTEGER,
    path       TEXT,
    rcount     INTEGER,
    rsize      INTEGER,
    node_json  TEXT
);
CREATE INDEX idx_parent ON nodes(parent);
CREATE INDEX idx_name_lower ON nodes(name_lower);
CREATE INDEX idx_path ON nodes(path);
"""


def _tree_db_path():
    return Path(os.environ.get("MEGA_TREE_DB") or (Path(_tempfile.gettempdir()) / ".mega_tree.sqlite"))


def _tree_fresh(sid):
    db = _tree_db_path()
    if not db.exists():
        return False
    try:
        import sqlite3, time as _time
        conn = sqlite3.connect(str(db))
        try:
            meta = {k: v for k, v in conn.execute("SELECT k, v FROM meta").fetchall()}
        finally:
            conn.close()
        if meta.get("sid") != (sid or ""):
            return False
        ttl = _int_env("MEGA_TREE_TTL", 86400)  # 24h — refetch is expensive
        return (_time.time() - float(meta.get("ts", "0"))) < ttl
    except Exception:
        return False


def _tree_conn():
    import sqlite3
    conn = sqlite3.connect(str(_tree_db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _tree_ingest(files, sid):
    """Build the SQLite index from a mega.py files dict (one-time per refresh).

    Reuses the in-memory helpers (_node_path, _folder_aggregates) to compute
    each node's full path and recursive folder size/count, then bulk-inserts.
    Writes to a .building sidecar and atomically renames so concurrent readers
    always see a complete index.
    """
    import sqlite3, time as _time
    cache = {}
    children_idx = _build_children_index(files)
    agg_memo = {}
    try:
        root_id = _get_root_id(files)
    except MegaError:
        root_id = ""

    rows = []
    for h, n in files.items():
        t = n.get("t")
        if t == 2:  # cloud-drive root
            rows.append((h, None, 2, "", "", None, "/", None, None, None))
            continue
        if t not in (0, 1):  # skip inbox/trash/unknown for browsing
            continue
        a = n.get("a") or {}
        name = a.get("n") if isinstance(a, dict) else None
        if not name:  # undecryptable / malformed → can't display or path it
            continue
        path = _node_path(h, files, cache)
        parent = n.get("p")
        if t == 0:
            rows.append((h, parent, 0, name, name.lower(), n.get("s"), path,
                         None, None, json.dumps(n)))
        else:
            cc, ts = _folder_aggregates(h, files, children_idx, agg_memo)
            rows.append((h, parent, 1, name, name.lower(), ts, path, cc, ts, None))

    db = _tree_db_path()
    tmp = str(db) + ".building"
    try:
        os.unlink(tmp)
    except OSError:
        pass
    conn = sqlite3.connect(tmp)
    try:
        conn.executescript(_TREE_SCHEMA)
        conn.executemany("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('sid', ?)", (sid or "",))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('ts', ?)", (str(_time.time()),))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('root', ?)", (root_id or "",))
        conn.commit()
    finally:
        conn.close()
    os.replace(tmp, db)  # atomic swap — readers see old or new, never partial
    print(f"[mega-import] tree indexed: {len(rows)} nodes -> {db}", file=sys.stderr)


def _get_tree(m):
    """Connection to a fresh SQLite tree index, ingesting if stale.

    Ingest is serialized across processes (flock) so concurrent download tasks
    don't each re-fetch the expensive full tree."""
    import time as _time
    sid = getattr(m, "sid", None)
    if _tree_fresh(sid):
        return _tree_conn()
    lock_dir = Path(_tempfile.gettempdir()) / "mega_tree_lock"
    with _publish_lock(lock_dir):
        if _tree_fresh(sid):  # another process ingested while we waited
            return _tree_conn()
        print("[mega-import] fetching full MEGA tree (index miss)...", file=sys.stderr)
        t0 = _time.time()
        files = m.get_files()
        print(f"[mega-import] tree fetched: {len(files)} nodes in {_time.time()-t0:.1f}s", file=sys.stderr)
        _tree_ingest(files, sid)
    return _tree_conn()


# --- indexed query helpers -------------------------------------------------

def _db_resolve(conn, path):
    """(handle, normalized_path) for a path, or raise MegaError.  Prefers a
    folder when a file and folder collide on the same path (duplicate names)."""
    path = path.rstrip("/") or "/"
    if path == "/":
        row = conn.execute("SELECT v FROM meta WHERE k='root'").fetchone()
        return (row[0] if row else ""), "/"
    row = conn.execute(
        "SELECT handle FROM nodes WHERE path=? ORDER BY type DESC LIMIT 1", (path,)
    ).fetchone()
    if not row:
        raise MegaError(f"Path not found: {path!r}", code="not_found")
    return row[0], path


def _db_children(conn, parent_handle):
    """Sorted child items (folders first, then alphabetical) for a folder."""
    out = []
    cur = conn.execute(
        "SELECT type, name, size, path, rcount, rsize FROM nodes WHERE parent=? "
        "ORDER BY type DESC, name COLLATE NOCASE", (parent_handle,))
    for r in cur:
        if r["type"] == 1:
            out.append({"type": "folder", "name": r["name"], "size": r["rsize"] or 0,
                        "child_count": r["rcount"] or 0, "total_size": r["rsize"] or 0,
                        "path": r["path"]})
        else:
            out.append({"type": "file", "name": r["name"], "size": r["size"], "path": r["path"]})
    return out


def _db_collect_files(conn, folder_handle):
    """All file rows (handle, path, size, node_json) recursively under a folder."""
    return conn.execute(
        """
        WITH RECURSIVE sub(h) AS (
            SELECT handle FROM nodes WHERE parent = ?
            UNION ALL
            SELECT n.handle FROM nodes n JOIN sub ON n.parent = sub.h
        )
        SELECT handle, path, size, node_json FROM nodes
        WHERE handle IN (SELECT h FROM sub) AND type = 0
        """, (folder_handle,)).fetchall()


# ---------------------------------------------------------------------------
# File-tree helpers.
# mega.py returns a flat {node_id: node} dict; we resolve paths by walking
# the parent chain.
# ---------------------------------------------------------------------------

def _node_path(node_id, files, cache):
    """Return the full '/' path for a node, walking the parent chain."""
    if node_id in cache:
        return cache[node_id]
    node = files.get(node_id)
    if node is None:
        cache[node_id] = "/"
        return "/"
    t = node.get("t", 0)
    if t == 2:                    # cloud drive root
        cache[node_id] = "/"
        return "/"
    if t in (3, 4):               # inbox / trash
        p = f"/_system_{t}"
        cache[node_id] = p
        return p
    name = (node.get("a") or {}).get("n", "?")
    parent_id = node.get("p")
    parent_path = _node_path(parent_id, files, cache) if parent_id else "/"
    full = ("/" + name) if parent_path == "/" else (parent_path + "/" + name)
    cache[node_id] = full
    return full


def _get_root_id(files):
    for nid, n in files.items():
        if n.get("t") == 2:
            return nid
    raise MegaError("Could not locate MEGA cloud-drive root", code="no_root")


def _find_by_path(files, path):
    """Return (node_id, node) for the given path, or raise MegaError."""
    path = path.rstrip("/") or "/"
    if path == "/":
        root_id = _get_root_id(files)
        return root_id, files[root_id]
    parts = [p for p in path.split("/") if p]
    current_id = _get_root_id(files)
    for part in parts:
        found = None
        for nid, n in files.items():
            if n.get("p") == current_id and (n.get("a") or {}).get("n") == part:
                found = nid
                break
        if found is None:
            raise MegaError(f"Path not found: {path!r}", code="not_found")
        current_id = found
    return current_id, files[current_id]


def _build_children_index(files):
    """{parent_id: [child_node_id, ...]} — built once, memoized for the call."""
    idx = {}
    for nid, n in files.items():
        p = n.get("p")
        if p:
            idx.setdefault(p, []).append(nid)
    return idx


def _folder_aggregates(folder_id, files, children_idx, memo):
    """Recursive (file_count, total_size) for everything under folder_id."""
    if folder_id in memo:
        return memo[folder_id]
    total_files = 0
    total_size = 0
    stack = [folder_id]
    seen = set()
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for cid in children_idx.get(cur, ()):
            child = files.get(cid)
            if not child:
                continue
            t = child.get("t", 0)
            if t == 0:  # file
                total_files += 1
                total_size += child.get("s") or 0
            elif t == 1:  # folder
                stack.append(cid)
    memo[folder_id] = (total_files, total_size)
    return total_files, total_size


def _list_children(files, parent_id, parent_path):
    """Return sorted [{type, name, size, path, child_count?, total_size?}] for direct children.

    Folders include `child_count` (recursive file count) and `total_size`
    (recursive byte count) so the UI can sort by smallest-first.  Files include
    only their own size.
    """
    children_idx = _build_children_index(files)
    agg_memo = {}
    items = []
    for cid in children_idx.get(parent_id, ()):
        n = files.get(cid)
        if not n:
            continue
        t = n.get("t", 0)
        if t not in (0, 1):
            continue
        name = (n.get("a") or {}).get("n", "?")
        child_path = ("/" + name) if parent_path == "/" else (parent_path + "/" + name)
        if t == 1:
            cc, ts = _folder_aggregates(cid, files, children_idx, agg_memo)
            items.append({
                "type": "folder",
                "name": name,
                "size": ts,           # recursive size for folders
                "child_count": cc,    # recursive file count
                "total_size": ts,
                "path": child_path,
            })
        else:
            items.append({
                "type": "file",
                "name": name,
                "size": n.get("s"),
                "path": child_path,
            })
    items.sort(key=lambda i: (i["type"] != "folder", i["name"].lower()))
    return items


def _collect_files_under(files, folder_id, cache, seen=None):
    """Recursively collect (path, nid, node) tuples for every file under folder_id."""
    if seen is None:
        seen = set()
    result = []
    for nid, n in files.items():
        if n.get("p") != folder_id or nid in seen:
            continue
        t = n.get("t", 0)
        if t == 0:
            result.append((_node_path(nid, files, cache), nid, n))
        elif t == 1:
            seen.add(nid)
            result.extend(_collect_files_under(files, nid, cache, seen))
    return result


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def action_check(_args):
    try:
        import importlib.metadata
        version = importlib.metadata.version("mega.py")
    except Exception:
        version = "installed"
    return {"version": f"mega.py {version}", "backend": "mega.py"}


def action_whoami(_args):
    token = _load_saved_token()
    if not token:
        return {"email": None}
    try:
        sid, master_key = _token_to_session(token)
        m = _make_mega(sid, master_key)
        user = m.get_user()
        return {"email": (user or {}).get("email")}
    except Exception:
        return {"email": None}


def action_login(args):
    session_token = (args.get("session_token") or "").strip()
    email = (args.get("email") or "").strip()
    password = args.get("password") or ""

    if session_token:
        sid, master_key = _token_to_session(session_token)
        try:
            m = _make_mega(sid, master_key)
            user = m.get_user()
        except Exception as e:
            raise MegaError(f"Session token rejected by MEGA: {e}", code="login_failed")
        user_email = (user or {}).get("email", "?")
        token = _save_session(sid, master_key)
        return {"email": user_email, "session_token": token}

    if not email or not password:
        raise MegaError("Provide email+password or session_token", code="bad_args")

    from mega import Mega
    try:
        m = Mega().login(email, password)
    except Exception as e:
        raise MegaError(f"Login failed: {e}", code="login_failed")

    try:
        user = m.get_user()
        user_email = (user or {}).get("email", email)
    except Exception:
        user_email = email

    token = _save_session(m.sid, m.master_key)
    return {"email": user_email, "session_token": token}


def action_logout(_args):
    try:
        SESSION_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    return {}


def action_list(args):
    path = (args.get("path") or "/").rstrip("/") or "/"
    m = _get_mega()
    conn = _get_tree(m)
    try:
        handle, _ = _db_resolve(conn, path)
        return _db_children(conn, handle)
    finally:
        conn.close()


def action_find(args):
    query = (args.get("query") or "").strip()
    if not query:
        raise MegaError("find requires 'query'", code="bad_args")
    search_path = (args.get("path") or "/").rstrip("/") or "/"

    # Translate the query to a SQL LIKE pattern: escape LIKE specials in the
    # literal text, then map glob wildcards (* ?) → (% _).  No wildcard ⇒
    # substring match (the old fnmatch *query* behaviour).
    esc = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    if "*" in query or "?" in query:
        like = esc.replace("*", "%").replace("?", "_")
    else:
        like = f"%{esc}%"

    m = _get_mega()
    conn = _get_tree(m)
    try:
        rows = conn.execute(
            "SELECT type, name, path FROM nodes WHERE type IN (0, 1) "
            "AND name_lower LIKE ? ESCAPE '\\'", (like.lower(),)).fetchall()
    finally:
        conn.close()

    items = []
    for r in rows:
        p = r["path"]
        if search_path != "/" and not p.startswith(search_path + "/"):
            continue
        items.append({"type": "folder" if r["type"] == 1 else "file", "name": r["name"], "path": p})
    items.sort(key=lambda i: i["path"].lower())
    return items


_SAFE_NAME_RE = None  # lazy compile


def _parse_filename_meta(name, full_path=None):
    """Best-effort metadata extraction from a filename.

    Returns a dict possibly containing:
      quality   - "1080p", "720p", "4K", "2160p", etc.
      year      - 4-digit year if found in (parens) or [brackets]
      performers - list of [Name] / {Name} bracketed performer names
      studio    - first (Studio) parenthesized phrase that isn't a year
      title     - cleaned-up title with bracket/paren content stripped
      tags      - list of common scene tags detected (POV, Anal, etc.)

    All fields are tentative; UI presents them as suggestions, not facts.
    Designed to be safe: unknown patterns just give an empty dict.
    """
    import re
    if not name:
        return {}
    base = name.rsplit(".", 1)[0]
    meta = {}

    # --- Quality ---
    q = re.search(r"\b(2160p|4k|1080p|720p|480p|360p|UHD|HD|SD)\b", base, re.IGNORECASE)
    if q:
        meta["quality"] = q.group(1).upper().replace("4K", "4K").replace("2160P", "2160p").replace("1080P", "1080p").replace("720P", "720p").replace("480P", "480p").replace("360P", "360p")

    # --- Year ---
    y = re.search(r"[\(\[](19\d{2}|20\d{2})[\)\]]", base)
    if y:
        meta["year"] = int(y.group(1))

    # --- Bracketed performers: [Name1] [Name2] or {Name1} {Name2} ---
    performers = []
    for match in re.finditer(r"[\[\{]([^\]\}]{2,40})[\]\}]", base):
        candidate = match.group(1).strip()
        # Skip if it's a year, quality, or pure number.
        if re.fullmatch(r"\d{3,4}p?|19\d{2}|20\d{2}|UHD|HD|SD|4K", candidate, re.IGNORECASE):
            continue
        performers.append(candidate)
    if performers:
        meta["performers"] = performers

    # --- Studio: first (Word) that isn't a year/quality/source tag ---
    for match in re.finditer(r"\(([^)]{2,40})\)", base):
        candidate = match.group(1).strip()
        if re.fullmatch(r"\d{4}|\d{3,4}p|UHD|HD|SD|4K|x264|x265|h264|h265|HEVC|WEB[-_ ]?DL|BluRay|BDRip|DVDRip|XXX|MP4", candidate, re.IGNORECASE):
            continue
        meta["studio"] = candidate
        break

    # --- Tags: common scene descriptors ---
    tag_patterns = ["POV", "Anal", "Lesbian", "MILF", "Teen", "Solo", "Threesome", "BBC", "Interracial", "Gangbang", "Creampie", "BDSM"]
    found_tags = []
    for t in tag_patterns:
        if re.search(rf"\b{re.escape(t)}\b", base, re.IGNORECASE):
            found_tags.append(t)
    if found_tags:
        meta["tags"] = found_tags

    # --- Source ---
    s = re.search(r"\b(WEB[-_ ]?DL|WEBRip|BluRay|BDRip|DVDRip|HDRip|HDTV|XXX)\b", base, re.IGNORECASE)
    if s:
        meta["source"] = s.group(1).upper().replace("_", "-").replace(" ", "-")

    # --- Cleaned title ---
    title = re.sub(r"[\[\{][^\]\}]*[\]\}]", " ", base)  # strip brackets
    title = re.sub(r"\([^)]*\)", " ", title)             # strip parens
    title = re.sub(r"\b(2160p|1080p|720p|480p|360p|4K|UHD|HD|SD|XXX|WEB[-_ ]?DL|WEBRip|BluRay|x264|x265|HEVC)\b", " ", title, flags=re.IGNORECASE)
    title = re.sub(r"[._\-]+", " ", title)               # collapse separators
    title = re.sub(r"\s+", " ", title).strip()
    if title and title.lower() not in {"download", base.lower()}:
        meta["title"] = title

    return meta

def _slugify_filename(name):
    """Filesystem-safe filename: keep ASCII letters/digits/._- and collapse spaces.

    Preserves the extension.  Empty/garbage names become 'download'.
    Avoids leading dots (hidden files) and reserved bare names.
    """
    import re, unicodedata
    global _SAFE_NAME_RE
    if _SAFE_NAME_RE is None:
        _SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

    if not name:
        return "download"
    # Strip path separators just in case (defensive — name should already be a leaf).
    name = name.replace("/", "_").replace("\\", "_")
    # Best-effort transliteration: 'café' → 'cafe'.
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    # Split off extension (last dot only); slugify each part separately so
    # extensions like ".jpg" survive cleanly.
    if "." in name:
        stem, ext = name.rsplit(".", 1)
    else:
        stem, ext = name, ""
    stem = _SAFE_NAME_RE.sub("_", stem).strip("._-")
    ext = _SAFE_NAME_RE.sub("", ext).strip(".")
    if not stem:
        stem = "download"
    out = f"{stem}.{ext}" if ext else stem
    # Cap at 200 chars to leave headroom for the dest path on most filesystems.
    if len(out) > 200:
        if ext:
            keep = 200 - len(ext) - 1
            out = stem[:keep] + "." + ext
        else:
            out = out[:200]
    return out


def _rescue_mac_tempfile(target_file, expected_size):
    """Rescue a download that failed mega.py's buggy MAC check.

    mega.py raises ValueError('Mismatched mac') AFTER fully writing the
    decrypted bytes to a /tmp/megapy_* temp file (it uses delete=False and
    raises before shutil.move).  Move the matching temp file into place.
    Returns True if a file of the expected size was rescued.
    """
    if expected_size is None:
        return False
    import tempfile, glob, shutil as _shutil
    tmp_dir = tempfile.gettempdir()
    candidates = [
        Path(p) for p in glob.glob(str(Path(tmp_dir) / "megapy_*"))
        if Path(p).is_file()
    ]
    # Most-recent first, take the first exact size match.
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for cand in candidates:
        try:
            if cand.stat().st_size == expected_size:
                _shutil.move(str(cand), str(target_file))
                return True
        except Exception:
            continue
    return False


# ---------------------------------------------------------------------------
# Anti-NFS-saturation: local staging + serialized, paced publish.
#
# A full import once froze the whole host.  mega.py downloads each file to a
# local /tmp temp, then shutil.move()s it to the dest.  When the dest is on NFS
# (a *different* filesystem) that move becomes a full copy to NFS, and several
# concurrent downloads stack multi-GB writes onto the mount → unbounded dirty
# pages → writeback burst → iowait storm → the VM hangs (recoverable only by
# power-cycle).  See mega-import-batch-redesign.md.
#
# Fix: when the dest is a network filesystem, download to a LOCAL staging dir
# (parallel, never touches NFS) then PUBLISH each file to the dest one-at-a-time
# across all concurrent plugin processes (cross-process lock), copying in chunks
# with periodic fdatasync so dirty pages stay bounded.  On a local-disk dest the
# staging is skipped entirely — no penalty, the current fast path is preserved.
# ---------------------------------------------------------------------------
import contextlib

# POSIX-only primitives — guard so the module still imports on Windows/macOS.
try:
    import fcntl as _fcntl
except ImportError:
    _fcntl = None
try:
    import msvcrt as _msvcrt
except ImportError:
    _msvcrt = None

# fdatasync flushes data without the metadata round-trip; Linux-only.
_fdatasync = getattr(os, "fdatasync", os.fsync)

_NETWORK_FSTYPES = {
    "nfs", "nfs4", "cifs", "smbfs", "smb3", "fuse.nfs", "fuse.glusterfs", "ceph",
}


def _staging_dir():
    import tempfile
    return Path(os.environ.get("MEGA_STAGING_DIR") or (Path(tempfile.gettempdir()) / "mega_stage"))


def _is_network_fs(path):
    """True if `path` lives on a network filesystem (NFS/CIFS/…).

    Linux-only via /proc/mounts; returns False everywhere else and on any
    error, so non-Linux hosts always take the direct/local fast path.
    """
    if not sys.platform.startswith("linux"):
        return False
    try:
        target = os.path.realpath(str(path))
        best_mp, best_fstype = "", ""
        with open("/proc/mounts", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mp, fstype = parts[1], parts[2]
                if (target == mp or target.startswith(mp.rstrip("/") + "/")) and len(mp) >= len(best_mp):
                    best_mp, best_fstype = mp, fstype
        return best_fstype in _NETWORK_FSTYPES
    except Exception:
        return False


def _should_stage(dest_path):
    """Whether to use local staging + serialized publish for this dest.

    MEGA_STAGING=1/on/force → always; =0/off → never; otherwise auto-detect
    (stage only when the dest is a network filesystem).
    """
    flag = (os.environ.get("MEGA_STAGING") or "").strip().lower()
    if flag in ("0", "off", "false", "no"):
        return False
    if flag in ("1", "on", "true", "yes", "force"):
        return True
    return _is_network_fs(dest_path)


def _int_env(name, default):
    try:
        v = int(os.environ.get(name) or 0)
        return v if v > 0 else default
    except ValueError:
        return default


@contextlib.contextmanager
def _publish_lock(lock_dir):
    """Cross-process exclusive lock: only ONE file is written to the dest at a
    time, no matter how many concurrent download processes run.

    Each download is a separate `python mega_import.py` process, so an
    in-process lock would not help — this uses fcntl.flock on POSIX, msvcrt on
    Windows, and degrades to a best-effort no-op if neither is available.
    """
    lock_dir.mkdir(parents=True, exist_ok=True)
    fh = open(lock_dir / ".publish.lock", "a+")
    try:
        if _fcntl is not None:
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
        elif _msvcrt is not None:
            fh.seek(0)
            _msvcrt.locking(fh.fileno(), _msvcrt.LK_LOCK, 1)
        yield
    finally:
        try:
            if _fcntl is not None:
                _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)
            elif _msvcrt is not None:
                fh.seek(0)
                _msvcrt.locking(fh.fileno(), _msvcrt.LK_UNLCK, 1)
        except Exception:
            pass
        fh.close()


def _publish(src, dst, lock_dir):
    """Move staged file `src` → final `dst` without flooding the dest FS.

    Serialized across processes (one writer), copied in chunks with periodic
    fdatasync so kernel dirty pages stay bounded (no writeback burst → no
    iowait storm), and published atomically via a `.part` sidecar + os.replace
    so Stash never scans a half-written file.  Optional MB/s cap via
    MEGA_PUBLISH_BWLIMIT.
    """
    import time as _time

    chunk = _int_env("MEGA_PUBLISH_CHUNK", 16 << 20)              # 16 MB reads
    fsync_every = _int_env("MEGA_PUBLISH_FSYNC_EVERY", 128 << 20)  # fdatasync cadence
    try:
        bwlimit = float(os.environ.get("MEGA_PUBLISH_BWLIMIT") or 0)  # MB/s, 0=off
    except ValueError:
        bwlimit = 0.0

    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(dst) + ".part"

    with _publish_lock(lock_dir):
        written = since = 0
        t0 = _time.monotonic()
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            while True:
                buf = fi.read(chunk)
                if not buf:
                    break
                fo.write(buf)
                written += len(buf)
                since += len(buf)
                if since >= fsync_every:
                    fo.flush()
                    _fdatasync(fo.fileno())
                    since = 0
                if bwlimit > 0:
                    expected = written / (bwlimit * 1_000_000)
                    dt = expected - (_time.monotonic() - t0)
                    if dt > 0:
                        _time.sleep(dt)
            fo.flush()
            _fdatasync(fo.fileno())
        os.replace(tmp, dst)  # atomic publish
    try:
        src.unlink()
    except OSError:
        pass


def _await_staging_capacity(staging_dir):
    """Backpressure: block until staged-but-unpublished bytes are under the cap
    so parallel downloads can't outrun the serialized publisher and fill the
    local disk.  Best-effort, bounded by a safety deadline."""
    import time as _time
    cap = _int_env("MEGA_MAX_STAGED_BYTES", 8 << 30)  # 8 GB
    if cap <= 0:
        return
    deadline = _time.monotonic() + 1800  # 30 min safety cap — never wait forever
    warned = False
    while _time.monotonic() < deadline:
        staged = 0
        try:
            for p in staging_dir.glob("*"):
                if p.is_file() and p.name != ".publish.lock":
                    try:
                        staged += p.stat().st_size
                    except OSError:
                        pass
        except OSError:
            return
        if staged < cap:
            return
        if not warned:
            print(f"[mega-import] backpressure: {staged}B staged ≥ cap {cap}B — waiting for publisher", file=sys.stderr)
            warned = True
        _time.sleep(2)


def _download_one(m, file_nid, file_node, dest_path, fname, target_file, expected_size, file_path, staging_dir=None):
    """Download a single MEGA file with file-level resume, retry/backoff, and
    (when staging_dir is given) local-staging + serialized publish to the dest.

    Returns a result dict for the items list.  Retries transient failures
    (network blips, mega.py request errors, publish errors) up to
    MEGA_DOWNLOAD_RETRIES times; skips files already present at full size so
    re-running an interrupted import is cheap and idempotent.
    """
    import time as _time

    # Resume: a complete copy already at the destination → skip the transfer.
    # mega.py writes to a temp file and only moves on success, so a file at
    # `target_file` of the right size is genuinely complete, not partial.
    if expected_size is not None and target_file.exists():
        try:
            if target_file.stat().st_size == expected_size:
                print(f"[mega-import] skip (already complete): {target_file}", file=sys.stderr)
                return {"path": file_path, "status": "ok", "saved_as": fname, "skipped": True}
        except OSError:
            pass

    # Where mega.py writes: a local staging dir (then we publish to the dest),
    # or straight to the dest (local-disk dest — no NFS hazard, fast path).
    fetch_dir = staging_dir if staging_dir is not None else dest_path
    fetch_target = (staging_dir / fname) if staging_dir is not None else target_file

    retries = max(1, _int_env("MEGA_DOWNLOAD_RETRIES", 3))

    def _attempt():
        """One full fetch (+ publish if staging). Returns a warning string or
        None on success; raises on failure."""
        warning = None
        try:
            # mega.py expects file=(nid, node_dict). The method is `download`,
            # NOT `download_file` (that name doesn't exist on the Mega class).
            m.download((file_nid, file_node), dest_path=str(fetch_dir), dest_filename=fname)
        except ValueError as e:
            # mega.py's post-download MAC verification is buggy for many files
            # (https://github.com/odwyersoftware/mega.py/issues/61).  The fully
            # decrypted bytes are still in /tmp/megapy_* — rescue them into the
            # fetch dir, then fall through to publish.
            if "mismatched mac" in str(e).lower() and _rescue_mac_tempfile(fetch_target, expected_size):
                warning = "mac-check-skipped"
                print(f"[mega-import] MAC failed but rescued temp file → {fetch_target} ({expected_size}b)", file=sys.stderr)
            else:
                raise
        if staging_dir is not None:
            _publish(fetch_target, target_file, staging_dir)
        return warning

    last_err = None
    for attempt in range(1, retries + 1):
        try:
            warning = _attempt()
            result = {"path": file_path, "status": "ok", "saved_as": fname}
            if warning:
                result["warning"] = warning
            return result
        except ValueError as e:
            last_err = f"ValueError: {str(e)[:400]}"
        except Exception as e:
            last_err = f"{type(e).__name__}: {str(e)[:400]}"

        if attempt < retries:
            backoff = min(2 ** (attempt - 1), 15)
            print(
                f"[mega-import] download attempt {attempt}/{retries} failed for "
                f"{file_path!r}: {last_err} — retrying in {backoff}s",
                file=sys.stderr,
            )
            _time.sleep(backoff)

    print(f"[mega-import] download failed path={file_path!r} after {retries} attempts: {last_err}", file=sys.stderr)
    return {"path": file_path, "status": "error", "error": last_err}


def action_download(args):
    paths = args.get("paths") or []
    dest = args.get("dest") or DEFAULT_DEST
    # Optional override: caller-supplied filename to save the file as.
    # If present, applies ONLY when `paths` has exactly one entry (the JS bridge
    # always sends one path per download call).  Slugified before use.
    forced_name = args.get("dest_filename")
    dest_path = Path(dest).expanduser().resolve()
    dest_path.mkdir(parents=True, exist_ok=True)

    # Anti-NFS-saturation: when the dest is a network filesystem, download to a
    # local staging dir and publish serialized + fsync-paced (see _publish).
    # Local dest → no staging, direct download (unchanged fast path).
    staging_dir = None
    if _should_stage(dest_path):
        staging_dir = _staging_dir()
        staging_dir.mkdir(parents=True, exist_ok=True)
        print(f"[mega-import] NFS-safe mode: staging in {staging_dir} → serialized publish to {dest_path}", file=sys.stderr)

    m = _get_mega()
    conn = _get_tree(m)
    items = []
    try:
        for remote in paths:
            if not remote.startswith("/"):
                remote = "/" + remote
            try:
                handle, _ = _db_resolve(conn, remote)
            except MegaError:
                items.append({"path": remote, "status": "error", "error": "Path not found in MEGA"})
                continue
            trow = conn.execute("SELECT type FROM nodes WHERE handle=?", (handle,)).fetchone()
            is_folder = trow is not None and trow["type"] == 1
            if is_folder:
                file_rows = _db_collect_files(conn, handle)
            else:
                fr = conn.execute(
                    "SELECT handle, path, size, node_json FROM nodes WHERE handle=?", (handle,)
                ).fetchone()
                file_rows = [fr] if fr else []
            for fr in file_rows:
                file_path = fr["path"]
                file_nid = fr["handle"]
                file_node = json.loads(fr["node_json"]) if fr["node_json"] else {}
                raw_fname = (file_node.get("a") or {}).get("n", "download")
                # Caller-supplied name wins (the "rename from folder" toggle in
                # the preview modal). Single-file calls only — for recursive
                # folder downloads the override doesn't make sense.
                if forced_name and len(paths) == 1 and not is_folder:
                    fname = _slugify_filename(forced_name)
                else:
                    fname = _slugify_filename(raw_fname)
                expected_size = fr["size"]
                target_file = dest_path / fname
                # Backpressure: don't let parallel downloads outrun the publisher.
                if staging_dir is not None:
                    _await_staging_capacity(staging_dir)
                print(f"[mega-import] downloading {file_path!r} → {target_file} (raw={raw_fname!r}, size={expected_size})", file=sys.stderr)
                items.append(_download_one(
                    m, file_nid, file_node, dest_path, fname, target_file, expected_size, file_path, staging_dir
                ))
    finally:
        conn.close()

    return {"dest": str(dest_path), "items": items}


# ---------------------------------------------------------------------------
# Background download queue (survives the UI / browser).
#
# Stash kills a plugin subprocess the moment the client (browser) disconnects,
# so a synchronous download dies when the tab closes.  Both Stash and the
# downloads run on the same (often remote) host — the browser is just a remote
# control and shouldn't need to stay open.  So we enqueue files to a JSON queue
# and process them in a DETACHED worker process (NOT a child of the
# runPluginOperation call, so Stash can't kill it).  The UI only enqueues and
# polls status; closing the tab leaves the worker downloading.
# ---------------------------------------------------------------------------
_SERVER_CONNECTION = {}


def _now():
    import time as _t
    return _t.time()


def _queue_file():
    return Path(os.environ.get("MEGA_QUEUE_FILE") or (Path(_tempfile.gettempdir()) / "mega_queue.json"))


def _queue_lock_dir():
    return Path(_tempfile.gettempdir()) / "mega_queue_lock"


def _load_queue():
    try:
        return json.loads(_queue_file().read_text(encoding="utf-8"))
    except Exception:
        return {"items": [], "worker_pid": None, "active": False, "updated_at": 0}


def _save_queue(q):
    q["updated_at"] = _now()
    p = _queue_file()
    tmp = str(p) + ".tmp"
    Path(tmp).write_text(json.dumps(q), encoding="utf-8")
    os.replace(tmp, p)


def _pid_alive(pid):
    if not pid:
        return False
    try:
        pid = int(pid)
        if sys.platform.startswith("win"):
            import ctypes
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            return code.value == 259  # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _spawn_worker(server_connection):
    import subprocess
    payload = json.dumps({"action": "__worker", "server_connection": server_connection or {}}).encode("utf-8")
    logf = open(str(_queue_file()) + ".worker.log", "ab")
    kwargs = {"stdin": subprocess.PIPE, "stdout": logf, "stderr": logf, "close_fds": True}
    if sys.platform.startswith("win"):
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP → not tied to Stash's job
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True  # new session → survives parent death
    proc = subprocess.Popen([sys.executable, os.path.abspath(__file__)], **kwargs)
    try:
        proc.stdin.write(payload)
        proc.stdin.close()
    except Exception:
        pass
    return proc.pid


def _ensure_worker(server_connection):
    with _publish_lock(_queue_lock_dir()):
        q = _load_queue()
        if q.get("worker_pid") and _pid_alive(q["worker_pid"]):
            return q["worker_pid"]
        pid = _spawn_worker(server_connection)
        q["worker_pid"] = pid
        q["active"] = True
        _save_queue(q)
        return pid


def action_enqueue(args):
    """Expand the requested paths to individual files and append them to the
    background queue, then ensure the detached worker is running.  Returns
    immediately — the worker downloads independently of the UI."""
    paths = args.get("paths") or []
    dest = args.get("dest") or DEFAULT_DEST
    forced_name = args.get("dest_filename")
    dest_abs = str(Path(dest).expanduser().resolve())

    m = _get_mega()
    conn = _get_tree(m)
    new_items, errors = [], []
    try:
        for remote in paths:
            if not remote.startswith("/"):
                remote = "/" + remote
            try:
                handle, _ = _db_resolve(conn, remote)
            except MegaError:
                errors.append({"path": remote, "error": "Path not found in MEGA"})
                continue
            trow = conn.execute("SELECT type FROM nodes WHERE handle=?", (handle,)).fetchone()
            is_folder = trow is not None and trow["type"] == 1
            if is_folder:
                files = [(r["path"], r["size"]) for r in _db_collect_files(conn, handle)]
            else:
                fr = conn.execute("SELECT path, size FROM nodes WHERE handle=?", (handle,)).fetchone()
                files = [(fr["path"], fr["size"])] if fr else []
            single = (len(paths) == 1 and not is_folder)
            for fp, sz in files:
                new_items.append({
                    "path": fp, "size": sz, "dest": dest_abs,
                    "dest_filename": forced_name if single else None,
                    "status": "pending", "error": None, "saved_as": None, "added_at": _now(),
                })
    finally:
        conn.close()

    ids = []
    with _publish_lock(_queue_lock_dir()):
        q = _load_queue()
        base = len(q["items"])
        stamp = int(_now())
        for i, it in enumerate(new_items):
            it["id"] = f"{stamp}-{base + i}"
            ids.append(it["id"])
        q["items"].extend(new_items)
        _save_queue(q)

    pid = _ensure_worker(_SERVER_CONNECTION)
    return {"queued": len(new_items), "ids": ids, "errors": errors, "worker_pid": pid}


def action_queue_status(_args):
    q = _load_queue()
    items = q.get("items", [])
    counts = {}
    for it in items:
        counts[it["status"]] = counts.get(it["status"], 0) + 1
    return {
        "items": items,
        "counts": counts,
        "worker_alive": bool(q.get("worker_pid") and _pid_alive(q["worker_pid"])),
        "updated_at": q.get("updated_at", 0),
    }


def action_queue_clear(args):
    """Drop queue items.  By default removes everything except the file
    currently downloading; pass only_done=true to keep pending+downloading."""
    only_done = bool(args.get("only_done"))
    with _publish_lock(_queue_lock_dir()):
        q = _load_queue()
        keep = ("pending", "downloading") if only_done else ("downloading",)
        q["items"] = [it for it in q["items"] if it["status"] in keep]
        _save_queue(q)
    return {"remaining": len(_load_queue().get("items", []))}


def _worker_download(m, conn, item):
    """Download one queued file (path → node → _download_one)."""
    dest_path = Path(item["dest"]).expanduser().resolve()
    dest_path.mkdir(parents=True, exist_ok=True)
    staging_dir = None
    if _should_stage(dest_path):
        staging_dir = _staging_dir()
        staging_dir.mkdir(parents=True, exist_ok=True)
    row = conn.execute(
        "SELECT handle, size, node_json FROM nodes WHERE path=? AND type=0 LIMIT 1", (item["path"],)
    ).fetchone()
    if not row or not row["node_json"]:
        return {"status": "error", "error": "file no longer in tree index"}
    file_node = json.loads(row["node_json"])
    raw = (file_node.get("a") or {}).get("n", "download")
    fname = _slugify_filename(item.get("dest_filename") or raw)
    target = dest_path / fname
    if staging_dir is not None:
        _await_staging_capacity(staging_dir)
    return _download_one(m, row["handle"], file_node, dest_path, fname, target,
                         row["size"], item["path"], staging_dir)


def _gql(server_connection, query, variables=None):
    import requests
    sc = server_connection or {}
    scheme = (sc.get("Scheme") or "http").lower()
    port = sc.get("Port") or 9999
    url = f"{scheme}://localhost:{port}/graphql"
    cookies = {}
    sk = sc.get("SessionCookie") or {}
    if sk.get("Name"):
        cookies[sk["Name"]] = sk.get("Value", "")
    r = requests.post(url, json={"query": query, "variables": variables or {}}, cookies=cookies, timeout=120)
    return r.json()


def _post_import(server_connection, dests):
    """After the queue drains: register each dest as a library path and trigger
    a scan — via Stash's GraphQL using the session from server_connection — so
    imports appear without the UI doing anything."""
    if not server_connection or not dests:
        return
    try:
        cfg = _gql(server_connection, "{configuration{general{stashes{path excludeImage excludeVideo}}}}")
        stashes = (((cfg or {}).get("data") or {}).get("configuration") or {}).get("general", {}).get("stashes", []) or []
    except Exception as e:
        print(f"[mega-import] post-import: cannot read config: {e}", file=sys.stderr)
        return
    have = {s["path"] for s in stashes}
    to_add = [d for d in dests if d not in have]
    if to_add:
        newst = [{"path": s["path"], "excludeImage": s.get("excludeImage", False),
                  "excludeVideo": s.get("excludeVideo", False)} for s in stashes]
        newst += [{"path": d, "excludeImage": False, "excludeVideo": False} for d in to_add]
        _gql(server_connection,
             "mutation($i:ConfigGeneralInput!){configureGeneral(input:$i){stashes{path}}}",
             {"i": {"stashes": newst}})
        print(f"[mega-import] post-import: added to library: {to_add}", file=sys.stderr)
    _gql(server_connection, "mutation{metadataScan(input:{})}")
    print("[mega-import] post-import: scan triggered", file=sys.stderr)


def _worker_loop(server_connection):
    print(f"[mega-import] worker started pid={os.getpid()}", file=sys.stderr)
    with _publish_lock(_queue_lock_dir()):
        q = _load_queue()
        q["worker_pid"] = os.getpid()
        q["active"] = True
        _save_queue(q)
    try:
        m = _get_mega()
        conn = _get_tree(m)
    except Exception as e:
        print(f"[mega-import] worker auth/tree failed: {e}", file=sys.stderr)
        with _publish_lock(_queue_lock_dir()):
            q = _load_queue()
            q["active"] = False
            q["worker_pid"] = None
            for it in q["items"]:
                if it["status"] in ("pending", "downloading"):
                    it["status"] = "error"
                    it["error"] = f"worker: {e}"
            _save_queue(q)
        return

    dests = set()
    try:
        while True:
            with _publish_lock(_queue_lock_dir()):
                q = _load_queue()
                item = next((it for it in q["items"] if it["status"] == "pending"), None)
                if item is None:
                    q["active"] = False
                    q["worker_pid"] = None
                    _save_queue(q)
                    break
                item["status"] = "downloading"
                item["started_at"] = _now()
                _save_queue(q)
            try:
                res = _worker_download(m, conn, item)
            except Exception as e:
                res = {"status": "error", "error": f"{type(e).__name__}: {str(e)[:400]}"}
            dests.add(item["dest"])
            with _publish_lock(_queue_lock_dir()):
                q = _load_queue()
                for it in q["items"]:
                    if it.get("id") == item["id"]:
                        it.update(res)
                        it["finished_at"] = _now()
                _save_queue(q)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    try:
        _post_import(server_connection, dests)
    except Exception as e:
        print(f"[mega-import] post-import failed: {e}", file=sys.stderr)
    print("[mega-import] worker finished", file=sys.stderr)


def action_temp_progress(args):
    """Snapshot of active mega.py download temp files.

    Returns [{name, size, mtime, age_s}] for every /tmp/megapy_* file.
    The frontend uses this to plot the REAL byte progress for in-flight
    downloads (matched heuristically against the rows it knows are downloading).

    Also opportunistically prunes anything older than 1 hour — orphan temp
    files from failed downloads accumulate quickly with multi-GB transfers.
    """
    import tempfile, glob, time as _time
    tmp_dir = tempfile.gettempdir()
    out = []
    cutoff_orphan = _time.time() - 3600  # 1h
    pruned = 0
    for path in glob.glob(str(Path(tmp_dir) / "megapy_*")):
        try:
            st = Path(path).stat()
        except OSError:
            continue
        # Auto-prune ancient temp files (download long since failed/abandoned).
        if st.st_mtime < cutoff_orphan:
            try:
                Path(path).unlink()
                pruned += 1
                continue
            except OSError:
                pass
        out.append({
            "name": Path(path).name,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "age_s": int(_time.time() - st.st_mtime),
        })
    out.sort(key=lambda x: x["mtime"])
    return {"files": out, "pruned_orphans": pruned, "now": _time.time()}


def action_cleanup_temp(args):
    """Delete every /tmp/megapy_* temp and staged-but-unpublished file
    regardless of age.  Use sparingly — will trash an in-flight download or a
    file mid-publish if you hit it during one.  Frontend surfaces this as a
    Settings button."""
    import tempfile, glob
    tmp_dir = tempfile.gettempdir()
    deleted = 0
    bytes_freed = 0
    # mega.py download temps + staging-dir orphans (staged files + .part sidecars).
    targets = glob.glob(str(Path(tmp_dir) / "megapy_*"))
    staging = _staging_dir()
    if staging.exists():
        for p in staging.glob("*"):
            if p.is_file() and p.name != ".publish.lock":
                targets.append(str(p))
    for path in targets:
        try:
            sz = Path(path).stat().st_size
            Path(path).unlink()
            deleted += 1
            bytes_freed += sz
        except OSError:
            continue
    return {"deleted": deleted, "bytes_freed": bytes_freed}


def action_preview(args):
    """Recursively expand the selected paths and return a preview manifest:
      { total_files, total_size, by_ext: {ext: {count, bytes}}, files: [{path, size, ext}] }
    No download happens.  Used by the UI to show a confirm dialog before
    committing to a multi-GB folder import.
    """
    paths = args.get("paths") or []
    m = _get_mega()
    conn = _get_tree(m)

    out_files = []
    try:
        for remote in paths:
            if not remote.startswith("/"):
                remote = "/" + remote
            try:
                handle, _ = _db_resolve(conn, remote)
            except MegaError:
                continue
            trow = conn.execute("SELECT type, path, size FROM nodes WHERE handle=?", (handle,)).fetchone()
            if trow is None:
                continue
            if trow["type"] == 1:
                leafs = [(r["path"], r["size"]) for r in _db_collect_files(conn, handle)]
            else:
                leafs = [(trow["path"], trow["size"])]
            for fp, sz in leafs:
                sz = sz or 0
                ext = fp.rsplit(".", 1)[-1].lower() if "." in fp else ""
                out_files.append({"path": fp, "size": sz, "ext": ext})
    finally:
        conn.close()

    by_ext = {}
    for f in out_files:
        bucket = by_ext.setdefault(f["ext"], {"count": 0, "bytes": 0})
        bucket["count"] += 1
        bucket["bytes"] += f["size"]

    return {
        "total_files": len(out_files),
        "total_size": sum(f["size"] for f in out_files),
        "by_ext": by_ext,
        "files": out_files,
    }


ACTIONS = {
    "check": action_check,
    "whoami": action_whoami,
    "login": action_login,
    "logout": action_logout,
    "list": action_list,
    "find": action_find,
    "preview": action_preview,
    "temp_progress": action_temp_progress,
    "cleanup_temp": action_cleanup_temp,
    "download": action_download,
    "enqueue": action_enqueue,
    "queue_status": action_queue_status,
    "queue_clear": action_queue_clear,
}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _write(result, error):
    """Write {"output": result, "error": error} and exit."""
    sys.stdout.write(json.dumps({"output": result, "error": error}))
    sys.stdout.flush()
    # Always exit 0: errors are encoded in the JSON payload so Stash routes them
    # through runPluginOperation's GraphQL error rather than crashing the job.
    sys.exit(0)


def main():
    # Read the args JSON as UTF-8 explicitly — reading via the text wrapper can
    # use the platform codec (cp1252 on Windows) and corrupt non-ASCII paths.
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
    except Exception:
        raw = sys.stdin.read()
    if not raw.strip():
        _write(None, "empty stdin")
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        _write(None, f"invalid JSON: {e}")
        return

    # Stash wraps task args: {"args": {...}, "server_connection": {...}}
    args = payload.get("args") if isinstance(payload, dict) and "args" in payload else payload
    if not isinstance(args, dict):
        _write(None, "args must be an object")
        return

    # Capture the server connection (scheme/port/session cookie) so the detached
    # worker can call back into Stash (library-add + scan) after downloading.
    global _SERVER_CONNECTION
    if isinstance(payload, dict) and isinstance(payload.get("server_connection"), dict):
        _SERVER_CONNECTION = payload["server_connection"]

    action = args.get("action")
    if not action:
        _write(None, "missing 'action'")
        return

    # The detached background worker is not a normal request/response action —
    # it loops until the queue drains and writes status to the queue file.
    if action == "__worker":
        _worker_loop(_SERVER_CONNECTION)
        sys.exit(0)

    handler = ACTIONS.get(action)
    if not handler:
        _write(None, f"unknown action '{action}'. valid: {sorted(ACTIONS)}")
        return

    try:
        result = handler(args)
        _write(result, None)
    except MegaError as e:
        _write(None, str(e))
    except Exception as e:
        _write(None, f"unhandled error: {e}")


if __name__ == "__main__":
    main()
