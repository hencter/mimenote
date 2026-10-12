/**
 * 运行时环境探测（ADR-0060 的 domain 纯净性）。
 *
 * 为什么单独一层：`domain/**` 不许碰浏览器全局（`document` / `navigator` / `window`），
 * 而"这台机器是不是 macOS""剪贴板怎么写"这类判断**必须**碰它们。把这类东西收在这里，
 * `domain` 就能保持纯函数：需要平台信息的纯逻辑（键位解析、快捷键展示）改成**注入**，
 * 由 `app/bootstrap.ts` 在启动时把这里的实现装进去。
 *
 * 这一层是 `app` 层（组合根）的一部分，因此可以依赖任何下层；反过来 `domain` 依赖它
 * 会被架构门禁拦下 —— 那正是这条分层存在的意义。
 */

/** 是否为 macOS（决定 `Mod` 用 Cmd 还是 Ctrl）。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform ?? ''
  return /mac|iphone|ipad/i.test(platform) || /Mac/i.test(navigator.userAgent)
}
