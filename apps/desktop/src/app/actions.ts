/**
 * 组合动作的**再导出壳**（ADR-0060 §3(c)）。
 *
 * 实现已经按领域拆进 `app/actions/**`：
 * - `vault.ts`：Vault 生命周期 / 重扫 / 回收站 / 片段 / 关于；
 * - `notes.ts`：打开、新建、保存、删除笔记（`openNote` / `openNoteAt` 就在这里 ——
 *   它是被复用最多的入口，B8 消环要接的是它）；
 * - `tags.ts`：标签编辑 / 改名 / 移动；
 * - `directories.ts`：目录改名与移动、条目级 rename/move。
 *
 * 这里保留原来的模块路径与**同名的**导出符号，39 处 `features → app/actions` 的调用点零改动。
 *
 * 加载本模块还会**装好"打开笔记"的桥**（`app/open-bridge.ts`）：`state/tabs-store` 需要一个
 * "打开一篇笔记"的实现，但不许反向 import 组合根；本文件是动作的公开入口，
 * 凡是能打开笔记的路径都加载过它，因此在这里装桥既够早也够全。
 */
import { installOpenNoteBridge } from './open-bridge'

export { moveDirectory, moveEntry, moveSelected, renameDirectory, renameEntry, renameSelected } from './actions/directories'
export { createNoteFromLink, createNoteHere, createNoteIn, deleteSelected, moveNote, openNote, openNoteAt, openNoteInNewTab, reloadCurrentNote, renameNote, saveCurrentNote, targetDirectoryForNewNote } from './actions/notes'
export { editCurrentNoteTags, explainInlineTag, moveTag, renameTag } from './actions/tags'
export type { TagEditResult } from './actions/tags'
export { closeVault, openRecentVault, openTrash, openVaultInteractive, rescanVault, showAbout, syncSnippets, toggleSnippets } from './actions/vault'

installOpenNoteBridge()
