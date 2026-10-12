/**
 * "打开一篇笔记"的桥（ADR-0060 B8：消掉 `state/tabs-store ↔ app/actions` 这个
 * 全仓唯一的模块级环）。
 *
 * 环的成因很朴素，方向却是错的：`state/tabs-store.activate()` 要知道"打开一篇笔记"
 * 这件事该怎么按顺序做（**先把未保存内容落盘**、切完再同步文件树选中项），
 * 而那套顺序只有 `app/actions/notes.ts` 的 `openNote` 知道 —— 于是状态层反向 import 了组合根。
 *
 * 修法不是把 `openNote` 的实现搬进 state（它要用 `features/**` 的能力，搬下去只会把环换成
 * 另一条越界边），而是在 state 侧留一个**函数指针**、由组合根装进来 ——
 * 与 `state/tabs-store.ts` 里 `setCaretMemory` 的注入手法完全一致（那条边当年也是这么消的）。
 *
 * 装配时机：`app/actions.ts`（动作的公开入口）在**模块加载时**装桥。凡是能打开笔记的代码路径
 * 都已经加载了那个入口，所以"忘记装"这件事在真实运行里不可能发生；未装时
 * `requestOpenNote` 会返回 `false`（显式的"没打开"），而不是静默假装成功。
 */

import { setOpenNoteRequest } from '@/state/tabs-store'

import { openNote } from './actions/notes'

/**
 * 装桥（幂等）。返回卸载函数 —— 单测里可以用它还原到"未安装"的状态，
 * 以便断言"没有实现时 `activate` 返回 false"这条显式语义。
 */
export function installOpenNoteBridge(): () => void {
  setOpenNoteRequest(openNote)
  return () => {
    setOpenNoteRequest(null)
  }
}
