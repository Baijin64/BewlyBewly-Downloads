#!/bin/sh
# Reached only when no usable Node runtime exists. The protocol needs a JS engine,
# so the honest answer is to explain the fix on stderr and exit non-zero; the
# extension turns that into "helper not connected" while the app/installer shows
# the actionable step.
set -u

cat >&2 <<'EOF'
Bewly 下载助手需要 Node.js 24 或更新版本。
请打开「Bewly 下载助手」应用，或重新运行安装脚本以自动安装运行时。
EOF

exit 1
