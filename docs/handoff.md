# 交接说明：下一个会话从这里开始

> 这份文件是**临时**的会话交接，不是产品文档。新会话接手顺利之后可以直接删掉它。
> 最后更新：ADR-0055 ~ 0059（键位与配置 / 模板语法 / 收件箱 / 分栏文件树 / 搜索质量）交付之后。

## 0. 最近一轮：键位与配置 · 模板语法 · 收件箱 · 分栏文件树 · 搜索质量

四条战线并行（各自先写设计再写代码），ADR 0055 ~ 0059：

| ADR | 内容 | 设计文档 |
| --- | --- | --- |
| [0055](adr/0055-keymap-and-config-file.md) | 键位解析链（**用户覆盖 → 档案 → 默认表**）+ Vault 配置文件（`.mimenote/config.toml\|yaml\|json` 三格式同构）+ 行内格式化命令（`Mod+B/I/K` 等） | [design/01](design/01-keymap-and-config.md) |
| [0056](adr/0056-template-syntax.md) | **MimeNote 模板语法 `@`**（无结束符、否定式边界、12 个内建变量、模板展开 + 编辑器内联补全共用一份判据） | [design/02](design/02-template-syntax.md) |
| [0057](adr/0057-inbox.md) | **收件箱**（独立目录、默认单篇时间戳笔记、状态即位置、归档走既有移动链路） | [design/03](design/03-inbox.md) |
| [0058](adr/0058-miller-columns.md) | **苹果式分栏文件树**（Miller columns）+ 单栏 ⇄ 分栏（`Mod+Alt+C`，默认单栏） | [design/04](design/04-miller-columns.md) |
| [0059](adr/0059-search-quality.md) | **搜索质量**（每篇命中上限 5、按需 COUNT、逐词高亮 + `settledQuery`；不动 schema） | [design/05](design/05-search.md) |

**键位表的净变化（`Mod+B` 归还给"加粗"）**：命令面板 `Mod+K` → `Mod+Shift+P`；插入链接占 `Mod+K`；
打开 Vault `Mod+O` → `Mod+Alt+O`；侧栏 `Mod+B` → `Mod+Shift+B`；导出 PDF `Mod+Shift+P` → `Mod+Alt+P`
（它与新命令面板撞了 —— 是 `tests/keymap-defaults.test.tsx` 的**结构性**冲突判据抓出来的）；
新增 `Mod+Shift+N` 从模板新建、`Mod+Shift+I` 捕获、`Mod+Alt+I` 收件箱、`Mod+Alt+C` 单栏/分栏、`Mod+Alt+N` 行号。

**本轮收尾时的实测数字**：

```
pnpm typecheck                ✓ 无错误
pnpm test                     ✓ 127 个测试文件 / 2222 条
cargo test --workspace        ✓ mn-core 219 · mn-index 174+10 · mimenote 193 · cli 6（0 失败）
pnpm check:version / check:ipc ✓ 0.3.0 一致；43 条命令三方一致
cargo clippy -D warnings      ✓ 干净
pnpm build                    ✓ 2.4s（index 1787 kB —— 超 1100 kB 警告线，见下）
```

**没跑**：`pnpm test:e2e:ui` / `test:e2e:app`（下一阶段；app 侧要先 `tauri build --no-bundle`）。

**留给下一阶段的两件事**：
1. **E2E 键位残留**已同步（`e2e/ui.e2e.test.ts` 与 `real-app.e2e.test.ts` 里 `Control+k` → `Control+Shift+p`、
   `Control+b` → `Control+Shift+b`），但**没有跑过**；应用层 E2E 还要覆盖"收件箱目录不存在时的第一次捕获"
   （真实宿主 `note_create` 要求父目录已存在，Mock 会自动补 —— inbox 队友已用"先建在根再 move"兜住）。
2. **包体**：`dist/assets/index-*.js` 1787 kB（vite 配置里的注释还写着"约 950KB"）。这是几轮累积的结果，
   与 ADR-0001 的冷启动预算直接相关 —— 建议在 M5 一起量：要么分包、要么把大文档预览那条链路再推迟加载。

## 0.5 上一轮：每格一个文档（ADR-0054）

用户原话三条：**"分栏里每个栏目都可以编辑"**、**"属性面板的显示和隐藏是鼠标悬浮过去才出现，
功能面板隐藏需要功能面板进行"**、**"图标没对齐！细节问题"**。

`note-store` 从"当前文档"升级成**文档仓库**（`docs` + `activePath`；`doc`/`dirty`/`status`/
`conflict`/… 成为 `docs[activePath]` 的**派生镜像**，旧 API 一字不改），于是：
**每格都能编辑与自动保存**（每篇各有防抖定时器、冲突态与 `(mtime,size)` 令牌）、
**每格一个属性面板**、每格自己的笔记路径进 CodeMirror facet（图片解析 / `[[` 候选排序 /
**粘贴附件的相对路径**）、出链按路径缓存、脏标记与关标签确认按篇。
细节三修 + 两个顺带发现的真 bug 见 [ADR-0054](adr/0054-per-pane-documents.md)。

**本轮的实测数字（收尾时跑的）**：

```
pnpm typecheck                  ✓ 无错误
pnpm test                       ✓ 113 个测试文件 / 1933 条
pnpm test:e2e:ui                ✓ 74 条（ui.e2e 69 + properties-layout 4 + split-panes 1）
```

没有动 Rust（`cargo test` / `clippy` / `fmt` 与上一轮相同）；**`pnpm test:e2e:app` 本轮没跑** ——
它要求先 `tauri build --no-bundle` 重建 release 二进制（前端改了它就跑旧前端）。

### 两处"看代码看不出来"的坑（都已被用例钉住）

1. **`open()` 对"已在仓库里且干净"的那篇必须重新读盘**。我一开始为了"别吃掉别格里的编辑"
   改成"已在仓库就只切当前"，结果 `ui.e2e.test.ts` 的"重命名笔记…并验证可逆"红了：
   重命名会**外部改写别的笔记**（改指向它的链接），而阅读视图渲染的是**内存正文** ——
   不重读就永远显示旧链接。正确口径：**干净 → 重读；脏/冲突 → 只切当前**。
2. **`reconcileLayout` 的 `notes: []` 与"名单未知"是两件事**。`installTabsSync` 挂载时的
   第一次对账发生在 `tabs-store` 装载之前，传 `[]` 会把树上所有笔记标签剪掉，再由
   `syncFromNote` 挂回**主叶末尾** —— 也就是"每次启动把非主叶的笔记搬回主叶"。
   现在 `notes` 可选（`undefined` = 别动笔记标签），判据是 `restoredRoot === 当前 Vault 根`。

> 验证这类改动的**唯一可靠办法**：`git worktree add` 一份 HEAD + 把 `node_modules`
> 做成 junction，用 `node ./node_modules/vite/bin/vite.js build` 与
> `node ./node_modules/vitest/vitest.mjs run -c vitest.e2e.config.ts e2e/ui.e2e.test.ts`
> 跑基线（pnpm 在 worktree 里会试图 install 而失败）。本轮就是靠它把 31 条失败判定成
> "我引入的回归"而不是"本来就红"。

## 0. 一句话现状

`main` 的上一个提交是 `feat(okf): frontmatter一层映射+合规检查+CLI起步，属性表结构化展示`
（ADR-0047 第一批）。**它之后的一大批工作曾经只躺在工作树里、没有提交**，而且里面混着几条
真实回归：把画布图谱整块换成朴素 SVG 节点网络（未记录、留下 20 个孤儿模块）、编辑器字号与
阅读字号互相改写、阅读视图变成可写的属性面板、分栏编辑器在焦点归位时把刚打开的笔记顶回去。

**本轮把这些全部收口**：撤销图谱降级、修掉四条回归、给两条新纯逻辑模块补上单测、
补 ADR-0048 ~ 0051 与 README / architecture / milestones / dependencies 的同步。

```
pnpm typecheck                 ✓ 无错误
pnpm test                      ✓ 110 个测试文件 / 1873 条
cargo test --workspace         ✓ mn-core 203 单元 + 18 集成 / mn-index 169 + 10 / mimenote 177 / cli 6
cargo clippy --workspace --all-targets -- -D warnings   ✓
cargo fmt --all -- --check     ✓
pnpm check:ipc / check:version ✓
pnpm build                     ✓
pnpm test:e2e:ui               ✓ 69 条
pnpm test:e2e:app              ✓ 34 条（release 二进制已重建 —— 前端变了它跑的就是旧前端）
```

上面九个数字都是本轮收尾时实测的。

## 1. 这一轮交付了什么

| ADR | 交付 |
| --- | --- |
| [0047](adr/0047-okf-and-hugo.md) | OKF 原生支持（frontmatter 一层映射 `Map`/`MapList`）、`mn-core::okf` 合规检查、`apps/cli` 的 `okf check`（红线：HTML 渲染永不进 CLI）；**第二批也已交付**：站点导出的 Hugo `draft`（计划层跳过）与 `slug`/`url`（覆盖输出路径 + 越界拒绝），判据只有 `domain/site-frontmatter.ts` 一份，见该 ADR 的「后续修订」 |
| [0048](adr/0048-property-editing.md) | **属性编辑**：`FrontmatterEditor` 挂在编辑器上方，改写走 CodeMirror 文档（没有第二条写路径）；`---`/`+++`/`;;;` 三种围栏；含注释的 TOML 拒绝改写；阅读视图仍然只读 |
| [0049](adr/0049-per-pane-editors.md) | **一格一个编辑器**（修订 ADR-0035）：非当前文档那格是只读编辑器；「变成当前」由**点正文**触发；文件树里的笔记/附件可拖进分栏 |
| [0050](adr/0050-inline-tags.md) | **行内 `#标签` 高亮**：判据只有 `domain/inline-tags.ts` 一份，编辑器与阅读视图两处消费 |
| [0051](adr/0051-ui-walkthrough-batch.md) | **UI 走查批**：品牌资产、文件树工具栏收敛成"视图与库"、最近 Vault 弹层、设置窗口紧凑居中；附"没有采纳：把图谱换成朴素节点网络" |

## 2. 本轮修掉的回归（都是真实用户可见的）

1. **图谱被降级又被撤销**：工作树里曾有一版自研 SVG 节点网络（`GraphCanvas.tsx` 2704 → 112 行），
   把力场/卡片/HUD/连线/浮窗一并删掉，还删了 `graph.test.tsx` 的近 2100 行。它与
   ADR-0021/0023/0025/0028/0035/0036 六份已交付决策冲突、留下 20 个孤儿模块与 2 份孤儿样式表
   （`tests/stylesheets.test.ts` 的纪律本来就会红）。**已 `git checkout HEAD` 恢复**，
   删除 `network-layout.ts` / `network.css`。→ ADR-0051 附节。
2. **字号耦合**：`setEditorFontSize` 顺手把 `readingFontSize` 也写了（反向同理），且
   `.mn-preview__body` 的 `font-size` 从 `var(--mn-font-size-reading, …)` 改成只用编辑器字号 ——
   设置页的「阅读视图字号」整项失效。**已恢复**（设置层两处 + `app.css` + 用例的断言）。
3. **阅读视图变成可写**：预览顶部的属性块从只读 `PropertiesTable` 换成了 `FrontmatterEditor`
   （可以增删改属性）。与"阅读视图是只读的"（任务复选框那条纪律）冲突，`properties-table.test.tsx`
   也因此失败。**预览已恢复只读**；属性编辑留在编辑器上方（那才是 Obsidian 的形态）。
4. **分栏编辑器的焦点自激活**（`line-jump.test.tsx` 失败的真实原因）：`MarkdownEditor` 把
   "把这一格变成当前"挂在 `onFocusChanged` 上，而搜索面板关闭会把焦点还给**上一篇**笔记的编辑器，
   那一刻 React 还没把 `notePath` 换成新文档 ⇒ 旧路径把自己重新激活，**刚跳过去的笔记 112ms 后被打回**
   （实测时间线：1003ms 打开「设计」→ 1115ms 退回「路线图」）。**改成由格子内容的 `onPointerDownCapture`
   触发**，并给 `caret-memory` 加了"这一格已有焦点就别用旧快照覆盖"。
5. **属性下拉会遍历全库问宿主**：`PropertySelect` 原来为"单选"类型对 Vault 里**每一篇**笔记调
   `note_tags`（4267 篇的真实 Vault = 4267 次 IPC，宿主每次都要读盘解析 frontmatter），
   而注释写的"宿主已有的属性索引"根本不存在。**改成有界候选**（本篇当前值 + 这个属性用过的值，
   落 localStorage，上限 50），并补了"打开面板零 IPC"的回归用例。
6. **TOML 注释判据不认引号**：`/(^|\n)\s*#|\s+#/` 会把 `title = "C # 教程"` 判成"含注释"，
   于是完全没有注释的区块也被赶去源码里改（YAML 同名值却没事）。**判据收敛成
   `tomlHasComment()` 一份**（先把字符串字面量抠掉再看 `#`），四处调用点（含 `FrontmatterEditor`
   里那份重复的正则）统一用它。
7. **两处小口径不一致**：① YAML 的顶层 `null` 被 `toJS() ?? {}` 当成空属性，JSON 分支却抛错 ——
   现在按 `contents === null`（空文档 / 只有注释）与显式 `null` 分开，三种格式一致；
   ② `inlineTagSpans` 的标题守卫没有按行判（整段文本里有一行标题，其它行的标签也一起消失）——
   现在逐行判、偏移量相对整段文本。
8. **附件查看器被"每格一个编辑器"挤掉**（UI E2E 抓到）：`LeafContent` 在编辑视图下对**任何**
   笔记都直接渲染 `MarkdownEditor`，于是"当前文档那一格"再也不走 `MainViews` ——
   点文件树里的图片/`.txt` 不再显示查看器（ADR-0032）。修法：**当前文档那一格先交给
   `MainViews`**，"一格一个编辑器"只针对非当前文档那些格子。这也是"E2E 是唯一能抓住
   这一类的层"的又一例（jsdom 里的组件测试当时全绿）。
9. **导出按钮先撤后补**：走查时把「新建/重命名/移动/**导出**」一起从工具栏撤掉，而
   `导出` 是**三选一导出对话框的唯一入口**（命令面板里的 `export.*` 是直达）——
   撤掉之后那张对话框（含"索引还在构建，所以整库导出灰着"的解释）再也打不开，
   UI E2E 的"整库导出静态站点"用例当场失败。**已补回工具栏**；撤出的三条文档操作
   本来就有等价入口（右键菜单 / `Ctrl+N`·`F2`·`F6` / 命令面板）。
   教训：撤一个可见入口前先问"它是不是某条能力的**唯一**入口"。
10. **编辑器被改成"整页滚动"**（app.css）：`.mn-editor { overflow: auto }` +
    `.cm-editor { height: auto }` + `.cm-scroller { overflow: visible }`。看着只是滚动条位置，
   实际同时坏两件事 —— ① `EditorView.scrollIntoView`（搜索命中/大纲跳转的"滚到视口正中"）
    作用在 `.cm-scroller` 上，它一 `overflow: visible` 就无处可滚，应用层 E2E 的
    "命中行落在视口中部"直接超时；② CM 的视口窗口化按 scroller 的可视高度算，
    高度等于全文时会把**所有行**都渲染出来（ADR-0020 那笔账）。**已恢复**标准结构，
    只保留 `.cm-content` 的 852px 居中（那一条与阅读视图同宽，是想要的）。
11. **frontmatter 折叠让一条 E2E 断言失去可观测面**：标签面板那条用例原来读
    `.cm-content` 的文本来确认"编辑器内存与磁盘对齐"，而 ADR-0048 之后 frontmatter
    在编辑器里默认折叠、原始区块不在 DOM 里。**用例改成先点一次「编辑源码」再读**
    （顺便把折叠的可逆性也走了一遍）。这类"能力没坏、但抓手没了"的失配要当成
    真问题处理 —— 直接删断言等于把"自动保存会不会把刚写的标签覆盖掉"这条保护丢掉。
12. **悬停预览的子代理一度被判死、实际还活着**：它交付 486 行实现 + 700 余行用例的过程很长
    （中途我自己跑它的用例看到 **7 条红**，其中两条是真的缺口：滚动/重排不重新定位、
    `mouseleave(relatedTarget = 卡片)` 那条宽限路径没实现），于是我**整批删掉过一次**
    （`features/editor/cm/wiki-hover/**`、`tests/wiki-hover.test.tsx`、`cm/setup.ts` 回 HEAD）。
    它随后把文件又写了回来并收敛到 **21/22**；最后一条（"停在链接上不动：延迟一到就弹"）
    的真实原因是**测试自己在用固定 sleep**（`waitForCard()` 原来是"睡 370ms"），
    单独跑全绿、整文件跑必红 —— 改成**轮询到出现**、并给负例单独一个 `waitPastDelay()`
    之后 22/22 全绿（`waitForArticle` 早就因为同一个原因改过，这一处漏了）。
    教训两条：① **子代理"很久没写文件"不等于死了**（它在跑测试或写文档），
    回退别人正在写的工作树之前先看 mtime 与它自己的交付节奏；
    ② 测试里的**固定 sleep 是假红的最大来源**，判据是"等到条件成立"就用轮询。

## 3. 下一轮可以做的（按价值排序）

1. **`okf index` 生成器**（ADR-0047 的下一批，本批只读不写）：按 OKF v0.2 §6 生成 `index.md`。
2. **把"不导出"标记下沉到索引**：站点导出目前是"计划由索引算、草稿在导出层摘掉"，
   于是指向草稿的链接会变成死链（ADR-0047「后续修订」4.5 记了这条代价）。
3. ~~连线那三件"更优雅的线"~~ —— **前两件已交付**（ADR-0052：渐细笔触取代箭头、
   同一对笔记的多条链接画成平行束）；**仍未做**：真正的避障布线（现在跨环还是"朝外鼓"的近似）。
4. 用户早前提过、本轮补齐了两件：**回收站永久删除 / 清空**（ADR-0018 的「后续修订」：
   `trash_delete` / `trash_empty`，台账逐条重校验、先删文件后台账）与
   编辑器里 `[[链接]]` 的 **Obsidian 式悬停预览**（ADR-0053：判据读装饰层的
   `data-mn-wikilink` + `links-store` 的出链，卡片复用 `StaticNotePreview`，
   延迟 220ms + 宽限 120ms）。
   仍未做：**标签面板拖拽成树**、**静态站点站内搜索与增量重导出**、
   **大文档预览的分块 + 视口窗口化**（ADR-0020 的收尾）。
5. 图谱卡片：卡片内搜索高亮；切割树收尾：只读预览补图、`Alt+↑/↓`、
   **同一篇笔记的左右对照编辑**（ADR-0054 已经交付了**多文档仓库**，所以"不同篇同时可写"
   已经不缺；缺的是"**同一篇**的两份视图 + 两套光标"—— 它撞 ADR-0035 不变式 1
   "每个标签全树恰好出现一次"，要单独设计）。
6. M4 插件系统的剩余部分（动态加载、Worker 隔离、四类 API、设置页插件分区）。

## 4. 工程约定与红线（新会话务必遵守）

- **注释与文档一律中文，注释解释"为什么"**（取舍、代价、踩过的坑），不复述代码在做什么。
- **提交由主会话做**：派出去的子代理**绝不执行 git 写操作**，只允许 `status`/`log`/`diff` 这类只读命令。
  每个交付项 = feature commit + docs-sync commit；ADR 放 `docs/adr/`，**下一个编号是 0060**
  （0055 键位与三格式配置、0056 模板语法、0057 收件箱、0058 分栏文件树、0059 搜索质量已占用）。
- **`examples/demo-vault/` 是用户自己的草稿区**：不要动、不要提交里面的文件（包括**已被跟踪但被改过**的
  那两篇 —— 用户在里面手动试语法，`updated:` 时间戳是应用自己盖的章）。
- **判据只有一份**（改一处必须同时改另一处时才允许两份，且两边都要有用例）：
  callout `domain/callouts.ts`、任务列表 `domain/task-list.ts`、frontmatter 展示 `domain/frontmatter.ts`、
  **frontmatter 编辑 `domain/frontmatter-edit.ts`**、**行内标签 `domain/inline-tags.ts`**、
  **键位解析 `domain/keymap.ts`**（默认表 + 档案 + 用户覆盖；`app/commands.ts` 只提供注入点，
  键盘原语也在这一个文件里）、**配置文件的格式判据 `domain/config-file.ts`**
  （解析/序列化/注释检测；字段与默认值只在 `state/settings-store.ts` —— **它是配置文件的唯一写者**）、
  **模板记号 `domain/template/scan.ts`**（编辑器补全与模板展开共用）、
  **收件箱条目判定 `domain/inbox.ts`**、**分栏列模型 `domain/columns.ts`**、
  文件树排序 `domain/tree.ts`、布局模型 `features/layout/tree-layout.ts`、落点几何 `features/layout/drop-target.ts`、
  键盘等价物 `features/layout/tree-keys.ts`、连线形状 `features/graph/edge-routing.ts`、
  连线的样式与画法 `features/graph/canvas/edge-paint.ts`、路径语法 `canvas/edge-path.ts`。
  **宿主与前端各有一份 frontmatter 解析**（Rust 为索引/链接改写、TS 为属性编辑）：口径必须一致，
  两边的用例钉的是同一批边界（`+++`/`;;;`、BOM、CRLF、未闭合）。
- **数字要同步**：用例数写在 `README.md`（质量门禁表 + E2E 覆盖段），功能描述写在 README 的功能表 +
  `docs/architecture.md`（§2 模块表、§4 ADR 表、§8 边界清单）+ `docs/milestones.md`。
- **验证顺序**：`pnpm typecheck` + 目标 vitest → `pnpm test`（含 `cargo test --workspace`）
  → `cargo clippy` + `cargo fmt --all -- --check` → 动了前端就 `pnpm build` + `pnpm test:e2e:ui`
  → 动了 Rust 或要跑应用层 E2E 才 `tauri build --no-bundle`（约 3–4 分钟）+ `pnpm test:e2e:app`。
- **这台机器上 `apps/desktop/src/**` 与 `README.md` 常被别的进程（Vite watch / VS Code）短暂占用**：
  `edit` 工具会报 `ReplaceFileW EIO (Win32 32/1175)`。**原样重试一次通常就过了**。
- **改测试文件时先确认括号配平**：清完大段代码后跑一次 `pnpm typecheck` 与该文件的最小 vitest，
  比事后猜快得多。
- **批量脚本**：别用 PowerShell 内联的 `node -e`（中文引号/反引号会被吃掉），写一个 `.mjs` 再跑。
- **子代理可用但要给足上下文**：本轮两个子代理都完成了任务（一个补了 49 条单测并**报出 3 个真 bug**，
  一个做站点导出的 Hugo 支持）。派活的要点：写清允许改哪些文件、禁止 git 写操作、
  只跑目标测试（不要跑整套，会和主会话抢机器）、要求报告里贴命令原文结尾。

## 5. 环境事实

- 真实 Vault：`C:\Users\hencter\Nutstore\1\Note`（4267 篇 `.md`，同步盘；建议排除 `.mimenote/`）。
- GUI：DSH Web（地址见会话开头的运行环境）。`target/release/mimenote.exe` 一旦前端有改动就要重建，
  否则应用层 E2E 跑的是旧前端。
- 图谱的 DOM 诊断属性（自动化唯一的抓手，别乱删）：`data-graph-mode / depth / scale / offset-x /
  offset-y / canvas-cards / painted-cards / root-rect / card-rects / pinned / overlaps / selected`；
  连线那一组见 ADR-0036 的对照表；力度面板的 `[data-force-param] / [data-force-value] /
  [data-force-preset] / [data-force-action]`；切割树的 `data-leaf-id / data-leaf-tabs / data-tab-path /
  data-module-tab / data-split-id / data-axis / data-drop-hint / data-main-path`（状态栏最左）；
  **编辑器实例的身份是 `data-note-path`**（ADR-0049 起多编辑器同屏，别再假设"页面里只有一个 `.cm-editor`"）。
- 测试骨架可以抄现成的：`tests/graph-edge-paint.test.ts`（记录型假上下文 + 手算期望值）、
  `tests/graph.test.tsx`（画布 + 记录型画布 + 指针派发）、`tests/tree-host.test.tsx`（树渲染 +
  假 DataTransfer + 矩形 mock）、`tests/frontmatter-edit.test.ts`（保真类断言全用整段 `toBe`）。
- **jsdom 的 DragEvent 不带 clientX/clientY**：落点几何的测试要改用
  `new MouseEvent('dragover', { clientX, clientY })` + `Object.defineProperty(event, 'dataTransfer', …)`。

## 6. 关键文件地图（本轮新增/变动）

**ADR-0054（每格一个文档）这一轮**：

- `apps/desktop/src/state/note-store.ts`：**文档仓库**。`docs` + `activePath` + 派生镜像；
  **唯一写入点 `commit()`**，它的返回三态（路径 / `null` 清空 / `undefined` 不改）必须分清 ——
  `null` 被 `??` 吞掉过一次，"关闭当前文档"从此关不掉；
- `apps/desktop/src/features/editor/cm/note-path.ts`：`notePathFacet` + `notePathOf(view)`
  （"这一格在显示哪一篇"，facet 空时退回当前文档）；
- `apps/desktop/src/state/links-store.ts`：`outboundByPath` / `ensureOutbound` / `outboundFor`
  （按路径的出链缓存；`null` = 未知，点击侧**不许**凭未知去新建笔记）；
- `apps/desktop/src/features/layout/TreeHost.tsx` 的 `LeafContent`：**两条分支元素形状一致**
  （否则激活一格会重建编辑器）；`MainViews` 现在只服务"空的主叶"；
- `apps/desktop/src/features/layout/layout-sync.ts` 的 `ReconcileInput.notes`：**可选**
  （`undefined` = 名单未知，别动笔记标签）；
- `apps/desktop/e2e/properties-layout.e2e.test.ts`（属性区排版：图标对齐 / 悬浮显隐 /
  切回自动展开 / 面板自带隐藏入口）与 `apps/desktop/e2e/split-panes.e2e.test.ts`
  （分栏两格各自可写、互不串、脏标记与落盘）；
- `apps/desktop/tests/note-repository.test.ts`：仓库模型的单测（含"干净要重读 / 脏了不重读"）。

**上一轮（ADR-0047 ~ 0051）**：

- `apps/desktop/src/domain/frontmatter-edit.ts`：三种围栏的解析与改写（判据一份，含 `tomlHasComment`）。
- `apps/desktop/src/features/editor/FrontmatterEditor.tsx`（+ `PropertyInput.tsx` / `PropertySelect.tsx`）
  与 `cm/metadata-fold.ts`：属性面板与编辑器里的折叠。
- `apps/desktop/src/domain/inline-tags.ts`：行内标签区间（编辑器装饰与阅读视图共用）。
- `apps/desktop/src/features/editor/MarkdownEditor.tsx`：`notePath` 可选参数 = 一格一个编辑器；
  `data-note-path` 是身份；**不要**把"变成当前"挂到 focus 上（§2.4）。
- `apps/desktop/src/features/layout/TreeHost.tsx` 的 `LeafContent`：按 `viewMode` 与 `isMarkdown`
  分派（只读编辑器 / 附件查看器 / 主视图），`onPointerDownCapture` 触发激活。
- `crates/mn-core/src/frontmatter/formats.rs`：`+++` / `;;;` 的宿主侧解析与写回（TOML 走 `toml_edit`）。
- `apps/cli/src/main.rs`：`okf check`；**HTML 渲染永不进 CLI**。
- **可见文字不再承载身份**：标签/状态栏路径上都带 `data-tab-path` / `data-main-path`（真实路径），
  两层 E2E 认身份读它们，**别改回读 `textContent`**。

## 7. 用户这一轮的原话

> 继续完成当前项目，自行补全自行完善当前项目

> 不合理的地方你需要直接开始改动！

（"不合理"在本轮被落实成 §2 那七条 —— 判断依据是**与该仓库自己的文档/ADR 冲突、
留下孤儿代码、或让既有用例失败**，不是主观好恶。）
