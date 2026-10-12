import { useEffect, useState } from 'react'
import { Combobox } from '@base-ui/react/combobox'

import { loadJson, saveJson } from '@/state/persist'
import { useVaultStore } from '@/state/vault-store'

/** 每个属性记住多少个候选（够用且不会把 localStorage 写胖）。 */
const MAX_REMEMBERED = 50

/** 候选值的落盘键：按 Vault 根 + 属性名分开（同名属性在不同 Vault 里取值无关）。 */
function valuesKey(root: string, name: string): string {
  return `mimenote.property.values.v1:${JSON.stringify([root, name])}`
}

/**
 * 「单选」属性的候选值。
 *
 * ## 为什么**不**去问全库
 * 这一栏最初的实现是遍历 Vault 里的每一篇笔记、逐个调 `note_tags` 汇总取值。
 * 它在 4267 篇的真实 Vault 上就是 **4267 次 IPC** —— 宿主每次都要读盘并解析
 * frontmatter，磁盘会被打满十几秒，而这一切只是为了让下拉框多几条候选；
 * 注释当时写的"只读取宿主已有的属性索引"也不成立：索引里只有标签、链接与全文，
 * **任意 frontmatter 字段不在其中**，所以没有"一次问出全库取值"的现成命令。
 *
 * 候选因此来自三个**有界**来源：本篇当前值、这个 Vault 里这个属性用过的值
 * （落 localStorage，上限 {@link MAX_REMEMBERED}）、用户当场输入的新值
 * （列表里显示成 `创建「…」`）。
 *
 * 代价要如实说：**第一次**用某个属性时看不到别处用过的值（用过一次之后就记住了）；
 * 换来的是零 IPC、打开属性面板不碰磁盘。真要"全库取值"应当由宿主在索引里做
 * （或加一条一次扫完的命令），而不是在渲染层循环打 IPC。
 */
export function PropertySelect({ name, value, change }: { name: string; value: string; change: (value: string) => void }) {
  const root = useVaultStore((s) => s.info?.rootPath ?? '')
  const key = valuesKey(root, name)
  const [options, setOptions] = useState<string[]>(() =>
    loadJson<string[]>(key, [], (candidate): candidate is string[] =>
      Array.isArray(candidate) && candidate.every((item) => typeof item === 'string'),
    ),
  )
  const [input, setInput] = useState(value)
  const [open, setOpen] = useState(false)
  useEffect(() => { setInput(value) }, [value])
  // 换 Vault / 换属性名时重新读那一份记忆（同一个组件实例会被复用）
  useEffect(() => {
    setOptions(
      loadJson<string[]>(key, [], (candidate): candidate is string[] =>
        Array.isArray(candidate) && candidate.every((item) => typeof item === 'string'),
      ),
    )
  }, [key])
  const all = [...new Set([value, ...options].filter(Boolean))]
  const query = input.trim()
  const creating = query !== '' && !all.includes(query)
  const items = [...all.filter((item) => item.toLocaleLowerCase().includes(query.toLocaleLowerCase())), ...(creating ? [query] : [])]
  const commit = (next: string) => {
    change(next)
    setInput(next)
    setOptions((old) => {
      const remembered = [...new Set([next, ...old])].slice(0, MAX_REMEMBERED)
      saveJson(key, remembered)
      return remembered
    })
    setOpen(false)
  }
  return <Combobox.Root items={items} filter={null} value={value} inputValue={input} onInputValueChange={setInput} open={open} onOpenChange={setOpen} onValueChange={(next) => { if (next !== null) commit(next) }}>
    <Combobox.Input aria-label={name} className="mn-property-select" placeholder="输入以选择或创建…" onKeyDown={(event) => {
      // 中文输入法组合期间的回车是"选字"，不是"提交"（keyCode 229 是 Safari 的老写法）
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter' && query && !event.currentTarget.getAttribute('aria-activedescendant')) { event.preventDefault(); commit(query) }
    }} />
    <Combobox.Portal><Combobox.Positioner sideOffset={4} className="mn-property-options"><Combobox.Popup>
      <Combobox.List>{(item: string) => <Combobox.Item key={item} value={item} className="mn-property-option">{creating && item === query ? `创建「${item}」` : item}</Combobox.Item>}</Combobox.List>
    </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
  </Combobox.Root>
}
