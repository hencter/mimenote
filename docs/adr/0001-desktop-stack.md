# ADR-0001：桌面栈选 Tauri 2 + Rust，而非 Electron

- 状态：已采纳
- 日期：M1

## 背景

需要跨平台桌面壳，且必须满足"冷启动 ≤1.5s（1 万笔记）、内存 ≤500MB、输入延迟 ≤16ms"。核心重量级工作是**文件 IO 与索引**（扫描 1 万文件、解析 Markdown、SQLite FTS5 写入）。

## 决策

采用 **Tauri 2（Rust 宿主）+ WebView2/WKWebView/WebKitGTK 渲染前端**，重量级逻辑用 Rust 实现，前端只做 UI 与交互。

## 理由

1. **资源占用**：Electron 每个窗口自带 Chromium（基线内存约 100MB+），Tauri 复用系统 WebView，量级差异直接决定内存预算能否达标。
2. **索引性能**：SQLite FTS5 与 Markdown 解析在 Rust 侧可复用同一进程地址空间，避免 Node 与 Rust 之间的序列化往返；`notify`、`tokio`、`pulldown-cmark` 生态成熟。
3. **安全面**：Tauri 的能力（capability）系统默认拒绝一切 IPC 与原生 API，必须显式声明；CSP 可配。Electron 的默认面更宽。
4. **打包体积**：安装包量级小一个数量级（对笔记工具这种"装了就常驻"的应用有意义）。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| 三平台 WebView 内核差异（渲染/API 细节） | 只用标准 DOM/CSS；自测基线在 Windows（WebView2/Chromium），宏观看齐 Chrome 110+ |
| Rust 学习/编译成本，首次构建慢 | `Cargo.toml` 中对依赖开 `opt-level = 3`、应用自身 `opt-level = 0`，平衡编译与运行；纯逻辑抽到 `mn-core` 保持秒级单测 |
| 生态插件少于 Electron | 关键能力（dialog/fs/shell/updater）官方插件齐备，其余自研 |
| 调试 WebView 内问题需开发者工具 | dev 模式开启 devtools；Rust 侧 `env_logger` 结构化日志 |

## 替代方案

- **Electron**：生态最成熟，但内存/体积与预算冲突，除非后续需要 Node 原生模块深度集成。
- **纯 Web（File System Access API）**：无法访问任意路径的 Vault、无法做后台索引与系统级集成，定位不符。

## 影响

`src-tauri` 只做 IPC 与状态；业务逻辑在 `crates/mn-core`（M2 起 `crates/mn-index`）。前端不假设任何 Node 能力。
