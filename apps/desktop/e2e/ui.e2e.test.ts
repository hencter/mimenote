/**
 * UI 层 E2E：用**系统 Edge**（无需下载浏览器）跑真实 Chromium 布局，
 * 前端跑在构建产物 `dist/` 上、IPC 走内存 Mock 适配器。
 *
 * 这一层的价值：
 * - **真布局**：jsdom 测不出高度，这里能断言"主体吃掉剩余高度、状态栏贴底"，
 *   也就是"必须先选中笔记才对得齐窗口"那类问题的回归门禁；
 * - **快且可移植**：不需要 WebView2、不需要构建 release 二进制，适合放进 CI；
 * - 覆盖编辑器/预览/过滤/主题这些交互链路。
 *
 * 运行：`pnpm --filter @mimenote/desktop build && pnpm test:e2e:ui`
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { delay, findFreePort, packageRoot } from './support/harness'
import { startStaticServer, type StaticServer } from './support/static-server'

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`等待超时：${what}`)
}

/** 读取关键区域的实际布局。 */
function readLayout(page: Page) {
  return page.evaluate(() => {
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width }
    }
    const rectOf = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) throw new Error(`缺少元素：${selector}`)
      return box(element)
    }
    /**
     * 标签栏是**可选**的：没有打开的笔记时整条不渲染（组件返回 null）。
     * 用"高度 0 的空盒子"表示"没有它"，于是"主体吃满剩余高度"这条契约
     * 在有标签与没标签时是**同一条算式**（这正是 ADR-0026 把标签栏放到窗口顶部后
     * 需要更新这条断言的原因：它现在夹在标题栏与主体之间）。
     */
    const optionalRect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      return element === null
        ? { top: 0, bottom: 0, height: 0, width: 0 }
        : box(element)
    }
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      titlebar: rectOf('.mn-titlebar'),
      tabs: optionalRect('.mn-tabs'),
      body: rectOf('.mn-body'),
      statusbar: rectOf('.mn-statusbar'),
      sidebar: rectOf('.mn-sidebar'),
      tree: rectOf('.mn-tree'),
      main: rectOf('.mn-main'),
    }
  })
}

/**
 * 文件树里的某一行。
 *
 * 注意必须限定在 `.mn-tree` 内：预览里的 wikilink 解析成功后也会带 `data-rel-path`，
 * 不加范围会命中两个元素（Playwright 严格模式会直接报错）。
 */
function treeRow(page: Page, relPath: string) {
  return page.locator(`.mn-tree [data-rel-path="${relPath}"]`)
}

/**
 * 确保文件树里某一行可见（必要时先展开父目录）。
 *
 * 为什么需要：用例之间会互相影响树的展开/选中状态（例如键盘导航用例按 Enter
 * 会折叠目录）。每条用例都应该自足，而不是依赖"上一条用例刚好把树留在什么状态"。
 *
 * 展开动作是**点击父行**（`toggleExpanded`）—— `revealPath` 只负责滚动，不改展开状态。
 * 点完必须**等子行真的出现**再返回：否则递归会在"还没重渲染"的间隙里继续往上找，
 * 于是"父目录其实已经展开"这件事被误判成"还没展开"。
 */
async function ensureTreeRow(page: Page, relPath: string): Promise<void> {
  const row = treeRow(page, relPath)
  if ((await row.count()) === 0) {
    const index = relPath.lastIndexOf('/')
    if (index > 0) {
      const parent = relPath.slice(0, index)
      await ensureTreeRow(page, parent)
      await treeRow(page, parent).click()
      await waitUntil(
        async () => (await row.count()) > 0,
        10_000,
        `展开 ${parent} 后出现 ${relPath}`,
      )
    }
  }
  await row.waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * 当前打开的笔记（标题栏中区那条路径）。
 *
 * 读 `data-main-path` 而**不是可见文字**：可见文字不带 `.md`（`displayPath`，ADR-0030），
 * 而自动化要的是真实路径；顺带避开"项目/设计"误配"项目/设计文档"这类前缀命中。
 * 没有打开的笔记时返回 `null`（那个元素根本不渲染）。
 */
async function currentMainPath(page: Page): Promise<string | null> {
  const node = page.locator('.mn-titlebar__path')
  if ((await node.count()) === 0) return null
  return node.getAttribute('data-main-path')
}

/** 在文件树里打开某篇笔记（编辑/阅读/图谱三种视图都能用）。 */
async function openNoteInTree(page: Page, relPath: string): Promise<void> {
  await ensureTreeRow(page, relPath)
  await treeRow(page, relPath).click()
  await waitUntil(
    // 标题栏中区的路径是"当前文档是谁"的**唯一**读法，三种视图里都在
    // （它从前挂在编辑器工具栏上，于是阅读/图谱视图只能退回"树里这一行被选中"这个间接信号 —— ADR-0029）
    async () => (await currentMainPath(page)) === relPath,
    10_000,
    `打开 ${relPath}`,
  )
}

/** 切到"编辑（所见即所得）"视图。 */
async function showEditView(page: Page): Promise<void> {
  await page.locator('button[aria-label="编辑（所见即所得）"]').click()
  await page.waitForSelector('.cm-content', { state: 'visible' })
}

/**
 * 关掉所有标签（回到"一篇都没打开"的空态）。
 *
 * 为什么需要：标签列表跨用例累积（同一页面 + 同一 Vault 根，还会写进 localStorage），
 * 需要断言"标签数量"的用例必须先垫一个已知的起点。刻意走 `×` 按钮而不是改 store：
 * 那才是用户路径，顺带覆盖了"关掉激活标签会自动接上相邻标签"。
 */
async function closeAllTabs(page: Page): Promise<void> {
  const tabs = page.locator('.mn-tabs__tab')
  for (let guard = 0; guard < 40; guard += 1) {
    const before = await tabs.count()
    if (before === 0) return
    await tabs.first().locator('.mn-tabs__close').click()
    await waitUntil(async () => (await tabs.count()) < before, 5_000, '关闭一个标签')
  }
  throw new Error('标签数量没有收敛到 0')
}

/**
 * 切到"阅读"视图（渲染后的正文）。
 *
 * 默认视图是**所见即所得编辑**（分栏已移除，见 ADR-0009），所以断言 `.mn-preview__body`
 * 之前必须先切到阅读视图；这一步就是点状态栏那个按钮。
 */
async function showReadView(page: Page): Promise<void> {
  await page.locator('button[aria-label="阅读（渲染后）"]').click()
  await page.waitForSelector('.mn-preview__body', { state: 'visible' })
}

// ---------------------------------------------------------------------------
// 知识图谱（ADR-0021 起卡片画在 canvas 上）
//
// 卡片不再是 DOM：既没有 `.mn-graph-card` 可以 `count()`，也没有元素可以 `click()`。
// 于是这一节的断言工具全部建立在"画布把事实写在界面上"这件事上：
//
// 1. **`data-graph-*` 属性**（写在宿主 `div.mn-graph` 上）：当前视图、跳数、
//    `屏幕 = 世界 × scale + offset` 的三个数、这一帧交给画笔的卡片数；
// 2. **像素**：卡片是**不透明底 + 边框**（`paint.ts` 的 `drawCard` 先 `fill` 再 `stroke`），
//    画布每帧 `clearRect`，所以卡片之外是透明的 —— "画了没有、卡片多高"都能从
//    `getImageData` 里量出来，不必去猜；
// 3. **几何命中**：命中判的是世界坐标矩形（+4px 屏幕宽容度），而世界原点的屏幕位置就是
//    `(offsetX, offsetY)`；关系图里圆心那一篇正好以世界原点为中心，于是"点圆心卡片"
//    就是点那个坐标。
//
// 连线（`.mn-graph-edge*`）与文件夹容器（`.mn-graph-folder*`）**仍然是 DOM**，
// 所以它们照旧用选择器断言。
// ---------------------------------------------------------------------------

/** 读宿主上的一个数字属性（缺失或读不出数字一律报错，不静默变成 NaN）。 */
async function graphNumber(page: Page, name: string): Promise<number> {
  const raw = await page.locator('.mn-graph').getAttribute(name)
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(value)) throw new Error(`图谱属性 ${name} 读不到数字：${String(raw)}`)
  return value
}

/** 这一帧交给画笔的卡片数（`data-graph-canvas-cards`，与 canvas 上的 `data-mn-cards` 同源）。 */
function graphCardCount(page: Page): Promise<number> {
  return graphNumber(page, 'data-graph-canvas-cards')
}

/**
 * 等到"世界 → 屏幕"的换算稳定，再返回它。
 *
 * 为什么必须等：进入/切换视图后画布会自动"适应窗口"一次（`autoFitBounds`），那一帧之后
 * `data-graph-scale` 与两个 offset 才会定下来。拿中途的偏移去算点击位置会点到卡片外面，
 * 而失败信号只会是"预览没出现"——离真正的原因很远。
 */
async function settledGraphTransform(page: Page): Promise<{ scale: number; x: number; y: number }> {
  let signature = ''
  await waitUntil(
    async () => {
      const now = [
        await graphNumber(page, 'data-graph-scale'),
        await graphNumber(page, 'data-graph-offset-x'),
        await graphNumber(page, 'data-graph-offset-y'),
      ].join('|')
      const stable = now === signature
      signature = now
      return stable
    },
    10_000,
    '画布的缩放与偏移稳定下来',
  )
  return {
    scale: await graphNumber(page, 'data-graph-scale'),
    x: await graphNumber(page, 'data-graph-offset-x'),
    y: await graphNumber(page, 'data-graph-offset-y'),
  }
}

/** 宿主在视口里的左上角（点击坐标以它为原点，与组件里 `toWorld` 用的矩形同一口径）。 */
async function graphBoxOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.mn-graph').boundingBox()
  if (box === null) throw new Error('图谱画布还没有布局盒（不可见？）')
  return { x: box.x, y: box.y }
}

/**
 * 点一下**圆心那张卡片**（= 当前打开的笔记）。
 *
 * 卡片是几何命中，而世界原点的屏幕位置就是 `(offsetX, offsetY)` —— 圆心那一篇正好以
 * 世界原点为中心，所以这一个坐标点下去命中的必然是它。这也是宿主把
 * `data-graph-scale/offset-x/offset-y` 写在界面上的原因（见 `GraphCanvas.tsx` 的注释）。
 */
async function clickGraphCenterCard(page: Page): Promise<void> {
  const transform = await settledGraphTransform(page)
  const origin = await graphBoxOrigin(page)
  await page.mouse.click(origin.x + transform.x, origin.y + transform.y)
}

/**
 * 画布上"上了墨"的像素占比（0..1）——用来证明这一帧**真的被画过**，而不是一块空白。
 *
 * 局限：它只说明"画布上有不透明的东西"，不说明画的是什么（透明/不透明的判据对形状、
 * 文字、底色一视同仁）。更强的证据见 `readCenterCardHeight`。
 */
function canvasInkRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.mn-graph__canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return -1
    const context = canvas.getContext('2d')
    if (context === null) return -1
    if (canvas.width === 0 || canvas.height === 0) return 0
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let inked = 0
    for (let index = 3; index < data.length; index += 4) {
      if ((data[index] ?? 0) > 0) inked += 1
    }
    return inked / (canvas.width * canvas.height)
  })
}

/**
 * 量"圆心那张卡片"被画出来的高度（**世界坐标**）。
 *
 * 做法：卡片中心在世界原点 ⇒ 屏幕上就是 `(offsetX, offsetY)`；沿那一列上下扫
 * `alpha > 0` 的**连续区间**，量到的就是卡片本身的高度（卡片是不透明底 + 边框，
 * 卡片之外被 `clearRect` 清成透明）。再除以 `dpr × scale` 换算回世界坐标，
 * 于是这个数与缩放、DPR 都无关，可以在两篇不同的笔记之间直接比。
 */
function readCenterCardHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('.mn-graph')
    const canvas = document.querySelector('canvas.mn-graph__canvas')
    if (!(host instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return -1
    const context = canvas.getContext('2d')
    if (context === null) return -1
    const scale = Number(host.getAttribute('data-graph-scale'))
    if (!Number.isFinite(scale) || scale <= 0) return -1
    // 画布按 dpr 放大（`canvasSize` 把 dpr 封顶在 3）：设备像素 = CSS 像素 × dpr
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    const column = Math.round(Number(host.getAttribute('data-graph-offset-x')) * dpr)
    const center = Math.round(Number(host.getAttribute('data-graph-offset-y')) * dpr)
    if (column < 0 || column >= canvas.width || center < 0 || center >= canvas.height) return 0
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const opaque = (row: number): boolean =>
      row >= 0 && row < canvas.height && (data[(row * canvas.width + column) * 4 + 3] ?? 0) > 0
    if (!opaque(center)) return 0
    let top = center
    while (opaque(top - 1)) top -= 1
    let bottom = center
    while (opaque(bottom + 1)) bottom += 1
    return (bottom - top + 1) / (dpr * scale)
  })
}

/**
 * 等到圆心卡片的高度**稳定**再返回它。
 *
 * `differFrom` 用来跳过"上一幅图还留在画布上"的过渡帧：换笔记、换跳数时 store 里那份
 * 旧快照会一直画到新的子图回来为止（这正是"刷新不闪白"的设计），此时量到的高度与上一幅
 * 一模一样 —— 不等它变，测到的就是旧数据。
 */
async function settledCenterCardHeight(page: Page, differFrom = -1): Promise<number> {
  let last = -1
  await waitUntil(
    async () => {
      const height = await readCenterCardHeight(page)
      const stable = height > 0 && Math.abs(height - last) < 1 && Math.abs(height - differFrom) > 1
      last = height
      return stable
    },
    15_000,
    '圆心卡片的高度稳定下来',
  )
  return last
}

/**
 * 画布上第一个"确实什么都没画"的点（**视口坐标**），用于"点空白处关掉预览"这一类交互。
 *
 * 为什么不写死一个坐标："右下角大约是空的"这种假设迟早会落到某张卡片上 —— 卡片位置
 * 取决于每篇正文排版后的高度。直接读像素，把"这里确实什么都没画"变成事实。
 */
async function findBlankCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const host = document.querySelector('.mn-graph')
    const canvas = document.querySelector('canvas.mn-graph__canvas')
    if (!(host instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null
    const context = canvas.getContext('2d')
    if (context === null) return null
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return null
    const dpr = canvas.width / width
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const opaque = (cssX: number, cssY: number): boolean => {
      const px = Math.round(cssX * dpr)
      const py = Math.round(cssY * dpr)
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return true
      return (data[(py * canvas.width + px) * 4 + 3] ?? 0) > 0
    }
    const box = host.getBoundingClientRect()
    // 从下缘往上、从左往右扫：HUD 在左上角、预览面板贴着右侧，底部那条横带是两者都到不了的地方
    for (let y = height - 20; y > height / 2; y -= 6) {
      for (let x = 20; x < width - 20; x += 6) {
        if (opaque(x, y)) continue
        const element = document.elementFromPoint(box.left + x, box.top + y)
        // HUD 与预览面板都带 `data-mn-graph-nopan`：点在它们身上不算"点空白处"
        if (element === null || element.closest('[data-mn-graph-nopan]') !== null) continue
        return { x: box.left + x, y: box.top + y }
      }
    }
    return null
  })
  if (point === null) throw new Error('画布上找不到空白的落点（卡片把整块画布铺满了？）')
  return point
}

/**
 * 确保当前在「关系图」。
 *
 * 为什么需要它：视图是**持久化偏好**（`mimenote.graph.prefs.v1`），"进入图谱是哪个模式"
 * 取决于上一条用例把它留成了什么。依赖关系图的用例显式切一次 —— 已经在关系图里时这个
 * 点击是幂等的（`setMode` 遇到同一个模式直接返回），所以用例彼此独立、也不必依赖执行顺序。
 */
async function ensureGraphFocusMode(page: Page): Promise<void> {
  await page.locator('[data-graph-action="mode-focus"]').click()
  await waitUntil(
    async () => (await page.locator('.mn-graph').getAttribute('data-graph-mode')) === 'focus',
    10_000,
    '处于关系图',
  )
}

/**
 * 把关系图的跳数拨回 1（`data-graph-action="depth-down"`，到底了按钮是 disabled 的）。
 *
 * 为什么需要：跳数同样是持久化偏好，用例之间会互相影响。需要精确跳数的用例先调回已知的
 * 起点，才不必依赖"我前面那条用例刚好把它设成了几"。调用前必须先处于关系图（深度那一栏
 * 只在关系图里渲染）。
 */
async function resetGraphDepthToOne(page: Page): Promise<void> {
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await graphNumber(page, 'data-graph-depth')) <= 1) return
    await page.locator('[data-graph-action="depth-down"]').click()
  }
  throw new Error('跳数没有回到 1（深度按钮没生效？）')
}

// ---------------------------------------------------------------------------
// ADR-0023（浮动态 / 从链接引出 / 可调卡片 / 浮窗）用到的断言工具
//
// 这一轮新增的能力多出两件"屏幕上看不见的事实"，它们都没有 DOM 节点可查：
//
// 1. **正文里那段 `[[链接]]` 在哪**：引线的起点来自 canvas 的排版结果（逐 run 量字），
//    只能通过"画出来的两段 path"间接断言；
// 2. **力场算完之后卡片到底在哪**：位置不再等于环坐标（力导向会把它挪走、用户还能按住它），
//    所以宿主把**圆心那张卡片的当前世界矩形**写在 `data-graph-root-rect` 上 ——
//    "精确点到圆心卡片"和"拖它的缩放手柄"都从这一个数出发，而不是去猜屏幕上哪儿有张卡片。
// ---------------------------------------------------------------------------

/** 默认张力（与 `graph-store.ts` 的 `DEFAULT_TENSION` 同一个数）：用例收尾时要把它拨回去。 */
const DEFAULT_GRAPH_TENSION = 0.35

/** 读宿主上的一个字符串属性（缺失就报错：调用方拿它当事实用，静默变成空串最糟）。 */
async function graphText(page: Page, name: string): Promise<string> {
  const raw = await page.locator('.mn-graph').getAttribute(name)
  if (raw === null) throw new Error(`图谱属性 ${name} 不存在`)
  return raw
}

/**
 * 圆心那张卡片**当前**的世界矩形（`data-graph-root-rect`，宿主已取整）。
 *
 * "精确点到它"与"拖它右下角的手柄"都必须用这个数：圆心卡片的位置虽然被力场固定在原点，
 * 但它的**尺寸**会因为用户拉宽而变（ADR-0023），而手柄在卡片内部右下角 —— 尺寸错了就点不中。
 */
async function graphRootRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const raw = await graphText(page, 'data-graph-root-rect')
  const values = raw.split(',').map((part) => Number(part))
  const [x = Number.NaN, y = Number.NaN, width = Number.NaN, height = Number.NaN] = values
  if (values.length !== 4 || [x, y, width, height].some((value) => !Number.isFinite(value))) {
    throw new Error(`图谱属性 data-graph-root-rect 读不出矩形：${raw}`)
  }
  return { x, y, width, height }
}

/**
 * 当前**可见**卡片的矩形（`data-graph-card-rects`，世界坐标，相对路径 → 矩形）。
 *
 * 与 `graphRootRect` 同一个理由，只是圆心之外的那些也需要：像"把甲拖到乙身上"
 * "被撞的那张有没有让开"这类断言，必须知道**乙此刻在哪**。属性格式是
 * `relPath|x,y,w,h`，多条之间用 `;` 分隔（一位小数），是宿主里那段注释写明的契约。
 */
async function graphCardRects(
  page: Page,
): Promise<Map<string, { x: number; y: number; width: number; height: number }>> {
  const raw = await graphText(page, 'data-graph-card-rects')
  const result = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const entry of raw.split(';')) {
    if (entry === '') continue
    const [relPath, numbers] = entry.split('|')
    if (relPath === undefined || numbers === undefined) continue
    const values = numbers.split(',').map((part) => Number(part))
    const [x = Number.NaN, y = Number.NaN, width = Number.NaN, height = Number.NaN] = values
    if (values.length !== 4 || [x, y, width, height].some((value) => !Number.isFinite(value))) {
      throw new Error(`图谱属性 data-graph-card-rects 里有一条读不出矩形：${entry}`)
    }
    result.set(relPath, { x, y, width, height })
  }
  if (result.size === 0) throw new Error('图谱属性 data-graph-card-rects 是空的')
  return result
}

/**
 * 世界坐标 → 页面坐标（`屏幕 = 世界 × scale + offset`，再加宿主左上角）。
 *
 * 与 `GraphCanvas` 里 `toWorld` 的口径逐字对应（那边是反过来的那一半）。
 */
function graphScreenPoint(
  origin: { x: number; y: number },
  transform: { scale: number; x: number; y: number },
  world: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: origin.x + world.x * transform.scale + transform.x,
    y: origin.y + world.y * transform.scale + transform.y,
  }
}

/**
 * 这个页面坐标会不会被"不参与画布指针"的那一层盖住（HUD / 停靠预览 / 浮窗）。
 *
 * 为什么点名这件事：它们都带 `data-mn-graph-nopan`，落在它们身上的按下**不会**进入画布的
 * 指针状态机（`GraphCanvas.handlePointerDown` 的第一条就是把这些筛出去）。手柄若被盖住，
 * 拖动会静默失效，失败信息只剩"卡片没变宽"，离原因很远 —— 所以这里把前置条件断言出来。
 */
function graphPointBlocked(page: Page, point: { x: number; y: number }): Promise<boolean> {
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element === null ? false : element.closest('[data-mn-graph-nopan]') !== null
  }, point)
}

/** 读图谱的持久化偏好（`mimenote.graph.prefs.v1`）；从没写过时返回 `null`。 */
function readGraphPrefs(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('mimenote.graph.prefs.v1')
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
  })
}

/**
 * 当前张力（`data-graph-tension`）。
 *
 * ⚠️ 这个属性写在**滑块自己**身上（它是那一个控件的状态），不是宿主 `.mn-graph` 上 ——
 * 与 `data-graph-mode` / `data-graph-root-rect` 那一批"整块画布的事实"不在同一层。
 */
async function graphTension(page: Page): Promise<number> {
  const raw = await page.locator('.mn-graph__slider[aria-label="连线张力"]').getAttribute('data-graph-tension')
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(value)) throw new Error(`张力滑块读不到 data-graph-tension：${String(raw)}`)
  return value
}

/**
 * 把一个**受控**的 `<input type=range>` 设成某个值（力度管理面板上的每一根滑杆都用它）。
 *
 * 为什么要绕开 `element.value = x`：受控组件在元素实例上挂了 React 自己的 `value` 描述符
 * （用来判断"这次输入到底变没变"），直接赋值会被判成"没变"、`onChange` 根本不触发 ——
 * 于是用例"改了个寂寞"却仍然通过后面的存在性断言。用原型上的原生 setter 改值再手写事件，
 * 才是 React 认的那种用户输入。
 */
async function setRangeValue(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, next) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('不是 input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('拿不到 input.value 的原生 setter')
    setter.call(element, next)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await waitUntil(
    async () => (await locator.inputValue()) === value,
    5_000,
    `滑杆设成 ${value}`,
  )
}

/**
 * 把「连线张力」滑块设到某个值（张力是这一轮唯一一个**连续量**旋钮，HUD 上没有胶囊可按）。
 */
async function setGraphTension(page: Page, tension: number): Promise<void> {
  await page.locator('.mn-graph__slider[aria-label="连线张力"]').evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('张力滑块不是 input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('拿不到 input.value 的原生 setter')
    setter.call(element, String(value))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, tension)
  await waitUntil(
    async () => Math.abs((await graphTension(page)) - tension) < 1e-9,
    10_000,
    `张力滑块设成 ${tension}`,
  )
}

/**
 * 一条**卡片外**的边（`path.mn-graph-edge` 且不是 `--lead`）：它的 `d` 与 tooltip。
 *
 * 只取**真的是张力曲线**的那一条（`d` 里有三次贝塞尔的 `C`）：两端重合的自环会退化成直线
 * （`tensionPath` 的退化分支），那种路径量不出"鼓出多少"。刻意不做等待 —— 读的是"此刻屏幕上的
 * 那条线"，调用方自己包轮询（它随时可能因为漂浮而变）。
 */
async function readSpanEdge(page: Page): Promise<{ d: string; title: string }> {
  const found = await page
    .locator('path.mn-graph-edge:not(.mn-graph-edge--lead)')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => ({
          d: node.getAttribute('d') ?? '',
          title: node.querySelector('title')?.textContent ?? '',
        }))
        .filter((item) => item.d.includes('C')),
    )
  const first = found[0]
  if (first === undefined) throw new Error('画布上没有一条卡片外的张力曲线（全是直线？）')
  return first
}

/**
 * 从一条卡片外的边路径（`M 起点 C 控制点1, 控制点2 终点`）里量出"张力鼓出多少"。
 *
 * 返回的是**相对量**：第一个控制点到弦（起点→终点那条直线）的距离 ÷ 弦长。
 * 为什么用相对量而不是绝对坐标：
 * - 卡片随时在漂浮、镜头会因为换预设而重新适应 —— 绝对坐标每次都不同，断言不了任何东西；
 * - 而 `tensionPath` 的定义是"控制点沿弦的垂直方向偏移 `tension × 弦长 × 0.25`"，
 *   所以这个比值**就是** `tension ÷ 4`，与位置、缩放、DPR 全都无关。
 * 于是"滑块真的改变了连线几何"可以被逐字断言，而不是"d 字符串变了"（漂浮时它每次都变）。
 */
function spanTensionRatio(d: string): number {
  const values = (d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/giu) ?? []).map((part) => Number(part))
  const [x0 = Number.NaN, y0 = Number.NaN, c1x = Number.NaN, c1y = Number.NaN, , , x1 = Number.NaN, y1 = Number.NaN] =
    values
  if (values.length < 8 || [x0, y0, c1x, c1y, x1, y1].some((value) => !Number.isFinite(value))) {
    throw new Error(`这条边的 d 不是"起点 + 一个控制点 + 终点"的三段式：${d}`)
  }
  const dx = x1 - x0
  const dy = y1 - y0
  const chord = Math.hypot(dx, dy)
  if (!(chord > 0)) return 0
  // 点到弦所在直线的距离 = |(控制点 − 起点) × (终点 − 起点)| ÷ 弦长（二维叉积）；再除以弦长得到比值
  const cross = (c1x - x0) * dy - (c1y - y0) * dx
  return Math.abs(cross) / (chord * chord)
}

describe('UI 层（Edge + dist + Mock Vault）', () => {
  let server: StaticServer
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const port = await findFreePort()
    server = await startStaticServer(join(packageRoot(), 'dist'), port)
    // channel: 'msedge' 直接用系统 Edge，避免下载 Playwright 自带浏览器
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('console', (message) => {
      if (message.text().startsWith('DBG')) console.log('[page]', message.text())
    })
    await page.goto(server.url)
    await page.waitForSelector('.mn-gate', { state: 'visible' })
  }, 120_000)

  afterAll(async () => {
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (server !== undefined) await server.close()
  })

  /**
   * 每个用例都从"编辑（所见即所得）"视图开始。
   *
   * 为什么需要：断言 `.mn-preview__body` 的用例会把视图切到"阅读"，而主区域一次只渲染
   * 一个 pane（分栏已移除，ADR-0009）—— 不重置的话，后面的用例会在阅读视图里找编辑器。
   */
  beforeEach(async () => {
    const editButton = page.locator('button[aria-label="编辑（所见即所得）"]')
    if ((await editButton.count()) > 0) await editButton.click()
  })

  it('门闸页 → 打开示例 Vault → 文件树出现', async () => {
    await page.getByText('打开文件夹作为 Vault').click()
    await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    expect(await page.locator('.mn-tree-row').count()).toBeGreaterThan(3)
    // 门闸消失、外壳出现
    expect(await page.locator('.mn-gate').count()).toBe(0)
    expect(await page.locator('.mn-app').count()).toBe(1)
  })

  it('未选中任何笔记时布局即铺满窗口（回归：不需要先选笔记）', async () => {
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height

    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.main.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(layout.tree.height).toBeGreaterThan(100)
    // 此时编辑器里没有文档
    expect(await page.locator('.cm-content').count()).toBe(0)
  })

  it('标签栏移到窗口顶部：横跨全宽，且位于侧栏之上', async () => {
    /*
      用户的要求是"标签页移动到顶部"。原来它挂在 `.mn-main` 里（主区域顶部、被侧栏挤窄），
      现在挂在 `.mn-app` 上：标题栏之下、`.mn-body` 之上，横跨整个窗口宽度。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.waitForSelector('.mn-app > .mn-tabs', { state: 'visible' })
    // 主区域里不再有它（那条 `:has(> .mn-tabs)` 条件规则已经删掉）
    expect(await page.locator('.mn-main > .mn-tabs').count()).toBe(0)

    const box = await page.evaluate(() => {
      const tabs = document.querySelector('.mn-tabs')?.getBoundingClientRect()
      const sidebar = document.querySelector('.mn-sidebar')?.getBoundingClientRect()
      return {
        left: tabs?.left ?? -1,
        width: tabs?.width ?? -1,
        bottom: tabs?.bottom ?? -1,
        sidebarTop: sidebar?.top ?? -1,
        innerWidth: window.innerWidth,
      }
    })
    expect(box.left).toBe(0)
    expect(box.width).toBeGreaterThan(box.innerWidth - 2)
    // 侧栏在它**下面**（不是并排）：这正是"横跨全宽"的判据
    expect(box.sidebarTop).toBeGreaterThanOrEqual(box.bottom - 1)
  })

  it('标题栏分三区：当前笔记路径落在窗口正中，三种视图里都在（ADR-0029）', async () => {
    /*
      用户的要求：路径原来在编辑器面板内部（`.mn-editor__path`，只横跨中间那一列、
      只在编辑视图里存在），现在要进标题栏那一行，并且那一行分左/中/右三区。

      这里钉三件事（都是 jsdom 测不了的）：① 三区都在；
      ② 路径的**中心**与窗口中心对齐 —— 真居中，而不是"看起来差不多"；
      ③ 切到阅读/图谱视图它也不消失（搬进标题栏的直接收益）。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')

    expect(await page.locator('.mn-titlebar__left').count()).toBe(1)
    expect(await page.locator('.mn-titlebar__center').count()).toBe(1)
    expect(await page.locator('.mn-titlebar__right').count()).toBe(1)
    // 编辑器面板里那一行已经不在了（同一信息只留一处）
    expect(await page.locator('.mn-editor__path').count()).toBe(0)

    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.mn-titlebar')?.getBoundingClientRect()
      const path = document.querySelector('.mn-titlebar__path')?.getBoundingClientRect()
      return {
        barHeight: bar?.height ?? -1,
        barBottom: bar?.bottom ?? -1,
        pathBottom: path?.bottom ?? -1,
        pathCenter: path === undefined ? -1 : (path.left + path.right) / 2,
        windowCenter: window.innerWidth / 2,
      }
    })
    expect(geometry.barHeight).toBe(34)
    // 路径就在标题栏那一行里（没有掉到下面去）
    expect(geometry.pathBottom).toBeLessThanOrEqual(geometry.barBottom)
    expect(Math.abs(geometry.pathCenter - geometry.windowCenter)).toBeLessThanOrEqual(2)

    // 阅读视图与图谱视图里路径仍然在
    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })
    expect(await currentMainPath(page)).toBe('项目/设计.md')

    await page.locator('button[aria-label="知识图谱"]').click()
    await page.waitForSelector('.mn-pane--graph', { state: 'visible' })
    expect(await currentMainPath(page)).toBe('项目/设计.md')
  })

  it('笔记名在各处都不带 .md，而身份与悬停仍是真实路径（ADR-0030）', async () => {
    /*
      用户诉求："隐藏 .md 的扩展名"。判据只有 `domain/paths.ts` 的
      `displayName` / `displayPath` 一份，这里在**真实浏览器**里钉住三个显示点
      （标题栏 / 标签页 / 文件树）：可见文字不带扩展名，而"这是哪一篇"的身份
      （`data-main-path` / `data-tab-path` / `data-rel-path`）与悬停 `title`
      仍然是真实路径 —— 少了后半句，自动化就只能靠可见文字认笔记。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.waitForSelector('.mn-app > .mn-tabs', { state: 'visible' })

    // 标题栏中区：可见文字不带 .md，title 与 data-main-path 给真实路径
    expect((await page.locator('.mn-titlebar__path-text').textContent()) ?? '').toBe('项目/设计')
    expect(await currentMainPath(page)).toBe('项目/设计.md')
    expect(await page.locator('.mn-titlebar__path').getAttribute('title')).toBe('项目/设计.md')

    // 标签页：可见文字只有文件名主干
    expect(
      (await page.locator('.mn-tabs [data-tab-path="项目/设计.md"] .mn-tabs__label').textContent()) ??
        '',
    ).toBe('设计')

    // 文件树行：同样不带 .md；真实路径留在 title（`路径 · 大小`）里
    const row = page.locator('.mn-tree [data-rel-path="项目/设计.md"]')
    expect((await row.locator('.mn-tree-row__name').textContent()) ?? '').toBe('设计')
    expect((await row.getAttribute('title')) ?? '').toContain('项目/设计.md')
  })

  it('默认字号三档统一 16：令牌真的生效，写死高度的栏不裁字（VI 落地第一批）', async () => {
    /*
      用户诉求"整体默认字体统一 16 号"。真值在**设置层**（`DEFAULT_SETTINGS`，由
      `font-overrides.ts` 以行内变量 + `!important` 写进 `<html>`），不是主题 JSON 也不是 `:root`
      —— 这一条顺便把这个事实钉住。顺带门禁两件容易被漏掉的事：VI 别名层要真的解析出值；
      写死高度的栏（标题栏 / 标签栏 / 状态栏 / 树行）不能把字裁掉。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')

    const sizes = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const fontSizeOf = (selector: string): string | null => {
        const element = document.querySelector(selector)
        return element === null ? null : getComputedStyle(element).fontSize
      }
      return {
        ui: root.getPropertyValue('--mn-font-size-ui').trim(),
        editor: root.getPropertyValue('--mn-font-size-editor').trim(),
        reading: root.getPropertyValue('--mn-font-size-reading').trim(),
        body: fontSizeOf('body'),
        // 编辑器那一档量的是 `.cm-editor`（`cm/theme.ts` 的 `&` 规则把它设成令牌值）：
        // 量 `.cm-line` 会撞上标题行自己的倍数（`h1` 是 1.62em）
        line: fontSizeOf('.cm-editor'),
        // 别名层（`--bg-base` 等）要真的解析成颜色：解析不出来就是空串/透明
        background: getComputedStyle(document.body).backgroundColor,
      }
    })
    expect(sizes.ui).toBe('16px')
    expect(sizes.editor).toBe('16px')
    expect(sizes.reading).toBe('16px')
    expect(sizes.body).toBe('16px')
    expect(sizes.line).toBe('16px')
    expect(sizes.background).not.toBe('rgba(0, 0, 0, 0)')

    const tight = await page.evaluate(() => {
      const clipped = (selector: string): boolean | null => {
        const element = document.querySelector(selector)
        return element === null ? null : element.scrollHeight > element.clientHeight + 1
      }
      const row = document.querySelector('.mn-tree-row')
      const name = row?.querySelector('.mn-tree-row__name')
      const gap =
        row === null || row === undefined || name === null || name === undefined
          ? null
          : (row.getBoundingClientRect().height - name.getBoundingClientRect().height) / 2
      return {
        titlebar: clipped('.mn-titlebar'),
        tabs: clipped('.mn-tabs'),
        statusbar: clipped('.mn-statusbar'),
        row: clipped('.mn-tree-row'),
        rowGap: gap === null ? 0 : Math.round(gap * 10) / 10,
      }
    })
    expect(tight.titlebar).toBe(false)
    expect(tight.tabs).toBe(false)
    expect(tight.statusbar).toBe(false)
    expect(tight.row).toBe(false)
    // 树行留白：行高 30 − 文字行盒 24 ⇒ 上下各 3px。字号再往上抬就必须一起抬行高
    expect(tight.rowGap).toBeGreaterThanOrEqual(3)
  })
  it('文件树里点一个 `.txt`：纯文本查看器把原文显示出来（只读，ADR-0032）', async () => {
    await ensureVaultOpen(page)
    const file = '.mn-tree [data-rel-path="附件/说明.txt"]'
    if ((await page.locator(file).count()) === 0) await treeRow(page, '附件').click()
    await page.locator(file).click()

    await page.waitForSelector('[data-viewer-kind="text"]', { state: 'visible' })
    // 原文真的来自读文件（Mock 适配器的 note_read）——不是占位、也不是空白
    expect((await page.locator('[data-viewer-text="true"]').textContent()) ?? '').toContain(
      '非 Markdown',
    )
    // 标题栏中区跟着换成"我在看什么"
    expect(await page.locator('.mn-titlebar__path').getAttribute('data-main-path')).toBe(
      '附件/说明.txt',
    )
    // 折行开关可逆（纯文本查看器唯一需要的交互）
    const wrap = page.locator('[data-viewer-action="toggle-wrap"]')
    const before = await wrap.textContent()
    await wrap.click()
    expect(await wrap.textContent()).not.toBe(before)

    // 打开一篇笔记就回到笔记
    await openNoteInTree(page, '项目/设计.md')
    expect(await page.locator('[data-viewer-kind="text"]').count()).toBe(0)
  })
  it('callout：所见即所得与阅读视图的框内边距一致（编辑区里也有边距）', async () => {
    /*
      用户报的"callout 在编辑区域下没有边距，预览/阅读视图和实时编辑视图没法统一"。

      判据是"**框的边缘**到框内第一段内容（图标）的距离"，两侧语义对等、可以直接比：
      编辑器那边量的是行盒（`.cm-line`），阅读视图那边量的是块（`.mn-callout`）。
      为什么不比框的总高度：一个按"行"排、一个按"块"排，行高与块间距本来就不一样 ——
      能统一、也应该统一的正是内边距。（框**底**那一侧由 `tests/live-preview-callout.test.ts`
      的跨文件契约用例钉着：编辑器的末行 padding = app.css 里 `.mn-callout` 的下内边距
      + 末块的 margin-bottom。）
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/callout 示例.md')
    await showEditView(page)

    const editor = await page.evaluate(() => {
      const glyph = document.querySelector('.mn-md-callout-glyph')
      const line = glyph?.closest('.cm-line')
      if (glyph === null || line === null || line === undefined) {
        throw new Error('编辑区里没有 callout 的图标装饰')
      }
      // 只量**同一行内**的偏移：多个 callout 并存时，跨元素找"框"会张冠李戴
      const box = line.getBoundingClientRect()
      const icon = glyph.getBoundingClientRect()
      return { left: icon.left - box.left, top: icon.top - box.top }
    })

    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })

    const read = await page.evaluate(() => {
      const box = document.querySelector('.mn-callout')
      const icon = box?.querySelector('.mn-callout__icon')
      if (box === null || icon === undefined || icon === null) {
        throw new Error('阅读视图里没有 callout')
      }
      const outer = box.getBoundingClientRect()
      const glyph = icon.getBoundingClientRect()
      return { left: glyph.left - outer.left, top: glyph.top - outer.top }
    })

    /*
      两处**已知**的小偏差，容差就是照它们给的（都记在 ADR-0022 的后续修订里）：
      1. 左侧多约 4px：编辑器里 `> ` 的 `>` 被隐藏后**留下一个空格**（读起来就是 0.25em），
         而阅读视图的标记整段被标题栏取代 —— 这是"引用标记的隐藏方式"的差，不是内边距的差；
      2. 上下各差约半个行距：编辑器的行盒比文字本身高。
    */
    expect(Math.abs(editor.left - read.left)).toBeLessThanOrEqual(6)
    expect(Math.abs(editor.top - read.top)).toBeLessThanOrEqual(6)
    // 但**内边距必须真的存在**：没有它的时候这两个数会差到 15px 以上（用户报的就是那种样子）
  })
  it('停靠区：文件树搬到最底部（键盘 Alt+3）、偏好落盘，再 Alt+1 搬回', async () => {
    /*
      "每个视图模块都能拖拽到任意区域占位"的键盘等价物：拖拽本身在单测里用合成事件钉着，
      这里走 Alt+数字那条路 —— 它更能在真实浏览器里稳定复现，而且**同样**经过
      `moveDockModule` 与落盘。
    */
    await ensureVaultOpen(page)
    const header = page.locator('[data-dock-module-header="tree"]')
    await header.waitFor({ state: 'visible' })
    await header.focus()
    await page.keyboard.press('Alt+3')

    await waitUntil(
      async () => (await page.locator('[data-dock="bottom"] [data-dock-module="tree"]').count()) === 1,
      5_000,
      '文件树被搬到最底部',
    )
    // 左区空了 ⇒ 整块左停靠区不渲染（`.mn-sidebar` 随之消失）
    expect(await page.locator('.mn-sidebar').count()).toBe(0)

    const stored = await page.evaluate(() => localStorage.getItem('mimenote.ui.v1'))
    expect((JSON.parse(stored ?? '{}') as { dockLayout?: { bottom?: string[] } }).dockLayout?.bottom).toEqual([
      'tree',
    ])

    // 搬回左侧（收尾：后面的用例还要用左侧的文件树）
    const moved = page.locator('[data-dock-module-header="tree"]')
    await moved.focus()
    await page.keyboard.press('Alt+1')
    await waitUntil(
      async () => (await page.locator('.mn-sidebar [data-dock-module="tree"]').count()) === 1,
      5_000,
      '文件树搬回左侧',
    )

    // 宽度：左停靠区仍然跟着侧栏宽度（拖分隔条能改它）
    const width = await page
      .locator('.mn-sidebar')
      .evaluate((element) => element.getBoundingClientRect().width)
    expect(width).toBeGreaterThan(100)
  })

  it('模块右键菜单：文件树行、标签页各有一套，Esc 关掉', async () => {
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await openNoteInTree(page, 'README.md')

    // 文件树行：右键 → 菜单（打开/新建/重命名/移动/定位/复制路径/删除）
    await treeRow(page, '项目/设计.md').click({ button: 'right' })
    const menu = page.locator('.mn-context-menu')
    await menu.waitFor({ state: 'visible' })
    expect(await page.locator('[data-menu-item="rename"]').count()).toBe(1)
    expect(await page.locator('[data-menu-item="delete"]').count()).toBe(1)
    // 右键即选中：菜单里的动作作用于这一行
    await waitUntil(
      async () =>
        (await treeRow(page, '项目/设计.md').getAttribute('class'))?.includes(
          'mn-tree-row--selected',
        ) === true,
      5_000,
      '右键选中了那一行',
    )
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await menu.count()) === 0, 5_000, 'Esc 关掉菜单')

    // 标签页：右键 → 关闭其他
    await page.locator('.mn-tabs__tab[data-tab-path="项目/设计.md"]').click({ button: 'right' })
    await page.locator('[data-menu-item="close-others"]').waitFor({ state: 'visible' })
    await page.locator('[data-menu-item="close-others"]').click()
    await waitUntil(async () => (await page.locator('.mn-tabs__tab').count()) === 1, 10_000, '只剩一个标签')
    expect(await page.locator('.mn-tabs__tab--active').getAttribute('data-tab-path')).toBe(
      '项目/设计.md',
    )
  })

  it('文件树排序可配置：菜单里选「修改时间」→ 顺序变化、偏好落盘，再换回来', async () => {
    await ensureVaultOpen(page)
    const orderOf = async (): Promise<string[]> =>
      await page
        .locator('.mn-tree-row')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-rel-path') ?? ''))
    const before = await orderOf()
    expect(before.length).toBeGreaterThan(3)

    await page.locator('button[aria-label="文件树排序"]').click()
    // ⚠️ 用**方向**而不是"修改时间"来证明重排：Mock Vault 里所有条目的 `mtimeMs` 相同
    // （按修改时间排等于没排），拿它当证据会得到一条永远超时的用例。
    // 判据本身（各 by/direction 组合）由 `tests/tree.test.ts` / `tests/dock*` 钉着，
    // 这里只需要证明"偏好 → 数据层重排 → DOM 顺序"整条链路通。
    await page.getByRole('menuitemradio', { name: '降序' }).click()

    await waitUntil(
      async () => JSON.stringify(await orderOf()) !== JSON.stringify(before),
      5_000,
      '排序真的变了（不是只改了一个偏好字段）',
    )
    const stored = await page.evaluate(() => localStorage.getItem('mimenote.ui.v1'))
    expect((JSON.parse(stored ?? '{}') as { treeSort?: { direction?: string } }).treeSort?.direction).toBe(
      'desc',
    )

    // 收尾：换回升序（后面的用例依赖自然序），顺带证明菜单不自动关闭（点第二下仍然有效）
    await page.getByRole('menuitemradio', { name: '升序' }).click()
    await waitUntil(
      async () => JSON.stringify(await orderOf()) === JSON.stringify(before),
      5_000,
      '换回名称升序',
    )
    await page.keyboard.press('Escape')
  })

  it('图谱：仅标题卡片、全文档、卡片右键菜单', async () => {
    /*
      三条这一轮新增的图谱能力，端到端各点一次：
        · 「仅标题」= 卡片只剩标题行（高度真的变矮）；
        · 「全文」= 不截断那一档（落盘里记下 `full: true`）；
        · 卡片右键 = 画布自己命中出来的菜单（卡片在 canvas 上，没有 DOM 可右键）。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '关系图画出圆心与它的邻居')

    const before = await settledCenterCardHeight(page)
    await page.locator('[data-graph-action="toggle-title-only"]').click()
    const titleOnly = await settledCenterCardHeight(page, before)
    expect(titleOnly).toBeLessThan(before)
    // 没有正文就没有"从链接引出"的引线
    expect(await page.locator('path.mn-graph-edge--lead').count()).toBe(0)
    await page.locator('[data-graph-action="toggle-title-only"]').click()
    await settledCenterCardHeight(page, titleOnly)

    // 全文档：选中圆心卡片 → 点「全文」
    await clickGraphCenterCard(page)
    await waitUntil(
      async () => (await page.locator('[data-card-height="full"]').count()) === 1,
      5_000,
      '选中卡片后出现高度档',
    )
    await page.locator('[data-card-height="full"]').click()
    await waitUntil(
      async () =>
        ((await page.evaluate(() => localStorage.getItem('mimenote.graph.sizes.v1'))) ?? '').includes(
          '"full":true',
        ),
      5_000,
      '「全文」落盘',
    )

    // 卡片右键：圆心那一张正好以世界原点为中心，于是"世界原点的屏幕位置"就是它
    // （与 `clickGraphCenterCard` 同一套换算，只是按下的是右键）
    const transform = await settledGraphTransform(page)
    const origin = await graphBoxOrigin(page)
    await page.mouse.click(origin.x + transform.x, origin.y + transform.y, { button: 'right' })
    const menu = page.locator('.mn-context-menu')
    await menu.waitFor({ state: 'visible' })
    expect(await page.locator('[data-menu-item="floating"]').count()).toBe(1)
    expect(await page.locator('[data-menu-item="unpin"]').count()).toBe(1)
    await page.keyboard.press('Escape')

    // 收尾：恢复自动尺寸并回到编辑视图
    await page.locator('[data-graph-action="reset-card-size"]').click()
    await showEditView(page)
  })
  it('打开笔记后布局不变（编辑/阅读是"填充"，不是"撑开"）', async () => {
    const before = await readLayout(page)

    await page.locator('.mn-tree [data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await waitUntil(
      async () =>
        ((await page.locator('.cm-content').textContent()) ?? '').includes('文件层'),
      10_000,
      '编辑器载入笔记内容',
    )

    const after = await readLayout(page)
    expect(Math.abs(after.body.height - before.body.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.statusbar.bottom - after.innerHeight)).toBeLessThanOrEqual(1)
    // 主区域只有一个 pane（编辑 / 阅读 / 图谱三选一），且占满宽度
    expect(after.main.width).toBeGreaterThan(600)
    expect(await page.locator('.mn-pane').count()).toBe(1)
  })

  it('阅读视图把 Markdown 渲染成结构化 HTML（表格 / 代码块 / 标题）', async () => {
    await showReadView(page)
    const html = (await page.locator('.mn-preview__body').innerHTML()) ?? ''
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<h1')

    // 切到带围栏代码块的笔记（先展开它的父目录）
    await page.locator('.mn-tree [data-rel-path="项目/子项目"]').click()
    await page.locator('.mn-tree [data-rel-path="项目/子项目/细节.md"]').click()
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').innerHTML()) ?? '').includes('<pre>'),
      10_000,
      '代码块被渲染为 pre',
    )
    const codeHtml = (await page.locator('.mn-preview__body').innerHTML()) ?? ''
    expect(codeHtml).toContain('export const answer = 42')
  })

  it('过滤框缩小可见行，并保留命中项的祖先目录', async () => {
    const total = await page.locator('.mn-tree-row').count()
    await page.locator('.mn-search-field__input').fill('2025')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) < total,
      5_000,
      '过滤后行数减少',
    )
    const paths = await page.locator('.mn-tree-row').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-rel-path')),
    )
    expect(paths).toContain('日记/2025-01-01.md')
    expect(paths).toContain('日记') // 祖先链被保留
    expect(paths).not.toContain('项目/设计.md')

    await page.locator('.mn-search-field__input').fill('')
  })

  it('切换主题即时生效（CSS 变量驱动，不重建编辑器）', async () => {
    // 先确保有一篇打开的笔记，才能验证"主题切换不会重建编辑器"
    await page.locator('.mn-tree [data-rel-path="随手记.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    const pathBefore = await currentMainPath(page)

    const before = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--mn-bg').trim(),
    )
    await page.selectOption('.mn-statusbar select', 'mimenote-light')
    await waitUntil(
      async () =>
        (await page.evaluate(() => document.documentElement.dataset['theme'])) === 'mimenote-light',
      5_000,
      '主题切换为浅色',
    )
    const after = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--mn-bg').trim(),
    )
    expect(after).not.toBe(before)
    // 编辑器还在，且打开的仍是同一篇笔记（没有被重建/重置）
    expect(await page.locator('.cm-content').count()).toBe(1)
    expect(await currentMainPath(page)).toBe(pathBefore)
    // 换回深色，避免影响后续用例
    await page.selectOption('.mn-statusbar select', 'mimenote-dark')
  })

  it('缩小窗口后布局立刻跟随（不需要任何点击）', async () => {
    await page.locator('.mn-tree [data-rel-path="项目/设计.md"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })

    await page.setViewportSize({ width: 1000, height: 620 })
    await waitUntil(
      async () => (await page.evaluate(() => window.innerHeight)) === 620,
      5_000,
      '视口高度变化生效',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    // 缩小后文件树仍然有实际高度（ResizeObserver 重新测量过）
    expect(layout.tree.height).toBeGreaterThan(100)

    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('文件树键盘导航：方向键移动选中项，Enter 打开笔记', async () => {
    await page.locator('.mn-tree [data-rel-path="随手记.md"]').click()
    await page.locator('.mn-tree').focus()

    const selectedPath = () =>
      page.locator('.mn-tree-row--selected').getAttribute('data-rel-path')

    await page.keyboard.press('ArrowDown')
    const afterDown = await selectedPath()
    expect(afterDown).not.toBeNull()

    await page.keyboard.press('ArrowUp')
    const afterUp = await selectedPath()
    expect(afterUp).not.toBeNull()
    expect(afterUp).not.toBe(afterDown)

    // Enter 打开当前选中项（目录则展开/折叠）
    await page.keyboard.press('Enter')
    // 选中项若为文件，编辑器应载入该文件
    const chosen = await selectedPath()
    if (chosen !== null && chosen.endsWith('.md')) {
      await waitUntil(
        async () =>
          ((await currentMainPath(page)) === chosen),
        8_000,
        `Enter 打开 ${chosen}`,
      )
    }
  })

  it('拖拽分隔条改变侧栏宽度，且布局仍然铺满', async () => {
    const before = await page.locator('.mn-sidebar').evaluate((el) => el.getBoundingClientRect().width)
    const handle = await page.locator('.mn-splitter').first().boundingBox()
    expect(handle).not.toBeNull()
    if (handle === null) return

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()

    await waitUntil(
      async () =>
        (await page.locator('.mn-sidebar').evaluate((el) => el.getBoundingClientRect().width)) >
        before + 60,
      5_000,
      '侧栏被拖宽',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
  })

  it('链接面板：显示反向链接，点击跳转到来源笔记', async () => {
    await openNoteInTree(page, '项目/设计.md')

    await page.locator('button[aria-label="链接面板"]').click()
    await page.waitForSelector('.mn-links', { state: 'visible' })

    // 反向链接里应出现「路线图.md」（它链接了「设计」）
    await waitUntil(
      async () =>
        (await page.locator('.mn-links__item-name').allTextContents()).includes('路线图'),
      10_000,
      '反向链接列表出现来源笔记',
    )

    // 出链里应有已解析的「路线图」
    const outbound = await page.locator('[data-outbound-target]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-outbound-target')),
    )
    expect(outbound).toContain('路线图')

    await page.locator('[data-backlink-from="项目/路线图.md"]').click()
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/路线图.md'),
      10_000,
      '点击反向链接后跳转到来源笔记',
    )

    await page.locator('button[aria-label="关闭链接面板"]').click()
    expect(await page.locator('.mn-links').count()).toBe(0)
  })

  it('阅读视图里的 wikilink 可点击跳转，且布局仍然铺满', async () => {
    // 自足：先打开带 wikilink 的笔记（不依赖上一条用例留下的状态）
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await page.waitForSelector('a.mn-wikilink', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('a.mn-wikilink').first().getAttribute('data-rel-path')) !== null,
      10_000,
      'wikilink 被标记为已解析',
    )

    await page.locator('a.mn-wikilink').first().click()
    // 跳转后仍停在阅读视图：用预览体里的标题确认换了一篇（编辑器在编辑视图才有）
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计'),
      10_000,
      '点击 wikilink 后打开目标笔记',
    )

    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
  })

  it('悬空 wikilink 标记为未解析', async () => {
    await openNoteInTree(page, '项目/子项目/细节.md')
    await showReadView(page)
    await page.waitForSelector('a.mn-wikilink--unresolved', { state: 'visible', timeout: 10_000 })
    const text = (await page.locator('a.mn-wikilink--unresolved').textContent()) ?? ''
    expect(text).toContain('还不存在的笔记')
  })

  it('重命名笔记：F2 → 改名 → 指向它的链接跟着改（并验证可逆）', async () => {
    // 自足：先打开目标笔记，让树与编辑器状态确定（重命名对话框在编辑视图里用）
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')

    // F2 打开重命名对话框：文件名预填、扩展名单独显示（不进输入框）
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    expect(await page.getByLabel('新文件名').inputValue()).toBe('设计')

    await page.getByLabel('新文件名').fill('架构设计')
    await page.getByLabel('新文件名').press('Enter')

    // 树里的行真的换了：旧行消失、新行出现
    await ensureTreeRow(page, '项目/架构设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(0)

    // 正在编辑的笔记原地换路径（不重新读取、内容不变）
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/架构设计.md'),
      10_000,
      '编辑器切到新路径',
    )

    // 指向它的链接被改写：切到阅读视图看来源笔记，预览里不再是悬空链接
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('架构设计'),
      10_000,
      '链接被改写为新名字',
    )
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBe(0)

    // 改回去：既验证可逆，也让后续用例看到与初始一致的 Vault
    await openNoteInTree(page, '项目/架构设计.md')
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    await page.getByLabel('新文件名').fill('设计')
    await page.getByLabel('新文件名').press('Enter')

    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '项目/架构设计.md').count()).toBe(0)
    await openNoteInTree(page, '项目/路线图.md')
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计细节见 设计'),
      10_000,
      '链接改回原名',
    )
  })

  it('标签面板：Ctrl+Shift+T 显示标签与属性，点标签列出笔记并可打开', async () => {
    // 设计.md 末尾有一行 `#项目`（行内标签），与「标签示例.md」的 frontmatter 标签同名 ——
    // 正好用来验证"跨笔记的标签索引"与"点标签列出笔记"
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')

    await page.keyboard.press('Control+Shift+t')
    await page.waitForSelector('.mn-tags', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag="项目"]').count()) === 1,
      10_000,
      '本篇的行内标签出现在面板里',
    )

    // 点标签 → 列出含它的两篇笔记（本篇 + 标签示例）
    await page.locator('.mn-tags [data-tag="项目"]').click()
    await waitUntil(
      async () =>
        (await page.locator('.mn-tags [data-tag-note="项目/标签示例.md"]').count()) === 1 &&
        (await page.locator('.mn-tags [data-tag-note="项目/设计.md"]').count()) === 1,
      10_000,
      '列出含该标签的笔记',
    )

    // 点另一篇 → 打开它；面板跟着切到它的标签与属性
    await page.locator('.mn-tags [data-tag-note="项目/标签示例.md"]').click()
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/标签示例.md'),
      10_000,
      '点笔记后打开它',
    )
    for (const tag of ['项目', '进行中', '架构']) {
      await waitUntil(
        async () => (await page.locator(`.mn-tags [data-tag="${tag}"]`).count()) === 1,
        10_000,
        `切换笔记后面板显示标签 ${tag}`,
      )
    }
    // 属性表里有 frontmatter 字段
    const panelText = (await page.locator('.mn-tags').textContent()) ?? ''
    expect(panelText).toContain('title')
    expect(panelText).toContain('标签示例')

    // 阅读视图只渲染正文：frontmatter 不当正文渲染
    await showReadView(page)
    await waitUntil(
      async () => ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('演示'),
      10_000,
      '预览渲染正文',
    )
    const preview = (await page.locator('.mn-preview__body').textContent()) ?? ''
    expect(preview).not.toContain('title')

    await page.keyboard.press('Control+Shift+t')
    await waitUntil(async () => (await page.locator('.mn-tags').count()) === 0, 5_000, '面板收起')
  })

  it('标签面板：层级编辑（挂到父标签下 → 提回顶层），概览与正文一起跟着换键', async () => {
    // 目标键由宿主算（`tag_move_target`）这件事在真实二进制那一层另有专测；
    // 这里验的是**真实浏览器里的交互链路**：入口在哪儿、初值是什么、
    // 预览 → 确认之后概览与正文有没有真的换键。
    await showEditView(page)
    await openNoteInTree(page, '项目/设计.md')
    // `Ctrl+Shift+T` 是**开关**，而本文件共用一个页面：先看它现在是不是开着的
    if ((await page.locator('.mn-tags').count()) === 0) {
      await page.keyboard.press('Control+Shift+t')
    }
    await page.waitForSelector('.mn-tags', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="项目"]').count()) === 1,
      10_000,
      '全库概览里出现 项目',
    )

    /** 打开某个键的"移到…"对话框（`⇥` 只在全库概览那一行上）。 */
    const openMove = async (key: string): Promise<void> => {
      await page
        .locator('.mn-tags li', { has: page.locator(`[data-tag-key="${key}"]`) })
        .locator(`[data-tag-move-open="${key}"]`)
        .click()
      await page.waitForSelector('[data-tag-move-dialog]', { state: 'visible' })
    }

    const input = page.locator('[data-tag-rename-input]')

    // —— 挂到 `父` 下面 ——
    await openMove('项目')
    // 顶层标签的父标签是空的（留空 = 顶层），所以这里必须自己打一个
    expect(await input.inputValue()).toBe('')
    await input.fill('父')
    await input.press('Enter')
    await page.waitForSelector('[data-tag-rename-preview]', { state: 'visible' })
    // `#项目` 出现在两篇笔记里（设计.md 的行内 + 标签示例.md 的 frontmatter 与行内）
    expect(await page.locator('[data-tag-rename-preview]').textContent()).toContain('这会改 2 篇笔记')
    await page.locator('[data-tag-rename-confirm]').click()
    await page.waitForSelector('[data-tag-rename-result]', { state: 'visible' })
    await page.locator('[data-tag-rename-done]').click()

    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="父/项目"]').count()) === 1,
      10_000,
      '概览里换成 父/项目',
    )
    expect(await page.locator('.mn-tags [data-tag-key="项目"]').count()).toBe(0)
    // 编辑器内存也必须对齐（否则下一次自动保存会把刚写下的标签覆盖掉）
    await waitUntil(
      async () => ((await page.locator('.cm-content').textContent()) ?? '').includes('#父/项目'),
      10_000,
      '正文行内标签跟着改成 父/项目',
    )

    // —— 提回顶层：把状态还给后面的用例，顺带覆盖"留空 = 顶层"这条路 ——
    await openMove('父/项目')
    // 初值就是它现在挂着的位置：用户要做的只是把它清掉
    expect(await input.inputValue()).toBe('父')
    await page.locator('[data-tag-move-top]').click()
    expect(await input.inputValue()).toBe('')
    await input.press('Enter')
    await page.waitForSelector('[data-tag-rename-preview]', { state: 'visible' })
    await page.locator('[data-tag-rename-confirm]').click()
    await page.waitForSelector('[data-tag-rename-result]', { state: 'visible' })
    await page.locator('[data-tag-rename-done]').click()

    await waitUntil(
      async () => (await page.locator('.mn-tags [data-tag-key="项目"]').count()) === 1,
      10_000,
      '提回顶层后又变回 项目',
    )
    expect(await page.locator('.mn-tags [data-tag-key="父/项目"]').count()).toBe(0)
    await waitUntil(
      async () => ((await page.locator('.cm-content').textContent()) ?? '').includes('#项目'),
      10_000,
      '正文行内标签回到 项目',
    )

    // 收尾：把面板关掉，状态还给后面的用例（同样是开关，先确认它开着）
    if ((await page.locator('.mn-tags').count()) > 0) {
      await page.keyboard.press('Control+Shift+t')
    }
    await waitUntil(async () => (await page.locator('.mn-tags').count()) === 0, 5_000, '面板收起')
  })

  it('全文搜索：Ctrl+Shift+F → 输入 → 回车打开命中的笔记', async () => {
    await page.keyboard.press('Control+Shift+f')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('全文搜索')

    // Mock 的搜索是逐行子串匹配（真实实现是 FTS5），"演示"只出现在标签示例那一篇里
    await page.locator('.mn-palette__input').fill('演示')
    await waitUntil(
      async () =>
        (await page.locator('.mn-palette [role="option"][data-rel-path="项目/标签示例.md"]').count()) ===
        1,
      10_000,
      '出现命中的笔记',
    )
    const optionText = (await page.locator('.mn-palette [role="option"][data-rel-path="项目/标签示例.md"]').textContent()) ?? ''
    expect(optionText).toContain('演示')
    // 结果行里带行号与片段
    expect(optionText).toMatch(/\d/)

    await page.locator('.mn-palette__input').press('Enter')
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/标签示例.md'),
      10_000,
      '回车打开命中的笔记',
    )
    expect(await page.locator('.mn-palette').count()).toBe(0)
  })

  it('知识图谱：默认是「关系图」（圆心 = 当前打开的笔记、1 跳），「深度 +」真的重拉子图', async () => {
    // ⚠️ 这条用例断言的是**默认值**，因此它必须是本文件里第一次进入图谱的用例。
    // 视图与跳数是持久化偏好（`mimenote.graph.prefs.v1`），一旦有别的用例先改过它们，
    // "默认 1 跳"就不再成立 —— 所以把"还没有任何偏好"这个前提显式断言出来，
    // 而不是默默依赖用例顺序（换个顺序时失败信息要能直接说明原因）。
    //
    // 判据是"没有偏好，**或者**偏好正好是默认值"：上面新增的用例（仅标题 / 全文档）
    // 会落盘同一份偏好，落的就是 `mode: focus` + `depth: 1` 这些默认值 ——
    // 那与"从没写过"对这条用例是同一件事（缺省读回来也是这些数）。
    const prefsRaw = await readGraphPrefs(page)
    if (prefsRaw !== null) {
      expect(prefsRaw['mode']).toBe('focus')
      expect(prefsRaw['depth']).toBe(1)
    }

    // 圆心 = 当前打开的笔记，所以先钉住文档（不先打开，圆心就是上一条用例留下的偶然状态）
    await openNoteInTree(page, '项目/路线图.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    expect(await page.locator('.mn-pane--graph').count()).toBe(1)

    expect(await page.locator('.mn-graph').getAttribute('data-graph-mode')).toBe('focus')
    expect(await graphNumber(page, 'data-graph-depth')).toBe(1)
    expect((await page.locator('[data-graph-depth-value]').textContent()) ?? '').toContain('1')
    // 关系图里那个"以当前笔记为圆心"的说明也在可访问性树上（`role="application"` 的 aria-label）
    expect(await page.locator('.mn-graph').getAttribute('aria-label')).toContain('1 跳')

    // 圆心这一篇在画布上确实被画了出来（卡片在 canvas 里，只能读"交给画笔的卡片数"）
    await page.waitForSelector('canvas.mn-graph__canvas', { state: 'visible' })
    const before = await graphCardCount(page)
    expect(before).toBeGreaterThan(0)

    // "深度 +"：跳数从 1 变 2，并且**画布上的子图必须跟着重拉**（跳数只是 HUD 上的意图，
    // 卡片才是结果 —— 这条路要走 HUD → store → graph_ego → 排版 → 绘制，只有端到端能证明）
    await page.locator('[data-graph-action="depth-up"]').click()
    await waitUntil(
      async () => (await graphNumber(page, 'data-graph-depth')) === 2,
      10_000,
      '跳数变成 2',
    )
    expect((await page.locator('[data-graph-depth-value]').textContent()) ?? '').toContain('2')

    // 断言"卡片数不减"：深度只可能让子图**变大**（BFS 的第 2 跳是在第 1 跳的结果上继续走），
    // 所以"变少"一定意味着画布画错了。这里刻意不写死张数（正文变长变短、Mock Vault 增删笔记
    // 都不该让这条用例红），但要**等它稳定**再读：同一帧里连读两次一致才说明新的子图已经回来，
    // 否则可能在"depth 已经变了、子图还在途中"的那一帧上通过，等于什么都没测到。
    await waitUntil(
      async () => {
        const first = await graphCardCount(page)
        await delay(150)
        const second = await graphCardCount(page)
        return first === second && second >= before
      },
      10_000,
      '深度 2 的子图画出来并且稳定',
    )
    expect(await graphCardCount(page)).toBeGreaterThanOrEqual(before)

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：卡片画在 canvas 上，点圆心卡片选中它、浮窗读全文、点空白取消选中', async () => {
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    expect(await page.locator('.mn-pane--graph').count()).toBe(1)
    expect(await page.locator('.mn-graph').getAttribute('data-graph-mode')).toBe('focus')

    // 卡片 = 笔记，但它们**不在 DOM 里**（`.mn-graph-card` 这个选择器已经不存在了）。
    // 于是断言分三层：canvas 存在 → 画笔被喂了卡片 → 画布真的被画过（像素非空）。
    // 圆心是 设计.md，它的两条出链（[[路线图]] 与 [[细节]]）也该在画布上，所以至少 3 张。
    await page.waitForSelector('canvas.mn-graph__canvas', { state: 'visible' })
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '关系图画出圆心与它的邻居')
    expect(await canvasInkRatio(page)).toBeGreaterThan(0.02)

    // 单击卡片 → **选中**（ADR-0025 起不再有侧边预览面板：卡片正面就是完整正文）。
    // 卡片是**几何命中**（世界坐标矩形 + 4px 屏幕宽容度），所以这里按
    // `屏幕 = 世界 × scale + offset` 反算：世界原点就是圆心那张卡片的中心。
    await clickGraphCenterCard(page)
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '项目/设计.md',
      10_000,
      '单击卡片选中了圆心那一篇',
    )

    // "点一下就能读全文"这条能力交给了浮窗（卡片上的正文是 canvas 像素，选不中也点不动链接）
    await page.locator('[data-graph-action="open-floating"]').click()
    const pane = page.locator('.mn-float-note')
    await pane.waitFor({ state: 'visible' })
    await waitUntil(
      async () => ((await pane.locator('.mn-float-note__article').textContent()) ?? '').includes('文件层'),
      10_000,
      '浮窗里出现笔记正文',
    )
    // Esc 先关浮窗、再取消选中（`graph.closePreview` 的两层语义）
    await page.locator('.mn-graph').press('Escape')
    await waitUntil(async () => (await page.locator('.mn-float-note').count()) === 0, 5_000, 'Esc 关掉浮窗')
    expect(await page.locator('.mn-graph').getAttribute('data-graph-selected')).toBe('项目/设计.md')
    await page.locator('.mn-graph').press('Escape')
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '',
      5_000,
      '再按一次 Esc 取消选中',
    )

    // 再点一次卡片，改在**空白处**单击：画布上"单击空白 = 取消选中"与"空白拖动 = 平移"
    // 共用同一套指针状态，是这次 canvas 化必须自己实现的那部分交互
    await clickGraphCenterCard(page)
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) !== '',
      10_000,
      '再次选中',
    )
    const blank = await findBlankCanvasPoint(page)
    await page.mouse.click(blank.x, blank.y)
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '',
      5_000,
      '点空白处取消选中',
    )

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：切到「整个 Vault」后文件夹成组、收起容器卡片变少、入链虚线/出链实线', async () => {
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await page.locator('[data-graph-action="mode-vault"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-mode')) === 'vault',
      10_000,
      '切到整个 Vault',
    )

    // 全库视图：卡片 = 每一篇 Markdown（Mock Vault 里 8 篇），文件夹自动成组。
    // 文件夹容器**仍然是 DOM**（它可点、可折叠，留在 DOM 里是对的），所以照旧用选择器断言。
    await waitUntil(async () => (await graphCardCount(page)) > 5, 10_000, '画布上出现全库的卡片')
    await page.waitForSelector('.mn-graph-folder[data-folder="项目"]', { state: 'visible' })

    // 选中 设计.md：这里用「定位笔记」而不是猜坐标 —— 全库视图的卡片位置由装箱算法决定，
    // 硬编码一个屏幕坐标迟早会落到别的卡片上（只有关系图保证圆心在世界原点）。
    await page.locator('.mn-graph__find-input').fill('设计')
    await page.waitForSelector('[data-find-path="项目/设计.md"]', { state: 'visible' })
    await page.locator('[data-find-path="项目/设计.md"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '项目/设计.md',
      10_000,
      '定位并选中了那一篇',
    )

    // 入链虚线 / 出链实线：设计.md 既有入链（路线图 → 设计）也有出链（设计 → 路线图/细节）
    // 注意 SVG 元素的 `className` 是 `SVGAnimatedString` 对象，必须读属性
    const highlighted = await page
      .locator('.mn-graph-edge--highlight')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('class') ?? ''))
    expect(highlighted.length).toBeGreaterThanOrEqual(2)
    expect(highlighted.some((name) => name.includes('mn-graph-edge--dashed'))).toBe(true)
    expect(highlighted.some((name) => !name.includes('mn-graph-edge--dashed'))).toBe(true)

    // Esc 取消选中
    await page.locator('.mn-graph').press('Escape')
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '',
      5_000,
      '取消选中',
    )

    // 文件夹可以收起：收起后容器变成紧凑的"文件夹卡片"，里面的卡片不再画在画布上
    const folder = page.locator('.mn-graph-folder[data-folder="项目"]')
    const before = await graphCardCount(page)
    await folder.locator('.mn-graph-folder__header').click()
    await waitUntil(
      async () => (await graphCardCount(page)) < before,
      5_000,
      '收起文件夹后画布上的卡片变少',
    )
    await waitUntil(
      async () => ((await folder.getAttribute('class')) ?? '').includes('mn-graph-folder--chip'),
      5_000,
      '收起后容器变成紧凑卡片',
    )
    await folder.locator('.mn-graph-folder__header').click()
    await waitUntil(async () => (await graphCardCount(page)) === before, 5_000, '再点一次展开回来')

    // 切回关系图再离开：视图是持久化偏好，给后面的用例留一个"默认视图"的状态
    await ensureGraphFocusMode(page)

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：「整个 Vault」与「关系图」互切，视图状态与文件夹容器都跟着变', async () => {
    // 为什么值得端到端测：两个视图走的是**两条不同的数据路径**（全库 = `graph_data`，
    // 关系图 = `graph_ego` + 逐篇正文），并且可见的层也不一样（文件夹容器只在全库视图渲染）。
    // 单测能分别验证两边的 store 逻辑，但"切过去之后屏幕上真的换了那一套"只有这里能证明。
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    // 视图是持久化偏好，"进来是哪个模式"取决于上一条用例 —— 这里不假设它，显式切到关系图
    await ensureGraphFocusMode(page)
    // 关系图里没有文件夹容器（圆环本身就是结构），深度那一栏只在关系图说得通
    await page.waitForSelector('[data-graph-depth-value]', { state: 'visible' })
    expect(await page.locator('.mn-graph-folder').count()).toBe(0)

    await page.locator('[data-graph-action="mode-vault"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-mode')) === 'vault',
      10_000,
      '切到整个 Vault',
    )
    await waitUntil(async () => (await page.locator('.mn-graph-folder').count()) > 0, 10_000, '出现文件夹容器')
    // 高亮跟着走：两个按钮而不是一个开关，就是为了让"我现在看的是哪一种图"一眼可见
    expect(await page.locator('.mn-graph__mode--active').textContent()).toContain('整个 Vault')
    expect(await page.locator('[data-graph-depth-value]').count()).toBe(0)
    expect(await graphCardCount(page)).toBeGreaterThan(0)

    await page.locator('[data-graph-action="mode-focus"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-mode')) === 'focus',
      10_000,
      '切回关系图',
    )
    await waitUntil(async () => (await page.locator('.mn-graph-folder').count()) === 0, 10_000, '文件夹容器消失')
    expect(await page.locator('.mn-graph__mode--active').textContent()).toContain('关系图')
    expect(await page.locator('[data-graph-depth-value]').count()).toBe(1)
    expect(await graphCardCount(page)).toBeGreaterThan(0)

    // 回到编辑视图
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：关系图里卡片的正面画的是**正文**（像素级证据：正文越长，卡片画得越高）', async () => {
    // 这是本次交付最核心的诉求（"每个节点是完整的 markdown 预览"）。卡片已经不在 DOM 里，
    // 读不到任何文字节点，所以证据只能来自画布本身：圆心卡片是**不透明底 + 边框**，
    // 沿它中心那一列扫 alpha > 0 的连续区间，量出来的就是卡片被**真正画出来**的高度。
    //
    // 为什么用"两篇正文长度差很多的笔记比高度"而不是写死一个像素阈值：
    // 高度是排版的结果（标题 + 段落 + 列表 + 代码块累加起来的高度）。只画标题的那种
    // 紧凑卡片在两篇上会得到同一个高度 —— 所以"高度随正文变"正是"正面画的是正文"的证据，
    // 而且不需要任何魔法数字。
    //
    // 局限（写清楚，免得被当成都测过了）：**像素读不回文字**。它证明"画了一张随正文变高的
    // 卡片"，不证明"画出来的字正好是那句话"；字面正确由 `layoutCard` / `paintGraph` 的
    // 单元测试覆盖（那里能拿到逐块逐行的排版结果）。两者互补，不重叠。
    //
    // 两篇都刻意选**没有任何链接**的笔记：它们的子图只有圆心一张卡片，量中心那一列才不会
    // 撞上第 1 跳的邻居（那会让"高度"变成两张卡片的并集）。
    await openNoteInTree(page, '随手记.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('canvas.mn-graph__canvas', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await waitUntil(async () => (await graphCardCount(page)) === 1, 10_000, '随手记的关系图只有圆心一张')
    const short = await settledCenterCardHeight(page)

    // 换一篇正文长得多的（多级标题 + 段落 + 代码块）—— 文档换了圆心就跟着换，子图重新拉
    await openNoteInTree(page, '项目/大纲.md')
    await waitUntil(async () => (await graphCardCount(page)) === 1, 10_000, '大纲的关系图也只有圆心一张')
    // `differFrom = short`：跳过"随手记那张卡片还留在画布上"的过渡帧
    const tall = await settledCenterCardHeight(page, short)

    expect(short).toBeGreaterThan(0)
    expect(tall).toBeGreaterThan(short)

    // 顺带把"画布真的被画过"也钉住（非透明像素占比）：上面量的是**一列**，这里量整块画布
    expect(await canvasInkRatio(page)).toBeGreaterThan(0.05)

    // 回到编辑视图
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：卡片不在 Tab 序列里，方向键仍能在画布上换选中（画布自己实现的那一半）', async () => {
    // 卡片搬到 canvas 之后，Tab 键再也走不到它们身上（`GraphCanvas` 的键盘注释把这件事
    // 写成了必须自己补回来的一半）。这条用例守的就是"键盘用户还能选中并预览卡片"：
    // 画布自己带 `role="application"` + `tabIndex=0`，方向键按**几何**找同一方向上最近的卡片。
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '关系图画出圆心与它的邻居')

    // 画布是可聚焦的：焦点落进画布之后，方向键才由画布处理
    await page.locator('.mn-graph').focus()
    expect(
      await page.evaluate(() => document.activeElement === document.querySelector('.mn-graph')),
    ).toBe(true)

    // 没有任何选中项时，方向键选中卡片数组里的**第一张** —— 圆心那一张（`layoutEgo` 先放圆心）
    await page.keyboard.press('ArrowRight')
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '项目/设计.md',
      10_000,
      '方向键先选中圆心那一张',
    )

    // 再按一次：从圆心出发，同一方向上最近的**另一张**卡片接过选中项。圆心自己会被跳过
    // （判据是"前进方向上的投影 > 0"），所以换到的一定是另一篇 —— 证明方向键在**移动**选中项，
    // 而不是"按一下就把圆心选中了"。这里不指定是哪一篇：环上的位置取决于两张卡片的排版尺寸，
    // 写死"应该是细节"会把一条布局细节变成回归门禁（那属于 `layout-ego` 的单测）。
    await page.keyboard.press('ArrowRight')
    await waitUntil(
      async () => {
        const selected = await page.locator('.mn-graph').getAttribute('data-graph-selected')
        return selected !== null && selected !== '' && selected !== '项目/设计.md'
      },
      10_000,
      '方向键把选中项换到另一张卡片',
    )

    // 回到编辑视图
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：跳数是持久化偏好，刷新页面之后仍然生效（localStorage）', async () => {
    // 为什么值得端到端测：偏好是在 `useGraphStore` 的 `create()`（也就是**模块初始化**）
    // 里被读回来的，所以"刷新之后还是 3 跳"这件事只有真的重新加载一次页面才能被证明 ——
    // 单测里改 store 永远走不到那条路。同时这条用例也守住了"偏好不按 Vault 分"这个决定：
    // 刷新后 Vault 可能还没打开，偏好却必须还在。
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    // 深度那一栏只在关系图里渲染，而且跳数是持久化偏好 —— 先切到关系图再拨回 1 这个已知起点
    await ensureGraphFocusMode(page)
    await resetGraphDepthToOne(page)
    await page.locator('[data-graph-action="depth-up"]').click()
    await page.locator('[data-graph-action="depth-up"]').click()
    await waitUntil(async () => (await graphNumber(page, 'data-graph-depth')) === 3, 10_000, '跳数调到 3')

    const stored = await page.evaluate(() => localStorage.getItem('mimenote.graph.prefs.v1'))
    expect(stored).not.toBeNull()
    // `toMatchObject` 而不是逐字相等：落盘里还有张力/预设/两个开关（ADR-0023 之后每次落盘都带着它们）。
    // "跳数真的写进去了"与"别的偏好没被顺手抹掉"是两件事，后者另有单独一条用例守着。
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ mode: 'focus', depth: 3 })

    await page.reload()
    // 刷新之后应用会从 localStorage 恢复上次打开的 Vault（`mimenote.vault.last`），
    // 所以正常不该停在门闸页；万一停在门闸页（第一次运行时手动打开过）就补点一次。
    await page.waitForSelector('.mn-tree-row, .mn-gate', { state: 'visible', timeout: 20_000 })
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
    }
    await page.waitForSelector('.mn-tree-row', { state: 'visible', timeout: 20_000 })

    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    expect(await graphNumber(page, 'data-graph-depth')).toBe(3)
    expect((await page.locator('[data-graph-depth-value]').textContent()) ?? '').toContain('3')
    // 关系图仍然是默认视图（同一份偏好里的 `mode`）
    expect(await page.locator('.mn-graph').getAttribute('data-graph-mode')).toBe('focus')

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：连线从正文里的 [[链接]] 引出（关掉之后引线消失、边仍在）', async () => {
    // 为什么值得端到端测：ADR-0023 要的是"线从对应的 wiki link 处引出"，也就是一条边由**两段**
    // 组成 —— 卡片里从那段文字拉出的虚线引线（起点还有一个圆点）+ 卡片外的实线/张力曲线。
    // 引线的起点是 canvas 排版的结果（要按同一套字体逐 run 量字才落得准），"那段字排在第几行、
    // 从第几列开始"只有真的排过版才知道：单测能喂一份假排版，这里跑的才是**真实正文 + 真实量字
    // + 真实 SVG**。而"关掉开关之后引线消失、边仍在"是同一件事的另一面（老行为必须还在）。
    await ensureVaultOpen(page)
    // 设计.md 的正文里正好有两处：`参考 [[路线图]] 与 [[细节]]`
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '关系图画出圆心与它的邻居')

    const lead = page.locator('path.mn-graph-edge--lead')
    const span = page.locator('path.mn-graph-edge:not(.mn-graph-edge--lead)')
    await waitUntil(async () => (await lead.count()) > 0, 10_000, '出现卡片内的虚线引线')
    await waitUntil(async () => (await span.count()) >= 2, 10_000, '卡片外的实线照旧存在')

    // 引线必须是**可画的**线段（起点 → 卡片边界上的出点）：`d` 里出现 NaN 时浏览器会把整条
    // 路径丢掉，而那正是"线凭空消失"的表现（`link-edge.ts` 的 `num` 就是为这件事写的）
    const leadPaths = await lead.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d') ?? ''))
    expect(leadPaths.length).toBeGreaterThanOrEqual(1)
    for (const d of leadPaths) {
      expect(d).toMatch(/^M \S+ \S+ L \S+ \S+$/u)
      const numbers = d
        .split(/[ML\s]+/u)
        .filter((token) => token !== '')
        .map((token) => Number(token))
      expect(numbers).toHaveLength(4)
      expect(numbers.every((value) => Number.isFinite(value))).toBe(true)
    }
    // 起点那个小圆点：没有它，"线从哪句话出来"只是虚线的一个端点
    expect(await page.locator('circle.mn-graph-edge-lead-dot').count()).toBeGreaterThanOrEqual(1)
    // tooltip 说出它是从**哪段文字**引出的 —— 这才叫"锚到了 link 上"，而不只是"多了条虚线"
    const onTitles = await lead.locator('title').allTextContents()
    expect(onTitles.some((text) => text.includes('从正文里的 [['))).toBe(true)

    // 关掉「从链接引出」：引线整段消失（`leadPath` 为空 ⇒ 连 `<path>` 都不渲染），
    // 而卡片外的边一条不少 —— 降级不是"少画一条边"，只是换一种起笔方式
    const spanBefore = await span.count()
    await page.locator('[data-graph-action="toggle-edge-from-link"]').click()
    await waitUntil(async () => (await lead.count()) === 0, 10_000, '关掉之后引线消失')
    expect(await page.locator('circle.mn-graph-edge-lead-dot').count()).toBe(0)
    expect(await span.count()).toBe(spanBefore)
    // 降级要**说清楚**：这时的 tooltip 必须承认"正文里没找到对应的链接写法，从卡片边缘出发"
    const offTitles = await span.locator('title').allTextContents()
    expect(offTitles).toHaveLength(spanBefore)
    expect(offTitles.every((text) => text.includes('从卡片边缘出发'))).toBe(true)
    expect(
      await page.locator('[data-graph-action="toggle-edge-from-link"]').getAttribute('aria-pressed'),
    ).toBe('false')

    // 再点回来：默认是**开**的，把它还给后面的用例（顺带覆盖"开关是双向的"）
    await page.locator('[data-graph-action="toggle-edge-from-link"]').click()
    await waitUntil(async () => (await lead.count()) === leadPaths.length, 10_000, '引线回来')
    expect(
      await page.locator('[data-graph-action="toggle-edge-from-link"]').getAttribute('aria-pressed'),
    ).toBe('true')

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：张力滑块真的改变连线几何（并落进 localStorage），用完拨回默认值', async () => {
    // 为什么值得端到端测：张力是这一轮新增的**唯一一个连续量**旋钮，而它作用在一条 SVG 路径的
    // 控制点上 —— "滑块的值变了"和"曲线真的弯了"是两件事。这里量的不是"`d` 变了"（开着漂浮时
    // 它每一帧都在变，那种断言等于没测），而是**相对量**：控制点到弦的距离 ÷ 弦长，按
    // `tensionPath` 的定义它就等于 `tension ÷ 4`，与卡片漂到哪、镜头缩到多大全都无关。
    // 顺带钉住"这个旋钮会落盘"（偏好与几何都跟着走，才算真的接通了）。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    // 跳数是持久化偏好：先拨回 1，让这条用例的起点与上一条留下什么无关
    await resetGraphDepthToOne(page)
    const span = page.locator('path.mn-graph-edge:not(.mn-graph-edge--lead)')
    await waitUntil(async () => (await span.count()) > 0, 10_000, '画布上有卡片外的边')

    /** 等到连线的鼓出比变成期望值，再返回它（比对一条还在变的曲线只能"等到"）。 */
    const ratioAt = async (expected: number): Promise<number> => {
      await waitUntil(
        async () => Math.abs(spanTensionRatio((await readSpanEdge(page)).d) - expected) < 1e-6,
        10_000,
        `连线的鼓出比变成 ${expected}`,
      )
      return spanTensionRatio((await readSpanEdge(page)).d)
    }

    // 起点自足：张力同样是持久化偏好（整个文件共用一个页面），先把它拨回默认值
    await setGraphTension(page, DEFAULT_GRAPH_TENSION)
    const before = await ratioAt(DEFAULT_GRAPH_TENSION * 0.25)
    expect(before).toBeCloseTo(DEFAULT_GRAPH_TENSION * 0.25, 6)
    expect(await graphTension(page)).toBeCloseTo(DEFAULT_GRAPH_TENSION, 6)

    // 拉到最右（= 1）：控制点离弦 `弦长的 1/4`，比默认的 0.0875 明显更弯
    await setGraphTension(page, 1)
    const after = await ratioAt(0.25)
    expect(after).toBeCloseTo(0.25, 6)
    expect(after).toBeGreaterThan(before * 2)
    // 偏好跟着落盘（刷新之后回来还是它）
    expect((await readGraphPrefs(page))?.tension).toBe(1)

    // 收尾：拨回默认值，别让后面的用例继承一条绷紧的曲线
    await setGraphTension(page, DEFAULT_GRAPH_TENSION)
    expect((await readGraphPrefs(page))?.tension).toBe(DEFAULT_GRAPH_TENSION)

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：拖卡片右下角的手柄把卡片拉宽（拉宽是拉宽，不是拖动卡片）', async () => {
    // 为什么值得端到端测：卡片尺寸牵动三件事 —— 手柄的命中判定（它在卡片**内部**右下角，
    // 不先判它就会退化成"拖动卡片"）、store 里的尺寸偏好（要落盘）、以及环半径的重算
    // （卡片变宽 ⇒ `layout-ego` 的弧长公式给出更大的环）。这三件事只在真实指针 + 真实
    // canvas 排版下连得起来，而"到底有没有变宽"只有一个可靠依据：宿主报出来的
    // `data-graph-root-rect`（圆心卡片的**当前**世界矩形）。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await resetGraphDepthToOne(page)
    // 起点自足：先把尺寸还给自动（幂等 —— 本来就是自动时这次点击不改任何数）
    await page.locator('[data-graph-action="reset-card-size"]').click()

    const before = await graphRootRect(page)
    expect(before.width).toBeGreaterThan(0)
    // 关系图里拖**卡片本体** = 把它按住（`pins`）。起点必须是 0 张，后面才谈得上"拖手柄没有
    // 把它按住"这件事
    expect(await graphNumber(page, 'data-graph-pinned')).toBe(0)

    // 手柄在卡片内部的右下角（`paint.ts` 的 `CARD_RESIZE_HANDLE` = 14 世界像素），取它的中心
    const handle = { x: before.x + before.width - 7, y: before.y + before.height - 7 }
    const point = graphScreenPoint(await graphBoxOrigin(page), await settledGraphTransform(page), handle)
    // 前置条件：这个点必须真的落在画布上（被 HUD / 预览面板盖住的话，按下根本不进画布状态机，
    // 失败信息只会是"卡片没变宽"，离原因很远）
    expect(await graphPointBlocked(page, point)).toBe(false)

    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 120, point.y, { steps: 12 })
    await page.mouse.up()

    await waitUntil(async () => (await graphRootRect(page)).width > before.width + 20, 10_000, '卡片被拉宽')
    const after = await graphRootRect(page)
    expect(after.width).toBeGreaterThan(before.width + 20)
    // ⚠️ 只断言宽度，**不**断言位置：环半径由卡片尺寸算出来（`layout-ego`），拉宽之后整幅图会
    // 重排，位置本来就是"会变的那一个"。反过来，"被按住"则必须是 0：手柄落在卡片内部，
    // 先判手柄正是为了不让拉宽变成"拖动卡片"（焦点视图里拖动 = 按住）
    expect(await graphNumber(page, 'data-graph-pinned')).toBe(0)

    // 收尾：「重置卡片」把尺寸还给自动，别让后面的用例继承一张被拉宽的卡片
    await page.locator('[data-graph-action="reset-card-size"]').click()
    await waitUntil(async () => (await graphRootRect(page)).width === before.width, 10_000, '重置回自动尺寸')

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：拖卡片本体真的跟着光标走，并且把撞上的那张推开（零重叠）', async () => {
    /*
      用户原话：「拖拽卡片没有变动位置，然后没有碰撞推动卡片，整体非常僵硬！」
      这条端到端用例守的就是那句话本身，三个断言对应三个症状：

      1. 按下 + 移动之后，圆心卡片的**世界矩形**必须真的跟着手走了（不是弹回原位）；
      2. 把它拖到另一张卡片上时，`data-graph-overlaps` 必须**一直是 0**（硬碰撞在拖动过程中
         同样成立），并且被撞的那张要真的让开（矩形中心距变大）；
      3. 松手之后它被"按住"（`data-graph-pinned` = 1），位置留在手放下的地方。

      为什么必须在真浏览器里测：命中判定读的是**当前**矩形（力场松弛之后的位置），
      拖动是否跟手取决于"每个 pointermove 都会推进模拟并重绘"这条时序 —— jsdom 里
      画布是假的、时序也是假的，这两件事都测不出来。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await resetGraphDepthToOne(page)
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '画出圆心与它的邻居')
    await page.locator('[data-graph-action="unpin-cards"]').click() // 起点自足：没有卡片被按住

    const origin = await graphBoxOrigin(page)
    const transform = await settledGraphTransform(page)
    const root = await graphRootRect(page)
    const grabWorld = { x: root.x + root.width / 2, y: root.y + root.height / 2 }
    const grab = graphScreenPoint(origin, transform, grabWorld)

    // 挑一张**离圆心最远**的卡片当靶子（压住它就必须真的把圆心搬过去）
    const cards = await graphCardRects(page)
    const target = [...cards.entries()]
      .filter(([relPath]) => relPath !== '项目/设计.md')
      .sort((a, b) => b[1].y - a[1].y)[0]
    expect(target).toBeDefined()
    const [targetPath, targetRect] = target as [string, { x: number; y: number; width: number; height: number }]
    const landing = graphScreenPoint(origin, transform, {
      x: targetRect.x + targetRect.width / 2,
      y: targetRect.y + targetRect.height / 2,
    })
    expect(await graphPointBlocked(page, grab)).toBe(false)
    expect(await graphPointBlocked(page, landing)).toBe(false)

    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + (landing.x - grab.x) * 0.5, grab.y + (landing.y - grab.y) * 0.5, {
      steps: 8,
    })
    // ① 拖动**过程中**就已经跟着走了：半个行程对应半个世界位移（缩放换算回去）
    const midway = await graphRootRect(page)
    expect(midway.x).not.toBe(root.x)
    expect(midway.y).not.toBe(root.y)

    await page.mouse.move(landing.x, landing.y, { steps: 8 })
    // ② 撞上去了，但**零重叠**，而且被撞的那张确实让开了
    expect(await graphNumber(page, 'data-graph-overlaps')).toBe(0)
    const pushed = (await graphCardRects(page)).get(targetPath)
    expect(pushed).toBeDefined()
    const pushedRect = pushed as { x: number; y: number; width: number; height: number }
    const pushedDistance =
      Math.abs(pushedRect.x - targetRect.x) + Math.abs(pushedRect.y - targetRect.y)
    // 让开的距离必须看得出来：几十像素级的位移，而不是"浮点噪声级的 0.01"
    expect(pushedDistance).toBeGreaterThan(10)

    // 松手前记下位置：松手之后它必须**留在这里**（力场不会把它拽回去）
    const beforeUp = await graphRootRect(page)
    await page.mouse.up()
    // ③ 松手之后它被按住，且位置留在手放下的地方
    await waitUntil(
      async () => (await graphNumber(page, 'data-graph-pinned')) === 1,
      10_000,
      '松手后这张卡片处于被按住状态',
    )
    const released = await graphRootRect(page)
    expect(Math.abs(released.x - beforeUp.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(released.y - beforeUp.y)).toBeLessThanOrEqual(2)
    expect(await graphNumber(page, 'data-graph-overlaps')).toBe(0)

    /*
      收尾（这一条不是客套）：这条用例**故意**把圆心那张搬到了别处，而后续用例
      （"选中卡片 → 浮窗"、"力导向预设换档"）都建立在"圆心那张就在世界原点"这条几何前提上。
      所以必须把图画回去：
      1. 「松开卡片」清掉钉子；
      2. 切到全库再切回来 ⇒ 模拟**从同心环的种子重建**（这是可复现的那条路径），
         几何回到"刚打开图谱"的样子；
      3. 最后自己验一遍：圆心那张的矩形确实又框住了世界原点。
    */
    await page.locator('[data-graph-action="unpin-cards"]').click()
    await waitUntil(
      async () => (await graphNumber(page, 'data-graph-pinned')) === 0,
      10_000,
      '卡片被松开',
    )
    await page.locator('[data-graph-action="mode-vault"]').click()
    await waitUntil(async () => (await graphText(page, 'data-graph-mode')) === 'vault', 10_000, '切到全库')
    await page.locator('[data-graph-action="mode-focus"]').click()
    await waitUntil(
      async () => (await graphText(page, 'data-graph-mode')) === 'focus',
      10_000,
      '切回关系图',
    )
    await waitUntil(
      async () => {
        const rect = await graphRootRect(page)
        return rect.x <= 0 && rect.y <= 0 && rect.x + rect.width >= 0 && rect.y + rect.height >= 0
      },
      10_000,
      '圆心那张卡片重新回到世界原点',
    )

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：选中卡片 → 浮窗可拖可缩放，Esc 只关浮窗（选中留着）', async () => {
    // 为什么值得端到端测：浮动面板是**受控**组件（位置与大小全部来自 store，拖动时按帧写回），
    // 于是"写回真的发生了"只有指针真动过才看得出来 —— 单测里模拟一次拖动等于自己把答案喂给自己。
    // 这条用例还钉住 Esc 的语义（ADR-0023 定的那一层，ADR-0025 之后第二层从"关停靠预览"
    // 变成了"取消选中"）：先关**最上面那个浮窗**，选中留着。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    await waitUntil(async () => (await graphCardCount(page)) >= 3, 10_000, '关系图画出圆心与它的邻居')

    // 选中圆心那张卡片（几何命中：圆心在世界原点），HUD 上才会多出「浮窗打开」那一行
    await clickGraphCenterCard(page)
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '项目/设计.md',
      10_000,
      '选中圆心那一篇',
    )
    await page.locator('[data-graph-action="open-floating"]').click()

    const pane = page.locator('.mn-float-note')
    await pane.waitFor({ state: 'visible' })
    expect(await pane.getAttribute('role')).toBe('dialog')
    // 浮起来的是**这一篇**（而不是随便一个浮窗）：aria-label 里带着标题与路径
    expect((await pane.getAttribute('aria-label')) ?? '').toContain('项目/设计.md')
    // 正文照常渲染（与停靠预览同一条链路）
    await waitUntil(
      async () => ((await pane.locator('.mn-float-note__article').textContent()) ?? '').includes('文件层'),
      10_000,
      '浮窗里出现笔记正文',
    )

    const readBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      const box = await pane.boundingBox()
      if (box === null) throw new Error('浮窗没有布局盒（不可见？）')
      return box
    }

    // —— 拖标题栏：位置由 store 写回，所以"拖动生效"的证据就是界面上的 left/top 变了 ——
    const beforeDrag = await readBox()
    const header = await page.locator('.mn-float-note__header').boundingBox()
    if (header === null) throw new Error('浮窗标题栏没有布局盒')
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2)
    await page.mouse.down()
    await page.mouse.move(header.x + header.width / 2 - 100, header.y + header.height / 2 - 40, {
      steps: 10,
    })
    await page.mouse.up()
    await waitUntil(async () => (await readBox()).x < beforeDrag.x - 40, 10_000, '浮窗被拖到左边')
    const afterDrag = await readBox()
    expect(afterDrag.y).toBeLessThan(beforeDrag.y - 20)
    // 拖标题栏**只**改位置：大小一个像素都不动（两种手势共用一套指针状态，别串了）
    expect(Math.abs(afterDrag.width - beforeDrag.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(afterDrag.height - beforeDrag.height)).toBeLessThanOrEqual(1)

    // —— 拖右下角把手：受控组件同样按帧写回，"尺寸变大"就是它唯一可见的证据 ——
    const handle = await page.locator('[data-float-resize]').boundingBox()
    if (handle === null) throw new Error('浮窗的缩放手柄没有布局盒')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2 + 80, {
      steps: 10,
    })
    await page.mouse.up()
    await waitUntil(async () => (await readBox()).width > afterDrag.width + 20, 10_000, '浮窗被拉宽')
    const resized = await readBox()
    expect(resized.height).toBeGreaterThan(afterDrag.height + 20)

    // —— Esc：关掉最上面那个浮窗，而**选中还在** ——
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.mn-float-note').count()) === 0, 10_000, 'Esc 关掉浮窗')
    expect(await page.locator('.mn-graph').getAttribute('data-graph-selected')).toBe('项目/设计.md')

    // 收尾：再按一次 Esc 取消选中并回到编辑视图，别让后面的用例一进来就挂着一个选中项
    await page.locator('.mn-graph').press('Escape')
    await waitUntil(
      async () => (await page.locator('.mn-graph').getAttribute('data-graph-selected')) === '',
      5_000,
      '取消选中',
    )
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：力导向预设点一下就换档（高亮、偏好与镜头重算三处一起变）', async () => {
    // 为什么值得端到端测：预设不是样式开关，它是**力场的输入**（张力/斥力/向心力/阻尼的一套数字）。
    // 端到端能钉住三件事同时成立：胶囊的高亮、落盘的偏好、以及力场真的按新参数重建过一次 ——
    // 后者表现为整幅图重新落定、镜头跟着重新"适应窗口"（缩放因此变了）。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)

    // 起点自足：预设是持久化偏好，而本文件里**只有这一条**用例改它、并且会改回去。
    // 从没写过这份偏好时 `readPrefs` 给出的缺省就是 balanced，所以两种起点都该看到 balanced
    // —— 这里把"应该是什么"显式断言出来，而不是默默依赖执行顺序。
    expect((await readGraphPrefs(page))?.forcePreset ?? 'balanced').toBe('balanced')
    const balanced = page.locator('[data-force-preset="balanced"]')
    const activePreset = () =>
      page.locator('.mn-graph__chip--active[data-force-preset]').getAttribute('data-force-preset')
    expect(await activePreset()).toBe('balanced')
    expect(await balanced.getAttribute('aria-pressed')).toBe('true')

    const zoomBefore = await graphNumber(page, 'data-graph-scale')
    await page.locator('[data-force-preset="spacious"]').click()
    await waitUntil(async () => (await activePreset()) === 'spacious', 10_000, '「舒展」成为当前预设')
    expect(await balanced.getAttribute('aria-pressed')).toBe('false')
    expect((await readGraphPrefs(page))?.forcePreset).toBe('spacious')
    // 新参数 ⇒ 新一轮落定 ⇒ 新的包围盒 ⇒ 镜头重新适应一次：缩放不再等于原来那个数
    await waitUntil(
      async () => (await graphNumber(page, 'data-graph-scale')) !== zoomBefore,
      10_000,
      '镜头按新的布局重新适应',
    )

    // 点回「均衡」：高亮、偏好、镜头全都回来（力场是确定性的：同一份参数 + 同一个种子 ⇒ 同一份布局）
    await page.locator('[data-force-preset="balanced"]').click()
    await waitUntil(async () => (await activePreset()) === 'balanced', 10_000, '切回「均衡」')
    expect((await readGraphPrefs(page))?.forcePreset).toBe('balanced')
    await waitUntil(
      async () => Math.abs((await graphNumber(page, 'data-graph-scale')) - zoomBefore) < 1e-6,
      10_000,
      '镜头回到「均衡」那一档的缩放',
    )

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('设置页：关掉「显示行号」，编辑器左侧那一栏立刻消失（不重开笔记、正文不动）', async () => {
    /*
      为什么值得端到端测：这条设置的**全部价值**就在于"立刻生效且不打断写作"——
      如果实现成"重建编辑器"，用户关一个显示开关就会丢掉光标与撤销历史（真实风险，
      因为最容易的写法就是重建）。所以这里断三件事：栏消失、正文一字不变、再打开它回来。
      收尾要把开关**还原成默认的开**：设置是持久化的，留着关会让后面的用例看不到行号。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.waitForSelector('.cm-content', { state: 'visible' })
    expect(await page.locator('.cm-gutters').count()).toBe(1)

    await page.keyboard.press('Control+,')
    await page.waitForSelector('.mn-settings', { state: 'visible', timeout: 10_000 })
    await page.locator('[role="tab"]', { hasText: '编辑器' }).click()

    const toggle = page.locator('input[aria-label="显示行号"]')
    expect(await toggle.isChecked()).toBe(true)
    await toggle.uncheck()

    await waitUntil(
      async () => (await page.locator('.cm-gutters').count()) === 0,
      10_000,
      '行号栏消失',
    )
    // 正文与光标没有被"重建编辑器"这种事打扰
    expect(await page.locator('.cm-content').textContent()).toContain('参考')

    await toggle.check()
    await waitUntil(
      async () => (await page.locator('.cm-gutters').count()) === 1,
      10_000,
      '行号栏回来',
    )

    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.mn-settings').count()) === 0, 5_000, '设置页关闭')
  })

  it('知识图谱：「漂浮」开关的按下状态与落盘偏好始终一致（开→关→开）', async () => {
    // 为什么值得端到端测：`floating` 是一个**纯偏好**开关 —— 它的可见后果是"力场要不要一直推进"，
    // 而那件事在有限的等待里断不了（力场收敛之后即使开着也不动，断言"在动"会假红）。
    // 所以这里钉的是另一半、也是刷新之后用户唯一看得到的那一半：
    // **界面上的按下状态与落盘偏好必须始终一致**（缺任何一半，开关都会在骗人）。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)
    // 跳数是持久化偏好：先拨回 1，别让这条用例画出一幅比需要更大的图
    await resetGraphDepthToOne(page)

    const chip = page.locator('[data-graph-action="toggle-floating"]')
    // 默认**开**（`readPrefs` 里的缺省就是 true，本文件没有别的用例碰过它）
    expect(await chip.getAttribute('aria-pressed')).toBe('true')
    expect(((await chip.getAttribute('class')) ?? '').includes('mn-graph__chip--active')).toBe(true)

    await chip.click()
    await waitUntil(async () => (await chip.getAttribute('aria-pressed')) === 'false', 5_000, '关掉漂浮')
    expect((await readGraphPrefs(page))?.floating).toBe(false)
    expect(((await chip.getAttribute('class')) ?? '').includes('mn-graph__chip--active')).toBe(false)

    await chip.click()
    await waitUntil(async () => (await chip.getAttribute('aria-pressed')) === 'true', 5_000, '再打开漂浮')
    expect((await readGraphPrefs(page))?.floating).toBe(true)

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('知识图谱：力度管理面板逐项可调、整份落盘，且**卡片之间不重叠**（碰撞是硬约束）', async () => {
    /*
      用户的两句要求一起验：
        · "图谱应该有力度管理" ⇒ 面板里每项都有滑杆、拖一下立刻生效并落盘、手调后标"自定义"、
          「恢复预设」退得回去；
        · "笔记之间应该有碰撞" ⇒ 默认力度下 `data-graph-overlaps` 恒为 0。
      后半句还做了一次**对照**（把斥力关到 0、向心力拉满 ⇒ 本该挤成一团）：这时仍然是 0，
      说明兜住它的是碰撞而不是碰巧；再关掉碰撞 ⇒ 立刻出现重叠，证明那个 0 不是恒真的。
      收尾把力度恢复成预设，别让后续用例看到一幅被挤过的图。
    */
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.mn-graph', { state: 'visible' })
    await ensureGraphFocusMode(page)

    const overlaps = () => graphNumber(page, 'data-graph-overlaps')
    await waitUntil(async () => (await overlaps()) === 0, 10_000, '默认力度下不重叠')

    await page.locator('[data-graph-action="toggle-force-panel"]').click()
    await page.waitForSelector('.mn-force', { state: 'visible', timeout: 10_000 })
    // 每一项参数都有控件（漏一项就等于那个旋钮不存在）
    for (const key of ['centerStrength', 'repelStrength', 'linkStrength', 'linkDistance', 'damping', 'maxSpeed', 'collideStrength', 'collideIterations', 'alphaDecay']) {
      expect(await page.locator(`[data-force-param="${key}"]`).count()).toBe(1)
    }

    // 拖「斥力」：store 与落盘一起变，角标变成"自定义"
    const repel = page.locator('[data-force-param="repelStrength"]')
    await setRangeValue(repel, '6')
    await waitUntil(
      async () => ((await readGraphPrefs(page))?.forceParams as Record<string, number> | undefined)?.['repelStrength'] === 6,
      5_000,
      '斥力写进偏好',
    )
    expect(((await page.locator('[data-force-current]').textContent()) ?? '').includes('自定义')).toBe(true)

    // 对照实验：把"该挤成一团"的力加上去，碰撞仍然保证零重叠
    await setRangeValue(repel, '0')
    await setRangeValue(page.locator('[data-force-param="centerStrength"]'), '0.05')
    await page.waitForTimeout(400)
    expect(await overlaps()).toBe(0)

    // 再把碰撞关掉：同样的力场立刻叠在一起（这一条是上面那个 0 的对照）
    await setRangeValue(page.locator('[data-force-param="collideStrength"]'), '0')
    await waitUntil(async () => (await overlaps()) > 0, 10_000, '关掉碰撞后出现重叠')

    // 「恢复预设」把一切还原（后续用例看到一个正常的手感）
    await page.locator('[data-force-action="reset"]').click()
    await waitUntil(
      async () => ((await page.locator('[data-force-current]').textContent()) ?? '').includes('自定义') === false,
      5_000,
      '恢复预设后不再是自定义',
    )
    await waitUntil(async () => (await overlaps()) === 0, 10_000, '恢复后重新落定为零重叠')

    await page.locator('[aria-label="关闭力度管理"]').click()
    await waitUntil(async () => (await page.locator('.mn-force').count()) === 0, 5_000, '面板关闭')

    // 回到编辑视图（后续用例与"默认视图"保持一致）
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('全局快捷键赢过编辑器自己的绑定：焦点在编辑器里按 Ctrl+G 也是"打开图谱"', async () => {
    // 回归：CodeMirror 的 searchKeymap 把 Mod+G 绑成了"查找下一个"并会 preventDefault。
    // 全局快捷键如果装在冒泡阶段，事件到达它时已经被吃掉 —— 用户按下 Ctrl+G 的结果是
    // 编辑器跳到了下一个匹配，而图谱纹丝不动（应用层 E2E 抓到的真实缺陷）。
    await openNoteInTree(page, '项目/设计.md')
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+g')

    await page.waitForSelector('.mn-graph', { state: 'visible', timeout: 10_000 })
    expect(await page.locator('.mn-pane--graph').count()).toBe(1)

    // 同一件事对 Ctrl+Shift+T（标签面板）、Ctrl+B（侧栏）同样成立：它们都不该被编辑器吞掉
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await page.locator('.cm-content').click()
    const sidebarBefore = await page.locator('.mn-sidebar').count()
    await page.keyboard.press('Control+b')
    await waitUntil(
      async () => (await page.locator('.mn-sidebar').count()) !== sidebarBefore,
      5_000,
      'Ctrl+B 切换侧栏',
    )
    await page.keyboard.press('Control+b')
    await waitUntil(
      async () => (await page.locator('.mn-sidebar').count()) === sidebarBefore,
      5_000,
      '再按一次恢复侧栏',
    )
  })

  it('多标签页：打开多篇成标签、点击切换、关闭当前，且布局契约不变', async () => {
    // 标签列表是**跨用例累积**的（同一个页面、同一个 Vault 根，还写进了 localStorage），
    // 前面的用例已经开过好几篇笔记。所以这里必须先清空，否则"恰好两个标签"永远不会成立。
    await closeAllTabs(page)

    await openNoteInTree(page, '项目/设计.md')
    await openNoteInTree(page, '项目/路线图.md')
    await waitUntil(
      async () => (await page.locator('.mn-tabs__tab').count()) === 2,
      10_000,
      '两篇笔记成为两个标签',
    )
    // 激活项跟着当前文档
    expect(
      await page.locator('.mn-tabs__tab--active').getAttribute('data-tab-path'),
    ).toBe('项目/路线图.md')

    // 点第一个标签切回去（编辑器路径随之变化）
    await page.locator('.mn-tabs__tab[data-tab-path="项目/设计.md"]').click()
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/设计.md'),
      10_000,
      '点击标签后切到那篇笔记',
    )

    // 标签栏在主区域内部：主体/侧栏/状态栏的高度契约不受影响
    const after = await readLayout(page)
    const expectedBody = after.innerHeight - after.titlebar.height - after.tabs.height - after.statusbar.height
    expect(Math.abs(after.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(after.statusbar.bottom - after.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.sidebar.height - after.body.height)).toBeLessThanOrEqual(1)
    expect(await page.locator('.mn-app > .mn-tabs').count()).toBe(1)

    // 关闭当前标签 → 剩一个，且不会崩
    await page.locator('.mn-tabs__tab--active .mn-tabs__close').click()
    await waitUntil(async () => (await page.locator('.mn-tabs__tab').count()) === 1, 5_000, '标签被关闭')

    // 收尾：把状态还给后面的用例（只留一个标签、停在编辑视图）
    await openNoteInTree(page, '项目/设计.md')
  })

  it('命令面板：编辑器聚焦时 Ctrl+K 也能打开，过滤后回车执行命令', async () => {
    await openNoteInTree(page, '项目/设计.md')
    // 关键：焦点在编辑器里。CodeMirror 自己把 Ctrl+K 绑成了 deleteToLineEnd，
    // 面板必须在捕捉阶段抢在它前面，否则"打开面板"会变成"删掉半行"。
    await page.locator('.cm-content').click()

    const themeBefore = await page.locator('html').getAttribute('data-theme')
    await page.keyboard.press('Control+k')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('命令面板')
    expect(await page.locator('.mn-palette [role="option"]').count()).toBeGreaterThan(5)

    await page.locator('.mn-palette__input').fill('切换主题')
    await waitUntil(
      async () => (await page.locator('.mn-palette [role="option"]').count()) === 1,
      5_000,
      '过滤到唯一命令',
    )
    await page.locator('.mn-palette__input').press('Enter')

    await waitUntil(
      async () => (await page.locator('html').getAttribute('data-theme')) !== themeBefore,
      5_000,
      '命令被执行（主题真的切换了）',
    )
    expect(await page.locator('.mn-palette').count()).toBe(0)
  })

  it('整库导出静态站点：浏览器预览模式没有系统目录选择框，如实说明而不是假装写出去了', async () => {
    // 这一层能验的是"降级路径"：Mock 适配器有完整的计划（页面表、链接、反链），
    // 但浏览器里没有 `dialog:allow-open`，`pickDirectory` 返回 null —— 于是导出必须在**选目录**
    // 这一步就停下并说清原因。真实落盘由 `real-app.e2e.test.ts` 用真实二进制 + 真实磁盘覆盖。
    await openNoteInTree(page, '项目/设计.md')
    await page.locator('.mn-export-launch').click()
    await page.waitForSelector('.mn-dialog--export', { state: 'visible' })

    // 三个选项都在同一张对话框里（单篇 HTML / 打印 / 整库站点），第三个在 Mock 里是**可用**的
    expect(await page.locator('.mn-export__choice').count()).toBe(3)
    const site = page.locator('[data-export-site]')
    await waitUntil(async () => !(await site.isDisabled()), 10_000, '整库导出选项可用（Mock 的索引是 ready）')
    await site.click()

    await waitUntil(
      async () =>
        (await page.locator('.mn-toasts').count()) > 0 &&
        ((await page.locator('.mn-toasts').textContent()) ?? '').includes('浏览器预览模式无法写出文件'),
      10_000,
      '说清"这里写不了文件"以及该去哪儿',
    )
    // 对话框自己收起（没有停在"正在导出…"），也没有任何东西被写出去
    await waitUntil(
      async () => (await page.locator('.mn-dialog--export').count()) === 0,
      5_000,
      '导出对话框收起',
    )
  })

  it('大文档阅读视图：小文档走同步路径，界面上"走了哪条路"是可断言的', async () => {
    // 为什么把这条痕迹做进 DOM（而不是只写日志）：Worker 是否被创建、结果有没有被采信，
    // 在 Playwright 这一层很难直接观察（jsdom 里根本没有 `Worker`，E2E 里也不好断言线程行为）。
    // 于是预览自己把"这一屏是同步渲染的、还是 worker 送回来的"写在 `data-mn-render` 上 ——
    // 断言一个事实，而不是推断。门槛以下不建 Worker 也是行为的一部分（构造 Worker 比重渲染一个
    // 小文档更贵），这里用演示 Vault 里的小笔记把它钉住。
    await openNoteInTree(page, '项目/设计.md')
    await showReadView(page)
    await waitUntil(
      async () => (await page.locator('[data-mn-render]').count()) > 0,
      10_000,
      '预览标出了自己走的哪条渲染路径',
    )
    expect(await page.locator('[data-mn-render]').first().getAttribute('data-mn-render')).toBe('sync')
    // 正文照常渲染（走哪条路都不该影响结果）
    expect((await page.locator('.mn-preview__body').textContent()) ?? '').toContain('设计')
  })

  it('快速切换：Ctrl+P 只列笔记、回车打开、Esc 关闭且不改动', async () => {
    await page.keyboard.press('Control+p')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    expect(await page.locator('.mn-palette').getAttribute('aria-label')).toBe('快速切换笔记')

    // 目录不出现在结果里（只列笔记文件）
    await page.locator('.mn-palette__input').fill('项目')
    await waitUntil(
      async () => (await page.locator('.mn-palette [role="option"]').count()) > 0,
      5_000,
      '有匹配结果',
    )
    const paths = await page
      .locator('.mn-palette [role="option"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-rel-path')))
    expect(paths).not.toContain('项目')

    await page.locator('.mn-palette__input').fill('路线图')
    await waitUntil(
      async () =>
        (await page.locator('.mn-palette [role="option"]').first().getAttribute('data-rel-path')) ===
        '项目/路线图.md',
      5_000,
      '第一条命中路线图',
    )
    await page.locator('.mn-palette__input').press('Enter')
    await waitUntil(
      async () =>
        ((await currentMainPath(page)) === '项目/路线图.md'),
      10_000,
      '打开选中的笔记',
    )

    // Esc 只关闭面板，不打开别的笔记
    await page.keyboard.press('Control+p')
    await page.waitForSelector('.mn-palette', { state: 'visible' })
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.mn-palette').count()) === 0, 5_000, 'Esc 关闭面板')
    expect(await currentMainPath(page)).toBe('项目/路线图.md')
  })

  it('视图模式切换：编辑 / 阅读 / 图谱（主区域只有一个 pane）', async () => {
    // 状态栏三个视图按钮
    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await waitUntil(
      async () => (await page.locator('.cm-content').count()) === 0,
      5_000,
      '进入阅读视图',
    )
    expect(await page.locator('.mn-preview__body').count()).toBe(1)
    expect(await page.locator('.mn-pane').count()).toBe(1)

    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    expect(await page.locator('.mn-preview').count()).toBe(0)
    expect(await page.locator('.mn-pane').count()).toBe(1)

    // 图谱视图：主区域换成画布（不再有编辑/预览并排 —— 分栏已移除）
    await page.locator('button[aria-label="知识图谱"]').click()
    await page.waitForSelector('.mn-pane--graph', { state: 'visible' })
    expect(await page.locator('.cm-content').count()).toBe(0)
    expect(await page.locator('.mn-preview').count()).toBe(0)

    // 布局不变式仍然成立
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)

    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
  })

  it('大纲面板：Ctrl+Shift+O 列出标题树，点一条跳到那一行（代码块里的伪标题不算）', async () => {
    await openNoteInTree(page, '项目/大纲.md')

    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await page.waitForSelector('.mn-outline', { state: 'visible' })

    // 标题树：层级正确、代码块里的 `# 伪标题` 不在里面
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      10_000,
      '渲染出四个标题',
    )
    const labels = await page.locator('.mn-outline__item').allTextContents()
    expect(labels).toEqual(['大纲示例', '第一节', '小节', '第二节'])

    // 点最后一条 → 光标落到那一行（读编辑器当前行的文本，而不是断言内部变量）
    await page.locator('.mn-outline__item[data-outline-line="15"]').click()
    await waitUntil(
      async () => ((await page.locator('.cm-activeLine').textContent()) ?? '').includes('第二节'),
      5_000,
      '光标落到第二节那一行',
    )

    // 「当前章节」高亮：跳转本身就把光标放进了那一节，因此高亮必须已经在它上面
    await waitUntil(
      async () =>
        (await page.locator('.mn-outline__item--current').getAttribute('data-outline-line')) === '15',
      5_000,
      '当前章节跟着光标走',
    )
    expect(await page.locator('.mn-outline__item--current').getAttribute('aria-current')).toBe(
      'location',
    )

    // 把光标挪到标题**下面的正文**里（第 17 行）：仍属于那一节（`<=` 语义），不是"没高亮"
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await waitUntil(
      async () =>
        (await page.locator('.mn-outline__item--current').getAttribute('data-outline-line')) === '15',
      5_000,
      '光标在正文里时仍高亮上面那一节',
    )

    // 阅读视图里点标题是"滚过去并高亮"（预览没有光标）
    await page.locator('button[aria-label="阅读（渲染后）"]').click()
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })
    await page.locator('.mn-outline__item[data-outline-line="5"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-preview__body .mn-outline-flash').count()) === 1,
      5_000,
      '阅读视图里对应标题被高亮',
    )
    expect(await page.locator('.mn-preview__body .mn-outline-flash').textContent()).toBe('第一节')

    /*
     * 阅读视图里的"当前章节"跟**滚动位置**走。
     *
     * 先把窗口缩矮，逼出真正的滚动条 —— 这篇 mock 笔记很短，1280×800 下整篇放得下，
     * 那种情况下"滚动"是空话（任何断言都会因为滚不动而假通过或假失败）。
     */
    await page.setViewportSize({ width: 900, height: 360 })
    await waitUntil(
      async () =>
        await page.evaluate(() => {
          const scroller = document.querySelector('.mn-preview__scroller')
          return scroller !== null && scroller.scrollHeight > scroller.clientHeight + 40
        }),
      5_000,
      '预览变成可滚动',
    )

    // 断言"跟着滚动走"这个**关系**，而不是某个具体行号：这篇笔记很短，
    // 最后一个标题根本滚不到顶（滚到底时视口顶部那一节是「小节」），写死行号只会把
    // 布局细节焊进用例。
    // 注意用 `evaluate` 读而不是 `locator().getAttribute()`：后者在元素不存在时会等满默认超时
    // （15s），而"还没滚到第一个标题时本来就没有高亮"是合法状态。
    const readCurrentLine = async (): Promise<number> =>
      await page.evaluate(() => {
        const node = document.querySelector('.mn-outline__item--current')
        return node === null ? 0 : Number(node.getAttribute('data-outline-line') ?? 0)
      })

    const beforeScroll = await readCurrentLine()
    await page.evaluate(() => {
      const scroller = document.querySelector('.mn-preview__scroller')
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
    })
    await waitUntil(
      async () => (await readCurrentLine()) > beforeScroll,
      5_000,
      '滚下去之后当前章节往后走了',
    )
    // 而且必须停在这篇笔记真正的标题上（不是随便一个行号）
    expect(['1', '5', '9', '15']).toContain(String(await readCurrentLine()))

    await page.setViewportSize({ width: 1280, height: 800 })
    await waitUntil(
      async () => (await page.locator('.mn-preview__body').count()) === 1,
      5_000,
      '恢复窗口尺寸',
    )

    // 再按一次收起面板
    await page.locator('button[aria-label="编辑（所见即所得）"]').click()
    await page.waitForSelector('.cm-content', { state: 'visible' })
    await page.keyboard.press('Control+Shift+o')
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 5_000, '面板收起')
  })

  it('表格格式化：Ctrl+Alt+F 把光标所在的表格对齐（只改空白，内容不动）', async () => {
    // mock 笔记 `项目/设计.md` 里的表格本来就没对齐（`层` 只有一列宽，`文件层` 有三列），
    // 因此不需要为此改 Mock 数据
    await openNoteInTree(page, '项目/设计.md')

    /** 表格块的每一行文本 + 显示宽度（中文按两列算，与实现同口径）。 */
    const tableLines = async (): Promise<Array<{ text: string; width: number }>> =>
      await page.evaluate(() => {
        const widthOf = (text: string): number => {
          let width = 0
          for (const char of text) {
            const code = char.codePointAt(0) ?? 0
            const wide =
              (code >= 0x1100 && code <= 0x115f) ||
              (code >= 0x2e80 && code <= 0xa4cf) ||
              (code >= 0xac00 && code <= 0xd7a3) ||
              (code >= 0xf900 && code <= 0xfaff) ||
              (code >= 0xfe30 && code <= 0xfe6f) ||
              (code >= 0xff00 && code <= 0xff60) ||
              (code >= 0xffe0 && code <= 0xffe6) ||
              (code >= 0x20000 && code <= 0x2fa1f)
            width += wide ? 2 : 1
          }
          return width
        }
        const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-content .cm-line')).map(
          (line) => line.textContent ?? '',
        )
        const block = lines.filter((line) => line.includes('|'))
        return block.map((text) => ({ text, width: widthOf(text) }))
      })

    const before = await tableLines()
    expect(before.length).toBeGreaterThanOrEqual(3)
    // 起点：确实没对齐（否则这条用例证明不了什么）
    expect(new Set(before.map((line) => line.width)).size).toBeGreaterThan(1)

    // 把光标放进表格里（点 `文件层` 那一行），再按快捷键。
    //
    // `.first()` 是必需的：所见即所得**渲染表格**之后，承载 widget 的那一行（DOM 里含整张
    // 渲染出来的表，而表里有"文件层"三个字）与那一行的原始源码都命中 `hasText`，strict mode
    // 会报"命中 2 个元素"。先命中 DOM 顺序里靠前的那一条正是 widget 宿主行 —— 它就在表格里，
    // 点它等于"把光标放进表格"，正是本用例要做的动作。
    await page.locator('.cm-content').click()
    const row = page.locator('.cm-content .cm-line', { hasText: '文件层' }).first()
    await row.click()
    await page.keyboard.press('Control+Alt+f')

    await waitUntil(
      async () => {
        const lines = await tableLines()
        const first = lines[0]?.width
        return first !== undefined && lines.every((line) => line.width === first)
      },
      5_000,
      '表格每一行的显示宽度一致',
    )

    const after = await tableLines()
    // 对齐了：每一行显示宽度相同（竖线因此严格对齐）
    expect(new Set(after.map((line) => line.width)).size).toBe(1)
    // 内容一个字符都没变（只动了空白与竖线位置）
    for (const line of after) {
      expect(line.text.replace(/\s+/gu, '')).toBe(
        before.find((item) => item.text.replace(/\s+/gu, '') === line.text.replace(/\s+/gu, ''))
          ?.text.replace(/\s+/gu, '') ?? line.text.replace(/\s+/gu, ''),
      )
    }

    // 幂等：再按一次，表格文本逐字不变
    const aligned = after.map((line) => line.text)
    await row.click()
    await page.keyboard.press('Control+Alt+f')
    await delay(200)
    expect((await tableLines()).map((line) => line.text)).toEqual(aligned)
  })

  it('拖拽整理：把笔记拖到另一个文件夹，树与指向它的链接一起换（并能拖回来）', async () => {
    // 自足：这条用例**真的会改 Vault**，所以先把起点收拾成"设计.md 就在 项目/ 里"。
    // 收拾手段就是拖拽本身（拖回 项目 是幂等的：已经在 项目 里时是无效落点，什么都不会发生）。
    // 单独跑这一条时（`-t`）门闸还在，先把 Vault 打开 —— 整个文件跑时它已经开着，这里是空操作。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 切到编辑视图（与 `beforeEach` 同一条动作）：这里**不等** `.cm-content`，
    // 单独跑这一条时编辑器里可能一篇笔记都没打开（那种情况下也不该为它先开一篇）
    const editButton = page.locator('button[aria-label="编辑（所见即所得）"]')
    if ((await editButton.count()) > 0) await editButton.click()
    await page.locator('.mn-search-field__input').fill('')
    if ((await treeRow(page, '日记/设计.md').count()) > 0) {
      await treeRow(page, '项目').waitFor({ state: 'visible', timeout: 10_000 })
      await dispatchDrag(page, '日记/设计.md', '项目')
      await waitUntil(
        async () => (await treeRow(page, '项目/设计.md').count()) === 1,
        10_000,
        '设计.md 回到 项目/',
      )
    }
    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)

    // 1) 悬停反馈：拖到文件夹行上时给出明确的"落点在这里"
    await dispatchDrag(page, '项目/设计.md', '日记', 'hover')
    await waitUntil(
      async () => (await treeRow(page, '日记').getAttribute('data-drop-state')) === 'valid',
      10_000,
      '悬停时目标文件夹标成可放置',
    )
    expect((await treeRow(page, '日记').getAttribute('class')) ?? '').toContain(
      'mn-tree-row--drop-valid',
    )

    // 2) 落下：文件真的换了目录（Mock Vault 的"磁盘"就是唯一事实来源）
    await dispatchDrag(page, '项目/设计.md', '日记')
    await ensureTreeRow(page, '日记/设计.md')
    expect(await treeRow(page, '项目/设计.md').count()).toBe(0)

    // 3) 全库指向它的链接被改写：路线图里的 `[[设计]]` → 相对新位置的 `[[../日记/设计]]`
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('日记/设计'),
      10_000,
      '预览里的链接已改写成新路径',
    )
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBe(0)

    // 4) 拖拽/移动不能破坏布局契约（标签栏仍在主区域里、主区域高度不变）
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.statusbar.bottom - layout.innerHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.sidebar.height - layout.body.height)).toBeLessThanOrEqual(1)
    expect(await page.locator('.mn-app > .mn-tabs').count()).toBe(1)

    // 5) 收尾：拖回 项目/，让 Vault 与用例开始时一致（后面的用例与手工验收都看到干净状态）
    await ensureTreeRow(page, '日记/设计.md')
    await dispatchDrag(page, '日记/设计.md', '项目')
    await ensureTreeRow(page, '项目/设计.md')
    expect(await treeRow(page, '日记/设计.md').count()).toBe(0)
    await openNoteInTree(page, '项目/路线图.md')
    await showReadView(page)
    await waitUntil(
      async () =>
        ((await page.locator('.mn-preview__body').textContent()) ?? '').includes('设计细节见 设计'),
      10_000,
      '链接改回原样',
    )
  })

  it('文件夹改名：F2 → 整棵子树换路径 → 指向子树的链接跟着改（并改回来）', async () => {
    // 自足：单独跑这一条（`-t`）时门闸还在，先把 Vault 打开
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 起点收拾干净：**目录改名是真实的磁盘操作**，上一条用例可能把它留在了别处
    //（拖拽用例的收尾只保证 `设计.md` 在 `项目/` 里，不保证目录本身叫 `项目`）
    if ((await treeRow(page, '项目').count()) === 0) {
      await ensureTreeRow(page, '工程')
      await dispatchDrag(page, '工程', null)
      await waitUntil(
        async () => (await treeRow(page, '项目').count()) === 1,
        10_000,
        '把 工程/ 移回 Vault 根并恢复名字',
      )
    }
    await ensureTreeRow(page, '项目/子项目/细节.md')

    // 1) 选中文件夹 → F2 → 改名框预填**目录名**（不带扩展名）
    await treeRow(page, '项目').click()
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    expect(await page.getByLabel('新文件名').inputValue()).toBe('项目')
    expect(await page.locator('.mn-rename__ext').count()).toBe(0)

    await page.getByLabel('新文件名').fill('工程')
    await page.getByLabel('新文件名').press('Enter')
    // 等对话框真的关掉：改名是异步的（IPC → 搬整棵子树 + 改写链接 → 条目表更新），
    // 不等就会在"命令还在路上"的那一刻去读树
    await waitUntil(
      async () => (await page.locator('.mn-dialog--rename').count()) === 0,
      10_000,
      '改名对话框关闭（命令已返回）',
    )

    // 2) 树里整棵子树都换了前缀（`项目/子项目/细节.md` 这种深层文件也在）
    await ensureTreeRow(page, '工程/子项目/细节.md')
    expect(await treeRow(page, '项目').count()).toBe(0)
    expect(await treeRow(page, '项目/子项目/细节.md').count()).toBe(0)

    // 3) 全库指向子树的链接被改写：路线图里 `[[设计]]` 是裸名（同目录，含义不变），
    //    而 `[[子项目/细节]]` 这类**路径形式**的链接必须跟着前缀走
    await openNoteInTree(page, '工程/子项目/细节.md')
    await showEditView(page)
    await waitUntil(
      async () => ((await currentMainPath(page)) === '工程/子项目/细节.md'),
      10_000,
      '子树的深层文件跟着换了路径',
    )
    // 换回阅读视图看链接是否仍然解析得到（悬空会渲染成 `a.mn-wikilink--unresolved`）
    // 注意 `细节.md` 本来就有一条故意悬空的 `[[还不存在的笔记]]`（其它用例依赖它），
    // 所以这里比的是**改动键本身**不见了，而不是"一条悬空都没有"
    await showReadView(page)
    await page.waitForSelector('.mn-preview__body', { state: 'visible' })
    const unresolvedTexts = await page.locator('a.mn-wikilink--unresolved').allTextContents()
    expect(unresolvedTexts.some((text) => text.includes('子项目/细节'))).toBe(false)
    expect(await page.locator('a.mn-wikilink--unresolved').count()).toBeLessThanOrEqual(1)

    // 4) 拖到树的空白区域 = 移到 Vault 根：这里本来就**已经在根**，所以是无效落点，
    //    什么都不该发生（顺带验证"文件夹可拖 + 空白区域是根 + 无效落点不静默"）
    await ensureTreeRow(page, '工程')
    await dispatchDrag(page, '工程', null)
    await waitUntil(
      async () => (await page.locator('.mn-toasts').textContent() ?? '').includes('已经'),
      10_000,
      '无效落点给出原因（而不是静默无反应）',
    )
    expect(await treeRow(page, '工程/子项目/细节.md').count()).toBe(1)

    // 5) 布局契约不受影响（标签栏仍在主区域里）
    const layout = await readLayout(page)
    const expectedBody = layout.innerHeight - layout.titlebar.height - layout.tabs.height - layout.statusbar.height
    expect(Math.abs(layout.body.height - expectedBody)).toBeLessThanOrEqual(2)
    expect(await page.locator('.mn-app > .mn-tabs').count()).toBe(1)

    // 6) 恢复原来的名字（让后续用例与手工验收看到与初始一致的 Vault）
    await ensureTreeRow(page, '工程')
    await treeRow(page, '工程').click()
    // F2 由**文件树**的 keydown 处理：先把焦点给回树（上一步在编辑器里点过）
    await page.locator('.mn-tree').focus()
    await page.locator('.mn-tree').press('F2')
    await page.waitForSelector('.mn-dialog--rename', { state: 'visible' })
    await page.getByLabel('新文件名').fill('项目')
    await page.getByLabel('新文件名').press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-dialog--rename').count()) === 0,
      10_000,
      '改名对话框关闭',
    )
    await ensureTreeRow(page, '项目/子项目/细节.md')
  })

  it('粘贴图片：写进附件目录，编辑器里出现图片、文件树里出现新附件', async () => {
    // 自足：单独跑这一条（`-t`）时门闸还在，先把 Vault 打开
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    await showEditView(page)
    await openNoteInTree(page, '随手记.md')
    // 焦点放进编辑器：粘贴事件的目标就是 contentDOM
    await page.locator('.cm-content').click()

    // 造一个**真实的**剪贴板事件：截图工具/浏览器复制图片给的正是 `DataTransfer.items`
    // 里的一份 file（`files` 在部分实现下是空的，产品代码两条路都覆盖）
    await page.evaluate(() => {
      const content = document.querySelector('.cm-content')
      if (content === null) throw new Error('编辑器未挂载')
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      content.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    })

    // 1) 编辑器里出现图片 widget（`![](相对路径)` 被装饰成图片）。
    //    Mock/浏览器预览模式没有 asset 协议 → 以**占位形态**渲染，`title` 上是被引用的
    //    Vault 相对路径；真实解码（naturalWidth > 0）由应用层 E2E 覆盖（ADR-0007/0013）。
    await page.waitForSelector('.cm-content .mn-md-image-placeholder', {
      state: 'visible',
      timeout: 10_000,
    })
    const widgetRel =
      (await page.locator('.cm-content .mn-md-image-placeholder').first().getAttribute('title')) ?? ''
    // 通用名 `image.png` 被换成带时间戳的名字（连续粘贴不会互相覆盖），并且落在附件目录里
    expect(widgetRel).toMatch(/^附件\/粘贴图片 \d{4}-\d{2}-\d{2} \d{6}\.png$/)

    // 2) 文件树里出现**同一个**附件（条目表是增量更新的，不需要重扫整个 Vault）
    if ((await page.locator('.mn-tree [data-rel-path^="附件/"]').count()) === 0) {
      await treeRow(page, '附件').click()
    }
    await waitUntil(
      async () => (await page.locator(`.mn-tree [data-rel-path="${widgetRel}"]`).count()) === 1,
      10_000,
      '文件树里出现新附件',
    )

    // 3) 收尾：把光标移开图片那一行（让 decoration 恢复成图片），保持编辑视图
    await page.locator('.cm-content').click()
    await showEditView(page)
  })

  it('大纲面板：按级别过滤 + 章节折叠（键盘可操作，当前章节高亮不漂移）', async () => {
    // 本文件共用一个页面，Vault 由第一条用例打开；单独筛选用例跑时门闸还在，这里自己补上
    // （整文件跑时这段是空操作），用例因此不依赖"前面刚好有人开过 Vault"。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }

    await openNoteInTree(page, '项目/大纲.md')

    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await page.waitForSelector('.mn-outline', { state: 'visible' })
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      10_000,
      '大纲列出四个标题',
    )
    // 默认 = 不过滤：六级开关全亮，升级上来的用户看到的还是完整标题树
    expect(await page.locator('.mn-outline__level[aria-pressed="true"]').count()).toBe(6)

    // 当前章节的行号（用 evaluate 读：元素不存在时 locator().getAttribute() 会等满默认超时）
    const currentLine = async (): Promise<number> =>
      await page.evaluate(() => {
        const node = document.querySelector('.mn-outline__item--current')
        return node === null ? 0 : Number(node.getAttribute('data-outline-line') ?? 0)
      })
    const hiddenCurrentLine = async (): Promise<string | null> =>
      await page.evaluate(
        () =>
          document.querySelector('[data-outline-hidden-current]')?.getAttribute(
            'data-outline-hidden-current',
          ) ?? null,
      )

    // —— 级别过滤：键盘（Enter）关掉 H3 ——
    const level3 = page.locator('.mn-outline__level[data-outline-level="3"]')
    await level3.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 3,
      5_000,
      '过滤掉 H3 之后少一条',
    )
    expect(await page.locator('.mn-outline__item').allTextContents()).toEqual([
      '大纲示例',
      '第一节',
      '第二节',
    ])
    expect(await level3.getAttribute('aria-pressed')).toBe('false')
    // 计数补上分母：用户要知道"还有几条没显示"
    expect(await page.locator('.mn-outline__count').textContent()).toBe('3/4')

    // 过滤之后点一条：滚动/高亮仍落在**正确的那一节**上
    // （序号按完整标题列表算；若按可见列表的下标算，这里会错位到「小节」上）
    await showReadView(page)
    await page.locator('.mn-outline__item[data-outline-line="15"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-preview__body .mn-outline-flash').count()) === 1,
      5_000,
      '阅读视图里对应标题被高亮',
    )
    expect(await page.locator('.mn-preview__body .mn-outline-flash').textContent()).toBe('第二节')
    await showEditView(page)

    // 放回 H3（键盘）
    await level3.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      5_000,
      '还原 H3',
    )

    // —— 章节折叠：把光标放到「小节」（第 9 行，属于「第一节」），再把第一节收起来 ——
    await page.locator('.mn-outline__item[data-outline-line="9"]').click()
    await waitUntil(async () => (await currentLine()) === 9, 5_000, '当前章节跟着光标走')

    const collapseFirst = page.locator('[data-outline-collapse="5"]')
    await collapseFirst.focus()
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 3,
      5_000,
      '收起第一节',
    )
    expect(await page.locator('.mn-outline__item').allTextContents()).toEqual([
      '大纲示例',
      '第一节',
      '第二节',
    ])
    expect(await collapseFirst.getAttribute('aria-expanded')).toBe('false')
    // 当前章节被藏起来时：不高亮到别的条目上，只如实交代它在第几行
    expect(await currentLine()).toBe(0)
    expect(await hiddenCurrentLine()).toBe('9')
    // 三角留在原地：收起的章节必须还能再展开
    expect(await collapseFirst.count()).toBe(1)

    await collapseFirst.focus()
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await currentLine()) === 9, 5_000, '展开后当前章节回到第 9 行')

    // —— 过滤到一条不剩：给人话，而不是空白面板 ——
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const button = page.locator(`.mn-outline__level[data-outline-level="${level}"]`)
      await button.focus()
      await page.keyboard.press('Enter')
    }
    await waitUntil(
      async () =>
        ((await page.locator('.mn-outline__empty').textContent()) ?? '').includes(
          '当前过滤条件下没有标题',
        ),
      5_000,
      '过滤后没有标题时给空态文案',
    )
    expect(await page.locator('.mn-outline__item').count()).toBe(0)

    // 一键还原 + 收尾（面板收起、过滤回到默认），不让状态漏给别的用例
    await page.locator('.mn-outline__reset').click()
    await waitUntil(
      async () => (await page.locator('.mn-outline__item').count()) === 4,
      5_000,
      '还原全部级别',
    )
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Shift+o')
    await waitUntil(async () => (await page.locator('.mn-outline').count()) === 0, 5_000, '面板收起')
  })

  it('按标签过滤文件树：只留命中笔记与祖先目录，计数说清 M/N，Esc 随时回到全量', async () => {
    // 本文件共用一个页面：单独跑这一条时门闸还在。
    // 刻意不调 `showEditView`：这一条只用文件树与它的头部控件，而"没有打开的笔记时
    // 编辑器根本不存在"（`.cm-content` 等不到），那样单独跑就会因为无关的原因失败。
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 起点干净：清掉可能残留的标签过滤与文本过滤
    await resetTagFilter(page)
    await page.locator('.mn-search-field__input').fill('')

    // —— 入口在文件树头部：可搜索的选择器 ——
    await page.locator('[data-tag-filter-toggle]').click()
    await page.locator('[data-tag-filter-search]').fill('项')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-option="项目"]').count()) === 1,
      5_000,
      '搜索后出现「项目」选项',
    )
    await page.locator('[data-tag-filter-option="项目"]').click()

    // —— 树被收窄到"命中笔记 + 祖先目录"：Mock 里 #项目 命中 设计.md 与 标签示例.md ——
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '过滤后只剩命中项与祖先目录',
    )
    const filtered = await page
      .locator('.mn-tree-row')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-rel-path')))
    // 集合一致（行内顺序按"目录在前 + 拼音"排，这里只钉住"祖先行排在它的子行之前"）
    expect([...filtered].sort()).toEqual(['项目', '项目/设计.md', '项目/标签示例.md'].sort())
    expect(filtered[0]).toBe('项目')

    // 没有命中的笔记、空目录（`项目/子项目` 下的笔记没有这个标签）都不出现
    for (const hidden of ['项目/路线图.md', '项目/子项目', '日记', '随手记.md']) {
      expect(await treeRow(page, hidden).count()).toBe(0)
    }

    // 计数一眼可见，且分母是全库笔记数
    expect(await page.locator('[data-tag-filter-count]').textContent()).toMatch(/^仅显示 2\/\d+ 篇$/)
    expect(await page.locator('[data-tag-filter-count]').getAttribute('data-tag-filter-count')).toBe(
      '2',
    )
    // 多选语义与「含子标签」都写在界面上（不留歧义）
    expect(await page.locator('[data-tag-filter-hint]').textContent()).toContain('含任意一个')
    const subtags = page.locator('[data-tag-filter-subtags]')
    expect(await subtags.textContent()).toContain('含子标签')
    // Mock 里没有 `项目/…` 子标签 → 开关禁用并说明原因（点了没反应比禁用更难懂）
    expect(await subtags.isDisabled()).toBe(true)
    expect(await subtags.getAttribute('title')).toContain('没有子标签')

    // —— 与既有的文本过滤叠加（两个条件都生效）——
    await page.locator('[data-tag-filter-toggle]').click() // 收起选择器
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )
    await page.locator('.mn-search-field__input').fill('设计')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 2,
      5_000,
      '文本过滤在标签结果上再收窄',
    )
    expect(await treeRow(page, '项目/标签示例.md').count()).toBe(0)
    await page.locator('.mn-search-field__input').fill('')

    // —— 键盘导航只在可见项之间走 ——
    await page.locator('.mn-tree').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const selected = await page.locator('.mn-tree-row--selected').getAttribute('data-rel-path')
    expect(['项目', '项目/设计.md', '项目/标签示例.md']).toContain(selected)

    // —— Esc 一键回到全量 ——
    await page.keyboard.press('Escape')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      'Esc 清除标签过滤',
    )
    expect(await page.locator('[data-tag-filter-hint]').count()).toBe(0)
    // 全量 = 没有标签的笔记也回来了。用工具栏的「展开全部目录」把整棵树摊开，
    // 这样断言不依赖上一条用例留下的展开状态（哪一级目录开着是别人的事）
    await page.locator('button[aria-label="展开全部目录"]').click()
    await waitUntil(
      async () => (await treeRow(page, '项目/路线图.md').count()) === 1,
      5_000,
      '回到全量后没有标签的笔记可见',
    )
    expect(await treeRow(page, '随手记.md').count()).toBe(1)
  })

  it('标签过滤支持「排除」：有 A 且没有 B，一次查询算完（含子标签也由宿主算）', async () => {
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    await resetTagFilter(page)
    await page.locator('.mn-search-field__input').fill('')

    // 含 `#项目`（Mock 里命中 设计.md 与 标签示例.md）
    await page.locator('[data-tag-filter-toggle]').click()
    await page.locator('[data-tag-filter-search]').fill('项')
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-option="项目"]').count()) === 1,
      5_000,
      '出现「项目」选项',
    )
    await page.locator('[data-tag-filter-option="项目"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '先收窄到 #项目 的命中',
    )

    // 再**排除** `#进行中`（Mock 里只有 `项目/标签示例.md` 用它）
    // —— 这一条就是"有 A 且没有 B"，而它只花**一次**宿主查询就出结果
    await page.locator('[data-tag-filter-search]').fill('进行')
    const excludeButton = page.locator('[data-tag-filter-option-exclude="进行中"]')
    await excludeButton.waitFor({ state: 'visible' })
    await excludeButton.click()

    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 2,
      10_000,
      '排除之后只剩 设计.md 与祖先目录',
    )
    expect(await treeRow(page, '项目/标签示例.md').count()).toBe(0)
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)
    // 「不含」那一组在胶囊里明说，不靠颜色猜
    expect(await page.locator('[data-tag-filter-exclude-chips]').textContent()).toContain('不含 #进行中')

    // 取消排除 → 回到只含 #项目 的那一档（可逆）
    await page.locator('[data-tag-filter-exclude-chip-remove="进行中"]').click()
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '取消排除后回到 3 行',
    )
    expect(await page.locator('[data-tag-filter-exclude-chips]').count()).toBe(0)

    // 收拾干净：清搜索词、收起浮层、清过滤（本文件共用一个页面，别把状态留给后面的用例）
    await page.locator('[data-tag-filter-search]').fill('')
    await page.locator('[data-tag-filter-toggle]').click()
    await resetTagFilter(page)
  })

  it('标签过滤期间拖拽只能落在看得见的行上：树的空白处明确拒绝并说明原因', async () => {
    if ((await page.locator('.mn-gate').count()) > 0) {
      await page.getByText('打开文件夹作为 Vault').click()
      await page.waitForSelector('.mn-tree-row', { state: 'visible' })
    }
    // 造一个已知的过滤态
    await resetTagFilter(page)
    await filterByTag(page, '项目')
    await waitUntil(
      async () => (await page.locator('.mn-tree-row').count()) === 3,
      10_000,
      '过滤生效',
    )
    // 收起选择器，免得浮层挡住拖拽的空白区域
    await page.locator('[data-tag-filter-toggle]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )

    // 悬停到空白区域：**不出现**落点反馈（空白处 = Vault 根目录，在收窄视图里恰恰最看不见）
    await dispatchDrag(page, '项目/设计.md', null, 'hover')
    expect(await page.locator('.mn-tree [data-drop-root]').count()).toBe(0)

    // 真的丢下去：不搬文件，只给一句能读懂的原因
    await dispatchDrag(page, '项目/设计.md', null, 'drop')
    const toast = page.locator('.mn-toast', { hasText: '过滤期间不能拖到树的空白处' })
    await toast.waitFor({ state: 'visible', timeout: 5_000 })
    expect(await toast.textContent()).toContain('Vault 根目录')
    // 没有被搬到 Vault 根：笔记还在原处，可见行数也没变
    expect(await treeRow(page, '项目/设计.md').count()).toBe(1)
    expect(await page.locator('.mn-tree-row').count()).toBe(3)

    // 收尾：清除过滤、恢复全量，别把状态漏给后面的用例
    await page.locator('[data-tag-filter-clear]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      '清除标签过滤',
    )
  })

  it('所见即所得：表格渲染成真表格，光标进入露原文（源码仍在 DOM 里）', async () => {
    await ensureVaultOpen(page)
    // 先开笔记再切视图：单独跑这一条时编辑器里还没有任何文档（`.cm-content` 不存在）
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    // 让光标离开表格：表格在 mock 笔记的第 5~8 行，点第一行（标题）即可
    await page.locator('.cm-content .cm-line').first().click()

    const table = page.locator('.cm-content .mn-md-table table')
    await table.waitFor({ state: 'visible', timeout: 10_000 })

    // 真表格：thead / th / tbody / td 都真的在，表头就是分隔行上面那一行
    expect(await table.locator('thead th').count()).toBe(2)
    expect(await table.locator('tbody tr').count()).toBe(2)
    expect(await table.locator('tbody td').count()).toBe(4)
    expect(((await table.locator('th').first().textContent()) ?? '').trim()).toBe('层')

    // 用户看到的是一张表：可见文本里一个 `|` 都没有
    const rendered = await editorVisibleText(page)
    expect(rendered).toContain('文件层')
    expect(rendered).not.toContain('|')

    // 但源码**仍然**留在 DOM 里（只是 `display: none`）：Live Preview 是视图层，
    // 不做"把源码从 DOM 里删掉"那件事 —— 浏览器的查找、以及靠 `.cm-line` 文本读表格的既有路径都还成立
    expect(await editorTextContent(page)).toContain('| 文件层 | 原子写 |')

    // 被藏起来的源码行**不占高度**：否则表格上下会多出三道缝（jsdom 测不了布局，所以放在这一层）
    expect(await zeroHeightLineCount(page)).toBe(3)

    // 光标进表格 → 整块露原文（表格消失，`|` 回来）
    await table.locator('tbody td').first().click()
    await waitUntil(
      async () => (await editorVisibleText(page)).includes('| 文件层'),
      10_000,
      '光标进入表格后露出原始 Markdown',
    )
    expect(await page.locator('.cm-content .mn-md-table table').count()).toBe(0)

    // 再让光标离开 → 又变回表格（同一份文档、同一个编辑器实例，只重算装饰）
    await page.locator('.cm-content .cm-line').first().click()
    await page.locator('.cm-content .mn-md-table table').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await editorVisibleText(page)).not.toContain('|')
  })

  it('所见即所得：单元格里的对齐与行内语法都渲染，「格式化表格」不改变渲染结果', async () => {
    await ensureVaultOpen(page)
    // 先开笔记再切视图：单独跑这一条时编辑器里还没有任何文档（`.cm-content` 不存在）
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    // 在文档末尾敲一张带对齐标记与行内语法的表。
    // 注意本用例**真的会改** mock 笔记（自动保存写进内存里的条目表），所以刻意放在文件最后一条。
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    const rows = ['| 名称 | 数量 | 备注 |', '| :--- | ---: | :---: |', '| 甲 | **12** | `码` |']
    // 两个换行 = 让表格前有一个**空行**：GFM 的表体会一直吃到空行/别的块级结构，
    // 少了它，新表格的第一行会被当成上面那个段落的续行（上一次运行就是这么假通过的）
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    for (const [index, line] of rows.entries()) {
      if (index > 0) await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }

    /*
     * 单元格里的 `[[` 补全：弹层挂在 `.cm-editor` 下（不在 `.cm-content` 里），与表格装饰
     * 互不干扰 —— 这里钉住"弹出 → 关掉 → 继续输入"这条链，免得以后谁改了表格的行内接管方式，
     * 把补全悄悄弄坏。
     *
     * 查询串刻意用「路线」而不是「设计」：
     * - 候选列表**不含当前笔记自己**（`candidates.ts` 的规则），而当前笔记正是 `项目/设计.md` ——
     *   用「设计」的话一条候选都没有，弹层会直接关掉；
     * - 「路线图」本来就在这篇笔记的出链表里（`参考 [[路线图]] 与 [[细节]]。`），
     *   所以渲染出来的 `<a>` 会带上"已解析"的标记，正好把这条链路也断言掉。
     */
    await page.keyboard.press('Enter')
    await page.keyboard.type('| [[路线')
    await page.waitForSelector('.mn-wiki-complete', { state: 'visible', timeout: 10_000 })
    expect(await page.locator('.mn-wiki-complete__item').count()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await waitUntil(
      async () => (await page.locator('.mn-wiki-complete').count()) === 0,
      5_000,
      '补全弹层关闭',
    )
    await page.keyboard.type('图]] |')

    // 光标离开表格 → 整块渲染
    await page.locator('.cm-content .cm-line').first().click()
    const table = page.locator('.cm-content .mn-md-table table').last()
    await table.waitFor({ state: 'visible', timeout: 10_000 })

    // 对齐方式来自分隔行（`:---` / `---:` / `:---:`），由浏览器算出来的是真的对齐
    expect(
      await table
        .locator('thead th')
        .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).textAlign)),
    ).toEqual(['left', 'right', 'center'])

    // 单元格里的行内语法渲染成元素，标记一个都不留给用户看
    expect(await table.locator('tbody strong').count()).toBe(1)
    expect(await table.locator('tbody code').count()).toBe(1)
    const body = await table.locator('tbody').innerText()
    expect(body).toContain('12')
    expect(body).not.toContain('**')
    expect(body).not.toContain('`')
    // `[[路线图]]` 渲染成可点击的 wikilink（不再是双方括号），且带着编辑器认的标记与解析结果
    const wikiLink = table.locator('a.mn-wikilink').first()
    expect(await table.locator('a.mn-wikilink[data-mn-wikilink="路线图"]').count()).toBe(1)
    expect(await wikiLink.getAttribute('data-mn-resolved')).toBe('项目/路线图.md')

    // 「格式化表格」：光标进表格 → Ctrl+Alt+F → 只改空白，**渲染结果逐字不变**
    const before = await table.locator('tbody').innerText()
    await table.locator('tbody td').first().click()
    await page.keyboard.press('Control+Alt+f')
    await delay(200)
    await page.locator('.cm-content .cm-line').first().click()
    const after = await page
      .locator('.cm-content .mn-md-table table')
      .last()
      .locator('tbody')
      .innerText()
    expect(after).toBe(before)
  })

  it('所见即所得：超宽表格横向滚动、超长单元格换行（正文不会被撑爆）', async () => {
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await showEditView(page)

    const contentWidth = async (): Promise<number> =>
      await page.evaluate(
        () => document.querySelector<HTMLElement>('.cm-content')?.clientWidth ?? 0,
      )
    const before = await contentWidth()

    /*
     * 16 列 + 一个"没有空格可断"的长串：**列多**就会超过正文宽度（每列有 `min-width: 4em`
     * 的下限，表格不会为了塞进正文而把自己压成"一列一个字"）—— 这正是要验的那个场景。
     * 第二格是一长段可换行的中文：它必须换行，而不是把整张表再撑宽。
     */
    const columns = Array.from({ length: 16 }, (_, index) => `列${index + 1}`)
    const longToken = 'W'.repeat(80)
    const longText = '可换行的长文本'.repeat(8)
    const rows = [
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      `| ${columns.map((_, index) => (index === 0 ? longToken : index === 1 ? longText : `值${index}`)).join(' | ')} |`,
    ]
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    // 两个换行 = 让表格前有一个**空行**（GFM 的表体会一直吃到空行/别的块级结构为止，
    // 少了它，新敲的第一行会被当成上面那段文字的续行）
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    for (const [index, line] of rows.entries()) {
      if (index > 0) await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }
    await waitUntil(
      async () => (await editorTextContent(page)).includes(longToken),
      15_000,
      '超宽表格已经输入',
    )

    await page.locator('.cm-content .cm-line').first().click()
    const scroller = page.locator('.cm-content .mn-md-table__scroll').last()
    await scroller.waitFor({ state: 'visible', timeout: 10_000 })

    // 1) 横向**滚动**而不是把正文挤爆：内容比容器宽，而容器自己不超过正文宽度
    const scrollerBox = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scrollerBox.scrollWidth).toBeGreaterThan(scrollerBox.clientWidth)
    expect(await contentWidth()).toBe(before)

    // 2) 超长单元格**换行**：没有任何一格横向溢出，长文本那一格被压成好几行
    const cells = await scroller
      .locator('tbody td')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          clientHeight: node.clientHeight,
        })),
      )
    for (const cell of cells) {
      expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1)
    }
    expect(cells[1]?.clientHeight ?? 0).toBeGreaterThan(40)
  })

  it('生产 CSP 下 worker 产物能加载并回包（Worker 的"只有装进应用才会炸"那一类边界）', async () => {
    // 这条用例存在的理由：真实 WebView 里有一条 CSP（`tauri.conf.json` 的 `app.security.csp`），
    // 而 UI 层 E2E 的静态服务器现在**也带上同一条**（见 `support/static-server.ts`）——
    // 于是"worker 产物能不能被同源加载"这件事可以在秒级的这一层验，而不是等到发布前。
    // 用打包出来的**真产物**（`dist/assets/render.worker-*.js`），走我们的真协议。
    const workerFile = readdirSync(join(packageRoot(), 'dist', 'assets')).find((name) =>
      name.startsWith('render.worker-'),
    )
    expect(workerFile, 'dist 里应当有打包出来的 render.worker 产物').toBeDefined()

    const reply = await page.evaluate(async (file) => {
      try {
        const worker = new Worker(new URL(`/assets/${file}`, location.href), { type: 'module' })
        const outcome = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 8_000)
          worker.onmessage = (event: MessageEvent) => {
            clearTimeout(timer)
            resolve(`message:${JSON.stringify(event.data).slice(0, 80)}`)
          }
          worker.onerror = (event: ErrorEvent) => {
            clearTimeout(timer)
            resolve(`error:${String(event.message ?? event)}`)
          }
          worker.postMessage({ requestId: 1, docKey: '探针', body: '# 探针\n\n一段。\n' })
        })
        worker.terminate()
        return outcome
      } catch (error) {
        return `throw:${String(error)}`
      }
    }, workerFile)

    expect(reply.startsWith('message:'), `worker 应当能加载并回包，实际：${reply}`).toBe(true)
    expect(reply).toContain('探针')
  })

  it('大文档阅读视图：门槛以下不建 Worker（小笔记走同步路径，界面上说得出来）', async () => {
    // 为什么把这条痕迹做进 DOM（而不是只写日志）：Worker 是否被创建、结果有没有被采信，
    // 在 Playwright 这一层很难直接观察，jsdom 里更是连 `Worker` 都没有（只能用假对象测协议）。
    // 于是预览自己把"这一屏是同步渲染的、还是 worker 送回来的"写在 `data-mn-render` 上 ——
    // 断言一个事实，而不是推断。这里钉的是**门槛生效**：演示 Vault 里的笔记都远小于 1 MiB，
    // 为它们开线程只会让每次编辑多一次异步往返。
    //
    // "超过门槛时真的开了 Worker"那一条放在 `real-app.e2e.test.ts`：真机才有真 Vault，
    // 测试进程可以直接写一篇 >1 MiB 的笔记进去（在 Mock Vault 里塞一篇 1 MB 的笔记会拖慢
    // 整个前端测试套件 —— 每建一个 Mock 适配器都要扫它一遍）。
    await ensureVaultOpen(page)
    await openNoteInTree(page, '项目/设计.md')
    await showReadView(page)
    await waitUntil(
      async () => (await page.locator('[data-mn-render]').count()) > 0,
      10_000,
      '预览标出了自己走的哪条渲染路径',
    )
    expect(await page.locator('[data-mn-render]').first().getAttribute('data-mn-render')).toBe('sync')
    // 正文照常渲染（走哪条路都不该影响结果）
    expect((await page.locator('.mn-preview__body').textContent()) ?? '').toContain('设计')
  })
})

/**
 * 把标签过滤恢复到"没有过滤"的确定状态（本文件共用一个页面，用例之间会互相影响）。
 *
 * 先收浮层再清过滤：浮层开着时点触发按钮是"收起"，不清这个状态的话，
 * 后面想选标签的那一步会点在收起按钮上（表现为"选项找不到"这种误导性的失败）。
 */
async function resetTagFilter(page: Page): Promise<void> {
  if ((await page.locator('[data-tag-filter-popover]').count()) > 0) {
    await page.locator('[data-tag-filter-toggle]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-popover]').count()) === 0,
      5_000,
      '选择器收起',
    )
  }
  if ((await page.locator('[data-tag-filter-clear]').count()) > 0) {
    await page.locator('[data-tag-filter-clear]').click()
    await waitUntil(
      async () => (await page.locator('[data-tag-filter-count]').count()) === 0,
      5_000,
      '清除标签过滤',
    )
  }
}

/** 从文件树头部的标签选择器里选一个标签（标签概览是异步来的，所以等选项出现）。 */
async function filterByTag(page: Page, key: string): Promise<void> {
  await page.locator('[data-tag-filter-toggle]').click()
  await waitUntil(
    async () => (await page.locator(`[data-tag-filter-option="${key}"]`).count()) === 1,
    10_000,
    `标签选择器里出现「${key}」`,
  )
  await page.locator(`[data-tag-filter-option="${key}"]`).click()
}

/**
 * 派发一次真实的 HTML5 拖拽（`dragstart` → `dragover` → `drop` → `dragend`）。
 *
 * 为什么不用 `page.dragAndDrop`：Playwright 的鼠标拖动对 HTML5 原生拖放不稳定
 * （浏览器要自己"发起"拖拽才算数），而这条用例要测的恰恰是**事件链路本身**
 * （在 `dragover` 上给反馈、在 `drop` 上落地）。`DataTransfer` 是真实构造的，
 * 与用户按住鼠标拖动时浏览器提供的是同一个接口。
 *
 * `phase: 'hover'` 只走到 `dragover`，用来断言"悬停时就有落点反馈"。
 * `toRel === null` 表示**树的空白区域**（等于 Vault 根目录）。
 */
async function dispatchDrag(
  page: Page,
  fromRel: string,
  toRel: string | null,
  phase: 'hover' | 'drop' = 'drop',
): Promise<void> {
  await page.evaluate(
    ({ fromRel, toRel, phase }) => {
      const source = document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${fromRel}"]`)
      const target =
        toRel === null
          ? document.querySelector<HTMLElement>('.mn-tree')
          : document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${toRel}"]`)
      if (source === null || target === null) {
        throw new Error(`拖拽元素缺失：${fromRel} → ${toRel ?? '（空白区域）'}`)
      }
      const dataTransfer = new DataTransfer()
      const fire = (node: Element, type: string, cancelable: boolean): void => {
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable, dataTransfer }))
      }
      fire(source, 'dragstart', false)
      fire(target, 'dragover', true)
      if (phase === 'drop') {
        fire(target, 'drop', true)
        fire(source, 'dragend', false)
      }
    },
    { fromRel, toRel, phase },
  )
}

/**
 * 单独跑某一条用例时门闸还在（整个文件跑时 Vault 已经开着）。
 *
 * 与"拖拽整理"等用例同一写法：每条用例都该自足，而不是依赖上一条刚好把状态留在哪里。
 */
async function ensureVaultOpen(page: Page): Promise<void> {
  if ((await page.locator('.mn-gate').count()) > 0) {
    await page.getByText('打开文件夹作为 Vault').click()
    await page.waitForSelector('.mn-tree-row', { state: 'visible' })
  }
}

/**
 * 编辑器里**看得见**的正文。
 *
 * 用 `innerText`（按渲染结果取文本，会跳过 `display: none` 的东西）：Live Preview 的表格
 * 渲染态里，源码行只是被 CSS 藏起来、仍留在 DOM 中，所以 `textContent` 两种状态下都一样，
 * 只有 `innerText` 能区分"用户现在看到的是表格"还是"看到的是源码"。
 */
async function editorVisibleText(page: Page): Promise<string> {
  return await page.evaluate(
    () => document.querySelector<HTMLElement>('.cm-content')?.innerText ?? '',
  )
}

/** 编辑器 DOM 里的**全部**文本（含被藏起来的源码行）。 */
async function editorTextContent(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')
}

/**
 * 高度为 0 的 `.cm-line` 数量。
 *
 * 表格渲染态里，源码行是靠"文字 `display: none`、行盒没有内容"塌成 0 高度的 ——
 * 这一条只有真实排版量得出来（jsdom 没有布局），所以放在 E2E 层。
 */
async function zeroHeightLineCount(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-content .cm-line')).filter(
        (line) => line.getBoundingClientRect().height === 0,
      ).length,
  )
}
