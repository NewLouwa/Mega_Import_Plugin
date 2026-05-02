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
            print(
                f"[mega-import] Hashcash challenge received (easiness={easiness}), solving…",
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
DEFAULT_DEST = os.environ.get("MEGA_IMPORT_DEST", "mega_imports")


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


def _list_children(files, parent_id, parent_path):
    """Return sorted [{type, name, size, path}] for direct children of parent_id."""
    items = []
    for nid, n in files.items():
        t = n.get("t", 0)
        if n.get("p") != parent_id or t not in (0, 1):
            continue
        name = (n.get("a") or {}).get("n", "?")
        child_path = ("/" + name) if parent_path == "/" else (parent_path + "/" + name)
        items.append({
            "type": "folder" if t == 1 else "file",
            "name": name,
            "size": n.get("s"),
            "path": child_path,
        })
    items.sort(key=lambda i: (i["type"] != "folder", i["name"].lower()))
    return items


def _collect_files_under(files, folder_id, cache, seen=None):
    """Recursively collect (path, node) pairs for every file under folder_id."""
    if seen is None:
        seen = set()
    result = []
    for nid, n in files.items():
        if n.get("p") != folder_id or nid in seen:
            continue
        t = n.get("t", 0)
        if t == 0:
            result.append((_node_path(nid, files, cache), n))
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
    files = m.get_files()
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
    files = m.get_files()
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


def action_download(args):
    paths = args.get("paths") or []
    dest = args.get("dest") or DEFAULT_DEST
    dest_path = Path(dest).expanduser().resolve()
    dest_path.mkdir(parents=True, exist_ok=True)

    m = _get_mega()
    files = m.get_files()
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
            else [(remote, node)]
        )
        for file_path, file_node in to_download:
            fname = (file_node.get("a") or {}).get("n", "download")
            try:
                m.download_file(file_node, dest_path=str(dest_path), dest_filename=fname)
                items.append({"path": file_path, "status": "ok"})
            except Exception as e:
                items.append({"path": file_path, "status": "error", "error": str(e)[:500]})

    return {"dest": str(dest_path), "items": items}


ACTIONS = {
    "check": action_check,
    "whoami": action_whoami,
    "login": action_login,
    "logout": action_logout,
    "list": action_list,
    "find": action_find,
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
