# ADR-0042：只引入无样式行为 primitives（Base UI），不引入 Tailwind/shadcn 全套

- 状态：已采纳（第一批已交付：设置页 Switch/Select）
- 日期：UI 走查轮（v0.2.0 之后）
- 相关：ADR-0005（内置扩展点）、ADR-0031（设计令牌两层）、ADR-0033（图标刻度）

## 背景

界面控件的"行为"（键盘走位、无障碍属性、开合与焦点管理）与"外观"（颜色/圆角/间距）links
是两件事。前者手写极易漏（焦点陷阱、typeahead、Esc、焦点归还 —— 每个控件重写一遍），
后者必须自主（JSON 主题 + `--mn-*` 变量 + 用户 CSS 片段是产品的"高度自定义"承诺，
任何把样式锁进构建期的方案都会与之冲突）。

用户要求评估 shadcn 全套。结论是**拆开买**：行为层买，样式层不买。

## 决策

### 1. 引入 `@base-ui/react`（1.x，MIT），按子路径按需导入
links
- 选择 Base UI 而不是 Radix：2026-07 起它是 shadcn 的默认底层（1.8.0，API 稳定），
  无样式、只注入 `data-*` 状态属性、不注入任何样式（CSP 与主题引擎零影响）；
- 只用行为：`Switch`（role=switch + aria-checked + Space/Enter）、`Select`
 （combobox/listbox + 方向键 + typeahead + Portal 弹出层）起步；
- 外观全部手写（`components/ui-controls.css`），只读 `--mn-*` 令牌；
  状态走 `data-checked` / `data-highlighted` / `data-popup-open`，不自建类名状态机。

### 2. 不引入 Tailwind / 不整套抄 shadcn 组件

- 主题是运行时 JSON → CSS 变量（换主题不重建任何东西），Tailwind 是构建期原子类：
  两套主题机制并存等于"换主题要改两处"，且用户 CSS 片段对 Tailwind 生成的类名无能为力；
- shadcn 的视觉语言（oklch 灰阶、Inter、圆角）与本项目的 VI（纸墨等中文阅读主题）
  不是一套，整套搬等于重做视觉；
- 图标继续用自研 `Icon.tsx`（ADR-0033 的刻度 + 单测纪律已证明够用，不引 lucide）。

### 3. 行为库的测试纪律（本次踩过的坑，写下来）

Base UI 的 `Select.Item` 靠 `pointerdown` 置位才提交 `click`
（防"打开瞬间光标下的选项被误点"）：测试里只发 `click` 会被合法地忽略，
必须 `pointerdown + click`（真实鼠标本来就是这个顺序）。见
`tests/ui-controls.test.tsx` 的 `clickOption` 注释 —— 以后每个 Base UI 控件测试
都要先确认"真实事件序列是什么"，而不是假设 `click` 万能。

## 代价与后续

1. 新增运行时依赖（违背"依赖最小化"的例外，理由见 `docs/dependencies.md`）；
   打包增量限于用到的子路径（Switch/Select），热路径（文件树虚拟化、编辑器、
   图谱 canvas）一个都不碰；
2. 对话框里的 Select 弹层走 Portal（挂 body，不被对话框滚动裁掉）；
   按键在弹层里时全局快捷键层的模态判定读的是原对话框 —— 单键快捷键在
   设置页本就极少，风险可接受；
3. 下一批候选：对话框焦点陷阱（Base Dialog）、Tooltip、右键菜单的子菜单/复选item；
   原生 range（字号滑杆）与各对话框里的 checkbox 保持原样，逐个替换、逐个有测试。

## 后续修订：第二批（Slider / Checkbox / Tooltip）与 jsdom 测试边界

- 新增 `Slider`（设置页三档字号，替代原生 range）、`Checkbox`（对话框四处布尔项）、
  `Tooltip`（悬停/聚焦提示，替代原生 `title`；`aria-describedby` 手动连，
  Base v1.8 不自动连）；
- `Checkbox` 的 `label` 可选：包在有可见文字的 `<label>` 里时省略（否则读屏拼成两遍）；
- 三条 jsdom 测不了、必须分层的纪律（与"测量 API 进 E2E"同一理由）：
  1. Select 选项提交要 `pointerdown + click`（Base 防误点）；
  2. Slider/Checkbox 本体是原生隐藏 input：`disabled` 断原生属性，不模拟按键；
  3. Tooltip/Select 浮层内容挂载要真实布局 → jsdom 只钉接线与开关态，内容文本进 UI E2E。
