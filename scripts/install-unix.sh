#!/usr/bin/env sh
# Install pi-bgwait-bridge into the user or project Pi scope.
#   scripts/install-unix.sh           -> user scope (~/.pi/agent/settings.json)
#   scripts/install-unix.sh --local   -> project scope (.pi/settings.json)
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

echo "Installing $PACKAGE_DIR $SCOPE"
node "$LAUNCHER" install "$PACKAGE_DIR" $SCOPE

echo
echo "Installed. Verify with:  pi list | grep pi-bgwait-bridge"
echo "Reload a running session with /reload."
