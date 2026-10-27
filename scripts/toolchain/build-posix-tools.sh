#!/bin/sh
# Builds pinned aria2 and FFmpeg binaries from official sources.
# Runs inside CI images whose CPU matches the target:
#   build-posix-tools.sh <target> <output-dir>
#   target: darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#
# The binaries are separate processes invoked by the helper, never linked into it.
# Sources, configure flags and the exact versions are written to SOURCES.txt and
# must be published with the binaries (GPL-2.0-or-later / LGPL-2.1-or-later).
set -eu

TARGET="${1:?target required}"
OUT="${2:?output directory required}"
ARIA2_VERSION=1.37.0
FFMPEG_VERSION=7.1
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)

case "$TARGET" in
  darwin-*) PLATFORM=darwin ;;
  linux-*) PLATFORM=linux ;;
  *) echo "unsupported target: $TARGET" >&2; exit 2 ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bewly-tools.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$OUT"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"
  fi
}

if [ "$PLATFORM" = linux ]; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq build-essential pkg-config libssl-dev zlib1g-dev libc-ares-dev libmp3lame-dev
  fi
  TLS_FLAGS="--with-openssl"
else
  if command -v brew >/dev/null 2>&1; then
    brew install openssl@3 c-ares lame || true
    OPENSSL_PREFIX=$(brew --prefix openssl@3)
    LAME_PREFIX=$(brew --prefix lame)
    CARES_PREFIX=$(brew --prefix c-ares)
    export PKG_CONFIG_PATH="$LAME_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$CARES_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
    export CPPFLAGS="-I$OPENSSL_PREFIX/include -I$LAME_PREFIX/include ${CPPFLAGS:-}"
    export LDFLAGS="-L$OPENSSL_PREFIX/lib -L$LAME_PREFIX/lib ${LDFLAGS:-}"
    pkg-config --exists lame || { echo "libmp3lame not found via pkg-config" >&2; exit 1; }
  fi
  TLS_FLAGS="--with-appletls"
fi

echo "== aria2 $ARIA2_VERSION =="
fetch "https://github.com/aria2/aria2/releases/download/release-$ARIA2_VERSION/aria2-$ARIA2_VERSION.tar.gz" "$WORK/aria2.tar.gz"
tar -xzf "$WORK/aria2.tar.gz" -C "$WORK"
(
  cd "$WORK/aria2-$ARIA2_VERSION"
  ./configure --prefix="$WORK/aria2-out" $TLS_FLAGS \
    --disable-nls --without-libxml2 --without-sqlite3 --without-libssh2
  make -j"$JOBS"
  make install
)
cp "$WORK/aria2-out/bin/aria2c" "$OUT/aria2c"
chmod 755 "$OUT/aria2c"

echo "== FFmpeg $FFMPEG_VERSION =="
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/ffmpeg.tar.xz"
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK"
(
  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  ./configure --prefix="$WORK/ffmpeg-out" \
    --disable-gpl --disable-nonfree --disable-doc --disable-debug \
    --disable-avdevice --disable-postproc \
    --enable-libmp3lame --disable-shared
  make -j"$JOBS"
  make install
)
cp "$WORK/ffmpeg-out/bin/ffmpeg" "$OUT/ffmpeg"
chmod 755 "$OUT/ffmpeg"

"$OUT/aria2c" --version | head -n 1
"$OUT/ffmpeg" -version | head -n 1

cat > "$OUT/SOURCES.txt" <<EOF
aria2 $ARIA2_VERSION: https://github.com/aria2/aria2/releases/download/release-$ARIA2_VERSION/aria2-$ARIA2_VERSION.tar.gz
ffmpeg $FFMPEG_VERSION: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
configure (aria2): $TLS_FLAGS --disable-nls --without-libxml2 --without-sqlite3 --without-libssh2
configure (ffmpeg): --disable-gpl --disable-nonfree --disable-doc --enable-libmp3lame --disable-shared
target: $TARGET
EOF

echo "tools written to $OUT"
