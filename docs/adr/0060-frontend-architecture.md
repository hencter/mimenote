# ADR-0060：前端架构 —— 依赖方向、纯模型归属、组件拆分与样式分层

- 状态：已采纳
- 日期：2026-10-13
- 相关：ADR-0005（命令注册表）、ADR-0009（所见即所得）、ADR-0020（大文档预览）、ADR-0023（图谱物理与浮窗）、ADR-0026/0035（可停靠模块与容器切割树）、ADR-0031（设计令牌别名层）、ADR-0048（三格式 frontmatter 的纪律）、ADR-0055（键位与配置：把纯解析下沉 `domain/keymap.ts` 的先例）

## 背景

用户的原话是"CSS 也该模块化了，组件模块化整个项目的架构差得要命"。体检（`docs/architecture-review.md`）量到四类事实：

1. **依赖方向有 10 处越界，且都在同一个方向上**：纯逻辑层/状态层反向依赖界面层 ——
   `state/ui-store.ts:14,19,24` → `features/dock|layout`、`state/graph-store.ts:41,43` → `features/graph`、
   `state/keymap-store.ts:13` → `app/commands`、`state/tabs-store.ts:48,54` → `app/actions|features/layout`、
   `components/ConfirmDialog.tsx:5` / `Toasts.tsx:3` → `state/*`。其中 `app/actions.ts:20` ↔ `state/tabs-store.ts:48`
   是**全仓唯一的模块级循环**。
2. **纯模型住在界面层里**：`features/layout/tree-layout.ts`(677)、`features/dock/dock-layout.ts`、
   `features/graph/layout.ts`(986)、`force.ts`(777) 都是纯函数/纯数据，却住在 `features/**` ——
   这才让第 1 条成为"要么反向依赖、要么写第二份实现"的二选一。
3. **上帝模块**：24 个文件超过 600 行，四处最重 —— `ipc/mock-adapter.ts`(3176)、
   `features/graph/GraphCanvas.tsx`(2635，其中单个 `GraphCanvas()` 函数体 398→2600 行)、
   `state/graph-store.ts`(1514，约 50 个 state 字段 + 45 个 action)、`app/actions.ts`(1018)。
4. **样式没有归属**：29 个样式表、0 个 CSS Modules、`styles/app.css` 1693 行混着壳/状态栏/按钮/编辑器外壳/
   导出/提示条；19 个 BEM 块被 2 个以上文件各写一半（`mn-tree` 被 4 个文件写）；9 处 `!important`。
   而且**同权重的胜者取决于打包顺序**：`main.tsx:10` 的 `import './styles/app.css'` 排在 `@/App`(7) 之后，
   于是"基座样式"反而最后注入、优先级最高。`features/vault/tag-filter.css:10` 的注释已经为这件事写过
   绕过方案（用复合选择器 `.mn-tree-toolbar.mn-tree-toolbar--with-tags` 把顺序问题"变成确定的"）。

这四件事互相咬合：不把纯模型搬到 `domain/**`，依赖方向就修不掉；不先定样式归属，拆 `app.css` 就是
"从一个 1693 行文件搬成六个 300 行文件"（判据仍在四个文件里）；没有可执行门禁，任何一次重复劳动都会烂回去。

## 决策

### 1. 依赖规则：值依赖只许向下，同层内部自由

```
domain      → domain
ipc         → domain, ipc
theme       → ipc, theme
state       → domain, ipc, theme, state
components  → domain, ipc, components
features    → domain, ipc, theme, state, components, features, app
app         → 全部
src/*.tsx   → 全部（组合根）
```

- **只约束值依赖**：`import type` 被 `verbatimModuleSyntax`（`apps/desktop/tsconfig.json`）完全擦除，
  不构成运行时耦合，因此一律放行 —— 也就没有"为搬一个类型去动代码"的伪工作。
- **`ipc/types.ts` 位置不动，它就叫"宿主契约"**：它是 `scripts/check-ipc.mjs` 三方校验的中心，
  53 组 DTO + 5 组枚举 + `ErrorCode` 全部以它为 TS 侧唯一判据。`domain/**` 需要 `EntryMeta` 时，
  写 `import type { EntryMeta } from '@/ipc/types'` —— 类型擦除、零运行时耦合，且避免长出第二份结构类型
  （第二份 = 两条判据，与 ADR-0048/0055 的纪律相反）。
  **不**新建 `src/contract/**`：那会让 `check-ipc.mjs` 的 `TS_TYPES` 与 50+ 个 import 点同时搬家，
  换来的只是"层级图更好看"。等到 `ipc/types.ts` 继续膨胀（现在 896 行）再拆，判据是
  **按 Rust 侧命令模块分文件**（vault/notes/tags/graph/search/site/system），并同步把 `TS_TYPES`
  从"一个文件"改成"一组文件" —— 那是独立一轮。
- **`theme/**` 内部再收窄**：`theme/tokens.ts` 是纯契约（`ThemeManifest`/`REQUIRED_TOKENS`/`validateTheme`），
  `theme/apply.ts` 写 `<html>`、`theme/snippets.ts` 调 IPC，是渲染适配。`state/ui-store.ts:12` 现在从
  `theme/apply` 取 `getTheme`/`nextThemeId`/`DEFAULT_THEME_ID`（纯函数），**放行但记录为待收窄**：
  这三个符号应搬进 `theme/tokens.ts`，`apply.ts` 只留 `applyTheme`。
- **`features → app` 是放行方向**：界面点一下 → 调用组合动作，39 处调用点，本轮不动；把它列进放行名单
  而不是冻结成债务（把 39 处都改掉是"为改而改"）。它带来的反向边（`app → features`）由下面的
  "模块级零循环"规则兜住。

### 2. 纯模型该住哪：判据一句话，迁移分六个阶段

**判据：一个模块如果不 import React、不碰 DOM、不读 store，它就必须住在 `domain/**`。**
只要它还在 `features/**`，任何"状态层需要它"的地方就只能反向依赖 —— 这就是那 10 条越界的成因。

每阶段独立可验收，验收方式统一是"**门禁里对应的那条登记必须被删除**"（门禁会因为"登记已过期"变红，
逼你删）：

| 阶段 | 搬什么 | 落地位置 | 可验证判据 |
| --- | --- | --- | --- |
| P1 布局模型 | `features/layout/tree-layout.ts`(677) + `layout-sync.ts` + `features/dock/dock-layout.ts` | `domain/layout/*` | 删掉 `ui-store`×3 + `tabs-store`×1 四条登记；`tests/layout-*` / `tree-host` / `tabs` 只改 import 即全绿 |
| P2 图谱模型 | `features/graph/{layout,force,force-presets,layout-ego,viewport}.ts` | `domain/graph/*` | 删掉 `graph-store`×2 条登记；`tests/graph-force/graph-paint/graph-link-edge` 等纯函数用例只改 import 即全绿（E2E 选 `.mn-*` 与行为，不选模块路径，因此不受影响） |
| P3 命令表 | `app/commands.ts` 的注册表与键位解析 | `domain/commands.ts`，`app/commands.ts` 变再导出 | 删掉 `keymap-store` 那条登记；手法与 ADR-0055 把键位原语搬进 `domain/keymap.ts` 完全一致（实现一份、调用点零改动） |
| P4 消除唯一的环 | `state/tabs-store.ts:48` 直接调 `openNote` | store 只暴露"请求打开"的意图，`app/**` 订阅后执行 | 门禁的 `cycles` 清空 |
| P5 控件归位 | `components/ConfirmDialog.tsx` / `Toasts.tsx`（它们绑定 store，是应用外壳不是通用控件） | `features/` | 删掉 2 条 `components` 登记 |
| P6 domain 纯净 | `domain/clipboard.ts`（`document.execCommand`/`navigator.clipboard`）、`domain/keymap.ts:244-245`（`navigator.platform`） | 浏览器适配移到 `features/` | 删掉 `domViolations` 两条登记 |

排序依据：P1/P2 一次搬家同时消掉 6 条越界与 6 个"待下沉"的大文件，价值最高、风险最低（纯函数、单测密集）；
P4 动的是全仓唯一的环，价值高但爆炸半径最大，放最后。

### 3. 组件拆分规则：行数是触发器，怎么拆看四条判据

**拆的判据（按优先级）**

1. **>600 行必须拆**（门禁硬线）。但这只是触发器。
2. **纯逻辑先出去**：任何"输入 → 输出、不碰 ref/DOM/store"的段落，先搬成同级 `*.ts`。
   判据：它能在 node 环境（本仓 `vitest` 的 `environment: 'node'`，DOM 由 `tests/setup.ts` 补）直接测。
3. **hook 第二**：把"订阅 store + 派生 + 副作用"绑成一件同一生命周期的事，或跨 ≥2 条渲染路径复用的段落，
   抽 `use-*.ts`。**只用一次的 hook 不算拆分**，它只是把行数搬了个家。
4. **子组件第三**：JSX 超 ~150 行、或有自己的局部 state/事件处理的块 → 独立 `XxxYyy.tsx`。
   容器/视图的判据：**接 store 的是容器（`XxxHost.tsx`），只收 props 的是视图（`XxxView.tsx`）**。
5. **常量表与参数域**：>40 行的表（力导向参数范围、卡片高度档位）搬进 `model/*.ts`，组件只引用。

**四处具体拆法**

**(a) `features/graph/GraphCanvas.tsx` 2635 → 6 个文件**（`GraphCanvas()` 单函数 2203 行）

| 新文件 | 搬哪段 | 职责 |
| --- | --- | --- |
| `features/graph/canvas-api.ts` | 398-560 | 入口组件：refs、视口尺寸上报、把下面几块拼起来 |
| `features/graph/use-graph-data.ts` | 553-680（数据加载 effect + store 订阅） | 加载/刷新/自动刷新订阅 |
| `features/graph/use-force-sim.ts` | 675-907 | 浮动态：rAF 时钟、热度衰减、`simRef` 所有权 |
| `features/graph/use-canvas-input.ts` | 1343-1451 | 滚轮/拖动/平移/命中测试（含 pointer 与 `hitTest` 的 ref 契约） |
| `features/graph/use-card-links.ts` | 1452-1852 | 卡片内 wikilink 热区 → 高亮连线 |
| `features/graph/canvas-view.tsx` | 1853-2600 | JSX：卡片、容器、HUD，只收 props + 回调 |
| `features/graph/GraphFolder.tsx` | 2601+ | 已经是子组件，直接搬出去 |

**风险点**：681-690 的注释说明"位置**不进 React state**，命中测试与绘制读同一份 ref"——
搬 hook 时必须把这**同一个 ref 传进去**，不能在 hook 里复制一份（复制 = "看到的"与"点得中的"分家）。

**(b) `state/graph-store.ts` 1514 → 5 个文件**

| 新文件 | 内容 |
| --- | --- |
| `domain/graph/prefs.ts` | `FORCE_PARAM_RANGES`/`FORCE_SLIDER_KEYS`/`FORMAT_FORCE_PARAM`/`clampForceParam`/`clampEgoDepth`/`readForceParams` 等纯函数 |
| `state/graph-persist.ts` | 三个持久化键的读写 + 400ms 防抖（模块级 `persistTimer:476` 必须**唯一**，两个防抖器会互相盖） |
| `state/graph-data.ts` | `load`/`loadEgo`/`refreshGraphData`/`startGraphAutoRefresh`/`readTexts` 与 `status/ego/egoStatus/data` |
| `state/graph-view-store.ts` | `view/viewport/collapsed/fitKey/manual/egoBounds` 与缩放平移 |
| `state/graph-cards-store.ts` | 卡片尺寸/完整态/浮窗面板/张力/边来源 |

store 之间用 zustand 的 `getState()` 交叉读（现状已经是这样），**不合并**：合并就是现在的状态。
`state/graph-store.ts` 保留为再导出（`useGraphStore` 的对外 API 不变）→ 组件一行不改。

**(c) `app/actions.ts` 1018 → 4 个文件 + 再导出薄壳**

`app/actions/notes.ts`（open* / save / reload / create* / delete / rename / move 笔记）、
`app/actions/directories.ts`（含 `finishDirectoryRelocation`、`linkSummary`）、
`app/actions/tags.ts`、`app/actions/vault.ts`（Vault 开关 / 重扫 / 回收站 / 片段 / 关于）。
`app/actions.ts` 只做再导出 —— `state/tabs-store.ts:48` 与其余 39 个调用点**零改动**，
这是"拆分不产生连锁改动"的关键。

**(d) `ipc/mock-adapter.ts` 3176 → 6 个文件 + 再导出薄壳**

`ipc/mock/vault.ts`（notes Map / 默认笔记 / 扫描 / 写入 / 冲突）、`ipc/mock/links.ts`（链接抽取、
解析器、改写）、`ipc/mock/tags.ts`（frontmatter 标签字段 + 行内标签 span + set/rename/move）、
`ipc/mock/search.ts`、`ipc/mock/site.ts`、`ipc/mock/index.ts`（43 条 `case` 的分发 +
`createMockAdapter`/`MOCK_VAULT_PATH`/`MockAdapter`）。

**对外契约零改动**：58 个测试文件 import 这三个符号，`ipc/mock-adapter.ts` 保留为再导出薄壳。
**唯一必须同时改的地方**：`scripts/check-ipc.mjs` 的 `TS_MOCK` 常量要指向新的分发文件。

> 附带一条价值更高、但要单独一轮的工作：mock 里的"标签编辑 / 链接改写 / 搜索打分"是**第三份领域实现**
> （Rust 一份、`domain/**` 一份、mock 一份）。优先让 mock 复用 `domain/inline-tags.ts`、
> `domain/frontmatter.ts`、`domain/links.ts` 的纯函数，把"mock 与宿主的行为差"显式记录下来 ——
> 那才是 ADR-0048"每条规则只有一个判据"在测试替身上的落点。

### 4. CSS 策略：`@layer` 四层 + 归属命名 + 文件预算（否决 CSS Modules）

**层序，写死在四个层上：**

```css
@layer mn.tokens, mn.base, mn.components, mn.features;
```

- **每个样式文件顶部都重复写这一行**（重复声明是幂等的），后面接自己的
  `@layer mn.<层> { … }` 把整个文件包住。这样**层序与打包/注入顺序无关** ——
  今天 `main.tsx:10` 的 app.css 排在 `@/App` 之后最后注入这个偶然事实，被彻底消掉。
- **层名由路径唯一决定**（没有例外，门禁按此校验）：

| 路径 | 层 |
| --- | --- |
| `src/styles/tokens.css` | `mn.tokens`（层序声明 + `@font-face` + `:root` 兜底 + VI 别名层） |
| `src/styles/base.css` | `mn.base`（元素基座：`::selection`、`prefers-reduced-motion`、`.mn-visually-hidden`、滚动条） |
| `src/components/**/*.css` | `mn.components` |
| `src/features/**/*.css` | `mn.features` |

- **`styles/app.css` 的拆法是机械的**（按它现有的段注释区间搬，逐段见 `architecture-review.md` §6）：
  拆成 `styles/tokens.css`（1-196 行里的 `@font-face` + `:root` + VI 别名层，由 ADR-0031 的
  `tests/theme/design-tokens.test.ts` 继续管）+ `styles/base.css` + 剩下的搬到各自的
  `components/*.css` 与 `features/<域>/*.css`，然后**删除** `app.css`。门禁给它的是
  "行数预算只许下降"（1693 → 0）。
- **`!important` 预算**：现状 9 处（`app.css` 4 处、`features/export/export.css` 5 处），冻结为按文件预算，
  只许下降。分层之后 export.css 那 5 处**可以直接删**（`mn.features` 的普通声明已经压过 `mn.base`）。
  另外禁止对 `--mn-*` 变量用 `!important` —— 那会压过 `features/settings/font-overrides.ts` 给用户的
  字号覆盖（它正是靠"作者 `!important` 胜过内联普通声明"这条规则工作的）。
- **公开书写面**：`.mn-*` 类名（BEM 块 + `__元素` + `--修饰符`）与 `--mn-*`/VI 别名（ADR-0031）
  是公开 API，**不哈希、不改名**。
- **用户片段（`.mimenote/snippets/*.css`）天然赢**：`theme/snippets.ts` 把片段作为 `<style>` 挂到
  `<head>`，它们是**未分层**样式 —— 未分层的普通声明压过任何分层里的普通声明。
  于是扩展点**变强**：用户不再需要 `!important` 就能覆盖内置样式。
- **CodeMirror 的运行时样式同样未分层**，会压过我们分层的普通声明。现状我们的 CSS 只有 3 条 `.cm-*`
  规则（`styles/app.css:542/546/547`）：其中 2 条是 `!important`（`!important` 胜过 CM 的普通声明与
  **行内普通样式**，与层无关，所以 `z-index`/`background` 两条结论不变），第 3 条 `height: 100%`
  与 CM 自身的 `.cm-editor` 规则不冲突。门禁把"我们的 CSS 里 `.cm-*` 选择器 ≤3"冻结，
  新的编辑器样式必须走 `EditorView.theme`（本仓已是主流做法）。

**新增样式该写在哪（一句话判据）：**

> **先定块名 `.mn-<域>-…`：这个块只被一个功能域用 → 写该域的 `features/<域>/<域>.css`；
> 被 ≥2 个域用 → 它是通用控件，写 `components/<控件>.css`；只声明变量、不选择元素 → 写
> `styles/tokens.css`。同一个块不得出现在第二个文件里。**

### 5. 门禁：`scripts/check-architecture.mjs`（接进 `pnpm check`）

四组规则，全部"**只允许债务变小**"，现状逐条冻结在 `scripts/architecture-allowlist.json`：

1. **依赖方向** + **domain 纯净性**（不许出现浏览器全局）+ **模块级零循环**（值导入图上的 SCC）；
2. **样式归属**：BEM 块只能由一个文件定义、`!important` 按文件预算、不许给自定义属性加 `!important`、
   我们的 CSS 里 `.cm-*` ≤3、每个样式表必须被 import（死样式）、新样式表必须按路径分层；
3. **文件体积**：新文件 ≤600 行；存量 24 个超标文件登记为"待拆"，登记值即天花板；
4. **白名单过期即红**：修好一条却忘了删登记，门禁也会红 —— 这是"只许变小"的执行机制。

白名单按**文件对 / 块名 / 文件名**登记，**不按行号**：行号会随任何一次无关编辑漂移，那种登记会在
无关改动上变红，教人忽略红色。

## 理由

- **把"应该"变成"必须"**：本项目已经吃过一次代价 —— `tag-filter.css:10` 为了绕开"同权重谁赢取决于
  加载顺序"而写了复合选择器。分层让"基座 < 控件 < 特性"成为**声明式事实**，而不是每个新规则都要重新
  推理一次的偶然事实。
- **纯模型下沉是唯一能同时解决"越界"与"上帝模块"的动作**：`features/graph/layout.ts`(986) 既是
  `graph-store` 反向依赖的源头，也是文件体积超标项；搬到 `domain/graph/layout.ts` 一次解决两件事。
- **判定顺序按价值/风险排**：纯函数搬家有密集单测兜住（`tests/` 127 个文件里 domain/state/features
  各有 66/195/186 处 import），而"改环"没有单测能直接看见，因此放最后。
- **门禁形状沿用既有先例**：`check-ipc.mjs` / `check-version.mjs` 都是"零依赖 + 纯函数解析器 +
  可被单测 import + 一次跑全仓"，本脚本与它们同形；`--print-baseline` 只打印不落盘。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| 未分层样式里的 `!important` 在作者 important 中排**最后**，因此用户片段若用 `!important` 去压我们保留的 4 处 `!important`，会**输**（分层前它靠"更晚注入"能赢） | 把这 4 处冻结成预算并逐条说明理由（覆盖 CM 行内 `z-index`、`prefers-reduced-motion`）；README 写明"片段用普通声明即可覆盖，`!important` 反而会被这 4 条压住" |
| CodeMirror 运行时注入的样式未分层，会压过我们分层的普通声明 | 现状只有 3 条 `.cm-*` 规则且结论不变（2 条靠 `!important`、1 条与 CM 不冲突）；门禁冻结 ≤3，新编辑器样式一律走 `EditorView.theme` |
| 29 个样式表各加两行层包装 = 一次机械 diff | 每文件两行、缩进不变；可四个人并行、互不重叠（按目录切） |
| `!important` 预算与体积预算会让"顺手加一行"变红 | 预算值就是"当前真实值"，要放宽必须改 JSON 并在 `note` 里写理由 —— 那一行会出现在 code review 的 diff 里 |
| 白名单过期即红会要求"改代码的人顺手删一条登记" | 这是刻意的：它把"还债"变成提交的一部分，也是"只许变小"唯一的执行手段 |
| 拆分 4 个上帝模块 + 29 个样式表是一次大范围搬运 | 分阶段、按目录切写权限（`architecture-review.md` 末节的 backlog）；`app/actions.ts`/`state/graph-store.ts`/`ipc/mock-adapter.ts` 都用"再导出薄壳"保证调用点零改动 |

## 替代方案

- **CSS Modules + 保留公开语义层（否决）**：哈希类名会让 **610 处 E2E 选择器**（`e2e/*.e2e.test.ts`）
  与 **744 处单测选择器**（`tests/*.tsx`）以及**用户片段**同时失效；要保住扩展点就得给每个元素写
  两份类名、维护两条判据 —— 与本仓库"每条规则只有一个判据"的纪律正面冲突。更关键的是：
  现状 19 处跨文件共享块是**归属**问题（同一个块被四个文件写），不是命名碰撞问题，Modules 一条也治不了；
  真正的命名冲突只有 16 个类名，而 `.mn-` 前缀已经是项目级命名空间。
- **继续用 `!important` 当主要手段**：现状 9 处里 5 处就是"没有层序"的补丁；继续加 = 让用户片段的
  覆盖能力持续退化（而且是不可观测地退化）。
- **引入 ESLint 的 `import/no-restricted-paths` 表达依赖方向**：能表达方向，但表达不了
  "块归属唯一""待拆只许变小""层序声明在每个文件顶部""登记过期即红"这些本项目特有的判据，
  还要引入一整套依赖与配置面；仓库已有零依赖门禁的先例。
- **一次性大重构**：四处上帝模块 + 29 个样式表同时动，无法审查、无法二分定位回归。
  本轮选"门禁冻结现状 + 分阶段并行搬"。
- **把纯模型留在 `features/**`，只放宽规则让 state 可以 import 它们**：那是把症状写进规则 ——
  纯函数将永远无法在 node 环境单独测，也无法被 Rust 之外的第二次消费（CLI/导出/插件）复用。

## 影响

- 新增 `scripts/check-architecture.mjs`、`scripts/architecture-allowlist.json`、
  `scripts/check-architecture.test.mjs`（29 条用例），`package.json` 增 `check:architecture` 并接进 `check`；
- 10 条依赖越界 + 1 个模块级环 + 2 个 domain DOM 文件 + 19 个共享块 + 29 个待分层样式表 +
  24 个待拆文件进入"只许变小"状态（`pnpm check:architecture` 的输出就是这份债务的当前快照）；
- **本轮业务代码零改动**：四块上帝模块的拆分、`app.css` 的拆解、纯模型下沉都由实现队友按
  `docs/architecture-review.md` 的 backlog 执行，写权限按目录互不重叠；
- 新样式一律按 §4 的层名与块归属规则落地；文档里"哪些地方不该动"的清单一并写在 review 末节。

## 后续修订（实施之后才知道的三件事）

### 1. 实施状态（按 `architecture-review.md` §9 的 backlog）

| 条目 | 状态 | 结果 |
| --- | --- | --- |
| B10 domain 纯净性 | ✅ | `domain/clipboard.ts` → `app/clipboard.ts`；`domain/keymap.ts` 的 `navigator` 改成注入点 `setMacPlatformResolver`（探测在 `app/env.ts`）→ `domViolations` 清零 |
| B2 布局模型下沉 | ✅ | `domain/layout/{tree-layout 569, layout-sync 342, dock-layout 64}`；删 4 条越界 + 1 条体积登记 |
| B3 图谱模型下沉 | ✅ | `domain/graph/{geometry 95, layout 579, rect-index 99, edge-visuals 321, force-params 226, force 582, force-presets, layout-ego, viewport}`，全部 ≤600 |
| B1 样式分层 + 拆 `app.css` | ✅ | 1693 行拆成 16 个新文件 + 28 个既有样式表加层包装；`!important` 9 → 4；待迁移分层 29 → 0 |
| B5 mock 拆分 | ✅ | 3176 → 21 行壳 + `ipc/mock/**`（全部 ≤600）；`check-ipc` 43 条命令三方一致；导出符号零改名 |
| B4 actions 拆分 | ✅ | 1018 → 19 行壳 + `app/actions/**`；33 个函数、31 个导出符号一个不少 |
| B11 mock 复用 domain | ✅ | 三处"第二份实现"合并（`isMarkdown` / `extensionOf` / `isInlineTagChar`），剩余刻意差异写成差异清单 |
| B6 graph-store 拆分 | ✅ | 1514 → 148 行组合壳 + 5 个切片（`graph-persist` 239 / `graph-data` 343 / `graph-view-store` 337 / `graph-cards-store` 339 / `domain/graph/prefs` 265） |
| **B8 消环** | ✅ | 见下 §2 |
| B7 GraphCanvas 拆分 | 🔄 | 2635 行 → 容器 + 视图 + hooks，最高风险项，按 E2E 判定 |
| B9 控件归位 | 🔄 | `ConfirmDialog` / `Toasts` → `features/shell/**`，消掉最后两条 `components → state` 越界 |

### 2. `state → app` 的边用**注入点**消，而不是把实现搬下去

B8 消掉的是全仓唯一的模块级环：`state/tabs-store.activate()` 需要"打开一篇笔记"的顺序约束
（切走前落盘、切完同步文件树选中项），而那套顺序只有 `app/actions/notes.ts` 的 `openNote` 知道 ——
于是状态层反向 import 了组合根。修法**不是**把 `openNote` 搬进 state（它要用 `features/**` 的能力，
搬下去只是把环换成另一条越界边），而是留一个函数指针：

```ts
// state/tabs-store.ts —— 与本文件既有的 setCaretMemory 完全同构
export type OpenNoteRequest = (relPath: string) => Promise<boolean>
export function setOpenNoteRequest(next: OpenNoteRequest | null): void
// app/open-bridge.ts —— 组合根装桥；app/actions.ts（动作公开入口）加载时装配
installOpenNoteBridge()
```

**未安装实现时返回 `false`**（显式的"没打开"），而不是静默假装成功 ——
假的成功会让 `caretMemory.restore` 打在错误的文档上。这是本仓库消"状态层需要上层能力"这类环的
**既定手法**（先例：`setCaretMemory`、editor 的 `Compartment` 注入），写在这里供后续参照。

### 3. 层序声明在 minified 产物里看不到 —— 那是**已经被解析掉**，不是失效

`@layer mn.tokens, mn.base, mn.components, mn.features;` 在 44 个样式表顶部各写一遍（幂等），
但**压缩产物里搜不到这条声明**，只剩四个层块。这不是缺陷：CSS 处理器在构建期就按声明把层序
**解析定序**了，压缩器随后把已经无用的声明删掉。证据（可复现）：

- 非压缩产物（`npx vite build --minify false`）**第一行就是层序声明**，而**打包顺序恰好相反**
  （第一段来自 `features/trash/trash-dialog.css`，即特性层）→ 说明顺序来自声明而不是拼接顺序；
- 压缩产物的四个块顺序仍是 `tokens → base → components → features`。

**验收判据**因此改为：构建产物里**前四条 `@layer` 块的顺序**必须是
`mn.tokens → mn.base → mn.components → mn.features`（而不是去搜那条声明）。
