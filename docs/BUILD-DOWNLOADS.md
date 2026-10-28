# 构建个人维护版

来源：[BewlyBewly 原项目](https://github.com/BewlyBewly/BewlyBewly)、[Bilidown 作者主页](https://zhouql.vip/)。保留原许可证与署名。

## GitHub Actions

CI 在 main 推送或 PR 时检查类型、浏览器测试、应用代码风格，并构建 Chrome ZIP。

手动运行 **Build connector and Chrome extension** 会构建 Chrome ZIP、运行 Rust 测试并打包 Windows 连接器。macOS/Linux 任务目前只验证 `cargo build` 并上传 host 二进制，因为这两个平台的打包脚本仍在沿用已退役的 Node 目录结构，待重写。

Actions 的 Windows 产物明确标记 unsigned，只用于构建验收或自行签名。正式测试下载使用 Releases 中维护者在本机签名的 MSIX。Chrome ZIP 可加载解压目录；CRX 使用本机 Windows 密钥提供器签名，不在 CI 中复制或导出私钥。

原来的商店发布 workflow 仅在 BewlyBewly 上游仓库运行；本分支不会自动向 Chrome/Edge/Firefox 商店提交。

## 本机扩展构建

使用 Node.js 24+ 和项目指定的 pnpm 版本安装依赖：

```bash
pnpm install --frozen-lockfile
pnpm exec vue-tsc --noEmit
pnpm exec vitest run
```

为了保留当前加载中的扩展，输出到隔离目录：

```bash
NODE_ENV=production BEWLY_BUILD_DIR=dist/release-extension \
  pnpm exec run-s build:web build:prepare build:js build:bg
npx esno scripts/pack-chrome-zip.ts dist/release-extension
```

## Windows 连接器

安装 Windows SDK（MakeAppx/SignTool）与 .NET SDK（用于托盘 AOT 编译）。媒体传输、断点续传与合流均由 Rust 实现，构建不再需要 aria2c.exe 或 ffmpeg.exe。

```bash
cargo test --manifest-path rust/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-helper.ps1 -StageOnly
```

去掉 `StageOnly` 可构建未签名 MSIX；加 `DevSign` 使用本机证书签名，证书 Subject 必须与 `platforms/windows/AppxManifest.xml` 的 `Identity Publisher` 一致。

另一台电脑自行创建证书时，若还要生成 CRX，需要用 `npm run prepare:crx` 更新该开发环境的公开扩展身份后重建扩展与助手；此时扩展 ID 会与维护者发布版不同。

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-helper.ps1 -DevSign
npx esno scripts/pack-crx.ts --source dist/release-extension --name BewlyBewly-Downloads-local
```

不上传 PFX/PEM/私钥、会话、数据库、下载文件或本机调试报告。下载任务保存在 LOCALAPPDATA/BewlyDownload，构建和测试使用各自的隔离目录。
