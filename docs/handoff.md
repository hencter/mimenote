# 交接说明：下一个会话从这里开始

> 这份文件是**临时**的会话交接，不是产品文档。新会话接手顺利之后可以直接删掉它。
> 最后更新：本轮交付收尾时；当时的提交是 `5b2dcc2`。

## 0. 一句话现状

上一轮用户提的四件事**全部交付、门禁全绿、工作树干净**（只剩用户自己的草稿文件未跟踪）。
新会话可以直接开新需求，不需要先修任何东西。

```
pnpm typecheck                 ✓ 无错误
pnpm test                      ✓ 79 个测试文件 / 1486 条
pnpm test:e2e:ui               ✓ 53 条（前置：先 pnpm build）
pnpm test:e2e:app              ✓ 33 条（前置：先 tauri build --no-bundle，约 3 分钟）
cargo fmt --all --check        ✓ 无差异
cargo clippy --workspace --all-targets -- -D warnings  ✓ 无告警
cargo test --workspace         本轮未动 Rust（上一次跑是全绿）
```

`git status` 里唯一的东西是 `examples/demo-vault/未命名笔记 1.md` —— **用户自己写的草稿**
（他的"Markdown 全元素测试用例"），刻意不跟踪、不改动、不删除；`tests/demo-vault.test.ts`
里有一条 `NOT_FIXTURE` 白名单正是为它加的。

## 1. 上一轮交付了什么（四件事，都有 ADR）

| # | 用户原话 | 根因 | 落在哪 |
| --- | --- | --- | --- |
| 1 | 「拖拽卡片没有变动位置，然后没有碰撞推动卡片，整体非常僵硬！」 | `pins` 曾是**创建模拟那条 effect 的依赖** ⇒ 每个 pointermove 都重建模拟、卡片被弹回原位；命中测试还在用环上的原始矩形；`settle()` 后 alpha = 0 所以除硬碰撞外力全停摆 | `force.ts` 的 `heat()`、`GraphCanvas.tsx` 的 `pinsRef` / `advanceSimulation` / `releasePins` / 当前矩形命中 / 拖动置顶；ADR-0023「后续修订」 |
| 2 | 「需要从 wiki 链接处虚线开始，卡片边缘处实线出连接到卡片」 | 几何**本来就是对的**；坏的是卡片内那段虚线被不透明的 canvas 卡片**整段盖住**（viewport 自成层叠上下文，z-index 盖不过 canvas），加上虚线相位让分界处留了 0.7~2.4px 的缝 | `GraphEdges.tsx` 的 `layer` + `.mn-graph__leads`、`link-edge.ts` 的 `leadDash()`；ADR-0023「后续修订」 |
| 3 | 「Markdown 的渲染没有 `- [ ]` 和 `- [x]` 待办列表的渲染样式」 | markdown-it 默认 preset 没有 task-list 插件 ⇒ 字面方括号；判据散在三处 | `domain/task-list.ts`（唯一判据）、`markdown-core.ts` 核心规则、`blocks.ts` 改读 token；**ADR-0024** |
| 4 | 「实时渲染中有序列表前面的符号都没有进行渲染」 | 列表标记只是挂了个淡色类名（`--mn-fg-subtle`，深色主题下几乎看不见） | `live-preview/build.ts` + `widgets.ts` 的 `ListMarkWidget`：`•`/`◦`/`▪` 与**算出来的序号** |

提交（新会话别重复做）：`2a1e9da` 拖拽 · `d692e71` 引线成层 · `a3b8571` 列表标记 ·
`8bd3d4b` 任务列表 · `5b2dcc2` 文档同步。

## 2. 接着可以做的候选（用户明确提过或我提过但没做）

1. **编辑器与阅读视图的任务项口径对齐**：lezer 的 `Task` 节点要求标记后必须有空格，
   所以 `- [x]`（空任务项）在编辑器里不是任务项、在阅读视图里是。要做就在
   `live-preview/build.ts` 加一条行内兜底规则（ADR-0024 第 5 条记着这件事）。
2. **引线粗细**：引线刻意比卡外那段细且淡（1px / opacity .55）。想一样粗就删掉
   `graph.css` 里 `.mn-graph-edge--lead` 的 `stroke-width` / `opacity` 两行，测试不会红。
3. **把用户的草稿提升成正式 fixture**：`examples/demo-vault/未命名笔记 1.md` 改名、
   图片引用改成本地、进 README 与 `demo-vault.test.ts` 的清单（他提过一次，未拍板）。
4. **编辑器里 `[[链接]]` 的 Obsidian 式悬停预览**：复用浮动面板那条渲染链
   （`FloatingNote.tsx` + `renderMarkdown`）。
5. 更早积压的（`docs/architecture.md` §8 有完整清单）：回收站永久删除/清空、
   标签面板拖拽成树、静态站点站内搜索与增量重导出、大文档预览的分块 + 视口窗口化、
   连线搬到 canvas 以支持 60fps 漂浮。

## 3. 工程约定与红线（新会话务必遵守）

- **注释与文档一律中文，注释解释"为什么"（取舍、代价、踩过的坑），不复述代码在做什么。**
- **提交由主会话做**：派出去的子代理**绝不执行 git 写操作**（`commit`/`checkout`/`restore`/
  `stash`/`reset`/`add`），只允许 `status`/`log`/`diff` 这类只读命令。每个交付项
  = feature commit + docs-sync commit；ADR 放 `docs/adr/`，**下一个编号是 0025**。
- **确定性是一条纪律**：力场模拟自己实现 xorshift32（不用 `Math.random`）、固定遍历顺序、
  不用 `Math.hypot`，同一份输入 + 同一组参数 ⇒ 同一份坐标（ADR-0021）。任何"让位置随历史变化"
  的改动都要先想清楚这条。
- **判据只有一份**：callout 是 `domain/callouts.ts`，任务列表是 `domain/task-list.ts`；
  同一件事在五处渲染（阅读视图 / 所见即所得 / 导出件 / 静态站点 / 图谱卡片）必须共用判据与样式。
- **数字要同步**：用例数写在 `README.md`（"质量门禁"表格 + 测试文件清单两处）、
  功能描述写在 README 的功能表 + `docs/architecture.md`（§7 ADR 表、§8 边界清单）+
  `docs/milestones.md`。上一轮改完是 **79 文件 / 1486 条 / UI E2E 53 条**。
- **验证顺序**：改完先 `pnpm typecheck` + 目标用例 `npx vitest run tests/<file>`，
  然后 `pnpm test`；动了前端要跑 `pnpm build` 再 `pnpm test:e2e:ui`（E2E 服务的是 `dist/`）；
  动了 Rust 或要跑应用层 E2E 才需要 `tauri build --no-bundle`（约 3 分钟）。
- 子代理交付时要它自己跑 `pnpm typecheck` + 目标 vitest，并**在报告里写清实跑命令与结果**。

## 4. 环境事实

- 真实 Vault：`C:\Users\hencter\Nutstore\1\Note`（4267 篇 `.md`，同步盘；建议排除 `.mimenote/`）。
- **用户有一个正在跑的开发实例 `target/debug/mimenote.exe` —— 绝不要杀它**。
- 刚重建过 release 二进制：`target\release\mimenote.exe`（应用层 E2E 用的是它）。
- GUI：`http://127.0.0.1:3080`（DSH Web）。改前端后需要 `pnpm build` + 刷新页面才生效。
- 图谱相关的 DOM 诊断属性（自动化唯一的抓手，别乱删）：`data-graph-mode / depth / scale /
  offset-x / offset-y / canvas-cards / painted-cards / root-rect / card-rects / pinned / overlaps`，
  以及力度面板的 `[data-force-param] / [data-force-value] / [data-force-preset] / [data-force-action]`。
- 测试骨架可以抄现成的：`tests/graph-drag.test.tsx`（自带假画布 + 指针派发 + `screenPoint`）、
  `tests/editor-live-preview.test.tsx`（装饰层：`decosOf` + 真 `EditorView` 挂载）、
  `e2e/ui.e2e.test.ts`（`graphNumber` / `graphRootRect` / `graphCardRects` / `settledGraphTransform`）。

## 5. 关键文件地图（图谱那块最绕，先看这三处注释）

- `apps/desktop/src/features/graph/GraphCanvas.tsx`：坐标换算、命中、指针、模拟 effect、
  漂浮循环、浮动面板、HUD。文件头的注释说明了"卡片为什么在 canvas 上"。
- `apps/desktop/src/features/graph/force.ts`：力导向（`step` / `settle` / `pin` / `heat` /
  `collidePass` 的 MTV 与硬约束），文件头解释了与环形种子的分工。
- `apps/desktop/src/features/graph/link-edge.ts`：引线几何（锚点 → 卡片边界 → 张力曲线）
  与 `leadDash` 的相位推导。
- 渲染单一口径的榜样：`domain/callouts.ts`（ADR-0022）与 `domain/task-list.ts`（ADR-0024）。
