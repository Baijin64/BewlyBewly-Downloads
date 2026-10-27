#!/bin/sh
# Native messaging entry point for macOS/Linux.
#
# Chromium is allowed to execute a shell script directly, and /bin/sh is signed by
# Apple, so this wrapper also sidesteps AMFI rejecting ad-hoc signed binaries when
# Chrome (Hardened Runtime) spawns the host. Never rely on `#!/usr/bin/env node`:
# GUI apps do not inherit the user's shell PATH.
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE=$(dirname -- "$DIR")

case "$(uname -s)" in
  Darwin) DATA="${BEWLY_DOWNLOAD_DATA:-$HOME/Library/Application Support/BewlyDownload}" ;;
  *)      DATA="${BEWLY_DOWNLOAD_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/bewly-download}" ;;
esac

resolve_node() {
  if [ -n "${BEWLY_NODE_PATH:-}" ] && [ -x "${BEWLY_NODE_PATH}" ]; then
    printf '%s' "${BEWLY_NODE_PATH}"
    return 0
  fi
  if [ -x "$DATA/runtime/node/bin/node" ]; then
    printf '%s' "$DATA/runtime/node/bin/node"
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

NODE=$(resolve_node) || exec "$DIR/degraded.sh" "$@"

case "${1:-}" in
  ''|-*) exec "$NODE" "$DIR/cli.mjs" "$@" ;;
  *)     exec "$NODE" "$DIR/host.mjs" "$@" ;;
esac
