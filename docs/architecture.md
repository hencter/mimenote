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
2. `mn-index` 同样不依赖 `tauri`，只依赖 `mn-core`：**索引是缓存，可从文件重建**；链接索引、标签索引与 FTS5 全文搜索都落在这里，IPC 契约不变。三者共用同一遍扫描、同一份文本（`LinkIndex::upsert` 里顺手算链接与标签）**与同一份跨会话判定键**（缓存库 `<Vault>/.mimenote/cache/search.db` 的 `notes_meta(path, mtime_ms, size)`，ADR-0008/0014）：对账之后"没变的那部分"连文件都不读。
3. `src-tauri` 只做三件事：持有会话状态、把 mn-core/mn-index 能力暴露成 IPC 命令、把错误映射成稳定错误码。**不放业务逻辑**。
4. `domain/` 是纯函数 + 纯数据结构，禁止 import React/Zustand/Tauri。
5. 组件不直接调用 IPC，必须经 store；store 不直接 `invoke`，必须经 `ipc/client`。
6. 每个副作用（监听器、定时器、注入的 `<style>`、CM 扩展、索引后台任务）都必须可逆：组件卸载/切换 Vault 即清理。

### 2.1 编辑器的扩展面（`features/editor/`）

所见即所得不是一个"富文本编辑器"，而是**在纯 Markdown 之上叠了几层可独立卸载的扩展**。
每层都只做一件事、都有自己的注释与测试，加起来才是"写起来像富文本、存下来还是 Markdown"：

| 扩展 | 负责 | 相关 ADR / 说明 |
| --- | --- | --- |
| `cm/live-preview/` | 标记的隐藏与渲染（标题/引用/列表/任务框/代码块/分隔线/图片），按视口计算装饰 | ADR-0009 |
| `cm/list-input.ts` | Enter 续行与空项退出、Backspace 去标记、Tab/Shift+Tab 升降级（纯函数 + 命令） | 与 `markdownKeymap` 的分工写在文件头 |
| `cm/wiki-complete/` | `[[` / `![[` 的候选弹层（排序口径与宿主消歧规则一致） | 见 `feat(editor)` 的提交说明 |
| `cm/image-input.ts` | 粘贴 / 拖入图片 → 写进附件目录 → 插入相对链接 | ADR-0013 |
| `cm/flash-line.ts` | "命中行"的一次性高亮（搜索跳转、大纲跳转共用） | §8 第 4 条 |
| `cm/table-format.ts` | 光标所在 Markdown 表格的对齐格式化（纯函数在 `domain/table-format.ts`） | 走**命令表**（`note.formatTable`，`Mod+Alt+F`）而不是编辑器私有 keymap，因此命令面板里也能搜到；只改空白与竖线位置 |
| `line-jump.ts` | 把光标落到第 N 行（打开 + 定位的两半，另一半在 `app/actions.openNoteAt`） | §8 第 4 条 |
| `cm/live-preview/table.ts` | **表格渲染**：把 GFM 表格渲染成真表格（复用 `domain/markdown.ts` 的唯一渲染管线），光标进入则整块露原文 | 见 §8 第 14 条：为什么是"整块"、什么情况下刻意不渲染 |
| （**上游**）`markdown()` 自带的 `pasteURLAsLink` | 把 URL 粘到**选中的文字**上 → 包成 `[文字](url)`；`www.` 自动补 `https://`，也认 `mailto:`/`xmpp:`；选区落在行内代码/链接/图片里或跨越语法节点时不动手 | **默认就开着**，所以这里没有我们的实现：曾经手写过一份等价扩展（`url-paste.ts`），调试中发现两份会互相抢先、真实生效的始终是上游那份（它的语法树守卫还更稳），于是把自写版删掉、改为**用测试把上游行为钉住**（`tests/paste-url-link.test.tsx`） |

三条纪律（踩过坑）：
1. **全局快捷键装在捕捉阶段**，注册过的组合键赢过编辑器自己的绑定 —— 否则 `Ctrl+G` 会被编辑器侧吃掉（见 `app/keymap.ts` 的注释）；
2. **弹层不进 `.cm-content`**：`wiki-complete` 的浮层挂在 `.cm-editor` 下当兄弟节点，否则它会被当成文档内容参与排版测量；
3. **动手前先查上游有没有已经做过**：`@codemirror/lang-markdown` / `@codemirror/view` 这类包里，常见输入体验（URL 粘贴成链接、表格里的 Tab、列表续行）往往已经内置且默认开启。重复实现不只是白写 —— 两个 DOM 事件处理器会互相抢先，表现为"行为随机地由其中一个决定"，排查成本极高。判断方法：在自己的扩展里临时打一条 `dispatch` 栈，看真正改文档的是谁。

### 2.2 设置页与应用菜单的接线

**一个原则：能力只有一份实现，界面只是它的投影。**

| 界面 | 投影自 | 为什么 |
| --- | --- | --- |
| 应用菜单（标题栏） | **命令注册表**（`app/builtin-commands.ts` 的 `BUILTIN_COMMANDS`，按 `category` 分组） | 菜单与命令面板读同一份数据。若菜单自己维护一张表，"面板里能搜到、菜单里没有"这种漂移迟早出现；菜单只**跳过**面板自己托管的那几条命令（避免同一个动作出现两行） |
| 命令面板 | 同上 | 依赖 Vault 的命令按 `when()` 置灰并显示 `unavailableReason` —— 判据只有一处 |
| 设置页的值 | `state/settings-store.ts`（localStorage `mimenote.settings.v1`），每个值落到"一个可逆副作用" | 见下表 |

设置项的落点（每一项都必须**即时生效 + 可逆**，且**不重建编辑器**）：

| 设置 | 落到哪里 | 为什么这样接 |
| --- | --- | --- |
| 主题 | `theme/apply.ts` 写一组 CSS 变量 + `data-theme` | 颜色全部来自令牌（`theme/tokens.ts` 是唯一契约，单测校验每个内置主题都提供全部令牌） |
| 界面 / 编辑器 / **阅读视图**字号 | `features/settings/font-overrides.ts` 写 `--mn-font-size-*`（内联 + 一条 `!important` 作者样式表） | 浏览器只做一次样式重算；**CodeMirror 实例、撤销历史、光标位置全都不用动**。两条路径一起写是因为换主题会整批重写内联令牌，只写内联会被覆盖回去（见该文件头） |
| Tab 宽度 | `--mn-tab-size` + 编辑器里的 `tabSizeCompartment` | 纯 CSS 那条管预览与设置页自身，compartment 那条管编辑器的**列宽语义**（列表层级、光标列计算都依赖它） |
| 自动保存延迟 | `note-store` 的 `configureAutosave({ delayMs })` | 它是模块级参数，设置页只是把已持久化的偏好喂进去 |
| 附件目录 | `attachment_save` 的 `dirRel`（粘贴/拖入图片落盘处） | 值是 **Vault 内相对目录**，所以换 Vault 仍然指向"那个 Vault 里的同名目录" |
| 阅读视图字号 | `--mn-font-size-reading`（阅读正文、导出件、打印容器共用） | 它**不是主题令牌**：主题 JSON 里没有它，因此不会被换主题覆盖；导出件额外读一次这个变量（`readExportTokens`），因为导出件是给人**读**的 |

**标题栏就是窗口本身**（ADR-0017）：宿主的 `tauri.conf.json` 关掉了系统装饰（`decorations: false`），
所以 `App.tsx` 里那条 `.mn-titlebar` 不是"应用内部的一条工具栏"，而是**唯一的标题栏**。
配套的三件事必须记住：① 它是拖动区（`data-tauri-drag-region="deep"`，Tauri 注入脚本负责拖动与
**双击最大化**，并自动跳过按钮/输入框这类可点击元素，因此不需要 `stopPropagation`）；
② 关窗口只能靠我们自己的按钮（`features/window/`），能力集里那 6 条 `core:window:allow-*`
就是为此而开；③ 最大化图标**从真实窗口读回来**（`isMaximized` + `onResized` 订阅），不自己做本地开关
—— 双击标题栏、`Win+↑`、拖到屏幕上沿都会改变窗口状态，本地开关必然与之脱节。

它内部**分三区**（ADR-0029，列宽 `1fr / 2fr / 1fr`）：左 = 我在哪个库（菜单 + 品牌 + Vault 名）、
中 = 我在哪一篇（当前笔记路径 + 「保存中…」）、右 = 这个库多大 + 出口动作（统计 + 导出 + 三个窗口按钮）。
两条与布局有关的纪律：**中区落在窗口正中靠的是左右两条等宽轨道**（不是"两边内容刚好一样宽"
这个巧合），而**纵向不能写 `align-items`** —— 三区都撑满 34px，窗口按钮的
`align-self: stretch`（"点关闭不该要求瞄准一个 10px 的方块"）依赖它。
路径从前挂在编辑器面板里（`.mn-editor__path`），搬上来的直接收益是顶部高度恒定、
且阅读/图谱视图里也看得见当前是哪一篇。

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
| `note_set_tags` | `relPath, add[], remove[], baseMtimeMs` | `SetTagsOutcome` | 在 frontmatter 上**加/删标签**（标签面板的写入口，ADR-0006「后续修订」）：宿主一次做完「令牌校验 → 读盘 → 最小 diff 改写 → 原子写 → 索引增量同步」，前端不自己拼 frontmatter（判同与保真纪律只有一份，在 `mn-core`）。入参是**增与删**而不是"新的完整列表"—— 面板上的列表可能比磁盘旧一拍，传"想要什么"会在那种情况下静默丢掉别的标签；幂等请求（结果与磁盘一致）返回 `changed=false`：**不写盘、不动 mtime、不重建索引**；`baseMtimeMs` **必填**，与磁盘不一致 → `CONFLICT`（与 `note_write` 同一套语义，绝不静默覆盖）。出参多带 `tags`（写入后磁盘上真实的标签，供前端如实解释"这条来自 `tag:` 字段、没被删掉"）与 `text`（写入后的整篇文本，前端据此**一次往返**把编辑器内存对齐磁盘，不必再读一次） |
| `tag_rename` | `from, to, includeChildren, dryRun` | `TagRenameOutcome` | **全库**把一个标签改名或合并进另一个（ADR-0006「后续修订」）：候选集来自标签索引，逐篇走「`(mtime,size)` 对账 → 读盘 → frontmatter（`tags` 与 `tag` 两个字段）+ 正文行内 `#标签` 一起改 → 原子写 → 索引增量同步」，**逐篇一个短临界区**（不把自动保存挡在整批之外）。`dryRun` 只回"这会改 N 篇"**不落盘**；`includeChildren` 决定 `父` → `母` 时是否把 `父/子` 一并带走（只换前缀那一段，后缀逐字保留）。**跳过如实汇报**：`skipped[{relPath, reason, message}]`（`external-change`/`unreadable`/`write-failed`）与 `unchanged`（磁盘上已经没有旧写法），幂等重试安全；索引未就绪时直接报 `IO`（候选集不完整时"改了 0 篇"是错的） |
| `note_create` | `parentRel, title` | `NoteContent` | 唯一命名，返回新笔记 |
| `note_delete` | `relPath, confirm` | `TrashRecord` | `confirm=false` 时返回 `CONFIRMATION_REQUIRED` |
| `trash_list` | — | `TrashEntry[]` | 列出回收站（最近删的排最前）。每条 = 台账记录 + `present`：台账是**追加写入**的，用户手工清过 `.mimenote/trash` 之后仍会留着指向不存在文件的记录 —— 界面必须能如实区分"可以恢复"与"东西已经没了"，而不是让用户点下去才吃到 `NOT_FOUND`（ADR-0018） |
| `note_restore` | `id, targetRelPath?` | `RestoreSummary` | 恢复一条：不传目标就回到**当初的位置**，传了就放到那里（「恢复为…」）。**绝不覆盖**：目标已存在 → `ALREADY_EXISTS`，记录与文件都原样留在回收站。恢复后**单篇**就地补条目 + 索引增量同步；**整目录**返回 `needsRescan=true`，由前端走一次静默重扫（一个目录可能带几百个文件，逐条构造 `EntryMeta` 等于把扫描口径抄第二遍） |
| `note_rename` | `relPath, newTitle, updateLinks?` | `RenameOutcome` | 同目录改名 + **全库链接精确改写**（默认 `updateLinks=true`）：按字符 span 改写，保留别名/锚点、跳过代码块、BOM/换行保真；返回被改写的文件与条数 |
| `note_move` | `relPath, targetParentRel, newTitle?, updateLinks?` | `RenameOutcome` | 跨目录移动（拖拽整理 / 命令面板「移动到文件夹…」）：与 `note_rename` **同一条链路**（换位置 + 改写全库链接 + 索引增量同步），因此**复用同一个 DTO**。`targetParentRel` 是目标父目录（`''` = Vault 根；目录不存在时创建）；`newTitle = null` 表示沿用原文件名（拖拽就是这种情况）；跨目录时链接一律改写成**相对新位置的路径** —— 裸名链接会被"同目录优先"消歧规则重新解释到别的同名笔记上。文件搬迁优先原子 `rename`，跨卷退回复制 + 删源；目标同名 → `ALREADY_EXISTS`（**绝不覆盖**）；移到自己所在目录 → 无操作 |
| `dir_rename` | `relPath, newTitle, updateLinks?` | `RenameOutcome` | **目录**重命名（连同整棵子树，ADR-0015）：磁盘上换名字 + 全库指向子树里**每一篇**的链接精确改写 + 索引增量同步。与 `note_rename` **同一条链路**的复用（候选集、span 改写、保真纪律都是同一份），因此**复用同一个 DTO**，只是 `oldRelPath`/`newRelPath` 是目录路径、`newMtimeMs` 恒为 `0`（目录不是版本令牌的载体）。目标位置已有同名目录 → `ALREADY_EXISTS`（**绝不覆盖、也绝不合并两棵子树**）；源不存在 → `NOT_FOUND`；源是文件 → `NOT_A_DIRECTORY`；`.mimenote` 内部目录一律拒（`PATH_INVALID`） |
| `dir_move` | `relPath, targetParentRel, newTitle?, updateLinks?` | `RenameOutcome` | **目录**移动（整棵子树，ADR-0015）：入参口径与 `note_move` 完全一致（`targetParentRel` 是目标父目录、`''` = Vault 根、不存在时创建；`newTitle = null` 沿用目录名 —— 拖拽就是这种情况）。整棵目录一次原子 `rename`（跨卷退回复制 + 删源）；**搬进它自己或它的后代** → `PATH_INVALID`（附一句能读懂的原因）；目标同名 → `ALREADY_EXISTS`；移到自己所在目录 → 无操作 |
| `note_stats` | `relPath` | `DocumentStats` | 磁盘上文档的真实统计（`mn_core::text_stats`），与编辑器内即时统计互为校验 |
| `index_status` | — | `IndexStatus` | 链接索引进度/概况（`idle`/`building`/`ready`/`cancelled`/`failed`）；`reusedNotes` 是"这一轮没有读文件、直接复用落盘索引"的笔记数（等于 `indexed` 即 Vault 没变） |
| `note_links` | `relPath` | `NoteLinks` | 该笔记的出链与反向链接（含悬空与歧义标记） |
| `tag_move` | `key, parent, includeChildren, dryRun` | `TagRenameOutcome`（与 `tag_rename` 同一个 DTO） | **层级编辑**：把 `key` 挂到 `parent` 下面，或（`parent` 为空）提回**顶层**（ADR-0006「后续修订」）。目标键由纯函数 `mn_core::tags::tag_move_target` 算 —— **只换祖先不动名字**（`父/甲/孙` 挂到 `母` 下是 `母/孙`），四条非法移动在写盘前拦住（挂到自己 / 挂到自己的后代 / 父标签里有空段 / 已经在那里了）。与 `tag_rename` 的分界是**合并**：目标键已被别的标签占用时**拒绝**并指向「重命名」（静默合并会让"只是换个位置"变成丢标签）。实现上**不开第二套写路径** —— 校验之后直接调 `tag_rename_in`，因此同一把写锁、同一份 `(mtime,size)` 对账、同一个 `write_atomic`、同一处索引增量同步、同一份 `skipped` 口径，前端连结果界面都复用 |
| `note_tags` | `relPath` | `NoteTags` | 该笔记的标签（frontmatter + 正文行内，带来源与行号）与 frontmatter 属性表（保序） |
| `tags_list` | — | `TagSummary[]` | 全库标签概览（按笔记数降序；`key` 是归一化键，`tag` 是首次出现的写法） |
| `tag_notes` | `key` | `TagNotes` | 某个标签下的笔记（传原始写法也可以：宿主入口会再归一化一次） |
| `tag_filter` | `any[], none[], includeChildren` | `TagFilterResult`（`paths[] / matched / tagged`） | **组合过滤**：含 `any` 里任意一个（空 = 全部有标签的笔记）且**不含** `none` 里任何一个；`includeChildren` 打开时 `父` 也匹配 `父/子`、`父/子/孙`（按 `/` 切段比较，`父老`/`父辈` 不算后代）。文件树的标签过滤走它，**一次往返算完** —— 在这之前前端只能逐个标签问（层级要展开成"父 + 每个后代各一次"，200 个子标签 = 201 次 IPC），"有 A 且没有 B"更是只能两次查询再相减。纯内存索引计算，不碰文件 |
| `search_query` | `query, limit?` | `SearchResult` | 全文搜索（SQLite FTS5，倒排索引缓存于 `<Vault>/.mimenote/cache/search.db`）：`-bm25` 排序，返回命中行号与裁剪后的片段；`total` 是命中总数（可大于 `hits.length`） |
| `asset_authorize` | `relPaths[]` | `AssetGrant[]` | 本地图片的**逐文件**读取授权（ADR-0007）：路径经 `path_guard::resolve_existing` 校验后，只把这一个文件加进 asset 作用域并返回磁盘绝对路径；**未通过校验的条目不会出现在返回值里**（调用方留在占位态） |
| `graph_data` | — | `GraphData` | 知识图谱的节点与边（ADR-0010）：节点含 `folder`/`tags`/出入度；边按 `(from,to)` 去重并带 `count`，`toRelPath=null` 表示悬空链接且 **`toRawTarget` 是用户写下的原始目标名**（三者都取第一条链接的写法）；只读索引、不做文件 IO；节点超过 8000 时按度数截断并置 `truncated` |
| `graph_ego` | `relPath, depth?, maxNodes?` | `GraphData`（**与 `graph_data` 逐字同一个形状**） | **自我中心子图**（ADR-0021）：以 `relPath` 为圆心、双向 BFS（出链与反链都算一跳）取 `depth` 跳以内的子图。`depth` 归一化到 1..5（缺省 1）、`maxNodes` 到 1..300（缺省 80）；截断按"距离升序 → 同层度数降序 → 路径字典序"，因此**截断后子图必然连通**；起点恒在，悬空边只在中心那一侧；起点不在索引里 → 空结果且**不报错**（笔记刚被删、还没保存）。度数仍是**全库**口径（与 `graph_data` 一致，不要在前端"修正"成子图内度数）。纯内存索引计算，≈50–60 ms / 1 万笔记 |
| `asset_read_base64` | `relPaths[]` | `AssetBytes[]` | 图片字节（`data:` URL 的原料，**导出**用）：与 `asset_authorize` 共用扩展名白名单与 `path_guard::resolve_existing`；单张 ≤ 8 MiB、单批 ≤ 32 MiB / 256 张，**超限或越界的条目静默跳过**（与 `asset_authorize` 的"拿不到就不返回"语义一致） |
| `export_write_html` | `path, html` | `ExportOutcome` | 把自包含 HTML 写到系统保存对话框选定的路径（ADR-0011）。这是**唯一允许写 Vault 之外**的写命令：目标路径不做越界限制（导出到桌面是正常需求），靠**扩展名白名单 `.html`/`.htm` + 内容 ≤ 32 MiB** 把能力收窄成"写一个 HTML 文件"；写入走 `mn_core::atomic::write_atomic` |
| `export_site_plan` | `outputDir?` | `SitePlan`（`vaultName / outputDir / previous / pages[] / stats / assets[]`） | **整库导出的计划**（ADR-0019）：页面表（每页的 `pagePath`/`urlPath`/`title`/`tags`/出链 `href`/反链）、统计。**只读、只回一次**（4 千篇的计划是几 MB 的 JSON，逐篇问会是几千次往返）。链接的 `href` 由索引的解析规则算好（相对**本页**、逐段百分号编码），前端只查表 —— "谁指向谁"只有索引那一份。传了 `outputDir` 就顺带做目标目录预检并回带上次标记（`previous`）；**在 Vault 内/`<Vault>/.mimenote` 之下 → `PATH_INVALID`**，非空且没有我们的标记 → `ALREADY_EXISTS`；索引未就绪 → `INDEX_NOT_READY` |
| `notes_read_batch` | `relPaths[]`（≤ 64） | `NotesBatch`（`items: NoteContent[]` / `skipped[]`） | 批量读原文（整库导出用）：把 4 千次往返压到几十次。**单篇失败不整批失败**：`skipped[{relPath, reason, message}]`，`reason ∈ not-found / unreadable / not-utf8 / too-large`（与 `tag_rename` 的跳过口径同构） |
| `export_site_write_pages` | `outputDir, files[{relPath, text}]` | `SiteWriteOutcome`（`files / bytes / writtenInMs / createdDirs[]`） | 往用户选定的目录批量写站点文件。**扩展名白名单 `.html`/`.css`/`.json`**；站内路径逐段校验（`..`、绝对路径、盘符、`:`（ADS）、Windows 保留设备名、控制字符、结尾点/空格全拒）；**批内按数组顺序写**（前端据此把 `index.html` 与标记文件留到最后 —— 中途失败时目录里没有任何东西自称导出完成）；逐文件 `write_atomic`；**从不删除任何文件**；单批 ≤ 256 个文件 / 32 MiB |
| `export_site_copy_assets` | `outputDir, assets[{vaultRelPath}]` | `SiteAssetOutcome`（`copied / bytes / createdDirs[] / skipped[]`） | 把图片复制进站点的 `assets/<原 Vault 相对路径>`（**复制而不是内嵌**：静态站是一个目录，内嵌会让同一张图在几千个页面里各存一份）。字节只在宿主里搬，不走 IPC 的 base64 通道。白名单复用 `assets.rs` 的图片扩展名判定（唯一一份）；单张 ≤ 64 MiB、单次 ≤ 512 张；越界/读失败/非图片进 `skipped` 并如实汇报 |
| `attachment_save` | `dirRel, files[]` | `AttachmentSaved[]` | 把粘贴/拖入的图片写进附件目录（ADR-0013）：`files` 是 `{ name, dataBase64 }[]`，出参是**去重之后**的相对路径与字节数。**要么整批落盘、要么一张都不落**；同名绝不覆盖（追加 ` 1`/` 2`）；扩展名白名单与 `asset_authorize` **同源**（`assets.rs` 的同一份常量）；单张 ≤ 8 MiB、一批 ≤ 32 MiB、一次 ≤ 32 张；文件名必须单段并过 `path_guard`（越界/保留名/符号链接一律拒），非法输入返回 `UNSUPPORTED_MEDIA`/`TOO_LARGE`/`PATH_INVALID`/`PATH_ESCAPE` |
| `snippets_list` | — | `SnippetFile[]` | 读取 `.mimenote/snippets/*.css` |
| `version_info` | — | `VersionInfo` | 应用 / mn-core / Tauri 版本 |

**事件（宿主 → 前端）**：

- `mn://index-status` 推送索引进度（`IndexStatus`）。用事件而不是轮询：索引构建是秒级的一次性过程，前端只需要"被通知"。
- `mn://vault-changed` 推送"Vault 在应用之外被改动了"（`VaultChanged = { paths, truncated, changes, detectedAtMs }`，ADR-0016）：
  宿主用 `notify` 监听 Vault 根（Windows 上是 `ReadDirectoryChangesW`），把**磁盘状态与条目表不一致**的事件
  去抖合并（静默期 500ms、硬上限 2s）后推给前端；前端据此静默重扫条目表（走既有的 `vault_snapshot`）
  并让当前笔记跟随磁盘（无未保存修改 → 自动重载；有 → 进既有的冲突态）。事件只回答"磁盘上有新闻"、
  不指挥接收方做什么 —— 因此不需要新命令，`Ctrl+Alt+R` 的手工重扫与自动重扫共用同一条链路。
  **应用自己写的文件不算外部改动**（保存/新建/改名后条目表立刻更新，事件到达时磁盘与条目表对得上就丢弃），
  `.mimenote/` 内部与 `mn_core::atomic` 的临时文件一律忽略。监听失败只记 warn，手动重扫仍是兜底。

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
| [ADR-0006](adr/0006-tags-and-frontmatter.md) | 标签/Frontmatter：解析在 `mn-core`、索引在 `mn-index`、`normalize_tag` 判同、改标签走既有写路径（后续修订：面板里加/删 frontmatter 标签走 `note_set_tags`） | 已采纳 |
| [ADR-0007](adr/0007-local-images-asset-protocol.md) | 本地图片走 `asset:` 协议，作用域按 Vault 动态注入（而非 IPC 传 base64 或自定义协议） | 已采纳 |
| [ADR-0008](adr/0008-full-text-search-fts5.md) | 全文搜索用 SQLite FTS5：中文逐字分词、external content 换行号、构建期放宽持久化 + 坏库自愈 | 已采纳 |
| [ADR-0009](adr/0009-wysiwyg-editor.md) | 所见即所得编辑（Live Preview），**移除"编辑 + 预览"双栏**；主区域三选一（编辑 / 阅读 / 图谱） | 已采纳 |
| [ADR-0010](adr/0010-knowledge-graph-card-canvas.md) | 知识图谱是**卡片画布**（非力导向小圆点）：文件夹自动成组、入链虚线/出链实线、卡片可直接预览 | 已采纳 |
| [ADR-0011](adr/0011-export-html-and-print-pdf.md) | 导出自包含 HTML（图片内嵌 `data:` URL）；PDF 交给系统打印对话框；`export_write_html` 是唯一允许写 Vault 外路径的命令，靠扩展名白名单收窄 | 已采纳 |
| [ADR-0019](adr/0019-static-site-export.md) | 整库导出静态站点：宿主出计划（索引驱动的链接解析 + URL 分配）、前端渲染（唯一一份 Markdown 管线）、宿主批量落盘；输出目录必须在 Vault 之外、非空目录凭标记文件认领、从不删除；零 JavaScript；页面里不含时间戳（确定性） | 已采纳 |
| [ADR-0020](adr/0020-large-document-preview.md) | 大文档阅读视图：整篇渲染**不能**搬进 Worker（DOMPurify 无 `window` 即不可用），主修是消掉两处放大（图片授权就地补图、wikilink 补类名线性化）；Worker 只承担解析且有门槛与同步回退；分块 + 视口窗口化留待下一轮 | 已采纳 |
| [ADR-0012](adr/0012-move-rewrites-relative-links.md) | 跨目录移动**同时改写被移动笔记自身正文里的相对路径链接**（纯路径算术，不做存在性检查；只动随位置变化的目标） | 已采纳 |
| [ADR-0013](adr/0013-image-attachments.md) | 粘贴 / 拖入的图片写进 Vault 附件目录（`attachment_save`）：字节走 IPC、MIME 定扩展名、同名去重、整批原子 | 已采纳 |
| [ADR-0014](adr/0014-persisted-link-tag-index.md) | 链接/标签索引与 FTS 落进同一个缓存库、共用同一份 `(path, mtime, size)` 判定键，写穿透挂在 `LinkIndex::upsert/remove` 内部 | 已采纳 |
| [ADR-0015](adr/0015-directory-rename-and-move.md) | **目录重命名与目录移动**（连同整棵子树的链接改写）：复用单篇搬迁的候选集/span 改写机制 + 前缀映射；整棵目录一次原子 `rename`；复用 `RenameOutcome`、不新增错误码 | 已采纳 |
| [ADR-0016](adr/0016-file-watching.md) | **文件监听**（Vault 外部改动的自动同步）：`notify` 只加在宿主；判定"是不是新闻"用**条目表 vs 磁盘**对账（自己写的文件天然被排除）；去抖 500ms / 硬上限 2s 合并风暴；不做按文件精细增量，走既有的去抖后重扫 + 增量索引构建；监听生命周期挂在 `set_vault` / `clear_vault` | 已采纳 |
| [ADR-0017](adr/0017-custom-title-bar.md) | **自绘标题栏**：关掉系统装饰（`decorations: false`），界面上那条 34px 的栏就是唯一标题栏 —— 拖动与双击最大化交给 Tauri 的拖动区，三个窗口按钮自己做且**状态从真实窗口读回来** | 已采纳 |
| [ADR-0021](adr/0021-graph-ego-canvas.md) | 知识图谱改为**自我中心子图 + canvas 卡片**：默认只看与当前笔记相关的部分（跳数=半径的同心环、深度可调 1..5 双向）、每张卡片是完整 Markdown 预览、BFS 在宿主里做（`graph_ego`）；整个 Vault 视图保留为可切换的另一种视图 | 已采纳 |
| [ADR-0022](adr/0022-callouts.md) | **Obsidian 风格 callout**（`> [!note] 标题`）：判据只有 `domain/callouts.ts` 一份，阅读视图/所见即所得/导出件/静态站点/图谱卡片五处一致；静态渲染里折叠符只是角标，**编辑器里真的收起**；强调色只有 app.css 一份表 | 已采纳 |
| [ADR-0023](adr/0023-graph-physics-and-floating.md) | 图谱的**浮动态**（环布局给种子 + 确定性力导向松弛：张力/斥力/向心力/阻尼/五个预设）与**从 wiki link 引出的连线**（卡片内虚线引线 → 卡片边界 → 卡片外张力曲线；找不到文字时如实降级）；**可调大小的卡片**（宽度是真尺寸、高度是上限）；**浮动笔记面板**（不引库、不持久化、`Esc` 先关浮窗；漂浮 20fps）。后续修订：**力度管理面板 + 碰撞是硬约束**；**拖拽跟手**（`pins` 不再是模拟重建的依赖、命中用当前矩形、交互 `heat` 重新加热、漂浮有强度底值）、**引线单独成层**（卡片内那段必须画在卡片层之上，否则被不透明卡片整段盖掉） | 已采纳 |
| [ADR-0024](adr/0024-task-lists.md) | **任务列表**（`- [ ]` / `- [x]`）：判据只有 `domain/task-list.ts` 一份、结论写在 token 上由五处消费；复选框是**禁用的原生 `input`**（阅读视图与导出件只读），净化白名单为此开一个口子并由钩子强制边界；已完成只变暗、不用删除线 | 已采纳 |
| [ADR-0018](adr/0018-trash-restore.md) | **回收站恢复**：默认恢复到原位置、原位置被占用时**拒绝并给「恢复为…」**（绝不覆盖）、台账来源逐条校验（防篡改台账变成任意文件移动原语）、单篇就地补索引 / 整目录交给静默重扫、界面由命令 `vault.trash` 打开 | 已采纳 |
| [ADR-0025](adr/0025-graph-card-reading.md) | 图谱卡片读正文的那几条决定：**移除停靠预览面板**（单击 = 选中，"读全文"交给浮窗，`Esc` 两层语义改成先关浮窗再取消选中）；**「仅标题」档**（不排正文、引线如实降级）；**宽高都能拖** + **「全文」档**（`maxHeight: Infinity`，与数值档互斥）；**引线加粗加深但仍是虚线**；**悬停正文里的 `[[链接]]` 提亮对应的边**（`linkZones` 与 `findLinkAnchor` 共用同一套遍历）；**失去焦点即松开**（点空白 + 选中变化两条路，都加热力场） | 已采纳 |
| [ADR-0026](adr/0026-dockable-modules.md) | **视图模块的三个停靠区**（左/右/底 + 区内顺序）：`dock-layout.ts` 是纯函数并带"每个模块恰好一次"的不变式；只存**位置**不存可见性（四条切换快捷键一字不改）；拖拽（空区在拖动期间出现"可放"轨道）与键盘等价物（`Alt+1/2/3`、同区 `Alt+方向键`）；**标签栏搬到窗口顶部**（`.mn-app` 的直接子节点，删掉 `.mn-main:has(> .mn-tabs)`）；**通用右键菜单**接入文件树行 / 标签页 / 停靠模块头 / 图谱卡片（菜单项直接执行既有命令）。**已被 ADR-0035 取代**（三区停靠是切割树的退化特例；`dock-layout.ts` 只剩迁移/回滚的读取面） | 已采纳（后被 0035 取代） |
| [ADR-0027](adr/0027-ui-preferences-and-reading.md) | **文件树排序可配置**（`domain/tree.ts` 一份判据；`mtimeMs: null` 恒排最后、兜底键恒升序；重排在数据层）；**最近打开的 Vault**（左下角、最多 8 条按根路径去重、可移除、`closeVault` 不清）；**阅读向主题「纸墨」**（一个 JSON，令牌与浅色主题逐键对齐）；**已完成任务加删除线**（观感改动：阅读视图/导出件画在 `li` 上，编辑器里必须是只圈文字的 mark 装饰） | 已采纳 |
| [ADR-0028](adr/0028-edge-semantics-and-routing.md) | 连线的**语义分层**（以当前笔记为参照：出链暖 `--mn-edge-out`、入链冷 `--mn-edge-in`、环间中性；跳数编码线宽与不透明度，且**淡化/强调是乘性调制**而不是覆盖 —— 否则跳数权重永远看不见）与**环向走线**（同环沿"最远的角之外"的弧走、跨环用朝外鼓的径向切线、涉及圆心保持 ADR-0023 原样；换形状时锚点换到卡片外缘，引线随之重画以守住分界纪律）；HUD 上有「沿环走线」开关（缺省开、可落盘） | 已采纳 |
| [ADR-0029](adr/0029-titlebar-three-regions.md) | **标题栏定型为左/中/右三区**（网格 `1fr / 2fr / 1fr`：左 = 哪个库、中 = 哪一篇、右 = 多大 + 出口动作），**当前笔记路径从编辑器面板搬进中区** —— 顶部高度因此恒定 34px，路径在阅读/图谱视图里也看得见；三区只是 `div`，标题栏整条仍是拖动区（ADR-0017 不变）。**中区的内容后又经 ADR-0034（文件标签）与 ADR-0035（纯拖动区）两次替换，"我在看什么"现在在状态栏最左** | 已采纳 |
| [ADR-0037](adr/0037-open-note-replaces-tab.md) | **打开笔记默认"顶掉"当前那条标签**（用户约定：「默认的新文件替换中的叶标签，即已打开的直接被新的替换掉」）：列表动作在 `tabs-store.syncFromNote`（顶掉刚在看的那条；新标签排末尾，与布局的挂载顺序一致）；打开**已经打开**的笔记 = 切换、不替换；"在新标签里打开"的入口是文件树上的 `Ctrl/⌘+点击` 与中键（`openNoteInNewTab` + 一次性旗子）；切换前**只在冲突态**弹确认（普通的未保存修改会先落盘，弹"会丢修改"是假话）；被顶掉那条的光标位置照记 | 已采纳 |
| [ADR-0036](adr/0036-edges-into-canvas.md) | **连线搬进 canvas**：连线与卡片共用一张画布，绘制顺序是硬契约（**卡外那段 → 卡片 → 卡内引线**），`GraphEdges.tsx` 那一层 SVG 与 `.mn-graph-edge*` 那批 CSS 退役；几何变成**点模型**（`canvas/edge-path.ts` 只认 M/L/C/A，椭圆弧展开成三次贝塞尔，解析只做一次、画与命中读同一份）；命中测试自己补（`edgeAt` 按"指针离折线多远"取最近的，容差 5 屏幕像素），**提示第一次真的会弹**（SVG 版那层挂着 `pointer-events: none`，`<title>` 从来没出现过）；漂浮 **20fps → 60fps**；顺手修掉"跳数权重被 CSS 表现属性优先级盖掉、从来没生效"这条落差（`EdgeStyle.width/opacity` 现在真的画得出来）；自动化抓手从 SVG 类名换成宿主上的 `data-graph-edge-*` | 已采纳 |
| [ADR-0035](adr/0035-container-split-tree.md) | **容器切割树**（布局模型 + 渲染器）：模块与笔记统一成"**标签**"，界面 = 一棵二叉切割树（`Split{axis, ratio, a, b}` / `Leaf{items, active}`）；六条不变式（**每个标签全树恰好一次**、空叶塌缩但**主叶允许为空**、比例夹 [0.15,0.85]、认不出的标签丢弃、整棵不合法退回默认、`active` 必须属于本叶）；操作全是纯函数；每格 = 标签条 + 内容（笔记与模块混排、标签是拖动源、**非当前笔记渲染只读预览**）；落点 = 条内插位 / 中央并入 / 四边带切割；`Alt+1/2/3` 搬到主区左/右/下、`Alt+←/→` 条内换位置；模块切出时按家尺寸定比例；`fromDockLayout` 把 ADR-0026 的配置按**旧像素宽度**迁移成比例；旧 `dockLayout` 键保留作回滚 | 已采纳 |
| [ADR-0034](adr/0034-merged-top-row.md) | **顶行合并**：标题栏、文件标签与窗口按钮同一行（三区网格不变，**中区从"当前路径"换成"文件标签栏"**；行高 34→36；这一行永远在，所以窗口按钮不会因"没有标签"而消失）；"我在看什么"挪到**状态栏最左**；标签条声明 `data-tauri-drag-region="false"`（否则按住 `role="tab"` 的 `div` 会被当成拖窗口）；布局契约式改成 `主体 = 窗口 − 标题栏 − 状态栏`。**后随 ADR-0035：标签进了各自的格子，中区回归纯拖动区** | 已采纳 |
| [ADR-0033](adr/0033-icon-size-scale.md) | **图标尺寸刻度**：`ICON_SIZES = { xs:12, sm:14, md:16, lg:20, xl:24 }` + **联合类型** `IconSize`（写刻度外的数字编译不过），78 处旧字面尺寸（9 种）一次收敛；字形图标（callout 的 `✎`、行内 `✓`）按 `em` 跟着字号走、**不**进这把尺子；CSS 侧 `--icon-*` 与组件刻度由单测钉住；两道闸：源码里 `<Icon size={数字}>` 必须 0 处、实参只能是刻度名 |
| [ADR-0032](adr/0032-attachment-viewer.md) | **第二类可打开的文件**（附件只读查看器）：判据只有 `domain/viewable.ts` 的 `viewerKindOf` / `isViewable`（图片那一支复用 `domain/assets.ts` 的白名单，不抄第二份）；主区形态由 `ui-store.openedFile` 决定（笔记三视图 or 附件查看器），**只读、不进标签页、不引写路径**；标题栏中区改成"我正在看什么"，`data-note-path` 随之改名 `data-main-path`；三条收口路径（打开笔记 / 点视图按钮 / 换 Vault） |
| [ADR-0031](adr/0031-design-tokens-and-default-font.md) | **VI 落地第一批**：设计令牌分两层（`--mn-*` 是存储格式、VI 规范名 `--bg-base`/`--text-primary`/`--radius-md`/`--space-*` 是公开书写面，别名层在 `app.css`；可选令牌走"可选 + 兜底"、**不进** `REQUIRED_TOKENS`）；**默认字号三档统一 16** —— 真值在设置层 `DEFAULT_SETTINGS`（`font-overrides` 以 `!important` 覆盖主题与 `:root`），随之把文件树行高 26 → 30；字体族按"可选皮肤"处理（`--font-reading`/`--font-editor` 默认回落 UI 字体，**没有**采纳阅读衬线/编辑等宽）；间距阶梯先定义不套用 | 已采纳 |
| [ADR-0030](adr/0030-hide-md-extension.md) | **界面上不写笔记的 `.md`**：判据只有 `domain/paths.ts` 的 `displayName` / `displayPath` 一份；只在"这是哪一篇"的标识显示上生效，**外部产物、宿主错误原文、路径编辑类对话框保留真实文件名**；悬停 `title` 与 `data-note-path` / `data-tab-path` / `data-rel-path` 一律给真实路径（自动化的身份探针不再依赖可见文字） | 已采纳 |


## 5. 安全模型

| 威胁 | 缓解措施 | 落点 |
| --- | --- | --- |
| 路径遍历（`../../etc`） | 相对路径成分白名单校验 + canonicalize 后 `starts_with(root)` 复查 | `mn-core/path_guard.rs` |
| 符号链接逃逸 | 逐级 `symlink_metadata` 检查，符号链接目标必须仍在 Vault 内；扫描默认不跟随链接 | `mn-core/path_guard.rs`、`scanner.rs` |
| 预览读取 Vault 外的文件（本地图片） | asset 协议**逐文件授权**：`path_guard::resolve_existing` 逐级检查符号链接 + 越界拒绝，只把通过校验的那一个文件加进作用域。**不用目录级作用域** —— Tauri 的 asset 协议按路径字符串匹配后直接 `File::open`（不 canonicalize），目录级放行会被 Vault 内的符号链接绕过（ADR-0007） | `src-tauri/src/assets.rs`、`mn-core/path_guard.rs` |
| Windows 保留名/ADS（`con.md`、`a:b`） | 段级黑名单校验 | `mn-core/path_guard.rs` |
| 写到 Vault 之外（导出） | 只有 `export_write_html` 一条命令能写 Vault 外路径，且**只接受 `.html`/`.htm`**（大小写不敏感）—— 白名单同时挡掉 ADS 尾巴（`a.html:ads`）；路径来自系统保存对话框；内容 ≤ 32 MiB。没有这条白名单，"带 path 参数且不校验越界"就等于一个任意文件写入后门（ADR-0011） | `src-tauri/src/export.rs`、`docs/adr/0011-export-html-and-print-pdf.md` |
| 写到 Vault 之外的**目录树**（整库导出） | 两条命令（`export_site_write_pages` / `export_site_copy_assets`）各自带**扩展名白名单**（页面只 `.html`/`.css`/`.json`，图片只走既有的图片白名单）；输出目录必须在 Vault 之外（在 Vault 内/`.mimenote` 之下 → `PATH_INVALID`）；每个站内路径逐段校验（`..`、盘符、`:`、保留设备名、控制字符、结尾点空格）并按"校验 → 建目录 → **再校验一次**（此时能真实 canonicalize）→ 原子写"的顺序执行；**从不删除任何文件**（ADR-0019） | `src-tauri/src/site_export.rs`、`docs/adr/0019-static-site-export.md` |
| 半写文件（断电/崩溃） | 临时文件 + fsync + rename 覆盖 | `mn-core/atomic.rs` |
| 误删数据 | 删除必须 `confirm=true`，文件移入 `.mimenote/trash` 并记 jsonl 台账（可恢复） | `mn-core/trash.rs` |
| XSS（笔记内嵌 HTML） | `markdown-it` 关闭 raw HTML + DOMPurify 二次净化 + 严格 CSP（`script-src 'self'`） | `domain/markdown.ts`、`tauri.conf.json` |
| 供应链 | 依赖数量最小化，逐个记录理由/许可证 | `docs/dependencies.md` |
| 隐私 | 无遥测、无自动上传、运行时无出站请求 | 全仓 |

## 6. 性能预算（默认基线，1 万笔记）

| 指标 | 目标 | 状态（M3） |
| --- | --- | --- |
| 冷启动到可交互 | ≤ 1500 ms | 未建立自动基准（M5）；当前无运行时网络请求、无同步阻塞 IO |
| Vault 扫描（1 万文件 + 100 目录） | ≤ 800 ms | **143 ms**（`cargo run -p mn-core --release --example scan_bench`，本机 SSD） |
| 打开 1MB Markdown | ≤ 100 ms | 状态栏显示每次读取耗时（`加载读取`），可直接观察 |
| 输入延迟 | ≤ 16 ms | 结构性保证：输入路径零 IO、编辑器不因文本变化重渲染、预览/大纲走 `useDeferredValue` |
| 大文档阅读视图（1 MiB 中文笔记，65549 个元素） | 未定目标（一次性渲染，口径见 ADR-0020） | jsdom 实测各阶段占比：解析 **≈9%**、DOMPurify 净化 **≈46%**、`innerHTML` 落地 **≈42%**、全篇 `querySelectorAll` **≈5%**。**净化与 DOM 只能留在主线程**（DOMPurify 在无 `window` 环境下连 `sanitize` 都未定义），因此超过 1 MiB 时把**解析**搬进 Worker，另两处放大（图片授权触发整篇重渲染、wikilink 补类名二次方）已消除；**窗口化未做** |
| 整库导出（1 万笔记） | 未定目标（一次性动作，进度可见、可取消） | 计划本身是 O(索引) 且不读文件；成本全在"逐篇渲染 + 逐篇原子写"，按 24 篇一批推进并在批边界让出主线程（ADR-0019）。实测见 §8 的静态站点条目 |
| 主线程单任务 | ≤ 8 ms | Rust 侧所有文件 IO 走 `spawn_blocking`；前端只做 O(可视行) 的窗口计算 |
| 保存（本地） | ≤ 50 ms | 状态栏显示每次写入耗时（含 fsync）；另有一次索引写穿透 **+0.68 ms/篇**（ADR-0014） |
| 文件树滚动 | 稳定 60fps | 固定行高 + 窗口化渲染：DOM 行数 = 可视行 + 2×overscan（与条目总数无关） |
| 全文搜索查询 | 交互可接受 | 1 万笔记 / 29.1 万行合成基准：命中 1000 行 **49–75 ms**；命中 29 万行（每行都含查询词）**0.8–1.1 s**；全量计数只占 12 ms。慢的那档是 `bm25()` 给全部命中打分的固有成本（已实测 CROSS JOIN / CTE+LIMIT / 去 ORDER BY / 页缓存 / mmap 等变体都在同一量级） |
| 打开 Vault（1 万笔记） | ≤ 800 ms（Vault 未变时） | **整库重建 9.8–10.5 s → 复用 0.25–0.34 s（约 30×）**：链接/标签/FTS 三者共用 `notes_meta(path, mtime_ms, size)` 判定键，Vault 没变时**一份笔记文件都不读**（对账 0.17–0.23 s + 装载 0.04–0.05 s，ADR-0008/0014）；改 1 篇只重读重写那 1 篇（0.26–0.31 s）。均后台可取消 |
| 知识图谱打开 / 平移缩放 | 交互可接受 | 10k 节点（合成）布局 **46 ms**、视口裁剪 **0.09 ms/帧**（只遍历与可视区相交的卡片）；`graph_data` 在真实量级下约 **55–85 ms**、JSON ≈ 1.0 MB（节点上限 8000，超出按度数截断）；拖动卡片只改一处坐标 + 防抖落盘 |
| **关系图（自我中心子图）**（ADR-0021） | 打开可接受、平移缩放无感 | `graph_ego` **≈50–60 ms / 1 万笔记**（双向 BFS 本身可忽略，贵在"入度按全库口径算"必须解析一遍全库链接 ≈20 ms；纯内存、零文件 IO）。前端：80 篇结构相似的中文笔记**排版成卡片 27.2 ms**（0.34 ms/篇，一次性且有 `(relPath, 标题, 正文, 宽度)` 缓存）、正文一次性随子图读回（`notes_read_batch` 40 篇/批）；**画一帧 0.3 ms（10 张可见）/ 1.1 ms（80 张全在屏幕里，3200 次绘制调用）** —— 对照：同样这 80 篇走一遍阅读视图的渲染管线是 **102.8 ms**，且**不含** DOM 落地与浏览器排版（那才是大头，见 ADR-0020） |
| **力导向浮动态**（ADR-0023 / ADR-0036） | 打开即落定、之后 **60fps** 慢漂移 | `createForceSimulation` 的 `settle()` 在 ego 一跳图上实测 **246 步**（默认参数 `alphaDecay 0.005` = 200 步预算，一次跑完就停）；单步是 `O(n²)` 斥力（宿主上限 300 节点 ⇒ 4.5 万对/步）。漂浮按 **60fps** 推进（`FLOAT_FPS`）：连线搬进 canvas 之后（ADR-0036），每帧要重画的只剩画布那一层 —— 卡片本来每帧都在重画，连线跟着一起画不再额外付出"一次 React 渲染"的代价。代价如实记着：卡片重画次数 20 次/秒 → 60 次/秒；真嫌重的下一招是脏矩形重画，不是把帧率压回去 |
| 阅读视图代码块复制 / 大纲跳转 | 瞬时 | 都是"渲染后挂按钮"与"滚一行"级别的 DOM 操作，无 IPC、无文件 IO |
| **目录搬迁**（1000 篇的子树） | 交互可接受 | 与**被引用的篇数**成正比、与子树大小无关：1000 篇里 50 篇被引用 **2.0 s**；500 篇内部链接 + 200 篇外部引用（700 个文件被改写）**8.3–10.4 s**。四段分解：计划 742 ms / 搬树 **2 ms**（整棵一次 `fs::rename`）/ 写回 405 ms（50 文件）/ 索引同步 720 ms。**瓶颈是每个被改写文件的 `write_atomic`（约 8 ms，含 fsync）** —— 700 次写入单独测就是 5.5 s（ADR-0015） |
| 内存（1 万笔记） | ≤ 500 MB | M5 接入（FTS5 库文件 29.1 万行约 114 MB、链接/标签表约 3.7 万行，都是磁盘缓存不是常驻内存） |
| **外部改动自动同步**（ADR-0016） | 可感延迟 ≤ 1.5 s | 去抖静默期 **500 ms**（风暴硬上限 2 s）+ 重扫与增量索引构建：1 万笔记 Vault 实测**宿主侧端到端 ≈ 714 ms**（判定 502–510 ms / 重扫 107 ms / 复用构建 105 ms），前端再叠一次 `buildTree(10000)` **11.7 ms**；小 Vault（十几篇）**≈ 0.51 s**（几乎全是静默期）。全过程在后台线程，不阻塞输入、可取消 |
| 监听常驻开销（1 个 Vault） | 可忽略 | **4 个 OS 句柄 + 2 个线程 + 约 0.5 MB 工作集**（`RecursiveMode::Recursive` 一次覆盖整棵树，不随文件数增长）；停掉监听后句柄与线程都回到基线（实测见 ADR-0016） |
| **FTS5 段合并**（增量收尾按段数触发，ADR-0008「后续修订」第 4 节） | 后台，不在输入路径上 | 1 万篇 / 30 万行：段数从 11–18 合并成 1 个，**查询平均 76.9 ms → 45.8 ms（1.68×；另一批次 82.8 → 37.3 ms = 2.2×）**，合并自身 **876–937 ms**（在后台构建线程上，不阻塞输入）；**文件大小不变**（118.5 MB → 118.5 MB）—— 它买的是查询速度，不是磁盘。段数 < 8 时一个字节都不动 |
| **悬空链接解析**（路径后缀表，§8 第 16 条） | 与库规模**无关** | 4000 篇库 + 2000 条互不相同的悬空链接：**0.0471 → 0.0005 ms/条（96.7×）**，2000 条 94.2 ms → **1.0 ms**；`graph_data`（4000 节点 / 6000 边）69.8 ms，其中悬空解析只占 **1.4 ms**。代价是后缀表内存：每个路径"段数"个条目（1 万篇约 2–3 MB） |

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

见 [milestones.md](milestones.md)。当前进度：**M1 / M1.5 / M2 / M3 已交付**（M3：所见即所得编辑与三视图外壳、
知识图谱卡片画布、设置页与应用菜单、图片嵌入与灯箱、多标签页、导出自包含 HTML / 打印为 PDF、
拖拽整理文件（跨目录移动 + 全库链接改写 + 移动时改写自身相对链接））。M3 之后又提前交付了若干
原属 M5 的项（**索引跨会话复用**：ADR-0008「后续修订」+ ADR-0014），以及超出原范围的体验项
（搜索命中行跳转、图片粘贴/拖入附件、大纲面板、阅读视图代码块复制、窗口标题跟随当前笔记、
**目录重命名 / 目录移动**：ADR-0015，整棵子树的路径与全库链接一起改、
**整库导出静态站点**：ADR-0019，每篇一个 HTML + 可点的双链 + 共享样式表 + 索引页，零 JavaScript）。
仍推迟：M4 插件系统（**标签编辑已交付**：ADR-0006 的三次「后续修订」，面板里加/删、
全库重命名/合并、**层级编辑**）。

## 8. 已知限制

1. **本地图片已可渲染**（ADR-0007 逐文件授权），并支持 `![[图.png]]` 嵌入、裸文件名全库兜底解析、点击放大灯箱（**预览与编辑器两处都能点开**：阅读视图的图片是 `img.mn-image`、所见即所得里的图片是 Live Preview 的 widget `img.mn-md-image`，灯箱两套类名都认；同一篇里有多张时还能翻页）；**粘贴/拖入的图片会自动落到附件目录并插入链接**（ADR-0013：MIME 定扩展名、通用名换成带时间戳的名字、同名追加 ` 1`，附件目录可在设置页改）。版式上：独占一段的图片渲染成**块级居中**（`.mn-figure--block` / `.mn-md-image-wrap`），段落里与文字混排的图片仍是行内（`inline-block`，按基线对齐）；**尺寸用 Obsidian 的写法** —— `![[图.png|300]]` 定宽、`|300x200` 定宽高（渲染成 `width`/`height` **属性**而不是内联样式：DOMPurify 默认放行它们，且只写宽度时浏览器按比例缩放；预览与编辑器两处共用同一个纯函数 `parseImageSize`，判据只写一遍 —— 数字以外的别名仍是图注，因为"300 字以内"这类**看起来像数字的图注**在中文笔记里很常见）。仍未做的：多图拖入时的**批量进度**（当前是一次 IPC 整批落盘，落盘中只显示一次"正在保存"）、图片的**对齐控制**（居中/左右浮动要写 CSS 片段）、附件转码/压缩（原样落盘）。
2. **重命名（M2）与跨目录移动（M3，`note_move`）都已交付**：同目录改名保持"最小 diff"（裸名链接仍是裸名），**跨目录移动**则把链接一律改成**相对新位置的路径**（`[[乙]]` → `[[子/乙]]`）—— 因为裸名靠"同目录优先"消歧，换了目录之后同一条链接可能落到另一篇同名笔记上；两者都复用同一套字符 span 改写（`[[甲]]` 不会误伤 `[[甲虫]]`、保留别名/锚点、跳过代码块、BOM/换行保真）与索引增量同步。移动**还会改写被移动笔记自身正文里的相对链接**（ADR-0012：`![](../附件/图.png)` 随新位置重算，纯路径算术、不查文件是否存在）。**目录重命名与目录移动也已交付**（ADR-0015，`dir_rename` / `dir_move`）：整棵子树的路径跟着变、全库指向子树里每一篇的链接精确改写，复用同一条搬迁链路与同一个 DTO；文件夹可拖、F2 / F6 对文件夹同样可用，**拖进自己的后代**是无效落点（两侧都拦）。仍未做：**引用式定义行**（`[id]: ../附件/图.png`）里的相对目标不改写（既有链接抽取器不认这种形态，为它单写一套上下文判定等于再养一个 Markdown 解析器）；带反斜杠的目标与**越出 Vault 根**的目标也跳过；另外被移动笔记里的**裸名 wikilink**（`[[乙]]`）不动 —— 它按文件名主干解析，移动后若全库有同名笔记可能改指另一篇（要修得模拟"搬过去之后会解析到谁"，属另一块）；目录搬迁本身**没有进度与取消**（1000 篇实测 2–10 s，只给一次 toast，见 ADR-0015 的代价表）。
3. `[[双链]]` **已可解析、渲染、跳转与反向链接**（M2 已交付）；**标签与 Frontmatter 现在是一整套可写的**：抽取/展示/跳转（M2）、面板里**加/删**（ADR-0006「后续修订」）、**全库重命名/合并**（同一个 ADR 的后续修订：连带正文行内 `#标签`，跳过代码块与行内代码，如实汇报跳过清单）、**文件树按标签过滤**（收窄视图，见下面一句）。加/删走 `note_set_tags`，重命名/合并走 `tag_rename` —— 两者都不开第二套写纪律（同一把写锁/同一份 `(mtime,size)` 令牌/同一个 `write_atomic`/同一处索引增量同步），冲突一律复用既有横幅语义。**正文行内 `#标签` 在"加/删"时是只读的、在"重命名/合并"时必须改**：前者只动 frontmatter（标出来源并提示"请到正文里删"），后者如果不动正文，"改了等于没改"（这是重命名而不是删除）。另一处口径要知道：面板显示的是 `tags` 与 `tag` **两个字段合并**后的列表，而加/删的写入目标永远是 `tags`（没有 `tags` 时才写 `tag`）—— 因此两者同时存在时 `tag:` 字段里的标签点 `×` 删不掉，面板会如实说"没有改动，它来自 `tag:` 字段"；**重命名/合并会改这两个字段里的任何一个**（`mn_core::frontmatter::editable_tags` 与 `Frontmatter::tags` 的分工见代码注释）。
   **文件树按标签过滤**（`features/vault/` + `state/tag-filter-store.ts`）是**只读收窄**：行集合 = 既有 `flattenTree` 结果 ∩ 标签命中集合（命中笔记的祖先目录自动保留、空目录不显示），排序/展平/虚拟窗口/键盘导航全部复用同一份实现。无选中 = 完全不过滤；多选是**并集**（交集在大 Vault 里极易得到空集，而"空集"与"过滤坏了"在界面上没法区分）；**「排除」= 有 A 且没有 B**（选项行末尾一个独立的排除按钮，"含"与"不含"用两组胶囊分开、互斥）；层级标签由「含子标签」开关明确表达（默认开）；**不持久化**（与同一条工具栏里的文本过滤一致：那是"我这会儿想看哪一类"，不是 Vault 的稳定属性）；查询失败时**整轮不收窄**（宁可不过滤，也不给"少了几篇"的假收窄），并在控件里说明原因 + 重试。**命中集合由宿主的 `tag_filter` 一次算完**（含/不含/层级全在索引上做，前端只做"可见路径 + 计数"这些与观感有关的事）。收窄期间**只有"拖到树的空白区域 = 移到根目录"被禁用**（列表短、空白大，误拖会静默搬家且根目录看不见）。
    **标签的层级编辑已交付**（同一个 ADR 的后续修订）：全库概览里每个标签旁的 `⇥` 打开「移到…」对话框
    （输入**父标签**，留空 = 提回顶层），与重命名**共用一个对话框**（三段式、明细、跳过汇报全部复用，
    只有输入框不同）但走独立命令 `tag_move`。三条口径：**只换祖先不动名字**（`父/甲/孙` → `母/孙`）、
    **目标已被占用时拒绝**并指向「重命名」（那是合并，不是移动）、**非法移动在写盘前拦**且理由原样显示
    （挂到自己/自己的后代/父标签里有空段/已经在那里了）—— 这里刻意不走 `describeError` 的错误码映射，
    否则 `PATH_INVALID` 会把"不能把标签挂到它自己下面"翻成"路径不合法"。宿主侧不开第二套写路径
    （`tag_move` 内部就是 `tag_rename_in`）。仍推迟：标签面板上的**拖拽成树**、多选一起移动、父标签输入的**前缀补全**。
4. **快速切换与命令面板已交付**（`Mod+K` / `Mod+P`）；**全文搜索已交付**（`Mod+Shift+F`，SQLite FTS5 + `bm25`，第三个面板模式 + 带竞态丢弃的异步查询），**命中行跳转也已交付**：入口是 `features/editor/line-jump.ts` 的 `openNoteAt(relPath, line)` —— 它先切回编辑视图、走既有的 `openNote` 打开，再**等这篇文档真的进了编辑器**（`note-store.revision` 那次整篇替换跑完，按帧重试并有超时上限）才用 `doc.line(n).from` 算行首，因此绝不会在旧文档上算偏移；定位本身是一次"只改选区 + 装饰"的事务（`Transaction.addToHistory.of(false)`：不进撤销历史、不置 dirty、不往正文插任何标记），滚动交给 `EditorView.scrollIntoView(..., { y: 'center' })`，并给该行一层几百毫秒后自动消失的高亮（`features/editor/cm/flash-line.ts`）。反向链接面板走**同一个入口**（`BacklinkRef.line` 是来源笔记里的行号，可直接定位）；出链刻意不定位 —— `ResolvedLink.line` 是引用写在当前笔记的哪一行，而 `#锚点` 是锚点名，宿主没有"锚点 → 行号"的接口（要做得新增一条宿主命令，不在本次范围）。
5. **frontmatter 会计入正文统计**（`text_stats` 拿的是磁盘原文，前端即时统计同样如此）：字数/行数/阅读时长里包含 `---` 分隔行与键值。要改必须**两侧同时改**（`mn_core::frontmatter::body` + TS 侧对应实现），否则"编辑器统计"与"磁盘统计"会互相打架。
6. 删除走 Vault 内 `.mimenote/trash`（可见、可入 Git 忽略），未对接系统回收站。**恢复已交付**（ADR-0018）：`restore_from_trash` / `restore_as` + 宿主命令 `trash_list` / `note_restore` + 界面（命令 `vault.trash`「打开回收站…」→ 列表 + 「恢复」/「恢复为…」）。三条纪律：**绝不覆盖**占位者（出路是换个名字）、**只动台账里且确实在 `.mimenote/trash` 之下的东西**（台账是磁盘上的普通 JSONL，手改一行就能指向任意文件，所以逐条校验 —— 没有这条"恢复"就是任意文件移动原语）、先搬文件后改台账（最坏是留一条可重试的孤儿记录）。父目录缺了就建并**如实报出建了哪些**。**没有"永久删除/清空"**：清空仍要用户去文件管理器里做（之后台账会出现孤儿记录，界面已标出）。
7. 外部变更检测依赖 mtime（毫秒）。同一毫秒内的外部改动理论上有漏检窗口（概率极低；M5 引入内容哈希作为二级令牌）。
8. **大文档阅读视图（ADR-0020）**：1 MiB 的中文笔记（65549 个元素）在 jsdom 里逐段实测占比 —— `markdown-it` 解析 **≈9%**、DOMPurify 净化 **≈46%**、`innerHTML` 落地 **≈42%**、全篇 `querySelectorAll` **≈5%**。因此**净化与 DOM 落地只能留在主线程**（DOMPurify 在没有 `window` 的环境里 `isSupported === false` 且 `sanitize` 未定义，调用直接抛 `TypeError`；DOM 构建更是主线程独占），Worker 只承担解析（超过 1 MiB 才启用，界面用 `data-mn-render` 标出走的哪条路，不可用时同步回落）。**这条路径刻意不判 `isTauriRuntime()`**：它与宿主无关（纯 JS 解析），而判它会带来"只有真实 WebView 才走 Worker"的后果 —— 那样能观察它的地方只剩"CDP 会不会上报 worker target"，而 UI 层 E2E（系统 Edge）本来就是唯一能用 `page.workers()` 断言它的层。本轮真正消掉的是两处**放大**：图片授权不再触发整篇重渲染（就地补图；从前每 200 张授权就整篇重渲一次，300 张图 = 3 次 × 66 ms）、wikilink 补类名从二次方降到线性（2000 条链接 1497 ms → 8.5 ms）。**仍未做分块 + 视口窗口化** —— 它才是消灭十万级 DOM 元素的办法，会打破"整篇都在 DOM 里"这一前提下的三处实现（大纲按 DOM 序号定位、灯箱的 document 级监听、代码块复制按钮重挂），留待下一轮。另：编辑器装饰按视口计算，但**光标移动也会重算**（"进入即露原文"的必然代价）。
9. 重命名时，若新文件名含 `#` 或 `^`，指向它的链接**不会被改写**（wikilink/Markdown 语法无法表达这种目标）：宿主跳过该条并记 warn 日志，而不是写出必然悬空的链接。
10. 索引后台构建期间（`indexStatus.phase === 'building'`）重命名，新路径可能被"构建完成时整轮替换索引"覆盖掉（要等一次重扫）；这是 `indexer::spawn_build` 的既有行为，未在本轮修。
11. E2E 覆盖"打开/编辑/保存/冲突/布局/主题/三视图/链接/重命名/拖拽整理/删除到回收站/键盘导航/分隔条拖拽/命令面板/快速切换/标签面板/全文搜索/本地图片/图片粘贴附件/知识图谱/搜索命中行跳转"等主干路径，但**未覆盖**：多窗口、插件（M4）、超大 Vault 下的表现。
12. **索引整体跨会话复用**（ADR-0008「后续修订」+ ADR-0014）：链接、标签、FTS5 落进同一个缓存库、共用同一份 `(path, mtime_ms, size)` 判定键。Vault 没变时**文件一份都不读**（1 万笔记：整轮 9.8–10.5 s → 0.25–0.34 s），改 1 篇只重读重写那 1 篇（0.26–0.31 s），后台可取消。仍存在的边界：判定键只有毫秒 mtime 与字节数，**同一毫秒内且字节数相同**的改动会漏检（与 ADR-0004 同一取舍，内容哈希属 M5）；`schema` 版本升级（含索引口径变化）后第一次打开仍是整库重建；复用一轮的主要成本是**对账**（0.17–0.23 s，要扫 `notes_meta ∪ lines` 的路径集合）；库里数据"看不懂"时会整轮退回读文件（方向安全，但不会顺手清库）。
13. **高频词的全文搜索会慢**（查询词若命中几十万行，`bm25()` 需要给全部命中打分 → 秒级）。这是 FTS5 排序的固有成本，已实测多个查询计划变体无显著差异；缓解手段是更具体的关键词（面板也有 150ms 防抖 + 竞态丢弃，不会堆积查询）。
14. **所见即所得覆盖高频语法，表格也已渲染**（ADR-0009）：**表格**已经渲染成真表格（`cm/live-preview/table.ts`）—— 对齐来自分隔行、列多时横向滚动且不让正文被撑宽、单元格里的行内语法照常渲染；**光标进入表格则整块露原文**（列宽是全表共享的，"只露一行"要么拆表、要么让竖线对不上并让视线反复重定位），**引用块/列表里的表格、缩进 ≥4 空格的"表格"、超过 200 行/20000 字符的"表格"刻意原样显示**（前者会与引用竖线/列表缩进抢同一行，后者是护栏）。仍**不做装饰**的是：缩进代码块、脚注、引用式链接、HTML、数学公式；frontmatter 只做淡色、不隐藏。装饰按 `view.visibleRanges` 计算，但**光标移动也会重算**（"进入即露原文"的必要代价），极端大文档下若手感有问题，需要再做"仅选区跨越装饰时重算"的优化。
15. **知识图谱会随编辑自动刷新（保留视角）**：保存成功（`note-store.saveCount` 变化）与索引就绪（`links-store` 的 `phase` 变成 `ready`）两条信号都会触发一次 `keepView` 刷新，前提是画布**正显示着**（监听由画布挂载/卸载，卸载后不多发一次 IPC）；切 Vault 或点「重新读取图谱」则是完整重载。仍然存在的边界：刷新会带上"正在重建索引"的提示徽标而不是等索引；手工拖动会覆盖自动布局（「重新自动排布」复位）；折叠状态刻意不持久化（每次默认全展开）；宿主上限 8000 节点，超出按度数截断（此时**度数仍是全图度数**，可能大于画布上可见的线数）—— 这个上限是"报文体积的硬上限"，几千篇的 Vault 因此能完整映射到画布上。
16. **图谱/反链的悬空链接解析尾巴已消掉**（原记录：`resolve_target` 在"按文件名找不到"时退化为全库后缀扫描）。**做法不是缓存"不可解析"判定，而是把路径后缀预建成表**（`LinkIndex::by_suffix`：`a/b/c` 贡献 `a/b/c`、`b/c`、`c`）：负缓存只对**重复**目标有效，而"还没写的计划"链接恰恰是**互不相同**的一大批目标（每个都要全扫一遍、每个都扫不到东西），所以按后缀建表才是对症的 —— 而且命中与不命中都是 O(1)，也就不需要一套失效逻辑（它随 `by_path` 在同一处维护，见 `index_suffixes` / `unindex_suffixes`）。实测（`bench_resolve_dangling_links`，4000 篇库 + 2000 条互不相同的悬空链接）：**0.0471 ms/条 → 0.0005 ms/条（96.7×）**，2000 条从 **94.2 ms 降到 1.0 ms**；同一批笔记的 `graph_data` 里含悬空与不含悬空的差从改前的约 94 ms 降到 **1.4 ms**。代价是内存：每个路径贡献"段数"个条目（1 万篇、平均 3 段约 2–3 MB）。
17. **导出**：单篇导出自包含 HTML / 打印为 PDF 已交付（ADR-0011）；**整库导出静态站点也已交付**（ADR-0019，`export.site` / `Ctrl+Alt+S`）—— 每篇一个 HTML（镜像目录树）、双链变成相对链接、图片复制进 `assets/`、整站一份共享样式表、根目录 `index.html`，**零 JavaScript**。仍然要知道的边界：① 输出目录**必须在 Vault 之外**（写进去会触发重扫，用户的 Vault 在同步盘里时还会被整站上传），非空目录必须先证明"是我们上次导出的"（靠 `mimenote-export.json`），且**从不删除任何文件**（变小了的 Vault 会留下旧页面，结果与索引页都点名）；② **站内没有搜索**（零 JS 的直接代价：`file://` 下浏览器禁止 `fetch()`，而 FTS5 库实测 207 MB）；③ **不做增量重导出**（每次整库重渲染）；④ 图片先写页面、后复制 ⇒ 中断会留短暂死图；⑤ 大 Vault 是**主进程分片渲染**（每批 24 篇让出主线程，进度可见、可取消）；⑥ 单个页面文件离开站点目录后样式会丢（样式是整站共享的一份，要"单文件到处能看"就用单篇导出）；⑦ PDF 走系统打印对话框，因此没有程序化的页眉页脚/页码/纸张控制，各打印驱动表现有差异；⑧ 单篇导出时图片 > 8 MiB 不内嵌（退化成占位文字，不做转码降采样）；⑨ **整库导出没有真实应用 E2E** —— 它必须经过系统目录选择框，而原生对话框无法被自动化驱动（单篇导出同理），那一段由宿主单元测试（真实文件系统）与前端 jsdom 集成测试两头夹住。
18. **标签页不恢复"每篇文档自己的未保存状态"**：`note-store` 只持有一份当前文档（自动保存流水线、冲突令牌、编辑器整篇替换的时机都绑在它上面），标签只保存路径列表。因此切标签天然是"先落盘再切"，未保存标记（●）只会出现在激活标签上。标签按 Vault 根持久化在 localStorage（`mimenote.tabs.v1`），换 Vault 会整体对账（剪掉已不存在的路径）。
19. **图片粘贴/拖入只支持图片**（ADR-0013）：非图片整批拒绝并点名文件（不做部分成功），因为"三张进了 Vault、第四张没有"的中间态更难解释；网络图片仍不支持（离线姿态不做出站请求）；SVG 在白名单里（走 `<img>`，不执行脚本），但**不做压缩/转码** —— 4K 截图按原样落盘；多光标时只在主光标处插入一次；落盘期间用户切走笔记则只落盘、不插链接（给 warn 提示）。
20. **大纲面板是"标题树"，不是可编辑的目录**：只认 ATX 标题（`# 标题`），Setext（下划线式）不算 —— 后者要判断"下一行是不是 `---`/`===`"，而 `---` 同时还是 frontmatter 与分隔线，判错会把行号带偏（跳错位置比没有条目更糟）。点击的落点随视图变化：编辑视图把光标放到那一行、阅读视图滚到第 N 个标题并高亮、图谱视图先切回编辑视图（同一个操作只给一种结果）。**"当前章节"高亮两个视图里都成立**：编辑视图取"最后一个不晚于光标行的标题"（`<=` 语义：光标落在正文里时仍属于上面那一节），光标行由编辑器在装配层**节流上报**（`features/editor/cm/setup.ts` 的 `onCursorLineChanged` → `state/cursor-store.ts`，只在**行号真的变了**时写入，否则每个按键都会让面板重渲染一次）；阅读视图取"视口顶部最后一个标题"（`features/outline/outline-scroll.ts`，passive 滚动监听 + rAF 计算 + 序号去重），**没挂预览时不猜**（没有依据就不高亮）。仍未做：**没有**了 —— 章节折叠与"只显示某几级标题"的过滤**已交付**（纯函数在 `features/outline/outline-view.ts`，面板只负责接线与样式）：级别开关**默认全亮 = 不过滤**（老用户观感不变）、按 Vault 根持久化在 `mimenote.ui.v1` 的 `outlineLevelsByVault`；折叠收起一条会隐藏其后所有更深的标题（直到同级或更浅的那条），**刻意不持久化、也不跨笔记**（下次打开要的是完整结构）。两条必须记住的约定：① **序号永远是完整标题列表的下标**，过滤/折叠只决定渲染哪几条，任何地方都不按可见列表重新编号 —— 否则"当前章节"会随着用户随手折叠而漂到别的章节上；② 当前章节被过滤掉或被收起的祖先藏起来时**不高亮到别处**，只在面板头部给一行"当前章节（第 N 行）没有显示在列表里"（`data-outline-hidden-current`），因为那才是真实方位，而过滤/折叠都是用户自己刚做的动作，替他自动撤销等于抢方向盘。
21. **阅读视图的代码块复制按钮是"渲染后挂 DOM"**（`features/preview/code-copy.ts`）：预览的 HTML 由 `dangerouslySetInnerHTML` 拥有，按钮不能进渲染管线（会被 DOMPurify 净化掉，也会让纯函数的渲染层认识 UI）。因此每次正文重渲染都会重建按钮，代价是 O(代码块数) 的 DOM 操作（几百个以内无感）；复制走 `navigator.clipboard` + `execCommand` 兜底，两条都失败时按钮显示"复制失败"而不是假装成功。
22. **窗口标题跟随当前笔记**（`features/status/window-title.ts`）：需要 `core:window:allow-set-title` 能力；拿不到能力时只记一次日志、界面不受影响。标题里不含 Vault 路径以外的信息（`笔记名 • — Mimenote`）。**没有"最近打开"或"多窗口标题区分"** —— 多窗口仍是 M4 之后的题目。
23. **`[[` 链接补全的边界**（`features/editor/cm/wiki-complete/`）：候选列表上限 50 条（页脚提示"还有 N 条，继续输入以缩小范围"），键盘导航只有 `↑↓`（没有 PageUp/Home/End）；**多光标下一律不弹**（一次确认只能改主光标）；输入法组合期间不抢按键，但组合串仍会刷新候选（刻意如此，否则中文输入时列表看起来"卡住"）；代码区间靠语法树判定，**刚粘贴几 MB 文本后光标处在未解析区时，围栏代码块里可能短暂弹一下**（行内代码有"反引号奇偶"兜底，围栏块没有 —— "向上找未闭合 ```" 是 O(行数)，与 ADR-0009 的按键路径纪律冲突，刻意不做）；弹层不订阅 store，打开着时新建笔记要等下一次按键/光标移动才出现在候选里。
24. **图谱「定位笔记」的候选来自图谱节点本身**（不是 Vault 条目表）：超过 8000 节点上限被截断掉的笔记不在候选里 —— 但它们本来也不在画布上，用条目表反而会给出"列表里选得中、画布上找不到"的落差。卡片在收起的文件夹里时会**自动展开祖先再定位**（一次性，不会每次布局变化都抢镜头）；空查询不列候选（画布只在有输入时查询）。
25. **外部改动自动同步（文件监听）的边界**（ADR-0016）：监听的是**当前打开的 Vault 根**，一个 Vault 占 4 个句柄 / 2 个线程 / 约 0.5 MB 工作集（不随文件数增长）；改动的判定是"磁盘状态 vs 条目表"，因此**同一毫秒内且字节数相同**的外部改动会漏判（与 ADR-0004 的 mtime 令牌、ADR-0014 的索引复用同一取舍）。同步盘的临时/中转文件：隐藏项（`.` 开头）、`Thumbs.db` 这类忽略名、`node_modules`/`.git` 之内一律不触发重扫；同步过来的**正常文件**（含 `xxx (冲突副本).md`）会被当成新增，这正是"同步下来了"的预期行为。网络盘 / UNC 路径下 `ReadDirectoryChangesW` 的通知完整性由对端决定（部分 NAS 不发通知），此时退化为"可能要等一次手工重扫"，不会报错。宿主端的事件可能重复、缓冲区溢出时还可能丢事件（丢的那次由下一次重扫补齐）——**监听是加速器，不是唯一真相来源**，`Ctrl+Alt+R` 的手工重扫始终有效。已知的两处不完美：① 应用**自己**改名/搬迁时被改写的那些文件（`updated_links`）会在条目表里留下旧 mtime → 换来一次多余的重扫（不弹提示、用户无感）；② 外部改动之后，**当前笔记的反链面板**要等它自己的刷新时机（切笔记/保存/图谱刷新）才更新 —— 图谱与搜索是索引驱动的，会自己跟上。

26. **搜索索引的体积与"它躺在 Vault 里"**（ADR-0008「后续修订」第 3、4 节有完整实测）：索引建在**行**上，因此一个真实的 4267 篇 / **501606 行** Vault 实测 `search.db` **207 MB**（正文文本只有 22 MB；`lines_fts` 是 external content，文本没被存两份 —— 体积来自 50 万个文档与 FTS5 默认的位置表，**不是**段膨胀：那个库里 `distinct segid` = 1）。它是**可丢弃的派生数据**（删掉即重建），所以 Vault 落在同步盘里时**建议在同步客户端排除 `.mimenote/`**，否则每次重建都会让同步客户端上传一份 200 MB 级的文件；应用侧不受影响（扫描器与文件监听都跳过 `.mimenote/`）。**段合并（`optimize`）已按实测接进增量收尾**：段数 ≥ 8 时合并一次（30 万行约 0.9 s，在后台构建线程上），实测查询 76.9 ms → 45.8 ms（1.68×，另一批次 2.2×），而文件大小**不变** —— 它买的是查询速度，不是磁盘。仍未做：`detail=none`（会牺牲短语查询）、按篇索引（要动"排名后取行号"的主线）。

27. **关系图（自我中心子图）用 canvas 画卡片，代价是有账的**（ADR-0021）：① 卡片不再是 DOM ⇒ **不能被 Tab 聚焦、文字不能被选中或浏览器查找**，补偿是宿主 `tabIndex=0` + 方向键在"同一方向上最近的卡片"间移动选中项 + `role="application"`；真要读/搜有编辑器、阅读视图与全文搜索三条路，预览面板仍是 DOM。② `graph_ego` 每次 **≈50–60 ms / 1 万笔记**（入度要按全库口径算），**连续调深度就是连续调它**，HUD 上的"刷新中"会亮。③ `truncated` 只有布尔值，**没有"还有多少篇没显示"的计数**（DTO 与 `graph_data` 逐字一致；要精确数字就得改两个命令的输出形状，而"离中心最近的一部分"这句话本身已经准确）。④ 卡片标题不折行也不补省略号（超出由卡片裁剪），图片只画占位框（canvas 里解码 `asset://` 是异步的，会把"一帧"变成"一串帧"）。⑤ 关系图里**不能拖动卡片**：位置就是"离中心几跳"，拖一下就把它变成了谎话。⑥ canvas 上提示框的强调色要靠**探针元素**读 `--mn-callout-accent`（`canvas/probe.ts`）—— app.css 把 13 种颜色写在 `var()` 的兜底位置上，`getComputedStyle` 读不到那个名字本身。⑧ **预览面板打开时方向键仍是"换选中项"**（面板没实现键盘滚动，排除掉就成了死键）—— 要滚正文用滚轮，或先 `Esc` 关掉预览。

28. **callout 的折叠语义在两侧刻意不同**（ADR-0022）：所见即所得里 `[!note]-` **真的收起**正文（光标进入即展开、点图标把 `-` ↔ `+` 写回文档），而阅读视图 / 导出件 / 静态站点里它只是一个低调的角标 —— 那些地方是"读"的场合，读者看不到被收起的内容只会以为笔记里没有这段文字。另外：未知类型会在类名里留下一个 `mn-callout--unknown` 的痕迹（类型被规范化之后"用户写的是不是系统认识的类型"就不可判定了，下游要如实说出这件事只能靠它）；`[!note]` 在语法树里其实是个 `Link` 节点（快捷引用链接的写法），被替换装饰整段接管，因此不会同时出现"链接可点"与"图标可点"两个行为。

29. **图谱的力导向与"从 wiki link 引出的连线"的边界**（ADR-0023；漂浮帧率与连线介质后经 ADR-0036 变更）：① 力场会把同心环**收紧**（默认档实测一跳 562 → 377、二跳 1124 → 672，"谁在内谁在外"保住、"半径 = 布局算出的数"不再成立；想保住半径用「舒展」档）；② 卡片内那段虚线引线**只在焦点视图**里有 —— 全库视图的卡片是紧凑卡片（没有正文位置），那里仍然从卡片边界出发；③ 匹配不到文字时降级成"从卡片边界出发"（`fromLink: false`，tooltip 说明原因），相邻同 href 的 `[[甲|A]][[甲|B]]` 会被合并成一个 run 而只能给一个锚点，自环的引线退化成一个点；④ **浮动面板不持久化**（临时阅读姿势），`Esc` 的语义是"先关最上面那个浮窗"；⑤ 漂浮现在是 **60fps**（ADR-0036：连线也画在同一张 canvas 上，"每帧一次 React 渲染"的代价没有了）。
30. **任务列表的口径与两处已知差异**（ADR-0024，观感部分见 ADR-0027）：① 判据只有 `domain/task-list.ts` 一份（GFM 口径：标记必须在段落最前面，`- **[x]** 手写` 不算），结论写在 token 上由阅读视图 / 导出件 / 应用内打印 / 静态站点 / 图谱卡片五处消费；② 复选框是**禁用的原生 `input`**（阅读视图与导出件只读，勾选要改文档 ⇒ 走编辑器），净化白名单为此单独放开 `input`，并由 DOMPurify 钩子强制「只有禁用的 checkbox 能活下来」；③ **已完成的任务画删除线**（ADR-0027 推翻了"只变暗"的旧取舍；编辑器里删除线挂在只圈文字的 mark 上，否则会把 `✓` 一起划掉）；④ 已知不一致：编辑器侧用的是 lezer 的 `Task` 节点，它的规则要求标记后面还有空格，所以 `- [x]`（空任务项）在编辑器里不是任务项而在阅读视图里是；⑤ `renderPlainText`（字数统计/摘要）不剥标记。
31. **拖拽的手感由三条实现细节共同决定**（ADR-0023「后续修订」）：① `pins` **不能**是"创建模拟"那条 effect 的依赖（否则每个 pointermove 都重建一次模拟、卡片被弹回原位）；② 命中测试与方向键导航必须用**当前**矩形（力场把环收紧约三分之二之后，按环上的原始矩形判命中会抓错卡片）；③ 交互必须能 `heat` 重新加热力场（`settle()` 之后 alpha = 0，不加热就只有硬碰撞会推人），漂浮则靠一个很小的强度底值（实测 0.2 ⇒ 每步每卡 0.12px ≈ 2.3px/秒）—— 顺带澄清：「零重叠」是**落定状态**的不变量，力全开时的中间帧可以有短暂重叠。
32. **卡片内那段引线必须画在卡片层之上**（ADR-0023「后续修订」，粗细见 ADR-0025）：卡片是不透明底画在 canvas 上、`.mn-graph__viewport` 又带 `will-change: transform` 自成层叠上下文，所以引线留在连线层里会被整段盖掉 —— 它单独成层（`.mn-graph__leads`，z-index 2）才看得见；两段的分界靠「端点逐坐标相同 + 虚线相位锚在边界端 + 两端 butt 线帽」三条保证。**粗细与不透明度的历史**：最初比卡外那段更细更淡（1px / 0.55），用户实测反馈"看不见"，现在与卡外同粗（1.6 / 0.85）—— 区分"指示"与"边本身"改由**线型（虚线）**承担，而不是靠更淡。

33. **（已被 ADR-0035 取代）停靠布局只解决"位置"**：三区停靠模型的边界记录保留备查 —— 它的"可见性归开关、位置归模型"与"每个模块恰好一次"两条不变式被切割树原样继承；`dockLayout` 落盘键仍在（回滚可读），但渲染与交互不再读它。

35. **连线走线与语义色相的边界**（ADR-0028；连线介质后经 ADR-0036 变更）：① 弧按**当前极角**实时算（漂浮时线会跟着微调，这是刻意的：形状必须跟着卡片走）；② 同环的弧**不随张力变直**（结构性走线），跨环的径向切线才吃张力滑杆；③ 跨环是"朝外鼓"的近似，不做真正的避障；④ 同一对笔记之间的多条链接仍然只画一条（`count > 1` 在悬停提示里，现在提示真的会弹出来）；⑤ **跳数权重（`EdgeStyle.width/opacity`）在 ADR-0036 之后真的生效了** —— 在 SVG 那一版里它们是表现属性、被 `graph.css` 的类规则按优先级盖掉，"越远越细越淡"从来没被看见；⑥ 色相令牌 `--mn-edge-out` / `--mn-edge-in` 是**可选**的（缺省落到 `--mn-warning` / `--mn-link`），**没有**加进 `REQUIRED_TOKENS` —— 那会让所有用户自定义主题在启动时报缺令牌。

34. **卡片尺寸与"全文"档的几个边界**（ADR-0025）：① 手柄拖动同时改宽与高（`setCardSize`），而单独"改宽度"仍会把高度上限重置成自动（那是另一条路，两者互不抹掉）；② 「全文」= `maxHeight: Infinity`，与数值档互斥；③ 卡片尺寸按 Vault 落盘，且**加载子图时也会补上 Vault 根**（回归：从前只有全库视图的 `load()` 写 `rootPath`，于是默认入口是关系图时卡片尺寸从来没被保存过）；④ 悬停高亮只对"有对应边"的链接生效，指向图外的链接不伪装成可悬停；⑤ 「仅标题」档下正文与引线一起消失（没有正文就没有可指的文字）。

36. **标题栏三区的边界**（ADR-0029；中区的内容后又经 ADR-0034/0035 两次替换）：① 标题栏带 `user-select: none`（它同时是拖动区）；② "我在看什么"（当前笔记/附件路径）在**状态栏最左**（ADR-0034），标题栏中区现在是**纯拖动区**（ADR-0035：标签进了各自的格子）；③ 状态栏路径表达的是"**最后打开的那一篇**"（与窗口标题同一口径），全库图谱视图下它与画布中心不是一回事 —— 只有关系图的圆心才等于当前笔记；④ 三区内容**不可配置**，想往里加东西仍然是改 `App.tsx`。

38. **设计令牌与默认字号的边界**（ADR-0031）：① VI 别名层是**单向**的 —— 写 `--bg-base` 不会影响 `--mn-bg`，主题作者改值仍然改主题 JSON；② 默认字号的真值在设置层 `DEFAULT_SETTINGS`（`font-overrides` 以行内变量 + `!important` 写进 `<html>`，压过主题 JSON 与 `:root`），**老用户读自己存下来的值**，升级不会被动变字号，要统一得点设置页的「恢复默认字号」；③ 界面里仍有一批 **10–13px 的硬编码小字**（状态栏 12px、角标 10px 等）不跟基础字号长，"统一 16"目前只覆盖基础层，收敛到 `--space-*` / `--font-size-*` 是单独一轮；④ VI 建议的顶栏 40 / 标签栏 32 / 状态栏 24 与现状 34/36/26 仍不一致（改高度要动 E2E 布局不变式与 ADR-0017/0029 的 34px 契约）；⑤ `--font-reading` / `--font-editor` 默认回落 UI 字体 —— 阅读衬线与编辑等宽**没有**采纳（中文字体缺失会掉到宋体回退，且编辑等宽与 ADR-0009 冲突）。
44. **"打开笔记 = 顶掉当前那条标签"的边界**（ADR-0037）：① 多标签没有被删掉，但默认不再堆积 —— 要两条以上得走文件树上的 `Ctrl/⌘+点击` 或中键（也能把标签拖到别的格子）；② 被顶掉的那条不再留在列表里（"刚才那篇去哪儿了"靠「在文件树中定位」或历史记录），未保存内容不会丢（切换前先落盘）；③ 只有**冲突态**才会弹确认 —— 给"边打字边点文件树"也弹一个"会丢修改"的确认是假话；④ 中键与修饰键是**隐式**入口（行上没有提示文字），真嫌不好发现就得在行右键菜单里加一项「在新标签中打开」，没有做；⑤ 快速切换 / 全文搜索 / wikilink / 标签面板打开的都算"替换"，只有文件树给了新标签入口（那些入口的语义本来就是"跳到那篇"）。
43. **连线搬进 canvas 的边界**（ADR-0036）：① **"直接给 `.mn-graph-edge` 写 CSS" 这条路没有了** —— canvas 不认识选择器；颜色仍然只有一份来源（主题令牌，画笔读的是**计算值**），所以主题与用户 CSS 片段改令牌依然生效；② 连线的形状与状态只认 `PaintedEdge` 那份记录（`key / layer / commands / shape / dashed / highlight / dim / hue / phantom / label / title`）—— 改它等于改"自动化能看到什么"；③ 弧是**每 90° 一段三次贝塞尔**的逼近（误差约 2/10000 半径），不做真正的圆弧绘制；④ 路径解析只认 M/L/C/A 的**绝对坐标**，几何层换了写法（比如用相对命令）会**当场抛错**而不是画歪；⑤ 悬停容差是 5 **屏幕**像素（换算成世界单位时除以缩放），离线超过这个距离就没有提示 —— 密图里两根线挨得很近时，取的是更近的那条；⑥ 连线仍是 `aria-hidden`（这一点与 SVG 版一样），提示不进 tab 序。
42. **容器切割树的边界**（ADR-0035，模型与渲染器都已交付）：① 迁移期两套落盘格式并存（`mimenote.ui.v1` 的 `dockLayout` 与 `mimenote.tabs.v1`），新格式是 `layout`，旧键保留作回滚；② 模型不判"标签还存不存在"（删掉的笔记 / 关掉的模块由上层对账，`isKnownItem` 钩子）；③ 比例夹紧意味着"拖到 0"实际落在 0.15，拖回来时起点不是 0；④ **同一篇笔记不能左右对照编辑**（不变式 1 的直接后果：非当前笔记的格子是只读预览，要支持得先做多文档模型）；⑤ `note:` 前缀占用标签命名空间，加视图模块时要看一眼；⑥ 只读预览不补图（图片占位态）；⑦ 主叶允许为空（笔记的默认落点 + "主区永远存在"），被拖空后留在原地而不是塌缩；⑧ `Alt+↑/↓` 无对应动作（标签条都是横排的）。

41. **顶行合并的边界**（ADR-0034；中区后随 ADR-0035 回归纯拖动区）：① 品牌/库名与统计/导出共用一条 36px 的带子，窄窗口下先走省略号；② 路径的可发现性下降 —— 它在状态栏左侧，"完整相对路径"要低头看；③ 应用层 E2E 需要 `tauri build --no-bundle` 重建后重跑（它跑的是打包进二进制的旧前端）；④ "全窗口唯一那条标签栏"已随容器切割树退役（每格一条标签条）。

40. **图标尺寸的边界**（ADR-0033）：① 刻度只有五档（12/14/16/20/24），遇到"确实想要 18px"没有位置 —— 要么归 `md`、要么归 `lg`，成体系的新尺寸必须先加档并记账；② 收敛带来一次 ±1~2px 的观感位移（11→12、13→12、15→16、18→20、22→20、26→24），没有逐屏对比；③ 内联 `<svg>` 自己写宽高的地方（如 `WindowControls` 的三个 10×10 窗口按钮）不在刻度内 —— 那是"图形"不是图标网格的一部分；④ 闸在单测里（`pnpm test` 才红），"写的时候就红"只有类型那一半，不引 ESLint 自定义规则。

39. **附件只读查看器的边界**（ADR-0032）：① 打开附件**只读**、不进标签页、不写盘 —— 编辑仍然只发生在 Markdown 上；② 图片**单张 8 MiB 一档**的上限里，超限与越界目前都归到"没能拿到读取授权"这一句说明上（要区分得让宿主把原因带回来，**待做**）；③ 浏览器预览与 jsdom 里没有 `asset:` 协议，只显示说明，真实渲染由**应用层 E2E** 把守（`naturalWidth > 0`）；④ 查看器刻意克制：不旋转、不平移、多图不翻页（灯箱才有），也没有"用系统程序打开"这条出口；⑤ 目前有**图片**与**纯文本**两类（`.txt/.log/.json/.csv/.toml/.yaml/源码…` 走等宽纯文本查看器，扩展名白名单在 `domain/viewable.ts` —— 二进制不按文本打开）；⑥ `note_read` 宿主侧**不限扩展名**（只做路径防护、拒目录、限大小），所以文本类预览**没有新增任何 IPC**；⑦ 结构化查看器（JSON 折叠树 / CSV 表格 / frontmatter 属性面板）与"编辑非 Markdown 文件"（第二条写路径）仍待做。
37. **界面不写 `.md` 的边界**（ADR-0030）：① 判据只有 `domain/paths.ts` 的 `displayName` / `displayPath` 一份（建在既有的 `isMarkdown` 上），**调用方不许自己 `replace`**；② 只在"这是哪一篇"的**标识显示**上生效 —— 导出件与静态站点（外部产物）、宿主错误消息原文、路径编辑/预览类对话框（移动对话框的"将移动到："）保留真实文件名；③ 悬停 `title` 与 `data-note-path` / `data-tab-path` / `data-rel-path` 一律给**真实路径**（自动化认身份不再读可见文字，顺带修掉 `includes('项目/设计')` 会被 `项目/设计文档` 误命中的隐患）；④ 快速切换与图谱「定位笔记」的**匹配**也跑在显示串上（否则高亮下标会落到被藏起来的三个字符上），因此 `Ctrl+P` 里搜 `.md` 不再命中；⑤ 文件树的**过滤框**仍按真实文件名匹配（匹配面是显示面的超集，宁可多匹配）；⑥ `.md` 之外的扩展名一律保留（`图.png` 去掉扩展名就认不出是什么文件）。

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
