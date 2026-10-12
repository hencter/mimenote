/**
 * 收件箱的挂载点：一个组件渲染两层面板（捕获 / 列表）。
 *
 * 为什么合成一个挂载点：Lead 在 `App.tsx` 里只需要加**一行** `<InboxHost />`
 * （与 `<TrashDialog />` 同级），不必让 App 知道收件箱内部有几层；
 * 两层面板共用同一份 store 状态（`inbox-store.panel`），切换也就没有第二个真相。
 */

import { useInboxStore } from '@/state/inbox-store'

import { CaptureDialog } from './CaptureDialog'
import { InboxDialog } from './InboxDialog'

export function InboxHost() {
  const panel = useInboxStore((state) => state.panel)
  if (panel === 'capture') return <CaptureDialog />
  if (panel === 'list') return <InboxDialog />
  return null
}
