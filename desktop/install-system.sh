#!/usr/bin/env bash
# Optional: install Crew in /opt/Crew with an AppArmor profile so it runs with
# Chromium's sandbox (how Ubuntu handles Google Chrome). Build first with `npm run desktop:pack`.
#   sudo desktop/install-system.sh            install or update
#   sudo desktop/install-system.sh --remove   remove the system install and the profile
# Afterwards run `npm run desktop:install` (as yourself) to point the app menu at it.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo "请用 sudo 运行：sudo $0 $*"
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
  echo "已移除 $DEST 和 AppArmor 规则。以普通用户再运行一次 npm run desktop:install，菜单会改回 AppImage。"
  exit 0
fi

if [ ! -x "$SRC/crew" ]; then
  echo "找不到 $SRC/crew，请先运行 npm run desktop:pack"
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

echo "✅ 已安装到 $DEST，并启用了 AppArmor 规则（沙盒可用）。"
echo "   接下来以普通用户运行：npm run desktop:install"
