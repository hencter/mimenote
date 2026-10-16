// @vitest-environment jsdom
/** 插件安装确认框：允许 / 拒绝 / Esc 三条路（M4 权限确认 UI）。 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXAMPLE_PLUGIN_MANIFEST } from '@/features/plugins/example'
import { PluginPermissionDialog } from '@/features/plugins/PluginPermissionDialog'

afterEach(() => {
  cleanup()
})

describe('PluginPermissionDialog', () => {
  it('manifest 为空时不渲染', () => {
    const { container } = render(
      <PluginPermissionDialog manifest={null} onAllow={() => {}} onDeny={() => {}} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('展示插件身份与权限说明，点允许/取消走对应回调', () => {
    const onAllow = vi.fn()
    const onDeny = vi.fn()
    render(<PluginPermissionDialog manifest={EXAMPLE_PLUGIN_MANIFEST} onAllow={onAllow} onDeny={onDeny} />)

    expect(screen.getByText(/安装插件/)).not.toBeNull()
    expect(screen.getByText(/注册命令/)).not.toBeNull()

    fireEvent.click(screen.getByText('允许并安装'))
    expect(onAllow).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('取消'))
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('Esc 视为拒绝', () => {
    const onDeny = vi.fn()
    render(
      <PluginPermissionDialog manifest={EXAMPLE_PLUGIN_MANIFEST} onAllow={() => {}} onDeny={onDeny} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDeny).toHaveBeenCalledTimes(1)
  })
})
