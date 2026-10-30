# 安装个人维护版

此分支主要供维护者及朋友使用，不是 BewlyBewly 或 Bilidown 官方发布。

原项目：[BewlyBewly/BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。Bilidown 原作者主页：[王子周棋洛](https://zhouql.vip/)。

## 当前状态（预览版）

下载助手已经由 Rust 重写，不再需要 Node.js，也不再携带 aria2。安装包内置精简版 FFmpeg（LGPL，`bin\ffmpeg.exe`），用于合流（把 DASH 的视频流和音频流合成 mp4/mkv）、提取音频和转 MP3，不需要另外安装。想换用自己的 FFmpeg，可以设置环境变量 `BEWLY_FFMPEG` 指向它。

## 获取文件

打开本仓库的 [Releases](https://github.com/Baijin64/BewlyBewly-Downloads/releases)。私有仓库需要先登录有访问权限的 GitHub 账号。

- Chrome/Edge 扩展：选择名称含 Chrome 的 ZIP，解压到打算长期保留的文件夹。
- 本地连接器：下载名称含 DownloadHelper 的 MSIX。
- 其他电脑首次安装 MSIX 时，按 Windows 提示信任随包提供的 BewlyDownload-Development.cer。它是公开证书，不含私钥；只应在你了解并信任维护者时导入。也可自行构建并用自己的代码签名证书签名。
- macOS/Linux 目前只有 `bewly-host` 原始可执行文件（tar.gz），没有安装器。

开发证书说明可参考 [Microsoft 的包签名文档](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)。本仓库不会自动更改浏览器安全策略或在后台导入证书。

## 浏览器扩展

1. 打开 chrome://extensions 或 edge://extensions，开启开发者模式。
2. 选择“加载已解压的扩展”，选中解压后直接含 manifest.json 的文件夹。
3. 刷新 B 站页面。

更新时覆盖原文件夹内容并重载扩展。不要在使用后删除该文件夹。

CRX 签名和固定 ID 已检查，但本项目尚未通过 Chrome Web Store/Edge Add-ons 发布；直接拖入 CRX 可能被禁用。当前明确支持的本地测试入口是加载解压目录。不要为了安装而关闭浏览器安全保护或修改企业策略。CRX 需要 Windows 证书库里的私钥，只能在维护者本机生成，因此不随 CI 产物发布。

## Windows 本地连接器

1. 安装 MSIX，然后从开始菜单打开“Bewly 下载助手”一次，完成当前用户的 Chrome/Edge Native Messaging 注册。
2. 回到 B 站下载界面，点击下载或加入待下载，首次同意按需启动；任务与设置保存在本机。

网页下载界面可直接打开，配置与最近记录使用本地快照，不为查看界面启动下载服务。实际执行下载、入队、修改本地配置或文件操作时才唤起；没有正在处理的任务后约 5 秒自动退出，托盘与下载引擎一起结束。Windows 手动启动默认常驻，退出安装后的首次手动会话后即可按需使用。设置中可撤回自动唤起许可；查看历史时的“刷新”只连接已经运行的助手。详见 [启动与退出规则](DOWNLOAD-LIFECYCLE.md)。

连接器的宿主进程是 `BewlyDownloadHost.exe`（Rust，约 3.6 MB），托盘是 `BewlyDownloadTray.exe`（C#，NativeAOT）。两者通过本机回环 RPC 通信，托盘只是客户端。合流与转 MP3 由包内的 `bin\ffmpeg.exe` 完成。

## 更新与验证范围

浏览器扩展与连接器分别更新。旧版 Node 连接器的任务与设置在首次启动时按需迁移，`downloads.sqlite` 沿用同一 schema，中断的任务可以继续。

尚未完成的部分：内置 libav 合流、macOS/Linux 安装器、旧版 `.bilidownexport` 历史文件导入（目前会明确报错而不是导入一半）、缺 Node 环境的完整 UAC/MSI 交互验收、真实慢网/CDN 切换测试。

本分支没有内置 AI 模型，也不会因为下载功能将视频上传到 AI 服务。
