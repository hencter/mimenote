/**
 * 「从模板新建」对话框：先选模板（+ 起名），有 `@prompt` 时再走第二步填答案。
 *
 * ## 为什么是"两步"，而不是"选完立刻创建"
 * `@prompt` 的答案必须先收集齐、再一次性展开（`domain/template/expand.ts` 的模块头）。
 * 如果选完立刻创建、创建过程中再弹输入框，用户会卡在"笔记已经建了、内容还没定"的
 * 半途状态里；把问题**前置到创建之前**，取消就等于什么都没发生（不会留下半篇笔记）。
 *
 * ## 为什么给"标题"一个输入框
 * `@title` / `@filename` / `@path` 展开的是**这篇新笔记自己**的名字（设计 02 §3）。
 * 不给用户起名的机会，那三个记号就只能展开成默认的"未命名笔记" —— 等于白给。
 * 标题留空时退回默认值（与 `createNoteIn` 一致）。
 *
 * ## 清单从哪来
 * `useTemplateStore`（宿主命令 `templates_list`）。模板目录被扫描器忽略，所以它**不在**
 * 文件树里 —— 这个对话框就是用户唯一能看见它们的地方，空态因此必须写清"去哪儿放文件"。
 *
 * ## 与其他对话框一致的纪律
 * 由 `App.tsx` 常驻挂载、`open === false` 时返回 `null`；`Esc` / 点击遮罩关闭；
 * 关闭时把焦点还给打开它的元素；`Esc` / `Enter` 都 `stopPropagation`，
 * 不让冒泡到全局快捷键（与 `MoveDialog` 同一套，见它的模块头）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError } from '@/ipc/types'
import type { TemplateFile } from '@/ipc/types'
import { templateTitle, useTemplateStore } from '@/state/template-store'
import { toast } from '@/state/toast-store'

import {
  DEFAULT_NOTE_TITLE,
  createNoteFromTemplate,
  describeTemplateNotes,
  readTemplateForCreate,
  type PreparedTemplate,
} from './from-template'

import './template-picker.css'

/** 选中并且已经读出正文的模板（第二步渲染它的问题清单）。 */
interface PendingTemplate {
  file: TemplateFile
  prepared: PreparedTemplate
}

export function TemplatePickerDialog() {
  const open = useTemplateStore((state) => state.open)
  const dir = useTemplateStore((state) => state.dir)
  const status = useTemplateStore((state) => state.status)
  const templates = useTemplateStore((state) => state.templates)
  const error = useTemplateStore((state) => state.error)
  const selected = useTemplateStore((state) => state.selected)

  const [step, setStep] = useState<'pick' | 'prompts'>('pick')
  const [title, setTitle] = useState(DEFAULT_NOTE_TITLE)
  const [pending, setPending] = useState<PendingTemplate | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  /** 关闭后把焦点还给打开它的元素（键盘用户不会"掉焦点"）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const firstPromptRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback((): void => {
    useTemplateStore.getState().closePicker()
    setStep('pick')
    setPending(null)
    setAnswers({})
    setBusy(false)
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  // 每次打开都从第一步、干净的局部状态开始（上一次的标题/答案不该留到下一次）
  useEffect(() => {
    if (!open) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    setStep('pick')
    setPending(null)
    setAnswers({})
    setBusy(false)
    setTitle(DEFAULT_NOTE_TITLE)
    useTemplateStore.getState().select(null)
  }, [open])

  // 第一步把光标放进标题框（大多数流程是"选一个模板 → 改个名字 → 回车"）
  useEffect(() => {
    if (!open || step !== 'pick') return
    const frame = requestAnimationFrame(() => titleRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, step])

  useEffect(() => {
    if (!open || step !== 'prompts') return
    const frame = requestAnimationFrame(() => firstPromptRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, step])

  /** 真正创建。`promptAnswers` 为空表就是"没有 @prompt"。 */
  const runCreate = useCallback(
    async (prepared: PreparedTemplate, promptAnswers: ReadonlyMap<string, string>): Promise<void> => {
      const created = await createNoteFromTemplate({
        // 展开用的是**第一步读到的那一份正文**（问题清单与展开必须同源）
        templateText: prepared.text,
        templateRelPath: prepared.templateRelPath,
        title,
        promptAnswers,
      })
      if (created === null) {
        // 失败原因已经由 `createNoteFromTemplate` 弹过 toast；对话框留着让用户改标题重试
        setBusy(false)
        return
      }
      close()
      toast.success('已从模板新建笔记', created.note.relPath)
      const notes = describeTemplateNotes(created.notes)
      if (notes !== null) toast.warn('模板里有需要注意的地方', notes)
    },
    [close, title],
  )

  /**
   * 第一步确认：读模板 → 有问题就进第二步，没有问题直接创建。
   *
   * 模板路径**显式传进来**（不读组件闭包里的 `selected`）：双击某一行时"选中"这个
   * store 更新还没提交，闭包里拿到的会是上一条。
   */
  const begin = useCallback(
    async (templateRelPath?: string): Promise<void> => {
      const relPath = templateRelPath ?? useTemplateStore.getState().selected
      if (relPath === null || busy) return
      setBusy(true)
      const prepared = await readTemplateForCreate(relPath)
      if (prepared === null) {
        setBusy(false)
        return
      }
      if (prepared.prompts.length > 0) {
        const file = useTemplateStore.getState().templates.find((item) => item.relPath === relPath)
        setPending(
          file === undefined ? { file: { name: relPath, relPath, sizeBytes: 0 }, prepared } : { file, prepared },
        )
        setAnswers({})
        setStep('prompts')
        setBusy(false)
        return
      }
      await runCreate(prepared, new Map())
    },
    [busy, runCreate],
  )

  /** 第二步确认：把答案交给展开器。 */
  const submitPrompts = useCallback(async (): Promise<void> => {
    if (pending === null || busy) return
    setBusy(true)
    await runCreate(pending.prepared, new Map(Object.entries(answers)))
  }, [answers, busy, pending, runCreate])

  if (!open) return null

  const canCreate = selected !== null && !busy

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <div
        className="mn-dialog mn-dialog--template"
        role="dialog"
        aria-modal="true"
        aria-label="从模板新建"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // 焦点在模板行（一个按钮）上时，Esc 也得能关上：对话框自己吃掉，
          // 不让它冒泡到全局快捷键
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            event.stopPropagation()
            if (step === 'prompts') {
              // 退了第一步而不是直接关掉：标题与选择都还在，用户不必重来
              setStep('pick')
              setPending(null)
              return
            }
            close()
          }
        }}
      >
        <div className="mn-dialog__header">
          <h2>{step === 'pick' ? '从模板新建' : '模板要问几个问题'}</h2>
        </div>

        {step === 'pick' ? (
          <>
            <p className="mn-dialog__message">
              模板目录：<code className="mn-template__dir">{dir}</code>
              {status === 'loading' && <span className="mn-template__hint"> · 正在读取…</span>}
            </p>

            {error !== null ? (
              <p className="mn-dialog__message mn-template__error" role="alert">
                {describeError(error, '读取模板目录失败')}
              </p>
            ) : templates.length === 0 && status !== 'loading' ? (
              <p className="mn-dialog__message mn-template__empty">
                这个目录里还没有模板。在 Vault 的 <code>{dir}</code> 下放几个 `.md`
                文件即可，里面的 `@` 记号会在创建时展开。
              </p>
            ) : (
              <div className="mn-template__list" role="listbox" aria-label="模板">
                {templates.map((file) => {
                  const active = file.relPath === selected
                  return (
                    <button
                      key={file.relPath}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`mn-template__item${active ? ' mn-template__item--active' : ''}`}
                      title={file.relPath}
                      disabled={busy}
                      onClick={() => useTemplateStore.getState().select(file.relPath)}
                      onDoubleClick={() => void begin(file.relPath)}
                    >
                      <span className="mn-template__name">{templateTitle(file)}</span>
                      <span className="mn-template__path">{file.relPath}</span>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="mn-template__field">
              <label className="mn-template__label" htmlFor="mn-template-title">
                新笔记标题
              </label>
              <input
                id="mn-template-title"
                ref={titleRef}
                className="mn-template__input"
                type="text"
                value={title}
                disabled={busy}
                placeholder={DEFAULT_NOTE_TITLE}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.stopPropagation()
                  void begin()
                }}
              />
            </div>

            <div className="mn-dialog__actions">
              <button
                type="button"
                className="mn-button mn-button--ghost"
                disabled={busy}
                onClick={() => void useTemplateStore.getState().refresh()}
              >
                重新读取
              </button>
              <button type="button" className="mn-button" disabled={busy} onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="mn-button mn-button--primary"
                disabled={!canCreate}
                onClick={() => void begin()}
              >
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mn-dialog__message">
              模板 <strong>{pending === null ? '' : templateTitle(pending.file)}</strong> 里有{' '}
              {pending?.prepared.prompts.length ?? 0} 处 `@prompt`，填完就会创建笔记。
            </p>

            <div className="mn-template__prompts">
              {(pending?.prepared.prompts ?? []).map((label, index) => (
                <div className="mn-template__field" key={`${label}-${index}`}>
                  <label className="mn-template__label" htmlFor={`mn-template-prompt-${index}`}>
                    {label === '' ? '（未命名的问题）' : label}
                  </label>
                  <input
                    id={`mn-template-prompt-${index}`}
                    ref={index === 0 ? firstPromptRef : undefined}
                    className="mn-template__input"
                    type="text"
                    value={answers[label] ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      setAnswers((previous) => ({ ...previous, [label]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      event.stopPropagation()
                      void submitPrompts()
                    }}
                  />
                </div>
              ))}
            </div>

            <div className="mn-dialog__actions">
              <button
                type="button"
                className="mn-button"
                disabled={busy}
                onClick={() => {
                  setStep('pick')
                  setPending(null)
                }}
              >
                上一步
              </button>
              <button
                type="button"
                className="mn-button mn-button--primary"
                disabled={busy}
                onClick={() => void submitPrompts()}
              >
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
