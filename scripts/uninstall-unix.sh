#!/usr/bin/env sh
# Remove pi-bgwait-bridge from the user or project Pi scope.
#   scripts/uninstall-unix.sh           -> user scope
#   scripts/uninstall-unix.sh --local   -> project scope
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(dirname "$SCRIPT_DIR")
SCOPE=""

case "${1:-}" in
  --local|-l) SCOPE="-l" ;;
  "") ;;
  *) echo "Unknown argument: $1 (use --local for project scope)" >&2; exit 2 ;;
esac

if [ -n "${PI_LAUNCHER:-}" ]; then
  LAUNCHER="$PI_LAUNCHER"
else
  LAUNCHER="$HOME/.pi/agent/bin/pi-launcher.js"
fi

if [ ! -f "$LAUNCHER" ]; then
  echo "pi launcher not found at $LAUNCHER. Set PI_LAUNCHER to its path." >&2
  exit 1
fi

echo "Removing $PACKAGE_DIR $SCOPE"
node "$LAUNCHER" remove "$PACKAGE_DIR" $SCOPE

echo
echo "Removed. The extension also unregisters itself on session_shutdown."
