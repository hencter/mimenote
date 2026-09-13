/** localStorage 读写（带类型守卫与异常兜底；Node 测试环境自动降级为内存）。 */

const memoryFallback = new Map<string, string>()

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // 隐私模式/权限受限时可能抛异常
  }
  return null
}

export function loadString(key: string): string | null {
  const store = storage()
  if (store === null) return memoryFallback.get(key) ?? null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

export function saveString(key: string, value: string): void {
  const store = storage()
  if (store === null) {
    memoryFallback.set(key, value)
    return
  }
  try {
    store.setItem(key, value)
  } catch {
    memoryFallback.set(key, value)
  }
}

export function removeKey(key: string): void {
  memoryFallback.delete(key)
  const store = storage()
  try {
    store?.removeItem(key)
  } catch {
    // 忽略
  }
}

/** 读取 JSON；解析失败或校验不通过时回退默认值。 */
export function loadJson<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  const raw = loadString(key)
  if (raw === null) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (validate !== undefined && !validate(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    saveString(key, JSON.stringify(value))
  } catch {
    // 循环引用等异常：忽略持久化失败，不影响主流程
  }
}
