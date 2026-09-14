# ADR-0017：自绘标题栏（关掉系统装饰，窗口按钮自己做）

- 状态：已采纳
- 日期：M3 之后

## 背景

界面顶部一直有一条 34px 的 `mn-titlebar`：应用菜单、产品名、当前 Vault、条目统计、导出按钮都在里面
（见 `architecture.md` §2.2"应用菜单是命令注册表的投影"）。但窗口本身仍然带着**系统标题栏**
——`tauri.conf.json` 的窗口配置里从来没有 `decorations` 这一项，默认就是 `true`。

于是每条窗口有两个标题栏：系统那条写着 "Mimenote"（或当前笔记名），下面那条写着同样的信息外加菜单。
用户在实机使用时的原话是"用的还是系统标题栏！"——这正是它的表现：**我们以为自己在自绘标题栏，
其实只是在系统标题栏下面又画了一条**。

要回答三个问题：

1. 关掉系统装饰之后，**谁负责拖动窗口与三个窗口按钮**？
2. **双击标题栏最大化**这类系统习惯怎么保住？
3. 关掉系统装饰的**代价**是什么（可访问性、多平台差异、截图观感）？

## 决策

### 1. `decorations: false`，`mn-titlebar` 成为唯一的标题栏

`tauri.conf.json` 的主窗口加 `"decorations": false` 与 `"shadow": true`（后者保留系统的窗口投影，
不然无边框窗口在深色桌面上"糊"在背景里）。
界面结构不变（`App.tsx` 的那条 `header.mn-titlebar` 本来就在最上面），只是它现在真的是窗口的顶边。

### 2. 拖动与双击最大化交给 Tauri 的拖动区，不自己写鼠标逻辑

`header.mn-titlebar` 加 `data-tauri-drag-region="deep"`。Tauri 注入的脚本
（`tauri/src/window/scripts/drag.js`，2.11 的实现）按属性处理：

* `mousedown` → `plugin:window|start_dragging`；`detail === 2`（双击）→ `internal_toggle_maximize`
  ——**双击最大化是它自带的**，不需要我们自己监听 `dblclick`（自己再监听会与它叠加成"开关两次"）；
* `deep` 表示**子树里的按下都算**，但 `A`/`BUTTON`/`INPUT`/`SELECT`/`TEXTAREA`/`LABEL`/`SUMMARY`
  以及带 `role=button|link|menuitem…` 的元素会自动**拦住**拖动 —— 所以标题栏上放菜单按钮与窗口按钮
  是安全的，不需要 `stopPropagation` 之类的手工补丁。

配套能力（`capabilities/default.json`）：`core:window:allow-start-dragging`、
`core:window:allow-internal-toggle-maximize`、`core:window:allow-minimize`、
`core:window:allow-toggle-maximize`、`core:window:allow-is-maximized`、`core:window:allow-close`。
它们全是**纯窗口属性操作**，不触碰文件系统 —— 与既有能力集的"最小面"原则一致
（能力文件里逐条写明了理由）。

### 3. 三个窗口按钮自己做，并**订阅真实状态**（`features/window/`）

关掉系统装饰就**必须**自己提供"关窗口"的办法，否则用户只能去任务栏右键关它。因此：

* `WindowControls.tsx`：最小化 / 最大化↔还原 / 关闭，原生 `<button>` + `aria-label` + `title`；
* `window-actions.ts`：动态 import `@tauri-apps/api/window`，失败只记一次日志
  （与 `features/status/window-title.ts`、`state/vault-store.ts` 的降级姿态一致）；
* **最大化状态从窗口读回来**（`isMaximized` + `onResized` 订阅），不是本地开关：窗口被最大化的途径
  不止那个按钮 —— 双击标题栏、`Win+↑`、拖到屏幕上沿、从最大化往下拖都会改变它。
  不订阅的后果是图标与真实状态长期不一致（显示"最大化"但窗口已经最大化了）。

**非 Tauri 环境（浏览器预览、jsdom 单测）里整组按钮不渲染**：渲染三个点了没反应的按钮
比不渲染更让人困惑；标题栏其余部分照常。

### 4. 观感与可访问性上的取舍

* 按钮宽度 42px、撑满 34px 的整条高度（点"关闭"不该要求瞄准一个 10px 的方块），
  关闭按钮悬停用危险色（`--mn-danger`）——它是唯一一个"点了会让窗口消失"的按钮；
* 图标是内联 SVG（10×10 的几何图形）：仓库没有图标库依赖，也不该为三个符号引入一个；
* 每个按钮都有 `aria-label`/`title`，图标本身 `aria-hidden`；焦点环用 `--mn-accent`；
* **没有**做：任务栏缩略图按钮、窗口贴边分屏的自定义处理（交给系统）、macOS 的
  `titleBarStyle: overlay`（本项目 Windows 优先，`decorations: false` 在三平台都成立）。

## 代价与已知限制

| 项 | 说明 |
| --- | --- |
| 失去系统标题栏自带的能力 | 系统菜单（右键标题栏）、Aero Snap 的"拖到屏幕边缘"手势仍由系统处理（无边框窗口照样能贴边），但**标题栏右键菜单**没了；最小化动画等由系统照旧 |
| 多平台差异 | Windows 上无边框窗口的圆角由系统（Win11）与 `shadow` 共同决定；macOS 上无边框窗口会失去红黄绿三个交通灯按钮 —— 我们自己的按钮**位置在右侧**，与 macOS 习惯相反（本轮以 Windows 优先，未做平台分支） |
| 屏幕阅读器 | 三个按钮有 `aria-label`；但"这条栏是标题栏"这件事没有 `role="banner"` 之类的强语义（它是 `header` 元素，语义上够用） |
| 拖动区的副作用 | 标题栏内**文本不可选中**（原本就有 `user-select: none`）；装饰性文字（品牌名、统计）现在也参与拖动，`title` 悬停提示仍可用 |
| 缩放/最大化时的状态 | 状态来自 `onResized` 订阅；窗口在**拖动过程中**连续触发 resize，因此每次都会问一次 `isMaximized`（本地窗口属性读取，微秒级，不值得节流） |

## 影响

- `apps/desktop/src-tauri/tauri.conf.json`（`decorations`/`shadow`）、
  `capabilities/default.json`（新增 6 条窗口能力，逐条写明理由）；
- 新增 `apps/desktop/src/features/window/{WindowControls.tsx,window-actions.ts}`，
  `App.tsx` 的标题栏挂上 `<WindowControls />` 与 `data-tauri-drag-region="deep"`，
  `styles/app.css` 加三条窗口按钮样式（只用既有主题令牌）；
- 测试：`tests/window-controls.test.tsx`（5 条：无 API 时不渲染、三个按钮可访问、
  点击分别调用最小化/关闭、点最大化后图标变"还原"、**窗口从外部被最大化后图标要跟上**）+
  应用层 E2E 一条（真实 Tauri 窗口：标题栏是可拖动区、三个按钮可见、
  点最大化后按钮变"还原"且 `aria-pressed=true`、再点可还原）；
- `README.md` 增加"窗口与标题栏"能力行与手工验收项，`architecture.md` §2.2 补一句
  "标题栏就是窗口"的说明。
