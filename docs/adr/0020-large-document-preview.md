# ADR-0020：大文档的阅读视图（为什么 Worker 只承担解析，以及两处真正的放大）

- 状态：已采纳
- 日期：M3 之后

## 背景

`README.md` 的已知限制里挂着一条："大文档（>5MB）预览仍在主线程渲染"，`docs/milestones.md` 的 M5 行
把"Web Worker 预览"列为待做。这一轮要回答的就是它。

原始设想很直白：把预览的渲染搬进 Web Worker，主线程就不卡了。动手前先把代价量清楚，
结论把这条路推翻了一半 —— 但**推翻它的是实测，不是偏好**。

## 决策

### 1. 整篇渲染搬进 Worker 是**不可能**的：DOMPurify 在无 `window` 环境下不可用

`domain/markdown.ts` 的渲染是两步：`markdown-it`（纯 JS）产出 HTML，再交给 DOMPurify 净化
（ADR-0002：笔记里的 HTML 必须过两道防线，`tests/markdown.test.ts` 正是钉这件事的）。

DOMPurify 的 ESM 入口在**没有 `window`** 的环境里走的是"不支持"分支：`isSupported === false`，
而且 `DOMPurify.sanitize` 根本没有被定义。实测（`apps/desktop` 下）：

```
node --input-type=module -e "const m=await import('dompurify');const D=m.default;
  console.log(typeof window, typeof D.sanitize, D.isSupported);
  try{D.sanitize('<b>x</b>')}catch(e){console.log('抛错:',e.message)}"
→ undefined undefined false
→ 抛错: DOMPurify.sanitize is not a function
```

也就是说把整篇渲染放进 Worker **不是"慢"，而是一次都跑不通**。退一步说，就算给 DOMPurify 塞一个
jsdom 实例（浏览器 Worker 里没有），DOM 构建、样式计算与布局也**只能在主线程**发生 ——
那才是大文档卡顿的大头（见下）。

**被否掉的替代**：让净化在 Worker 里"降级成不做"（无 DOM 时原样返回）。那等于把 XSS 的第二道防线
静默删掉，而这道防线存在的理由就是"markdown-it 关掉 raw HTML 也不够"。

### 2. 代价的分布决定了本轮的主修：净化与 DOM 占大头，解析只占约六分之一

1 MiB 的中文笔记（65549 个元素）在 jsdom 里逐段实测（绝对数偏慢，**看占比**）：

| 阶段 | 耗时 | 占比 | 能不能进 Worker |
| --- | --- | --- | --- |
| `frontmatterBody` | 17.8 ms | ≈0.2% | 能，但不值得 |
| `markdown-it` 解析 | ≈674.5 ms | ≈9% | **能** |
| `DOMPurify` 净化 | ≈3469.4 ms | ≈46% | **不能**（见决策 1） |
| `innerHTML` 落地 | ≈3177.1 ms | ≈42% | **不能**（DOM 是主线程独占） |
| 全篇 `querySelectorAll` | ≈376.3 ms | ≈5% | 不能（读 DOM） |

于是本轮的主修不是"把渲染搬走"，而是**消掉两处真实的放大**（决策 3、4）；
Worker 退到一个**窄角色**：只承担能搬走的那一段解析（决策 5）。

### 3. 主修一：图片授权不再触发整篇重渲染（就地补图）

既有实现里，本地图片要逐文件向宿主换授权（ADR-0007），每批最多 200 张。授权结果写进
`assetUrls` state，而 `imageEnv`（useMemo）依赖它、`html`（useMemo）依赖 `imageEnv` ——
于是**每一批授权回来都会把整篇重新渲染一遍**：`markdown-it` + DOMPurify + `innerHTML` 重建 +
后面的全篇扫描。一篇引用了 1000 张图的笔记就是 **6 次**整篇渲染。

改法：渲染只发生一次，授权回来后**原地替换**占位节点（`[data-mn-asset="…"]` → 真 `<img>`）。
要点两条：

* `<img>` 的 HTML 由**同一个纯函数**产出（渲染规则与补图路径共用）—— 否则"补出来的图"与
  "整篇渲染出来的图"迟早会在类名、`data-mn-src`、图注这类细节上分叉，而灯箱与失败回退都依赖它们；
* 拿不到授权的（越界、符号链接逃逸、不存在、非图片）同样**原地**换成**终态占位**（去掉了
  `data-mn-asset`），否则授权 effect 会一遍遍重试同一张注定失败的图。

### 4. 主修二：wikilink 补类名从二次方降到线性

既有实现对每个 `a.mn-wikilink` 元素做一次 `outbound.find(link => normalizeLinkTarget(link.rawTarget) === key)`，
**两侧都调用 `normalizeLinkTarget`**。一篇 2000 条链接、出链也是 2000 条的笔记就是 4000 万次归一化，
而它在**每次 HTML 变化时**都要跑一遍（正文一变就跑）。改法：先把出链归一化一次建 `Map`，
再逐元素查表；行为逐条保持一致（命中/未命中/歧义三种分支，重复目标取第一次 —— 与 `find` 等价）。

### 5. Worker 的窄角色：只解析，且必须有门槛与同步回退

* **只搬 `markdown-it` 这一段**（≈9% 的渲染代价）。它买到的是"解析期间界面还能动"，
  **不是**吞吐：净化与 DOM 仍在主线程。这一点必须写在代码注释与文档里，免得后人以为
  "已经有 Worker 了，所以大文档不卡了"。
* 为了让 Worker 里**不可能**误用净化器，渲染被拆成两层：`domain/markdown-core.ts`（markdown-it 实例
  与我们的全部规则，**不 import DOMPurify**）与 `domain/markdown.ts`（`sanitizeHtml` + `renderMarkdown`）。
  拆分是**纯搬运**：既有 `tests/markdown.test.ts` 的断言一条都不改，行为逐字节不变。
* **门槛**（`PREVIEW_WORKER_MIN_BYTES = 1 MiB`）：低于它直接走同步路径 —— 小文档下 Worker 的构造与
  消息往返比解析本身还贵。这个门槛与 `features/export/export-note.ts` 的 `LARGE_EXPORT_BYTES = 5 MiB`
  **不是同一把尺子**（那个是"要不要先告诉用户等几秒"，这里是"要不要分流"）。
* **协议**：`{ requestId, docKey, body }` → `{ requestId, docKey, html }`。`docKey`（`relPath\u0000revision`）
  与"是不是最新一次请求"两个条件都满足才采信，否则**丢弃**（用户可能在解析期间继续打字、切笔记）。
* **回退**：`typeof Worker === 'undefined'`、构造失败（CSP 等）、`onerror`/`messageerror` →
  永久回退同步路径，只记一次 warn、不弹 toast（与"图片授权失败永久占位"同一姿态）。
  组件卸载或离开阅读视图 → `terminate()`（可逆副作用）。
* **可观察**：预览根节点上挂 `data-mn-render="worker" | "sync"`，让"走了哪条路"成为可断言的事实，
  而不是靠推断（沿用 `data-mn-asset` 那类诊断属性的既有做法）。

### 6. 本轮**没有**做：分块 + 视口窗口化（下一轮的第一顺位）

真正消灭"24 万个元素"的办法是把正文切成块（在顶层 ATX 标题与围栏之外的空行切）、只挂载可视块
（± 一屏）、用 spacer 撑高并由 `ResizeObserver` 回填实测高度。它能同时把 DOMPurify 的输入从
几 MB 变成几十 KB（净化器不必离开主线程就快了一个数量级）。

**为什么不在本轮做**：它会打破三处既有前提 —— `features/outline/outline-scroll.ts` 的"按 DOM 序号
定位标题"（窗口化之后大部分标题不在 DOM 里）、灯箱的 document 级捕获监听、
代码块复制按钮的"重渲染即重挂"。这些都要改成"按块下标 + 高度偏移"的新模型，是一次独立的、
需要自己一轮测试的重构。本轮把它写进 `docs/milestones.md` 的待办，并在下文如实给出残留代价。

## 代价与已知限制

| 项 | 说明 |
| --- | --- |
| Worker 只买到解析 | 净化（≈46%）与 DOM 落地（≈42%）仍在主线程：**大文档从"卡住"变成"卡两段"**，中间有一次让出的机会，不是流畅了 |
| 窗口化未做 | 5 MiB 文档仍会在 DOM 里产生十万级元素（内存、样式计算、滚动都受影响）；这是本轮之后最大的一处遗留 |
| 就地补图的额外状态 | 授权缓存与"终态占位"是两套集合，改错一处会出现"图片反复请求"或"永远停在骨架态"（测试各钉一条）；图片规格只写在**待办**占位上（等授权/等解析），终态占位一个都不带 —— 否则导出件会变脏，"失败回退 == 从没成功过"这条不变量也会破 |
| Worker 的启动成本 | 每次进入阅读视图（或换文档）可能重建一个 Worker；因此在门槛以下**不建**，超过门槛也只建一个 |
| 拆分出的 `markdown-core.ts` | 多一层间接：以后加渲染规则要记住"核心层不许 import DOMPurify"（由依赖图与测试共同保证） |
| Worker 路径没有 `isTauriRuntime()` 门槛 | 这条路径与宿主无关（纯 JS 解析），判它会带来"只有真实 WebView 才走 Worker"的后果 —— 而 UI 层 E2E（系统 Edge）恰好是唯一能用 `page.workers()` 观察它的地方。代价：浏览器预览（`pnpm dev`）下也会开线程，同一条代码路径，多一套开销 |
| 大文档在持续输入期间显示上一次结果 | `useDeferredValue` 让正文比路径慢一拍，因此"正文还没落定就不发请求"；代价是持续输入时看到的是上一次渲染 + "正在同步预览…"提示（对 1 MiB 文档，这比每次按键阻塞主线程几百毫秒好得多） |

## 实测（本机 jsdom，绝对数偏悲观，看**比值**）

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 300 张图的正文：图片授权带来的整篇重渲染 | ⌈300/200⌉+1 = **3 次**（每次 66.3 ms，合计约 199 ms） | **1 次**（每次授权只就地替换一个节点，约 0.7 ms） |
| 2000 条链接的补类名 | **1497 ms**（逐元素 × 全表 `find`，两侧都归一化） | **8.5 ms**（出链一次建表 + 每个元素各一次） |
| 1 MiB 正文各阶段占比 | 解析 ≈9% / 净化 ≈46% / `innerHTML` ≈42% / 全篇扫描 ≈5% | 同左（只有解析被搬到 Worker，其余仍在主线程） |


## 影响

- `domain/markdown-core.ts`（新，纯 JS、无 DOMPurify）与 `domain/markdown.ts`（净化 + 三个 env 钩子）；
- `features/preview/render.worker.ts`（新）+ 主线程侧的协议与降级逻辑；
- `MarkdownPreview`：就地补图、链接补类名线性化、`data-mn-render` 诊断属性、effect 依赖收紧；
- 测试：`tests/preview-render-hydration.test.tsx`（4 条）、`tests/preview-link-annotation.test.tsx`（2 条）、
  `tests/preview-worker.test.ts`（8 条）、`tests/preview-render-cost.test.ts`（3 条，把上表的比值钉住，
  断言是**比较式**而不是绝对阈值）；既有 `markdown.test.ts` / `preview-images.test.tsx` /
  `live-preview-table.test.tsx` 的断言一条不改；E2E 两层各一条：UI 层断言门槛以下 `data-mn-render="sync"`，
  **真实应用层**往临时 Vault 写一篇 >1 MiB 的笔记，断言 `data-mn-render="worker"` **且 CDP 看得到 worker 实例**
  —— 那是"Vite 打包出来的 worker 产物在真实 WebView 里能跑"的唯一硬证据；
- 文档：README 的预览能力行/性能表/已知限制/测试清单/手工验收、`docs/architecture.md` §6 与 §8、
  `docs/milestones.md` 的 M5 行；
- **不新增 IPC、不新增依赖、不动 CSP**（同源 Worker 走 `script-src 'self'`，`tauri.conf.json` 里没有
  `worker-src`，回退链落在 `'self'` 上；不能用 Blob/Data URL 造 Worker）。
