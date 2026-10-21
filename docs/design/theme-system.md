# MimeNote 主题系统：默认与纸墨

> 状态：主题配置基线。四套 Token 已进入实现；真实运行截图、跨平台视觉检查与最终对比度复核仍须在发布前完成。

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

## 6. 可访问性与发布验收

- 普通文字对比度至少 4.5:1；大字号文字至少 3:1；关键控件边界与焦点指示目标至少 3:1。
- 不得仅通过颜色表达选中、错误、成功或警告；同时使用图形、文字或形状。
- 必须在四套主题中检查编辑器、Markdown 预览、代码块、图谱、侧栏、菜单、弹窗、输入框、选区、活动行、悬停、禁用与焦点状态。
- 对比度应以最终解析后的颜色计算，并在真实运行界面检查透明度和叠加效果；设计令牌的静态审计不能替代 Windows/macOS 截图 QA。
- 验证主题切换后笔记内容、光标、撤销历史、快捷键与信息布局不变。

## 7. 参考

- [MDN: CSS `color-mix()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix) — 语法、混色空间与浏览器支持。
- [Obsidian Developer Docs: Colors](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors) — 以基础色构建语义表面、并使用 `color-mix()` 替代重复的透明色值。
- [GitHub Primer: Base color scales](https://github.com/primer/design/blob/main/content/foundations/color/base-scales.mdx) — 将中性色阶与语义角色分离，并分别验证浅色/深色模式。
