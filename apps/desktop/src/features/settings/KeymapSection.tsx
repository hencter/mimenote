/**
 * 设置页 · 键位分区（ADR-0055）：档案 + 逐条覆盖 + 冲突可见。
 *
 * 三条纪律体现在界面上：
 * 1. **命令表是唯一事实来源**：这一页不维护任何"命令清单"，读的就是 `commands.list()`；
 * 2. **改键用输入框而不是按钮**：`app/keymap.ts` 的全局分发在**捕获阶段**监听 window，
 *    如果录制控件是一个 `<button>`，用户按下 `Ctrl+S` 的瞬间就会真的触发"保存"。
 *    而分发器明确跳过 `<input>`/`<textarea>`（“输入框里让用户正常打字”），
 *    所以这里的录制控件是**只读 input** —— 既拿到按键，又天然不被全局快捷键抢走；
 * 3. **冲突必须看得见**：同一个键被两条命令占用时，列表顶部给出红字清单，
 *    并区分"真的会撞"（两条 `when` 同时成立）与"互斥视图下的同名键"。
 */

import { useMemo, useState } from 'react'

import { commands, chordFromEvent } from '@/app/commands'
import { Icon } from '@/components/Icon'
import { Select } from '@/components/Select'
import {
  KEYMAP_PROFILES,
  defaultChordsOf,
  formatChord,
  resolveChords,
  type KeymapProfileId,
} from '@/domain/keymap'
import { keymapConflicts } from '@/state/keymap-store'
import { useSettingsStore } from '@/state/settings-store'

/** 不支持录入的组合：纯字母/数字会挡住打字，纯修饰键根本不是一个键位。 */
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift'])

export function KeymapSection() {
  const profile = useSettingsStore((state) => state.keymapProfile)
  const setProfile = useSettingsStore((state) => state.setKeymapProfile)
  const overrides = useSettingsStore((state) => state.keymapOverrides)
  const setBinding = useSettingsStore((state) => state.setKeymapBinding)
  const resetBindings = useSettingsStore((state) => state.resetKeymapBindings)

  const [filter, setFilter] = useState('')
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [rejection, setRejection] = useState<string | null>(null)

  // 命令表在 bootstrap 里注册；这里挂载时快照一次（设置页不会在注册中途打开）
  const [allCommands] = useState(() => commands.list())

  const conflicts = useMemo(() => keymapConflicts(), [profile, overrides])
  const realConflicts = conflicts.filter((conflict) => conflict.real)

  const needle = filter.trim().toLowerCase()
  const visible = needle === ''
    ? allCommands
    : allCommands.filter((command) =>
        `${command.title}${command.category}${command.id}`.toLowerCase().includes(needle),
      )

  return (
    <>
      <h3 className="mn-settings__section-title">键位</h3>
      <p className="mn-settings__section-hint">
        默认表按 QWERTY 人体工学排：高频动作占单修饰键（`Mod+字母`），面板与视图放
        `Mod+Shift+字母`，低频或难逆的动作放 `Mod+Alt+字母`。档案（profile）是一整套心智模型，
        覆盖则精确到每一条命令 —— 两者都写进 Vault 的配置文件，跟着 Vault 走。
      </p>

      {realConflicts.length > 0 && (
        <p className="mn-settings__note mn-settings__note--error" role="alert">
          有 {realConflicts.length} 个键位被多条命令同时占用：
          {realConflicts
            .map((conflict) => `${formatChord(conflict.chord)} → ${conflict.commandIds.join(' / ')}`)
            .join('；')}
          。分发时按"用户覆盖 &gt; 档案 &gt; 默认表"取第一条，其余不会触发。
        </p>
      )}

      <section className="mn-settings__group" aria-labelledby="mn-settings-keymap-profile">
        <h4 className="mn-settings__group-title" id="mn-settings-keymap-profile">
          <Icon name="keyboard" size="sm" />
          档案
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">键位档案</span>
            <span className="mn-settings__row-hint">
              {KEYMAP_PROFILES.find((item) => item.id === profile)?.description ?? ''}
            </span>
          </span>
          <span className="mn-settings__row-control">
            <Select
              label="键位档案"
              value={profile}
              onChange={(next) => setProfile(next as KeymapProfileId)}
              options={KEYMAP_PROFILES.map((item) => ({ value: item.id, label: item.label }))}
            />
          </span>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-keymap-bindings">
        <h4 className="mn-settings__group-title" id="mn-settings-keymap-bindings">
          <Icon name="list" size="sm" />
          逐条覆盖
          <span className="mn-settings__header-spacer" />
          <button type="button" className="mn-button mn-button--ghost" onClick={resetBindings}>
            全部恢复默认
          </button>
        </h4>

        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">过滤命令</span>
            <span className="mn-settings__row-hint">按名称、分类或命令 id 过滤（共 {allCommands.length} 条）</span>
          </span>
          <span className="mn-settings__row-control">
            <input
              type="search"
              className="mn-input"
              aria-label="过滤命令"
              placeholder="例如：加粗 / 搜索 / note.save"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </span>
        </div>

        <ul className="mn-keymap-list">
          {visible.map((command) => (
            <KeymapRow
              key={command.id}
              commandId={command.id}
              title={command.title}
              category={command.category}
              defaultKeybinding={command.keybinding ?? null}
              profile={profile}
              overridden={overrides[command.id] !== undefined}
              recording={recordingId === command.id}
              onStartRecording={() => {
                setRejection(null)
                setRecordingId(command.id)
              }}
              onCancel={() => setRecordingId(null)}
              onCapture={(chord) => {
                setRecordingId(null)
                setRejection(null)
                setBinding(command.id, [chord])
              }}
              onReject={(reason) => setRejection(reason)}
              onUnbind={() => setBinding(command.id, [])}
              onRestore={() => setBinding(command.id, null)}
            />
          ))}
        </ul>

        {rejection !== null && (
          <p className="mn-settings__row-hint" role="status">
            {rejection}
          </p>
        )}
      </section>
    </>
  )
}

interface KeymapRowProps {
  commandId: string
  title: string
  category: string
  /** 命令自带的默认键位（`Command.keybinding`）：只在没有覆盖时展示，供对照。 */
  defaultKeybinding: string | readonly string[] | null
  profile: KeymapProfileId
  overridden: boolean
  recording: boolean
  onStartRecording: () => void
  onCancel: () => void
  onCapture: (chord: string) => void
  onReject: (reason: string) => void
  onUnbind: () => void
  onRestore: () => void
}

function KeymapRow({
  commandId,
  title,
  category,
  defaultKeybinding,
  profile,
  overridden,
  recording,
  onStartRecording,
  onCancel,
  onCapture,
  onReject,
  onUnbind,
  onRestore,
}: KeymapRowProps) {
  const overrides = useSettingsStore((state) => state.keymapOverrides)
  const current = resolveChords({ id: commandId }, profile, overrides)
  const defaultChords = defaultChordsOf({ id: commandId, keybinding: defaultKeybinding ?? undefined })

  return (
    <li className="mn-keymap-row">
      <span className="mn-keymap-row__label">
        <span className="mn-keymap-row__title">{title}</span>
        <span className="mn-keymap-row__meta">
          {category}
          {overridden && <em className="mn-keymap-row__badge">已覆盖</em>}
        </span>
      </span>

      <span className="mn-keymap-row__keys">
        {current.length === 0 ? (
          <span className="mn-keymap-row__empty">（没有键位）</span>
        ) : (
          current.map((chord) => (
            <kbd key={chord} className="mn-keymap-row__kbd">
              {formatChord(chord)}
            </kbd>
          ))
        )}
      </span>

      <span className="mn-keymap-row__actions">
        {recording ? (
          <input
            // 只读 input：全局快捷键分发器会跳过输入框，于是这里能安心录键
            readOnly
            autoFocus
            className="mn-input mn-keymap-row__recorder"
            aria-label={`为「${title}」录制新的组合键`}
            value="按下新的组合键…（Esc 取消）"
            onBlur={onCancel}
            onKeyDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (event.key === 'Escape') {
                onCancel()
                return
              }
              if (MODIFIER_KEYS.has(event.key) || event.key === 'Unidentified') return
              // `chordFromEvent` 要的是 DOM 事件（它读 `key`/`metaKey`/`ctrlKey`…），
              // React 的合成事件与它不同源 —— 用 `nativeEvent` 交给同一个判据
              const chord = chordFromEvent(event.nativeEvent)
              if (chord === '') return
              const hasModifier = chord.includes('Mod') || chord.includes('Alt')
              const isFunctionKey = /^F\d{1,2}$/.test(chord)
              if (!hasModifier && !isFunctionKey) {
                onReject('请至少带上 Ctrl / Alt，或使用功能键（F1–F12）—— 纯字母键会挡住正常打字。')
                return
              }
              onCapture(chord)
            }}
          />
        ) : (
          <>
            <button type="button" className="mn-button mn-button--ghost" onClick={onStartRecording}>
              改键
            </button>
            {overridden ? (
              <>
                <button type="button" className="mn-button mn-button--ghost" onClick={onRestore}>
                  恢复默认
                </button>
                {current.length > 0 && (
                  <button type="button" className="mn-button mn-button--ghost" onClick={onUnbind}>
                    解绑
                  </button>
                )}
              </>
            ) : (
              defaultChords.length > 0 && (
                <span className="mn-keymap-row__default">默认 {formatChord(defaultChords[0] ?? '')}</span>
              )
            )}
          </>
        )}
      </span>
    </li>
  )
}
