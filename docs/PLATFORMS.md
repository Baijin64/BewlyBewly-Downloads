# 下载助手平台支持

本目录记录 Windows / Android / macOS / Linux 四端下载助手的能力、安装与构建现状。核心协议、分片下载引擎、任务持久化与业务逻辑已统一由纯 Rust 实现（`rust/crates/*`），平台差异集中在 `platforms/` 下的宿主与安装包外壳；旧版 `native/`（Node.js / aria2）已彻底移除。

## 能力对照

| 能力 | Windows | Android | macOS | Linux |
| --- | --- | --- | --- | --- |
| 核心引擎 | Rust `bewly-host` | Rust `bewly-android`（JNI） | Rust `bewly-host` | Rust `bewly-host` |
| 桌面/移动界面 | NativeAOT 托盘（吉祥物图标） | Jetpack Compose 独立 App | 菜单栏源码已保留（待重打包） | 无托盘界面 |
| 合流 / MP3 | 内置精简 LGPL `bin\ffmpeg.exe` | 内置 `jniLibs/<abi>/libffmpeg.so` | 可由 `build-ffmpeg.sh` 编译 | 可由 `build-ffmpeg.sh` 编译 |
| 文件/目录选择 | 原生对话框（`rfd`） | MediaStore 自动导出 + SAF 文档选择 | 原生对话框 / `BewlyTray` | `rfd` / 手填路径 |
| 剪贴板监听 | ✅ | 手动粘贴 + 系统分享接收 | 托盘源码支持 | ❌ |
| 下载完成关机 | ✅（可取消 30s 倒计时） | ❌ | 托盘源码支持 | ❌ |
| 登录信息保护 | DPAPI | 应用私有目录（`allowBackup=false`） | Keychain / 0600 文件 | 0600 文件 |
| 外部运行时依赖 | 无（无需 Node.js / aria2） | 无 | 无 | 无 |
| 当前分发状态 | ✅ MSIX 完整构建 | ✅ Gradle APK 构建（`arm64-v8a`） | 仅裸二进制 `bewly-host` | 仅裸二进制 `bewly-host` |

## Windows

见 [INSTALL-DOWNLOADS.md](./INSTALL-DOWNLOADS.md) 与 [BUILD-DOWNLOADS.md](./BUILD-DOWNLOADS.md)。安装 MSIX 后从开始菜单启动一次即可完成 Chrome/Edge Native Messaging 注册。

## Android

Android 独立客户端位于 `platforms/android/`（Jetpack Compose + Foreground Service + MediaStore 导出 + B 站 WebView 登录）：

1. 在仓库根目录使用 `cargo-ndk` 编译原生引擎到 `platforms/android/app/src/main/jniLibs/arm64-v8a/libbewly_android.so`：
   ```sh
   cargo ndk -t arm64-v8a -o platforms/android/app/src/main/jniLibs build --release --manifest-path rust/Cargo.toml -p bewly-android
   ```
2. 按需编译内置 FFmpeg 到 `jniLibs/<abi>/libffmpeg.so`：
   ```sh
   bash scripts/toolchain/build-ffmpeg-docker.sh android-arm64
   ```
3. 在 `platforms/android/` 下使用 `./gradlew assembleDebug` / `./gradlew assembleRelease`（配置 `BEWLY_ANDROID_KEYSTORE*` 环境变量进行正式签名）或 `./gradlew testDebugUnitTest` 运行单测。

详细步骤见 [platforms/android/ANDROID_STUDIO_TASK.md](../platforms/android/ANDROID_STUDIO_TASK.md)。

## macOS / Linux（待重写打包脚本）

- Rust 核心与 `bewly-host` 已在 GitHub Actions 的 `linux-x64`、`darwin-arm64`、`darwin-x64` 上通过测试并产出裸二进制（`bewly-host-<target>.tar.gz`）。
- `scripts/toolchain/build-ffmpeg.sh` 已支持构建各平台的精简 LGPL FFmpeg。
- `platforms/linux/install.sh`、`platforms/linux/bewly-download.service` 及 macOS `.app` 打包脚本目前仍停留在已退役的 Node 目录结构（`launcher.sh`、`fetch-node.sh`），尚未重写为 Rust 单文件宿主 + 内置 FFmpeg 布局，因此 `scripts/build-helper.ts` 对 `linux` / `darwin` 目标会直接提示并返回退出码 3。

## 构建命令

```sh
npx esno scripts/build-helper.ts --target win32-x64     # 转调 build-helper.ps1（需 Windows SDK、.NET SDK 与 FFmpeg）
cargo test --manifest-path rust/Cargo.toml              # 验证全平台 Rust 核心与服务测试
cargo build --manifest-path rust/Cargo.toml --release -p bewly-host
```

## 已知限制

- macOS 与 Linux 尚未提供面向终端用户的安装器与内置 FFmpeg 成品包。
- Linux 无托盘、无剪贴板监听、无自动关机，扩展设置会根据 `health.capabilities` 自动隐藏对应项。
- Android 目前默认打包 `arm64-v8a` ABI；真机全链路回归测试需在实体设备或模拟器上执行。
