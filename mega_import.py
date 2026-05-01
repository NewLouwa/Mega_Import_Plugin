#!/usr/bin/env python3
"""
MEGA Import Plugin — backend.

Wraps MEGAcmd (https://github.com/meganz/MEGAcmd) as a subprocess so the JS
frontend can drive auth/list/download against MEGA.nz from a Stash plugin task.

Protocol
--------
Reads a single JSON document from stdin. Two accepted shapes:

  Standalone:
    {"action": "list", "path": "/"}

  From Stash (plugin task wraps args in "args"):
    {"args": {"action": "list", "path": "/"}, "server_connection": {...}}

Writes a single JSON document to stdout. Two output modes, auto-selected:

  Standalone (input had no "args" key):
    Success:  {"ok": true,  "result": <action-specific>}
    Failure:  {"ok": false, "error": "<message>", "code": "<short_code>"}

  Stash plugin task (input had "args" key — Stash wraps it):
    Always:   {"output": null, "error": "OK:<json_result>" | "ERR:<message>"}

  The Stash envelope abuses Job.error as a transport because Stash's GraphQL
  doesn't expose plugin task stdout to the frontend. The JS bridge strips the
  OK:/ERR: prefix.

Actions
-------
  check                       -> {"version": "..."}
  whoami                      -> {"email": "..."} or {"email": null}
  login   {email, password}   -> {"email": "..."}
  logout                      -> {}
  list    {path}              -> [{type, name, size, path}]
  find    {query, path?}      -> [{type, name, path}]   (file-only matches)
  download {paths, dest?}     -> {dest, items: [{path, status, error?}]}
                               (paths may include folders — MEGAcmd downloads
                               them recursively)

Requirements
------------
MEGAcmd installed and `mega-login`, `mega-whoami`, `mega-ls`, `mega-logout`,
`mega-get` on PATH. Windows install path is usually
`C:\\Users\\<you>\\AppData\\Local\\MEGAcmd\\` — add it to PATH.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_DEST = os.environ.get("MEGA_IMPORT_DEST", "mega_imports")
MEGACMD_TIMEOUT_S = int(os.environ.get("MEGA_IMPORT_TIMEOUT", "300"))


class MegaError(Exception):
    def __init__(self, message, code="mega_error"):
        super().__init__(message)
        self.code = code


def _find_cmd(name):
    """Locate a mega-* binary on PATH or in known Windows install dirs."""
    found = shutil.which(name)
    if found:
        return found
    if sys.platform == "win32":
        candidates = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "MEGAcmd" / f"{name}.bat",
            Path(os.environ.get("PROGRAMFILES", "")) / "MEGAcmd" / f"{name}.bat",
        ]
        for c in candidates:
            if c.exists():
                return str(c)
    raise MegaError(
        f"MEGAcmd command '{name}' not found on PATH. Install MEGAcmd from "
        "https://mega.nz/cmd and ensure its install directory is on PATH.",
        code="megacmd_missing",
    )


def _run(args, input_text=None):
    """Run a MEGAcmd binary, return (stdout, stderr, returncode)."""
    binary = _find_cmd(args[0])
    full = [binary] + list(args[1:])
    try:
        proc = subprocess.run(
            full,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=MEGACMD_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise MegaError(f"`{args[0]}` timed out after {MEGACMD_TIMEOUT_S}s", code="timeout")
    return proc.stdout, proc.stderr, proc.returncode


# -- actions ----------------------------------------------------------------

def action_check(_args):
    out, err, rc = _run(["mega-version"])
    if rc != 0:
        raise MegaError(f"mega-version failed: {err.strip() or out.strip()}", code="check_failed")
    first_line = (out.strip().splitlines() or [""])[0]
    return {"version": first_line}


def action_whoami(_args):
    out, err, rc = _run(["mega-whoami"])
    text = (out + err).strip()
    if rc != 0 or "Not logged in" in text or not text:
        return {"email": None}
    # Output usually: "Account e-mail: foo@bar.com"
    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    return {"email": m.group(0) if m else None}


def action_login(args):
    email = args.get("email")
    password = args.get("password")
    if not email or not password:
        raise MegaError("login requires 'email' and 'password'", code="bad_args")

    # If already logged in as a different user, log out first.
    current = action_whoami({}).get("email")
    if current and current != email:
        _run(["mega-logout"])

    out, err, rc = _run(["mega-login", email, password])
    text = (out + err).strip()
    if rc != 0:
        # MEGAcmd writes auth failures to stderr with a useful message.
        raise MegaError(text or "Login failed", code="login_failed")
    return action_whoami({})


def action_logout(_args):
    _run(["mega-logout"])
    return {}


def _normalize_remote_path(path):
    if not path:
        return "/"
    if not path.startswith("/"):
        path = "/" + path
    return path


# Example `mega-ls -l /` line (column widths vary):
#   FLAGS       VERS  SIZE      DATE                NAME
#   drwxrwx---     -     -      14May2024 10:22:11  Documents
#   -rw-rw----     1   1.5M     14May2024 10:22:11  file.jpg
_LS_HEADER_RE = re.compile(r"^FLAGS\b", re.IGNORECASE)


def _parse_ls_line(line, parent_path):
    """Best-effort parse of a `mega-ls -l` line. Returns dict or None."""
    if not line.strip():
        return None
    parts = line.split(None, 5)
    if len(parts) < 6:
        # Some entries may collapse VERS or other columns — try a looser split.
        parts = line.split(None, 4)
        if len(parts) < 5:
            return None
        flags, _vers_or_size, size, _date_or_name = parts[0], parts[1], parts[2], parts[3]
        name = parts[-1]
    else:
        flags, _vers, size, _date_d, _date_t, name = parts
    is_dir = flags.startswith("d")
    if name in (".", ".."):
        return None
    full = parent_path.rstrip("/") + "/" + name if parent_path != "/" else "/" + name
    return {
        "type": "folder" if is_dir else "file",
        "name": name,
        "size": None if size == "-" else size,
        "path": full,
    }


def action_list(args):
    path = _normalize_remote_path(args.get("path", "/"))
    out, err, rc = _run(["mega-ls", "-l", path])
    if rc != 0:
        raise MegaError(err.strip() or out.strip() or "list failed", code="list_failed")
    items = []
    for line in out.splitlines():
        if _LS_HEADER_RE.match(line.strip()):
            continue
        parsed = _parse_ls_line(line, path)
        if parsed:
            items.append(parsed)
    # Folders first, then files, both alphabetical — matches typical UI expectation.
    items.sort(key=lambda i: (i["type"] != "folder", i["name"].lower()))
    return items


def action_find(args):
    query = (args.get("query") or "").strip()
    if not query:
        raise MegaError("find requires 'query'", code="bad_args")
    path = _normalize_remote_path(args.get("path") or "/")
    # MEGAcmd `mega-find` supports glob patterns. Search recursively from path.
    out, err, rc = _run(["mega-find", path, "--pattern=" + query])
    if rc != 0:
        # Some MEGAcmd versions take the pattern as a positional arg instead of
        # --pattern=. Retry with the alternate form before giving up.
        out2, err2, rc2 = _run(["mega-find", path, query])
        if rc2 != 0:
            raise MegaError(
                err.strip() or err2.strip() or out.strip() or "find failed",
                code="find_failed",
            )
        out = out2
    items = []
    for line in out.splitlines():
        p = line.strip()
        if not p:
            continue
        if not p.startswith("/"):
            continue
        name = p.rsplit("/", 1)[-1]
        items.append({"type": "file", "name": name, "path": p})
    items.sort(key=lambda i: i["path"].lower())
    return items


def action_download(args):
    paths = args.get("paths") or []
    dest = args.get("dest") or DEFAULT_DEST
    dest_path = Path(dest).expanduser().resolve()
    dest_path.mkdir(parents=True, exist_ok=True)

    items = []
    for remote in paths:
        remote = _normalize_remote_path(remote)
        out, err, rc = _run(["mega-get", remote, str(dest_path)])
        if rc == 0:
            items.append({"path": remote, "status": "ok"})
        else:
            items.append({
                "path": remote,
                "status": "error",
                "error": (err.strip() or out.strip() or "download failed")[:500],
            })
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


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        return {"ok": False, "error": "empty stdin", "code": "no_input"}, False
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"invalid JSON: {e}", "code": "bad_json"}, False

    stash_mode = isinstance(payload, dict) and "args" in payload
    args = payload.get("args") if stash_mode else payload
    if not isinstance(args, dict):
        return {"ok": False, "error": "args must be an object", "code": "bad_args"}, stash_mode
    action = args.get("action")
    if not action:
        return {"ok": False, "error": "missing 'action'", "code": "no_action"}, stash_mode
    handler = ACTIONS.get(action)
    if not handler:
        return ({
            "ok": False,
            "error": f"unknown action '{action}'. valid: {sorted(ACTIONS)}",
            "code": "unknown_action",
        }, stash_mode)

    try:
        result = handler(args)
        return {"ok": True, "result": result}, stash_mode
    except MegaError as e:
        return {"ok": False, "error": str(e), "code": e.code}, stash_mode
    except Exception as e:
        return {"ok": False, "error": f"unhandled: {e}", "code": "internal"}, stash_mode


def _stash_envelope(response):
    """Encode a response into Stash's PluginOutput shape for transport via Job.error."""
    if response.get("ok"):
        payload = json.dumps(response.get("result"))
        return {"output": None, "error": "OK:" + payload}
    return {"output": None, "error": "ERR:" + (response.get("error") or "unknown")}


if __name__ == "__main__":
    response, stash_mode = main()
    out = _stash_envelope(response) if stash_mode else response
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    # In Stash mode always exit 0 — Stash treats nonzero as a hard plugin failure
    # and we want the structured error to come through Job.error instead.
    sys.exit(0 if (stash_mode or response.get("ok")) else 1)
