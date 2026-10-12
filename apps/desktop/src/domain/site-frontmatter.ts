/**
 * 站点导出的**frontmatter 判据**（纯函数，可单测）：`draft` 过滤与 `slug` / `url` 覆盖输出路径。
 *
 * 为什么判据落在这里、而不是散在导出流程或 UI 里（ADR-0047 §4 的"判据只有一份"）：
 * 这两条规则决定**哪些文件会被写出去、写到哪个路径**，正是最不能两处不一致的东西 ——
 * 导出流程要拿它过滤与改名，结果界面与索引页要拿它解释"为什么少了 N 篇、为什么这一篇换了地址"。
 *
 * ## 为什么在 TS 里另起一个 frontmatter 解析，而不是走 Rust 的 `mn_core::frontmatter`
 *
 * 不是为了第二套 YAML：这里**只取三个标量字段**（`draft` / `slug` / `url`），用的是与
 * `domain/frontmatter.ts` 的 `frontmatterRegion` **同一套区块识别口径**（含 BOM、允许 `+++` / `;;;`、
 * 未闭合就不算 frontmatter）。走宿主解析要把 `notes_read_batch` 换成"连属性一起回带"的批量命令，
 * 那是新 IPC 契约 + 索引侧改动；而这三个字段是**逐行 `key: value`** 的形态，
 * 三行判定换成一次宿主往返不划算。代价写在 ADR-0047 的"后续修订"里：
 * 只认直线字段（嵌套映射 `slug:` 带子键、块数组一概不认），认不出就当没写（退回默认路径）。
 *
 * ## 三条语义选择与它们的代价
 *
 * 1. **`slug: "abc"` 留在原目录**（`笔记/甲.md` → `笔记/abc.html`）：Hugo 的 slug 是
 *    "这一节里的文件名主干"，节位置由文件在 `content/` 里的位置决定 —— 留在原目录正是它的本义。
 *    若改成放站点根（有些 SSG 插件那样），重名会跨目录大量出现，"撞名清单"会因为一个改名而变长。
 * 2. **`url` 以 `/` 开头 = 相对输出根**、**不带 `/` = 相对本页所在目录**（Hugo 原义）。
 *    带 `/` 时我们会**丢掉"原目录"这一层信息**：作者写 `url: /docs/a/` 就是明确要脱离镜像目录树，
 *    代价是这一页的地址不再能从源路径推导出来（索引页会把它标出来）。
 * 3. **`draft` 只认严格 `true`**：YAML 1.1 里 `yes` / `on` / `y` 都是布尔真，但书写者的"顺手一行"
 *    与"我确定要下架这篇"是两件事；误判成一整篇笔记不进导出（站点里凭空少一页、打不开的链接多一条）
 *    比"多导出一篇草稿"严重得多。所以 `draft: yes` 不跳过，只在结果里不去猜它。
 *
 * ## 安全：任何覆盖都不得逃出输出根
 *
 * 覆盖值来自笔记正文（可能被粘贴进来），而它直接决定写盘路径 —— 与 `..` 逃逸、盘符、UNC、
 * Windows 保留名的对抗是这一层的第一职责：**任何可疑值一律拒绝覆盖、退回默认路径，并如实记一条**
 * （`SitePathReject`，最终进结果提示与索引页）。拒绝不是失败：导出继续，用户知道那一页用的还是默认地址。
 */

import { SITE_PAGE_EXTENSION } from './site-paths'
import { frontmatterRegion } from './frontmatter'

/** 一篇笔记的站点相关 frontmatter（缺省 / 值不合法时都是 `null`）。 */
export interface SiteFrontmatter {
  /**
   * 严格 `true` 才为真。
   *
   * 为什么不跟 YAML 1.1 的布尔真集合（`yes` / `on` / `y`）：这份值的后果是"整篇笔记从站点里消失"，
   * 详见模块文档第 3 条 —— "随手写的 yes" 不配拥有这个后果。
   */
  draft: boolean
  /** `slug`：文件名主干（不含 `.html`）。 */
  slug: string | null
  /** `url`：输出路径（Hugo 语义，见模块文档）。 */
  url: string | null
}

/**
 * frontmatter 里的三个站点字段（缺省 = `false` / `null`）。
 *
 * 刻意不解析嵌套结构：`slug:` 下面挂着子键（`slug:\n  name: x`）时，那种形态表达的是
 * **另一套约定**（多半来自别的工具），我们的字段只有标量这一种读法；宁可退回默认路径，
 * 也不猜作者想要哪个子键 —— 猜错就是"这一页静默换了地址"。
 */
export function parseSiteFrontmatter(text: string): SiteFrontmatter {
  const region = frontmatterRegion(text)
  if (region === null) return { draft: false, slug: null, url: null }

  const lines = text.split('\n')
  // 只认区块内**缩进为 0** 的直线字段：缩进的行是某个键的子结构（或列表项），不是顶层字段
  const result: SiteFrontmatter = { draft: false, slug: null, url: null }
  for (let index = 1; index < region.endLine; index += 1) {
    const raw = (lines[index] ?? '').replace(/\r$/, '')
    if (raw === '' || raw.trimStart().startsWith('#')) continue
    if (/^\s/.test(raw)) continue
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const key = raw.slice(0, colon).trim().toLowerCase()
    if (key !== 'draft' && key !== 'slug' && key !== 'url') continue
    const value = stripYamlScalar(raw.slice(colon + 1))
    if (value === null) continue
    if (key === 'draft') {
      // 只有字面 `true`：`"true"`（带引号）也是字符串，但**刻意**照收 —— 它没有任何歧义，
      // 而拒绝它换来的是"作者以为下架了、其实还在站点里"这种最难查的偏差
      result.draft = value === 'true'
    } else if (key === 'slug') {
      result.slug = value
    } else {
      result.url = value
    }
  }
  return result
}

/**
 * 一个 YAML 标量的字面文本；不是标量（块映射 / 块列表的开头、空值）返回 `null`。
 *
 * 返回 `null` 的三种形态都是"这个字段没有值"：`slug:`（后面没有东西）、`slug: |`（块标量）、
 * `url: [a, b]`（序列）。它们一律按"没写覆盖"处理，而不是把 `|` 或 `[a, b]` 当成文件名。
 */
function stripYamlScalar(raw: string): string | null {
  const value = raw.trim()
  if (value === '' || value === '~') return null
  if (value.startsWith('[') || value.startsWith('{') || value.startsWith('|') || value.startsWith('>')) {
    return null
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1)
  // 行内注释：只切 ` #`（YAML 的注释前必须有空白），`a#b` 里的 `#` 是名字的一部分
  const hash = value.indexOf(' #')
  return hash === -1 ? value : value.slice(0, hash).trim()
}

/**
 * 覆盖值被拒绝的原因码（UI 与索引页直接展示，枚举而不是自由文本，便于断言）。
 *
 * `escape` / `absolute` / `drive` / `unc` 分开而不是统一成"路径非法"：作者看提示时能立刻知道
 * 是"想写到输出目录外面去了"还是"多打了一个盘符"，这两类的修法完全不同。
 */
export type SitePathRejectReason =
  | 'empty'
  | 'escape'
  | 'absolute'
  | 'drive'
  | 'unc'
  | 'reserved-name'
  | 'bad-segment'

/**
 * 一条"覆盖被拒绝、退回默认路径"的事实（如实汇报，绝不静默降级）。
 *
 * 只存**原因码**、不存措辞：文案由 {@link describeReject} 一处生成，
 * 否则"索引页里那句话"和"提示里那句话"迟早会漂移成两种说法。
 */
export interface SitePathReject {
  reason: SitePathRejectReason
}

/** 拒绝原因 → 一句话；索引页与提示共用，避免两处措辞漂移。 */
export function describeReject(reason: SitePathRejectReason): string {
  switch (reason) {
    case 'empty':
      return '值是空的'
    case 'escape':
      return '含 `..`（会写到输出目录外面去）'
    case 'absolute':
      return '解析之后没有指向任何文件'
    case 'drive':
      return '带盘符（形如 `C:`）'
    case 'unc':
      return '是 UNC 网络路径（`//主机/共享`）'
    case 'reserved-name':
      return '是 Windows 保留设备名（CON / NUL / COM1 这类）'
    default:
      return '含非法字符（`<>:"|?*%#`、反斜杠、控制字符）或空/`..` 路径段'
  }
}

/**
 * Windows 保留设备名（不区分大小写；带扩展名的 `con.html` 同样打不开 —— 系统在解析路径时就吃掉它）。
 *
 * 名单来自 Win32 的保留设备：CON / PRN / AUX / NUL / COM1-9 / LPT1-9，以及 COM¹ 这类上标写法。
 * 为什么要在**前端**就挡：真到了写盘那一步，宿主只能整批拒绝或写出一个打不开的文件，
 * 两者都不是用户能理解的失败；挡在这里则能说清"这一页的 slug 是保留名，已退回默认地址"。
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'com¹',
  'com²',
  'com³',
  'lpt¹',
  'lpt²',
  'lpt³',
])

/**
 * 一个路径段能不能原样当文件名写出去。
 *
 * 为什么比"文件名不允许的字符"更严：被拒绝的代价只是**退回默认地址 + 一条提示**，
 * 而放过去的代价是"写盘失败（整批被宿主的白名单拒掉）"或"浏览器按 URL 规则解析出另一个文件"
 * （`#` 截断、`%20` 被当成转义、`?` 变成查询串）—— 一个打不开的页面。所以一旦拿不准就拒。
 */
function checkSegment(segment: string): SitePathReject | null {
  if (segment === '' || segment === '.' || segment === '..') {
    return { reason: 'bad-segment' }
  }
  // 控制字符（含 DEL）与 URL 里有特殊含义的字符：`?` `#` 会截断地址，`%` 会被当成转义前缀，
  // `:` `*` `|` `"` `<` `>` 在 Windows 上直接非法
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>:"|?*%#\\]/.test(segment)) {
    return { reason: 'bad-segment' }
  }
  // 尾随的 `.` / 空格：Windows 会在解析时悄悄吃掉它们，于是"写出去的路径"与"记进标记文件的路径"
  // 不再逐字相同 —— 下次导出算残留文件时就会认不出来
  if (/[. ]$/.test(segment)) {
    return { reason: 'bad-segment' }
  }
  const stem = segment.split('.')[0]?.toLowerCase() ?? ''
  if (RESERVED_NAMES.has(stem)) {
    return { reason: 'reserved-name' }
  }
  return null
}

/**
 * 把覆盖值算成站内文件路径（**已逐段校验，绝不逃出输出根**）；不合法返回拒绝原因。
 *
 * 三种输入形态（`slug` 与 `url` 共用这一段算术，差别只在传进来的 `value` 与 `resourceDir`）：
 * * 以 `/` 开头（根相对）：**丢掉默认目录**，从输出根算起 —— 作者写 `/docs/a/` 就是为了脱离镜像目录树；
 * * 含反斜杠：一律拒绝（Windows 上它是分隔符，但写在 frontmatter 里更可能是笔误或从别处粘来的，
 *   "`a\b` 是一层还是两层"没有唯一答案，猜错就是一条写歪的路径）；
 * * 其余：相对 `resourceDir`（Hugo 的 `url` 语义）。
 */
export function resolveSitePagePath(input: {
  /** 覆盖值原文（`slug` 传文件名主干，`url` 传路径）。 */
  value: string
  /** 默认位置所在目录（`''` = 原来就在站点根）。 */
  resourceDir: string
}): { ok: true; path: string } | { ok: false; reject: SitePathReject } {
  const trimmed = input.value.trim()
  if (trimmed === '') return { ok: false, reject: { reason: 'empty' } }
  if (trimmed.includes('\\')) return { ok: false, reject: { reason: 'bad-segment' } }
  if (/^\/\/+/.test(trimmed)) return { ok: false, reject: { reason: 'unc' } }
  if (/^\/?[A-Za-z]:/.test(trimmed)) return { ok: false, reject: { reason: 'drive' } }
  const relative = trimmed.startsWith('/') ? trimmed.slice(1) : `${input.resourceDir}/${trimmed}`
  const out: string[] = []
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, reject: { reason: 'escape' } }
    const reject = checkSegment(segment)
    if (reject !== null) return { ok: false, reject }
    out.push(segment)
  }
  if (out.length === 0) return { ok: false, reject: { reason: 'absolute' } }
  return { ok: true, path: out.join('/') }
}

/**
 * `slug` 的落点：**原目录 + 该文件名主干 + `.html`**。
 *
 * 为什么留在原目录：Hugo 的 `slug` 就是"节里的文件名主干"，节由文件在内容目录里的位置决定 ——
 * 留在原目录是它的本义。改成放站点根的话，`slug: index` 这种顺手写法会与索引页直接撞名，
 * 而且"一次改名"会牵连出更多撞名。
 */
export function pagePathForSlug(
  defaultPagePath: string,
  slug: string,
): { ok: true; path: string } | { ok: false; reject: SitePathReject } {
  // slug 是**一个文件名主干**，不是一个路径：`slug: "a/b"` 在 Hugo 里会被 slug 化成一个词，
  // 我们不做 slug 化（那会把 CJK 变成一串百分号编码），所以直接拒绝 —— 想改目录请用 `url`
  if (slug.includes('/')) {
    return { ok: false, reject: { reason: 'bad-segment' } }
  }
  const at = defaultPagePath.lastIndexOf('/')
  const resourceDir = at <= 0 ? '' : defaultPagePath.slice(0, at)
  return resolveSitePagePath({ value: `${slug}${SITE_PAGE_EXTENSION}`, resourceDir })
}

/**
 * `url` 的落点：Hugo 语义 —— 带 `/` 开头从输出根算起，否则相对本页所在目录。
 *
 * 尾随 `/` 映射成 `index.html`（Hugo 的 pretty URL 习惯）：这样 `siteRelativeHref` 只需按
 * "最后一段是文件名"处理就够了，不用为"目录型页面"在链接算术里再开一条分支。
 * 代价：`url: /docs/a/` 会覆盖掉同目录里本该叫 `index.html` 的那一页（撞名清单会如实报出来）。
 */
export function pagePathForUrl(
  defaultPagePath: string,
  url: string,
): { ok: true; path: string } | { ok: false; reject: SitePathReject } {
  const at = defaultPagePath.lastIndexOf('/')
  const resourceDir = at <= 0 ? '' : defaultPagePath.slice(0, at)
  const value = url.trim().endsWith('/') ? `${url.trim()}index${SITE_PAGE_EXTENSION}` : url
  return resolveSitePagePath({ value, resourceDir })
}

/** 覆盖来源（索引页与提示里要说清"这一页为什么不在默认地址"）。 */
export type SitePathSource = 'slug' | 'url'

/** 解析过 frontmatter 的一页（导出流程把"计划里的路径"和"从原文读到的三个字段"合在这里）。 */
export interface SiteNoteOverrideInput {
  relPath: string
  /** 计划的默认页面路径；不是笔记（`null`）时这一项不参与。 */
  defaultPagePath: string | null
  frontmatter: SiteFrontmatter
}

/** 一次导出里页面路径的最终结果（导出流程拿它过滤与改名，UI 拿它解释）。 */
export interface SiteExportPathPlan {
  /**
   * 这一轮真正会写出去的页面（顺序即计划的顺序 —— 决定性与它是同一件事）。
   *
   * 只要"路径"与"最终路径 → 来源"，不要别的：索引页的每一栏都能从这两张表推出来，
   * 多存一份派生数据就多一处漂移的机会。
   */
  pages: Array<{ relPath: string; pagePath: string }>
  /** 最终页面路径 → 覆盖来源（`slug` / `url`）；只有真正生效的覆盖才在里面。 */
  pathSource: Map<string, SitePathSource>
  /** 生效的覆盖：来源笔记路径 → 页面路径。 */
  overrides: Map<string, string>
  /** 因为同名撞路径而被追加了 `-2` 的页面（宿主只算得出默认路径的撞名，覆盖后的要这里补上）。 */
  renamed: Array<{ relPath: string; pagePath: string }>
  /** `draft: true` 而被跳过的笔记（**只是不导出，磁盘上什么都不动**）。 */
  drafts: string[]
  /**
   * 被拒绝、退回默认路径的覆盖（如实列出，绝不静默）。
   *
   * 存**原因码**而不是措辞：文案由 `describeReject` 一处生成（索引页与提示必须同一句话）。
   */
  rejected: Array<{ relPath: string; field: SitePathSource; value: string; reason: SitePathRejectReason }>
  /**
   * 两个覆盖撞在同一个路径上时，**后一个**退回默认地址。
   *
   * 为什么不按"计划顺序"让后一个赢：覆盖是作者对某一页的显式要求，先后顺序在笔记里看不出来；
   * 让先来者赢、后来者退回并如实报出，作者至少能看到"这一页没按我写的来"并去改名字。
   */
  conflicts: Array<{ relPath: string; field: SitePathSource; value: string; path: string }>
}

/**
 * 覆盖解析 + 撞名分配 + 草稿过滤，**一次算完**（ADR-0047 §4 的实现落点）。
 *
 * 三步的顺序是有意义的：
 * 1. **先排覆盖**（按 `relPath` 排序，与计划顺序无关 —— 两次导出必须得到同一张表），
 *    被拒绝的、撞车的都退回默认路径；
 * 2. **再排默认路径**：显式占用的路径先记进 `taken`，于是"被 slug 改名到别人默认位置"的
 *    那一页会像同名撞车一样拿到 `-2`（否则两个页面会写同一个文件，用户看到的是随机丢失）；
 * 3. **最后过滤草稿**：草稿不进结果，也就不会占用路径、不会复制图片（在计划层就断掉）。
 */
export function buildSiteExportPathPlan(
  notes: readonly SiteNoteOverrideInput[],
): SiteExportPathPlan {
  const noteOf = new Map(notes.map((note) => [note.relPath, note]))
  const drafts = notes
    .filter((note) => note.frontmatter.draft)
    .map((note) => note.relPath)
    .sort(compareText)
  const draftSet = new Set(drafts)

  const pageOf = new Map<string, string>()
  const pathSource = new Map<string, SitePathSource>()
  const overrides = new Map<string, string>()
  const rejected: SiteExportPathPlan['rejected'] = []
  const conflicts: SiteExportPathPlan['conflicts'] = []
  const taken = new Set<string>()

  const explicitOrder = notes
    .filter((note) => !draftSet.has(note.relPath) && note.defaultPagePath !== null)
    .map((note) => note.relPath)
    .sort(compareText)

  for (const relPath of explicitOrder) {
    const note = noteOf.get(relPath)
    const defaultPagePath = note?.defaultPagePath ?? null
    if (note === undefined || defaultPagePath === null) continue
    const { slug, url } = note.frontmatter
    const field: SitePathSource | null = slug !== null ? 'slug' : url !== null ? 'url' : null
    if (field === null) continue
    const value = field === 'slug' ? (slug ?? '') : (url ?? '')
    const resolved =
      field === 'slug'
        ? pagePathForSlug(defaultPagePath, value)
        : pagePathForUrl(defaultPagePath, value)
    if (!resolved.ok) {
      rejected.push({ relPath, field, value, reason: resolved.reject.reason })
      continue
    }
    if (taken.has(resolved.path)) {
      conflicts.push({ relPath, field, value, path: resolved.path })
      continue
    }
    taken.add(resolved.path)
    pageOf.set(relPath, resolved.path)
    pathSource.set(resolved.path, field)
    overrides.set(relPath, resolved.path)
  }

  const renamed: SiteExportPathPlan['renamed'] = []
  for (const note of notes) {
    if (draftSet.has(note.relPath) || note.defaultPagePath === null) continue
    const explicit = pageOf.get(note.relPath)
    if (explicit !== undefined) {
      // 覆盖生效的那一页：默认路径与最终路径不同就是一次改名（索引页要能解释地址的由来）
      if (explicit !== note.defaultPagePath) {
        renamed.push({ relPath: note.relPath, pagePath: explicit })
      }
      continue
    }
    const dot = note.defaultPagePath.lastIndexOf('.')
    const stem = dot <= 0 ? note.defaultPagePath : note.defaultPagePath.slice(0, dot)
    const extension = dot <= 0 ? '' : note.defaultPagePath.slice(dot)
    let candidate = note.defaultPagePath
    let suffix = 2
    while (taken.has(candidate)) {
      candidate = `${stem}-${suffix}${extension}`
      suffix += 1
    }
    taken.add(candidate)
    pageOf.set(note.relPath, candidate)
    if (candidate !== note.defaultPagePath) renamed.push({ relPath: note.relPath, pagePath: candidate })
  }

  renamed.sort((left, right) => compareText(left.relPath, right.relPath))
  rejected.sort((left, right) => compareText(left.relPath, right.relPath))
  conflicts.sort((left, right) => compareText(left.relPath, right.relPath))

  const pages = notes
    .filter((note) => !draftSet.has(note.relPath) && note.defaultPagePath !== null)
    .flatMap((note) => {
      const pagePath = pageOf.get(note.relPath)
      return pagePath === undefined ? [] : [{ relPath: note.relPath, pagePath }]
    })
    // 结果按笔记路径排序，**不沿用入参顺序**：这一步同时是草稿过滤的出口，于是"哪几篇会写出去"
    // 与顺序一起变成入参顺序的纯函数之外的稳定值 —— 两次导出（甚至计划顺序变了）都得到同一张表，
    // 而"同一份 Vault 导出两次逐字节相同"这条硬要求就建立在它上面。
    .sort((left, right) => compareText(left.relPath, right.relPath))

  return { pages, pathSource, overrides, renamed, drafts, rejected, conflicts }
}

/** 与导出流程其它地方的排序逐字一致（码元序，不用 `localeCompare` —— 它随系统语言变）。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
