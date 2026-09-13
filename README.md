# Mimenote

本地优先、可高度自定义、高性能的 Markdown 知识库桌面应用。

**你的笔记就是普通文件夹里的普通 Markdown 文件** —— 可被 Git 管理、可被任何编辑器打开、随时可以整体搬走。
应用不联网、不遥测、不上传；所有派生数据（未来的索引、图谱）都可以从文件重建。

> 当前状态：**M1 与 M1.5 已交付；M2（核心体验）进行中**（双链/反链、重命名与全库链接改写已可用）。
> 范围与后续里程碑见 [`docs/milestones.md`](docs/milestones.md)，架构与决策见 [`docs/architecture.md`](docs/architecture.md)。

---

## M1 做了什么

| 能力 | 说明 |
| --- | --- |
| 打开 Vault | 系统目录选择框，或命令行 `mimenote.exe <目录>` 直接打开 → Rust 侧迭代式扫描（不跟随符号链接、忽略 `.git`/`node_modules` 等）→ 一次调用返回概要与完整条目表 |
| 文件树 | **虚拟列表**（固定行高 + overscan，10 万条目也只挂载几十行 DOM）、键盘导航（↑↓←→/Enter/Delete）、中文与数字自然排序、子串过滤并自动保留祖先 |
| 编辑器 | CodeMirror 6 + Markdown 语法高亮、行号、搜索面板（Ctrl+F）、Markdown 语法高亮、自动换行；**输入路径零 IO、零全量重渲染** |
| 保存 | 防抖自动保存（默认 600ms）+ Ctrl+S；写入串行化；**原子替换**（同目录临时文件 → fsync → rename）；状态栏显示每次写入实测耗时 |
| 冲突保护 | `mtime` 版本令牌；文件被外部修改时**拒绝静默覆盖**，弹出横幅让用户选「覆盖 / 重新加载」 |
| 换行保真 | 识别并保留 CRLF / LF 与 UTF-8 BOM，避免"保存一次 = 全文 diff" |
| 预览 | `markdown-it`（关闭 raw HTML）+ DOMPurify 二次净化的实时预览；`useDeferredValue` 降优先级 |
| 双链与反链 | `[[笔记]]` / `[[笔记\|别名]]` / `[[笔记#小节]]` / `![[嵌入]]` 解析与点击跳转；右侧链接面板显示**反向链接与出链**；悬空链接标黄并**点击即创建**；同名多篇按「同目录 → 更短路径 → 字典序」消歧并标记 |
| 重命名 | 文件树 `F2`（或工具栏铅笔）改名：宿主**同步改写全库指向它的链接**（保留别名/锚点、跳过代码块、BOM 与换行保真）并增量更新索引；正在编辑的笔记**原地换路径**（保留光标与撤销历史），其他被改写的文件自动重新加载 |
| 标签与属性 | `mn-core` 抽取 frontmatter 的 `tags`/`tag` 字段与正文行内 `#标签`（跳过代码块、行内代码、HTML 注释、标题行；`#父/子` 层级；`#Rust` 与 `#rust` 归为一个）；右侧**标签面板**显示本篇标签、frontmatter 属性表与全库标签（可点标签展开"哪些笔记用了它"→ 点笔记直接打开） |
| 快速切换与命令面板 | `Ctrl+P` 在当前 Vault 的笔记里模糊搜索（子序列匹配 + 命中高亮，1 万篇下按键路径仍是一次 O(n) 扫描）；`Ctrl+K` 列出全部命令并执行（依赖 Vault 的命令置灰并说明原因）；两者共用同一个面板，`↑↓`/`Enter`/`Esc` 与点选都支持 |
| 全文搜索 | `Ctrl+Shift+F` 搜索正文（SQLite FTS5 + `bm25` 排序，中文与多词都支持）；结果按笔记分组显示行号与片段并高亮命中词，回车打开命中笔记。索引是**缓存**：`<Vault>/.mimenote/cache/search.db`，删掉即自动重建 |
| 本地图片 | 预览渲染 `![](附件/图.png)`（相对路径、`../`、根绝对三种写法）。图片经 **asset 协议逐文件授权**：路径先由 `path_guard` 逐级检查符号链接与越界，只放行通过校验的那一个文件（见 ADR-0007）；加载失败会**回退成占位元素**而不是裂图 |
| 删除保护 | 必须二次确认；文件移入 Vault 内 `.mimenote/trash/` 并写台账（可恢复），不做 `unlink` |
| 可定制 | 命令注册表 + 快捷键、JSON 主题（CSS 变量）、Vault 内 `.mimenote/snippets/*.css` 用户样式片段（可整体卸载） |
| 安全 | 路径越界/符号链接逃逸/Windows 保留名拦截、严格 CSP、能力声明最小化（仅 `core:default` + `dialog:allow-open`） |

## 还没有做（明确推迟）

图谱视图、第三方插件系统（M4）、Git 集成、同步。
**M2「核心体验」的范围已全部交付**：双链与反链、重命名（含全库链接改写）、标签与 Frontmatter、
全文搜索、快速切换与命令面板、本地图片渲染。
**目录重命名与跨目录移动**、**标签重命名/合并**、**命中行跳转**推迟到 M3/M4。
详见 [`docs/architecture.md` §8](docs/architecture.md) 与 [`docs/milestones.md`](docs/milestones.md)。

---

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22（实测 26.2.0） | 前端构建与测试 |
| pnpm | ≥ 10（实测 11.7.0） | 包管理（`corepack enable pnpm`） |
| Rust | stable（实测 1.96.0） | Rust 宿主 |
| MSVC Build Tools / VS 2022 | Windows 需要 | 链接 Tauri 宿主 |
| WebView2 Runtime | Windows 11 自带 | 渲染前端 |

### 安装与运行

```bash
pnpm install                 # 安装前端依赖（Cargo 依赖在首次构建时自动拉取）

pnpm tauri:dev               # 启动桌面应用（开发模式，热更新）
pnpm dev                     # 仅启动前端（浏览器里跑 Mock Vault，用于调界面）

# 直接用某个文件夹启动（命令行参数 / 快捷方式 / "打开方式"）
target\release\mimenote.exe D:\我的笔记
```

首次 `pnpm tauri:dev` 需要编译约 400 个 crate（本机约 4~5 分钟），之后为增量编译。

### 构建

```bash
pnpm tauri:build                      # 出安装包（Windows: NSIS + MSI，需要下载打包工具）
pnpm --filter @mimenote/desktop exec tauri build --no-bundle   # 只出可执行文件 → target/release/mimenote.exe
```

> ⚠️ **必须用 Tauri CLI 构建（`pnpm tauri:build`），不要直接 `cargo build --release`。**
> `tauri-build` 通过 `TAURI_ENV_DEBUG` 环境变量判断"开发 / 生产"，这个变量只有 Tauri CLI 会设置；
> 直接跑 cargo 时它会退化为 `cfg!(debug_assertions)`，于是**生产二进制里被写入了 devUrl**，
> 启动后窗口会去连 `http://127.0.0.1:1420` 并显示"网络错误"。
> 同理，`target/debug/mimenote.exe` 也总是要连 dev server —— 调试请用 `pnpm tauri:dev`。

### 测试与质量门禁

```bash
pnpm check        # 类型检查 + 前端测试 + Rust 测试（一条命令跑完）
pnpm typecheck    # tsc --noEmit（TS 严格模式，含 noUncheckedIndexedAccess）
pnpm test         # vitest（前端单元 + 集成测试）
pnpm test:rust    # cargo test --workspace
pnpm lint:rust    # cargo clippy --workspace --all-targets -- -D warnings
pnpm fmt:rust     # cargo fmt --all
pnpm test:e2e     # 两层端到端测试（见下）
```

### 端到端测试（E2E）

分两层，各自解决不同的问题：

| 层 | 命令 | 被测对象 | 平台 |
| --- | --- | --- | --- |
| **真实应用** | `pnpm test:e2e:app` | `tauri build` 产出的 **release 二进制**：真实 WebView2、真实 IPC、**真实磁盘写入** | 仅 Windows（需要 WebView2 的远程调试） |
| **UI 层** | `pnpm test:e2e:ui` | **系统 Edge** + `dist/` 构建产物 + 内存 Mock Vault：真实 Chromium 布局与交互 | 跨平台，秒级，适合 CI |

运行前提：

```bash
pnpm --filter @mimenote/desktop build                          # UI 层需要 dist/
pnpm --filter @mimenote/desktop exec tauri build --no-bundle   # 应用层需要 release 二进制
```

覆盖的场景：

- **应用层**（`e2e/real-app.e2e.test.ts`）：命令行参数自动打开 Vault、文件树渲染、**未选中任何笔记时布局即铺满窗口**、打开笔记 → 编辑器载入 → 输入 → **防抖后内容真的落到磁盘**、文件被外部修改 → 冲突横幅 → **磁盘未被覆盖** → 重新加载恢复、删除到回收站（二次确认 + 真实 `.mimenote/trash`）、**后台索引完成后反向链接可见 → 点击跳转 → 悬空链接一键创建真实文件**、**重命名：`F2` 改名后磁盘上的文件名与全库链接都被改写（跨目录相对路径、别名与锚点保留、`[[甲]]` 不误伤 `[[甲虫]]`、代码块与行内代码不动、CRLF 保真），且索引立刻同步**、**标签面板（真实 IPC）：frontmatter 与行内标签、属性表、点标签列出笔记、切换笔记后跟随刷新**、**全文搜索（真实 FTS5）命中 → 回车打开**、**本地图片真的被解码（`naturalWidth > 0`），而 Vault 越界引用与符号链接引用都留在占位态**
- **UI 层**（`e2e/ui.e2e.test.ts`）：门闸 → 打开 Vault → 树、**缩小窗口后布局跟随**、打开笔记前后布局不变、预览渲染表格/代码块、**wikilink 点击跳转与悬空标记**、**链接面板反向链接跳转**、过滤保留祖先、主题即时切换、三种视图模式、文件树键盘导航、分隔条拖拽、**重命名对话框（`F2` → 改名 → 预览里的链接跟着改 → 再改回来）**、**标签面板（`Ctrl+Shift+T`）**、**命令面板（编辑器聚焦时 `Ctrl+K` 也能打开、过滤后回车执行）**、**快速切换（`Ctrl+P` 只列笔记、回车打开、`Esc` 关闭）**、**全文搜索（`Ctrl+Shift+F` → 输入 → 回车打开）**

#### 为什么是"Playwright + WebView2 CDP"而不是 tauri-driver

Tauri 官方文档的 E2E 路径是 `tauri-driver` + WebdriverIO：`tauri-driver` 是一个 **WebDriver 服务端**，
而 Playwright 不走 WebDriver 协议，两者无法对接；走那条路还要一个与 WebView2 版本**精确匹配**的
`msedgedriver.exe`。WebView2 支持 `--remote-debugging-port`（通过环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 传入），Playwright 的 `chromium.connectOverCDP()`
可以直接接管它 —— 于是既保留了 Playwright，又能跑真实二进制。

实现见 `e2e/support/harness.ts`，其中记了两个坑：

1. 端口被别的程序（浏览器、其它调试实例）占用时，WebView2 会退到 IPv6 `[::1]`，
   而 IPv4 上仍是别人在监听 —— 探到的 404 是别人的。**必须先申请一个空闲端口**。
2. 不通过 `Emulation.setDeviceMetricsOverride` 测窗口缩放：WebView2 的 CDP 不暴露该域，
   缩放场景放在 UI 层（真实 Chromium）验证。

### 手工验收

自动化已经覆盖了"打开 Vault → 编辑 → 保存 → 冲突保护"与布局链路的**行为**；
剩下需要人眼判断的是观感（配色、字号、间距、动画是否舒服）。用仓库自带的示例 Vault：
`examples/demo-vault/`。

10k 笔记扫描基准（会真实创建 1 万个文件，默认忽略）：

```bash
cargo test -p mn-core --release -- --ignored --nocapture bench_scan_10k_notes
```

---

## 目录结构

```
mimenote/
├─ crates/mn-core/                  文件层（纯 Rust 库，不依赖 tauri，可独立测试）
│  ├─ src/path_guard.rs             路径校验与越界防护（VaultRoot）
│  ├─ src/atomic.rs                 原子写 / 限长读取 / mtime 工具
│  ├─ src/scanner.rs                迭代式 Vault 扫描（忽略规则、深度与条目上限）
│  ├─ src/trash.rs                  回收站（移动 + jsonl 台账）
│  ├─ src/text_stats.rs             CJK 感知统计
│  ├─ src/links.rs                  链接抽取（含字符 span，重命名精确改写用）
│  ├─ src/frontmatter.rs            极简 YAML 子集解析 + 最小 diff 改写
│  ├─ src/tags.rs                   标签抽取与归一化（`normalize_tag` 是唯一判同键）
│  └─ tests/vault_ops.rs            端到端文件层测试
├─ crates/mn-index/                 索引层（纯 Rust 库，索引是可重建的缓存）
│  ├─ src/lib.rs                    链接索引 + 标签索引（挂在同一个 upsert/remove 上）
│  ├─ src/rename.rs                 重命名：候选集计划 → 精确改写 → 索引同步
│  └─ src/search.rs                 SQLite FTS5 全文索引（`.mimenote/cache/search.db`）
├─ apps/desktop/
│  ├─ src-tauri/                    Tauri 宿主（状态 + IPC + 错误码，不含业务逻辑）
│  │  ├─ src/lib.rs                 应用装配与命令注册
│  │  ├─ src/state.rs               会话状态（Vault 缓存、写锁、索引与搜索句柄）
│  │  ├─ src/commands.rs            IPC 命令与 DTO
│  │  ├─ src/assets.rs              本地图片的逐文件读取授权（ADR-0007）
│  │  ├─ src/error.rs               mn-core 错误 → 稳定错误码
│  │  ├─ capabilities/default.json  最小能力声明
│  │  └─ tauri.conf.json            CSP / 窗口 / 打包配置
│  ├─ src/
│  │  ├─ app/                       bootstrap、命令注册表、快捷键、高层动作
│  │  ├─ domain/                    纯函数：树、虚拟列表、EOL、Markdown、统计、格式化
│  │  ├─ ipc/                       IPC 契约类型 + 可替换适配器（tauri / mock）
│  │  ├─ state/                     zustand store（vault / note / ui / links / tags / toast / confirm）
│  │  ├─ features/                  vault（门闸、工具栏、虚拟化文件树、重命名对话框）
│  │  │                             editor（CM6 装配与主题）、preview、status
│  │  │                             links（反向链接面板）、tags（标签与属性面板）
│  │  │                             palette（命令面板 / 快速切换）
│  │  ├─ theme/                     主题令牌、JSON 主题、CSS 片段装载
│  │  ├─ components/                Icon、Splitter、Toasts、确认框、错误边界
│  │  └─ styles/app.css             布局与组件样式（颜色全部走 CSS 变量）
│  ├─ tests/                        vitest：领域层单测 + store 集成测试
│  └─ scripts/make-icon.mjs         纯 Node 生成应用图标源图（无图像依赖）
├─ examples/demo-vault/             用于手工验收的示例 Vault（含 CSS 片段示例）
└─ docs/                            架构、里程碑、ADR、依赖清单
```

## 快捷键

| 快捷键 | 命令 |
| --- | --- |
| `Ctrl+K` | 命令面板（当前所有命令，可模糊搜索后执行） |
| `Ctrl+P` | 快速切换笔记（模糊搜索当前 Vault 的笔记） |
| `Ctrl+Shift+F` | 全文搜索（搜索笔记正文，支持中文与多词；`↑↓` 选择、`Enter` 打开） |
| `Ctrl+O` | 打开 Vault |
| `Ctrl+N` | 新建笔记（在选中目录 / 选中文件的父目录） |
| `Ctrl+S` | 保存 |
| `Ctrl+Alt+L` | 从磁盘重新加载（丢弃内存改动，会二次确认） |
| `Delete` | 删除到回收站（树上有焦点时，会二次确认） |
| `F2` | 重命名选中笔记（会同时改写全库指向它的链接） |
| `Ctrl+E` | 循环切换 编辑 / 分栏 / 预览 |
| `Ctrl+B` | 显示 / 隐藏侧栏 |
| `Ctrl+Shift+L` | 显示 / 隐藏链接面板（反向链接 / 出链） |
| `Ctrl+Shift+T` | 显示 / 隐藏标签面板（标签与 Frontmatter 属性） |
| `Ctrl+Shift+E` | 聚焦文件过滤框（`Ctrl+Shift+F` 让给了全文搜索） |
| `Ctrl+Alt+E` / `Ctrl+Alt+W` | 展开 / 折叠全部目录 |
| `Ctrl+Alt+R` | 重新扫描 Vault |
| `Ctrl+Alt+T` | 切换主题 |
| `Ctrl+Alt+A` | 关于（版本 + 当前文档磁盘统计） |
| `Ctrl+F` | 编辑器内搜索（CodeMirror 面板） |

macOS 上 `Ctrl` 自动换成 `Cmd`（`Mod`）。命令表在 `src/app/builtin-commands.ts`，是未来命令面板与插件 API 的数据源。

---

## 验证

### 自动化测试（本机实测）

| 命令 | 结果 |
| --- | --- |
| `cargo test -p mn-core` | 106 个单元测试 + 12 个集成测试通过（另有 1 个性能基准默认忽略） |
| `cargo test -p mn-index` | 65 个单元测试通过（链接解析/歧义消解/增量更新/构建取消、重命名与链接精确改写、标签索引、FTS5 搜索与恶意查询）（另有 2 个基准默认忽略） |
| `cargo test -p mimenote` | 47 个宿主单元测试通过（IPC 错误映射、路径解析、建笔记、重命名、标签、搜索、图片授权、片段、写锁、启动参数） |
| `pnpm test` | 19 个测试文件 / 236 个测试通过 |
| `pnpm test:e2e:ui` | 18 个用例通过（系统 Edge，真实 Chromium，约 5 秒） |
| `pnpm test:e2e:app` | 13 个用例通过（真实 release 二进制 + 真实磁盘，约 17 秒） |
| `pnpm check` | 以上三类一次跑完，全绿 |
| `pnpm typecheck` | 无错误（TypeScript 严格模式 + `noUncheckedIndexedAccess`） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 无告警 |
| `cargo fmt --all --check` | 无差异 |
| `cargo run -p mn-core --release --example scan_bench` | 1 万文件 + 100 目录：**143 ms**（预算 800 ms） |

### 二进制启动验证（实测）

```bash
pnpm --filter @mimenote/desktop exec tauri build --no-bundle   # → target/release/mimenote.exe（4.5MB）
```

启动后日志（`%LOCALAPPDATA%\app.mimenote.desktop\logs\mimenote.log`）：

```text
INFO mimenote_lib] Mimenote 0.1.0 启动（mn-core 0.1.0，离线模式：无遥测、无出站请求）
INFO mimenote_lib] 日志文件：C:\Users\<你>\AppData\Local\app.mimenote.desktop\logs\mimenote.log
INFO mimenote_lib::commands] IPC 握手成功：app 0.1.0 / mn-core 0.1.0 / tauri 2.11.5
```

出现 "IPC 握手成功" 这一行意味着三件事同时成立：**WebView 渲染成功**、**前端 JS 执行成功**、
**IPC 通道可用**（CSP 与能力声明都没有拦住）。这是排查"白屏"类问题最快的信号；
门闸页底部也会显示同一份运行环境信息。

前端测试覆盖的重点：

- `tests/note-store.test.ts`：自动保存、切换文档前落盘、保存期间继续输入、**外部修改冲突**（不覆盖 / 重新加载 / 强制覆盖）、CRLF 保真
- `tests/vault-flow.test.ts`：打开 Vault、树结构、新建（重名避让）、删除（取消 / 确认 / 目录连带后代）、重扫
- `tests/rename.test.tsx`：改名 + 全库链接改写、条目表原地更新、**改名前的落盘顺序**、`updateLinks=false`、重名/非法名拒绝、目录拒绝、对话框交互与 Esc 取消、自链接重读
- `tests/tags.test.tsx`：frontmatter 与行内标签抽取（代码块/标题行/`#123`/`a#b` 不抽）、属性保序与类型标注、全库标签计数、面板渲染与"点标签 → 点笔记 → 打开"
- `tests/palette.test.tsx`：`Ctrl+K`/`Ctrl+P` 开关、子序列过滤与高亮、键盘选择与执行、置灰项、结果上限、焦点归还、Esc 不冒泡
- `tests/search.test.tsx`：Mock 搜索（大小写不敏感、命中行号、片段裁剪、排序）；面板的防抖只发一次请求、竞态丢弃、结果高亮、回车打开、错误态
- `tests/assets.test.ts`：图片路径解析的**拒绝面**（越界 `..`、外部 scheme、Windows 非法字符与保留设备名、空地址）
- `tests/markdown.test.ts`：**XSS 防护**（script、事件属性、`javascript:`、`data:text/html`、iframe、style）
- `tests/tree.test.ts` / `tests/virtual-list.test.ts`：树构建与排序、过滤保留祖先、虚拟窗口计算与滚动定位
- `tests/eol.test.ts` / `tests/stats.test.ts` / `tests/commands.test.ts` / `tests/theme.test.ts`：换行与 BOM 往返、统计口径、快捷键解析、主题令牌完整性

### 手工验收清单

用仓库自带的示例 Vault：`examples/demo-vault/`。

1. `pnpm tauri:dev` → 应用启动，显示 Vault 门闸页
2. 「打开文件夹作为 Vault」→ 选择 `examples/demo-vault` → 文件树出现，状态栏显示条目数与扫描耗时
3. 点击 `项目/设计文档.md` → 编辑器载入内容，右侧预览同步渲染（表格、代码块、引用）
4. 输入文字 → 状态栏短暂显示「保存中…」→「已保存 hh:mm:ss」并给出写入耗时（应 < 50ms）
5. 切换主题（状态栏右下角下拉）→ 编辑器与预览颜色立即跟随，无需重启
6. 调色板按钮 → 停用/启用 `example.css` 片段，观察预览标题/引用的变化
7. **冲突验证**：用记事本打开 `README.md` 并改几个字保存 → 回到应用里输入一个字 → 顶部出现冲突横幅 → 选「用我的内容覆盖」或「丢弃我的修改并重新加载」
8. **原子写验证**：保存时观察 Vault 目录，正常情况下不应残留 `.mimenote-*.tmp`
9. **删除验证**：选中 `附件/示例说明.txt` 按 `Delete` → 二次确认 → 文件出现在 `.mimenote/trash/`，台账 `.mimenote/index.jsonl` 多一行
10. **重命名验证**：选中 `项目/设计文档.md` 按 `F2` → 输入新名字回车 → 文件树里的行改名；打开 `项目/路线图.md` 看预览里的 `[[设计文档]]` 是否已跟着改成新名字（用 `git status`/编辑器看磁盘内容也行）
11. **标签与属性验证**：按 `Ctrl+Shift+T` 打开标签面板 → 当前笔记的 `#标签` 与 frontmatter 属性列出来；点某个标签 → 展开"哪些笔记用了它" → 点笔记直接打开
12. **命令面板 / 快速切换验证**：`Ctrl+P` 输入"设计"回车 → 打开对应笔记；在编辑器里按 `Ctrl+K`（应弹出面板，而不是删掉一行后半截）→ 输入"主题"回车 → 主题切换
13. **全文搜索验证**：`Ctrl+Shift+F` 输入"原子写"→ 结果里应出现 `项目/设计文档.md`（带行号与片段）→ 回车打开它；中文与多词（如"原子 写"）都应命中；删掉 `.mimenote/cache/search.db` 后重开 Vault 应自动重建
14. **本地图片验证**：打开 `项目/设计文档.md` → 预览顶部应显示出图片（`附件/示例图片.png`）。若显示占位方块，说明该图没拿到授权（文件不存在、路径越界、或扩展名不在白名单里）
15. **大 Vault 验证**：把示例 Vault 复制成多份或生成 1 万个小文件，打开后滚动文件树应保持顺滑（DOM 行数恒定），`Ctrl+P` 输入时也不应卡顿

### 已知限制与风险

见 [`docs/architecture.md` §8/§9](docs/architecture.md)。当前最主要的几条：

1. 预览不渲染本地图片：`asset:` 协议需要按 Vault 动态注入作用域，仍未做（图片显示为占位元素）
2. 重命名只支持**单篇笔记的同目录改名**：目录重命名与跨目录移动推迟到 M3（与拖拽整理一起做）。
   新文件名里含 `#`/`^` 时，指向它的链接**不会被改写**（wikilink 语法无法表达这种目标），宿主会记日志并跳过
3. 全文搜索（SQLite FTS5）尚未实现；标签面板只做**展示与跳转**，改标签目前要手动编辑 frontmatter 或正文
4. 删除走 Vault 内回收站，未对接系统回收站；恢复界面在 M2
5. 冲突检测基于 mtime（同毫秒内两次独立修改理论上有漏检窗口）
6. 大文档（>5MB）预览仍在主线程渲染
7. E2E 未覆盖：多窗口、插件（M4）、以及"标签/搜索在超大 Vault 下的表现"（功能已覆盖，规模未覆盖）

---

## 性能预算与实测

| 指标 | 目标 | 状态（M2 末） |
| --- | --- | --- |
| 冷启动到可交互 | ≤ 1500 ms | 未建立自动基准（M5） |
| Vault 扫描（1 万文件 + 100 目录） | ≤ 800 ms | **实测 120–147 ms**（`cargo run -p mn-core --release --example scan_bench`，M2 末复测） |
| 打开 1MB Markdown | ≤ 100 ms | 状态栏显示每次读取耗时，可直接观察 |
| 输入延迟 | ≤ 16 ms | 结构性保证：输入路径零 IO、编辑器不因文本变化重渲染、预览 `useDeferredValue`；命令面板按键路径最坏 3–6 ms（1 万笔记，见 `features/palette/match.ts`） |
| 主线程单任务 | ≤ 8 ms | Rust 侧所有文件 IO 走 `spawn_blocking` |
| 保存（本地） | ≤ 50 ms | 状态栏显示每次写入耗时（含 fsync） |
| 文件树滚动 | 60 fps | 固定行高虚拟列表，DOM 行数 = 可视行 + overscan，与总数无关 |
| 全文搜索查询 | 交互可接受 | 见下表（合成基准：1 万笔记 / 29.1 万行） |

全文搜索实测（`cargo test -p mn-index --release -- --ignored --nocapture`，合成 Vault：1 万笔记、每篇约 29 行、共 **29.1 万行**，FTS 库 113.8–114.7 MB）：

| 项 | 实测 |
| --- | --- |
| 索引构建（与链接/标签同一次遍历，后台、可取消） | 链接+标签 **5.5 s**；含 FTS5 **10.3 s**（其中 FTS 自身约 2.8 s，**快于链接那一轮**） |
| 查询：真实场景（命中约 100 行） | **3 ms** |
| 查询：命中 1000 行 | **66–79 ms** |
| 查询：命中 29 万行（查询词在每一行里都出现） | **0.9–1.2 s** |
| 单独的全量计数 `COUNT(*)` | 12–17 ms（**不是**瓶颈） |
| 索引体积 | ≈ 被索引文本的 **2.7 倍**（中文逐字 token 的固有比例） |

慢的那一档是**排序的固有成本**：`bm25()` 要给全部命中打分，`ORDER BY score LIMIT 50` 也必须先算完
（已实测 `CROSS JOIN` / `CTE+LIMIT` / 去掉 `ORDER BY` / 加大页缓存 / mmap 变体，都在同一量级，
说明没有便宜的优化空间；拆解显示打分 + JOIN 回行表 + 三键排序占约 90%）。面板对请求做了 150ms 防抖 +
竞态丢弃，不会因为连续输入堆积查询；索引未就绪时面板显示"正在构建"提示而不是报错。

索引构建在**每次打开 Vault** 时会随链接/标签索引一起重跑（可取消、不阻塞 UI）；跨会话复用缓存、
按文件 mtime 增量更新属于 M5「增量索引」的范围，`<Vault>/.mimenote/cache/search.db` 删掉（或损坏）时自动重建。

扫描过程中发现并修掉的一个真实性能坑：用 `fs::symlink_metadata(path)` 逐文件取元数据，
1 万文件要 2227ms；改用 `DirEntry` 的缓存元数据后降到 145ms（**14 倍**）。
细节与约束见 [`docs/architecture.md` §6](docs/architecture.md)。

---

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 窗口一片空白，提示"无法访问 127.0.0.1" | 用 `cargo build --release` 而不是 Tauri CLI 构建的：生产二进制里被写入 devUrl。改用 `pnpm tauri:build`（见"构建"一节） |
| 点开笔记后编辑区是空白 | 已修复（CodeMirror 实例漏创建）。若再出现，跑 `pnpm test:e2e:ui` 一眼就能定位 |
| E2E 报"找不到应用二进制" | 先跑 `pnpm --filter @mimenote/desktop exec tauri build --no-bundle`（release 才内嵌前端资源） |
| E2E 应用层在非 Windows 上被跳过 | WebView2 的远程调试只在 Windows 上存在；这是显式跳过而不是"通过" |
| `pnpm tauri:dev` 起不来，`pnpm dev` 正常 | 检查 1420 端口是否被占用（`vite.config.ts` 与 `tauri.conf.json` 都约定 `127.0.0.1:1420`） |
| 保存报 `IO` 错误 | 目标目录可能是 OneDrive 同步目录或只读；日志文件里有系统错误码（`detail` 字段） |
| 提示"文件已被外部修改" | 这是**保护**：别处改过同一文件。选择覆盖或重新加载（见 ADR-0004） |
| 界面上看不到本地图片 | M1 已知限制，图片渲染为占位元素，M2 引入 `asset:` 协议 |
| 需要看日志 | `%LOCALAPPDATA%\app.mimenote.desktop\logs\mimenote.log`（超过 2MB 会自动重建） |

## 安全与隐私

- **默认离线**：运行时无任何网络请求；CSP 为 `default-src 'self'`、`script-src 'self'`，`connect-src` 仅允许 Tauri IPC。
- **能力最小化**：`capabilities/default.json` 只放开 `core:default` 与 `dialog:allow-open`；文件访问全部经过自定义 IPC 命令与路径防护。
- **路径防护**：拒绝 `..`、绝对路径、盘符/UNC、Windows 保留名与 ADS；逐级检查符号链接，目标必须仍在 Vault 内。
- **不破坏用户数据**：写入原子替换、删除进回收站、冲突必须人工决策。
- **XSS 防护**：Markdown 关闭 raw HTML + DOMPurify 二次净化（有专门的攻击载荷测试）。
- **用户样式片段**只从用户自己的 Vault 目录读取，不加载远程 CSS。

## 依赖

见 [`docs/dependencies.md`](docs/dependencies.md)：逐个说明理由、许可证，以及**刻意没有引入**的依赖及其替代实现方式。

## 贡献

- 提交前跑 `pnpm check`（类型 + 前端测试 + Rust 测试）与 `pnpm lint:rust`。
- 新增 IPC 命令必须：`async fn` + `spawn_blocking` + 返回 `IpcError` + 在 `src/ipc/types.ts` 补类型 + 在 `docs/architecture.md` §3.1 登记。
- 新增依赖必须在 `docs/dependencies.md` 登记理由与许可证。
- 架构相关改动请追加 ADR（`docs/adr/`），不要悄悄改变分层约定。

## 假设

本实现基于以下已确认的假设（来自需求澄清）：

1. **Windows 优先**，代码保持跨平台（路径与文件 API 全部使用跨平台语义，未写死 `\`）。
2. 技术栈：Tauri 2 + Rust + React + TypeScript + Vite + CodeMirror 6 + Zustand；SQLite FTS5 在 M2 引入。
3. **第三方插件推迟到 M4**，M1 只提供内置扩展点（命令、快捷键、主题、CSS 片段、编辑器扩展）。
4. **不做同步/协作**，只保证纯 Markdown 且可被 Git 管理。
5. 目标规模 **1 万笔记**，使用上文默认性能预算。

## 许可证

MIT。
