import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * 沒有 boundary 時，任何 render 例外都會讓整個視窗變成空白，
 * 使用者只能重開且拿不到任何線索。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: `${error.stack ?? error.message}\n${info.componentStack ?? ''}` });
    console.error('[cozypad] render error:', error, info);
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash-screen">
        <h2>介面發生錯誤</h2>
        <p className="hint">
          這是 CozyPad 的問題，不是你的操作造成的。連線與遠端 session 不受影響。
        </p>
        <pre className="command-block">{stack || error.message}</pre>
        <div className="form-actions">
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(stack || error.message).catch(() => undefined);
            }}
          >
            複製錯誤訊息
          </button>
          <button className="primary" onClick={() => this.setState({ error: null, stack: '' })}>
            嘗試復原
          </button>
          <button onClick={() => window.location.reload()}>重新載入</button>
        </div>
      </div>
    );
  }
}
