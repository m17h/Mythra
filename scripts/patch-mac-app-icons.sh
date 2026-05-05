#!/usr/bin/env bash
# Copy build/app_icon.icns into an existing .app and remove electron.icns (manual / legacy packaging).
# Recommended: `npm run dist:mac` — builds Mythra.app with the correct icon and no electron.icns.
#
# Usage: bash scripts/patch-mac-app-icons.sh path/to/Mythra.app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICNS="${ROOT}/build/app_icon.icns"
APP="${1:-}"

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "Usage: $0 path/to/Your.app" >&2
  exit 1
fi

if [[ ! -f "$ICNS" ]]; then
  echo "Missing $ICNS — run: npm run icons:mac" >&2
  exit 1
fi

RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"

ICON_KEY=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$PLIST" 2>/dev/null || echo 'app_icon')
ICON_BASE="${ICON_KEY%.icns}"

cp -f "$ICNS" "$RES/${ICON_BASE}.icns"
rm -f "$RES/electron.icns"

# CFBundleIconName is for asset catalogs; without one, Finder reliably uses CFBundleIconFile + .icns.
if /usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$PLIST" &>/dev/null; then
  /usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$PLIST" || true
fi

# Apple expects CFBundleIconFile without the .icns extension.
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile ${ICON_BASE}" "$PLIST" || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string ${ICON_BASE}" "$PLIST"

echo "Patched icons in $APP (re-sign / notarize again if needed)."
