# ADR-0005：第三方插件推迟到 M4，M1 先做内置扩展点

- 状态：已采纳
- 日期：M1

## 背景

"高度自定义"是核心卖点之一，但"允许第三方代码在应用内运行"是最大的安全与稳定性风险面：插件能读写用户全部笔记、能发网络请求、能让主应用崩溃。

若在 M1 就引入插件系统，会得到一个**没有权限模型、没有隔离、API 还会随 M1~M3 的需求不断破坏性变更**的系统——那等于给用户装了一个不设防的后门，同时给未来的插件作者制造反复重写。

## 决策

M1 只实现**内置扩展点**，它们是未来插件 API 的雏形与同一套机制的内部消费者：

| 扩展点 | M1 形态 | 未来插件 API 的对应物 |
| --- | --- | --- |
| 命令 | `CommandRegistry.register({ id, title, run, keybinding })` | `api.commands.register` |
| 快捷键 | `matchChord` + `when` 谓词，用户可覆盖绑定 | `api.hotkeys.add` |
| 主题 | JSON 主题清单 → CSS 变量 | `api.theme.register` |
| CSS 片段 | Vault `.mimenote/snippets/*.css` 注入 | `api.css.addSnippet` |
| 编辑器 | CM6 `Extension` 数组装配点 | `api.editor.registerExtension` |
| 设置 | localStorage（Vault 级偏好） | `api.settings` + `data.json` |

M4 才实现：manifest（id/name/version/minAppVersion/permissions）、权限声明与安装确认 UI、Worker 隔离、API 版本化、错误边界、卸载清理。

## 理由

- 内置扩展点迫使我们在**没有第三方压力**的情况下把机制做对（注册表、生命周期、清理、错误边界）。
- 到 M4 时，插件 API 就是"把内部注册表暴露出去 + 加权限层"，而不是从零设计。
- 安全上：M1 的"自定义"完全来自**用户自己的数据**（Vault 内的 CSS 片段、主题 JSON），不存在第三方代码执行。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| M1 的自定义能力弱于 Obsidian | 主题 + CSS 片段 + 快捷键 + 命令已覆盖高频诉求；核心体验（M2 搜索/双链）优先级更高 |
| 后期 API 仍需破坏性变更 | 从 M1 起所有扩展点即标注版本（`API_VERSION` 常量），M4 起坚持语义化版本 |
| 用户 CSS 片段仍可注入任意样式 | 只在用户自己的 Vault 内加载，且明确告知；不加载远程 CSS |

## 影响

命令注册表、主题层、片段加载器从 M1 起就必须**可逆、可枚举、可版本化**——这三条是 M4 能顺利落地的前提。
