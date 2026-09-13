/** 设置页 · 编辑器分区：自动保存延迟、Tab 宽度。 */

import { Icon } from '@/components/Icon'
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

  return (
    <>
      <h3 className="mn-settings__section-title">编辑器</h3>
      <p className="mn-settings__section-hint">
        这两项是"写盘节奏"和"制表符宽度"，与具体笔记无关，因此跨 Vault 保存。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-autosave-title">
        <h4 className="mn-settings__group-title" id="mn-settings-autosave-title">
          <Icon name="save" size={14} />
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
          <Icon name="columns" size={14} />
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
    </>
  )
}
