/**
 * 标签重命名/合并的**文案与分组**（纯函数，可单测）。
 *
 * 为什么单独一个模块：这些句子有两个使用者 —— 对话框（结果面板）与 toast（离开面板之后
 * 唯一还看得见的反馈），而它们必须**逐字一致**。分开写两份的后果是同一件事在两处说成
 * 两样，用户无法判断该信哪一句。
 *
 * 三条纪律：
 *
 * 1. **不许说"部分成功"**：改了就说改了、跳过就说跳过（含为什么、下一步怎么办）。
 *    只报"成功"而把跳过藏起来，正是本功能最需要避免的那种谎话；
 * 2. 数字全部来自宿主的返回（`edited` / `skipped` / `candidates`），前端不做任何推算 ——
 *    预演的那句"这会改 N 篇笔记"与真跑之后的"改了 N 篇"因此同源；
 * 3. 跳过按**原因**分组（宿主的稳定原因串），一组一句话，而不是把几十条 message 平铺出来。
 */

import type { TagRenameOutcome, TagRenameSkip, TagSkipReason } from '@/ipc/types'

/** 稳定跳过原因 → 一句人话（面向用户，不带错误码）。 */
export function describeSkipReason(reason: TagSkipReason): string {
  switch (reason) {
    case 'external-change':
      return '磁盘被外部改动'
    case 'unreadable':
      return '读不到这个文件'
    case 'write-failed':
      return '写入失败'
  }
}

/** 稳定跳过原因 → "怎么办"（用户唯一真正需要的下一步）。 */
export function skipAdvice(reason: TagSkipReason): string {
  switch (reason) {
    case 'external-change':
      return '磁盘被外部改动，请重试'
    case 'unreadable':
      return '可能已被外部删除，或不是 UTF-8 文本'
    case 'write-failed':
      return 'Vault 可能是只读的，或文件正被别的程序占用'
  }
}

/** 一组同原因的跳过（对话框里一组一行，而不是几十条平铺）。 */
export interface TagRenameSkipGroup {
  reason: TagSkipReason
  /** 原因的人话（`describeSkipReason`）。 */
  label: string
  /** 下一步（`skipAdvice`）。 */
  advice: string
  files: string[]
}

/** 把跳过按原因分组，组间顺序固定（便于阅读，也让测试可复现）。 */
export function groupSkips(skipped: readonly TagRenameSkip[]): TagRenameSkipGroup[] {
  const order: TagSkipReason[] = ['external-change', 'write-failed', 'unreadable']
  const groups: TagRenameSkipGroup[] = []
  for (const reason of order) {
    const files = skipped.filter((item) => item.reason === reason).map((item) => item.relPath)
    if (files.length === 0) continue
    groups.push({ reason, label: describeSkipReason(reason), advice: skipAdvice(reason), files })
  }
  return groups
}

/** 预演阶段的那句话（"先查询再确认"里的查询结果）。 */
export function previewSentence(outcome: TagRenameOutcome): string {
  if (outcome.edited.length === 0) {
    return outcome.candidates === 0
      ? '没有笔记用到这个标签，这次改名不会改动任何文件'
      : '这些笔记里已经没有旧写法了，本次不会改动任何文件'
  }
  const skipped = outcome.skipped.length > 0 ? `（另有 ${outcome.skipped.length} 篇读不到，将被跳过）` : ''
  return `这会改 ${outcome.edited.length} 篇笔记${skipped}`
}

/** 执行之后的汇报：改了 / 没改（含原因），一句人话说完。 */
export function resultSentence(outcome: TagRenameOutcome): string {
  if (outcome.edited.length === 0 && outcome.skipped.length === 0) {
    return '没有笔记需要改动'
  }
  const parts: string[] = []
  if (outcome.edited.length > 0) parts.push(`改了 ${outcome.edited.length} 篇笔记`)
  if (outcome.skipped.length > 0) {
    const reasons = groupSkips(outcome.skipped)
      .map((group) => `${group.files.length} 篇${group.label}`)
      .join('、')
    parts.push(`${outcome.skipped.length} 篇没改（${reasons}）`)
  }
  return parts.join('，')
}

/** 改写细节（frontmatter 几处 / 正文几处）—— 说清"到底动了什么"。 */
export function editDetail(outcome: TagRenameOutcome): string {
  const parts = [`frontmatter ${outcome.frontmatterEdits} 处`, `正文行内 ${outcome.inlineEdits} 处`]
  if (outcome.inlineRemoved > 0) parts.push(`合并去掉重复 ${outcome.inlineRemoved} 处`)
  return parts.join(' · ')
}

/**
 * 一次改名是否真的改动了什么（用于决定要不要重读当前笔记、要不要刷新图谱）。
 *
 * 预演永远为 `false`：它没有写盘，任何"跟着变"的状态都不该动。
 */
export function changedAnything(outcome: TagRenameOutcome): boolean {
  return !outcome.dryRun && outcome.edited.length > 0
}
