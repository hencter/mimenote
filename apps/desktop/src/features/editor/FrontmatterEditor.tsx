import { useEffect, useRef, useState } from 'react'
import {
  editMetadataField,
  metadataBlock,
  parseMetadata,
  renameMetadata,
  reorderMetadata,
  replaceMetadata,
  serializeMetadata,
  tomlHasComment,
  type MetadataBlock,
  type MetadataFormat,
} from '@/domain/frontmatter-edit'
import { Icon } from '@/components/Icon'
import { Select } from '@/components/Select'
import { saveJson } from '@/state/persist'
import { useVaultStore } from '@/state/vault-store'
import {
  PROPERTY_ICONS,
  PROPERTY_TYPES,
  PropertyInput,
  coerceDraftValue,
  type PropertyType,
} from './PropertyInput'
import './frontmatter-editor.css'

export function FrontmatterEditor({
  read,
  apply,
  seed,
}: {
  read: () => string
  apply: (text: string) => void
  /**
   * 文档**这一版**的 frontmatter 区块（`null` = 这篇没有合法区块）。
   *
   * 为什么要有这个 prop：非当前分栏的正文是**挂载之后**才异步读到的，挂载那一刻编辑器里
   * 可能还是空的 —— 只看挂载瞬间的话，从"没有 frontmatter 的笔记"切回"有 frontmatter 的笔记"
   * 时面板会停在**折叠态**（真实 Edge 探针实测 `collapsedOnReturn = true`）。
   * 不传 = 退回"挂载时从编辑器里读一次"的旧形态（单测直接这么用）。
   */
  seed?: MetadataBlock | null
}) {
  const [mountSeed] = useState<MetadataBlock | null>(() =>
    seed !== undefined ? seed : metadataBlock(read()),
  )
  const [open, setOpen] = useState(() => mountSeed !== null)
  const [source, setSource] = useState(() => mountSeed?.source ?? '')
  const [format, setFormat] = useState<MetadataFormat>(() => mountSeed?.format ?? 'yaml')
  const [error, setError] = useState('')
  const [key, setKey] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftType, setDraftType] = useState<PropertyType>('text')
  const [draftValue, setDraftValue] = useState('')
  const vaultRoot = useVaultStore((state) => state.info?.rootPath ?? '')
  /**
   * 用户主动收起过面板：这一版文档不再自动展开。
   * 换笔记会重建组件（`key`），于是它天然复位 —— 不必自己记路径。
   */
  const dismissed = useRef(false)
  // 这一版文档变了（换笔记 / 外部重新加载 / 分栏异步读到正文）：面板跟着它走。
  useEffect(() => {
    if (seed === undefined) return
    setSource(seed?.source ?? '')
    setFormat(seed?.format ?? 'yaml')
    setError('')
    if (seed !== null && !dismissed.current) setOpen(true)
  }, [seed])
  // 旧形态（没有 seed 的调用方）：挂载时读一次即可。
  useEffect(() => {
    if (seed !== undefined) return
    setSource(mountSeed?.source ?? '')
    setFormat(mountSeed?.format ?? 'yaml')
  }, [mountSeed, seed])
  let data: Record<string, unknown> = {}
  let parseError = ''
  try {
    data = parseMetadata(source, format)
  } catch (cause) {
    parseError = String(cause)
  }
  const change = (name: string, value: unknown, remove = false) => {
    try {
      const text = read()
      const block = metadataBlock(text)
      const next = editMetadataField(
        block?.source ?? '',
        block?.format ?? format,
        name,
        value,
        remove,
      )
      apply(replaceMetadata(text, next, block?.format ?? format))
      setSource(next)
      setError('')
      return true
    } catch (cause) {
      setError(String(cause))
      return false
    }
  }
  const commitDraft = (): boolean => {
    const name = key.trim()
    if (!name) return false
    if (Object.hasOwn(data, name)) {
      setError('属性名称已存在')
      return false
    }
    const value = coerceDraftValue(draftType, draftValue)
    if (!change(name, value)) return false
    saveJson(`mimenote.property.config.v1:${JSON.stringify([vaultRoot, name])}`, {
      type: draftType,
      options: draftType === 'single' && draftValue.trim() !== '' ? [draftValue.trim()] : [],
    })
    setAdding(false)
    setKey('')
    setDraftValue('')
    setDraftType('text')
    return true
  }
  return (
    <div className="mn-metadata">
      <div className="mn-metadata__toolbar">
        <button
          type="button"
          className="mn-metadata__toggle"
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              const block = seed !== undefined ? seed : metadataBlock(read())
              setSource(block?.source ?? '')
              setFormat(block?.format ?? 'yaml')
              setError('')
            }
            // 用户主动收起 = 这一版文档别再无谓地自动展开；手动展开则把这面旗放回去
            dismissed.current = open
            setOpen(!open)
          }}
        >
          <Icon
            name="chevron"
            size="xs"
            className={`mn-metadata__chevron${open ? ' mn-metadata__chevron--open' : ''}`}
          />
          笔记属性
        </button>
        {open && (
          <Select
            label="Frontmatter 格式"
            value={format}
            options={[
              { value: 'yaml', label: 'YAML' },
              { value: 'toml', label: 'TOML' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={(value) => {
              const next = value as MetadataFormat
              try {
                const text = read()
                const block = metadataBlock(text)
                if (block && tomlHasComment(block.source)) {
                  throw new Error('格式转换可能丢失注释，请先在源码中处理注释。')
                }
                const converted = serializeMetadata(
                  parseMetadata(block?.source ?? '', block?.format ?? format),
                  next,
                )
                apply(replaceMetadata(text, converted, next))
                setSource(converted)
                setFormat(next)
                setError('')
              } catch (cause) {
                setError(String(cause))
              }
            }}
          />
        )}
      </div>
      {open && (
        <div className="mn-metadata__panel">
          {!parseError && (
            <div className="mn-metadata__fields">
              {Object.entries(data).map(([name, value]) => (
                <PropertyInput
                  key={name}
                  name={name}
                  value={value}
                  change={(nextValue) => change(name, nextValue)}
                  rename={(nextName) => {
                    try {
                      const text = read()
                      const block = metadataBlock(text)
                      if (!block) return false
                      const next = renameMetadata(block.source, block.format, name, nextName)
                      apply(replaceMetadata(text, next, block.format))
                      setSource(next)
                      setError('')
                      return true
                    } catch (cause) {
                      setError(String(cause))
                      return false
                    }
                  }}
                  reorder={(from, before) => {
                    try {
                      const text = read()
                      const block = metadataBlock(text)
                      if (!block) return
                      const next = reorderMetadata(block.source, block.format, from, before)
                      apply(replaceMetadata(text, next, block.format))
                      setSource(next)
                      setError('')
                    } catch (cause) {
                      setError(String(cause))
                    }
                  }}
                />
              ))}
              {adding && (
                <div className="mn-metadata__row mn-metadata__draft">
                  <div className="mn-metadata__type" title="选择属性类型">
                    <Select
                      label="新属性类型"
                      value={draftType}
                      icon={PROPERTY_ICONS[draftType]}
                      options={Object.entries(PROPERTY_TYPES).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                      onChange={(next) => {
                        setDraftType(next as PropertyType)
                        setDraftValue(next === 'boolean' ? 'false' : '')
                      }}
                    />
                  </div>
                  <input
                    autoFocus
                    aria-label="新属性名称"
                    placeholder="属性名称"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onBlur={() => {
                      commitDraft()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                      if (e.key === 'Escape') setAdding(false)
                    }}
                  />
                  {draftType === 'boolean' ? (
                    <input
                      aria-label="新属性值"
                      type="checkbox"
                      checked={draftValue === 'true'}
                      onChange={(e) => setDraftValue(e.target.checked ? 'true' : 'false')}
                    />
                  ) : (
                    <input
                      aria-label="新属性值"
                      placeholder="值"
                      type={
                        draftType === 'datetime'
                          ? 'datetime-local'
                          : draftType === 'number'
                            ? 'number'
                            : draftType === 'date'
                              ? 'date'
                              : draftType === 'url'
                                ? 'url'
                                : draftType === 'email'
                                  ? 'email'
                                  : 'text'
                      }
                      step={draftType === 'number' ? 'any' : draftType === 'datetime' ? '1' : undefined}
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing && key.trim()) {
                          e.preventDefault()
                          commitDraft()
                        }
                      }}
                    />
                  )}
                  <button
                    type="button"
                    aria-label="取消添加属性"
                    className="mn-metadata__icon-btn"
                    onClick={() => setAdding(false)}
                  >
                    <Icon name="x" size="sm" />
                  </button>
                </div>
              )}
              <button
                type="button"
                aria-label="添加笔记属性"
                className="mn-metadata__add-trigger"
                onClick={() => {
                  setAdding(true)
                  setKey('')
                  setDraftValue('')
                  setDraftType('text')
                }}
              >
                ＋ 添加笔记属性
              </button>
            </div>
          )}
          {(error || parseError) && <p role="alert">{error || parseError}</p>}
        </div>
      )}
    </div>
  )
}
