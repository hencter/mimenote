# ADR-0036：连线搬进 canvas（连线层换介质）

- 状态：已采纳（已交付）
- 日期：修补轮（ADR-0035「容器切割树」收口之后）
- 相关：ADR-0021（画布改 canvas）、ADR-0023（卡片内引线）、ADR-0028（连线的语义色相与走线）

## 背景

交接说明里排在第一位的"下一轮"是**把连线搬进 canvas**，理由是它挡着所有"更优雅的线"：

> 1. **把连线搬进 canvas**：这是所有"更优雅的线"效果（渐细笔触 taper、发光、流动虚线、60fps 漂浮）
>    的前置 —— 连线现在是 React 渲染的 SVG，所以 `FLOAT_FPS = 20`。代价是命中测试 / tooltip /
>    可访问性要自己补（卡片那边已经付过一次，可以复用同一套做法）。

`FLOAT_FPS = 20` 的理由写在 `GraphCanvas` 里：位置一变化，卡片的 canvas 本来就要重画，而连线是
React 渲染的 SVG，**每帧都要重渲染一次组件树**。此外这次搬迁顺手量出了 SVG 那一版两个实打实的落差：

1. **`<title>` 的 tooltip 从来没有生效过。** `.mn-graph__edges { pointer-events: none }`，而
   `pointer-events` 是继承属性 —— 子元素也收不到指针事件，鼠标永远落不到那条 `path` 上。
   于是"同一条边 `count > 1` 时在 tooltip 里说明共几条链接"这条语义**只存在于代码里**。
2. **`EdgeStyle.width` / `.opacity`（跳数权重）从来没有生效过。** 它们是写在 `path` 上的
   **表现属性**，而 SVG 的表现属性是"作者层 0 优先级"—— 任何 CSS 规则都能盖过它。
   `graph.css` 的 `.mn-graph-edge { stroke-width: 1.6; opacity: .5 }` 一直赢，
   而 `GraphCanvas.tsx` 里那段注释恰恰在强调"淡化/强调必须**在跳数权重上调制**、不能替换它"
   （否则"越远越细越淡"永远看不见 —— 而现实是它本来就没被看见过）。

## 决策

### 1. 一张 canvas，三段顺序

连线与卡片画在**同一张 canvas**上，顺序是硬契约：**卡外那段 → 卡片 → 卡内引线**。

原来靠三层 DOM 凑出这个关系（连线层 `z-index: 0` < 卡片 1 < 引线层 2），现在它是同一次绘制里的
调用顺序（`paintGraph` 的入口）。`GraphEdges.tsx`、`.mn-graph__leads` 那一层 DOM 与
`.mn-graph-edge* / .mn-graph-arrow* / .mn-graph-phantom* / .mn-graph__edges` 那批 CSS 规则**退役**。

### 2. 几何变成点模型（`canvas/edge-path.ts`）

SVG 那一版把形状交给浏览器：`d` 字符串进、像素出来。canvas 要自己画，于是路径先被解析成命令序列：

- 只认 **M / L / C / A**（绝对坐标）—— 几何层（`layout.edgePath`、`edge-routing.routeEdgePath`
  与 `ringArcPath`、`link-edge` 的 `leadPathBetween` / `tensionPath`）产出的就是这四种；
  见到别的命令**当场抛错**（悄悄画错一条线比崩溃难查得多）；
- **`A`（椭圆弧）在解析时展开成三次贝塞尔**（`4/3·tan(Δ/4)` 的经典系数，每段 ≤ 90°）：
  命令集因此实际只有三种，采样、命中、描边三处都不用为弧各写一遍。
  逼近误差量级 2/10000 半径（半径 400px 的弧上不到 0.2px），而且**最后一段的终点强制取规范给的点** ——
  "卡内引线的终点与卡外那段的起点逐坐标相同"是 ADR-0023 的硬纪律，分界点上不能有累计误差。

### 3. 命中测试与 tooltip 自己补（`edgeAt` + `[data-graph-edge-tip]`）

canvas 里没有"元素"可挂提示，悬停只能自己算：`edgeAt(painted, 世界坐标, 容差)` 取**最近**的那条，
容差 5 **屏幕**像素（换算成世界单位时除以缩放，于是"容差看起来永远是 5px"）。
判据用的就是画笔那一帧**真画出来**的那份几何（`PaintedEdge.commands`）——
"看到的那条线"与"悬停到的那条线"不可能分家。

提示是新补的 DOM（`role="tooltip"`、`pointer-events: none`、挂在进入那条边时的指针位置）：
文案与 SVG 那一版的 `<title>` 逐字相同（含"共 N 条链接"、"从正文里的 `[[x]]` 引出"，
以及降级时的"正文里没找到对应的链接写法，从卡片边缘出发"）。**这一次它真的会弹出来了。**

### 4. 漂浮 20fps → 60fps

连线不再是每帧一次 React 渲染，于是帧率可以按"观感"而不是"代价"来定。
账如实记下：卡片的重画次数从 20 次/秒变成 60 次/秒；真觉得重时的下一招是脏矩形重画，
而不是把帧率偷偷压回去。

### 5. 权重语义落地（顺手修掉的落差 2）

`EdgeStyle.width` / `.opacity` 现在**真的生效**：

| 情况 | 线宽 / 不透明度 |
| --- | --- |
| 给了 `width` / `opacity`（焦点视图） | 用它 —— 跳数权重 × 强调/淡化的调制 |
| 没给（全库视图） | 退到 `graph.css` 那三档：普通 `1.6 / 0.5`、强调 `2.2 / 0.95`、淡化 `1 / 0.16` |

两套语义各自完整、不互相猜（这正是当年那段注释计划的做法），只是 SVG 的优先级暗礁让它做不到。

### 6. 自动化抓手：从"SVG 类名"换成"画布诊断数字"

连线画在 canvas 上之后，两层 E2E 没有 DOM 可查。宿主 `div.mn-graph` 上新增一组属性，
它们都由**这一帧真画出来的那张记录表**（`PaintedEdge[]`）算出来：

| 旧载体（SVG） | 新载体 |
| --- | --- |
| `path.mn-graph-edge` 的个数 | `data-graph-edges` |
| `--dashed` / `--highlight` / `--dim` 类名 | `data-graph-edge-dashed` / `-highlight` / `-dim` |
| "入链虚线、出链实线"（两个类名的差） | `data-graph-edge-highlight` 与 `-highlight-dashed` |
| `--out` / `--in` / `--context` 类名 | `data-graph-edge-hues`（`出,入,环间` 三个数） |
| `d` 里出现 `A`（同环走弧） | `data-graph-edge-arcs` |
| `path.mn-graph-edge--lead` 的个数 | `data-graph-edge-leads` |
| `text.mn-graph-phantom-label` 的文字 | `data-graph-edge-phantoms` |
| 从 `d` 现算的"鼓出比"（张力那条 E2E） | `data-graph-edge-bulges` |
| ——（SVG 版没有） | `data-graph-edge-hover` = 悬停到的那条边的 key |

## 代价与边界（如实记）

1. **直接给 `.mn-graph-edge` 写 CSS 这条路没有了** —— canvas 不认识选择器。
   但**颜色仍然只有一份来源**：主题令牌（`--mn-fg-subtle` / `--mn-accent` / `--mn-edge-out` /
   `--mn-edge-in` / `--mn-warning`），画笔按 `readPalette` 读的是**计算值**，
   所以主题与用户 CSS 片段改令牌依然生效（这是 ADR-0028 收敛过的书写面）。
2. **每帧的解析代价**：一条边一个 `M` 加一两个 `C`（十几个数），走"正则取词 + `Number()`"的直路，
   几百条边每帧不到 1ms。没有引入通用 SVG 路径解析（弧线转贝塞尔那套里我们只用到"圆/椭圆 + 旋转 0"）。
3. **可访问性**：这一层在 SVG 版里就是 `aria-hidden="true"`（连线不是可聚焦元素），
   所以搬迁没有让它变差；新出现的 tooltip 是纯提示，同样不进 tab 序。
4. **`PaintedEdge` 是这一层的公开契约**：`key / layer / commands / shape / dashed / highlight /
   dim / hue / phantom / label / title`。改它等于改"自动化能看到什么"，与改 DOM 属性同级。

## 测试与判据的家

新增 `tests/graph-edge-paint.test.ts`（31 条）钉住"画笔按什么规则画"：路径串的语法（含隐式重复、
写错要抛错）、弧展开后采样点真的落在弧上、采样与命中距离、终点切向、样式四档、
两层的绘制内容（线宽/图案/箭头三角形/虚影圆与目标名）、记录的字段、`save`/`restore` 配平、
确定性，以及**两段首尾逐坐标相接**（ADR-0023 的硬纪律，现在直接读记录）。

判据按"能在哪一层被直接读到"重新安家，一条都没有丢：

| 判据 | 家 |
| --- | --- |
| 画笔按什么规则画（样式、两层内容、几何） | `tests/graph-edge-paint.test.ts`（新） |
| 三段绘制顺序（引线在卡片之后） | `tests/graph-paint.test.ts` |
| 组件把哪些边交给画笔（提亮/淡化/色相/弧/引线/悬空名/鼓出比） | `tests/graph.test.tsx` 的 `data-graph-edge-*` 断言 |
| 张力旋钮真的改变几何（相对量 = `tension ÷ 4`） | `e2e/ui.e2e.test.ts`（读 `data-graph-edge-bulges`） |
| 悬空边标出目标名、选中卡片后两种边都在 | `e2e/real-app.e2e.test.ts` 与 `e2e/ui.e2e.test.ts` |
| 连线形状（弧 / 径向切线 / 张力）本身 | `tests/edge-routing.test.ts`、`tests/graph-link-edge.test.ts`（未动） |

顺带修掉一条**已知抖动**：`graph.test.tsx` 的「仅标题」用例原来是"清空记录 → 点开关 → 立刻断言
没有正文"，而清空之后到断言之间可能插进一帧**切换前**的重绘（漂浮/力场落定都会推帧）。
60fps 让推帧更密，于是改成确定性的采样窗口：先等布局落定，再清空，再用一次指针移动
（hover 变化 ⇒ 必然重绘）拿"切换后"的那一帧。

## 被否掉的替代

1. **用 `Path2D` + `ctx.isPointInStroke` 做解析与命中**：原生解析更快，但 jsdom 里没有 `Path2D`，
   命中测试就没法在单测里断言，而且"画"与"命中"会用两份几何（一份路径对象、一份采样点）。
   本仓库的纪律是能把判据钉在测试里的地方就别留给运行时。
2. **只搬卡外那段，引线留在 SVG**：省掉"绘制顺序"这一次思考，但两段的相位与端点严丝合缝就没法
   共用一个判据（`leadDash` 的长度、`exit` 的坐标），而那正是 ADR-0023 最贵的一条纪律。
3. **E2E 改用画布像素断言**（截图里量线）：听着最"端到端"，但漂浮开着时卡片每帧都在动，
   颜色还会被 alpha 混出一堆近似值 —— 量出来的东西每次都不同。张力那条因此改用相对量
   （`data-graph-edge-bulges`，与位置、缩放、漂浮全都无关）。
4. **保留 `graph.css` 里那批连线规则当"文档"**：选择器指向的元素已经不存在，
   留着就是一份"看着像判据、实际没人读"的代码；常量搬进 `edge-paint.ts` 顶部，并在 `graph.css`
   里留一句指向（含"自定义边界"那条说明）。
