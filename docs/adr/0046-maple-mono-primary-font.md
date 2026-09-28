# ADR-0046：Maple Mono 为首要等宽字体（全量中文捆绑）

- 状态：已采纳（已交付）
- 日期：UI 走查轮（v0.3.0 之后）
- 相关：ADR-0031（设计令牌）、ADR-0042（不引 Tailwind；主题 JSON 仍是字体栈的唯一来源）

## 背景

用户指定 Maple Mono（圆角 + 连字 + 中西文 2:1 网格，29k star 的开源等宽字体）
为首要字体。等宽字体管辖：代码块/行内代码、编辑器 gutter 与 mono 装饰、
设置页 mono 数值、属性表键名 —— 全都走 `--mn-font-mono` 这一个变量。

## 决策

### 1. 捆绑范围：CN Regular + Bold（woff2，约 10.7MB）

- MapleMono-CN.zip 140MB 全是 TTF（单字重 17MB），本地转 woff2 后 Regular 5.3MB +
  Bold 5.4MB；latin 包另有 1.3MB 但 CN 已含拉丁字形，不重复捆；
- Italic 不捆：代码里斜体极少，浏览器合成 oblique 可接受；以后真需要再加（OFL 允许）；
- 文件住 `public/fonts/`（Vite 原样复制，不走管线—— 5MB 走转译又慢又没意义）；
  `src/styles/fonts/` 试过但构建期解析失败（issuer 识别错乱，见提交说明），public 是正道；
- `font-display: swap`（解码中先用回退顶着，不白屏）；CSP 的 `font-src 'self'` 本来就有。

### 2. 三套主题的等宽栈首位都是 `'Maple Mono'`

`design-tokens.test.ts` 钉住（首位 + `@font-face` + 文件存在三连）。
UI 字体（`--mn-font-ui`）不动：等宽中文做正文牺牲可读性，首要字体指等宽栈。

### 3. 许可证合规

OFL-1.1 文本随产物发布（`public/fonts/OFL.txt` → `dist/fonts/`），
`docs/dependencies.md` 登记（字体按"供应商"对待，与 npm 依赖同一张表）。

## 代价与已知边界

1. 安装包 +10MB（localStorage 统计：这是全仓最大的新增体积，请只增不减地盯着）；
2. 首次渲染有一帧回退字体（swap 的代价，换来不白屏）；
3. 用户机器上若装了同名新版 Maple，`font-family` 名字相同但**产物内嵌优先**
   （`@font-face` 的同源声明先于系统字体匹配，不会混用）。
