# Mimenote 架构（M1 基线）

> 状态：M1 实现中 · 最后更新：见 git 历史
> 本文是**权威架构文档**。任何与代码冲突的描述都视为 bug，需修正代码或修正本文。

## 1. 目标与假设

**产品目标**：本地优先、高度可自定义、高性能、交互丝滑的 Markdown 知识库桌面应用。

**M1 目标**：一条真正跑通的最小闭环 —— 选择 Vault → 文件树 → 编辑 Markdown → 原子保存 → 实时预览，且这条闭环上的每一层都按最终架构分层落位，后续里程碑只做**增量扩展**，不做推倒重来。

**已确认的假设**（来自需求澄清）：

| 决策点 | 结论 |
| --- | --- |
| 目标平台 | Windows 优先，代码保持跨平台（路径/文件 API 全部走 std + 跨平台语义） |
| 技术栈 | Tauri 2 + Rust + React 19 + TypeScript + Vite + CodeMirror 6 + Zustand + SQLite FTS5（M2 引入） |
| 插件系统 | M1 只提供**内置扩展点**（命令、快捷键、主题、CSS 片段、编辑器扩展），第三方插件放到 M4 |
| 同步/协作 | 不做。只保证纯 Markdown + 可被 Git 管理 |
| 规模基线 | 1 万笔记，使用默认性能预算（见第 6 节） |
| 网络 | 默认离线：无遥测、无自动上传、运行时无出站请求 |

**M1 非目标**（明确推迟，避免范围蔓延）：双链/反链、标签索引、全文搜索、快速切换、命令面板 UI、图谱、SQLite 索引、第三方插件、Git 集成、移动端、内嵌图片渲染（见 §8 已知限制）。

## 2. 分层与模块边界

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI 层 (React)            分片订阅 · 虚拟列表 · 乐观更新 · 骨架屏        │
│  apps/desktop/src/features/*                                         │
├──────────────────────────────────────────────────────────────────────┤
│  状态层 (Zustand)         vault-store / note-store / ui-store          │
│  领域层 (纯 TS，可单测)    domain/tree · virtual-list · eol · markdown  │
│  扩展层 (内置扩展点)       app/commands（命令注册表 + 快捷键）           │
│  主题层                   theme/apply（CSS 变量 + JSON 主题 + 片段）     │
├──────────────────────────────────────────────────────────────────────┤
│  IPC 层                   ipc/client（可替换适配器）→ Tauri invoke      │
├──────────────────────────────────────────────────────────────────────┤
│  应用层 (Rust)            src-tauri：状态、命令、错误码、能力声明         │
├──────────────────────────────────────────────────────────────────────┤
│  文件层 (Rust, mn-core)   路径防护 · 原子写 · 扫描 · 回收站 · 文本统计    │
│  （M2 起新增：索引层 mn-index，SQLite FTS5，独立于文件层）               │
└──────────────────────────────────────────────────────────────────────┘
```

**边界规则**（可据此判断新代码放哪）：

1. `mn-core` 是**纯 Rust 库**，不依赖 `tauri`，可 `cargo test -p mn-core` 独立验证。凡是"与 UI 框架无关、且必须在 Rust 侧做"的逻辑（路径安全、原子写、大目录扫描、回收站）都放这里。
2. `src-tauri` 只做三件事：持有会话状态、把 mn-core 能力暴露成 IPC 命令、把错误映射成稳定错误码。**不放业务逻辑**。
3. `domain/` 是纯函数 + 纯数据结构，禁止 import React/Zustand/Tauri。
4. 组件不直接调用 IPC，必须经 store；store 不直接 `invoke`，必须经 `ipc/client`。
5. 每个副作用（监听器、定时器、注入的 `<style>`、CM 扩展）都必须可逆：组件卸载即清理。

## 3. 接口与数据流

### 3.1 IPC 契约

所有 DTO 由 Rust `serde(rename_all = "camelCase")` 定义，TS 侧在 `src/ipc/types.ts` 手工镜像。契约条款：

- **错误**：命令一律返回 `Result<T, IpcError>`，`IpcError = { code, message, detail?, currentMtimeMs? }`。`code` 是稳定字符串（见 `src/ipc/types.ts` 的 `ErrorCode`），UI 只按 `code` 分支，不解析 message。
- **路径**：跨 IPC 只传**相对于 Vault 根的 POSIX 风格相对路径**（如 `notes/日拱一卒.md`）。绝对路径只在 `vault_open` 入参和 `VaultInfo.rootPath` 出现。
- **时间**：一律毫秒时间戳（`mtimeMs`），用作版本令牌（version token）。
- **写操作**：`note_write` 必须携带 `baseMtimeMs`，Rust 侧二次校验，冲突返回 `CONFLICT`（详见 ADR-0004）。

| 命令 | 入参 | 出参 | 说明 |
| --- | --- | --- | --- |
| `vault_open` | `path` | `VaultSnapshot` | 打开并扫描 Vault，**一次调用同时返回概要与完整条目表**（避免"先 open 再 snapshot"的二次全量扫描） |
| `vault_info` | — | `VaultInfo \| null` | 当前会话 Vault 概要（不重扫，未打开返回 `null`） |
| `vault_snapshot` | — | `VaultSnapshot` | 重新扫描并刷新缓存 |
| `vault_close` | — | `void` | 释放 Vault 上下文 |
| `note_read` | `relPath` | `NoteContent` | 读取原文（不解释 BOM/换行，交给前端领域层） |
| `note_write` | `relPath, text, baseMtimeMs?, force` | `WriteOutcome` | 冲突检查 + 原子写 + 返回新 mtime |
| `note_create` | `parentRel, title` | `NoteContent` | 唯一命名，返回新笔记 |
| `note_delete` | `relPath, confirm` | `TrashRecord` | `confirm=false` 时返回 `CONFIRMATION_REQUIRED` |
| `note_stats` | `relPath` | `DocumentStats` | 磁盘上文档的真实统计（`mn_core::text_stats`），与编辑器内即时统计互为校验 |
| `snippets_list` | — | `SnippetFile[]` | 读取 `.mimenote/snippets/*.css` |
| `version_info` | — | `VersionInfo` | 应用 / mn-core / Tauri 版本 |

### 3.2 打开 Vault 的数据流

```
用户点"打开文件夹"
  → @tauri-apps/plugin-dialog 选择目录（系统对话框，前端直接调用）
  → ipc.vaultOpen(path)
      → Rust: VaultRoot::new（canonicalize、校验是目录）
      → spawn_blocking: mn_core::scanner::scan（迭代式、不跟随符号链接、忽略规则）
      → 缓存扫描结果到 AppState，返回 VaultSnapshot（概要 + 完整条目表）
  → vault-store: 存 entries[]，按需构建树（domain/tree）
  → FileTree: flattenVisible + computeWindow 虚拟化渲染（只挂载可视行）
  → 读取上次打开的笔记 → note_read → 编辑器
```

关键点：**打开 Vault 只扫描一次**。后续创建/删除/保存返回增量，前端直接改本地 store，不重扫——这是 1 万笔记下不被 IO 拖死的核心。

### 3.3 编辑到保存的数据流（含冲突处理）

```
CM6 updateListener（每次输入，仅更新 store + dirty 标记，无 IO）
  → note-store.updateText：调度防抖保存（默认 600ms，可配）
  → 保存串行化：单飞（in-flight）标志 + 待写标记，永不并发写同一文件
  → ipc.noteWrite(relPath, text, baseMtimeMs, force=false)
      → Rust: 加写锁（每 Vault 一把）→ stat 当前 mtime → 与 baseMtimeMs 比对
          相等 → write_atomic（同目录临时文件 + fsync + rename 覆盖）
          不等 → Err(CONFLICT, currentMtimeMs)
  → 成功：更新 baseMtimeMs / lastSavedAt / 保存耗时（状态栏显示）
  → CONFLICT：进入 conflict 状态，UI 顶部横幅给出「覆盖保存 / 重新加载」，绝不静默覆盖
```

编辑器输入路径上**没有任何同步 IO、没有全量重渲染**：文本变更只进 store（Zustand 分片订阅），预览用 `useDeferredValue` 降优先级，保存全异步。

## 4. 关键决策（ADR 索引）

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [ADR-0001](adr/0001-desktop-stack.md) | 桌面栈选 Tauri 2 + Rust 而非 Electron | 已采纳 |
| [ADR-0002](adr/0002-markdown-single-source-of-truth.md) | Markdown 文件是唯一事实来源，索引可重建 | 已采纳 |
| [ADR-0003](adr/0003-ipc-contract-and-async-isolation.md) | IPC 契约 + 文件 IO 全部 `spawn_blocking` 隔离 | 已采纳 |
| [ADR-0004](adr/0004-atomic-write-and-conflict.md) | 原子写 + mtime 版本令牌 + 显式冲突解决 | 已采纳 |
| [ADR-0005](adr/0005-plugin-model-deferred.md) | 第三方插件推迟到 M4，先做内置扩展点 | 已采纳 |

## 5. 安全模型

| 威胁 | 缓解措施 | 落点 |
| --- | --- | --- |
| 路径遍历（`../../etc`） | 相对路径成分白名单校验 + canonicalize 后 `starts_with(root)` 复查 | `mn-core/path_guard.rs` |
| 符号链接逃逸 | 逐级 `symlink_metadata` 检查，符号链接目标必须仍在 Vault 内；扫描默认不跟随链接 | `mn-core/path_guard.rs`、`scanner.rs` |
| Windows 保留名/ADS（`con.md`、`a:b`） | 段级黑名单校验 | `mn-core/path_guard.rs` |
| 半写文件（断电/崩溃） | 临时文件 + fsync + rename 覆盖 | `mn-core/atomic.rs` |
| 误删数据 | 删除必须 `confirm=true`，文件移入 `.mimenote/trash` 并记 jsonl 台账（可恢复） | `mn-core/trash.rs` |
| XSS（笔记内嵌 HTML） | `markdown-it` 关闭 raw HTML + DOMPurify 二次净化 + 严格 CSP（`script-src 'self'`） | `domain/markdown.ts`、`tauri.conf.json` |
| 供应链 | 依赖数量最小化，逐个记录理由/许可证 | `docs/dependencies.md` |
| 隐私 | 无遥测、无自动上传、运行时无出站请求 | 全仓 |

## 6. 性能预算（默认基线，1 万笔记）

| 指标 | 目标 | M1 实测 / 验证方式 |
| --- | --- | --- |
| 冷启动到可交互 | ≤ 1500 ms | 未建立自动基准（M5）；当前无运行时网络请求、无同步阻塞 IO |
| Vault 扫描（1 万文件 + 100 目录） | ≤ 800 ms | **143 ms**（`cargo run -p mn-core --release --example scan_bench`，本机 SSD） |
| 打开 1MB Markdown | ≤ 100 ms | 状态栏显示每次读取耗时（`加载读取`），可直接观察 |
| 输入延迟 | ≤ 16 ms | 结构性保证：输入路径零 IO、编辑器不因文本变化重渲染、预览走 `useDeferredValue` |
| 主线程单任务 | ≤ 8 ms | Rust 侧所有文件 IO 走 `spawn_blocking`；前端只做 O(可视行) 的窗口计算 |
| 保存（本地） | ≤ 50 ms | 状态栏显示每次写入耗时（含 fsync） |
| 文件树滚动 | 稳定 60fps | 固定行高 + 窗口化渲染：DOM 行数 = 可视行 + 2×overscan（与条目总数无关） |
| 内存（1 万笔记） | ≤ 500 MB | M5 接入 |

### 扫描性能的关键实现约束（踩过的坑）

同一份 1 万文件的数据集，两种"取元数据"的写法差 **14 倍**：

| 写法 | 耗时 |
| --- | --- |
| `fs::read_dir` + `DirEntry::file_type()` | 128 ms |
| `+ DirEntry::metadata()`（取 size/mtime） | 145 ms |
| `+ fs::symlink_metadata(path)` | 2227 ms |

原因：Windows 上 `DirEntry` 的 `file_type()` / `metadata()` 复用目录枚举已经返回的数据
（无额外系统调用），而 `symlink_metadata(path)` 每个文件都要重新打开句柄，
在开启实时防护的机器上代价极高。

**结论（新增代码必须遵守）**：扫描/遍历路径上一律使用 `DirEntry` 的缓存元数据，
不要用 `path`-based 的 `fs::*metadata` 逐文件查询；目录不需要 size/mtime，不要为它取元数据。
基准工具：`crates/mn-core/examples/scan_bench.rs`（可指定文件数、可保留目录复用）。

**回归阈值**：M5 起把上表变成可重复基准 + CI 阈值。当前已有的回归门禁：
`cargo test -p mn-core --release -- --ignored bench_scan_10k_notes`（阈值 1500ms）。
工程性约束（不阻塞主线程、不做全量重索引、扫描不用 path-based 元数据）从 M1 起就必须成立。

## 7. 里程碑

见 [milestones.md](milestones.md)。当前进度：**M1（本目录）**。

## 8. 已知限制（M1）

1. **预览不渲染本地图片**：`asset:` 协议需要在运行时按 Vault 动态注入作用域，M2 随「附件规则」一起做。当前 `<img>` 显示为占位（alt 文本）。
2. `[[双链]]` 按普通文本显示（M2 引入 wikilink 解析 + `note/link/tag` 表）。
3. 无全文搜索 / 快速切换 / 命令面板 UI（M2）。命令注册表与快捷键机制已就绪，调用方是 M2 的 UI。
4. 删除走 Vault 内 `.mimenote/trash`（可见、可入 Git 忽略），未对接系统回收站；`restore` 命令在 M2 提供 UI。
5. 外部变更检测依赖 mtime（毫秒）。同一毫秒内的外部改动理论上有漏检窗口（概率极低；M2 引入内容哈希作为二级令牌）。
6. 未做 E2E（Playwright + tauri-driver）：M5 接入。M1 的手动验证清单见 README。
7. 大文档（>5MB）预览仍在主线程渲染（已用 `useDeferredValue` 降级）；M5 迁移到 Web Worker。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Windows 上 WebView2 缺失 | 应用无法启动 | Win11 内置；打包器可配置 `webviewInstallMode` |
| 长路径 / 非 ASCII 路径 | 写入失败 | 统一 canonicalize + 相对路径 IPC + 跨平台测试 |
| OneDrive 同步目录下 rename 语义差异 | 原子写偶发失败 | 原子写失败回退为「直接写 + 保留备份」，并记录日志（M2） |
| CodeMirror 主题依赖 CSS 变量 | 变量名改动导致样式失效 | 变量集中在 `theme/tokens.ts`，单测覆盖必需 token |
| **用 `cargo build --release` 而非 Tauri CLI 构建** | 生产二进制写入 devUrl → 启动后白屏/连不上 127.0.0.1 | README「构建」一节显式警告；只走 `pnpm tauri:build`（该问题已在 M1 复现并定位） |
| 前端资源是**编译期内嵌**的 | 改了前端却没重编 Rust，就会看到旧界面 | `tauri dev` 不受影响；构建流程固定为 `tauri build`（其 `beforeBuildCommand` 会先跑 `pnpm build`） |
| 日志只落盘、不轮转 | 长期使用日志变大 | 单文件超过 2MB 自动重建（`logging.rs`） |
