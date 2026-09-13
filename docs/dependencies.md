# 依赖清单与理由

原则：**每一个依赖都要有明确的、当前就需要的理由**；能用少量代码自己写对的，不引三方。

## 运行时依赖（`apps/desktop`）

| 依赖 | 版本 | 许可证 | 用途 | 为什么必须 |
| --- | --- | --- | --- | --- |
| `react` / `react-dom` | 19.x | MIT | UI 渲染 | 生态与并发渲染特性（`useDeferredValue` 等）直接服务于"输入不卡"目标 |
| `zustand` | 5.x | MIT | 状态管理 | 约 1KB，支持**按切片订阅**（`selector`），是"精准更新、不做全量重渲染"的基础 |
| `@tauri-apps/api` | 2.x | MIT/Apache-2.0 | IPC 客户端 | Tauri 官方 API；只被 `ipc/tauri-adapter.ts` 一个文件引用 |
| `@tauri-apps/plugin-dialog` | 2.x | MIT/Apache-2.0 | 目录选择框 | 系统原生目录选择；能力声明里只放开 `dialog:allow-open` |
| `@codemirror/*`（state/view/commands/language/search/lang-markdown） | 6.x | MIT | 编辑器内核 | 按架构要求使用；模块化、可增量扩展、输入路径无全量重渲染 |
| `@lezer/highlight` | 1.x | MIT | 语法高亮标签 | CodeMirror 语言栈的一部分（`tags.*`），非额外引入 |
| `markdown-it` | 15.x | MIT | Markdown → HTML | 配置项少、`html: false` 直接关闭 raw HTML，渲染器规则可定制（外链/图片占位） |
| `dompurify` | 3.x | MPL-2.0 OR Apache-2.0 | HTML 二次净化 | XSS 的第二道防线；笔记内容属于不可信输入（别人分享的 Vault） |

**刻意没有引入**：

- 虚拟列表库（`react-window` / `@tanstack/react-virtual`）：本项目的行高固定、数据结构简单，自己实现约 40 行并有单测（`domain/virtual-list.ts`），比引入依赖更可控。
- 图标库：`components/Icon.tsx` 用内联 SVG 路径，无需额外几百 KB。
- 样式方案（Tailwind / CSS-in-JS）：主题必须由用户可编辑的 **JSON + CSS 变量**驱动，手写 CSS + 变量最贴合这个需求，也避免了构建期插件。
- 状态持久化中间件：20 行 `state/persist.ts` 足够。
- 表单/路由/请求库：M1 没有这些场景。

## 开发依赖

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| `vite` / `@vitejs/plugin-react` | MIT | 构建与 HMR |
| `typescript` | Apache-2.0 | 类型门禁（`pnpm typecheck`） |
| `vitest` | MIT | 单元/集成测试 |
| `jsdom` | MIT | 让 Markdown 净化测试（DOMPurify）有 DOM 环境 |
| `@testing-library/react` | MIT | 组件测试（仅在需要渲染时使用） |
| `playwright-core` | Apache-2.0 | E2E：驱动系统 Edge（UI 层）与真实应用的 WebView2（CDP 连接）。**不含浏览器二进制**，因此不下载 Chromium |
| `@tauri-apps/cli` | MIT/Apache-2.0 | `tauri dev` / `tauri build` / `tauri icon` |

## Rust 依赖

| 依赖 | 许可证 | 用途 | 为什么不用其他方案 |
| --- | --- | --- | --- |
| `tauri` / `tauri-build` | MIT/Apache-2.0 | 桌面宿主 | 见 ADR-0001 |
| `tauri-plugin-dialog` | MIT/Apache-2.0 | 目录选择 | 官方插件；能力最小化声明 |
| `serde` / `serde_json` | MIT/Apache-2.0 | IPC 序列化、回收站台账 | Tauri 生态事实标准 |
| `thiserror` | MIT/Apache-2.0 | 错误类型派生 | 零运行时开销的样板消除 |
| `tempfile` | MIT/Apache-2.0 | 原子写的临时文件 | 它保证 `persist` 在 Windows 上是 `MoveFileEx(REPLACE_EXISTING)` 语义，即真正的原子覆盖；自己写这段更容易出错 |
| `log` / `env_logger` | MIT/Apache-2.0 | 结构化日志 | Rust 侧不被前端能力系统约束，输出到 stderr 便于开发排查 |
| `rusqlite` 0.37（`bundled`） | MIT（`libsqlite3-sys` 0.35 同为 MIT；SQLite 本体为 public domain） | 全文搜索：FTS5 倒排索引 + `MATCH` + `bm25()` 排序 | 见下方说明 |
| `libsqlite3-sys` 0.35（rusqlite 传递依赖） | MIT | rusqlite 的 FFI 与 `bundled` 构建脚本（编进 SQLite，FTS5 已启用） | 由 `bundled` 引入，不单独使用 |
| `hashlink` 0.10 / `fallible-iterator` 0.3 / `fallible-streaming-iterator` 0.1 | MIT OR Apache-2.0 / MIT-Apache-2.0 | rusqlite 的语句缓存与行迭代 | 由 rusqlite 引入的传递依赖，无直接使用 |

### 为什么引入 SQLite/FTS5，而不是自己在内存里做搜索

全文搜索要同时解决四件事：**分词**、**倒排索引**、**相关性排序**、**增量更新**。自己在内存里写一遍，
等于把"半个数据库"塞进应用（而且大概率在 1 万笔记规模上先撞上内存与排序质量的问题）。
SQLite 的 FTS5 是这几件事的成熟实现，且它带来的缓存是**纯派生数据**：`<Vault>/.mimenote/cache/search.db`
删掉即可从文件重建（ADR-0002）。

`bundled` 的含义与代价：

- **从源码编译 SQLite 并静态链接进二进制**，不依赖用户机器上的 `sqlite3.dll`（Windows 上系统不带 SQLite，
  依赖动态库等于给安装包加一个"可能缺 Dll"的坑），也保证 **FTS5 一定可用**（系统库是否编译了 FTS5 不可控）。
- 代价：首次构建变慢、二进制体积增加（约 1~2 MB）。属于一次性成本。
- 因此本次引入的传递依赖只有 `libsqlite3-sys` 与其构建期依赖，未引入 `serde_yaml` 之类的额外东西。

**刻意没有引入**：

- `tokio` 直接依赖：Tauri 已内置 `tauri::async_runtime`（`spawn_blocking` 够用）。
- `notify`（文件监听）：M2 与 SQLite 索引一起引入，避免现在引入"没有消费者的事件流"。
- `walkdir` / `ignore`：扫描逻辑需要精确的越界/符号链接/忽略规则控制，自己实现（`scanner.rs`，约 120 行）比适配通用库更直接，且已有测试覆盖。
- `trash` crate：M1 使用 Vault 内 `.mimenote/trash` 台账（跨平台行为一致、可被 Git 忽略），M2 再评估是否对接系统回收站。

## 供应链与隐私

- 运行时不发起任何网络请求（无遥测、无更新检查、无 CDN 资源）。
- 前端 CSP 为 `default-src 'self'`，`script-src 'self'`（见 `tauri.conf.json`），`connect-src` 仅允许 Tauri IPC。
- 新增依赖前需要在本文件登记：理由、体积、许可证、安全影响。
