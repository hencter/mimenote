/**
 * 粘贴 / 拖入图片 → 落进 Vault 的附件目录，并在光标（或鼠标释放）处插入 `![](相对路径)`。
 *
 * 这是 ADR-0013 的前端一半：**取字节 → 交给宿主落盘 → 把宿主回传的最终路径插进文档**。
 * 判断"图放哪儿、叫什么"的是纯函数（`domain/attachments.ts`），这里只负责接线。
 *
 * ## 为什么用 `EditorView.domEventHandlers`，而不是在 `contentDOM` 上自己加监听
 *
 * CodeMirror 自己处理 `paste` / `drop`（它会把拖进来的文件当**文本**读进来、把剪贴板文本插进文档）。
 * 两种接法看起来都对，实际只有一种不会打架：
 *
 * * `contentDOM.addEventListener('paste', …)` 与 CodeMirror 的处理器**同时**跑 —— 一次粘贴会走两遍，
 *   图片既被我们处理、也被它按"空文本"处理一次（结果是插入位置/撤销历史里多出一笔）；
 * * `EditorView.domEventHandlers` 是 CodeMirror 认得的扩展：它的分发是"**第一个返回 `true` 的
 *   处理器吃掉事件并 `preventDefault`，后面的都不再跑**"，而插件提供的处理器**排在**内置处理器
 *   之前（`@codemirror/view` 的 `computeHandlers`：先收插件的，最后才 `push` 内置的 `handlers`）。
 *
 * 于是"合作"的规则只有一条：**图片粘贴/拖放返回 `true`，其余一律返回 `false`**。
 * 返回 `false` 时文本粘贴完全落到 CodeMirror 的默认实现上（用户粘一行代码、一段表格，行为与
 * 加这个功能之前**一模一样**）—— 这也是它必须有测试的原因。
 *
 * 另一个必须同步决定的事：`domEventHandlers` 的返回值不是 Promise。读字节、落盘、插链接全是
 * 异步的，所以处理器**同步返回 `true`（"这次事件我接管了"）**，真正的活在后台继续跑。
 *
 * ## 与 `dragDropEnabled: false` 的关系
 *
 * `tauri.conf.json` 关掉了系统级拖放，于是 WebView 拿到的就是**原生 HTML5 拖放事件**
 * （`dataTransfer.files` 可用）。这也是选 HTML5 而不是 Tauri `onDragDropEvent` 的原因：
 * 后者只告诉宿主"有文件落在这个窗口的哪个坐标"，既不知道落点是不是编辑器、也拿不到
 * "第几行"这个信息（见 ADR-0013）。
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  attachmentFileName,
  attachmentMarkdown,
  bytesToBase64,
  extensionForImage,
} from '@/domain/attachments'
import { ipc } from '@/ipc/client'
import type { AttachmentInput } from '@/ipc/types'
import { MimenoteError, describeError } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

/** 事件被谁接管（决定事务的 `userEvent`，也是排查"这次插入是谁干的"的锚点）。 */
type InputSource = 'input.paste' | 'input.drop'

/**
 * 从 `DataTransfer` 里取出文件。
 *
 * 先看 `files`，为空再看 `items`：**截图工具粘贴**走的是后者（`kind === 'file'`，
 * `files` 常常是空的），而资源管理器拖放走的是前者。两条路都要覆盖，否则
 * "从浏览器复制图片能粘、截图工具粘不了"这种半可用状态极难查。
 */
function filesOf(transfer: DataTransfer | null): File[] {
  if (transfer === null) return []
  const listed = Array.from(transfer.files ?? [])
  if (listed.length > 0) return listed

  const fromItems: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null) fromItems.push(file)
  }
  return fromItems
}

/** 这次拖拽里是否带**文件**（决定 `dragover` 要不要接管）。 */
function hasFiles(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false
  if ((transfer.files?.length ?? 0) > 0) return true
  return Array.from(transfer.types ?? []).some((type) => type === 'Files')
}

/** 读成 base64（`File` 只给字节，没有可用的本地路径 —— 见 ADR-0013 的"为什么走字节"）。 */
async function readBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  return bytesToBase64(new Uint8Array(buffer))
}

/** 文件名列表 → 一句可读的提示文案（最多列 3 个，剩下的给个数）。 */
function describeFiles(files: readonly File[]): string {
  const names = files.slice(0, 3).map((file) => file.name || '（未命名）')
  return files.length > 3 ? `${names.join('、')} 等 ${files.length} 个文件` : names.join('、')
}

/**
 * 把一段 Markdown 插到文档里，并让光标落在**它下面一行**。
 *
 * 为什么不是"插完把光标停在图片那行"：Live Preview 的规则是**光标所在行露出原文**
 * （ADR-0009），光标若停在 `![](…)` 上，用户看到的就是这串源码而不是图片 ——
 * "粘贴后立刻能看到图"这条要求就落空了。独占一段 + 光标在下一行，两个目的同时满足。
 *
 * 一次 `dispatch` = 一个撤销步骤：`Ctrl+Z` 一下就把这次插入（连同换行）整条撤掉。
 * 只处理**主选区**（多光标时按主光标插入）：附件落盘是"一次动作一个结果"，
 * 在每个光标处各插一遍同一张图，用户还得手工删掉多余的几处。
 */
function insertAttachmentBlock(
  view: EditorView,
  at: number | null,
  markdown: string,
  userEvent: InputSource,
): void {
  const doc = view.state.doc
  const range = view.state.selection.main
  const from = Math.min(at ?? range.from, doc.length)
  const to = at === null ? range.to : from

  // 插入点前后若不是换行，就补一个 —— 图片必须独占一段才会被渲染成块级图片
  const leading = from > 0 && doc.sliceString(from - 1, from) !== '\n' ? '\n' : ''
  const insert = `${leading}${markdown}\n`

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent,
  })
}

/**
 * 落盘 → 插链接 → 刷新文件树。
 *
 * 顺序是刻意的：**先确认字节真的进了 Vault，再往文档里写路径**。反过来的话，一次失败的粘贴
 * 会在笔记里留一条指向不存在文件的链接（用户看到的是占位方块，且不知道是自己写错了还是功能坏了）。
 */
async function saveImages(
  view: EditorView,
  files: readonly File[],
  options: { at: number | null; source: InputSource },
): Promise<void> {
  const note = useNoteStore.getState().doc
  if (note === null || useVaultStore.getState().info === null) {
    toast.warn('先打开一篇笔记', '粘贴的图片要存进 Vault，需要知道当前笔记在哪')
    return
  }

  // 下面三条是**提前提示**，不是安全边界：宿主会独立再判一遍（见 ADR-0013）。
  // 放在这里只是为了让用户立刻知道"为什么没反应"，而不是等一次 IPC 往返。
  if (files.length > MAX_ATTACHMENTS) {
    toast.error('一次粘贴的图片太多', `最多 ${MAX_ATTACHMENTS} 张（本次 ${files.length} 张）`)
    return
  }
  const unsupported = files.filter((file) => extensionForImage(file.type, file.name) === null)
  if (unsupported.length > 0) {
    // 整批拒绝而不是"存下能存的"：否则会出现"三张进了 Vault、第四张没有"的中间态，
    // 而用户只看到一句"部分失败"，还得自己数文件树里到底少哪一张
    toast.error('只接受图片文件', `${describeFiles(unsupported)}（支持 png / jpg / gif / webp / avif / bmp / svg / ico）`)
    return
  }
  const oversize = files.find((file) => file.size > MAX_ATTACHMENT_BYTES)
  if (oversize !== undefined) {
    toast.error('图片太大', `${oversize.name}：${oversize.size} 字节 > 单张上限 ${MAX_ATTACHMENT_BYTES} 字节`)
    return
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
    toast.error(
      '这批图片太大',
      `合计 ${totalBytes} 字节 > 一批上限 ${MAX_ATTACHMENT_BATCH_BYTES} 字节（可以分几次粘贴）`,
    )
    return
  }

  // 命名规则见 `domain/attachments.ts`：保留原文件名；通用名（image.png / blob / 无扩展名）
  // 换成带时间戳的名字（否则连续粘贴会互相去重成 `image 1.png` 这种猜不出内容的名字）
  const at = new Date()
  const inputs: AttachmentInput[] = []
  for (const file of files) {
    const name = attachmentFileName({ name: file.name, mime: file.type, at })
    if (name === null) {
      toast.error('无法识别的图片类型', describeFiles([file]))
      return
    }
    inputs.push({ name, dataBase64: await readBase64(file) })
  }

  try {
    const dir = useSettingsStore.getState().attachmentDir
    const saved = await ipc.attachmentSave(dir, inputs)
    if (saved.length === 0) return

    // 读字节/落盘是异步的，期间用户可能已经切走了笔记：那就只落盘、不插链接
    // （往另一篇笔记里插一条指向"上一篇"的相对路径，比不插更糟）
    const current = useNoteStore.getState().doc
    if (current === null || current.relPath !== note.relPath) {
      toast.warn('图片已保存，但没有插入链接', `当前笔记已切换（图片在 ${dir === '' ? 'Vault 根目录' : dir} 里）`)
      return
    }

    const markdown = saved
      .map((item) => attachmentMarkdown(note.relPath, item.relPath))
      .join('\n')
    insertAttachmentBlock(view, options.at, markdown, options.source)

    // 文件树刷新：条目表是"打开 Vault 时扫一次"的快照，这里是**增量**插入
    // （不重扫目录，10k 笔记下重扫是 800ms 级的开销）
    for (const item of saved) {
      useVaultStore.getState().registerAttachment(item)
    }

    const detail =
      saved.length === 1
        ? saved[0]?.relPath
        : `${saved.length} 张 → ${dir === '' ? 'Vault 根目录' : dir}`
    toast.success('已插入图片', detail)
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '插入图片失败'))
  }
}

/**
 * 拖放落点：**鼠标释放处**（不是光标处）。
 *
 * `posAtCoords` 在拿不到布局时返回 `null`（编辑器被隐藏、`jsdom` 这类没有真实排版的环境）——
 * 那时退回光标位置：仍然是一次合法的插入，不会因为算不出坐标就把整次拖放丢掉。
 */
function dropPosition(view: EditorView, event: DragEvent): number {
  return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
}

/**
 * 编辑器扩展：接管"带文件的粘贴/拖放"。
 *
 * 四条分支各自的返回值都是刻意的：
 *
 * * `paste` 没有文件 → `false`：纯文本粘贴交回 CodeMirror（**行为与加这个功能之前完全一致**）；
 * * `paste` 有文件 → `true`：即使里面不是图片也要接管并明确报错。让 CodeMirror 兜底的话，
 *   它会把这些文件当文本读进来（`.pdf` 的字节流会被插进文档），那比"没反应"更糟；
 * * `drop` 带文件 → `true`（理由同上），落点用鼠标坐标；
 * * `dragover` 带文件 → `true`：**HTML5 拖放的硬性要求** —— 不 `preventDefault` 浏览器根本不会
 *   派发 `drop`。只对"带文件"的拖拽这么做，编辑器内部的文本拖动仍旧归 CodeMirror 自己处理。
 *
 * 返回数组而不是单个 `Extension`：与 `livePreviewExtensions()` 等装配点保持同一形状
 * （`createEditorExtensions` 里统一展开）。
 */
export function imageInputExtensions(): Extension[] {
  return [
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const files = filesOf(event.clipboardData)
        if (files.length === 0) return false
        void saveImages(view, files, { at: null, source: 'input.paste' })
        return true
      },
      drop: (event, view) => {
        const files = filesOf(event.dataTransfer)
        if (files.length === 0) return false
        void saveImages(view, files, {
          at: dropPosition(view, event),
          source: 'input.drop',
        })
        return true
      },
      dragover: (event) => hasFiles(event.dataTransfer),
    }),
  ]
}

/**
 * 给测试用的接缝。
 *
 * 为什么需要它：事件的"吃不吃掉"是**同步**返回值，而真正的处理是异步的（读字节 → IPC → 落盘），
 * 所以测试要能分别断言这两件事；而"插入块的落点规则"又依赖坐标，在 jsdom 里拿不到真实排版
 * （`posAtCoords` 返回 `null`）—— 位置规则因此按纯函数测，其余仍走真实事件。
 */
export const __testing = {
  /** 载荷 → 文件（`files` 优先、退到 `items` 的那条规则）。 */
  filesOf,
  /** 载荷里是否有文件（`dragover` 据此决定接不接管）。 */
  hasFiles,
  /** 把一段 Markdown 插到指定位置（落点/独占一段/光标位置）。 */
  insertAttachmentBlock,
}
