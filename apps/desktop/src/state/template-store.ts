/**
 * 模板列表与「从模板新建」的**界面状态**。
 *
 * ## 为什么单独一个 store
 * 选择对话框是应用级的（命令面板 / 快捷键 / 将来的菜单都能打开它），"开着、列着什么、
 * 选中哪一条"因此不能活在某个组件的 state 里 —— 与 `trash-store` / `move-store` 的
 * 理由一致。真正的创建编排在 `features/template/from-template.ts`（那一步要碰
 * `note-store` / 编辑器，不属于状态层）。
 *
 * ## 清单从哪来（以及为什么不读条目表）
 * `vault-store` 的条目表里**没有**模板文件：`.mimenote/` 被扫描器忽略
 * （`mn-core` 的 `ScanOptions.ignore_dir_names`），而这是刻意的 —— 模板不该出现在文件树、
 * 索引与搜索里。所以清单走宿主命令 `templates_list`（与 `.mimenote/snippets` 的
 * `snippets_list` 同构的"应用私有目录里的某一类文件"接口）。
 *
 * 目录名来自设置项 `templatesDir`（设置页可改，也能被 Vault 配置文件里的
 * `templates.dir` 覆盖）—— **只读它**，写入与归一化是设置层的职责。
 *
 * ## 空态即真相
 * 目录不存在时宿主返回空数组（不是错误），因此"还没有模板"与"读不出来"在界面上是
 * 两句话：前者是正常状态，后者带 `error`（对话框把原因照实写出来，而不是转圈）。
 */

import { create } from 'zustand'

import { displayName } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'
import type { TemplateFile } from '@/ipc/types'

import { DEFAULT_TEMPLATES_DIR, useSettingsStore } from './settings-store'

/** 清单的加载状态。 */
export type TemplateListStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface TemplateState {
  /** 选择对话框是否打开（不持久化：重启后不该自己弹出一层模态）。 */
  open: boolean
  /** 当前生效的模板目录（Vault 相对，已在 `openPicker` 里归一化）。 */
  dir: string
  status: TemplateListStatus
  /** 模板清单（宿主已按文件名升序返回）。 */
  templates: TemplateFile[]
  /** 读取失败的原因（目录不存在**不是**错误，清单为空即可）。 */
  error: MimenoteError | null
  /** 用户在列表里选中的那一条（对话框回显用；切换模板时清掉）。 */
  selected: string | null

  /** 打开选择对话框（顺手拉一次清单）。不传目录时用设置里的 `templatesDir`。 */
  openPicker: (dir?: string) => Promise<void>
  closePicker: () => void
  /** 重新拉一次清单（L 键 / 用户刚在磁盘上放了模板文件）。 */
  refresh: () => Promise<void>
  select: (relPath: string | null) => void
}

/**
 * 模板的**显示标题**：与 `@title` / 命令面板同口径 —— `displayName`（笔记去扩展名，
 * 见 ADR-0030）。不要在别处再写一次 `replace(/\.md$/)`。
 */
export function templateTitle(file: TemplateFile): string {
  return displayName(file.relPath)
}

/** 目录名的兜底：设置里读到空串时回到默认模板目录。 */
function resolveDir(dir: string | undefined): string {
  const candidate = dir ?? useSettingsStore.getState().templatesDir
  return candidate === '' ? DEFAULT_TEMPLATES_DIR : candidate
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  open: false,
  dir: DEFAULT_TEMPLATES_DIR,
  status: 'idle',
  templates: [],
  error: null,
  selected: null,

  openPicker: async (dir) => {
    set({ open: true, dir: resolveDir(dir), selected: null })
    await get().refresh()
  },

  closePicker: () => {
    // 不清 `templates`：下次打开先用旧清单渲染一帧（不闪空白），拉回来再替换
    set({ open: false })
  },

  refresh: async () => {
    const dir = get().dir
    set({ status: 'loading', error: null })
    try {
      const templates = await ipc.templatesList(dir)
      // 目录在这一轮里被改过（用户又开了一次对话框）：丢掉过期结果
      if (get().dir !== dir) return
      set({ status: 'ready', templates, error: null })
    } catch (cause) {
      if (get().dir !== dir) return
      set({ status: 'error', templates: [], error: MimenoteError.from(cause) })
    }
  },

  select: (selected) => set({ selected }),
}))
