# 下载助手平台支持

本目录记录 Windows / macOS / Linux 三端下载助手的安装、排障与构建方式。协议与业务逻辑三端共用（`native/*.mjs`），平台差异集中在 `native/platform/` 与各自的安装外壳。

## 能力对照

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 系统托盘 | ✅ | ✅ 菜单栏 | ❌ 无界面 |
| 文件/目录选择 | ✅ | ✅ | 需 zenity 或 kdialog，否则手填路径 |
| 剪贴板监听 | ✅ | ✅ | ❌ |
| 下载完成关机 | ✅ | ✅ | ❌ |
| 登录信息保护 | DPAPI | Keychain（失败降级 0600 文件） | 0600 文件 |
| Node 运行时 | 官方 MSI（按需） | 系统 ≥24，缺失则自动下载 | 同 macOS |
| 分发 | MSIX | `.app` zip（ad-hoc 签名） | `tar.gz` + `install.sh` |

## macOS

1. 解压 `Bewly-DownloadHelper-<版本>-macos-arm64.zip`，把「Bewly 下载助手.app」拖进 `/Applications`。
2. 首次打开：由于未做公证，macOS 15+ 需在「系统设置 → 隐私与安全性」点「仍要打开」；也可执行
   `xattr -dr com.apple.quarantine "/Applications/Bewly 下载助手.app"`。
3. App 首次运行会：校验/安装 Node 24 到 `~/Library/Application Support/BewlyDownload/runtime`、写入 Chrome/Edge/Chromium/Brave 的原生消息清单、启动后台服务与菜单栏图标。
4. 重启浏览器，在扩展中点击连接。

排障：

- 菜单栏没有图标 → `~/Library/Application Support/BewlyDownload/logs/` 查看日志，或手动执行
  `"/Applications/Bewly 下载助手.app/Contents/Resources/native/posix/launcher.sh" status`。
- 扩展提示未连接 → 确认清单存在：
  `ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/`。

## Linux

```sh
tar -xzf Bewly-DownloadHelper-<版本>-linux-x64.tar.gz
cd Bewly-DownloadHelper-<版本>-linux-x64    # 或解压目录
sh install.sh                                # 装到 ~/.local，无需 root
sh install.sh --systemd                      # 可选：systemd --user 常驻
```

安装脚本会：复制到 `~/.local/opt/bewly-download/app`、写入 4 个浏览器的清单、生成 desktop 入口、必要时把 Node 24 下载到 `~/.local/share/bewly-download/runtime`。

卸载：`sh uninstall.sh`（保留下载记录与运行时）；`sh uninstall.sh --purge` 一并删除。

## Windows

见 [INSTALL-DOWNLOADS.md](./INSTALL-DOWNLOADS.md)。行为未变。

## 构建

```sh
node scripts/build-helper.mjs --target win32-x64     # 转调 build-helper.ps1（需 Windows SDK）
node scripts/build-helper.mjs --target linux-x64     # 需 --bin 指定 aria2c/ffmpeg
node scripts/build-helper.mjs --target darwin-arm64  # 必须在 macOS 上运行（swiftc/codesign）
```

暂存目录已存在时构建会拒绝覆盖，需显式加 `--clean` 或使用 `--out <dir>`。

媒体工具（aria2 / FFmpeg）由 `scripts/toolchain/build-posix-tools.sh` 从官方源码构建：

```sh
sh scripts/toolchain/build-posix-tools.sh linux-x64 dist/toolchain/bin
node scripts/verify-toolchain.mjs --platform linux-x64 dist/toolchain/bin
```

二进制与 `SOURCES.txt`（版本 + configure 参数）必须同批发布，以满足 GPL/LGPL 的源码提供义务。

## 已知限制

- macOS 包为 ad-hoc 签名、未公证，升级后需要重新在系统设置中允许。
- Linux 无托盘、无剪贴板监听、无自动关机，这三项在扩展设置中按 `health.capabilities` 隐藏。
- 仅支持 Node 24 及以上；musl（Alpine）无预编译原生模块，暂不支持。
