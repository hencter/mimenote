/** 设置页 · 编辑器分区：自动保存延迟、Tab 宽度、行号、附件目录。 */

import { useState } from 'react'

import { Icon } from '@/components/Icon'
import { DEFAULT_ATTACHMENT_DIR, normalizeAttachmentDir } from '@/domain/attachments'
import {
  AUTOSAVE_DELAY_OPTIONS,
  DEFAULT_SETTINGS,
  TAB_WIDTH_OPTIONS,
  useSettingsStore,
} from '@/state/settings-store'

export function EditorSection() {
  const autosaveDelayMs = useSettingsStore((state) => state.autosaveDelayMs)
  const setAutosaveDelayMs = useSettingsStore((state) => state.setAutosaveDelayMs)
  const tabWidth = useSettingsStore((state) => state.tabWidth)
  const setTabWidth = useSettingsStore((state) => state.setTabWidth)
  const editorLineNumbers = useSettingsStore((state) => state.editorLineNumbers)
  const setEditorLineNumbers = useSettingsStore((state) => state.setEditorLineNumbers)
  const attachmentDir = useSettingsStore((state) => state.attachmentDir)
  const setAttachmentDir = useSettingsStore((state) => state.setAttachmentDir)
  /**
   * 输入框的**草稿**值。
   *
   * 为什么不用受控输入直接写回 store：附件目录是"边打边生效"最糟的那类设置 ——
   * 每敲一个字符就归一化一次，用户永远打不出 `附件/粘贴`（中间的 `附件/` 是合法值，
   * 而清空到空串会被当成"Vault 根"立刻生效）。所以输入过程只改草稿，
   * 失焦或回车时才落到 store（`commit`）。
   */
  const [draftDir, setDraftDir] = useState<string | null>(null)
  const shownDir = draftDir ?? attachmentDir

  const commit = (): void => {
    if (draftDir === null) return
    setAttachmentDir(draftDir)
    setDraftDir(null)
  }

  return (
    <>
      <h3 className="mn-settings__section-title">编辑器</h3>
      <p className="mn-settings__section-hint">
        这几项是"写盘节奏""显示方式"与"粘贴的图片放哪儿"，与具体笔记无关，因此跨 Vault 保存；
        全部**即时生效**，不需要重开笔记。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-autosave-title">
        <h4 className="mn-settings__group-title" id="mn-settings-autosave-title">
          <Icon name="save" size="sm" />
          自动保存
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">自动保存延迟</span>
            <span className="mn-settings__row-hint">
              停止输入后多久写盘（防抖窗口）。写入本身是原子替换，写盘期间继续输入不会丢字；
              <code className="mn-settings__path">Ctrl+S</code> 始终可以立刻保存
            </span>
          </span>
          <label className="mn-settings__row-control">
            <span className="mn-visually-hidden">自动保存延迟</span>
            <select
              className="mn-settings__select"
              aria-label="自动保存延迟"
              value={autosaveDelayMs}
              onChange={(event) => setAutosaveDelayMs(Number(event.target.value))}
            >
              {AUTOSAVE_DELAY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} ms
                  {option === DEFAULT_SETTINGS.autosaveDelayMs ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-tab-title">
        <h4 className="mn-settings__group-title" id="mn-settings-tab-title">
          <Icon name="columns" size="sm" />
          制表符
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">制表符显示宽度</span>
            <span className="mn-settings__row-hint">
              走 CSS 变量 <code className="mn-settings__path">--mn-tab-size</code>
              （<code>tab-size</code> 是继承属性）：编辑器里已有的制表符与预览中的代码块一起跟随
            </span>
          </span>
          <label className="mn-settings__row-control">
            <span className="mn-visually-hidden">Tab 宽度</span>
            <select
              className="mn-settings__select"
              aria-label="Tab 宽度"
              value={tabWidth}
              onChange={(event) => setTabWidth(Number(event.target.value))}
            >
              {TAB_WIDTH_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} 字符
                  {option === DEFAULT_SETTINGS.tabWidth ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mn-settings__note">
          说明：这里改变的是制表符的显示宽度。编辑器刻意没有绑定 Tab 键（保留 Tab 在控件之间
          导航的可访问性），CodeMirror 内部按字符列计算光标位置时仍用自己的默认{' '}
          <code className="mn-settings__path">tabSize: 4</code>
          ；要让它与这个设置完全一致，需要在{' '}
          <code className="mn-settings__path">features/editor/cm/setup.ts</code> 里补一行{' '}
          <code className="mn-settings__path">EditorState.tabSize.of(值)</code>
          （属于编辑器装配，不在本次改动范围内）。
        </p>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-gutter-title">
        <h4 className="mn-settings__group-title" id="mn-settings-gutter-title">
          <Icon name="outline" size="sm" />
          行号
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">显示行号</span>
            <span className="mn-settings__row-hint">
              左侧那一栏行号。关掉之后正文会宽出十几像素（纯写作时那一栏是纯噪声）；
              「跳到第 N 行」「对着日志找位置」这类事需要它，所以默认是开的
            </span>
          </span>
          <label className="mn-settings__checkbox">
            <input
              type="checkbox"
              aria-label="显示行号"
              checked={editorLineNumbers}
              onChange={(event) => setEditorLineNumbers(event.target.checked)}
            />
          </label>
        </div>
        <p className="mn-settings__note">
          说明：切换是<strong>即时</strong>的 —— 编辑器只把那一段扩展换掉（CodeMirror 的
          {' '}
          <code className="mn-settings__path">Compartment</code>），文档、光标、选区、
          撤销历史一个都不动；也不必重开笔记。设置跨 Vault 保存。
        </p>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-attachment-title">
        <h4 className="mn-settings__group-title" id="mn-settings-attachment-title">
          <Icon name="file" size="sm" />
          附件
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">附件目录</span>
            <span className="mn-settings__row-hint">
              粘贴（<code className="mn-settings__path">Ctrl+V</code>）或拖入的图片存到这里，
              目录不存在时会自动创建；留空表示直接放在 Vault 根目录。笔记里插入的链接始终是
              <strong>相对当前笔记</strong>的路径，因此移动笔记也不会断
            </span>
          </span>
          <label className="mn-settings__row-control">
            <span className="mn-visually-hidden">附件目录</span>
            <input
              type="text"
              className="mn-settings__input"
              aria-label="附件目录"
              placeholder={DEFAULT_ATTACHMENT_DIR}
              value={shownDir}
              onChange={(event) => setDraftDir(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
              }}
            />
          </label>
        </div>
        <p className="mn-settings__note">
          说明：这里写的是 <strong>Vault 内的相对目录</strong>（如{' '}
          <code className="mn-settings__path">{DEFAULT_ATTACHMENT_DIR}</code> 或{' '}
          <code className="mn-settings__path">assets</code>），不是本机绝对路径 ——
          绝对路径、<code className="mn-settings__path">..</code> 之类的写法会被归一化回默认值。
          {normalizeAttachmentDir(shownDir) !== shownDir.trim() && (
            <span className="mn-settings__note--warn">（当前输入不合法，将回退为默认目录）</span>
          )}
        </p>
      </section>
    </>
  )
}
