/**
 * 顶层错误边界：任何渲染期异常都不拖垮整个应用。
 *
 * M4 的插件系统会复用同样的思路（每个插件一棵独立的边界树）。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 渲染异常：', error, info.componentStack)
    this.setState({ info: info.componentStack ?? null })
  }

  private readonly handleReload = (): void => {
    window.location.reload()
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null, info: null })
  }

  override render(): ReactNode {
    const { error, info } = this.state
    if (error === null) return this.props.children

    return (
      <div className="mn-crash">
        <h1>界面出错了</h1>
        <p className="mn-crash__message">{error.message}</p>
        <p className="mn-crash__hint">
          你的笔记文件没有受到影响（编辑内容可能尚未保存）。可以尝试恢复界面；若再次失败，请把下面的堆栈反馈给开发者。
        </p>
        <div className="mn-crash__actions">
          <button type="button" className="mn-button mn-button--primary" onClick={this.handleReload}>
            重新加载界面
          </button>
          <button type="button" className="mn-button" onClick={this.handleReset}>
            仅重置错误状态
          </button>
        </div>
        {info !== null && <pre className="mn-crash__stack">{info}</pre>}
        <pre className="mn-crash__stack">{error.stack ?? ''}</pre>
      </div>
    )
  }
}
