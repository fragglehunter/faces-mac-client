#!/usr/bin/env bash
# build-app.sh — compile the Swift sources and assemble Faces.app.
#
# Produces ./Faces.app, a self-contained native macOS app bundle (Apple Silicon)
# that renders the faces-gui UI and includes a Settings window.
#
# Requires the Xcode command-line tools (swiftc, iconutil, sips, codesign).
#
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Faces"
BUNDLE_ID="io.buoyant.facesguimacapp"
VERSION="1.0.0"
MIN_MACOS="13.0"

APP="${APP_NAME}.app"
CONTENTS="${APP}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RES_DIR="${CONTENTS}/Resources"
BUILD_DIR="build"

echo "==> Cleaning"
rm -rf "${APP}" "${BUILD_DIR}"
mkdir -p "${MACOS_DIR}" "${RES_DIR}" "${BUILD_DIR}"
export CLANG_MODULE_CACHE_PATH="${PWD}/${BUILD_DIR}/ModuleCache"
mkdir -p "${CLANG_MODULE_CACHE_PATH}"

echo "==> Compiling Swift sources"
ARCH="$(uname -m)" # arm64 on Apple Silicon
swiftc \
  -parse-as-library \
  -O \
  -target "${ARCH}-apple-macos${MIN_MACOS}" \
  -o "${MACOS_DIR}/${APP_NAME}" \
  Sources/*.swift

echo "==> Copying web assets"
cp -R web "${RES_DIR}/web"

echo "==> Generating app icon"
# Prefer the high-quality clean-transparent logo; fall back to web/logo-128.png.
ICON_SRC=""
[ -f "logo-clean-transparent.png" ] && ICON_SRC="logo-clean-transparent.png"
[ -z "$ICON_SRC" ] && [ -f "web/logo-128.png" ] && ICON_SRC="web/logo-128.png"
if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1 && [ -n "$ICON_SRC" ]; then
  ICONSET="${BUILD_DIR}/${APP_NAME}.iconset"
  mkdir -p "${ICONSET}"

  # macOS app icons sit inside a rounded grid with ~10% transparent padding on
  # each side. A full-bleed logo therefore looks noticeably bigger than other
  # Dock/Finder/menu-bar icons. Composite the source onto a transparent 1024
  # canvas at ~80% so ours matches. (Requires `swift`; falls back to full-bleed.)
  MASTER="${BUILD_DIR}/icon-master.png"
  if command -v swift >/dev/null 2>&1 && swift - "$ICON_SRC" "$MASTER" >/dev/null 2>&1 <<'SWIFT'
import Foundation
import CoreGraphics
import ImageIO
let a = CommandLine.arguments
guard a.count >= 3,
      let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(1) }
let canvas = 1024, inset = 102            // ~10% padding -> ~80% content box
let box = canvas - inset * 2
guard let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.interpolationQuality = .high
ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))
let iw = Double(img.width), ih = Double(img.height)
let s = min(Double(box) / iw, Double(box) / ih)
let dw = iw * s, dh = ih * s
ctx.draw(img, in: CGRect(x: (Double(canvas) - dw) / 2, y: (Double(canvas) - dh) / 2, width: dw, height: dh))
guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, "public.png" as CFString, 1, nil)
      else { exit(1) }
CGImageDestinationAddImage(dest, out, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
SWIFT
  then
    ICON_SRC="$MASTER"
  else
    echo "    (icon padding step unavailable; using full-bleed source)"
  fi

  sips -z 16 16     "$ICON_SRC" --out "${ICONSET}/icon_16x16.png"      >/dev/null 2>&1 || true
  sips -z 32 32     "$ICON_SRC" --out "${ICONSET}/icon_16x16@2x.png"   >/dev/null 2>&1 || true
  sips -z 32 32     "$ICON_SRC" --out "${ICONSET}/icon_32x32.png"      >/dev/null 2>&1 || true
  sips -z 64 64     "$ICON_SRC" --out "${ICONSET}/icon_32x32@2x.png"   >/dev/null 2>&1 || true
  sips -z 128 128   "$ICON_SRC" --out "${ICONSET}/icon_128x128.png"    >/dev/null 2>&1 || true
  sips -z 256 256   "$ICON_SRC" --out "${ICONSET}/icon_128x128@2x.png" >/dev/null 2>&1 || true
  sips -z 256 256   "$ICON_SRC" --out "${ICONSET}/icon_256x256.png"    >/dev/null 2>&1 || true
  sips -z 512 512   "$ICON_SRC" --out "${ICONSET}/icon_256x256@2x.png" >/dev/null 2>&1 || true
  sips -z 512 512   "$ICON_SRC" --out "${ICONSET}/icon_512x512.png"    >/dev/null 2>&1 || true
  sips -z 1024 1024 "$ICON_SRC" --out "${ICONSET}/icon_512x512@2x.png" >/dev/null 2>&1 || true
  if iconutil -c icns "${ICONSET}" -o "${RES_DIR}/${APP_NAME}.icns" >/dev/null 2>&1; then
    ICON_PLIST="    <key>CFBundleIconFile</key>
    <string>${APP_NAME}</string>"
  else
    echo "    (icns generation failed; continuing without an icon)"
    ICON_PLIST=""
  fi
else
  echo "    (iconutil/sips/logo not available; continuing without an icon)"
  ICON_PLIST=""
fi

echo "==> Writing Info.plist"
cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <!-- Demo tool: the user points it at arbitrary face endpoints (often
             plain http IPs/hostnames inside a cluster), so allow them. -->
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
${ICON_PLIST}
</dict>
</plist>
PLIST

echo "==> Ad-hoc code signing"
codesign --force --deep --sign - "${APP}" >/dev/null 2>&1 || \
  echo "    (codesign failed; the app will still run locally)"

echo ""
echo "Built ${APP}"
echo "Run it with:  open ${APP}    (or ./run.sh)"
