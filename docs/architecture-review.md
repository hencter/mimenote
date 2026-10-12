# 前端架构体检与改造 backlog

> 体检对象：`D:\Projects\mimenote` @ `89ef508`（工作树另有他人未提交改动，见 §0.3）
> 口径：**物理行**；所有数字都是本轮实测，测量命令见 §12
> 配套决策：`docs/adr/0060-frontend-architecture.md`；可执行门禁：`scripts/check-architecture.mjs`

## 0. 复核：与 Lead 给到的数字的口径差异

### 0.1 行数口径不同（结论方向不变）

Lead 的 LOC 是**非空行**，我按**物理行**重测 —— 后者与编辑器行号、`git diff --stat` 一致，
也是门禁 `oversizeFiles` 用的口径。两者系统性差 8–15%：

| 文件 | Lead（非空行） | 我（物理行） | 差 |
| --- | --- | --- | --- |
| `ipc/mock-adapter.ts` | 2970 | **3176** | +206 |
| `features/graph/GraphCanvas.tsx` | 2490 | **2635** | +145 |
| `styles/app.css` | 1470 | **1693** | +223 |
| `state/graph-store.ts` | 1373 | **1514** | +141 |
| `app/actions.ts` | 928 | **1018** | +90 |
| `features/graph/layout.ts` | 888 | **986** | +98 |
| `ipc/types.ts` | 823 | **896** | +73 |

非空行数与 Lead 完全对得上（例：mock-adapter 非空 2970 ✔、GraphCanvas 2490 ✔），
所以 **Lead 的排序与结论没有被推翻**；但门禁与 ADR 一律以物理行为准。

### 0.2 `!important` 是 9 处，不是 10 处

`styles/app.css:55` 是**注释里提到** `!important`（"用 `!important` 就正好相反"），不是声明。
真实声明 9 处：

| 文件:行 | 内容 | 是否必要 |
| --- | --- | --- |
| `styles/app.css:170,171` | `@media (prefers-reduced-motion: reduce)` 下的 `animation-duration` / `transition-duration` | 必要（要压过任何动画声明） |
| `styles/app.css:546` | `.mn-editor__surface .cm-selectionLayer { z-index: 3 !important }` | 必要（压 CM 经 `layer()` 写的**行内** `z-index:-2`） |
| `styles/app.css:548` | `.cm-selectionBackground { background: … !important }` | 必要（同上） |
| `features/export/export.css:109,113,119,120,121` | `@media print` 里隐藏应用外壳 | **不必要** —— 分层之后 `mn.features` 的普通声明已压过 `mn.base`，这 5 处应删除 |

教训已写进门禁：**数 `!important` 之前必须先剥注释与字符串**（`importantCount()` 就是这么做的）。

### 0.3 其它口径修正

- `import './x.css'`：Lead 说 34 处，实测 **33 条 import 语句**；
  `domain/site-paths.ts:23` 的 `SITE_CSS_FILE = 'assets/site.css'` 与
  `ipc/mock-adapter.ts:3100` 的 mock 片段 `{ name: 'example.css' }` 会被 `grep "\.css'"` 误计。
  我按"解析 import 语句 + 解析到真实文件"统计：33 条 import、**29 个样式表 100% 被引用（无死样式）**。
- 依赖越界：Lead 列的 `state/graph-store.ts:41-43` 里，**:42 是 `import type`**（`ForceParams`）；
  `state/tabs-store.ts:49` 也是 `import type`（`Disposer`）。二者被 `verbatimModuleSyntax: true`
  完全擦除，**不构成运行时耦合**，因此不计入越界。真实越界 = **10 条值依赖**（§1.2 逐条列出）。
- `domain/*` → `@/ipc/types` 的 6 处**全是 type-only** ✔（Lead 已注明），门禁据此放行。
- CSS 文件数：28 个 feature/component CSS + `styles/app.css` = **29** ✔；**0 个 CSS Modules** ✔。

### 0.4 Lead 没有提到、但我实测到的两件事

1. **全仓唯一的模块级循环**：`app/actions.ts:20` → `state/tabs-store.ts` ←→ `state/tabs-store.ts:48` → `app/actions.ts`。
   我按值导入图跑 Tarjan，**217 个模块里只有 1 个 SCC≥2**。层与层之间是双向的
   （`app → features` 10 条 / `features → app` 39 条），但落到模块上并不成环。
2. **最重的那个文件不是"体积问题"而是"第三个领域实现"**：`ipc/mock-adapter.ts` 3176 行里
   40 余个内部辅助函数（`mockXxx` 家族）自己实现了一遍 links / 标签编辑 / frontmatter / 搜索打分 / 站点导出 ——
   Rust（权威）一份、`domain/**` 一份、mock 一份。**三条判据**，与 ADR-0048 的纪律冲突（§7.2）。

### 0.5 基线可信度

我独立跑了一遍单测（`apps/desktop`，`npx vitest run`）：

```
Test Files  127 passed (127)
     Tests  2222 passed (2222)
  Duration  138.73s
```

与 Lead 的"127 文件 / 2222 条全绿"**完全一致**。`pnpm check:version`、`pnpm check:ipc`
（43 条命令三方一致 / 15 个错误码 / 53 组 DTO / 5 组枚举）也在我改动前后各跑通一次。

---

## 1. 依赖方向

### 1.1 实测的依赖矩阵

`src/**` 内共 **863** 条模块间依赖（值依赖 760 + 类型依赖 103），其中跨层 546 条、同层 317 条。

| 方向 | 值依赖 | 类型依赖 | 判定 |
| --- | --- | --- | --- |
| `domain → ipc` | 0 | **6** | ✅ 允许（纯类型，全部擦除） |
| `domain → *`（其它） | 0 | 0 | ✅ **零值依赖向上**，这条现状是干净的 |
| `ipc → domain` | 5 | 0 | ✅ 允许（mock-adapter 复用 `domain/attachments` 等纯函数，方向正确） |
| `theme → ipc` | 1 | 0 | ✅ 允许 |
| `state → domain` | 14 | 0 | ✅ |
| `state → ipc` | 20 | 11 | ✅ |
| `state → theme` | 1 | 0 | ⚠️ 记为待收窄（§1.3） |
| **`state → features`** | **6** | 1 | ❌ |
| **`state → app`** | **2** | 1 | ❌ |
| `components → domain` | 1 | 0 | ✅ |
| **`components → state`** | **2** | 0 | ❌ |
| `features → domain / ipc / state / components` | 103 / 31 / 136 / 48 | 11 / 26 / 1 / 1 | ✅ |
| `features → app` | 38 | 1 | ✅ **有意为之**（界面触发组合动作），列入放行名单 |
| `app → *` | 47 | 1 | ✅ 组合根 |
| `root → *`（`App.tsx` / `main.tsx`） | 24 | 0 | ✅ |

### 1.2 10 条越界（门禁逐条冻结，只许变小）

| # | 出处 | 目标 | 影响 |
| --- | --- | --- | --- |
| 1 | `state/ui-store.ts:14-18` | `features/dock/dock-layout` | 纯布局模型被锁在 features 里 |
| 2 | `state/ui-store.ts:19-23` | `features/layout/tree-layout` | 同上（677 行的纯模型） |
| 3 | `state/ui-store.ts:24` | `features/layout/layout-sync` | 同上 |
| 4 | `state/graph-store.ts:41` | `features/graph/layout`（8 个符号：`FIT_PADDING`/`buildLayout`/`clampZoom`/`fitView`/`panBy`/`pruneManualPositions`/`zoomAround` 与类型） | 同上（986 行纯模型） |
| 5 | `state/graph-store.ts:43` | `features/graph/force-presets` | 纯数据表 |
| 6 | `state/tabs-store.ts:54` | `features/layout/layout-sync` | 同上 |
| 7 | `state/keymap-store.ts:13` | `app/commands` | `commands` 注册表被状态层依赖；ADR-0055 已把键位**原语**下沉到 `domain/keymap.ts`，注册表还没搬 |
| 8 | `state/tabs-store.ts:48` | `app/actions` | **全仓唯一的环**（§1.4） |
| 9 | `components/ConfirmDialog.tsx:5` | `state/confirm-store` | "通用控件"里绑了 store ⇒ 它其实是应用外壳 |
| 10 | `components/Toasts.tsx:3` | `state/toast-store` | 同上 |

**影响（为什么这不是洁癖）**

- **纯函数测不了**：`features/graph/layout.ts` 与 `features/layout/tree-layout.ts` 是纯函数，
  但 `state/**` 依赖它们 ⇒ 任何只测模型的用例都得绕开 store 层；本仓 `vitest` 的
  `environment: 'node'` + `tests/setup.ts` 补 DOM，模型测试的隔离成本被这条依赖放大。
- **第二份实现随时会长出来**：mock-adapter 里已经出现"自己再实现一遍"的路径（§7.2）。
- **搬文件时连锁改动不可控**：任何一次 `features/**` 目录级的重组都会牵动 `state/**`。

**风险（爆炸半径）**

- 修 #1–#6 的**唯一正确手法是搬家**（纯模型下沉 `domain/**`）。搬家的风险点不在逻辑，
  而在**import 路径的机械替换**：`features/graph/layout.ts` 被 6 个模块引用、
  `features/layout/tree-layout.ts` 被 4 个引用 —— 都必须同一次改完，否则 typecheck 会拦住（这是好事）。
- 修 #8（环）风险最高：`openNote` 是 30 个导出动作里被复用最多的一个。动作本身没有单测能直接看见，
  只能靠 `tests/tabs.test.tsx` 与 `tests/note-store.test.ts` 间接覆盖 ⇒ 放最后做。

### 1.3 `theme/**` 的待收窄（本轮不修，先记下）

`state/ui-store.ts:12` 从 `theme/apply.ts` 取 `DEFAULT_THEME_ID` / `getTheme` / `nextThemeId` —— 都是纯函数，
但 `theme/apply.ts` 同时是 DOM 写入者（`applyTheme` 写 `<html>` 行内变量）。层规则放行 `state → theme`，
但纯契约与渲染适配应该分开：`theme/tokens.ts`（纯）+ `theme/apply.ts`（只留 `applyTheme`）。

### 1.4 唯一的模块级循环

```
app/actions.ts:20  → state/tabs-store
state/tabs-store.ts:48 → app/actions  （openNote）
```

ESM 下不必然报错，但它是**初始化顺序地雷**：`tabs-store` 的模块级代码一旦开始读
`openNote` 的绑定（而不是在调用时才读），就会拿到 TDZ/undefined。现状没炸是因为只在函数体内调用。
门禁已经把这一对边冻结，并要求"删任一条就必须删两条"（环的两条边都在白名单里）。

### 1.5 建议

按 ADR-0060 §2 分六个阶段搬（P1 布局 → P2 图谱 → P3 命令表 → P4 消环 → P5 控件归位 → P6 domain 纯净），
每阶段的验收判据统一是"**门禁里对应登记被删除**"。

---

## 2. 文件体积与"上帝模块"

### 2.1 24 个文件超过 600 行（`src/**` 共 217 个文件）

```
3176 ipc/mock-adapter.ts              1018 app/actions.ts              782 features/vault/FileTree.tsx
2635 features/graph/GraphCanvas.tsx    986 features/graph/layout.ts     780 state/note-store.ts
1693 styles/app.css                    896 ipc/types.ts                 777 features/graph/force.ts
1514 state/graph-store.ts              867 state/settings-store.ts      758 state/vault-store.ts
1261 features/editor/…/build.ts        854 features/graph/link-edge.ts  724 features/export/site-export.ts
1229 features/graph/canvas/paint.ts    824 features/graph/canvas/text-layout.ts
1102 features/graph/canvas/blocks.ts   817 features/graph/graph.css     677 features/layout/tree-layout.ts
                                       807 domain/markdown-core.ts      614 features/preview/MarkdownPreview.tsx
                                       786 app/builtin-commands.ts      605 features/export/export-html.ts
```

**影响**：单文件越大，"改动 A 会不会碰坏 B"就越难判定；本仓的图谱域（`features/graph/**`
共 23 个文件、合计约 13k 行）已经有 8 个文件超线 —— 它是**第二个"域级上帝模块"**，
`GraphCanvas.tsx` 2635 只是它最外面的一层。

**风险**：四个最重的模块（mock-adapter / GraphCanvas / graph-store / actions）都是**高价值+高流量**文件，
任何整文件重写都无法审查。**建议一律采用"搬行 + 再导出薄壳"**，让调用点零改动（ADR-0060 §3）。

### 2.2 `GraphCanvas.tsx` 的真实形状

- 单个 `GraphCanvas()` 函数体：**398 → 2600 行（2203 行）**，函数内 13 个 `useEffect`、
  14 个 `useRef`、13 个 `useState`、23 个 `useCallback`、23 个 `useMemo`，`useGraphStore` 引用 83 次。
- 内部已有 10 处段注释（数据加载 / 布局 / 视口换算 / 力导向浮动态 / 画笔入参 / 定位笔记 /
  尺寸上报 / 交互 / wikilink 高亮 / 卡片回调）—— **拆分的边界已经写在注释里**，照抄即可。
- 模块级已经全是纯函数（`edgeWeight:201`、`topPaneZ:241`、`applySimulation:269`、`countOverlaps:296`、
  `boundsOfRects:315`、`edgeTargets:337`、`sameHoveredLink:348`、`compactLinesFor:386`）
  ⇒ 它们可以**零风险**先搬进同级 `model/*.ts`。
- 最难搬的一块是 675-907 的浮动态：**位置刻意不进 React state**，`visibleWorldRect` 是一个
  "绘制与命中测试共享"的 ref（681-690 的注释就是为这件事写的）。搬 hook 时必须传同一个 ref。

### 2.3 `state/graph-store.ts` 的真实形状

一个 store 里塞了四份状态：**图谱数据**（`status/data/error/rootPath/ego/egoStatus/egoError/texts`）、
**视口**（`view/viewport/collapsed/manual/fitKey/egoBounds/selected`）、**卡片**（尺寸表、完整态、
浮窗面板、z 序）、**力导向参数**（张力、预设、逐参数覆盖）。约 31 个状态字段 + 42 个 action（声明行首统计）。
另有 400ms 防抖的持久化与三个 localStorage 键混在里面。

**建议**：按 ADR-0060 §3(b) 拆 5 个文件，`state/graph-store.ts` 保留为再导出 ——
`useGraphStore` 的对外形状不变，`features/**` 一行不用改。

---

## 3. 组件边界：容器 / 视图 / 纯逻辑是否混在一处

判据（门禁管不到，靠 review 与 ADR-0060 §3 的规则）：

| 类别 | 判据 | 现状问题 |
| --- | --- | --- |
| 纯逻辑 | 不 import React、不碰 DOM、不读 store | `GraphCanvas.tsx` 里 8 个纯函数（§2.2）与 `app/actions.ts` 的 `targetDirectoryForNewNote`/`linkSummary` 都混在 UI/动作文件里；`graph-store.ts` 里 `clampForceParam`/`formatForceParam`/`clampCardWidth`/`isStoredPrefs`/`readForceParams` 也是纯函数 |
| hook | 订阅+派生+副作用绑成一件事，或跨 ≥2 条渲染路径复用 | `GraphCanvas.tsx` 的 13 个 effect 全在组件体内，无法单独测 |
| 子组件（视图） | 只收 props | `GraphFolder`（2601+）是干净的；`canvas-view` 段（1853-2600）还没独立 |
| 容器 | 接 store | `GraphCanvas()` 同时是容器、视图、控制器、动画循环宿主 |

**影响**：`GraphCanvas` 的任何一个交互 bug 都必须在 2635 行里定位；`tests/graph-drag.test.tsx`
（挂真 DOM + 真 store）成了唯一防线，而它跑一次要等 `maxWorkers: 6` 的整套调度。

**风险**：把 effect 拆成 hook 时最容易犯的错是**复制 ref**（§2.2 第三条）。建议每个 hook
显式接收它需要的 ref 并在类型上标注 `RefObject<…>`，不新建。

**建议**：`GraphCanvas.tsx` → 7 个文件（`canvas-api.ts` / `use-graph-data.ts` / `use-force-sim.ts` /
`use-canvas-input.ts` / `use-card-links.ts` / `canvas-view.tsx` / `GraphFolder.tsx`），见 ADR-0060 §3(a)。
**这条任务必须由 Lead 亲自跑 E2E 验收**：画布是像素与指针级的，单测看不见。

---

## 4. 状态切分

| store | 物理行 | 职责 | 判定 |
| --- | --- | --- | --- |
| `graph-store.ts` | 1514 | 数据 + 视口 + 卡片 + 浮窗 + 力参数 + 持久化 | ❌ 四合一（§2.3） |
| `ui-store.ts` | 447 | 视图模式 / 主题 / 树排序 / 布局 / 布局迁移 | ⚠️ 混了**布局模型**（应为 domain）与**界面偏好**（应为 state）；且它是 3 条越界的出处 |
| `tabs-store.ts` | 541 | 标签页 + 布局对账 + **调 `openNote`** | ❌ 既做状态又做动作（环的来源） |
| `note-store.ts` | 780 | 文档内容 / 脏标记 / 保存 | ✅ |
| `vault-store.ts` | 758 | Vault 生命周期 / 条目表 / 监听 | ✅ |
| `settings-store.ts` | 867 | 偏好（真相是 Vault 内 config 文件） | ✅ 单一写者，符合 ADR-0055 §4 |
| `keymap-store.ts` / `links-store.ts` / `tags-store.ts` / `toast-store.ts` / `confirm-store.ts` / `inbox-store.ts` / `template-store.ts` | — | 各自一件事 | ✅ |

**建议**：`ui-store` 与 `tabs-store` 的越界随 P1 一起解决（不搬 store 本身，只把纯模型搬到 `domain/layout/**`）。
`graph-store` 按 §2.3 拆；**不要**把拆出来的 store 再合并回一个大 store（那正是现状）。

---

## 5. IPC 契约层

- `ipc/types.ts` 896 行、53 组 DTO + 5 组枚举 + `ErrorCode`/`KNOWN_CODES`，由 `scripts/check-ipc.mjs`
  与 Rust 侧做**三方一致性**校验（命令名 / 错误码 / DTO 字段 / 枚举）✅ —— 这是本仓最结实的一块。
- 建议①：**位置不动**（ADR-0060 §1）。`domain/**` 需要 `EntryMeta` 时用 `import type` 即可。
- 建议②：`ipc/mock-adapter.ts` 3176 行是这一层唯一的体积问题，且它是**第三个领域实现**（§7.2）。
  拆分时唯一要连带改的非业务文件是 `scripts/check-ipc.mjs` 的 `TS_MOCK` 常量。
- 建议③：`ipc/types.ts` 继续膨胀时的拆法已写进 ADR（按 Rust 命令模块分文件 + `TS_TYPES` 改目录列表），
  **但不要现在做**：它会让 `check-ipc.mjs` 与 50+ 个 import 点同时搬家，收益只是层级图好看。

---

## 6. 样式归属与死代码

### 6.1 现状实测

- **29 个样式表、0 个 CSS Modules**；`styles/app.css` 1693 行 / 19 个段注释 / 221 处 `mn-` 类引用 / 154 个类。
- 全部 **592 个 `mn-*` 类名**分布在 29 个文件里；按 BEM **块**（到第一个 `__`/`--` 为止）归并后 **85 个块**，
  其中 **19 个块被 2 个以上文件定义**（跨文件"一个块四条判据"）。
- **16 个类名跨文件重复**定义（`mn-button--small`、`mn-dialog__header`、`mn-preview__body`…）。
- **无死样式**：29/29 被 import；另有 71 个类名在 TS/TSX 字符串里找不到（大多是 `--modifier`
  由运行时条件拼接、或由 CSS 自身状态选择器命中，**不是**死代码，但需要一条"拼类名"的约定来审计）。
- `!important` 9 处（§0.2）。
- **72% 的 E2E 选择面靠 `.mn-*`**：`e2e/*.ts` 里 `mn-…` 出现 **610 处**，`tests/` 里 **744 处**。

### 6.2 优先级不是"加载顺序随机"，而是**同权重的胜者取决于打包顺序**

`main.tsx` 的 import 顺序是：`@/app/bootstrap`(6) → `@/App`(7) → `@/components/ErrorBoundary`(8) →
`./styles/app.css`(10)。ESM 按源码顺序求值 ⇒ **App 的整棵子树（含 33 条 feature CSS import）
先求值，app.css 最后求值** ⇒ 打包产物里 app.css 的规则**排在最后**。

于是"基座样式"拿到了**最高的同权重优先级**。这不是假设，代码里已经留下了证据：
`features/vault/tag-filter.css:10` 的注释写着——

> "用复合选择器而不是单类名：`flex-wrap` 是覆盖 app.css 的 `.mn-tree-toolbar`，
> 同优先级下谁赢取决于两个样式表的加载顺序 —— 复合选择器把这件事变成确定的。"

**结论**：`@layer` 四层（`mn.tokens < mn.base < mn.components < mn.features`）不是风格偏好，
它把这条"靠复合选择器兜住"的隐式契约变成显式声明。层序声明写在**每个文件顶部**（幂等），
因此与打包/注入顺序彻底无关。

### 6.3 `styles/app.css` 已经失去自解释性

它的最后一段注释是 `/* ---- 滚动条 */`（1659），滚动条规则到 1685 结束 ——
紧接着 **1686-1693 是 `.mn-inline-tag`（行内标签，属于预览渲染管线）**，没有任何段注释。
一个"基座样式表"把渲染管线的规则贴在滚动条后面，正是"新规则随便找个地方塞"的证据。

### 6.4 `app.css` 的机械拆解表（每行的目标文件）

| 行区间 | 段（现有注释） | 定义的块 | 目标 |
| --- | --- | --- | --- |
| 1-42 | 头部注释 + 2× `@font-face` + `:root` 兜底令牌 | — | `styles/tokens.css` |
| 44-59 | `:where(::selection)` | — | `styles/base.css` |
| 61-166 | VI 别名层 `:root`（ADR-0031） | — | `styles/tokens.css`（`tests/design-tokens.test.ts` 继续管） |
| 168-173 | `prefers-reduced-motion` | — | `styles/base.css` |
| 175-195 | `.mn-visually-hidden` + `kbd` | `mn-visually-hidden` | `styles/base.css` |
| 197-307 | 布局 | `mn-app` `mn-body` `mn-pane` `mn-window-controls` | `features/layout/shell.css`（+ `features/window/window-controls.css`） |
| 308-330 | 分隔条 | `mn-splitter` | `components/splitter.css` |
| 331-512 | 文件树栏 | `mn-tree` `mn-tree-row` `mn-tree-toolbar` `mn-search-field` `mn-icon-button` | `features/vault/tree.css` + `components/ui-controls.css`（`mn-icon-button`） |
| 513-560 | 编辑器 | `mn-editor` | `features/editor/editor-shell.css` |
| 561-870 | 预览 / callout / 任务 / 占位图 | `mn-preview` `mn-callout` `mn-task-item` `mn-image-placeholder` | `features/preview/preview.css` |
| 871-902 | 冲突横幅 | `mn-conflict` | `features/status/conflict-banner.css` |
| 903-1010 | 状态栏 | `mn-statusbar` `mn-status-dot` | `features/status/status-bar.css` |
| 1011-1108 | 按钮与控件 | `mn-button` `mn-icon` `mn-empty` | `components/ui-controls.css` |
| 1109-1163 | 提示条 | `mn-toast` `mn-toasts` | `components/toasts.css` |
| 1164-1209 | 对话框 | `mn-dialog` `mn-overlay` | `components/dialog.css` |
| 1210-1295 | Vault 门闸 | `mn-gate` | `features/vault/vault-gate.css` |
| 1296-1337 | 崩溃界面 | `mn-crash` | `components/error-boundary.css` |
| 1338-1483 | 链接面板 | `mn-links` `mn-wikilink` | `features/links/links-panel.css` + `features/preview/preview.css`（`mn-wikilink`） |
| 1484-1658 | 命令面板 / 快切 / 全文搜索 | `mn-palette` `mn-overlay` | `features/palette/palette.css` |
| 1659-1685 | 滚动条 | — | `styles/base.css` |
| **1686-1693** | **无注释**（`.mn-inline-tag`） | `mn-inline-tag` | `features/preview/preview.css` |

拆完之后 **删除 `app.css`**；门禁给它的行数预算是"只许下降"（1693 → 0）。

### 6.5 19 个跨文件块：归属判据

按 ADR-0060 §4 的一句话判据判定：块只被一个功能域用 → 该域的样式文件；被 ≥2 个域用 → 通用控件；
只声明变量 → `tokens.css`。19 个块里，最需要先处理的是 `mn-tree`（4 个文件写）、
`mn-preview` / `mn-wikilink`（3 个文件写，而它们对应的 `domain/links.ts` 是**单一判据**——
样式与判据的单一程度不匹配才是真问题）。

---

## 7. 可测试性

### 7.1 现状

- 127 个测试文件 / 2222 条用例全绿；`vite.config.ts` 的 `include` **只有** `tests/**`
  （源码目录里放测试不会被执行）。
- 按被 import 的层统计：`state` 195 处、`features` 186 处、`ipc` 142 处、`domain` 66 处、
  `app` 60 处、`components` 10 处、`theme` 4 处。
- 覆盖率最高的入口：`ipc/client`、`ipc/mock-adapter`（**56 个测试文件**）、`state/vault-store`、
  `state/note-store`、`app/actions`。

**影响**：`domain` 只有 66 处 import —— 而它本该是被测得最密的一层（纯函数、零成本）。
纯模型住在 `features/**` 是直接原因（§1.2）。

### 7.2 mock-adapter 是"第三个领域实现"（本轮最值得注意的发现）

`ipc/mock-adapter.ts` 里 41 个 `mockXxx` 自己实现了一遍领域算法，与另外两份并存：

| mock 里的实现 | 第二份（前端 domain） | 第一份（Rust 权威） |
| --- | --- | --- |
| `mockExtractLinks:165` / `mockRewriteLinks:468` / `rebuildLink:444` | `domain/links.ts` | `mn-index` 的链接解析 |
| `mockScanInlineTags:758` / `mockSetTags:924` / `mockRenameTags:1301` | `domain/inline-tags.ts`、`domain/frontmatter.ts` | `mn-core::tags` / `frontmatter` |
| `mockParseFrontmatter:696` / `classifyFrontmatterValue:686` | `domain/frontmatter.ts` | `mn-core::frontmatter` |
| `mockSearch:1440` / `mockSearchScore:1435` / `mockSnippet:1415` | —（搜索只在 Rust） | `mn-index` FTS5 |
| `mockSite*`（站点导出计划） | `domain/site-paths.ts` 等 | `mn-index::site` |

`domain/attachments.ts:6` 的注释已经承认过这件事的反面价值（"放在纯函数里能用 vitest 逐条钉死，
**也能让 Mock 适配器复用**"）—— 也就是说**方向早就定了，只是没有全部落地**。

**建议**（价值高、但要单独一轮，不要和拆分混在一起）：让 mock 复用 `domain/**` 的纯函数，
把"mock 与宿主的行为差"从"两份实现"变成"一份实现 + 一份显式差异清单"。
门禁管不了这件事，判据只能靠 review。

### 7.3 建议

1. P1/P2 把纯模型搬进 `domain/**` 后，`tests/` 里应新增**纯函数用例**（现在 `domain` 只被 import 66 处）。
2. 拆分四个上帝模块时，**一律不改断言**（除 import 路径）—— 改动断言就等于改了行为，
   那就不再是"等价重构"，验收也就不成立。
3. 画布与编辑器这类像素/指针级行为，只有 E2E 能兜住 ⇒ `GraphCanvas` 拆分必须配一次 UI E2E。

---

## 8. 门禁与"自证会红"

### 8.1 交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/check-architecture.mjs` | 四组规则：依赖方向 + domain 纯净 + 模块级零循环 + 样式归属/体积 |
| `scripts/architecture-allowlist.json` | 债务登记（10 越界 / 2 个 domain DOM 文件 / 1 个环的两条边 / 19 共享块 / 29 待分层 / 9 处 important / 24 待拆文件） |
| `scripts/check-architecture.test.mjs` | 29 条用例：15 条纯解析器 + 11 条临时目录端到端（造违规 ⇒ 必须红）+ 3 条真实仓库集成 |
| `package.json` | 新增 `check:architecture`，并接进 `pnpm check`（在 `check:ipc` 之后、`typecheck` 之前） |

`pnpm check:architecture` 当前输出：

```
架构校验通过：217 个源文件 / 29 个样式表、760 条值依赖（冻结越界 10 条、冻结环 2 条）、
!important 9 处、跨文件共享块 19 个、待迁移分层 29 个、待拆文件 24 个
```

债务只减不增的执行机制有两条：**新违规直接红**；**登记过期也红**（修好了却忘删登记 ⇒ 红），
所以清单不可能"只加不减"。

### 8.2 自证有效（在真实仓库里注入 5 类违规，逐类确认变红，然后还原）

| 注入 | 门禁输出（关键行） | 退出码 |
| --- | --- | --- |
| `state/zz-probe.ts` 值依赖 `features/graph/layout` | `依赖方向：…/state/zz-probe.ts:1 → …/features/graph/layout.ts（state 不得值依赖 features）` | 1 |
| `domain/zz-probe.ts` 用 `document.createElement` | `domain 纯净性：…/domain/zz-probe.ts 使用了浏览器全局（L1 …document.createElement('div')）` | 1 |
| 未分层的 `features/graph/zz-probe.css`（并被 import） | `样式分层：…zz-probe.css:1：第一行必须是层序声明 @layer mn.tokens, mn.base, mn.components, mn.features;` | 1 |
| `domain/zz-big.ts`（700 行，未登记） | `文件体积：…/zz-big.ts 有 700 行，超过 600 行且没有登记为待拆` | 1 |
| `state/zz-a.ts` ↔ `zz-b.ts` 互引 | `循环依赖：…zz-a.ts:1 → …zz-b.ts 落在同一个环里`（两条边都报） | 1 |
| **全部还原** | `架构校验通过：…` | **0** |

`git status` 确认四个探针文件全部删除、业务代码零改动（唯一非本次交付的改动见 §0.3 说明）。

端到端用例还把另外 6 类红固化成了回归测试：死样式、待拆长胖、登记过期、登记文件缺失、
层名写错、CSS 住在不认识的位置。另有 1 条**跨文件一致性**用例：
`--print-baseline` 的输出必须与仓库里登记的清单**逐条相同** —— 防止"实际状态"与"冻结状态"悄悄漂移。

### 8.3 门禁自身修过的 4 个 bug（都是写用例时逼出来的）

1. `root → root` 被误判成越界（`ALLOWED_TARGETS.root` 漏了 `'root'`）；
2. `physicalLines` 用 `split('\n').length`，结尾换行会多算 1 行（与编辑器/`git diff --stat` 对不上）；
3. `checkCssLayering` 的花括号配对**差一位**（把包装行的 `{` 算进了"包装之外"）；
4. `domain` 纯净性最初按 `file:line` 登记 —— 那会在任何一次无关编辑后变红。
   改成按**文件**登记；结论写进 ADR：**白名单不按行号**。

---

## 9. 改造 backlog（按价值/风险排序）

**协调规则（重要）**：`scripts/architecture-allowlist.json` 由 **Lead 独占维护**。
每条任务的交付里要写明"验收时应删除的登记条目"，Lead 在合并时统一删 ——
否则 4 个队友会同时改同一个 JSON。

| # | 任务 | 写权限范围（互不重叠） | 验证方式 | 依赖 / 并行 |
| --- | --- | --- | --- | --- |
| **B1** | **样式分层 + `app.css` 拆解**：29 个样式表加层序声明与层包装；`app.css` 按 §6.4 表拆成 `styles/tokens.css` + `styles/base.css` + 9 个 feature/component 文件并**删除 `app.css`**；删掉 `export.css` 的 5 处 `!important` | `apps/desktop/src/styles/**`、`apps/desktop/src/components/*.css`、`apps/desktop/src/features/**/*.css`、`apps/desktop/src/main.tsx` | ①`pnpm check:architecture`（29 条 `cssPendingLayers` 清空、`importantTotal` 9→4）②`pnpm build` 后确认产物 `dist/assets/*.css` 里**层序声明出现在第一条 `@layer`**③`npx vitest run tests/design-tokens.test.ts` ④`pnpm test:e2e:ui:smoke` | **无依赖，可并行**；独占全部 CSS |
| **B2** | **布局纯模型下沉（P1）**：`features/layout/tree-layout.ts`+`layout-sync.ts`+`features/dock/dock-layout.ts` → `domain/layout/**`；改 `ui-store`/`tabs-store`/`app/builtin-commands` 的 import | `apps/desktop/src/features/layout/**`、`features/dock/**`、`src/domain/layout/**`（新）、`src/state/ui-store.ts`、`src/state/tabs-store.ts`、`src/app/builtin-commands.ts`、`apps/desktop/tests/**`（只改 import 路径） | ①`pnpm typecheck`②`npx vitest run tests/layout-store.test.ts tests/tree-host.test.tsx tests/tabs.test.tsx tests/columns-tree.test.tsx`③门禁删 4 条登记（ui-store×3、tabs-store×1）后绿 | **无依赖，可并行**（与 B3 目录不重叠）；同时消掉 `tree-layout.ts` 677 行的待拆登记 |
| **B3** | **图谱纯模型下沉（P2）**：`features/graph/{layout,force,force-presets,layout-ego,viewport}.ts` → `domain/graph/**`；改全部引用点（含 `state/graph-store.ts` **只改 import 行**） | `apps/desktop/src/features/graph/{layout,force,force-presets,layout-ego,viewport}.ts`、`src/domain/graph/**`（新）、`src/state/graph-store.ts`（仅 import）、`apps/desktop/tests/graph-*.test.ts*` | ①`pnpm typecheck`②`npx vitest run tests/graph-force.test.ts tests/graph-paint.test.ts tests/graph-link-edge.test.ts tests/graph-view-prefs.test.ts tests/graph.test.tsx`③门禁删 2 条登记 | **无依赖，可并行**；是 B5/B6 的前置 |
| **B4** | **`app/actions.ts` 拆分**：拆到 `app/actions/{notes,directories,tags,vault}.ts`，`app/actions.ts` 变再导出薄壳（调用点零改动） | `apps/desktop/src/app/actions.ts`、`src/app/actions/**`（新） | ①`pnpm typecheck`②`npx vitest run tests/tabs.test.tsx tests/rename.test.tsx tests/move-note.test.tsx tests/vault-flow.test.ts tests/tag-rename.test.tsx tests/tag-move.test.tsx tests/dir-move.test.tsx tests/inbox-store.test.ts`③门禁把 `actions.ts` 的待拆值下调 | **无依赖，可并行**；**不要动 `tabs-store.ts` 的 import**（那是 B2 的范围） |
| **B5** | **`ipc/mock-adapter.ts` 拆分**：拆到 `ipc/mock/{vault,links,tags,search,site,index}.ts`，`mock-adapter.ts` 变再导出薄壳；同步改 `check-ipc.mjs` 的 `TS_MOCK` | `apps/desktop/src/ipc/mock-adapter.ts`、`src/ipc/mock/**`（新）、`scripts/check-ipc.mjs`（仅 `TS_MOCK` 常量） | ①`pnpm check:ipc`（43 条命令三方一致）②`pnpm test:scripts`③`npx vitest run tests/vault-flow.test.ts tests/tags.test.tsx tests/search.test.tsx tests/site-export.test.tsx tests/graph-ego-mock.test.ts tests/tag-edit.test.tsx`④门禁下调 mock-adapter 的待拆值 | **无依赖，可并行**；56 个测试文件依赖其导出符号，**不许改名** |
| **B6** | **`state/graph-store.ts` 拆分**：按 §2.3 拆 5 个文件 + 再导出 | `src/state/graph-store.ts`、`src/state/graph-*.ts`（新）、`src/domain/graph/prefs.ts` | ①`pnpm typecheck`②`npx vitest run tests/graph-ego-store.test.ts tests/graph-view-prefs.test.ts tests/graph-drag.test.tsx tests/graph.test.tsx`③门禁下调待拆值 | **blocked_by B3**（同域，且 B3 会改这个文件的 import） |
| **B7** | **`features/graph/GraphCanvas.tsx` 拆分**：7 个文件（含 `use-force-sim.ts` 共享同一个 `visibleWorldRect` ref） | `apps/desktop/src/features/graph/GraphCanvas.tsx`、`src/features/graph/{canvas-api.ts,use-graph-data.ts,use-force-sim.ts,use-canvas-input.ts,use-card-links.ts,canvas-view.tsx,GraphFolder.tsx}`（新） | ①`pnpm typecheck`②`npx vitest run tests/graph-drag.test.tsx tests/graph-find.test.tsx tests/graph-ego-preview.test.ts tests/graph.test.tsx`③**`pnpm test:e2e:ui`（Lead 亲自跑）**④门禁下调待拆值 | **blocked_by B3**；**风险最高，放最后** |
| **B8** | **消除唯一的环（P4）**：`tabs-store` 只暴露"请求打开"的意图，`app/**` 订阅后执行 `openNote` | `src/state/tabs-store.ts`、`src/app/actions.ts`（或 `app/actions/notes.ts`）、`src/app/builtin-commands.ts` | ①门禁 `cycles` 清空（删 2 条）②`npx vitest run tests/tabs.test.tsx tests/note-store.test.ts tests/palette.test.tsx` | **blocked_by B2 + B4**（同一批文件） |
| **B9** | **控件归位（P5）**：`components/ConfirmDialog.tsx`、`Toasts.tsx` → `features/`（它们的样式文件是否一起搬见下方注） | `apps/desktop/src/components/ConfirmDialog.tsx`、`components/Toasts.tsx`、`src/features/shell/**`（新）、`src/App.tsx`、`apps/desktop/tests/**`（只改 import） | ①门禁删 2 条 `components` 登记②`npx vitest run tests/app-shell.test.tsx` | **blocked_by B1**：B1 会把 `app.css` 里的对话框/提示条块落到 `components/dialog.css` / `components/toasts.css`；B9 应带着这两个样式文件一起搬进 `features/shell/`（**先 B1 后 B9，避免同一批 CSS 被两个人写**） |
| **B10** | **domain 纯净性（P6）**：`domain/clipboard.ts`（DOM）搬到 `features/`（或新 `platform/`）；`domain/keymap.ts` 的 `navigator` 检测改为参数注入 | `src/domain/clipboard.ts`、`src/domain/keymap.ts`、`apps/desktop/tests/**`（只改 import） | ①门禁 `domViolations` 清空②`npx vitest run tests/keymap.test.ts`（若存在）+ `pnpm typecheck` | **无依赖，可并行**（中价值、低风险） |
| **B11** | **mock 复用 domain 纯函数**（§7.2，价值最高但要单独一轮） | `src/ipc/mock/**`、`src/domain/**` | ①`npx vitest run tests/tags.test.tsx tests/tag-edit.test.tsx tests/tag-move.test.tsx tests/tag-rename.test.tsx tests/attachments.test.ts`②差异清单写进注释（"mock 与宿主的行为差"） | **blocked_by B5**（否则会和拆分撞车） |

**建议的 4 人分工（写权限互不重叠）**

- 队友 A：**B1**（独占全部 CSS，是唯一不会与别人冲突的整块工作）
- 队友 B：**B3 → B6 → B7**（图谱域一人到底，含关键路径上与画布有关的全部风险）
- 队友 C：**B2 → B9**（布局模型下沉；B9 要等队友 A 的 B1 落地后再动 `components/`）
- 队友 D：**B5 → B4**（两个"再导出薄壳"型拆分，手法相同，先做最重的 mock）
- Lead：维护 `scripts/architecture-allowlist.json`、跑 `pnpm test:e2e:*`、B8/B10 收尾

关键路径是**队友 B 的 B3 → B6 → B7**（图谱域 13k 行、8 个超标文件、风险最高、且 B7 必须由 Lead 跑 E2E）；
其余三条线可以与它并行推进、互不阻塞。

**每条任务共同的验收（缺一不可）**

1. `pnpm typecheck` 通过；
2. 指定用例全绿，且**断言一行没改**（只允许改 import 路径）；
3. `pnpm check:architecture` 通过，且登记条目**只减不增**（Lead 删条目后）；
4. 交付说明里列出"删掉了哪些登记 / 有没有新增任何登记 / 为什么"。

---

## 10. 我认为**不该动**的地方

1. **`scripts/check-ipc.mjs` 的 `DTO_MANIFEST`/`ENUM_MANIFEST` 与 `ipc/types.ts` 的字段集合**
   —— 三方一致性判据，不要"顺手整理排序"。B5 只允许改 `TS_MOCK` 一行。
2. **`domain/**` 里已有的纯函数**（`inline-tags.ts` 的区间判据、`tree.ts` 的排序、`links.ts` 的解析）
   —— mock 与前端都应复用它，**不要为了拆 mock 复制一份**（那是把"两个真相"变成三个）。
3. **`EditorView.theme` 的样式装配方式**（`features/editor/cm/*/theme.ts`）
   —— 随扩展装配/卸载、自动加编辑器实例前缀，是 CM6 的正确用法。门禁反过来在**冻结** CSS 里的
   `.cm-*` 选择器（≤3），新的编辑器样式一律走 `EditorView.theme`。
4. **`features/settings/font-overrides.ts` 的双路径**（内联变量 + 一条 `!important` 作者样式）
   —— 这是 ADR-0031 §3 判据（`applyTheme` 整批重写内联令牌时不能冲掉用户字号），动它会静默失效。
5. **`state/graph-store.ts` 的"两条加载路径"**（`keepView` 保留视角刷新 vs 完整重载，
   文件头 13-23 行注释）—— 踩过的坑，拆分时按原样搬，别"合并成一个函数"。
6. **`tests/**` 的断言**（除 import 路径）—— 改了断言就不是等价重构，验收随之失效。
7. **`main.tsx` 的 import 顺序**：B1 把 `styles/app.css` 换成了 16 行逐份 import。
   > **实施中的一处有意例外（B1 落地后修订）**：这段样式清单被**刻意排到了 `@/App` 之前**，
   > 并按 tokens → base → components → features 分组。原因是实施时发现的真事实：
   > `@layer` 的**声明语句**会被 CSS 压缩器删掉（构建期已解析定序），于是"顺序无关"这条前提在
   > minified 产物里并不成立 —— 让**构造顺序**也等于层序是第二道保证。
   > 实测：挪到 `@/App` 之后，未压缩产物第一段立刻变成 `features/trash/trash-dialog.css`。
   > 这条由 `scripts/check-css-layers.mjs` 钉住（源侧查分组与位置、产物侧查四层首次出现顺序）。
   > 完整记录见 ADR-0060 的「后续修订」§3。
8. **`features → app` 的 39 处调用**：这是有意的"界面触发组合动作"，不是越界；
   把它们改成依赖注入是"为改而改"，门禁也把它列为放行方向。
9. **`ipc/types.ts` 的搬家**：等它继续膨胀再按 ADR-0060 §1 的判据拆，本轮不做。
10. **`domain/markdown-core.ts`(807) 的分层**：它是渲染管线的**单一判据**（五处消费同一套 token），
    体积超标但职责单一 —— 拆它会让"同一判据"变成"多个文件拼出来"，**宁可留着并登记为待拆**。

---

## 11. 结论

- **好消息**：`domain` 零值依赖向上、`ipc` 契约有三方门禁、333 处同层依赖边界清楚、
  29/29 样式表都有归属（无死样式）、2222 条单测全绿。这个仓库的**纪律很强**，缺的是
  "把纪律变成可执行判据"的那一层。
- **真问题**：纯模型住错层（→ 10 条越界 + 1 个环）、四处上帝模块、19 个样式块没有归属、
  同权重样式胜负取决于打包顺序（并且已经有人为它写过绕过方案）。
- **本轮的落点**：`docs/adr/0060-frontend-architecture.md` 定规则，
  `scripts/check-architecture.mjs` + 债务登记把规则变成"只许变小"的门禁，
  `architecture-review.md` 的 backlog 把改造切成写权限互不重叠、可以并行执行的 11 条任务。

## 12. 附：本文所有数字的测量命令

```pwsh
# 物理行数（PowerShell 的 (Get-Content).Count 等价于 [System.IO.File]::ReadAllLines().Count）
# 上表用的口径门禁自己也实现了：scripts/check-architecture.mjs 的 physicalLines()
node scripts/check-architecture.mjs                       # 债务快照
node scripts/check-architecture.mjs --print-baseline      # 当前债务的 JSON（只打印）
node --test scripts/check-architecture.test.mjs           # 29 条用例
pnpm test:scripts                                         # 三个门禁脚本的全部用例
npx vitest run                                            # 127 文件 / 2222 条
pnpm check:ipc                                            # 43 命令 / 15 错误码 / 53 DTO / 5 枚举
```

层级矩阵 / 循环依赖 / BEM 块归属三项是从 `collectSnapshot()` 与 `findCycleEdges()` 直接导出的
（`scripts/check-architecture.mjs` 的导出函数，可被任意脚本 import）。
