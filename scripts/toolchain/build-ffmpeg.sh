#!/usr/bin/env bash
# Builds the FFmpeg binary bundled with the download helper, from official sources.
#
#   build-ffmpeg.sh <target> <out-dir>
#
# Targets: win32-x64 (MinGW cross), android-arm64, android-x86_64 (NDK cross,
# needs ANDROID_NDK_HOME), linux-x64, darwin-arm64, darwin-x64 (native).
#
# The build is LGPL-only (no --enable-gpl / --enable-nonfree) and keeps just what
# the helper runs: stream-copy remux of DASH/FLV/MP4 into MP4/M4A/MKV/MKA/FLAC
# and MP3 encoding through LAME. Sources, versions and configure flags are
# written next to the binary in SOURCES.txt.
set -euo pipefail

TARGET="${1:?usage: build-ffmpeg.sh <target> <out-dir>}"
OUT="$(mkdir -p "${2:?usage: build-ffmpeg.sh <target> <out-dir>}" && cd "$2" && pwd)"
WORK="${BEWLY_FFMPEG_WORK:-$(mktemp -d)}"
CACHE="${BEWLY_FFMPEG_CACHE:-$WORK/cache}"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
ANDROID_API=26

FFMPEG_VERSION=7.1.1
FFMPEG_SHA256=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
LAME_VERSION=3.100
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e

mkdir -p "$WORK" "$CACHE"

fetch() {
  local url="$1" file="$2" sum="$3"
  if [ ! -f "$file" ]; then
    # Resume across attempts: some networks reset long transfers part-way.
    for attempt in 1 2 3 4 5 6; do
      curl -fsSL --retry 3 --connect-timeout 20 -C - -o "$file.part" "$url" && mv "$file.part" "$file" && break
      echo "download attempt $attempt failed: $url" >&2
      sleep 5
    done
  fi
  echo "$sum  $file" | sha256sum -c - >/dev/null || {
    echo "checksum mismatch for $file (expected $sum, got $(sha256sum "$file" | cut -d' ' -f1))" >&2
    exit 1
  }
}

# --- toolchain per target ---------------------------------------------------
HOST=""
EXE="ffmpeg"
CROSS_FLAGS=()
LAME_ENV=()
case "$TARGET" in
  win32-x64)
    HOST=x86_64-w64-mingw32
    EXE="ffmpeg.exe"
    CROSS_FLAGS=(--enable-cross-compile --target-os=mingw32 --arch=x86_64
      --cross-prefix=x86_64-w64-mingw32- --extra-ldflags=-static)
    ;;
  android-arm64|android-x86_64)
    : "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point at an Android NDK}"
    case "$(uname -s)" in
      Linux) NDK_HOST=linux-x86_64 ;;
      Darwin) NDK_HOST=darwin-x86_64 ;;
      *) echo "Android builds need a Linux or macOS host" >&2; exit 2 ;;
    esac
    TOOLS="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$NDK_HOST"
    if [ "$TARGET" = android-arm64 ]; then
      HOST=aarch64-linux-android
      ARCH=aarch64
      ARCH_FLAGS=(--cpu=armv8-a)
    else
      HOST=x86_64-linux-android
      ARCH=x86_64
      ARCH_FLAGS=(--disable-x86asm)
    fi
    CC="$TOOLS/bin/${HOST}${ANDROID_API}-clang"
    # Android only lets an app run binaries from its native library directory,
    # so the executable ships as lib*.so (see platforms/android build.gradle.kts).
    EXE="libffmpeg.so"
    CROSS_FLAGS=(--enable-cross-compile --target-os=android --arch="$ARCH" "${ARCH_FLAGS[@]}"
      --cc="$CC" --cxx="${CC}++" --nm="$TOOLS/bin/llvm-nm" --ar="$TOOLS/bin/llvm-ar"
      --ranlib="$TOOLS/bin/llvm-ranlib" --strip="$TOOLS/bin/llvm-strip"
      --sysroot="$TOOLS/sysroot" --enable-pic)
    LAME_ENV=(CC="$CC" AR="$TOOLS/bin/llvm-ar" RANLIB="$TOOLS/bin/llvm-ranlib")
    ;;
  linux-x64|darwin-arm64|darwin-x64)
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    exit 2
    ;;
esac

PREFIX="$WORK/prefix-$TARGET"
mkdir -p "$PREFIX"

# --- LAME (LGPL) ------------------------------------------------------------
echo "== LAME $LAME_VERSION ($TARGET) =="
fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" \
  "$CACHE/lame-$LAME_VERSION.tar.gz" "$LAME_SHA256"
rm -rf "$WORK/lame-$LAME_VERSION"
tar -xzf "$CACHE/lame-$LAME_VERSION.tar.gz" -C "$WORK"
(
  cd "$WORK/lame-$LAME_VERSION"
  # 3.100 exports a symbol it no longer defines; only the shared build trips on it,
  # but the export list is read regardless on some toolchains.
  sed -i.bak '/lame_init_old/d' include/libmp3lame.sym
  env "${LAME_ENV[@]}" ./configure --prefix="$PREFIX" ${HOST:+--host=$HOST} \
    --enable-static --disable-shared --disable-frontend --disable-decoder \
    --disable-gtktest --with-pic
  make -j"$JOBS"
  make install
)

# --- FFmpeg (LGPL) ----------------------------------------------------------
echo "== FFmpeg $FFMPEG_VERSION ($TARGET) =="
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
rm -rf "$WORK/ffmpeg-$FFMPEG_VERSION"
tar -xJf "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"

COMPONENT_FLAGS=(
  --disable-everything --disable-autodetect
  --disable-doc --disable-debug --disable-network
  --disable-programs --enable-ffmpeg
  --disable-avdevice --disable-postproc --disable-swscale
  --enable-protocol=file,pipe
  # Inputs: DASH m4s / MP4 (mov), FLV (durl), plain audio streams.
  --enable-demuxer=mov,flv,mp3,aac,flac,ac3,eac3,matroska
  # Outputs: mp4, m4a (ipod), mkv / mka, flac, mp3.
  --enable-muxer=mp4,ipod,mov,matroska,matroska_audio,flac,mp3
  # Decoders feed the MP3 encoder; video is only ever stream-copied.
  --enable-decoder=aac,aac_latm,mp3,mp3float,flac,ac3,eac3,opus
  --enable-encoder=libmp3lame
  --enable-parser=aac,aac_latm,h264,hevc,av1,flac,mpegaudio,ac3,opus
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb
  --enable-filter=aresample,aformat,anull,atrim,abuffer,abuffersink,null,format,trim,buffer,buffersink
  --enable-swresample
  --enable-libmp3lame
)

CONFIGURE=(./configure --prefix="$PREFIX" --enable-static --disable-shared
  --pkg-config-flags=--static
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib"
  "${CROSS_FLAGS[@]}" "${COMPONENT_FLAGS[@]}")
case "$TARGET" in
  win32-x64|linux-x64|darwin-*) CONFIGURE+=(--disable-x86asm) ;;
esac

(
  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  "${CONFIGURE[@]}" || { tail -n 60 ffbuild/config.log >&2; exit 1; }
  make -j"$JOBS"
  if [ -f ffmpeg.exe ]; then cp ffmpeg.exe "$OUT/$EXE"; else cp ffmpeg "$OUT/$EXE"; fi
  cp COPYING.LGPLv2.1 "$OUT/LICENSE-FFmpeg-LGPL-2.1.txt"
)
cp "$WORK/lame-$LAME_VERSION/COPYING" "$OUT/LICENSE-LAME-LGPL.txt"

case "$TARGET" in
  win32-x64) x86_64-w64-mingw32-strip "$OUT/$EXE" ;;
  android-*) "$TOOLS/bin/llvm-strip" "$OUT/$EXE" ;;
  darwin-*) strip "$OUT/$EXE" ;;
  *) strip "$OUT/$EXE" ;;
esac
chmod 755 "$OUT/$EXE"

{
  echo "FFmpeg $FFMPEG_VERSION: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz (sha256 $FFMPEG_SHA256)"
  echo "LAME $LAME_VERSION: https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz (sha256 $LAME_SHA256)"
  echo "License: LGPL-2.1-or-later (FFmpeg built without --enable-gpl/--enable-nonfree; LAME LGPL-2.0)"
  echo "Target: $TARGET"
  echo "configure (ffmpeg): ${CONFIGURE[*]:1}"
} > "$OUT/SOURCES.txt"

echo "built $OUT/$EXE ($(du -h "$OUT/$EXE" | cut -f1))"
