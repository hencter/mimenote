# 交接说明：下一个会话从这里开始

> 这份文件是**临时**的会话交接，不是产品文档。新会话接手顺利之后可以直接删掉它。
> 最后更新：进入"用户逐条提需求、主会话逐条交付"的修补轮之后（第一项 = 标题栏三区，ADR-0029）。

## 0. 一句话现状

13 条需求那一轮与连线重做都已交付；现在是**用户逐条提、主会话逐条做**的修补轮，
已交付 **标题栏三区（ADR-0029）**与**界面不写 `.md`（ADR-0030）**，门禁全绿。

```
pnpm typecheck                 ✓ 无错误
pnpm test                      ✓ 87 个测试文件 / 1601 条
pnpm test:e2e:ui               ✓ 63 条（前置：先 pnpm build）
pnpm test:e2e:app              ✓ 34 条（前置：先 tauri build --no-bundle；release 二进制未变，未重跑）
```

工作树里**只剩用户自己在 `examples/demo-vault/` 里的草稿文件**（未跟踪，刻意不提交、不改动）。
其中 `项目/未命名笔记.md`（**已跟踪**）与 `测试笔记.md`（未跟踪）都被用户自己删进了 `.mimenote/trash`
—— 那两处删除**没有**进任何提交，也没有被恢复，留给用户决定。
（`测试笔记.md` 进回收站时让 `tests/demo-vault.test.ts` 的"图片引用都要解析得到"变红，
已在 `listFiles` 里跳过 `.mimenote/trash` —— **不是**放宽判据，回收站里的东西本来就已被用户删掉。）

## 1. 这一轮交付了什么

### 13 条需求（原话 → 落点）

| # | 用户原话 | 落在哪 |
| --- | --- | --- |
| 1 | 可以增加一个配置是只有标题（文件名）的卡片 | `graph-store.titleOnly` + HUD「仅标题」+ `measure.titleOnlyCardHeight` |
| 2 | 鼠标悬浮 wikilink 时对应的关系连线高亮 | `link-edge.linkZones`（与 `findLinkAnchor` 共用遍历）+ canvas 里给那段文字描边 |
| 3 | wikilink 引线太淡（仍保持虚线） | `graph.css` 的 `.mn-graph-edge--lead`：1.6 / 0.85 / `--mn-fg-muted` |
| 4 | 卡片失去焦点后继续松开、保持浮动 | 点空白（`endPointer`）+ 选中变化（effect）两条路，都 `heat(RELEASE_HEAT)` |
| 5 | 卡片完整展示全文 + 移除侧边预览 | `CardSize.full`（`maxHeight: Infinity`）+ 删掉 `GraphPreview.tsx`；`Esc` 改成"先关浮窗再取消选中" |
| 6 | 卡片只能调宽度、不能调高度 | 手柄拖动改走 `setCardSize`（宽高同时改），另加「全文」档 |
| 7 | 每个视图模块可拖拽到任意区域占位 | `features/dock/`（三区 + 区内顺序；拖拽 + `Alt+1/2/3` + 同区 `Alt+方向键`） |
| 8 | 标签页移动到顶部 | `<TabBar />` 挂到 `.mn-app`（横跨全宽），删掉 `.mn-main:has(> .mn-tabs)` |
| 9 | 任意模块的右键菜单 | `components/ContextMenu.tsx`，接入文件树行 / 标签页 / 停靠模块头 / 图谱卡片 |
| 10 | 文件树排序规则可配置 | `domain/tree.ts` 的 `TreeSort` + `makeEntryComparator`，重排在数据层 |
| 11 | 最近打开的 Vault 固定在左下角 | `features/vault/RecentVaults.tsx` + `vault-store.recentVaults`（最多 8 条、按根路径去重） |
| 12 | 一套更适合阅读的主题色 | `theme/themes/mimenote-paper.json`（暖白纸感「纸墨」） |
| 13 | 已完成任务加删除线 | 阅读视图/导出件/静态站点（`li` 上）+ 所见即所得（只圈文字的 mark） |

### 两处额外修复（都是真的缺陷）

1. **焦点视图下卡片尺寸从不落盘**：`graph-store.rootPath` 过去只由全库视图的 `load()` 写入，
   而默认入口是关系图 ⇒ 拖出来的宽高重启就没了（静默丢失）。现在 `loadEgo` 会补上 Vault 根
   （优先级：store 里已有的 → 宿主那一刻的 Vault 根）。回归用例在 `tests/graph-view-prefs.test.ts`。
2. **frontmatter 画在卡片上**：卡片正文现在进入排版前过 `frontmatterBody`（判据仍是
   `domain/frontmatter.ts` 一份），落点是"一篇笔记文件 → 一张卡片"的唯一边界 `measure.layoutCard`。

### 连线的重做（用户讨论后定稿：ADR-0028）

- **语义色相**：暖 = 我指向它（`root → X`）、冷 = 它指向我（`X → root`）、中性 = 环与环之间；
  令牌 `--mn-edge-out` / `--mn-edge-in` 是**可选**的（缺省落到 `--mn-warning` / `--mn-link`），
  **没有**加进 `REQUIRED_TOKENS`。
- **跳数编码粗细与透明度**，且**淡化/强调是乘性调制**（写成覆盖会让跳数权重永远看不见 —— 实现时踩过）。
- **环向走线**：同环沿"两张卡片**最远的角**之外"的弧走（不是"中心距离 + 余量"，那会让弧穿过卡片 ——
  也踩过）、跨环用朝外鼓的径向切线、**涉及圆心保持 ADR-0023 原样**（径向切线在径向边上会退化成直线，
  张力旋钮会看起来失灵）。换形状时锚点换到卡片**外缘**（`outerExit`），引线随之重画以守住分界纪律。
- HUD 上有「沿环走线」开关（缺省开、可落盘），能当场对比新旧。

提交：`0cab6fd` 图谱卡片 · `2c3f8eb` 停靠/标签栏/右键菜单 · `d6540cf` 偏好与阅读体验 ·
`07f58f8` 文档（ADR-0025/0026/0027 + 架构）；本轮连线与剩余文档见下面"下一轮"开头的说明。

## 1.5 修补轮（用户逐条提、主会话逐条做）

用户明确定了节奏：**"我提功能你做，提一个做一个"**。已交付：

| # | 用户原话 | 落在哪 |
| --- | --- | --- |
| 1 | `mn-editor__path` 居中在中间页、高度不固定，希望进标题栏那一行并分成左/中/右三区 | **ADR-0029**：`.mn-titlebar` 改网格 `1fr / 2fr / 1fr`（`__left` / `__center` / `__right`），路径从编辑器面板搬进中区（`.mn-titlebar__path`），删掉 `.mn-editor__path` / `.mn-editor__status` |
| 2 | 隐藏 `.md` 的扩展名 | **ADR-0030**：`domain/paths.ts` 新增 `displayName` / `displayPath`（建在既有的 `isMarkdown` 上），标签页 / 标题栏 / 文件树 / 反链出链 / 快速切换 / 搜索命中 / 窗口标题 / 回收站 / 冲突横幅 / 拖拽与保存提示都改走它；导出件、宿主报错原文、移动对话框保留真实文件名 || 3 | 一份完整的 VI 设计文档（v1.0）+「整体默认字体能统一 16 号字体吗」 | **ADR-0031**：设计令牌两层命名（`--mn-*` 存储 / VI 名 `--bg-base`… 公开书写面，别名层在 app.css，可选令牌带兜底）+ **默认字号三档统一 16** + 文件树行高 26→30 + 新增"四栏不裁字 / 树行留白 ≥3px / 三档字号 = 16px"的 E2E 门禁。VI 里会推翻既有 ADR 的三条（顶栏 40px 等高度、编辑正文等宽、分屏）**一条都没动** || 4 | 「图片选择后无法预览吗」 | **ADR-0032**：第二类可打开的文件 —— `domain/viewable.ts` 一份判据 + `ui-store.openedFile` + `features/viewer/`（图片只读查看器，`asset:` 逐文件授权，`naturalWidth > 0` 由应用层 E2E 把守）；标题栏中区改成"我在看什么"，`data-note-path` → `data-main-path`（E2E 探针 helper 改名 `currentMainPath`） |
- **字号的真值在设置层**：`state/settings-store.ts` 的 `DEFAULT_SETTINGS`，由 `features/settings/font-overrides.ts`
  以行内变量 + `!important` 写进 `<html>`。改 `app.css` 的 `:root` 或主题 JSON 里的 `--mn-font-size-*`
  **不会有任何效果**（那两处只是兜底与令牌清单完整性）。老用户读 localStorage 里存的值，
  所以"改了默认值而用户没变"是预期行为 —— 出路是设置页的「恢复默认字号」。
- **VI 别名层是单向的**：写 `--bg-base` 不影响 `--mn-bg`。主题作者改值仍然改主题 JSON；
  想加"可选皮肤"（阅读衬线、编辑等宽、品牌 hover 色）就给对应的 `--mn-*` 可选令牌，别名会自己接上。
- 界面里还有一批 **10–13px 硬编码小字**不跟基础字号长；把它们收敛到 `--space-*` / `--font-size-*`
  是单独一轮（会改观感）。

两个细节值得记住（下一个交付项会复用）：

- 路径的旧类名 `.mn-editor__path` 曾是 E2E 里"当前打开的是哪一篇"的主力探针（约 20 处），
  现在一律是 `.mn-titlebar__path`；`openNoteInTree` 里"编辑视图读路径、否则退回树里选中态"的分支
  已经删掉（路径三种视图里都在，不需要间接信号了）。
- **标签栏在窗口最顶上那一行**（标题栏在它下面）：顶行的空白段是拖动区（`.mn-tabs__filler`），
  别把它删了 —— 删了之后顶行就没法拖窗口。
- **可见文字不再承载身份**：标题栏路径元素上有 `data-note-path`（真实路径），两层 E2E 的
  `currentNotePath(page)` 读它，**别改回读 `textContent`** —— `includes('项目/设计')` 会被
  `项目/设计文档` 误命中，而且可见文字现在**不带 `.md`**。
- 快速切换与图谱「定位笔记」的 `NoteIndexEntry` / `RankedNote` 多了 `displayPath` 字段：
  匹配与高亮下标都相对它算（渲染也用同一串字符），新写消费方时别再用 `relPath` 去匹配。
- 顺手修的门禁红：`tests/demo-vault.test.ts` 的 `listFiles` 现在跳过 `.mimenote/trash`
  （用户删除的副本不该被当成夹具；`README` 里列着的 `.mimenote/snippets/` 仍然照查）。

## 2. 下一轮可以做的（按价值排序）

1. **把连线搬进 canvas**：这是所有"更优雅的线"效果（渐细笔触 taper、发光、流动虚线、60fps 漂浮）
   的前置 —— 连线现在是 React 渲染的 SVG，所以 `FLOAT_FPS = 20`。代价是命中测试 / tooltip /
   可访问性要自己补（卡片那边已经付过一次，可以复用同一套做法）。
2. **渐细笔触取代箭头**（起点粗、终点细）：小尺度下干净得多；建议在第 1 条之后做。
3. **同一对笔记的多条链接画成平行束**（现在 `count > 1` 只画一条、信息在 tooltip 里）。
4. **真正避障布线**（跨环现在是"朝外鼓"的近似）。
5. 用户早期提过、仍未做：**编辑器里 `[[链接]]` 的 Obsidian 式悬停预览**（可复用浮窗那条渲染链）、
   **回收站永久删除 / 清空**、**标签面板拖拽成树**、**静态站点站内搜索与增量重导出**、
   **大文档预览的分块 + 视口窗口化**（ADR-0020 的收尾）。
6. 图谱卡片：**同一张卡片的多条出链做束化**（地铁主干那种），以及**卡片内搜索高亮**。

## 3. 工程约定与红线（新会话务必遵守）

- **注释与文档一律中文，注释解释"为什么"**（取舍、代价、踩过的坑），不复述代码在做什么。
- **提交由主会话做**：派出去的子代理**绝不执行 git 写操作**，只允许 `status`/`log`/`diff` 这类只读命令。
  每个交付项 = feature commit + docs-sync commit；ADR 放 `docs/adr/`，**下一个编号是 0034**。
- **`examples/demo-vault/` 是用户自己的草稿区**：不要动、不要提交里面的未跟踪文件（含
  `项目/未命名笔记.md` 与 `测试笔记.md` 那两处删除 —— 都是用户自己删的，保持原样）。
- **确定性是一条纪律**：力场自己实现 xorshift32、固定遍历顺序、不用 `Math.hypot` 的地方就别用；
  同一份输入 + 同一组参数 ⇒ 同一份坐标（ADR-0021）。连线走线同样**不含任何随机量**。
- **判据只有一份**：callout 是 `domain/callouts.ts`，任务列表是 `domain/task-list.ts`，
  frontmatter 是 `domain/frontmatter.ts`，文件树排序是 `domain/tree.ts`，停靠模型是
  `features/dock/dock-layout.ts`，连线形状是 `features/graph/edge-routing.ts`。
- **数字要同步**：用例数写在 `README.md`（质量门禁表 + E2E 覆盖段），功能描述写在 README 的功能表 +
  `docs/architecture.md`（§7 ADR 表、§8 边界清单）+ `docs/milestones.md`。现在改完是
  **87 文件 / 1601 条 / UI E2E 63 条 / 应用层 E2E 34 条**（应用层那 34 条是在纯文本查看器与图标刻度之前跑的：那两处都走 UI 层可覆盖的路径）。
- **验证顺序**：`pnpm typecheck` + 目标 vitest → `pnpm test` → 动了前端就 `pnpm build` + `pnpm test:e2e:ui`
  → 动了 Rust 或要跑应用层 E2E 才 `tauri build --no-bundle`（约 3–4 分钟）+ `pnpm test:e2e:app`。
- **`pnpm test` 有已知抖动**：`tests/graph.test.tsx` 的「仅标题」用例在**并行跑整套**时偶发失败
  （单独跑必过；`a9d472d` 那次把门闸改成"布局高度"只消掉了其中一条路径）。遇到它先单独重跑一次确认，
  别急着改被测代码。
- **子代理在本轮两次中途失败过**（B 干到一半、A 完全没跑起来）：派活时把"硬性纪律 + 文件地图 +
  交付报告格式"写全，并且**假设它随时可能死** —— 主会话要留出接手收尾的余量。
- **这台机器上 `apps/desktop/src/**` 与 `README.md` 常被别的进程（Vite watch / VS Code）短暂占用**：
  `edit` 工具会报 `ReplaceFileW EIO (Win32 32/1175)`。**原样重试一次通常就过了**；
  连续失败就改用 PowerShell 的 `[IO.File]::ReadAllText/WriteAllText` + 重试循环，别为此改文件内容。

## 4. 环境事实

- 真实 Vault：`C:\Users\hencter\Nutstore\1\Note`（4267 篇 `.md`，同步盘；建议排除 `.mimenote/`）。
- **用户有一个正在跑的开发实例 `target/debug/mimenote.exe` —— 绝不要杀它**。
- `target\release\mimenote.exe` 刚重建过（应用层 E2E 用的是它）。
- GUI：`http://127.0.0.1:3080`（DSH Web）。改前端后需要 `pnpm build` + 刷新页面才生效。
- 图谱的 DOM 诊断属性（自动化唯一的抓手，别乱删）：`data-graph-mode / depth / scale / offset-x /
  offset-y / canvas-cards / painted-cards / root-rect / card-rects / pinned / overlaps / selected`；
  力度面板的 `[data-force-param] / [data-force-value] / [data-force-preset] / [data-force-action]`；
  这一轮新增的 `data-dock / data-dock-module / data-dock-module-header / data-dock-drop-line /
  data-dock-rail / data-menu-item / data-card-height="full" / [data-graph-action="toggle-title-only"] /
  [data-graph-action="toggle-ring-routing"]`。
- 测试骨架可以抄现成的：`tests/dock-host.test.tsx`（停靠区 + 假 DataTransfer）、
  `tests/context-menu.test.tsx`（浮层的键鼠与夹回视口）、`tests/edge-routing.test.ts`（手算几何）、
  `tests/graph.test.tsx`（画布 + 录制型假画布 + 指针派发）、
  `e2e/ui.e2e.test.ts` 的 `readLayout / graphScreenPoint / settledGraphTransform / graphCardRects`。

## 5. 关键文件地图

- `apps/desktop/src/App.tsx` 的 `<header className="mn-titlebar">`：**唯一的标题栏**，
  内部三区 `.mn-titlebar__left / __center / __right`（ADR-0029）；中区放当前笔记路径
  `.mn-titlebar__path`（含 `.mn-titlebar__path-text` 与「保存中…」），它的缩放/省略样式与三区列宽
  都在 `styles/app.css` 标题栏那一段。**`align-items` 不能加**（窗口按钮靠 `align-self: stretch`）。
- `apps/desktop/src/features/graph/GraphCanvas.tsx`：坐标换算、命中、指针、模拟 effect、漂浮循环、
  浮动面板、HUD、**卡片菜单**、**连线样式与走线的组装**（`edgeVisuals` 那段）。
- `apps/desktop/src/features/graph/edge-routing.ts`：**连线形状**（弧 / 径向切线 / 交回调用方），
  文件头有完整的形状示意与三条判据。
- `apps/desktop/src/features/graph/link-edge.ts`：引线几何（锚点 → 边界 → 张力曲线）、`linkZones`
  （悬停热区）、`leadDash`（虚线相位）、`leadPathBetween`。
- `apps/desktop/src/features/dock/`：`dock-layout.ts`（纯模型 + 不变式）、`DockHost.tsx`（渲染 + 拖拽 +
  键盘 + 模块菜单）、`dock.css`、`dock-drag.ts`（瞬时拖动状态）。
- `apps/desktop/src/components/ContextMenu.tsx`：通用右键菜单（点外关 / `Esc` / 走位 / 夹回视口 / 还焦点）。
- 渲染单一口径的榜样：`domain/callouts.ts`、`domain/task-list.ts`、`domain/frontmatter.ts`。
