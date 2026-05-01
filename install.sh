#!/usr/bin/env bash
# MEGA Import Plugin — installer for Linux / macOS (and WSL).
# Usage:
#   ./install.sh                              # install to default Stash plugins dir
#   ./install.sh /custom/stash/plugins        # explicit target dir
#   STASH_HOST=user@host ./install.sh         # remote install over SSH (rsync)
#   STASH_HOST=user@host STASH_PLUGINS=/var/lib/stash/plugins ./install.sh
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
check_prereqs_local() {
  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    red "Python not found on PATH. Install python3."
    return 1
  fi
  if ! command -v mega-version >/dev/null 2>&1; then
    warn "MEGAcmd not found on PATH. Plugin will install but MEGA actions will fail."
    warn "Install MEGAcmd from: https://mega.nz/cmd"
  else
    green "MEGAcmd detected: $(mega-version | head -n1)"
  fi
}

check_prereqs_remote() {
  ssh "$REMOTE" 'command -v python3 >/dev/null || command -v python >/dev/null' \
    || { red "Python missing on $REMOTE"; return 1; }
  if ssh "$REMOTE" 'command -v mega-version >/dev/null 2>&1'; then
    green "MEGAcmd detected on $REMOTE: $(ssh "$REMOTE" 'mega-version | head -n1')"
  else
    warn "MEGAcmd not found on $REMOTE. Install before using the plugin."
  fi
}

# 3. Run Python smoke test locally before deploying.
run_smoke_tests() {
  blue "Running Python unit tests…"
  if command -v python3 >/dev/null; then PY=python3; else PY=python; fi
  if ! "$PY" -m unittest test_mega_import >/dev/null 2>&1; then
    red "Python tests failed. Aborting install."
    "$PY" -m unittest test_mega_import
    exit 1
  fi
  green "Tests passed."
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
    blue "Detecting Stash plugins dir on $REMOTE…"
    for d in "${default_targets[@]}"; do
      if ssh "$REMOTE" "[ -d '$d' ]"; then TARGET_BASE="$d"; break; fi
    done
    if [[ -z "${TARGET_BASE:-}" ]]; then
      red "No Stash plugins dir found on $REMOTE. Set STASH_PLUGINS=/path/on/remote ./install.sh"
      exit 1
    fi
  fi
  local target="$TARGET_BASE/$PLUGIN_NAME"
  blue "Remote target: $REMOTE:$target"
  ssh "$REMOTE" "mkdir -p '$target'"
  rsync -av --delete \
    --exclude '__pycache__' --exclude '*.pyc' --exclude '.git' \
    "${FILES[@]/#/$SCRIPT_DIR/}" \
    "$REMOTE:$target/"
  green "Installed to $REMOTE:$target"
  echo
  echo "Next: open Stash → Settings → Plugins → click 'Reload Plugins'."
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
