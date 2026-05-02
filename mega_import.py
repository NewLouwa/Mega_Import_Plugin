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
import fnmatch
import json
import os
import random
import sys
from pathlib import Path

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
    num_workers = min(os.cpu_count() or 1, 8)
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

SESSION_FILE = Path(os.environ.get("MEGA_SESSION_FILE", "/tmp/.mega_session.json"))

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


# Cache the full MEGA file tree across action invocations.
# mega.py.get_files() pulls the entire account metadata in one request; for
# multi-TB accounts that's 30s-3min.  Each Stash plugin call spawns a fresh
# subprocess, so we persist the cache to /tmp keyed by sid to amortize.
_FILES_CACHE = {"sid": None, "files": None, "ts": 0.0}
_FILES_CACHE_TTL = 3600  # 1 hour
_FILES_CACHE_FILE = Path("/tmp/.mega_files_cache.json")


def _cached_get_files(m):
    import time as _time
    sid = getattr(m, "sid", None)
    now = _time.time()

    # In-memory hit (same process)
    if (
        _FILES_CACHE["sid"] == sid
        and _FILES_CACHE["files"] is not None
        and (now - _FILES_CACHE["ts"]) < _FILES_CACHE_TTL
    ):
        return _FILES_CACHE["files"]

    # On-disk hit (across subprocesses)
    if _FILES_CACHE_FILE.exists():
        try:
            blob = json.loads(_FILES_CACHE_FILE.read_text())
            if blob.get("sid") == sid and (now - blob.get("ts", 0)) < _FILES_CACHE_TTL:
                files = blob["files"]
                _FILES_CACHE.update(sid=sid, files=files, ts=blob["ts"])
                print(f"[mega-import] tree cache hit ({len(files)} nodes)", file=sys.stderr)
                return files
        except Exception as e:
            print(f"[mega-import] cache read failed: {e}", file=sys.stderr)

    print("[mega-import] fetching full MEGA tree (cache miss)...", file=sys.stderr)
    t0 = _time.time()
    files = m.get_files()
    print(f"[mega-import] tree fetched: {len(files)} nodes in {_time.time()-t0:.1f}s", file=sys.stderr)
    _FILES_CACHE.update(sid=sid, files=files, ts=now)
    try:
        _FILES_CACHE_FILE.write_text(json.dumps({"sid": sid, "files": files, "ts": now}))
    except Exception as e:
        print(f"[mega-import] cache write failed: {e}", file=sys.stderr)
    return files


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
    files = _cached_get_files(m)
    cache = {}
    node_id, _node = _find_by_path(files, path)
    cache[node_id] = path
    return _list_children(files, node_id, path)


def action_find(args):
    query = (args.get("query") or "").strip()
    if not query:
        raise MegaError("find requires 'query'", code="bad_args")
    search_path = (args.get("path") or "/").rstrip("/") or "/"
    pattern = query if ("*" in query or "?" in query) else f"*{query}*"

    m = _get_mega()
    files = _cached_get_files(m)
    cache = {}
    items = []
    for nid, n in files.items():
        t = n.get("t", 0)
        if t not in (0, 1):
            continue
        name = (n.get("a") or {}).get("n", "")
        if not fnmatch.fnmatch(name.lower(), pattern.lower()):
            continue
        full_path = _node_path(nid, files, cache)
        if search_path != "/" and not full_path.startswith(search_path + "/"):
            continue
        items.append({"type": "folder" if t == 1 else "file", "name": name, "path": full_path})
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


def action_download(args):
    paths = args.get("paths") or []
    dest = args.get("dest") or DEFAULT_DEST
    # Optional override: caller-supplied filename to save the file as.
    # If present, applies ONLY when `paths` has exactly one entry (the JS bridge
    # always sends one path per download call).  Slugified before use.
    forced_name = args.get("dest_filename")
    dest_path = Path(dest).expanduser().resolve()
    dest_path.mkdir(parents=True, exist_ok=True)

    m = _get_mega()
    files = _cached_get_files(m)
    cache = {}

    # Build path → (nid, node) map once.
    path_to_node = {}
    for nid, n in files.items():
        if n.get("t") in (0, 1):
            p = _node_path(nid, files, cache)
            path_to_node[p] = (nid, n)

    items = []
    for remote in paths:
        if not remote.startswith("/"):
            remote = "/" + remote
        entry = path_to_node.get(remote)
        if entry is None:
            items.append({"path": remote, "status": "error", "error": "Path not found in MEGA"})
            continue
        nid, node = entry
        to_download = (
            _collect_files_under(files, nid, cache)
            if node.get("t") == 1
            else [(remote, nid, node)]
        )
        for file_path, file_nid, file_node in to_download:
            raw_fname = (file_node.get("a") or {}).get("n", "download")
            # Caller-supplied name wins (used by the "rename from folder" toggle
            # in the preview modal). Single-file calls only — for recursive
            # folder downloads the override doesn't make sense.
            if forced_name and len(paths) == 1 and node.get("t") == 0:
                fname = _slugify_filename(forced_name)
            else:
                fname = _slugify_filename(raw_fname)
            expected_size = file_node.get("s")
            target_file = dest_path / fname
            print(f"[mega-import] downloading {file_path!r} → {target_file} (raw={raw_fname!r}, size={expected_size})", file=sys.stderr)
            try:
                # mega.py expects file=(nid, node_dict). The method is `download`,
                # NOT `download_file` (that name doesn't exist on the Mega class).
                m.download((file_nid, file_node), dest_path=str(dest_path), dest_filename=fname)
                items.append({"path": file_path, "status": "ok", "saved_as": fname})
            except ValueError as e:
                # mega.py's post-download MAC verification is buggy for many files
                # (https://github.com/odwyersoftware/mega.py/issues/61).  When it
                # raises, the fully-downloaded bytes are still sitting in a temp
                # file like /tmp/megapy_XXXXX (mega.py used delete=False and
                # raises BEFORE shutil.move()).  Find that orphan and move it.
                if "mismatched mac" in str(e).lower() and expected_size is not None:
                    import tempfile, glob, shutil as _shutil
                    tmp_dir = tempfile.gettempdir()
                    candidates = [
                        Path(p) for p in glob.glob(str(Path(tmp_dir) / "megapy_*"))
                        if Path(p).is_file()
                    ]
                    # Most-recent first, prefer exact size match.
                    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                    rescued = None
                    for cand in candidates:
                        try:
                            if cand.stat().st_size == expected_size:
                                _shutil.move(str(cand), str(target_file))
                                rescued = target_file
                                break
                        except Exception:
                            continue
                    if rescued is not None:
                        print(f"[mega-import] MAC failed but rescued temp file → {rescued} ({expected_size}b)", file=sys.stderr)
                        items.append({"path": file_path, "status": "ok", "warning": "mac-check-skipped", "saved_as": fname})
                        continue
                    print(f"[mega-import] download failed path={file_path!r}: ValueError: {e} (no rescuable temp file in {tmp_dir})", file=sys.stderr)
                    items.append({"path": file_path, "status": "error", "error": f"ValueError: {str(e)[:400]}"})
                else:
                    print(f"[mega-import] download failed path={file_path!r}: ValueError: {e}", file=sys.stderr)
                    items.append({"path": file_path, "status": "error", "error": f"ValueError: {str(e)[:400]}"})
            except Exception as e:
                print(f"[mega-import] download failed path={file_path!r}: {type(e).__name__}: {e}", file=sys.stderr)
                items.append({"path": file_path, "status": "error", "error": f"{type(e).__name__}: {str(e)[:400]}"})

    return {"dest": str(dest_path), "items": items}


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
    """Delete every /tmp/megapy_* file regardless of age.  Use sparingly —
    will trash an in-flight download if you hit it during one.  Frontend
    surfaces this as a Settings button."""
    import tempfile, glob
    tmp_dir = tempfile.gettempdir()
    deleted = 0
    bytes_freed = 0
    for path in glob.glob(str(Path(tmp_dir) / "megapy_*")):
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
    files = _cached_get_files(m)
    cache = {}

    path_to_node = {}
    for nid, n in files.items():
        if n.get("t") in (0, 1):
            p = _node_path(nid, files, cache)
            path_to_node[p] = (nid, n)

    out_files = []
    for remote in paths:
        if not remote.startswith("/"):
            remote = "/" + remote
        entry = path_to_node.get(remote)
        if entry is None:
            continue
        nid, node = entry
        leafs = _collect_files_under(files, nid, cache) if node.get("t") == 1 else [(remote, nid, node)]
        for fp, _fnid, fnode in leafs:
            sz = fnode.get("s") or 0
            ext = fp.rsplit(".", 1)[-1].lower() if "." in fp else ""
            out_files.append({"path": fp, "size": sz, "ext": ext})

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

    action = args.get("action")
    if not action:
        _write(None, "missing 'action'")
        return

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
