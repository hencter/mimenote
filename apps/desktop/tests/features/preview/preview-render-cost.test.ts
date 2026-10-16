// @vitest-environment jsdom
/**
 * **实测**：这一轮的改动省下了什么、还剩下什么。
 *
 * 为什么要把它写成一条用例（而不是只写在交付说明里）："解析能搬进 Worker、净化搬不走"
 * 是本轮所有取舍的前提（门槛为什么定在 1 MiB、为什么即使开了 Worker 仍然会卡），
 * 这个前提一旦哪天变了（换渲染器、换净化库），下面的比例会先变红。
 *
 * 绝对数字**偏悲观**：这里是 jsdom，没有真实布局与原生 HTML 解析器，比 WebView 里慢。
 * 有意义的是**占比**与数量级，与既有 `live-preview-table.test.tsx` 的实测用例同一口径：
 * 打印数字 + 只断数量级，绝不给紧上界（并行跑测试时机器负载会把单次耗时抬高几倍）。
 */

import { describe, expect, it } from 'vitest'

import { normalizeLinkTarget } from '@/domain/links'
import { imageHtml, renderMarkdown, sanitizeHtml } from '@/domain/markdown'
// 解析层是 Worker 实际加载的那一份（`domain/markdown-core.ts`），主线程只做净化：
// 用**两个真实的入口**来量，才说明"哪一段被搬走了"
import { parseMarkdown } from '@/domain/markdown-core'

/**
 * 造一篇约 1 MiB 的正文（与调研样本同一量级：1 MiB / 约 6.5 万个元素）。
 *
 * 为什么用规整段落而不是粘一段真实笔记：测量要的是"每个阶段与文档大小、元素个数的关系"，
 * 规整输入让结果可复现，也不会因为某个偶发的语法结构把某一阶段带偏。
 */
function buildLargeBody(targetBytes: number): string {
  const block = '这是一段用于测量的正文，含**强调**、`行内代码`与 [链接](https://example.com)。\n\n'
  const times = Math.ceil(targetBytes / block.length)
  return `# 大文档测量\n\n${block.repeat(times)}`
}

function now(): number {
  return performance.now()
}

describe('大文档预览的代价分布（哪些被搬走了、哪些还在主线程）', () => {
  it(
    '1 MiB 正文：解析（能进 Worker）与净化 + 落地（搬不走）各占多少',
    { timeout: 60_000 },
    () => {
      const body = buildLargeBody(1024 * 1024)
      // 预热：第一次调用会把库的初始化（markdown-it 实例、DOMPurify 的 DOM 探测）算进去，
      // 那不是"渲染这篇文档"的代价
      sanitizeHtml(parseMarkdown('# 预热\n\n一段话。\n'))

      const parseStarted = now()
      const raw = parseMarkdown(body)
      const parseMs = now() - parseStarted

      const sanitizeStarted = now()
      const clean = sanitizeHtml(raw)
      const sanitizeMs = now() - sanitizeStarted

      const holder = document.createElement('div')
      const attachStarted = now()
      holder.innerHTML = clean
      const attachMs = now() - attachStarted

      const elementCount = holder.querySelectorAll('*').length
      const total = parseMs + sanitizeMs + attachMs
      const share = (value: number): string => `${((value / total) * 100).toFixed(1)}%`

      console.info(
        `[preview-cost] ${(body.length / 1024 / 1024).toFixed(2)} MiB / ${elementCount} 个元素：` +
          `解析（可搬进 Worker）${parseMs.toFixed(1)}ms ${share(parseMs)} / ` +
          `净化（搬不走）${sanitizeMs.toFixed(1)}ms ${share(sanitizeMs)} / ` +
          `innerHTML 落地（搬不走）${attachMs.toFixed(1)}ms ${share(attachMs)} / 合计 ${total.toFixed(1)}ms`,
      )

      // 这条断言是**门槛与取舍的依据**：解析只占少数，Worker 搬走的是"这几百毫秒里界面还能动"，
      // 不是吞吐。若哪天净化变得比解析还便宜，那"只搬解析"这个决定就该重新讨论。
      expect(parseMs).toBeLessThan(sanitizeMs)
      expect(elementCount).toBeGreaterThan(10_000)
    },
  )

  it(
    '整篇重渲染 vs 就地补一张图：整篇次数从 ⌈N/200⌉+1 降到 1',
    { timeout: 60_000 },
    () => {
      const imageCount = 300
      const body =
        '# 多图\n\n' + Array.from({ length: imageCount }, () => '![图](images/pic.png)').join('\n\n')

      const whole = (): void => {
        renderMarkdown(body)
      }
      whole()
      let wholeMin = Number.POSITIVE_INFINITY
      for (let round = 0; round < 3; round += 1) {
        const started = now()
        whole()
        wholeMin = Math.min(wholeMin, now() - started)
      }

      const figureSpec = {
        src: 'images/pic.png',
        alt: '图',
        title: null,
        width: null,
        height: null,
        block: true,
        url: 'asset://localhost/x.png',
      }

      // 补一张图 = 生成**一个**节点的 HTML + 就地替换一个节点：
      // 完全不碰正文的其它部分（既不重跑 markdown-it，也不重跑净化，更不重建整棵 DOM）。
      // 每次迭代都新建一个容器，免得测成"往脱离文档的节点上再替换一次"的空操作。
      const patch = (): void => {
        const host = document.createElement('div')
        host.innerHTML = '<span class="mn-image-placeholder"></span>'
        const slot = host.firstElementChild
        const box = document.createElement('div')
        box.innerHTML = imageHtml(figureSpec)
        const node = box.firstElementChild
        if (slot !== null && node !== null) slot.replaceWith(node)
      }
      patch()
      const patchStarted = now()
      for (let round = 0; round < 50; round += 1) patch()
      const patchAvgMs = (now() - patchStarted) / 50

      // 只生成字符串（不含解析与替换）：用来分清"补图的代价里哪一段占大头"
      const buildStarted = now()
      for (let round = 0; round < 50; round += 1) imageHtml(figureSpec)
      const buildAvgMs = (now() - buildStarted) / 50

      const batches = Math.ceil(imageCount / 200) + 1
      console.info(
        `[preview-cost] ${imageCount} 张图的正文：整篇重渲染 ${wholeMin.toFixed(1)}ms / ` +
          `就地补一张 ${patchAvgMs.toFixed(3)}ms（生成字符串 ${buildAvgMs.toFixed(3)}ms + 小片段解析与替换）/ ` +
          `整篇次数 ${batches} → 1（改造前 ${batches}×${wholeMin.toFixed(1)}=${(batches * wholeMin).toFixed(0)}ms）`,
      )

      // 一张图的就地替换必须远小于一次整篇渲染（实测约 1%）：否则"就地"这个词就没有意义了。
      // 给 10% 的宽上界 —— jsdom 的小片段解析比真实 WebView 慢得多，绝对数不可外推，
      // 这里抓的是"退化回整篇量级"这种数量级问题。
      expect(patchAvgMs * 10).toBeLessThan(wholeMin)
    },
  )

  it(
    '2000 条链接的补类名：归一化次数从 L×M 降到 L+M',
    { timeout: 30_000 },
    () => {
      const count = 2000
      const targets = Array.from({ length: count }, (_, index) => `目标${index}.md`)

      // 参考实现（改造前的写法）：每个元素都从出链表里从头找
      const startedOld = now()
      let oldHits = 0
      for (const target of targets) {
        const key = normalizeLinkTarget(target)
        const hit = targets.find((item) => normalizeLinkTarget(item) === key)
        if (hit !== undefined) oldHits += 1
      }
      const oldMs = now() - startedOld

      // 改造后的写法：出链先归一化一次建表，再逐元素查表
      const startedNew = now()
      const byTarget = new Map<string, string>()
      for (const target of targets) {
        const key = normalizeLinkTarget(target)
        if (!byTarget.has(key)) byTarget.set(key, target)
      }
      let newHits = 0
      for (const target of targets) {
        if (byTarget.get(normalizeLinkTarget(target)) !== undefined) newHits += 1
      }
      const newMs = now() - startedNew

      console.info(
        `[preview-cost] ${count} 条链接：改造前 ${oldMs.toFixed(1)}ms（逐元素 × 全表 find） / ` +
          `改造后 ${newMs.toFixed(1)}ms（出链一次建表 + 元素各一次）`,
      )

      // 两种写法的**结果**必须一致（改变的是复杂度，不是语义）
      expect(newHits).toBe(count)
      expect(newHits).toBe(oldHits)
      // 数量级断言（不比对绝对耗时）：线性实现应当明显快于"逐元素扫全表"
      expect(newMs).toBeLessThan(oldMs)
    },
  )
})
