#!/usr/bin/env python3
"""
MEGA Import Plugin — backend (mega.py edition).

Replaces MEGAcmd with the mega.py library (pip install mega.py), which works
on Alpine Linux containers and needs no native binaries.

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
    """Encode session credentials as a portable base64 token string."""
    data = {"sid": sid, "mk": list(master_key) if master_key else []}
    return base64.b64encode(json.dumps(data, separators=(",", ":")).encode()).decode()


def _token_to_session(token):
    """Decode a session token back to (sid, master_key_bytes)."""
    try:
        data = json.loads(base64.b64decode(token.encode()).decode())
        sid = data.get("sid") or ""
        mk_list = data.get("mk") or []
        if not sid:
            raise ValueError("empty sid")
        return sid, bytes(mk_list) if mk_list else None
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
    sid, master_key = _token_to_session(token)
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
