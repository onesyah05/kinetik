import React from 'react';

type State = {error: Error | null; stack: string};

/**
 * Shows what went wrong instead of a blank page when the UI crashes, with ways out.
 * Without this, React unmounts everything and only the dark background is left.
 */
export class CrashScreen extends React.Component<{children: React.ReactNode}, State> {
  state: State = {error: null, stack: ''};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[kinetik] UI crashed:', error, info.componentStack);
    this.setState({stack: info.componentStack ?? ''});
  }

  render() {
    const {error, stack} = this.state;
    if (!error) return this.props.children;
    // The message and the components it happened in say the most; the rest is library internals.
    const where = stack
      .trim()
      .split('\n')
      .map((l) => l.trim().replace(/\s*\(http.*\)$/, ''))
      .slice(0, 8)
      .join('\n');
    const first = (error.stack ?? '').split('\n').find((l) => l.includes('/src/')) ?? '';
    const details = `${error.name}: ${error.message}\n${first.trim()}\n\n${where}`;
    return (
      <div className="crash">
        <h1>Kinetik hit an error</h1>
        <p className="faint">Your projects are safe. Reload the page, or go back to the project list.</p>
        <pre>{details}</pre>
        <div className="row" style={{gap: 8}}>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button
            className="btn"
            onClick={() => {
              location.hash = '';
              location.reload();
            }}
          >
            Back to projects
          </button>
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(details)}>
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
