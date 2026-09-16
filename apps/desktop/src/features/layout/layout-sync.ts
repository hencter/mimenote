/**
 * 容器切割树的**迁移与对账**（ADR-0035 的第 1 步「接线」的逻辑面，纯函数）。
 *
 * ## 两件事
 * 1. {@link migrateLayout}：把**旧格式**变成树 —— `mimenote.ui.v1` 里的 `dockLayout`（三区停靠）
 *    加上 `mimenote.tabs.v1` 里的笔记列表。老用户升级之后看到的布局与从前等价。
 * 2. {@link reconcileLayout}：让树与**权威列表**对账 —— 打开的笔记（`tabs-store`）与
 *    四种视图模块。树管"**谁在哪**"，权威列表管"**谁存在**"，两者不重复记账。
 *
 * ## 一条刻意保留的旧语义：隐藏 ≠ 移除
 * 面板的可见性一直归各自的开关（`Ctrl+B` / `Ctrl+Shift+L·T·O`），而**位置**归布局模型 ——
 * 所以隐藏一个面板再显示出来，它必须回到原处。这条在树模型里的落法是：
 * **四个模块永远在树上**（始终各占一个标签位置），渲染时按可见性过滤：
 * 某个叶子里的标签全被隐藏时，那一格在画面上收缩掉，但树里什么都没变 ⇒ 再打开就回原位。
 * 因此 {@link reconcileLayout} **不会**因为"面板被隐藏"而移除任何模块。
 *
 * 为什么把这一步单独做成纯函数：接线要动 `ui-store` 的落盘与渲染，风险最大；
 * 而"读旧 → 转树"与"对账"这两件事的判据可以完全脱离 React 与 localStorage 来钉住。
 */

import {
  attachItem,
  contentLeafId,
  defaultLayout,
  fromDockLayout,
  isViewModule,
  itemsOf,
  layoutsEqual,
  leafOfItem,
  leaves,
  noteItem,
  notePathOf,
  normalizeLayout,
  removeItem,
  setActive,
  type MigrateSizes,
  type TreeLayout,
  type ViewModuleId,
} from './tree-layout'

/** 旧格式（`mimenote.ui.v1` 的 `dockLayout`）—— 只读它的形状，不 import 那边的类型。 */
export interface LegacyDockLayout {
  left: readonly ViewModuleId[]
  right: readonly ViewModuleId[]
  bottom: readonly ViewModuleId[]
}

/**
 * 视图模块的**默认落点**（新模块第一次出现时挂哪儿，以及旧格式缺失该区时的兜底）。
 *
 * 与 `features/dock/dock-layout.ts` 的 `DEFAULT_DOCK_LAYOUT` 逐字一致：
 * 文件树在左、链接/标签/大纲在右。放在这里而不是 import 那边，是为了让本模块
 * **不认识**停靠模型（迁移完就与它无关了）；两边不一致时由单测钉住。
 */
export const DEFAULT_MODULE_HOME: Record<ViewModuleId, 'left' | 'right' | 'bottom'> = {
  tree: 'left',
  links: 'right',
  tags: 'right',
  outline: 'right',
}

export interface ReconcileInput {
  /** 打开的笔记（顺序即标签顺序，来自 `tabs-store`）。 */
  notes: readonly string[]
  /** 当前存在的视图模块（**与可见性无关**：隐藏的面板照样在树上，见文件头）。 */
  modules?: readonly ViewModuleId[]
  /** 新模块挂哪儿；缺省用 {@link DEFAULT_MODULE_HOME}。 */
  moduleHome?: (module: ViewModuleId) => 'left' | 'right' | 'bottom'
  /**
   * 当前文档（`note-store.doc.relPath` 的镜像，来自 `tabs-store`）。
   *
   * 给了就保证：**它所在的那一格把它作为激活标签**。这是渲染层的硬前提 ——
   * 叶子只渲染激活标签的内容，若"当前文档"所在的格子停在别的标签上，编辑器就无处可显示
   * （典型路径：wikilink 打开一篇**已在树上**、但它那格停在别处的笔记；attach 只管新标签，
   * 不会替那格翻页）。`null` / 缺省 = "没有或还不知道"，不动任何激活项。
   */
  activeNote?: string | null
}

/**
 * 读旧格式 → 树。
 *
 * - 已经有 `raw`（新格式的树）→ 直接规范化（认不出的标签丢掉、空叶塌缩、比例夹紧）；
 * - 只有 `legacy`（旧的 `dockLayout`）→ 按 `fromDockLayout` 的口径迁移；
 * - 两个都没有 → 默认布局（一个空的叶）。
 *
 * 迁移完之后**仍然过一遍对账**：旧格式里可能缺模块（例如某个面板从没被移动过，
 * 于是没写进 dockLayout），而对账会把四个模块补齐。
 */
export function migrateLayout(
  raw: unknown,
  legacy: {
    dock?: LegacyDockLayout | null
    /**
     * 打开的笔记（**权威**：给了就按它裁剪树上已有的笔记标签）。
     *
     * **不给 = "还没拿到这份名单，别动树上的笔记"** —— 这一条是接线时踩出来的：
     * `ui-store` 在**模块初始化**时读盘，那时 `tabs-store` 还没加载，若传 `[]` 就会把
     * 树上的笔记标签全部裁掉（用户把某篇笔记拖到别处的布局每次启动都丢）。
     * 真正的裁剪交给 `tabs-store` 挂载后的对账（那时它才知道"开着哪几篇"）。
     */
    notes?: readonly string[]
    modules?: readonly ViewModuleId[]
    /**
     * 迁移几何的尺寸线索（旧的像素宽度 + 窗口尺寸）：只在"旧格式 → 树"那一刻用来
     * 把像素换算成比例（不给的话用 1280×800 与旧默认值，见 `tree-layout.ts` 的
     * `MigrateSizes`）。已经有树（`raw`）时完全不读它。
     */
    sizes?: MigrateSizes
  },
): TreeLayout {
  const seed =
    raw === undefined || raw === null
      ? fromLegacy(legacy.dock ?? null, legacy.notes ?? [], legacy.sizes)
      : raw
  const normalized = normalizeLayout(seed)
  if (legacy.notes === undefined && legacy.modules === undefined) return normalized
  return reconcileLayout(normalized, {
    notes: legacy.notes ?? noteItemsIn(normalized),
    ...(legacy.modules === undefined ? {} : { modules: legacy.modules }),
  })
}

/** 树上现有的笔记标签（"没给权威名单"时用它把树原样保住）。 */
function noteItemsIn(layout: TreeLayout): string[] {
  return itemsOf(layout)
    .map((item) => notePathOf(item))
    .filter((path): path is string => path !== null)
}

/** 旧的三区停靠 → 树（`dock` 缺失时退到默认布局 + 逐篇挂载）。 */
function fromLegacy(
  dock: LegacyDockLayout | null,
  notes: readonly string[],
  sizes?: MigrateSizes,
): TreeLayout {
  if (dock === null) {
    let tree = defaultLayout()
    for (const note of notes) tree = attachItem(tree, noteItem(note))
    return tree
  }
  // 直接调 `tree-layout.ts` 的迁移（同一个 feature，同一份口径 —— 曾经的本地副本已删，
  // 尺寸换算只有那一处；单测仍钉着"同一份旧输入 → 同一棵树"）
  return fromDockLayout(dock, notes, sizes)
}

/**
 * 树 ↔ 权威列表对账（**幂等**：对账两次与一次相同）。
 *
 * | 权威列表 | 树上的表现 |
 * | --- | --- |
 * | 有一篇**新打开**的笔记 | 挂到主叶末尾（没有主叶就挂到第一个叶；一个叶都没有就建默认叶） |
 * | 一篇笔记**被关掉** | 从树上移除；那一格空了就塌缩 |
 * | 四种视图模块 | **永远都在**（缺哪个补哪个，默认落点见 `DEFAULT_MODULE_HOME`） |
 *
 * 顺序与位置都不动已有的标签：用户拖过的布局，不会因为打开/关闭一篇笔记而被重置。
 */
export function reconcileLayout(layout: TreeLayout, input: ReconcileInput): TreeLayout {
  const moduleHome = input.moduleHome ?? ((module) => DEFAULT_MODULE_HOME[module])
  let tree = layout

  // 1) 关掉的笔记：从树上摘掉（认不出的"笔记"标签也顺手清掉）
  const wanted = new Set(input.notes.map(noteItem))
  for (const item of itemsOf(tree)) {
    const path = notePathOf(item)
    if (path !== null && !wanted.has(item)) tree = removeItem(tree, item)
  }

  // 2) 新打开的笔记：挂到主叶末尾
  for (const note of input.notes) {
    const item = noteItem(note)
    if (leafOfItem(tree, item) !== null) continue
    tree = attachItem(tree, item, { leafId: mainLeafId(tree) })
  }

  // 3) 视图模块：缺的补上（**不因为被隐藏而移除**，见文件头）
  const modules: readonly ViewModuleId[] =
    input.modules ?? (['tree', 'links', 'tags', 'outline'] as const)
  for (const module of modules) {
    if (leafOfItem(tree, module) !== null) continue
    const home = moduleHome(module)
    const edge = home === 'left' ? 'left' : home === 'right' ? 'right' : 'bottom'
    const anchor = mainLeafId(tree)
    tree = attachItem(tree, module, { leafId: anchor, edge })
  }

  // 4) 当前文档所在的格子必须真的显示它（见 `ReconcileInput.activeNote`）
  if (typeof input.activeNote === 'string') {
    const leaf = leafOfItem(tree, noteItem(input.activeNote))
    if (leaf !== null) tree = setActive(tree, leaf.id, noteItem(input.activeNote))
  }

  const normalized = normalizeLayout(tree, {
    isKnownItem: (item) => isViewModule(item) || notePathOf(item) !== null,
  })
  // 幂等的**强版本**：没变就返回原引用。调用方（`tabs-store` 的订阅）因此可以每帧对账，
  // 而不会让 `ui-store` 每次都写一遍 localStorage。
  return layoutsEqual(normalized, layout) ? layout : normalized
}

/** 主叶的 id（笔记的默认落点 / 模块"切一刀"的锚点；见 `contentLeafId`）。 */
function mainLeafId(layout: TreeLayout): string | undefined {
  return contentLeafId(layout) ?? leaves(layout)[0]?.id
}
