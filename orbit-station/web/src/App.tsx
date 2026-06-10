import { useEffect, useState } from 'react';
import { useConnected } from './lib/useStation';
import { DockStatus } from './components/DockStatus';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Overview } from './modules/Overview';
import { Observability } from './modules/Observability';
import { Config } from './modules/Config';
import { BodyLink } from './modules/BodyLink';
import { Mind } from './modules/Mind';
import { Bench } from './modules/Bench';
import { Ota } from './modules/Ota';
import { LiveStream } from './modules/LiveStream';

interface ViewDef { id: string; label: string; ico: string; el: React.ReactNode; }

const VIEWS: ViewDef[] = [
  { id: 'overview', label: 'Overview', ico: '◎', el: <Overview /> },
  { id: 'observability', label: 'Observability', ico: '📡', el: <Observability /> },
  { id: 'config', label: 'Config', ico: '⚙', el: <Config /> },
  { id: 'bodylink', label: 'BodyLink', ico: '🦾', el: <BodyLink /> },
  { id: 'live', label: 'Live', ico: '📹', el: <LiveStream /> },
  { id: 'ota', label: 'Updates', ico: '⬆', el: <Ota /> },
  { id: 'mind', label: 'Mind', ico: '✦', el: <Mind /> },
  { id: 'bench', label: 'Benchmarks', ico: '📊', el: <Bench /> },
];

function currentHash(): string {
  const h = location.hash.replace('#', '');
  return VIEWS.some((v) => v.id === h) ? h : 'overview';
}

export function App() {
  const [view, setView] = useState(currentHash());
  const [navOpen, setNavOpen] = useState(false);
  const connected = useConnected();

  useEffect(() => {
    const onHash = () => setView(currentHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (id: string) => {
    location.hash = id;
    setNavOpen(false);
  };

  return (
    <>
      <div className="stars" />
      <button className="menu-btn" aria-label="menu" onClick={() => setNavOpen((o) => !o)}>☰</button>
      <div className={`app${navOpen ? ' nav-open' : ''}`}>
        <nav className="side">
          <div className="brand">
            <span className="orb" />
            <div><h1>orbit&nbsp;station</h1><small>mission control</small></div>
          </div>
          <ul className="navlist">
            {VIEWS.map((v) => (
              <li key={v.id}>
                <button className={v.id === view ? 'active' : ''} onClick={() => go(v.id)}>
                  <span className="ico">{v.ico}</span> {v.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="side-docks-wrap">
            <div className="side-section-label">Docks</div>
            <DockStatus />
          </div>
          <div className="side-foot">
            <span className={`dot ${connected ? 'on' : 'off'}`} />
            {connected ? 'connected' : 'reconnecting…'}
          </div>
        </nav>
        <div className="scrim" onClick={() => setNavOpen(false)} />
        <main>
          <ErrorBoundary key={view}>{VIEWS.find((v) => v.id === view)?.el}</ErrorBoundary>
        </main>
      </div>
    </>
  );
}
