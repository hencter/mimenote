# ADR-0011：导出自包含 HTML；PDF 走系统打印对话框

- 状态：已采纳
- 日期：M3

## 背景

M3 要求"导出 HTML/PDF"，验收标准是"**导出产物可在浏览器打开**"。

两个必须回答的问题：

1. 产物要**自包含**到什么程度？笔记里的本地图片经 asset 协议**逐文件授权**（ADR-0007），而那个授权是**会话级**的（作用域存在进程内存里）—— 把 `asset:` URL 写进导出件，换个程序打开就全断。绝对路径同理，换台机器就断。
2. PDF 怎么生成？Tauri 没有"写 PDF"的 API。自己生成要引 PDF 引擎（几 MB + 中文字体嵌入 + 排版继承），而那正是本项目一直避免的依赖形态（`docs/dependencies.md` 的原则）。

## 决策

### 1. 导出自包含 HTML：图片内嵌 `data:` URL，样式内联成静态值

- 正文走**同一套净化管线**（`domain/markdown.ts` 的 `renderMarkdown` + `frontmatterBody`），不另写一份 Markdown 渲染 —— 否则语法口径与 XSS 防线会立刻分叉。
- 图片解析复用阅读视图的 `createAssetResolver(entries)`（"相对当前笔记 → 全库同名兜底"），字节由新的只读命令 `asset_read_base64` 提供，产出 `<img src="data:image/png;base64,…">`。
- 主题令牌从 DOM 实读后**取成字面值**写进 `<style>`：导出件不引 `app.css`、不引字体、不引任何 URL。实测产物里 `src`/`href` 只剩三种：`data:image/…`（内嵌图）、`#mn-wikilink`（wikilink 锚点）、以及用户在正文里自己写的普通超链接（那是内容）。
- **两遍渲染**：第一遍只为发现"引用了哪些 Vault 内图片"，拿到字节后第二遍产出最终 HTML。代价是大笔记多一次渲染；收益是图片解析规则与阅读视图**同源**（在 Markdown 源码上跑正则预扫就得复刻 markdown-it 的围栏/转义规则，那种重复迟早漂移）。

### 2. PDF = 系统打印对话框里的"另存为 PDF"

打印的**不是当前界面**，而是把同一份导出正文挂到一个只在 `@media print` 可见的容器（`#mn-print-root`），打印结束（`finally`）把容器与注入样式一起移除 —— 可逆副作用。打印样式**强制浅色**（白底黑字、代码块 `pre-wrap`、`break-inside: avoid`、`@page` 边距），只有字体/字号/圆角沿用用户设置。

理由：每个桌面平台的打印对话框本来就有"另存为 PDF"，用户拿到的是系统级的页面设置（纸张、页边距、页码），我们不必也不该重写它。**不引 PDF 引擎**是有意取舍：程序化 PDF 会带来依赖体积、中文字体嵌入与排版继承三个长期维护点，换来的是"我们控制页眉页脚"这点边际收益。

### 3. 写导出件是**唯一允许写 Vault 之外路径**的写命令，靠扩展名白名单收窄

新增 `export_write_html(path, html)`：

- 路径来自**系统保存对话框**（`tauri-plugin-dialog` 的 `save`），因此**不做 `path_guard` 越界限制** —— 目标在 Vault 之外是正常需求（导出到桌面/文档目录）。
- 但**只接受 `.html` / `.htm`**（大小写不敏感）：这条命令带 `path` 参数且不校验越界，如果不限制扩展名，就等于给前端一个"任意文件写入"的后门。白名单把能力面收窄成"写一个 HTML 文件"，这是它能存在的前提；顺带挡掉了 NTFS 备用数据流（`a.html:ads` 的"扩展名"是 `html:ads`）。
- 内容 ≤ 32 MiB（检查在搬字符串进后台任务**之前**做，O(1)，不违反 ADR-0003），写入走 `mn_core::atomic::write_atomic`（同目录临时文件 → fsync → rename 原子替换）。
- 能力声明相应扩张一条：`dialog:allow-save`（没有它就弹不出保存对话框）。除此之外**没有新增任何文件系统/Shell/HTTP 权限**（`fs` 仍未授予）。这条扩张的理由写进了 `capabilities/default.json` 的 `description` 字段本身。

### 4. 图片读取与授权共用同一份白名单与同一套路径校验

`asset_read_base64` 与 `asset_authorize` 共用 `ALLOWED_IMAGE_EXTENSIONS` / `is_allowed_image` 与 `path_guard::resolve_existing`（逐级符号链接检查 + 越界拒绝）。上限：单张 ≤ 8 MiB、单批 ≤ 32 MiB、单批 ≤ 256 张；**超限/失败/越界的条目静默跳过并记日志**，导出件里退化成占位文字 —— 与 `asset_authorize` 的语义一致（"没返回就是拿不到"，而不是整批报错）。

## 代价与已知限制

| 项 | 说明 |
| --- | --- |
| 只支持"当前打开的笔记" | 整库导出 / 多篇合并 / 目录导出都需要"批量选择 + 一次写多文件（或 zip）+ 取消与进度"，属独立一块 |
| PDF 不可编程控制 | 没有页眉页脚/页码/纸张尺寸的程序化控制，各打印驱动的表现有差异 |
| 打印清理依赖 `print()` 的阻塞语义 | Chromium/WebView2 里 `print()` 阻塞到对话框关闭，`finally` 清理安全；若某平台 `print()` 立即返回，应改成 `afterprint` 事件清理（一处小改） |
| 大笔记仍是主线程同步渲染 | 两遍渲染 ≈ 2× 成本；彻底解决要把渲染搬进 Web Worker（M5 既有计划） |
| 图片超限不降采样 | 单张 > 8 MiB 的图不内嵌（导出件里是占位文字），不做转码 —— 需要图像库依赖 |
| 导出件里的 `[[双链]]` 不可跳转 | 渲染成带 `#mn-wikilink` 的锚点、CSS 做成"不可点的虚线文本"；要做可跳转的静态站得为每篇生成一个 HTML 并重写链接（属于整库导出） |
| `data-mn-src` 会留在内嵌图上 | 它不是资源引用（不发请求），但确实带着 Vault 内的相对路径字符串；介意的话需要渲染层提供"导出模式"开关 |

## 影响

- 宿主新增两个命令（`asset_read_base64` 只读、`export_write_html` 只写 HTML），都在 `docs/architecture.md` §3.1 登记；`capabilities/default.json` 增加 `dialog:allow-save`。
- `features/export/**` 拥有导出（纯函数构建 HTML + 高层动作 + 保存对话框 + 进度/选择面板 + 打印容器）；命令 `export.html`（`Mod+Shift+S`）与 `export.pdf`（`Mod+Shift+P`）。
- 导出**不改任何笔记文件**，只读 Vault；产物是单个 HTML，可被任何浏览器打开 —— 满足 milestones 里"导出产物可在浏览器打开"的验收口径。
