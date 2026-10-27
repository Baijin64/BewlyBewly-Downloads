#!/bin/sh
# Downloads a pinned Node 24 runtime into the user data directory.
# Used by install.sh and by the macOS app's first run, where no Node may exist yet.
set -eu

DATA="${BEWLY_DOWNLOAD_DATA:-}"
if [ -z "$DATA" ]; then
  case "$(uname -s)" in
    Darwin) DATA="$HOME/Library/Application Support/BewlyDownload" ;;
    *) DATA="${XDG_DATA_HOME:-$HOME/.local/share}/bewly-download" ;;
  esac
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "不支持的平台：$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "需要 curl 或 wget 才能下载 Node.js" >&2; exit 1
  fi
}
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/bewly-node.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "正在获取 Node.js 发布清单…"
fetch "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" "$TMP/SHASUMS256.txt"

LINE=$(grep -E "^[0-9a-fA-F]{64}  node-v24\.[0-9]+\.[0-9]+-${OS}-${ARCH}\.tar\.gz$" "$TMP/SHASUMS256.txt" | tail -n 1 || true)
if [ -z "$LINE" ]; then echo "发布清单中没有 ${OS}-${ARCH} 的 Node.js 24 安装包" >&2; exit 1; fi

EXPECTED=$(printf '%s' "$LINE" | cut -d' ' -f1 | tr 'A-F' 'a-f')
FILE=$(printf '%s' "$LINE" | sed 's/^[0-9a-fA-F]*  //')
VERSION=$(printf '%s' "$FILE" | sed -E 's/^node-v([0-9.]+)-.*/\1/')

echo "正在下载 Node.js ${VERSION}（${OS}-${ARCH}）…"
fetch "https://nodejs.org/dist/v${VERSION}/${FILE}" "$TMP/$FILE"
ACTUAL=$(digest "$TMP/$FILE")
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "Node.js 安装包校验失败" >&2; exit 1; fi

mkdir -p "$DATA/runtime"
rm -rf "$DATA/runtime/node" "$DATA/runtime/.extract"
mkdir -p "$DATA/runtime/.extract"
tar -xzf "$TMP/$FILE" --strip-components=1 -C "$DATA/runtime/.extract"
if [ ! -x "$DATA/runtime/.extract/bin/node" ]; then echo "安装包缺少可执行文件" >&2; exit 1; fi
mv "$DATA/runtime/.extract" "$DATA/runtime/node"
chmod 755 "$DATA/runtime/node/bin/node"
printf '{\n  "version": "%s",\n  "arch": "%s",\n  "sha256": "%s",\n  "source": "https://nodejs.org/dist/v%s/%s",\n  "installedAt": "%s"\n}\n' \
  "$VERSION" "$ARCH" "$EXPECTED" "$VERSION" "$FILE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DATA/runtime/runtime.json"

echo "$DATA/runtime/node/bin/node"
