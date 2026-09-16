# 交接说明：下一个会话从这里开始

> 这份文件是**临时**的会话交接，不是产品文档。新会话接手顺利之后可以直接删掉它。
> 最后更新：容器切割树（ADR-0035）**渲染器换树**交付之后。

## 0. 一句话现状

13 条需求那一轮与连线重做都已交付；修补轮的布局工作以 **ADR-0035 容器切割树**收口 ——
模型、迁移对账、落盘、**渲染器换树**（每格一条标签条 + 拖标签落点 + 分隔条 + 键盘等价物 +
非当前笔记的只读预览）全部交付，门禁全绿。

```
pnpm typecheck                 ✓ 无错误
pnpm test                      ✓ 93 个测试文件 / 1660 条（graph.test.tsx「仅标题」并行偶发那条单独跑必过，已知抖动）
pnpm test:e2e:ui               ✓ 64 条（本批重写过布局/标签相关断言）
pnpm test:e2e:app              ✓ 34 条（release 二进制已重建 —— 前端变了它跑的就是旧前端）
```

工作树里**只剩用户自己在 `examples/demo-vault/` 里的草稿文件**（未跟踪，刻意不提交、不改动）。

## 1. 这一轮交付了什么（ADR-0035 渲染器换树）

用户确认的两条产品语义：**非当前笔记 = 只读预览**（一格可写、其余可读）；
**全局标签栏撤掉、标签进格子**（标题栏中区回归纯拖动区）。

- **渲染器**：`features/layout/TreeHost.tsx`（递归 + 收缩 + 分隔条 + 落点接线）与
  `LeafTabs.tsx`（每格一条标签条：笔记/模块混排、标签是拖动源、右键菜单、键盘）。
- **行为层纯函数**：`drop-target.ts`（落点几何：条内插位 / 中央并入 / 四边带切割）、
  `tree-keys.ts`（`Alt+1/2/3` 搬到主区左/右/下 + 幂等闸、`Alt+←/→` 条内换位置）、
  `split-size.ts`（模块切出时按旧默认像素 288/300/220 换算新刀比例）、
  `layout-drag.ts`（拖动瞬时态）、`module-visibility.ts`（可见性唯一真相 + 隐藏/显示走原开关）。
- **只读预览链路只一份**：新抽 `features/preview/StaticNotePreview.tsx`，
  图谱浮窗（`FloatingNote`）与树叶子的"非当前笔记"都用它。
- **对账**：`reconcileLayout` 新增 `activeNote`（当前文档所在的格子必须把它作为激活标签，
  否则 wikilink 打开一篇"已在树上但那格停在别处"的笔记时编辑器无处可显示）。
- **旧件退役**：`TabBar`/`DockHost`/`dock-drag`/`dock.css` 删除；`dock-layout.ts`
  只剩类型/缺省/校验（迁移与回滚的读取面）；`ui-store` 卸掉 `moveDockModule`，
  `dockLayout` 与三个旧尺寸字段仍在落盘里（回滚可读，别加新消费方）。

### 两个抓出的真 bug（ADR-0035 后续修订 3 有完整记录）

1. **空主叶塌缩**：不变式 2 修订为"**主叶允许为空**"（否则启动时一篇没开，main 叶不在树上，
   下一篇笔记被挂进文件树那格）。
2. **迁移比例一律 0.5**：文件树独占半窗 → 图谱 HUD 盖住圆心卡片、点选不中（UI E2E 全红）。
   修法：迁移按旧像素宽度/窗口尺寸换算比例（`MigrateSizes`）。

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
7. 切割树的收尾候选（用户提过再动）：只读预览**补图**（现在停在占位态）、
   主叶被拖空后留在原地（VS Code 是关掉空组 —— 现在的选择是留着当"主区占位"）、
   `Alt+↑/↓` 占用（搬到上/下相邻格子）、笔记左右对照编辑（要先做多文档模型，量级很大）。

## 3. 工程约定与红线（新会话务必遵守）

- **注释与文档一律中文，注释解释"为什么"**（取舍、代价、踩过的坑），不复述代码在做什么。
- **提交由主会话做**：派出去的子代理**绝不执行 git 写操作**，只允许 `status`/`log`/`diff` 这类只读命令。
  每个交付项 = feature commit + docs-sync commit；ADR 放 `docs/adr/`，**下一个编号是 0036**。
- **`examples/demo-vault/` 是用户自己的草稿区**：不要动、不要提交里面的未跟踪文件。
- **确定性是一条纪律**：力场自己实现 xorshift32、固定遍历顺序、不用 `Math.hypot` 的地方就别用；
  同一份输入 + 同一组参数 ⇒ 同一份坐标（ADR-0021）。连线走线同样**不含任何随机量**。
- **判据只有一份**：callout 是 `domain/callouts.ts`，任务列表是 `domain/task-list.ts`，
  frontmatter 是 `domain/frontmatter.ts`，文件树排序是 `domain/tree.ts`，
  布局模型是 `features/layout/tree-layout.ts`，落点几何是 `features/layout/drop-target.ts`，
  键盘等价物是 `features/layout/tree-keys.ts`，连线形状是 `features/graph/edge-routing.ts`。
- **数字要同步**：用例数写在 `README.md`（质量门禁表 + E2E 覆盖段），功能描述写在 README 的功能表 +
  `docs/architecture.md`（§7 ADR 表、§8 边界清单）+ `docs/milestones.md`。现在改完是
  **93 文件 / 1660 条 / UI E2E 64 条 / 应用层 E2E 34 条**。
- **验证顺序**：`pnpm typecheck` + 目标 vitest → `pnpm test` → 动了前端就 `pnpm build` + `pnpm test:e2e:ui`
  → 动了 Rust 或要跑应用层 E2E 才 `tauri build --no-bundle`（约 3–4 分钟）+ `pnpm test:e2e:app`。
- **`pnpm test` 有已知抖动**：`tests/graph.test.tsx` 的「仅标题」用例在**并行跑整套**时偶发失败
  （单独跑必过）。遇到它先单独重跑一次确认，别急着改被测代码。
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
  切割树的 `data-leaf-id / data-leaf-tabs / data-tab-path / data-module-tab / data-split-id / data-axis /
  data-drop-hint / data-main-path`（状态栏最左，"我在看什么"）。
- 测试骨架可以抄现成的：`tests/tree-host.test.tsx`（树渲染 + 假 DataTransfer + 矩形 mock）、
  `tests/context-menu.test.tsx`（浮层的键鼠与夹回视口）、`tests/edge-routing.test.ts`（手算几何）、
  `tests/graph.test.tsx`（画布 + 录制型假画布 + 指针派发）、`tests/tree-keys.test.ts`（键盘搬运）。
- **jsdom 的 DragEvent 不带 clientX/clientY**（`fireEvent.dragOver` 给的是 undefined）：
  落点几何的测试要改用 `new MouseEvent('dragover', { clientX, clientY })` + `Object.defineProperty(event, 'dataTransfer', …)`
  （`tests/tree-host.test.tsx` 的 `dragEvent` helper 就是现成的写法）。

## 5. 关键文件地图

- `apps/desktop/src/App.tsx` 的 `<header className="mn-titlebar">`：**唯一的标题栏**，
  三区 `.mn-titlebar__left / __center / __right`；中区是**纯拖动区**（标签进了格子）。
  "我在看什么"在**状态栏最左**（`.mn-statusbar [data-main-path]`）。
- `apps/desktop/src/features/layout/TreeHost.tsx`：切割树渲染器（递归、收缩规则、内容分派、
  落点接线、分隔条）；`LeafTabs.tsx`：每格标签条（笔记/模块混排、菜单、键盘）。
  内容分派与收缩规则只有一套，都写在两个文件的头注释里。
- `apps/desktop/src/features/preview/StaticNotePreview.tsx`：任意笔记的只读预览链路
  （`noteRead → renderMarkdown(frontmatterBody) → wikilink 标注 → openNote`），
  浮窗与树叶子共用。
- `apps/desktop/src/features/graph/GraphCanvas.tsx`：坐标换算、命中、指针、模拟 effect、漂浮循环、
  浮动面板、HUD、**卡片菜单**、**连线样式与走线的组装**（`edgeVisuals` 那段）。
- `apps/desktop/src/features/graph/edge-routing.ts`：**连线形状**（弧 / 径向切线 / 交回调用方），
  文件头有完整的形状示意与三条判据。
- `apps/desktop/src/features/graph/link-edge.ts`：引线几何（锚点 → 边界 → 张力曲线）、`linkZones`
  （悬停热区）、`leadDash`（虚线相位）、`leadPathBetween`。
- `apps/desktop/src/components/ContextMenu.tsx`：通用右键菜单（点外关 / `Esc` / 走位 / 夹回视口 / 还焦点）。
- 渲染单一口径的榜样：`domain/callouts.ts`、`domain/task-list.ts`、`domain/frontmatter.ts`。
- **可见文字不再承载身份**：标签/状态栏路径上都带 `data-tab-path` / `data-main-path`（真实路径），
  两层 E2E 认身份读它们，**别改回读 `textContent`**。
- 快速切换与图谱「定位笔记」的 `NoteIndexEntry` / `RankedNote` 多了 `displayPath` 字段：
  匹配与高亮下标都相对它算（渲染也用同一串字符），新写消费方时别再用 `relPath` 去匹配。

