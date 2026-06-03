import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Catches render-time throws in one module so a single bad event/record shows a
 * recoverable panel instead of unmounting the whole app to a blank screen.
 * Keyed by the active view in App, so switching tabs resets it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[orbit-station] module crashed:', err, info.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div className="empty">
          <p>⚠ This panel hit an error and stopped rendering.</p>
          <pre className="mono sm">{this.state.err.message}</pre>
          <button className="pill acc" onClick={() => this.setState({ err: null })}>retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
