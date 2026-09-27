# ADR-0040：插件 manifest 与宿主第一批（M4 起步）

- 状态：已采纳（第一批已交付）
- 日期：M4 开工（v0.2.0 之后）
- 相关：ADR-0005（插件推迟到 M4，先做内置扩展点）

## 背景

ADR-0005 要求 M4 的插件系统具备 manifest、权限声明与安装确认 UI、Worker 隔离、
API 版本化、错误边界、卸载清理。一次性全做等于引入"第三方代码执行 + 动态加载 +
隔离 + 全套 API"，风险与评审面都太大，因此切成小批：第一批只做"身份与门禁"
（manifest 解析校验 + 权限确认 UI + 命令注册暴露 + 错误边界 + 卸载清理 +
示例插件），**不做**动态代码加载与 Worker 隔离 —— 第三方代码本批还不进应用。

## 决策

### 1. manifest 形状与校验（`features/plugins/manifest.ts`）

字段：`id / name / version / minAppVersion / permissions`（ADR-0005 原样）。

- `id`：小写点分命名空间（如 `example.hello`），每段字母数字开头结尾、可用连字符，
  总长 ≤64 —— 它同时是命令命名空间的前缀；
- `version` / `minAppVersion`：严格 `主.次.补`；
- `permissions`：白名单制，本批只认 `commands`，未知与重复都报错；
- 校验风格学 `theme/tokens.ts`：`validate*` 收集**全部**问题一次展示，
  `parse*` 在此之上抛错；`isCompatibleManifest(manifest, appVersion)` 做纯函数版本比较
  （非法输入按不兼容处理）。

### 2. 宿主（`features/plugins/host.ts`）

- 权限门禁：`api.commands.register` 在无 `commands` 权限时抛错；命令 ID 必须以
  `<插件ID>.` 开头（防抢 `note.*` 等内置命令）；
- 错误边界：`setup` 抛错只让这一个插件进 `failed`（toast 一次）；插件命令的 `run`
  被包裹，运行时抛错只 toast，不掀翻调用栈；
- 可逆：`load` 返回的记录带幂等 `dispose`（命令逐个摘除 + 自定义清理），
  `unload / unloadAll` 复用它；`listed()` 可枚举（设置页插件分区读它）；
- 注入式构造：`new PluginHost({ registry, notify })`，生产用全局 `pluginHost`
 （全局命令表 + toast），测试自建。

### 3. 安装确认 UI（`PluginPermissionDialog.tsx`）

复用全站 `.mn-overlay` / `.mn-dialog` / `.mn-button`（与 `ConfirmDialog` 同一语言），
`role="alertdialog"` 让全局快捷键层自动把它当模态。展示插件身份、版本要求与每条权限的
中文说明（`describePermissions`）；允许 / 取消 / 遮罩点击 / Esc 四条路，
后三条一律视为拒绝。`manifest` 为空即不渲染，调用方以此控制开关。

### 4. 示例插件（`example.ts`）

`example.hello`（0.1.0，要求应用 ≥0.2.0，只要 `commands` 权限）：注册
`example.hello.say`，执行时一句提示。M4 的可验证交付就是"它在最小权限下加载、
运行、卸载无残留"（18 条新测试钉住）。

## 代价与后续

1. **动态加载与 Worker 隔离未做**：插件定义由调用方直接传入；`manifest.json` +
   `plugin.js` 的 Vault 内加载、Worker 沙箱、能力收窄（`commands/mod.rs` 的领域对照表
   就是 capability boundary）是下一批；
2. **只开放了 `commands`**：主题 / CSS 片段 / 编辑器扩展 / 设置四类 API 仍是内部机制，
   逐个开放时逐个加权限名与测试；
3. `minAppVersion` 的宿主侧真实版本号接线（`version_info`）随设置页插件分区一起做，
   本批只提供纯函数。
