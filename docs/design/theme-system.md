# MimeNote 主题系统：默认与纸墨

> 状态：主题配置基线。四套主题清单已进入实现；真实运行截图、跨平台视觉检查与最终对比度复核仍须在发布前完成。

## 1. 设计决策

MimeNote 提供两套独立的配色家族，每套都支持日间与夜间模式：

| 配色家族 | 日间 ID | 夜间 ID | 视觉目标 |
|---|---|---|---|
| 默认 | `mimenote-light` | `mimenote-dark` | 白色编辑画布、墨棕文字、克制的暖色分区 |
| 纸墨 | `mimenote-paper` | `mimenote-paper-dark` | 纸色背景、深墨文字；夜间使用温暖的炭棕底色 |

新安装默认使用 `mimenote-light`。既有的 `mimenote-dark` 和 `mimenote-paper` ID 保留，已有偏好不需要迁移；新增 `mimenote-paper-dark` 补齐纸墨夜间模式。

主题仍沿用 `apps/desktop/src/theme/themes/*.json`、`theme/tokens.ts` 和 `theme/apply.ts` 的现有架构。主题切换只更新 CSS 变量，不重建 CodeMirror 实例。

## 2. 固定品牌基色

固定品牌基色定义在 `apps/desktop/src/styles/tokens.css`，不随日间/夜间切换而改变：

| Token | 值 | 用途 |
|---|---|---|
| `--mn-brand-ink` | `#593719` | 墨棕品牌色、正文与主要操作 |
| `--mn-brand-paper` | `#FCF7ED` | 暖纸色与反白文字 |
| `--mn-brand-ochre` | `#C37F2C` | Logo 原有赭金细节，UI 中少量使用 |
| `--mn-brand-carbon` | `#171614` | 夜间模式的炭黑基色 |
| `--mn-brand-sand` | `#E7D5BD` | 砂岩色，用于表面层级与边界 |

固定品牌基色与主题语义 Token 分层：`--mn-brand-*` 表达品牌身份；`--mn-bg`、`--mn-fg`、`--mn-hover`、`--mn-selection` 等表达当前界面用途。组件应引用语义 Token，不直接写品牌 HEX。

## 3. 色彩混合规则

派生表面、交互状态、边界、选区与阴影使用 `color-mix()`，并显式指定 `in srgb`，让公式可读且混色空间一致。固定品牌基色和需要独立保证对比度的语义色可以保留明确色值。

示例：

```css
/* 柔和表面 */
color-mix(in srgb, var(--mn-brand-paper) 75%, var(--mn-brand-sand) 25%)

/* 选中状态 */
color-mix(in srgb, var(--mn-brand-paper) 58%, var(--mn-brand-sand) 42%)

/* 夜间边框 */
color-mix(in srgb, var(--mn-brand-carbon) 82%, var(--mn-brand-sand) 18%)

/* 带透明度的浮层阴影 */
color-mix(in srgb, var(--mn-brand-carbon) 16%, transparent)
```

百分比代表相应颜色在混合中的占比；同一公式的百分比变化必须同时经过主题预览与对比度复核。不要在组件中重复生成相似颜色。

## 4. 四套主题的层级

### 默认 · 日间

- 页面与编辑画布以纯白为主，墨棕负责正文和主要操作。
- 暖纸色、砂岩色只用于侧栏、代码块、悬停和选中状态。
- 赭金不用于大面积背景；链接采用深色系，避免在浅色表面上使用低对比度的金色小字。

### 默认 · 夜间

- 页面以 `#171614` 为基底，正文采用暖纸色。
- 表面、边框和活动行由炭黑、墨棕、砂岩色混合产生，不做简单的明暗反转。
- 选区与活动行需在代码块、表格、Callout 等不透明内容块上保持可辨识。

### 纸墨 · 日间

- 页面底色由暖纸色与砂岩色混合产生，内容面采用暖纸色。
- 正文使用墨棕与炭黑混合的深色；侧栏、代码块与选中态形成温和但可辨认的纸色层级。
- `#8B5E26` 作为少量交互强调色；正文链接仍使用对比度更稳定的墨棕。

### 纸墨 · 夜间

- 使用偏暖的深炭棕，而非将日间纸色机械反转为纯黑。
- 正文和次级文字使用暖纸色、砂岩色；浮层与侧栏通过不同深度的墨棕区分。
- 选中、悬停、活动行与代码块使用同一套语义 Token，避免编辑器和其他面板出现不同色系。

## 5. 语义 Token 职责

| Token | 职责 |
|---|---|
| `--mn-bg` | 主工作区背景 |
| `--mn-bg-elevated` | 内容表面、卡片与浮层 |
| `--mn-bg-sidebar` | 侧栏与次级区域 |
| `--mn-fg` / `--mn-fg-muted` / `--mn-fg-subtle` | 主要、次级和弱化文字 |
| `--mn-border` | 边框与分隔线 |
| `--mn-accent` / `--mn-accent-fg` | 焦点、强调与强调色上的文字 |
| `--mn-hover` / `--mn-active` | 悬停与激活状态 |
| `--mn-selection` | 文本选区与选中状态 |
| `--mn-editor-bg` / `--mn-editor-fg` | 编辑画布背景与文字 |
| `--mn-editor-gutter-bg` / `--mn-editor-gutter-fg` | 行号栏 |
| `--mn-active-line` / `--mn-code-bg` / `--mn-quote-border` | 活动行、代码与引用块 |
| `--mn-danger` / `--mn-warning` / `--mn-success` | 错误、警告与成功状态 |

## 6. 阅读舒适度、可访问性与发布验收

### 排版与视觉节奏

- 阅读视图正文行长上限为 `40em`；编辑器列总宽为 `42em`，扣除左右内边距后正文约为 `40em`。在 16px 字号下，中文正文约 40 个汉字一行；字号放大时，列宽按 em 同步增长。
- 编辑器与阅读视图默认字号保持 16px，以符合项目现有的默认字号约定；两者均使用 1.78 行高。阅读视图保留独立字号设置，不要求用户为舒适阅读牺牲编辑区的信息密度。
- 默认日间使用柔和的中性近白色 `#F8F7F4`，纸墨日间使用暖纸色；两者都避免把整块工作区做成刺眼的纯白。
- 夜间正文不直接使用纯白，而由暖纸色与炭黑按 `color-mix()` 派生；背景使用深炭棕而非纯黑。正文必须清晰，次级文字逐级降低亮度，但不得淡到难以辨认。
- 正文保持左对齐，不使用两端对齐；段落、标题、列表、代码和引用依靠间距、字重与结构共同形成层次。

### 对比度与语义色

- 正文、标题等主要文字对背景的设计目标为至少 7:1；次级文字、链接、行号、状态色与 Callout 强调文字至少 4.5:1。计算应使用最终解析后的颜色，而不是对 HEX 或混色公式进行目测判断。
- 活动行是整行背景而非正文文字：四套主题都通过真实浏览器计算其与编辑器底色的亮度差，内部验收阈值为 1.2:1。该阈值是 MimeNote 的可辨识性判据，不是 WCAG 正文对比度标准。
- 内置 Callout 不再依赖高饱和的蓝、青、荧光绿、粉红等硬编码文字色；使用主题语义色（链接、次级文字、成功、警告、危险），并保留低比例的背景染色。自定义主题仍可覆盖可选 Callout Token。
- 普通文字对比度至少 4.5:1；大字号文字至少 3:1；关键控件边界与焦点指示目标至少 3:1。
- 不得仅通过颜色表达选中、错误、成功或警告；同时使用图形、文字或形状。

### 必须完成的验证

- 自动测试计算四套主题的正文、次级文字、链接、行号、代码、强调色、警告/成功/危险色和 Callout 的对比度。
- 真实浏览器 E2E 对四套主题逐一检查活动行可辨识性。
- 人工检查长篇中文、英文混排、列表、表格、代码块、引用和 Callout；在默认日间、纸墨日间、默认夜间、纸墨夜间分别连续阅读至少 20 分钟，记录刺眼、文字发虚、选区干扰、长行难以跟读等问题。
- 在常规显示器和较低亮度环境检查日间/夜间模式；再检查 Windows/macOS 实际 WebView 中的色彩、字体回退、透明度叠加与焦点状态。
- 验证主题切换后笔记内容、光标、撤销历史、快捷键与信息布局不变。

静态测试和 WCAG 对比度不能证明所有人的主观舒适度；人工长文本测试与实际设备检查是合并前的必要门槛。
## 7. 参考

- [MDN: CSS `color-mix()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix) — 语法、混色空间与浏览器支持。
- [Obsidian Developer Docs: Colors](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors) — 以基础色构建语义表面、并使用 `color-mix()` 替代重复的透明色值。
- [GitHub Primer: Base color scales](https://github.com/primer/design/blob/main/content/foundations/color/base-scales.mdx) — 将中性色阶与语义角色分离，并分别验证浅色/深色模式。
