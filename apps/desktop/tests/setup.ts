/**
 * 前端单元/集成测试的公共前置（`vite.config.ts` 的 `test.setupFiles`）。
 *
 * 目前只做一件事：给 jsdom 补上 **CodeMirror 测量阶段需要的 DOM 测量 API**。
 *
 * 为什么必须补：jsdom 没有布局引擎，`Range.prototype.getClientRects` 根本不存在，而 CM 在
 * 编辑器存活期间的任何一次 measure（滚动、装饰刷新、光标闪烁、`coordsAtPos`）都会调用它。
 * 抛出的 `TypeError` 不是断言失败 —— 它发生在异步的 measure 里，于是被 vitest 记成
 * **未处理错误**：输出里虽然是"全部用例通过"，进程却以非零码退出，还会附一句
 * "可能让其它用例假通过"。这既不诚实也不好查（失败信息与真正的原因隔了两层）。
 *
 * 为什么返回空矩形而不是真去算：jsdom 里所有元素的尺寸都是 0，返回空列表与
 * "这个环境没有布局"是一致的语义；需要真实像素的断言都放在 UI 层 E2E（真实 Chromium）。
 * 只在**缺失**时才补，绝不覆盖宿主已经提供的实现。
 */

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    const empty = {
      length: 0,
      item: (): null => null,
      [Symbol.iterator]: function* iterate(): Generator<DOMRect> {
        // 没有布局 → 没有任何矩形
      },
    }
    return empty as unknown as DOMRectList
  }
}
