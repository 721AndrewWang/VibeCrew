#!/usr/bin/env bash
# Optional: install Crew in /opt/Crew with an AppArmor profile so it runs with
# Chromium's sandbox (how Ubuntu handles Google Chrome). Build first with `npm run desktop:pack`.
#   sudo desktop/install-system.sh            install or update
#   sudo desktop/install-system.sh --remove   remove the system install and the profile
# Afterwards run `npm run desktop:install` (as yourself) to point the app menu at it.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo: sudo $0 $*"
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../release/linux-unpacked"
DEST=/opt/Crew
PROFILE=/etc/apparmor.d/crew

if [ "${1:-}" = "--remove" ]; then
  if [ -f "$PROFILE" ]; then apparmor_parser -R "$PROFILE" 2>/dev/null || true; fi
  rm -f "$PROFILE"
  rm -rf "$DEST"
  echo "Removed $DEST and the AppArmor profile. Run npm run desktop:install again as yourself to point the menu back at the AppImage."
  exit 0
fi

if [ ! -x "$SRC/crew" ]; then
  echo "$SRC/crew not found. Run npm run desktop:pack first."
  exit 1
fi

# Copy, then swap in place; a running copy keeps its open files until it restarts.
rm -rf "$DEST.new"
cp -a "$SRC" "$DEST.new"
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

install -m 644 "$HERE/apparmor/crew" "$PROFILE"
apparmor_parser -r "$PROFILE"

echo "✅ Installed to $DEST and enabled the AppArmor profile (sandbox available)."
echo "   Next, as yourself, run: npm run desktop:install"
