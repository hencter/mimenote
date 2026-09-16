# 交接说明：下一个会话从这里开始

> 这份文件是**临时**的会话交接，不是产品文档。新会话接手顺利之后可以直接删掉它。
> 最后更新：连线搬进 canvas（ADR-0036）交付 + 一次**界面样式回归的修复**之后。

## 0. 一句话现状

上一轮的容器切割树（ADR-0035）之后，用户在界面上发现**样式掉了** —— 根因是
`features/tabs/tabs.css` 成了**孤儿样式表**（ADR-0035 删掉旧全局标签栏 `TabBar.tsx` 时，
它是那份样式的唯一导入方），新组件 `LeafTabs.tsx` 照旧渲染 `.mn-tabs*` 类名却没人再 import，
整份规则没进产物。已修（`LeafTabs.tsx` 里补上 import），并新增
`tests/stylesheets.test.ts`（**没有孤儿样式表**）把这条纪律钉住。

随后交付了交接说明里排第一的那件事：**连线搬进 canvas**（ADR-0036）。

```
pnpm typecheck                 ✓ 无错误
pnpm test                      ✓ 95 个测试文件 / 1693 条
pnpm test:e2e:ui               ✓ 64 条
pnpm test:e2e:app              ✓ 34 条（release 二进制已重建 —— 前端变了它跑的就是旧前端）
```

工作树里**只剩用户自己在 `examples/demo-vault/` 里的草稿文件**（未跟踪，刻意不提交、不改动）。

## 1. 这一轮交付了什么

### 1.1 样式回归（不是"改观感"，是"整份样式表没进包"）

- `features/layout/LeafTabs.tsx` 补 `import '@/features/tabs/tabs.css'`（文件头写清了为什么这一行是它进包的**唯一**原因）。
- `tests/stylesheets.test.ts`（3 条）：扫源码树，`src/**/*.css` 每一份都必须被某个模块 import，
  且定义了 `mn-*` 类名的那份必须被**真的在用它**的模块导入。

### 1.2 ADR-0036：连线搬进 canvas

- **一张 canvas 三段顺序**：卡外那段 → 卡片 → 卡内引线（`paintGraph` 的入口）。
  `GraphEdges.tsx`、`.mn-graph__leads` 那一层 DOM、`.mn-graph-edge* / arrow* / phantom*` 那批 CSS 全部退役。
- **几何变成点模型**（`canvas/edge-path.ts`）：只认 M/L/C/A（绝对坐标），椭圆弧展开成三次贝塞尔
  （每 90° 一段，误差 2/10000 半径，**最后一段终点强制取规范点**以守住分界纪律）。
- **命中测试与提示自己补**：`edgeAt` 取"最近且 ≤ 5 屏幕像素"的那条，判据用的是画笔那一帧真画出来的几何；
  提示是新补的 DOM（`[data-graph-edge-tip]`）—— 顺带发现 SVG 版那层 `<title>` 因为
  `.mn-graph__edges { pointer-events: none }` **从来没生效过**。
- **漂浮 20fps → 60fps**（代价如实记在 ADR 里：卡片重画次数 20 → 60 次/秒）。
- **顺手修掉一条落差**：`EdgeStyle.width/opacity`（跳数权重）在 SVG 版里是**表现属性**，
  被 `graph.css` 的类规则按优先级盖掉 —— "越远越细越淡"从来没被看见过。canvas 里没有这种暗礁，
  现在**真的生效**（给了就用、没给才退到 `graph.css` 那三档）。
- **自动化抓手换载体**：SVG 类名 → 宿主上的 `data-graph-edges / -dashed / -highlight /
  -highlight-dashed / -dim / -hues / -arcs / -leads / -bulges / -phantoms / -hover`（ADR-0036 有对照表）。
- 新文件：`canvas/edge-path.ts`、`canvas/edge-paint.ts`、`canvas/context.ts`、`tests/graph-edge-paint.test.ts`（31 条）；
  退役：`features/graph/GraphEdges.tsx`。

### 1.3 顺手修掉的一条已知抖动

`graph.test.tsx` 的「仅标题」用例原来是"清空画布记录 → 点开关 → 立刻断言没有正文"，
而清空到断言之间可能插进一帧**切换前**的重绘。60fps 让推帧更密，于是改成确定性的采样窗口
（先等布局落定 → 清空 → 指针移一下拿到"切换后"那一帧）。

## 2. 下一轮可以做的（按价值排序）

0. **用户刚提的界面需求（最优先，原话见 §6）**：**主叶保持在中间；默认打开新文件时用新笔记
   **替换主叶那条标签**（"已打开的直接被新的替换掉"）**。
   落点在 `state/tabs-store.ts` 的 `activate` 与 `features/layout/layout-sync.ts` 的对账：
   现在打开一篇笔记是**追加**一个标签，用户要的是默认**替换主叶当前那条**。
   动手前先确认三件事（语义差别很大）：① 是不是"主叶永远只留一条标签"（多标签要靠拖拽才出现）？
   ② 已经在别的格里打开的笔记，再打开时是**切过去**还是也替换？③ 被替换掉的那条标签
   （有未保存修改时）要不要先问？另外"主叶一直在中间"要不要做成不变式（现在主叶只是**默认落点**，
   被拖走之后不会再被搬回来）。
1. **连线搬进 canvas 之后才可能做的三件"更优雅的线"**：**渐细笔触取代箭头**（起点粗、终点细）、
   同一对笔记的多条链接画成**平行束**、真正的**避障布线**（现在跨环是"朝外鼓"的近似）。
   现在都只差几何与画笔，不用再碰图层。
2. 用户早期提过、仍未做：**编辑器里 `[[链接]]` 的 Obsidian 式悬停预览**、
   **回收站永久删除 / 清空**、**标签面板拖拽成树**、**静态站点站内搜索与增量重导出**、
   **大文档预览的分块 + 视口窗口化**（ADR-0020 的收尾）。
3. 图谱卡片：卡片内搜索高亮；「同一张卡片的多条出链做束化」。
4. 切割树收尾：只读预览**补图**（现在停在占位态）、主叶被拖空后留在原地（VS Code 是关掉空组）、
   `Alt+↑/↓` 占用（搬到上/下相邻格子）、笔记左右对照编辑（要先做多文档模型，量级很大）。

## 3. 工程约定与红线（新会话务必遵守）

- **注释与文档一律中文，注释解释"为什么"**（取舍、代价、踩过的坑），不复述代码在做什么。
- **提交由主会话做**：派出去的子代理**绝不执行 git 写操作**，只允许 `status`/`log`/`diff` 这类只读命令。
  每个交付项 = feature commit + docs-sync commit；ADR 放 `docs/adr/`，**下一个编号是 0037**。
- **`examples/demo-vault/` 是用户自己的草稿区**：不要动、不要提交里面的未跟踪文件。
- **确定性是一条纪律**：力场自己实现 xorshift32、固定遍历顺序；连线同样**不含任何随机量**
  （新加的画笔有一条"两次绘制逐字相同"的用例）。
- **判据只有一份**：callout 是 `domain/callouts.ts`，任务列表是 `domain/task-list.ts`，
  frontmatter 是 `domain/frontmatter.ts`，文件树排序是 `domain/tree.ts`，布局模型是
  `features/layout/tree-layout.ts`，落点几何是 `features/layout/drop-target.ts`，
  键盘等价物是 `features/layout/tree-keys.ts`，连线形状是 `features/graph/edge-routing.ts`，
  **连线的样式与画法是 `features/graph/canvas/edge-paint.ts`，路径语法是 `canvas/edge-path.ts`**。
- **数字要同步**：用例数写在 `README.md`（质量门禁表 + E2E 覆盖段），功能描述写在 README 的功能表 +
  `docs/architecture.md`（§7 ADR 表、§8 边界清单）+ `docs/milestones.md`。现在改完是
  **95 文件 / 1693 条 / UI E2E 64 条 / 应用层 E2E 34 条**。
- **验证顺序**：`pnpm typecheck` + 目标 vitest → `pnpm test` → 动了前端就 `pnpm build` + `pnpm test:e2e:ui`
  → 动了 Rust 或要跑应用层 E2E 才 `tauri build --no-bundle`（约 3–4 分钟）+ `pnpm test:e2e:app`。
- **子代理在这个环境里会死**（本轮又死了一个：派去写 `tests/graph-edge-paint.test.ts` 的子代理
  连文件都没建起来）。硬性纪律 + 文件地图 + 报告格式写全之外，**主会话要留出自己收尾的余量**；
  写测试这种"要读实现细节"的活，自己写往往比派出去更快。
- **这台机器上 `apps/desktop/src/**` 与 `README.md` 常被别的进程（Vite watch / VS Code）短暂占用**：
  `edit` 工具会报 `ReplaceFileW EIO (Win32 32/1175)`。**原样重试一次通常就过了**；
  连续失败就改用 PowerShell 的 `[IO.File]::ReadAllText/WriteAllText` + 重试循环，别为此改文件内容。
- **大批量改文件时别用 PowerShell 内联的 `node -e`**：中文引号 / 反引号 / 正则会被 pwsh 吃掉
  （本轮在这上面浪费了好几次往返）。写一个 `.mjs` 到 `$env:DSH_HOME\tmp\` 再跑。
- **改测试文件时先确认括号配平**：本轮连着两次把用例的收尾 `})` 连掉，症状是
  "vitest 报 no tests / 用例被算成嵌套在另一个用例里"。清完大段代码后跑一次 `pnpm typecheck`
  与 `vitest run <该文件>` 的最小确认，比事后猜快得多。

## 4. 环境事实

- 真实 Vault：`C:\Users\hencter\Nutstore\1\Note`（4267 篇 `.md`，同步盘；建议排除 `.mimenote/`）。
- DSH 宿主在 **23:26 重启过**（进程换过），所以：**动态 Cordis 插件与 Goal 都不在了**，
  而且**用户那个正在跑的开发实例 `target/debug/mimenote.exe` 已经不在进程表里**
  （`Get-Process` 里没有 mimenote，1420 端口也没在听）。要再起开发实例得先 `pnpm dev`（Vite），
  或直接跑 release 二进制（它吃 `dist/`）。
- `target\release\mimenote.exe` 刚重建过（应用层 E2E 用的是它）。
- GUI：`http://127.0.0.1:3080`（DSH Web）。它的静态资源本轮实测全 200（**不是**它掉了样式）。
- 图谱的 DOM 诊断属性（自动化唯一的抓手，别乱删）：`data-graph-mode / depth / scale / offset-x /
  offset-y / canvas-cards / painted-cards / root-rect / card-rects / pinned / overlaps / selected`；
  **连线那一组见 ADR-0036 的对照表**（`data-graph-edges / -dashed / -highlight / -highlight-dashed /
  -dim / -hues / -arcs / -leads / -bulges / -phantoms / -hover`，外加新出现的 `[data-graph-edge-tip]`）；
  力度面板的 `[data-force-param] / [data-force-value] / [data-force-preset] / [data-force-action]`；
  切割树的 `data-leaf-id / data-leaf-tabs / data-tab-path / data-module-tab / data-split-id / data-axis /
  data-drop-hint / data-main-path`（状态栏最左）。
- 测试骨架可以抄现成的：`tests/graph-edge-paint.test.ts`（记录型假上下文 + 手算期望值）、
  `tests/graph-paint.test.ts`（同一套记录法）、`tests/graph.test.tsx`（画布 + 记录型画布 + 指针派发）、
  `tests/tree-host.test.tsx`（树渲染 + 假 DataTransfer + 矩形 mock）、
  `tests/edge-routing.test.ts`（手算几何）。
- **jsdom 的 DragEvent 不带 clientX/clientY**：落点几何的测试要改用
  `new MouseEvent('dragover', { clientX, clientY })` + `Object.defineProperty(event, 'dataTransfer', …)`
  （`tests/tree-host.test.tsx` 的 `dragEvent` helper 是现成写法）。

## 5. 关键文件地图

- `apps/desktop/src/App.tsx` 的 `<header className="mn-titlebar">`：**唯一的标题栏**，
  三区 `.mn-titlebar__left / __center / __right`；中区是**纯拖动区**。"我在看什么"在**状态栏最左**。
- `apps/desktop/src/features/layout/TreeHost.tsx`：切割树渲染器；`LeafTabs.tsx`：每格标签条
  （**注意它必须 import `@/features/tabs/tabs.css`** —— 这一行就是那次样式回归的修复）。
- `apps/desktop/src/features/graph/canvas/edge-paint.ts`：**连线的样式与画法**（顶部常量表对着
  `graph.css` 的退役规则，分 `span` / `lead` 两层画，`edgeAt` 是命中判据，`bulgeRatio` 是给自动化的相对量）。
- `apps/desktop/src/features/graph/canvas/edge-path.ts`：**路径语法**（M/L/C/A、隐式重复、抛错口径、
  采样 / 命中距离 / 终点切向 / 弧展开 → 三次贝塞尔）。
- `apps/desktop/src/features/graph/canvas/paint.ts`：卡片画笔 + **三段绘制顺序**（卡外 → 卡片 → 引线）。
- `apps/desktop/src/features/graph/GraphCanvas.tsx`：坐标换算、命中、指针、模拟 effect、漂浮循环
  （`FLOAT_FPS = 60`）、浮动面板、HUD、卡片菜单、**连线的诊断属性**、`EDGE_HIT_SLOP = 5`。
- `apps/desktop/src/features/graph/edge-routing.ts`：连线形状（弧 / 径向切线 / 交回调用方）。
- `apps/desktop/src/features/graph/link-edge.ts`：引线几何、`linkZones`（悬停热区）、`leadDash`
  （**返回数字**，给 `ctx.setLineDash` + `lineDashOffset` 用）。
- `apps/desktop/src/features/graph/graph.css`：连线那一节只剩一段"样式不在这里、去哪里改、
  自定义边界是什么"的说明。
- **可见文字不再承载身份**：标签/状态栏路径上都带 `data-tab-path` / `data-main-path`（真实路径），
  两层 E2E 认身份读它们，**别改回读 `textContent`**。

## 6. 用户这一轮的原话（新需求，别改语义）

> 中间的这个叶保持在中间，默认的新文件替换中的叶标签
> 即已打开的直接被新的替换掉

（§2 的第 0 条是它对应的落点与要先确认的三个问题。）
