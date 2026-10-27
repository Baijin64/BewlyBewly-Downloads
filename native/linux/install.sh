#!/bin/sh
# User-level installer for the Bewly download helper (Linux, no root required).
set -eu

DRY_RUN=0
SYSTEMD=0
PREFIX="${PREFIX:-$HOME/.local}"
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --systemd) SYSTEMD=1 ;;
    --prefix) shift; PREFIX="$1" ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

APP="$PREFIX/opt/bewly-download/app"
DATA="${BEWLY_DOWNLOAD_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/bewly-download}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

run() { if [ "$DRY_RUN" = 1 ]; then echo "+ $*"; else "$@"; fi; }

if [ ! -d "$SOURCE/app" ]; then echo "安装包不完整：缺少 app 目录" >&2; exit 1; fi

echo "安装位置：$APP"
run mkdir -p "$(dirname "$APP")"
if [ "$DRY_RUN" = 0 ]; then
  rm -rf "$APP"
  cp -R "$SOURCE/app" "$APP"
fi
run chmod 755 "$APP/posix/launcher.sh" "$APP/posix/degraded.sh" "$APP/posix/fetch-node.sh"
run chmod 755 "$APP/bin/aria2c" "$APP/bin/ffmpeg"

NODE_OK=0
if command -v node >/dev/null 2>&1 && node --no-warnings -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:')" >/dev/null 2>&1; then NODE_OK=1; fi
if [ -x "$DATA/runtime/node/bin/node" ]; then NODE_OK=1; fi
if [ "$NODE_OK" = 0 ]; then
  echo "未找到 Node.js 24，正在下载到用户目录…"
  run sh "$APP/posix/fetch-node.sh"
fi

if [ "$DRY_RUN" = 0 ]; then
  "$APP/posix/launcher.sh" register
fi

run mkdir -p "$DESKTOP_DIR"
if [ "$DRY_RUN" = 0 ]; then
  cat > "$DESKTOP_DIR/io.bewly.download.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bewly 下载助手
Comment=连接 BewlyBewly 浏览器扩展与本地下载核心
Exec=$APP/posix/launcher.sh first-run
Terminal=false
Categories=AudioVideo;Network;
EOF
  chmod 644 "$DESKTOP_DIR/io.bewly.download.desktop"
else
  echo "+ write $DESKTOP_DIR/io.bewly.download.desktop"
fi

if [ "$SYSTEMD" = 1 ]; then
  run mkdir -p "$UNIT_DIR"
  if [ "$DRY_RUN" = 0 ]; then
    NODE_BIN="$DATA/runtime/node/bin/node"
    if [ ! -x "$NODE_BIN" ]; then NODE_BIN=$(command -v node || true); fi
    sed -e "s|@APP@|$APP|g" -e "s|@NODE@|$NODE_BIN|g" -e "s|@DATA@|$DATA|g" \
      "$SOURCE/linux/bewly-download.service" > "$UNIT_DIR/bewly-download.service"
    systemctl --user daemon-reload || true
    systemctl --user enable --now bewly-download.service || true
  else
    echo "+ install systemd --user unit"
  fi
fi

echo
echo "安装完成。请重启浏览器，然后在扩展中点击连接。"
echo "若 ~/.local/bin 不在 PATH 中，可执行：$APP/posix/launcher.sh status"
