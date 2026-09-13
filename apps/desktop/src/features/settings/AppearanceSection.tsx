/** 设置页 · 外观分区：主题、界面字号、编辑器字号。 */

import { Icon } from '@/components/Icon'
import {
  DEFAULT_SETTINGS,
  EDITOR_FONT_SIZE_RANGE,
  UI_FONT_SIZE_RANGE,
  useSettingsStore,
} from '@/state/settings-store'
import { useUiStore } from '@/state/ui-store'
import { THEMES } from '@/theme/apply'

export function AppearanceSection() {
  const themeId = useUiStore((state) => state.themeId)
  const setThemeId = useUiStore((state) => state.setThemeId)
  const uiFontSize = useSettingsStore((state) => state.uiFontSize)
  const editorFontSize = useSettingsStore((state) => state.editorFontSize)
  const setUiFontSize = useSettingsStore((state) => state.setUiFontSize)
  const setEditorFontSize = useSettingsStore((state) => state.setEditorFontSize)
  const resetFontSizes = useSettingsStore((state) => state.resetFontSizes)

  return (
    <>
      <h3 className="mn-settings__section-title">外观</h3>
      <p className="mn-settings__section-hint">
        主题与字号都是即时生效的：主题写 CSS 变量，字号也写 CSS 变量 —— 浏览器只做一次样式重算，
        编辑器实例（光标位置、撤销历史）不受影响。
      </p>

      <section className="mn-settings__group" aria-labelledby="mn-settings-theme-title">
        <h4 className="mn-settings__group-title" id="mn-settings-theme-title">
          <Icon name="palette" size={14} />
          主题
        </h4>
        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">配色主题</span>
            <span className="mn-settings__row-hint">
              颜色、圆角、阴影全部来自主题令牌，编辑器与预览同步跟随
            </span>
          </span>
          <label className="mn-settings__row-control">
            <span className="mn-visually-hidden">配色主题</span>
            <select
              className="mn-settings__select"
              aria-label="配色主题"
              value={themeId}
              onChange={(event) => setThemeId(event.target.value)}
            >
              {THEMES.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                  {theme.appearance === 'light' ? '（浅色）' : '（深色）'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="mn-settings__group" aria-labelledby="mn-settings-font-title">
        <h4 className="mn-settings__group-title" id="mn-settings-font-title">
          <Icon name="type" size={14} />
          字号
        </h4>

        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">界面字号</span>
            <span className="mn-settings__row-hint">
              除编辑区之外的所有文字：状态栏、面板、按钮（CSS 变量{' '}
              <code className="mn-settings__path">--mn-font-size-ui</code>）
            </span>
          </span>
          <span className="mn-settings__row-control">
            <input
              className="mn-settings__range"
              type="range"
              aria-label="界面字号"
              min={UI_FONT_SIZE_RANGE.min}
              max={UI_FONT_SIZE_RANGE.max}
              step={UI_FONT_SIZE_RANGE.step}
              value={uiFontSize}
              onChange={(event) => setUiFontSize(Number(event.target.value))}
            />
            <span className="mn-settings__value">{uiFontSize}px</span>
          </span>
        </div>

        <div className="mn-settings__row">
          <span className="mn-settings__row-label">
            <span className="mn-settings__row-title">编辑器字号</span>
            <span className="mn-settings__row-hint">
              编辑区与预览正文（CSS 变量{' '}
              <code className="mn-settings__path">--mn-font-size-editor</code>）；改它不会重建编辑器
            </span>
          </span>
          <span className="mn-settings__row-control">
            <input
              className="mn-settings__range"
              type="range"
              aria-label="编辑器字号"
              min={EDITOR_FONT_SIZE_RANGE.min}
              max={EDITOR_FONT_SIZE_RANGE.max}
              step={EDITOR_FONT_SIZE_RANGE.step}
              value={editorFontSize}
              onChange={(event) => setEditorFontSize(Number(event.target.value))}
            />
            <span className="mn-settings__value">{editorFontSize}px</span>
          </span>
        </div>

        <div className="mn-settings__actions">
          <button
            type="button"
            className="mn-button"
            aria-label="恢复默认字号"
            disabled={
              uiFontSize === DEFAULT_SETTINGS.uiFontSize &&
              editorFontSize === DEFAULT_SETTINGS.editorFontSize
            }
            onClick={resetFontSizes}
          >
            <Icon name="refresh" size={13} />
            恢复默认字号
          </button>
        </div>
      </section>
    </>
  )
}
