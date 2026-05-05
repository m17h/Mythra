#!/usr/bin/env bash
# Build build/app_icon.icns from Images/app_icon.png (requires macOS sips + iconutil).
# For release builds, prefer `npm run dist:mac` — electron-builder converts the same PNG for the bundle.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/Images/app_icon.png"
OUT_DIR="${ROOT}/build"
ICONSET="${OUT_DIR}/AppIcon.iconset"
DEST_ICNS="${OUT_DIR}/app_icon.icns"

if [[ ! -f "$SRC" ]]; then
  echo "Missing source icon: $SRC" >&2
  exit 1
fi

mkdir -p "$ICONSET"

rm -f "${ICONSET}/"*.png

sips -z 16 16 "$SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

rm -f "$DEST_ICNS"
iconutil -c icns "$ICONSET" -o "$DEST_ICNS"

echo "Wrote $DEST_ICNS"
