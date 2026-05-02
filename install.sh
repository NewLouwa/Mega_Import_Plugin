#!/usr/bin/env bash
# MEGA Import Plugin — installer for Linux / macOS (and WSL).
# Usage:
#   ./install.sh                              # install to default Stash plugins dir
#   ./install.sh /custom/stash/plugins        # explicit target dir
#   STASH_HOST=user@host ./install.sh         # remote install over SSH (rsync)
#   STASH_HOST=user@host STASH_PLUGINS=/var/lib/stash/plugins ./install.sh
#   STASH_HOST=root@10.0.0.5 SSH_OPTS="-J root@jump.example:2222 -i ~/.ssh/id_ed25519" ./install.sh
#
# Env vars:
#   STASH_HOST     — user@host for remote install (rsync over SSH)
#   STASH_PLUGINS  — explicit plugins dir on the target (skips auto-detection)
#   SSH_OPTS       — extra args passed to ssh AND rsync's underlying ssh
#                    (e.g. "-J jump.example", "-i ~/.ssh/key", "-p 2222")
set -euo pipefail

PLUGIN_NAME="mega_import"
FILES=(
  mega_import.js
  mega_import.css
  mega_import.py
  mega_import.yml
  test_mega_import.py
  README.md
  PROGRESS.md
  manifest
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_BASE="${1:-${STASH_PLUGINS:-}}"
REMOTE="${STASH_HOST:-}"
SSH_OPTS="${SSH_OPTS:-}"
# Build ssh + rsync-shell wrappers honoring SSH_OPTS.
# Word-splitting is intentional: SSH_OPTS may contain multiple flags.
# shellcheck disable=SC2206
SSH_CMD=(ssh $SSH_OPTS)
RSYNC_E="ssh $SSH_OPTS"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }

# 1. Find target plugins directory if not given.
default_targets=(
  "$HOME/.stash/plugins"
  "$HOME/.local/share/stash/plugins"
  "/root/.stash/plugins"
  "/var/lib/stash/plugins"
)

find_local_target() {
  for d in "${default_targets[@]}"; do
    if [[ -d "$d" ]]; then echo "$d"; return; fi
  done
  return 1
}

# 2. Pre-flight check on the target machine (local OR remote).
install_megapy_local() {
  local pip="${PY:-python3} -m pip"
  blue "Installing / upgrading Python dependencies (mega.py, tenacity≥8)..."
  # tenacity ≤5 uses asyncio.coroutine which was removed in Python 3.11.
  # Install ≥8 first so mega.py's install doesn't downgrade it.
  $pip install --upgrade --quiet "tenacity>=8.0" "mega.py" 2>/dev/null \
    || $pip install --upgrade --quiet --break-system-packages "tenacity>=8.0" "mega.py" 2>/dev/null \
    || warn "pip install failed — ensure mega.py and tenacity>=8 are installed."
}

check_prereqs_local() {
  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    red "Python not found on PATH. Install python3."
    return 1
  fi
  install_megapy_local
}

install_megapy_remote() {
  blue "Installing / upgrading Python dependencies on $REMOTE (mega.py, tenacity≥8)..."
  "${SSH_CMD[@]}" "$REMOTE" \
    'pip3 install --upgrade --quiet "tenacity>=8.0" "mega.py" 2>/dev/null || pip3 install --upgrade --quiet --break-system-packages "tenacity>=8.0" "mega.py" 2>/dev/null || true'
}

check_prereqs_remote() {
  "${SSH_CMD[@]}" "$REMOTE" 'command -v python3 >/dev/null || command -v python >/dev/null' \
    || { red "Python missing on $REMOTE"; return 1; }
  install_megapy_remote
}

# 3. Run Python smoke test locally before deploying.
run_smoke_tests() {
  blue "Running Python unit tests..."
  if [[ -n "${PYTHON:-}" ]]; then
    PY="$PYTHON"
  else
    PY=""
    for cand in python3 python; do
      if command -v "$cand" >/dev/null 2>&1; then
        # Skip Windows Store stub: real interpreters reply to --version.
        if "$cand" --version >/dev/null 2>&1; then
          PY="$cand"; break
        fi
      fi
    done
  fi
  if [[ -z "$PY" ]]; then
    red "No working Python interpreter found. Set PYTHON=/path/to/python or install python3."
    exit 1
  fi
  if ! "$PY" -m unittest test_mega_import >/dev/null 2>&1; then
    red "Python tests failed. Aborting install."
    "$PY" -m unittest test_mega_import
    exit 1
  fi
  green "Tests passed (using $PY)."
}

# 4. Local install.
install_local() {
  if [[ -z "$TARGET_BASE" ]]; then
    if TARGET_BASE="$(find_local_target)"; then
      blue "Found Stash plugins dir: $TARGET_BASE"
    else
      red "No Stash plugins directory detected. Pass one as the first argument:"
      red "  ./install.sh /path/to/stash/plugins"
      exit 1
    fi
  fi
  local target="$TARGET_BASE/$PLUGIN_NAME"
  mkdir -p "$target"
  blue "Copying plugin files → $target"
  for f in "${FILES[@]}"; do
    if [[ -f "$SCRIPT_DIR/$f" ]]; then
      cp "$SCRIPT_DIR/$f" "$target/$f"
    fi
  done
  green "Installed to $target"
  echo
  echo "Next: open Stash → Settings → Plugins → click 'Reload Plugins'."
}

# 5. Remote install via rsync over SSH.
install_remote() {
  if [[ -z "${TARGET_BASE:-}" ]]; then
    blue "Detecting Stash plugins dir on $REMOTE..."
    for d in "${default_targets[@]}"; do
      if "${SSH_CMD[@]}" "$REMOTE" "[ -d '$d' ]"; then TARGET_BASE="$d"; break; fi
    done
    if [[ -z "${TARGET_BASE:-}" ]]; then
      red "No Stash plugins dir auto-detected on $REMOTE. Set STASH_PLUGINS=/path/on/remote ./install.sh"
      exit 1
    fi
  else
    # Explicit path — sanity-check it exists OR its parent is writable so we can create it.
    if ! "${SSH_CMD[@]}" "$REMOTE" "[ -d '$TARGET_BASE' ] || [ -w \"\$(dirname '$TARGET_BASE')\" ]"; then
      red "Target '$TARGET_BASE' on $REMOTE doesn't exist and parent isn't writable."
      red "Verify the path (e.g. ssh into the host and ls), then re-run."
      exit 1
    fi
    blue "Using explicit STASH_PLUGINS: $TARGET_BASE"
  fi
  local target="$TARGET_BASE/$PLUGIN_NAME"
  blue "Remote target: $REMOTE:$target"
  "${SSH_CMD[@]}" "$REMOTE" "mkdir -p '$target'"

  if command -v rsync >/dev/null 2>&1; then
    rsync -av --delete -e "$RSYNC_E" \
      --exclude '__pycache__' --exclude '*.pyc' --exclude '.git' \
      "${FILES[@]/#/$SCRIPT_DIR/}" \
      "$REMOTE:$target/"
  else
    warn "rsync not found — falling back to scp (no --delete, no exclusions)."
    for f in "${FILES[@]}"; do
      if [[ -f "$SCRIPT_DIR/$f" ]]; then
        # shellcheck disable=SC2086
        scp $SSH_OPTS "$SCRIPT_DIR/$f" "$REMOTE:$target/$f"
      fi
    done
  fi

  green "Installed to $REMOTE:$target"
  echo
  echo "Next: open Stash -> Settings -> Plugins -> click 'Reload Plugins'."
}

cd "$SCRIPT_DIR"
run_smoke_tests
if [[ -n "$REMOTE" ]]; then
  check_prereqs_remote
  install_remote
else
  check_prereqs_local
  install_local
fi
