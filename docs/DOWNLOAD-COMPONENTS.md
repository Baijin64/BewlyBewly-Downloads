# 本地助手精简与 Node.js 安装流程

2026-10-16。用户最终选择：去掉内置 Node.js，保留 FFmpeg 和 aria2；环境检测与一键下载安装放到本地连接器。网页维持当前界面，GitHub 下载链接等正式发布后再接。

## 当前交付

- 扩展 0.44.0，助手 0.2.6；MSIX 已签名并在本机安装。
- 新包 28,953,835 字节，安装文件 68,287,536 字节（约 27.6 / 65.1 MiB）；不含 node.exe。
- 0.2.4 的安装包为 66,479,387 字节，安装载荷约 158 MiB；原包内 Node 约 87 MiB，FFmpeg 58 MiB，aria2 5.7 MiB，迁移依赖 6.4 MiB。
- 正式构建已仅保留 Windows x64 迁移依赖，约 0.96 MiB，去掉其他平台预编译库、测试和编译源码。
- 本机复用 C:\Program Files\nodejs\node.exe 24.14.1，没有重新安装或升级系统 Node。
- 保留原有 1 条完成记录及全部设置，没有导入旧配置或新增真实下载任务。

## 启动与安装

1. 安装 MSIX 后从开始菜单打开 Bewly 下载助手，注册浏览器连接器。
2. 检查注册表、最新的用户/系统 PATH 和常见安装位置；实际执行受限的能力探测，要求 Node 24+、x64、SQLite 与所需网络 API。
3. 兼容版本存在时直接启动服务，桥接与服务使用同一个绝对路径；不依赖当前工作目录或 shell 搜索。
4. 缺少或不兼容时显示本地窗口：“下载并安装 Node.js”“重新检测”“稍后”，并提供官网入口。
5. 用户点击后，从 nodejs.org 的 Node 24 官方分支获取 x64 MSI 发布清单，下载安装包、校验 SHA-256 和 Windows 数字签名，再调用 Windows Installer。可能出现 UAC 授权；不绕过 Windows 安装授权，不强制重启。
6. 安装完成后重新检测注册表与 PATH，无需只为了刷新 PATH 重启浏览器；取消、重启要求或失败时显示对应状态，可重试或官网手动安装。
7. 清理本次临时 MSI。已安装的系统 Node 与连接器保留，后续本地调用仍需要它们。

Node 下载官网：https://nodejs.org/zh-cn/download。应用从官方 latest-v24.x/SHASUMS256.txt 选择版本化 x64 MSI，不接受网页传入任意安装地址。

高级本地环境可用 BEWLY_NODE_PATH 明确指定 node.exe，仍需通过兼容检查。进程启动会去掉 NODE_OPTIONS / NODE_PATH，避免外部启动参数干扰本应用。此配置不提供给普通网页。

## MSIX 与系统 Node 的兼容

实际安装测试发现，外部系统 Node 不能直接加载 WindowsApps 内的 LevelDB 原生模块。连接器会将唯一必需的数据库原生模块按内容哈希缓存在自己的数据目录，约 0.52 MiB，并验证内容。不会复制整套 Node 或 FFmpeg。

FFmpeg 和 aria2 仍留在签名 MSIX 中，由包内连接器启动；系统 Node 负责调度。工具被限制为这两个固定名称，使用参数数组语义，保留 Unicode 路径。工具进程加入 Windows Job Object，结束代理时同时结束其媒体子进程，防止遗留进程。

不自动卸载 MSIX 或删除系统 Node。浏览器桥接空闲后退出，下载服务的空闲退出时间继续使用原配置；当前记录、自动关机、剪贴板等设置不被升级改写。

## 已完成验证

- [x] 41 项原生回归通过，包括下载暂停/恢复、FFmpeg 全输出、迁移、管道、无 Node 引导、版本与架构拒绝、安装清单、窗口布局和媒体子进程清理。
- [x] 实际 MSIX 更新后通过原应用别名启动，使用系统 Node，托盘联系服务，桥接管道释放，服务继续存活。
- [x] 实际安装包中的 FFmpeg 经系统 Node 调度完成合成音频转 MP3；aria2 执行成功。验证在独立临时数据目录进行。
- [x] 官方 Node 24.22.0 x64 MSI 实际下载，SHA-256 与 Windows 签名验证通过，随后清理临时文件。
- [x] 未重复安装已有兼容 Node，未改变用户下载记录和设置。

本机已有 Node，因此没有通过卸载/重装本机 Node 来测试 UAC 与 MSI 的完整安装交互。该路径已实现，仍需在缺少 Node 的独立 Windows 环境验收。安装窗口图片是控件离屏渲染，不是操作桌面所得的截图。

主要证据：
- dist/helper-slim-size-0.2.6.json
- dist/native-ui-0.2.6-verification.json
- dist/helper-update-0.2.6-verification.json
- dist/installed-runtime-0.2.6-verification.json
- dist/node-installer-download-verification.json
- dist/native-tests-0.2.6.log

## 保留到后续

FFmpeg/aria2 独立组件包、私有 Node 运行组件、独立迁移组件均不在本次交付。连接器正式 GitHub 下载地址待用户发布后接入；网页插件无需为本次原生精简重载。慢网线路实测、AI/MCP 等原计划仍保持延后。
