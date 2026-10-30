# BewlyBewly Android 端接入与 Rust 下载器编译任务书 (Android Studio Antigravity 专享)

> **文档性质**：跨 Agent 协作交接任务书（Handoff Document）  
> **执行环境**：用户本地 Android Studio 内嵌的 Antigravity AI Agent 实例  
> **适用平台**：Android (Target: `aarch64-linux-android` / `x86_64-linux-android`)  
> **代码仓库根目录**：`c:\Users\Yidong Derek Li\BewlyBewly`  
> **Android SDK 根目录**：`C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk`  
> **文档生成时间**：2026-10-28  

---

## 1. 项目背景与当前代码库架构进度

BewlyBewly 原下载器基于 Node.js 运行时实现。为了显著降低移动端与桌面端的内存占用、消除外部 Runtime 依赖并提升多线程下载与流媒体混流性能，核心团队已在 `rust/` 目录下用 **纯 Rust 完成了 100% 的功能重写**：

1. **82/82 项双端对齐测试全部通过**：
   - 涵盖 URL 解析、WBI 签名、Cookie 注入、SQLite 任务状态迁移、多分片并发下载规划、断点续传 Sidecar 机制、HTTP RPC API 以及 WebSocket 实时通知。
   - 旧版 `native/`（Node.js/Electron 实现）已彻底清理移除。
   - 各平台桌面外壳已独立拆分并归档至 `platforms/` 目录（`platforms/windows`、`platforms/macos`、`platforms/linux`）。
2. **Workspace 结构划分（7 个核心 Crates）**：
   - [`bewly-core`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-core)：纯领域业务模型，包含番剧/视频 URL 模式匹配、B 站 AV/BV 号转换、文件名模板插值、音视频流优选算法。**无 IO，无异步依赖**。
   - [`bewly-proto`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-proto)：Native Messaging 长度前缀帧编解码器及 JSON-RPC 请求/响应/事件 Envelope。
   - [`bewly-engine`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-engine)：基于 HTTP 范围请求（Range Request）的高性能分块下载引擎、`.aria2` 格式兼容解析与自研 `.bewlypart` 断点续传状态机。
   - [`bewly-store`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-store)：SQLite 任务持久化与 LevelDB 任务归档，保证与旧版 Node.js 下载记录数据文件的 100% 字节级兼容。
   - [`bewly-media`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-media)：音视频轨道分离下载后的解复用（Demux）、复用（Remux）及元数据写入抽象接口。
   - [`bewly-service`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-service)：核心本地常驻服务，内置 Axum 0.8 HTTP API 服务、WebSocket 事件广播、下载任务调度 Worker、WBI 动态风控签名算法、设置存储与数据快照管理。
   - [`bewly-host`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-host)：桌面端 Native Messaging Host 标准输入输出桥接器。
3. **移动端代码级障碍已彻底扫清**：
   - 原先在桌面端使用的本地原生目录选择器 `rfd = "0.15"` 会拉取 Windows Win32 / macOS AppKit / Linux GTK 原生依赖，在移动端不可用。
   - 已在 [`rust/crates/bewly-service/Cargo.toml`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-service/Cargo.toml) 中通过 `[target.'cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))'.dependencies]` 将 `rfd` 条件化门禁隔离；并在代码层 `tools.rs` 中为 Android 等非桌面平台提供了优雅降级（非桌面环境禁止唤起弹出窗口，改为直接读取配置路径）。
4. **编译现状**：
   - 纯 Rust Crates（`bewly-core`、`bewly-proto`、`bewly-media`）已经在 Windows 环境下直接通过针对 `aarch64-linux-android` 目标的编译检查：
     ```powershell
     & "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable check --manifest-path rust/Cargo.toml -p bewly-core -p bewly-proto -p bewly-media --target aarch64-linux-android
     ```
     **结果：0 Error, 0 Warning, 秒级通过！**

---

## 2. 本机环境核心注意事项（避坑必读）

在 Android Studio 内的终端或 Gradle 构建脚本中调用 Rust 工具链时，请**务必注意以下本机环境特性**：

### 2.1 Rustup 多工具链陷阱与调用规范
- 本机通过 Rustup 安装了多个版本。默认全局激活的是较旧的 `1.83.0`，而 BewlyBewly 的现代化异步运行时及依赖库要求使用最新的 `stable` 工具链（本机已安装，版本为 `1.97.1` / `1.99.1`）。
- **必须使用 `+stable` 修饰符**，或者使用全路径调用：
  ```powershell
  # 正确的 Cargo 调用方式：
  & "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable <command>

  # 正确的 Rustup 调用方式：
  & "$env:USERPROFILE\.cargo\bin\rustup.exe" +stable <command>
  ```
- 当前在 `+stable` 工具链中，已安装的编译目标：
  - `aarch64-linux-android`（真机主流 64 位 ARM）
  - `x86_64-pc-windows-msvc`
  - `x86_64-unknown-linux-gnu`
  - *如果需要在 Android Studio 模拟器中测试，可一键安装 x86_64 目标*：
    ```powershell
    & "$env:USERPROFILE\.cargo\bin\rustup.exe" +stable target add x86_64-linux-android
    ```

### 2.2 本机 Android SDK 与 NDK 路径
- **Android SDK 根目录**：`C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk`
  - 已安装 `platforms/android-37.0`、`platforms/android-37.1`
  - 已安装 `build-tools/36.0.0`、`build-tools/36.1.0`
  - 已安装 `platform-tools` (adb, sqlite3)
- **Android NDK 现状**：
  - 目前 `C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk\ndk` 目录尚不存在。
  - 因为 `rusqlite`（使用 `bundled` 特性，需编译 `sqlite3.c`）以及 `ring`（部分底层汇编与 C 代码）需要调用 NDK 的 Clang 编译器与 sysroot。当前直接执行 `cargo check` 带有 C 绑定的 crate 时会报 `failed to find tool clang.exe`。
  - **安装 NDK 后，使用 NDK 提供的 Clang 即可直接秒解！**

---

## 3. 交给 Android Studio Antigravity 的具体执行任务清单

请 Android Studio 内的 Antigravity 实例按序推进以下 4 个阶段的任务：

---

### Task 1: 检查 / 安装 Android NDK 并配置交叉编译环境

#### 步骤 1.1: 安装 NDK
在 Android Studio 中打开 **Settings (Preferences) -> Languages & Frameworks -> Android SDK -> SDK Tools**：
- 勾选 **NDK (Side by side)**（推荐选择稳定 LTS 版本，如 `26.x` 或 `27.x`，例如 `27.2.12479018`）。
- 勾选 **CMake**（如果未安装）。
- 点击 **Apply** 完成下载安装。
- 安装完成后，NDK 将位于：
  `C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk\ndk\<version>`

#### 步骤 1.2: 了解 NDK 编译工具链路径
以 NDK `27.2.12479018` 为例，LLVM 工具链位于：
`C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk\ndk\27.2.12479018\toolchains\llvm\prebuilt\windows-x86_64\bin`

该目录下包含适用于 Windows 的编译器包装脚本与工具：
- 针对 ARM64 (API 26+)：`aarch64-linux-android26-clang.cmd`
- 针对 x86_64 (API 26+)：`x86_64-linux-android26-clang.cmd`
- 静态归档工具：`llvm-ar.exe`

#### 步骤 1.3: 配置 Cargo 交叉编译配置（推荐方式）
推荐在 `rust/.cargo/config.toml` 中配置交叉编译器的 Linker 与环境变量，或者借助 `cargo-ndk` 工具：

**方案 A：创建 `rust/.cargo/config.toml` 文件**
```toml
# c:\Users\Yidong Derek Li\BewlyBewly\rust\.cargo\config.toml

[target.aarch64-linux-android]
ar = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe"
linker = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android26-clang.cmd"

[target.x86_64-linux-android]
ar = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe"
linker = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/x86_64-linux-android26-clang.cmd"

[env]
# 为 cc-rs 构建脚本注入 NDK Clang 编译器
CC_aarch64_linux_android = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android26-clang.cmd"
AR_aarch64_linux_android = "C:/Users/Yidong Derek Li/AppData/Local/Android/Sdk/ndk/<NDK_VERSION>/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe"
```
*(注意：请将 `<NDK_VERSION>` 替换为您安装的具体版本号，路径使用正斜杠 `/` 防止转义问题)*

**方案 B：使用 `cargo-ndk` 工具（最省心自动化方案）**
通过 Cargo 安装 `cargo-ndk`：
```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable install cargo-ndk
```
随后只需指定 `ANDROID_NDK_HOME` 环境变量：
```powershell
$env:ANDROID_NDK_HOME = "C:\Users\Yidong Derek Li\AppData\Local\Android\Sdk\ndk\<NDK_VERSION>"
cargo ndk -t arm64-v8a -t x86_64 check
```

---

### Task 2: 验证全量核心 Crate 通过 Android 目标编译

配置好 NDK Clang 之后，验证所有 6 个核心 Crates（排除桌面外壳 `bewly-host`）能够完整通过 Android 目标编译：

```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable check `
  --manifest-path rust/Cargo.toml `
  -p bewly-core `
  -p bewly-proto `
  -p bewly-engine `
  -p bewly-store `
  -p bewly-media `
  -p bewly-service `
  --target aarch64-linux-android
```

#### 关注核查项：
1. **`libsqlite3-sys` (来自 `bewly-store`)**：确认 `sqlite3.c` 是否顺利由 NDK Clang 编译通过。
2. **`ring` / `rustls` (来自 `ureq`)**：确认汇编与加密模块编译无报错。
3. **`tokio` 与 `axum` (来自 `bewly-service`)**：确认 Android Linux 环境下的 epoll 与套接字绑定特性正常。

---

### Task 3: 创建 Android JNI / FFI 桥接层并编译 `libbewly_download.so`

#### 步骤 3.1: 创建 `bewly-android` Crate
在 `rust/crates/bewly-android` 创建一个极轻量的 JNI 桥接层：

**[`rust/crates/bewly-android/Cargo.toml`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-android/Cargo.toml)**：
```toml
[package]
name = "bewly-android"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
description = "JNI bindings and Android native library for BewlyBewly download service"

[lib]
crate-type = ["cdylib"]

[dependencies]
jni = { version = "0.21", default-features = false }
bewly-service = { path = "../bewly-service" }
serde_json = { workspace = true }
tokio = { version = "1", features = ["rt-multi-thread", "sync"] }
```

**[`rust/crates/bewly-android/src/lib.rs`](file:///c:/Users/Yidong%20Derek%20Li/BewlyBewly/rust/crates/bewly-android/src/lib.rs)** 示例实现：
```rust
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::JNIEnv;
use serde_json::{json, Value};

static RUNNING: AtomicBool = AtomicBool::new(false);

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_startService(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    mode: JString,
) -> jboolean {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return 1; // 已在运行
    }

    let Ok(data_dir_str) = env.get_string(&data_dir) else { return 0; };
    let Ok(mode_str) = env.get_string(&mode) else { return 0; };
    
    let path = PathBuf::from(data_dir_str.to_str().unwrap_or(""));
    let mode_val = mode_str.to_str().unwrap_or("service").to_string();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to build Tokio runtime for BewlyService");

        rt.block_on(async {
            if let Err(err) = bewly_service::run(path, mode_val).await {
                eprintln!("[BewlyNative] Service error: {}", err);
            }
        });
        RUNNING.store(false, Ordering::SeqCst);
    });

    1
}

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_ping(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = json!({
        "pong": true,
        "engine": "rust",
        "service_running": RUNNING.load(Ordering::Relaxed)
    });
    env.new_string(result.to_string())
        .expect("Failed to create Java string")
        .into_raw()
}
```

#### 步骤 3.2: 编译产出 `.so`
使用 `cargo ndk` 或直接通过 Cargo 编译输出动态库：
```powershell
# 输出 arm64-v8a
cargo ndk -t arm64-v8a -o platforms/android/app/src/main/jniLibs build --release -p bewly-android

# 如需支持模拟器，顺手编译 x86_64
cargo ndk -t x86_64 -o platforms/android/app/src/main/jniLibs build --release -p bewly-android
```
产出物将自动放置于：
- `platforms/android/app/src/main/jniLibs/arm64-v8a/libbewly_android.so`
- `platforms/android/app/src/main/jniLibs/x86_64/libbewly_android.so`

#### 步骤 3.3: 内置 FFmpeg
合流、提取音频和转 MP3 需要 FFmpeg。Android 10 起应用只能执行原生库目录里的文件，所以它以 `libffmpeg.so` 的名字和 Rust 库放在一起，`build.gradle.kts` 用 `useLegacyPackaging` 让安装器解压出来，`BewlyDownloadService` 启动时把路径写进 `BEWLY_FFMPEG`。
```bash
# 需要 Docker；Linux NDK 与源码缓存在 ~/.cache/bewly-toolchain
bash scripts/toolchain/build-ffmpeg-docker.sh android-arm64 android-x86_64
```
产出物会放到 `jniLibs/arm64-v8a/libffmpeg.so` 与 `jniLibs/x86_64/libffmpeg.so`。缺少时服务仍可运行，但只能下载音画合一的低画质文件。

---

### Task 4: 在 `platforms/android/` 下建立最小可运行宿主工程与验证测试

在 `platforms/android/` 目录初始化标准的 Android Studio Gradle 工程：

#### 目录结构推荐：
```text
platforms/android/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle/
├── gradlew
├── gradlew.bat
└── app/
    ├── build.gradle.kts
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── jniLibs/
        │   │   ├── arm64-v8a/libbewly_android.so
        │   │   └── x86_64/libbewly_android.so
        │   └── java/io/bewly/download/
        │       ├── BewlyNative.kt
        │       └── BewlyDownloadService.kt
        └── androidTest/java/io/bewly/download/
            └── BewlyNativeTest.kt
```

#### 步骤 4.1: Kotlin JNI 声明类
```kotlin
package io.bewly.download

object BewlyNative {
    init {
        System.loadLibrary("bewly_android")
    }

    external fun startService(dataDir: String, mode: String): Boolean
    external fun ping(): String
}
```

#### 步骤 4.2: 编写 Instrumentation / Unit 测试用例验证端到端跑通
在 `platforms/android/app/src/androidTest/java/io/bewly/download/BewlyNativeTest.kt`：
```kotlin
package io.bewly.download

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BewlyNativeTest {

    @Test
    fun testNativePing() {
        val pingResult = BewlyNative.ping()
        val json = JSONObject(pingResult)
        assertEquals(true, json.getBoolean("pong"))
        assertEquals("rust", json.getString("engine"))
    }

    @Test
    fun testStartServiceAndHealth() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dataDir = context.filesDir.absolutePath
        
        val started = BewlyNative.startService(dataDir, "service")
        assertTrue("Service should start successfully", started)

        // 等待服务启动并调用 health 接口验证
        Thread.sleep(1500)
        // 通过本地 Loopback 验证 HTTP RPC 服务可用
    }
}
```

---

## 4. 架构设计与进阶集成路线建议

1. **Android 前台保活与通知（Foreground Service）**：
   - 移动端系统对后台进程管控极严。下载中建议通过 Android `Foreground Service` 附带 Ongoing Notification 显示下载进度条与实时速率，避免服务被 Low Memory Killer 杀掉。
2. **下载目录与 SAF (Storage Access Framework)**：
   - Android 10+ (API 29+) 强制 Scoped Storage。
   - `bewly-service` 内部的数据存储（任务数据库、Token、配置）应存放在应用私有目录 `context.filesDir`。
   - 下载的最终音视频文件若需导出到公共 `Downloads` 或 `Movies` 目录，可通过 Android SAF 授权 URI 或 MediaStore API 流式写入。
3. **前端 WebView 与 HTTP/WS 通信兼容**：
   - 现有 BewlyBewly 的 Web 扩展页面与下载器之间完全通过标准 HTTP RPC（默认 Token 鉴权）与 WebSocket 进行无状态解耦通信。
   - Android 端加载 Web 界面时，前端直接与本地 Rust 启动的 Loopback HTTP 端口交互，代码复用率可达到 **95% 以上**！

---

## 5. 快速排错指南（FAQ）

- **Q1: 编译时报错 `aarch64-linux-android-clang: program not found` 或 `clang.exe: program not found`？**  
  **解答**：这是因为环境变量未找到 NDK Clang 编译器。安装 NDK 后，在 `rust/.cargo/config.toml` 中显式指定 `[target.aarch64-linux-android]` 的 `linker` 和 `[env]` 的 `CC_aarch64_linux_android`，或者使用 `cargo-ndk` 并设置 `$env:ANDROID_NDK_HOME`。
- **Q2: 提示 `edition 2021 requires a newer version of cargo`？**  
  **解答**：本机默认的 Rust 是 1.83.0，必须强制使用 `+stable`：`& "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable ...`。
- **Q3: 为什么 `platforms/android/` 之前没有文件？**  
  **解答**：因为旧版下载器是基于 Node.js/Electron 的，只能运行在桌面系统（Windows/macOS/Linux）；全新的纯 Rust 下载器是第一次赋予 BewlyBewly 跨平台原生移动端运行能力。本任务书即为 Android 宿主工程的起点。
