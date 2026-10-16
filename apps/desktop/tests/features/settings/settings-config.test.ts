/**
 * 偏好值 ↔ 配置文档（`state/settings-store.ts` 的 `configDocumentOf` / `applyConfigDocument`，ADR-0055）。
 *
 * 这两条函数是"配置文件是真相"的全部实现，因此最要紧的一条断言是**往返一致**：
 * `apply(documentOf(v)) === v`。它一旦不成立，用户就会遇到"我明明写进文件了，
 * 打开应用却是另一个值"，而且没有任何报错 —— 这是这类分层最典型的静默故障。
 *
 * 其余用例覆盖三条防线：
 * - `version` 比应用新 → **只读**，并且给出一条能读懂的原因；
 * - 字段类型不对 → 回退默认值 + 逐条列出问题（绝不静默吞掉）；
 * - 目录类字段 → 归一化（`./Inbox//` → `Inbox`），空值回落到默认（收件箱不能没有落点）。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  applyConfigDocument,
  configDocumentOf,
  normalizeVaultDir,
  type SettingsValues,
} from '@/state/settings-store'
import { CONFIG_SCHEMA_VERSION } from '@/domain/config-file'

const CUSTOM: SettingsValues = {
  ...DEFAULT_SETTINGS,
  uiFontSize: 15,
  editorFontSize: 18,
  readingFontSize: 20,
  autosaveDelayMs: 1000,
  tabWidth: 2,
  editorLineNumbers: false,
  attachmentDir: '附件/粘贴',
  frontmatterTimestamps: true,
  treeLayout: 'columns',
  inboxDir: '收件箱',
  templatesDir: '模板',
  keymapProfile: 'obsidian',
  keymapOverrides: {
    'note.save': ['Mod+Alt+S'],
    'note.delete': [],
  },
}

describe('配置文档的形状', () => {
  it('带上 schema 版本，且键位覆盖按命令 id 排序（diff 只反映值的变化）', () => {
    const document = configDocumentOf(CUSTOM)
    expect(document['version']).toBe(CONFIG_SCHEMA_VERSION)

    const keymap = document['keymap'] as { profile: string; bindings: { command: string }[] }
    expect(keymap.profile).toBe('obsidian')
    expect(keymap.bindings.map((entry) => entry.command)).toEqual(['note.delete', 'note.save'])
  })

  it('每个分组与代码里的字段一一对应（不发明第二套命名）', () => {
    const document = configDocumentOf(DEFAULT_SETTINGS)
    expect(Object.keys(document).sort()).toEqual([
      'editor',
      'inbox',
      'keymap',
      'templates',
      'tree',
      'ui',
      'vault',
      'version',
    ])
    expect(document['tree']).toEqual({ layout: 'single' })
    expect(document['inbox']).toEqual({ dir: 'Inbox' })
  })
})

describe('往返一致', () => {
  it('apply(documentOf(v)) 逐字段等于 v', () => {
    const applied = applyConfigDocument(configDocumentOf(CUSTOM))
    expect(applied.issues).toEqual([])
    expect(applied.versionNewer).toBe(false)
    expect(applied.values).toEqual(CUSTOM)
  })

  it('默认值同样往返一致（默认值不会在第一次写盘时被改写）', () => {
    const applied = applyConfigDocument(configDocumentOf(DEFAULT_SETTINGS))
    expect(applied.values).toEqual(DEFAULT_SETTINGS)
  })
})

describe('版本比应用新 → 只读', () => {
  it('给出原因，并标记 versionNewer', () => {
    const applied = applyConfigDocument({ version: CONFIG_SCHEMA_VERSION + 1 })
    expect(applied.versionNewer).toBe(true)
    expect(applied.issues.join()).toContain('只读')
  })

  it('version 不是数字时如实报告，但不算"更新"', () => {
    const applied = applyConfigDocument({ version: 'v1' })
    expect(applied.versionNewer).toBe(false)
    expect(applied.issues.join()).toContain('version 应当是数字')
  })
})

describe('字段类型不对：回退默认 + 逐条报告', () => {
  it('数值/布尔/字符串三类错误都被点出来', () => {
    const applied = applyConfigDocument({
      ui: { fontSize: 'big' },
      editor: { tabWidth: true },
      inbox: { dir: 42 },
    })
    expect(applied.values.uiFontSize).toBe(DEFAULT_SETTINGS.uiFontSize)
    expect(applied.values.tabWidth).toBe(DEFAULT_SETTINGS.tabWidth)
    expect(applied.values.inboxDir).toBe(DEFAULT_SETTINGS.inboxDir)
    expect(applied.issues.join()).toContain('ui.fontSize')
    expect(applied.issues.join()).toContain('editor.tabWidth')
    expect(applied.issues.join()).toContain('inbox.dir')
  })

  it('取值超出档位 → 吸附到最近档位（下拉框不会显示成空选中）', () => {
    const applied = applyConfigDocument({ editor: { autosaveDelayMs: 900 } })
    expect(applied.values.autosaveDelayMs).toBe(1000)
    const font = applyConfigDocument({ ui: { fontSize: 999 } })
    expect(font.values.uiFontSize).toBe(18)
  })

  it('未知键被忽略（向前兼容），不产生 issue、不影响其它字段', () => {
    const applied = applyConfigDocument({ version: 1, future: { x: 1 }, ui: { fontSize: 14 } })
    expect(applied.issues).toEqual([])
    expect(applied.values.uiFontSize).toBe(14)
  })
})

describe('键位绑定的两种写法', () => {
  it('规范写法（表数组）能被读回', () => {
    const applied = applyConfigDocument({
      keymap: {
        profile: 'vscode',
        bindings: [
          { command: 'note.save', chords: ['Mod+S'] },
          { command: 'note.delete', chords: [] },
        ],
      },
    })
    expect(applied.values.keymapProfile).toBe('vscode')
    expect(applied.values.keymapOverrides).toEqual({ 'note.save': ['Mod+S'], 'note.delete': [] })
    expect(applied.issues).toEqual([])
  })

  it('顺手写法（映射）也能读回；非法条目被点出来', () => {
    const applied = applyConfigDocument({
      keymap: { bindings: { 'note.save': 'Mod+S', 'note.move': 42 } },
    })
    expect(applied.values.keymapOverrides).toEqual({ 'note.save': ['Mod+S'] })
    expect(applied.issues.join()).toContain('1 条格式不对')
  })

  it('profile 不是三个已知值之一 → 用默认并说明', () => {
    const applied = applyConfigDocument({ keymap: { profile: 'emacs' } })
    expect(applied.values.keymapProfile).toBe(DEFAULT_SETTINGS.keymapProfile)
    expect(applied.issues.join()).toContain('keymap.profile')
  })
})

describe('目录类字段的归一化', () => {
  it('去掉前导 ./、重复分隔符与结尾斜杠', () => {
    expect(normalizeVaultDir(' ./附件//粘贴/ ')).toBe('附件/粘贴')
    expect(normalizeVaultDir('\\收件箱\\')).toBe('收件箱')
    expect(normalizeVaultDir('')).toBe('')
  })

  it('收件箱/模板目录不接受空值（必须有落点），回落到默认', () => {
    const applied = applyConfigDocument({ inbox: { dir: '   ' }, templates: { dir: '' } })
    expect(applied.values.inboxDir).toBe(DEFAULT_SETTINGS.inboxDir)
    expect(applied.values.templatesDir).toBe(DEFAULT_SETTINGS.templatesDir)
  })

  it('附件目录允许空串（= Vault 根），不回落默认', () => {
    const applied = applyConfigDocument({ vault: { attachmentDir: '' } })
    expect(applied.values.attachmentDir).toBe('')
  })
})
