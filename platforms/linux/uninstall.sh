#!/bin/sh
# Removes the user-level install. Downloads and history are kept unless --purge.
set -eu

PURGE=0
PREFIX="${PREFIX:-$HOME/.local}"
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --prefix) shift; PREFIX="$1" ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

APP="$PREFIX/opt/bewly-download/app"
DATA="${BEWLY_DOWNLOAD_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/bewly-download}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [ -x "$APP/posix/launcher.sh" ]; then "$APP/posix/launcher.sh" unregister || true; fi
if [ -f "$UNIT_DIR/bewly-download.service" ]; then
  systemctl --user disable --now bewly-download.service 2>/dev/null || true
  rm -f "$UNIT_DIR/bewly-download.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi
rm -f "$DESKTOP_DIR/io.bewly.download.desktop"
rm -rf "$PREFIX/opt/bewly-download"
if [ "$PURGE" = 1 ]; then rm -rf "$DATA"; fi

echo "已卸载。"
if [ "$PURGE" = 0 ]; then echo "下载记录与运行时保留在：$DATA（使用 --purge 可一并删除）"; fi
