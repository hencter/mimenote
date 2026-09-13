# ADR-0007：本地图片通过 `asset:` 协议渲染，作用域按 Vault 动态注入

- 状态：已采纳
- 日期：M2

## 背景

M2 要让预览渲染笔记里的本地图片（`![](附件/图.png)`）。

难点不在渲染，而在**"WebView 凭什么能读到磁盘上的文件"**：渲染进程受 CSP 与浏览器同源策略约束，`file://` 被 CSP 挡下（也从安全上不该开），而笔记内容里写的路径又完全由用户输入决定 —— 一旦放开得太宽，就等于把整台机器的文件系统暴露给一个渲染 HTML 的进程。

可选通道有三条：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A. IPC 读文件** | 新命令把图片读成 base64 交给前端 | 大图要过一遍 JSON 序列化与内存（几 MB 的图 → 更大的 base64 字符串）；没有流式与 Range，滚动一堆图时主线程与内存都吃不消；还得自己做 MIME 与缓存 |
| **B. 自定义协议** | `register_uri_scheme_protocol("mn-asset", …)` 自己实现 | 控制力最强，但要自己写 MIME 探测、Range/断点、缓存头、路径校验 —— 这些正是最容易写出漏洞的地方 |
| **C. 内置 asset 协议** | 打开 `app.security.assetProtocol`，运行时把 Vault 目录加进作用域 | 复用 WebView 原生的图片管线（流式、可缓存、支持 Range）；我们只需要回答"允许哪些目录"这一个问题 |

## 决策

采用 **C**，但**不用目录级作用域**（原因见下一节"已验证的缺口"），而是**逐文件授权**：

1. `tauri.conf.json` 打开 `app.security.assetProtocol.enable`，**静态 scope 留空**，CSP 的 `img-src` 加上 `asset: http://asset.localhost`（Windows 上 asset URL 形如 `http://asset.localhost/<编码后的绝对路径>`，macOS/Linux 是 `asset://localhost/…`）；`src-tauri/Cargo.toml` 打开 `protocol-asset` feature；
2. 新增一个 IPC 命令做**授权**：前端给出「当前笔记 + 图片原始地址」，宿主用 `mn_core::path_guard` 把相对路径解析成 Vault 内的真实文件（`resolve_existing` 会逐级检查符号链接、拒绝越界），确认它是**允许的图片类型**后，把**这一个文件**加进 asset 作用域（`asset_protocol_scope().allow_file(abs)`），并把绝对路径回给前端；
3. 前端用 `convertFileSrc(绝对路径)` 生成 asset URL 填进 `<img>`（`ipc/tauri-adapter.ts` 里的 `convertAssetUrl`，保证 `@tauri-apps/api` 的依赖仍只出现在一个文件里）；
4. 前端另有一层纯函数解析（`domain/assets.ts`，含单测：越界 `..`、外部 scheme、Windows 非法字符与保留名一律拒绝）—— 它只是"别去请求明显不该请求的东西"，**权威判定在宿主**。

## 已验证的缺口：目录级作用域会跟随符号链接

Tauri 2.11.5 的实现（`tauri/src/protocol/asset.rs`）是：percent-decode 请求路径 → `scope.is_allowed(&path)` → `File::open(path)`。
**全程没有 canonicalize**，而 `File::open` 会跟随符号链接 —— 于是 `allow_directory(root, recursive)` 的语义是"路径字符串以 root 开头"，
**Vault 内一个指向外部的符号链接，其目标会被读到**。

对本项目这意味着：一个从不可信来源拿到的 Vault（"别人分享的笔记库"正是我们的威胁模型之一）只要放一个
`泄露.png -> C:\Users\…\某文件` 的链接，再加上引用它的笔记，就能让预览读取 Vault 之外的文件；若目标是合法图片，
用户会看到它。**没有脚本执行、也不会外泄**（渲染到 `<img>` 的字节不进 JS，M4 之前也没有第三方代码），
但它与"路径越界/符号链接逃逸一律拦截"的既有姿态不一致，而且这个原语在 M4 插件面前会变得更有价值。

因此不用 `allow_directory`，改走上面第 2 条的**逐文件授权**：能不能读由 `mn_core::path_guard` 说了算（它已经逐级检查符号链接、
拒绝越界、拒绝 Windows 保留名与 ADS），asset 作用域只是把"已判定安全的那一个文件"放行。

已知代价：首次显示一张图多一次 IPC（纯路径校验，不读文件，前端按 `(笔记, 地址)` 缓存）；
作用域里的条目只增不减（切换 Vault 后旧条目仍留着，但前端只按当前 Vault 的相对路径请求，
**没有可达路径**；真正清理需要在 Tauri 作用域上做减法，留待需要时评估）。

## 理由

- **静态 scope 做不到这件事**：Vault 是用户运行时选的任意目录。若写成 `**`，等于对渲染进程放开整个文件系统 —— 这是本项目明确拒绝的安全姿态（`docs/architecture.md` §5）。
- **不引入自定义协议实现**：M2 的目标是可用与正确，不是重写浏览器资源管线。asset 协议是 Tauri 官方为"渲染本地资源"提供的通道，作用域语义由它保证。
- **不让二进制数据走 IPC**：ADR-0003 之所以要求所有文件 IO 走 `spawn_blocking`，就是为了不让 IO 影响主线程；把图片塞进 IPC 会把这个问题重新引回来，而且还多了内存拷贝。
- **作用域收窄到"当前 Vault"**：与"路径越界一律拒绝"的现有姿态一致；关掉 Vault 后连当前 Vault 也读不到。

## 代价与风险

| 代价 / 风险 | 说明与缓解 |
| --- | --- |
| CSP 必须放开 `img-src` 到 asset 源 | 只放开图片这一个指令，`default-src`/`script-src`/`connect-src` 不变；`object-src 'none'` 仍在 |
| 净化层要允许 `asset:` scheme | DOMPurify 默认的 URI 白名单只认 `http/https/mailto/…`；`ALLOWED_URI_REGEXP` 里显式加上 `asset`（否则 macOS/Linux 上图片会被净化掉而 Windows 正常 —— 典型的"只在某个平台坏"的坑） |
| `protocol-asset` feature 增加一点体积 | 可接受；`docs/dependencies.md` 里不需要新条目（Tauri 自带 feature） |
| 符号链接 | **已核实**（见上一节）：Tauri 2.11.5 的 asset 协议不做 canonicalize，目录级作用域会被符号链接绕过。因此改为**逐文件授权 + `path_guard` 判定**，把符号链接的判定权交回既有实现 |
| 每张图多一次 IPC | 纯路径校验（不读文件、不做 IO），前端按 `(笔记, 地址)` 缓存；同一张图重复渲染不会重复请求 |
| asset URL 里带着绝对路径 | 只在本进程的 WebView 内使用；笔记文件里写的是相对路径，绝对路径不落盘 |

## 影响

- 宿主新增一个只读命令（授权 + 返回绝对路径）。它**不写任何东西**，因此不需要写锁；但必须走 `path_guard` 的 `resolve_existing`，不能自己拼路径。
- 前端新增 `domain/assets.ts`（相对路径 → Vault 内绝对路径，拒绝越界/外部地址/Windows 非法字符与保留名）与 `ipc/tauri-adapter.ts` 的 `convertAssetUrl`；预览在把地址交给 asset 协议之前必须先过它。
- 渲染层对解析结果再做一次 scheme 白名单（`domain/markdown.ts` 的 `SAFE_IMAGE_URL`），并且**加载失败就地回退占位元素** —— 作用域没覆盖、文件被删、路径其实是外部资源，都不该留下裂图。
- 预览不再渲染 frontmatter 区块（它是元数据，已经在标签面板的属性表里）：`domain/frontmatter.ts` 的判定口径与 `mn_core::frontmatter::parse` 保持一致（未闭合的 `---` 不算 frontmatter，否则普通的水平分隔线会把整篇正文吃掉）。
