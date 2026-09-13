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
│  应用层 (Rust)            src-tauri：状态、命令、错误码、能力声明、后台索引       │
├──────────────────────────────────────────────────────────────────────┤
│  索引层 (Rust, mn-index)  链接索引（出链/反链）· 标签索引 · SQLite FTS5 全文搜索（缓存可重建）  │
├──────────────────────────────────────────────────────────────────────┤
│  文件层 (Rust, mn-core)   路径防护 · 原子写 · 扫描 · 回收站 · 文本统计 · 链接抽取  │
└──────────────────────────────────────────────────────────────────────┘
```

**边界规则**（可据此判断新代码放哪）：

1. `mn-core` 是**纯 Rust 库**，不依赖 `tauri`，可 `cargo test -p mn-core` 独立验证。凡是"与 UI 框架无关、且必须在 Rust 侧做"的逻辑（路径安全、原子写、大目录扫描、回收站、链接抽取）都放这里。
2. `mn-index` 同样不依赖 `tauri`，只依赖 `mn-core`：**索引是缓存，可从文件重建**；链接索引、标签索引与 FTS5 全文搜索都落在这里，IPC 契约不变。三者共用同一遍扫描与同一份文本（`LinkIndex::upsert` 里顺手算链接与标签，FTS5 的行表由后台构建写入 `<Vault>/.mimenote/cache/search.db`）。
3. `src-tauri` 只做三件事：持有会话状态、把 mn-core/mn-index 能力暴露成 IPC 命令、把错误映射成稳定错误码。**不放业务逻辑**。
4. `domain/` 是纯函数 + 纯数据结构，禁止 import React/Zustand/Tauri。
5. 组件不直接调用 IPC，必须经 store；store 不直接 `invoke`，必须经 `ipc/client`。
6. 每个副作用（监听器、定时器、注入的 `<style>`、CM 扩展、索引后台任务）都必须可逆：组件卸载/切换 Vault 即清理。

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
| `note_rename` | `relPath, newTitle, updateLinks?` | `RenameOutcome` | 同目录改名 + **全库链接精确改写**（默认 `updateLinks=true`）：按字符 span 改写，保留别名/锚点、跳过代码块、BOM/换行保真；返回被改写的文件与条数 |
| `note_stats` | `relPath` | `DocumentStats` | 磁盘上文档的真实统计（`mn_core::text_stats`），与编辑器内即时统计互为校验 |
| `index_status` | — | `IndexStatus` | 链接索引进度/概况（`idle`/`building`/`ready`/`cancelled`/`failed`） |
| `note_links` | `relPath` | `NoteLinks` | 该笔记的出链与反向链接（含悬空与歧义标记） |
| `note_tags` | `relPath` | `NoteTags` | 该笔记的标签（frontmatter + 正文行内，带来源与行号）与 frontmatter 属性表（保序） |
| `tags_list` | — | `TagSummary[]` | 全库标签概览（按笔记数降序；`key` 是归一化键，`tag` 是首次出现的写法） |
| `tag_notes` | `key` | `TagNotes` | 某个标签下的笔记（传原始写法也可以：宿主入口会再归一化一次） |
| `search_query` | `query, limit?` | `SearchResult` | 全文搜索（SQLite FTS5，倒排索引缓存于 `<Vault>/.mimenote/cache/search.db`）：`-bm25` 排序，返回命中行号与裁剪后的片段；`total` 是命中总数（可大于 `hits.length`） |
| `asset_authorize` | `relPaths[]` | `AssetGrant[]` | 本地图片的**逐文件**读取授权（ADR-0007）：路径经 `path_guard::resolve_existing` 校验后，只把这一个文件加进 asset 作用域并返回磁盘绝对路径；**未通过校验的条目不会出现在返回值里**（调用方留在占位态） |
| `graph_data` | — | `GraphData` | 知识图谱的节点与边（ADR-0010）：节点含 `folder`/`tags`/出入度；边按 `(from,to)` 去重并带 `count`，`toRelPath=null` 表示悬空链接且 **`toRawTarget` 是用户写下的原始目标名**（三者都取第一条链接的写法）；只读索引、不做文件 IO；节点超过 3000 时按度数截断并置 `truncated` |
| `snippets_list` | — | `SnippetFile[]` | 读取 `.mimenote/snippets/*.css` |
| `version_info` | — | `VersionInfo` | 应用 / mn-core / Tauri 版本 |

**事件（宿主 → 前端）**：`mn://index-status` 推送索引进度（`IndexStatus`）。
用事件而不是轮询：索引构建是秒级的一次性过程，前端只需要"被通知"。

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
| [ADR-0006](adr/0006-tags-and-frontmatter.md) | 标签/Frontmatter：解析在 `mn-core`、索引在 `mn-index`、`normalize_tag` 判同、改标签走既有写路径 | 已采纳 |
| [ADR-0007](adr/0007-local-images-asset-protocol.md) | 本地图片走 `asset:` 协议，作用域按 Vault 动态注入（而非 IPC 传 base64 或自定义协议） | 已采纳 |
| [ADR-0008](adr/0008-full-text-search-fts5.md) | 全文搜索用 SQLite FTS5：中文逐字分词、external content 换行号、构建期放宽持久化 + 坏库自愈 | 已采纳 |
| [ADR-0009](adr/0009-wysiwyg-editor.md) | 所见即所得编辑（Live Preview），**移除"编辑 + 预览"双栏**；主区域三选一（编辑 / 阅读 / 图谱） | 已采纳 |
| [ADR-0010](adr/0010-knowledge-graph-card-canvas.md) | 知识图谱是**卡片画布**（非力导向小圆点）：文件夹自动成组、入链虚线/出链实线、卡片可直接预览 | 已采纳 |

## 5. 安全模型

| 威胁 | 缓解措施 | 落点 |
| --- | --- | --- |
| 路径遍历（`../../etc`） | 相对路径成分白名单校验 + canonicalize 后 `starts_with(root)` 复查 | `mn-core/path_guard.rs` |
| 符号链接逃逸 | 逐级 `symlink_metadata` 检查，符号链接目标必须仍在 Vault 内；扫描默认不跟随链接 | `mn-core/path_guard.rs`、`scanner.rs` |
| 预览读取 Vault 外的文件（本地图片） | asset 协议**逐文件授权**：`path_guard::resolve_existing` 逐级检查符号链接 + 越界拒绝，只把通过校验的那一个文件加进作用域。**不用目录级作用域** —— Tauri 的 asset 协议按路径字符串匹配后直接 `File::open`（不 canonicalize），目录级放行会被 Vault 内的符号链接绕过（ADR-0007） | `src-tauri/src/assets.rs`、`mn-core/path_guard.rs` |
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
| 全文搜索查询 | 交互可接受 | 1 万笔记 / 29.1 万行合成基准：命中 1000 行 **49–75 ms**；命中 29 万行（每行都含查询词）**0.8–1.1 s**；全量计数只占 12 ms。慢的那档是 `bm25()` 给全部命中打分的固有成本（已实测 CROSS JOIN / CTE+LIMIT / 去 ORDER BY / 页缓存 / mmap 等变体都在同一量级） |
| 索引构建（1 万笔记） | 不阻塞 UI | 链接+标签 ≈ 5.9 s、含 FTS5 ≈ 12 s，随打开 Vault 在后台跑且可取消；**每次打开都重建**（跨会话复用与 mtime 增量更新属 M5「增量索引」） |
| 内存（1 万笔记） | ≤ 500 MB | M5 接入（FTS5 库文件 29.1 万行约 114 MB，是磁盘缓存不是常驻内存） |

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

见 [milestones.md](milestones.md)。当前进度：**M1 / M1.5 / M2 已交付；M3 进行中**
（M3 已交付：所见即所得编辑与三视图外壳、知识图谱卡片画布、设置页与应用菜单、图片嵌入与灯箱；
剩余：工作区布局持久化、导出 HTML/PDF、多标签页、拖拽整理文件）。

## 8. 已知限制

1. **本地图片已可渲染**（ADR-0007 逐文件授权），并支持 `![[图.png]]` 嵌入、裸文件名全库兜底解析与点击放大灯箱。仍未做的：图片的**附件规则**（粘贴/拖入自动落到 `附件/`、命名规则）与块级独占行渲染（现在是行内 inline-block）。
2. **重命名已交付（M2）**：同目录改名 + 全库链接精确改写（字符 span 定位，`[[甲]]` 不会误伤 `[[甲虫]]`）+ 索引增量更新；**目录重命名与跨目录移动**仍未做，推迟到 M3 与拖拽整理一起。
3. `[[双链]]` **已可解析、渲染、跳转与反向链接**（M2 已交付）；**标签与 Frontmatter 已可抽取、展示与跳转**（M2 已交付），但面板是**只读**的 —— 改标签要手动编辑 frontmatter 或正文（`mn_core::frontmatter::set_tags` 已经就绪，接线时走 `note_read → set_tags → note_write`，复用 ADR-0004 的冲突令牌，不开新写路径）。标签重命名/合并、按标签过滤文件树也未做。
4. **快速切换与命令面板已交付**（`Mod+K` / `Mod+P`）；**全文搜索已交付**（`Mod+Shift+F`，SQLite FTS5 + `bm25`，第三个面板模式 + 带竞态丢弃的异步查询）。仍未做：**回车不跳到命中行**（编辑器还没有"定位到某行"的入口 —— 要接的话应由 editor 侧提供 `openAt(relPath, line)`，而不是在搜索面板里自己滚列表）。
5. **frontmatter 会计入正文统计**（`text_stats` 拿的是磁盘原文，前端即时统计同样如此）：字数/行数/阅读时长里包含 `---` 分隔行与键值。要改必须**两侧同时改**（`mn_core::frontmatter::body` + TS 侧对应实现），否则"编辑器统计"与"磁盘统计"会互相打架。
6. 删除走 Vault 内 `.mimenote/trash`（可见、可入 Git 忽略），未对接系统回收站；`restore` 尚未提供 UI。
7. 外部变更检测依赖 mtime（毫秒）。同一毫秒内的外部改动理论上有漏检窗口（概率极低；M5 引入内容哈希作为二级令牌）。
8. 大文档（>5MB）预览仍在主线程渲染（已用 `useDeferredValue` 降级）；M5 迁移到 Web Worker。
9. 重命名时，若新文件名含 `#` 或 `^`，指向它的链接**不会被改写**（wikilink/Markdown 语法无法表达这种目标）：宿主跳过该条并记 warn 日志，而不是写出必然悬空的链接。
10. 索引后台构建期间（`indexStatus.phase === 'building'`）重命名，新路径可能被"构建完成时整轮替换索引"覆盖掉（要等一次重扫）；这是 `indexer::spawn_build` 的既有行为，未在本轮修。
11. E2E 覆盖"打开/编辑/保存/冲突/布局/主题/三视图/链接/重命名/删除到回收站/键盘导航/分隔条拖拽/命令面板/快速切换/标签面板/全文搜索/本地图片/知识图谱"等主干路径，但**未覆盖**：多窗口、插件（M4）、超大 Vault 下的表现。
12. **索引每次打开 Vault 都会重建**（链接、标签、FTS5 一起；1 万笔记约 6–12 s，后台可取消）。跨会话复用缓存、按 mtime 增量更新属于 M5「增量索引」；在此之前打开大 Vault 会有一次后台 CPU 高峰（UI 不阻塞，搜索在索引就绪前返回空/降级）。
13. **高频词的全文搜索会慢**（查询词若命中几十万行，`bm25()` 需要给全部命中打分 → 秒级）。这是 FTS5 排序的固有成本，已实测多个查询计划变体无显著差异；缓解手段是更具体的关键词（面板也有 150ms 防抖 + 竞态丢弃，不会堆积查询）。
14. **所见即所得只覆盖高频语法**（ADR-0009）：表格、缩进代码块、脚注、引用式链接、HTML、数学公式**不做装饰**（原样显示）；frontmatter 只做淡色、不隐藏。装饰按 `view.visibleRanges` 计算，但**光标移动也会重算**（"进入即露原文"的必要代价），极端大文档下若手感有问题，需要再做"仅选区跨越装饰时重算"的优化。
15. **知识图谱不随编辑自动刷新**（切 Vault / 点"重新读取图谱" / 索引就绪时才重拉），因为 `graph-store.load()` 会重置视口与选中；要做"存盘后刷新"需要保留视角的变体。手工拖动会覆盖自动布局（「重新自动排布」复位），折叠状态刻意不持久化（每次默认全展开）。宿主上限 3000 节点，超出按度数截断（此时**度数仍是全图度数**，可能大于画布上可见的线数）。
16. **图谱/反链的悬空链接解析有性能尾巴**：`mn_index::resolve_target` 在"按文件名找不到"时会退化为全库后缀扫描（每条约 0.2–0.5 ms），大量"还没写的计划"链接会让 `graph_data` 到几百毫秒。缓解方案已记录在 `mn-index` 注释里（缓存"不可解析"判定），未在本轮做。

## 8.1 测试策略（分层）

| 层 | 位置 | 能抓住的问题 | 成本 |
| --- | --- | --- | --- |
| Rust 单元/集成 | `crates/mn-core`、`src-tauri` | 路径防护、原子写、扫描、回收站、错误码、建笔记命名、写锁串行化 | 秒级 |
| 前端领域层单元 | `apps/desktop/tests/*.test.ts` | 树构建/过滤、虚拟窗口、EOL 往返、统计口径、快捷键解析、主题完整性 | 秒级 |
| 前端集成（jsdom + Mock 适配器） | `apps/desktop/tests/*.test.ts(x)` | store 状态机、自动保存/冲突、删除确认、**渲染结构**（含"打开笔记后编辑器是否真的被创建"） | 秒级 |
| **UI E2E（真实 Chromium）** | `apps/desktop/e2e/ui.e2e.test.ts` | **真实布局与像素尺寸**、窗口缩放、交互链路、预览渲染、主题 | ~3 秒 |
| **应用 E2E（真实二进制）** | `apps/desktop/e2e/real-app.e2e.test.ts` | 生产构建能否启动、IPC 契约、**真实磁盘读写**、冲突保护、命令行打开 Vault | ~7 秒 |

**为什么必须有 E2E**：M1 开发过程中出现过两个"单元测试全绿但用户在界面上撞到"的缺陷 ——
布局不随窗口对齐、以及打开第一篇笔记时编辑器空白（`useEffect([])` 空转导致 CodeMirror 实例从未创建）。
两者都发生在"组件挂载时序 + 真实布局"这一层，只有真实浏览器/真实二进制能抓住。

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
