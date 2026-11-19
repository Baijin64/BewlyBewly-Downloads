#!/usr/bin/env bash
# Builds BewlyDownload.app and packages a drag-to-Applications .dmg on macOS.
#
#   bash scripts/build-macos-dmg.sh [darwin-arm64|darwin-x64] [ffmpeg-dir]
#
# Prerequisites on macOS:
#   - Rust host already compiled at rust/target/release/bewly-host
#     (run: (cd rust && cargo build --release -p bewly-host))
#   - Bundled LGPL FFmpeg built into dist/toolchain/ffmpeg/<target>
#     (run: bash scripts/toolchain/build-ffmpeg.sh <target> dist/toolchain/ffmpeg/<target>)
#   - Xcode Command Line Tools (swiftc, codesign, sips, iconutil, hdiutil)
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-macos-dmg.sh must run on macOS (Darwin)." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_ARCH="$(uname -m)"
if [ "$HOST_ARCH" = "arm64" ]; then
  DEFAULT_TARGET="darwin-arm64"
else
  DEFAULT_TARGET="darwin-x64"
fi

TARGET="${1:-$DEFAULT_TARGET}"
case "$TARGET" in
  darwin-arm64) ARCH_LABEL="arm64" ;;
  darwin-x64) ARCH_LABEL="x64" ;;
  *)
    echo "Unsupported macOS target: $TARGET (expected darwin-arm64 or darwin-x64)" >&2
    exit 2
    ;;
esac

FFMPEG_DIR="${2:-${BEWLY_FFMPEG_DIR:-$REPO_ROOT/dist/toolchain/ffmpeg/$TARGET}}"
RUST_HOST="$REPO_ROOT/rust/target/release/bewly-host"
if [ ! -x "$RUST_HOST" ]; then
  echo "Rust host not found at $RUST_HOST. Run '(cd rust && cargo build --release -p bewly-host)' first." >&2
  exit 1
fi

FFMPEG_BIN="$FFMPEG_DIR/ffmpeg"
if [ ! -x "$FFMPEG_BIN" ]; then
  echo "FFmpeg not found at $FFMPEG_BIN. Run 'bash scripts/toolchain/build-ffmpeg.sh $TARGET $FFMPEG_DIR' first." >&2
  exit 1
fi
for notice in LICENSE-FFmpeg-LGPL-2.1.txt LICENSE-LAME-LGPL.txt SOURCES.txt; do
  if [ ! -f "$FFMPEG_DIR/$notice" ]; then
    echo "Missing $notice in $FFMPEG_DIR" >&2
    exit 1
  fi
done

HELPER_VERSION="$(awk '/^\[workspace\.package\]/{in_pkg=1;next} /^\[/{in_pkg=0} in_pkg && /^version[[:space:]]*=/{gsub(/.*=[[:space:]]*"|".*/,""); print; exit}' "$REPO_ROOT/rust/Cargo.toml")"
if [ -z "$HELPER_VERSION" ]; then
  echo "Failed to read workspace version from rust/Cargo.toml" >&2
  exit 1
fi

STAGE_ROOT="$REPO_ROOT/dist/macos-$ARCH_LABEL"
APP_BUNDLE="$STAGE_ROOT/BewlyDownload.app"
DMG_STAGE="$STAGE_ROOT/dmg-stage"
OUT_DMG="$REPO_ROOT/dist/Bewly-DownloadHelper-$HELPER_VERSION-macos-$ARCH_LABEL.dmg"

rm -rf "$STAGE_ROOT" "$OUT_DMG"
mkdir -p \
  "$APP_BUNDLE/Contents/MacOS/bin" \
  "$APP_BUNDLE/Contents/Resources/licenses" \
  "$DMG_STAGE"

# Info.plist synced to rust/Cargo.toml version
cp "$REPO_ROOT/platforms/macos/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $HELPER_VERSION" "$APP_BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $HELPER_VERSION" "$APP_BUNDLE/Contents/Info.plist"

# Main executable (CFBundleExecutable = BewlyDownload)
cp "$RUST_HOST" "$APP_BUNDLE/Contents/MacOS/BewlyDownload"
chmod 755 "$APP_BUNDLE/Contents/MacOS/BewlyDownload"

# Menu bar tray companion (spawned by bewly-service from Contents/MacOS/BewlyTray)
swiftc -O \
  -framework AppKit \
  -framework Foundation \
  "$REPO_ROOT/platforms/macos/BewlyTray.swift" \
  -o "$APP_BUNDLE/Contents/MacOS/BewlyTray"
chmod 755 "$APP_BUNDLE/Contents/MacOS/BewlyTray"

# Bundled LGPL FFmpeg (located by bewly-media at Contents/MacOS/bin/ffmpeg)
cp "$FFMPEG_BIN" "$APP_BUNDLE/Contents/MacOS/bin/ffmpeg"
chmod 755 "$APP_BUNDLE/Contents/MacOS/bin/ffmpeg"

# Licenses & third-party notices
cp "$REPO_ROOT/LICENSE" "$APP_BUNDLE/Contents/Resources/licenses/BewlyBewly-MIT.txt"
cp "$FFMPEG_DIR/LICENSE-FFmpeg-LGPL-2.1.txt" "$APP_BUNDLE/Contents/Resources/licenses/FFmpeg-LICENSE-FFmpeg-LGPL-2.1.txt"
cp "$FFMPEG_DIR/LICENSE-LAME-LGPL.txt" "$APP_BUNDLE/Contents/Resources/licenses/FFmpeg-LICENSE-LAME-LGPL.txt"
cp "$FFMPEG_DIR/SOURCES.txt" "$APP_BUNDLE/Contents/Resources/licenses/FFmpeg-SOURCES.txt"
cat > "$APP_BUNDLE/Contents/Resources/licenses/THIRD-PARTY.txt" <<'EOF'
This is a personal maintenance build of BewlyBewly + Downloads.
Media transfer is implemented in Rust. Muxing, audio extraction and MP3 encoding use
the bundled Contents/MacOS/bin/ffmpeg: FFmpeg (https://ffmpeg.org/) with LAME
(https://lame.sourceforge.io/), both under the LGPL, built from unmodified upstream
sources by scripts/toolchain/build-ffmpeg.sh without GPL or non-free components.
Source URLs, checksums and the exact configure flags are in FFmpeg-SOURCES.txt.
EOF

# App icon (.icns) generated from the Bewly mascot PNG
ICON_SRC="$REPO_ROOT/platforms/windows/Assets/BewlyMascot.png"
if [ ! -f "$ICON_SRC" ]; then
  ICON_SRC="$REPO_ROOT/assets/icon-512.png"
fi
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$STAGE_ROOT/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
    sz2=$((sz * 2))
    sips -z "$sz2" "$sz2" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

# Verify binaries before signing
HOST_VER="$("$APP_BUNDLE/Contents/MacOS/BewlyDownload" --version)"
case "$HOST_VER" in
  "bewly-host "*) echo "Verified host: $HOST_VER" ;;
  *) echo "Unexpected host --version output: $HOST_VER" >&2; exit 1 ;;
esac

MUXERS="$("$APP_BUNDLE/Contents/MacOS/bin/ffmpeg" -hide_banner -muxers)"
for m in mp4 ipod matroska mp3 flac; do
  if ! printf '%s\n' "$MUXERS" | grep -Eq "[[:space:]]${m}[[:space:]]"; then
    echo "Bundled FFmpeg lacks muxer: $m" >&2
    exit 1
  fi
done
if ! "$APP_BUNDLE/Contents/MacOS/bin/ffmpeg" -hide_banner -encoders | grep -q "libmp3lame"; then
  echo "Bundled FFmpeg lacks libmp3lame encoder" >&2
  exit 1
fi
echo "Verified bundled FFmpeg muxers and libmp3lame"

# Ad-hoc sign inner executables first, then the outer .app bundle
SIGN_IDENTITY="${BEWLY_MACOS_SIGN_IDENTITY:--}"
codesign --force --sign "$SIGN_IDENTITY" "$APP_BUNDLE/Contents/MacOS/bin/ffmpeg"
codesign --force --sign "$SIGN_IDENTITY" "$APP_BUNDLE/Contents/MacOS/BewlyTray"
codesign --force --sign "$SIGN_IDENTITY" "$APP_BUNDLE/Contents/MacOS/BewlyDownload"
codesign --force --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"
echo "Verified ad-hoc code signature on $APP_BUNDLE"

# Assemble drag-to-Applications DMG
cp -R "$APP_BUNDLE" "$DMG_STAGE/BewlyDownload.app"
ln -s /Applications "$DMG_STAGE/Applications"
cat > "$DMG_STAGE/首次打开说明.txt" <<'EOF'
Bewly 下载助手（macOS）安装说明

1. 将「BewlyDownload.app」拖入右侧的「Applications」文件夹。
2. 首次打开（未做 Apple 公证，系统会拦截）：
   打开「终端」执行以下命令一次：
     xattr -dr com.apple.quarantine "/Applications/BewlyDownload.app"
   或在「系统设置 -> 隐私与安全性」中点击「仍要打开」。
3. 双击打开「BewlyDownload.app」一次，即可自动写入 Chrome / Edge / Chromium / Brave / Firefox 的原生消息配置并在菜单栏出现下载助手图标。
4. 重启浏览器后，在 B 站页面点击下载即可自动连接。

本安装包内置 Rust 下载引擎与精简版 LGPL FFmpeg，无需安装 Node.js 或 aria2。
EOF

hdiutil create \
  -volname "Bewly Download Helper $HELPER_VERSION" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$OUT_DMG"

echo "DMG built: $OUT_DMG ($(du -h "$OUT_DMG" | awk '{print $1}'))"
