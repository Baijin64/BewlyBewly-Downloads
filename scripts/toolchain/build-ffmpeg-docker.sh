#!/usr/bin/env bash
# Runs build-ffmpeg.sh inside a clean Ubuntu container, for hosts without the
# cross toolchains (or without root to install them). The Linux NDK is fetched once.
#
#   build-ffmpeg-docker.sh <target>...      default: win32-x64 android-arm64 android-x86_64
#
# Outputs land in dist/toolchain/ffmpeg/<target>/. Downloads (sources, NDK) are
# cached in $BEWLY_TOOLCHAIN_CACHE, by default ~/.cache/bewly-toolchain.
# BEWLY_APT_MIRROR swaps the Ubuntu archive for a closer mirror, for example
# https://mirrors.tuna.tsinghua.edu.cn/ubuntu.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${BEWLY_TOOLCHAIN_CACHE:-$HOME/.cache/bewly-toolchain}"
NDK_VERSION=r27c
NDK_SHA1=090e8083a715fdb1a3e402d0763c388abb03fb4e
[ "$#" -gt 0 ] || set -- win32-x64 android-arm64 android-x86_64
mkdir -p "$CACHE" "$ROOT/dist/toolchain/ffmpeg"

docker run --rm \
  -v "$ROOT/scripts/toolchain:/scripts:ro" \
  -v "$ROOT/dist/toolchain/ffmpeg:/out" \
  -v "$CACHE:/cache" \
  -e TARGETS="$*" -e NDK_VERSION="$NDK_VERSION" -e NDK_SHA1="$NDK_SHA1" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e APT_MIRROR="${BEWLY_APT_MIRROR:-}" \
  ubuntu:24.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    # apt checks the archive signatures, so a nearby mirror is as safe as the default.
    if [ -n "$APT_MIRROR" ]; then
      sed -i "s#http://archive.ubuntu.com/ubuntu#$APT_MIRROR#g; s#http://security.ubuntu.com/ubuntu#$APT_MIRROR#g" /etc/apt/sources.list.d/ubuntu.sources
    fi
    apt_opts="-o Acquire::Retries=5 -o Acquire::http::Timeout=60"
    apt-get $apt_opts update -qq
    apt-get $apt_opts install -y -qq build-essential mingw-w64 pkg-config curl xz-utils unzip ca-certificates >/dev/null
    export BEWLY_FFMPEG_CACHE=/cache
    for target in $TARGETS; do
      case "$target" in
        android-*)
          if [ ! -d /cache/android-ndk-$NDK_VERSION ]; then
            zip=/cache/android-ndk-$NDK_VERSION-linux.zip
            for attempt in 1 2 3 4 5 6; do
              [ -f "$zip" ] && break
              curl -fsSL --retry 3 --connect-timeout 20 -C - -o "$zip.part" \
                "https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-linux.zip" && mv "$zip.part" "$zip"
            done
            echo "$NDK_SHA1  $zip" | sha1sum -c -
            unzip -q "$zip" -d /cache
          fi
          export ANDROID_NDK_HOME=/cache/android-ndk-$NDK_VERSION
          ;;
      esac
      BEWLY_FFMPEG_WORK=/tmp/build-$target bash /scripts/build-ffmpeg.sh "$target" "/out/$target"
    done
    chown -R "$HOST_UID:$HOST_GID" /out /cache
  '

# Android picks up the executables from jniLibs (gitignored build output).
for target in "$@"; do
  case "$target" in
    android-arm64) abi=arm64-v8a ;;
    android-x86_64) abi=x86_64 ;;
    *) continue ;;
  esac
  dest="$ROOT/platforms/android/app/src/main/jniLibs/$abi"
  mkdir -p "$dest"
  cp "$ROOT/dist/toolchain/ffmpeg/$target/libffmpeg.so" "$dest/libffmpeg.so"
  echo "staged $dest/libffmpeg.so"
done
