# 构建个人维护版

来源：[BewlyBewly 原项目](https://github.com/BewlyBewly/BewlyBewly)、[Bilidown 作者主页](https://zhouql.vip/)。保留原许可证与署名。

## GitHub Actions

CI 在 main 推送或 PR 时检查类型、64 项浏览器测试、应用代码风格，并构建 Chrome ZIP。

手动运行 **Build connector and Chrome extension** 会同时构建 Chrome ZIP 和 Windows 连接器，执行当前原生测试。Windows 构建从本私有仓库的 build-deps-20220508 Release 获取固定版本的媒体工具，并验证 native/toolchain.json 中的 SHA-256。

Actions 的 Windows 产物明确标记 unsigned，只用于构建验收或自行签名。正式测试下载使用 Releases 中维护者在本机签名的 MSIX。Chrome ZIP 可加载解压目录；CRX 使用本机 Windows 密钥提供器签名，不在 CI 中复制或导出私钥。

原来的商店发布 workflow 仅在 BewlyBewly 上游仓库运行；本分支不会自动向 Chrome/Edge/Firefox 商店提交。

## 本机扩展构建

使用 Node.js 24+ 和项目指定的 pnpm 版本安装依赖：

```powershell
pnpm install --frozen-lockfile
npm ci --prefix native --ignore-scripts
pnpm exec vue-tsc --noEmit
pnpm exec vitest run
```

为了保留当前加载中的扩展，输出到隔离目录：

```powershell
$env:NODE_ENV = 'production'
$env:BEWLY_BUILD_DIR = 'dist/release-extension'
pnpm exec run-s build:web build:prepare build:js build:bg
node scripts/pack-chrome-zip.mjs dist/release-extension
```

## Windows 连接器

安装 Windows SDK，准备与 native/toolchain.json 对应的 aria2c.exe 和 ffmpeg.exe。仓库不包含 Node 运行时、媒体 EXE 或用户配置。

有仓库权限并已登录 GitHub CLI 时，可获取固定测试工具链：

```powershell
gh release download build-deps-20220508 --repo Baijin64/BewlyBewly-Downloads --pattern Bewly-Media-Tools-1.36.0-5.0.1.zip --dir dist/toolchain-download
Expand-Archive -LiteralPath dist/toolchain-download/Bewly-Media-Tools-1.36.0-5.0.1.zip -DestinationPath dist/toolchain
node scripts/verify-toolchain.mjs dist/toolchain/bin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-helper.ps1 -BinDirectory dist/toolchain/bin -StageOnly
node --test native/tests/*.test.mjs
```

去掉 StageOnly 可构建未签名 MSIX；加 DevSign 使用本机项目开发证书签名。已有本机签名身份保持不变。另一台电脑自行创建证书时，若还要生成 CRX，需要用 prepare:crx 更新该开发环境的公开扩展身份后重建扩展与助手；此时扩展 ID 会与维护者发布版不同。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-helper.ps1 -BinDirectory dist/toolchain/bin -DevSign
node scripts/pack-crx.mjs --source dist/release-extension --name BewlyBewly-Downloads-local
```

不上传 PFX/PEM/私钥、会话、数据库、下载文件或本机调试报告。原生下载任务保存在 LOCALAPPDATA/BewlyDownload，构建和测试使用各自的隔离目录。

工具链 ZIP 记录原始版本、构建配置与许可；它是维护者现有安装提供的固定测试依赖，不是由本仓库编译的第三方新版本。媒体组件来源与许可证随测试安装包保留。
