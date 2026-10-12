/**
 * 快速捕获：一行输入 → 收件箱里一篇笔记（ADR-0057 / 设计 03 §2）。
 *
 * 交互上只有三条硬要求：
 * 1. **打开即聚焦、回车即落盘**：捕获的价值是"记完就走"，任何多一步都是它的反面；
 * 2. **失败不吞**：宿主错误显示在输入框旁边，**内容留在屏幕上**（用户按一次回车就能重试，
 *    而不是重打一遍那句话）；
 * 3. **成功即关**：捕获不是编辑器，落盘之后这一层就该消失（要立刻看内容，
 *    收件箱列表里点一下就是打开）。
 *
 * 目标路径的预览用渲染时刻的 `new Date()`：预览是"大概会落成什么名"，真正的标题在
 * `inbox-store.capture` 里按**真正落盘那一刻**生成 —— 两处的生成函数是同一个
 * （`domain/inbox.inboxNoteTitle` / `inboxDailyPath`），不存在"预览与结果不同"的第二种规则。
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { inboxDailyPath, inboxNoteTitle } from '@/domain/inbox'
import { describeError } from '@/ipc/types'
import { useInboxStore } from '@/state/inbox-store'
import { useSettingsStore } from '@/state/settings-store'

import './capture-dialog.css'

export function CaptureDialog() {
  // 目录的真相在设置层（`inbox.dir`）。这里**订阅**它而不是调 `inboxStore.inboxDir()`：
  // 后者是一次性读取，用户在设置里改了收件箱目录之后，已经打开的捕获框要立刻跟上
  // （目标路径预览就在眼前，不跟着变就是在显示假话）。
  const dir = useSettingsStore((state) => state.inboxDir)
  const captureMode = useInboxStore((state) => state.captureMode)
  const capturing = useInboxStore((state) => state.capturing)
  const error = useInboxStore((state) => state.error)

  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 只在挂载时聚焦一次。**不能**用 ref 回调里 `element?.focus()`：内联回调每次渲染都是新函数，
  // React 每帧都会调它一次，结果是一边打字一边被抢焦点（光标跳回开头）。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const at = new Date()
  const target =
    captureMode === 'daily'
      ? inboxDailyPath(dir, at)
      : `${dir}/${inboxNoteTitle(text, at)}.md`
  const empty = text.trim() === ''

  const close = (): void => {
    useInboxStore.getState().close()
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (empty || capturing) return
    const relPath = await useInboxStore.getState().capture(text)
    if (relPath === null) return // 失败：面板与内容都留着
    setText('')
    close()
  }

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // 点遮罩关闭（点对话框内部不关），与回收站/设置对话框同一条约定
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="mn-dialog mn-capture"
        role="dialog"
        aria-modal="true"
        aria-label="快速捕获"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }}
      >
        <header className="mn-capture__header">
          <h2 className="mn-capture__title">快速捕获</h2>
          <button type="button" className="mn-button" onClick={close} aria-label="关闭快速捕获">
            关闭
          </button>
        </header>

        <form className="mn-capture__form" onSubmit={(event) => void submit(event)}>
          <input
            ref={inputRef}
            className="mn-input mn-capture__input"
            value={text}
            placeholder="想到什么？回车存进收件箱"
            aria-label="要捕获的内容"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="submit"
            className="mn-button mn-button--primary"
            disabled={empty || capturing}
            title={empty ? '先写点什么' : '回车也可以'}
          >
            {capturing ? '捕获中…' : '捕获'}
          </button>
        </form>

        <p className="mn-capture__target">
          会落到 <code>{target}</code>
          {captureMode === 'daily' ? '（追加到当日笔记末尾）' : ''}
        </p>

        {error !== null && (
          <p className="mn-capture__error" role="alert">
            {describeError(error, '捕获失败')}
          </p>
        )}
      </div>
    </div>
  )
}
