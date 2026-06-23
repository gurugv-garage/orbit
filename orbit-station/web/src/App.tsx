import { useEffect, useState } from 'react';
import { useConnected } from './lib/useStation';
import { DockStatus } from './components/DockStatus';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Overview } from './modules/Overview';
import { Docks } from './modules/Docks';
import { Observability } from './modules/Observability';
import { Brain } from './modules/Brain';
import { Tasks } from './modules/Tasks';
import { Skills } from './modules/Skills';
import { Config } from './modules/Config';
import { BodyLink } from './modules/BodyLink';
import { Bench } from './modules/Bench';
import { Ota } from './modules/Ota';
import { Perception } from './modules/Perception';
import { Memory } from './modules/Memory';
import { Capture } from './modules/Capture';
import { Cost } from './modules/Cost';
import { Feedback } from './modules/Feedback';

interface ViewDef { id: string; label: string; ico: string; el: React.ReactNode; }

const VIEWS: ViewDef[] = [
  { id: 'overview', label: 'Overview', ico: '◎', el: <Overview /> },
  { id: 'docks', label: 'Docks', ico: '🛰', el: <Docks /> },
  { id: 'observability', label: 'Observability', ico: '📡', el: <Observability /> },
  { id: 'cost', label: 'Cost', ico: '💰', el: <Cost /> },
  { id: 'brain', label: 'Brain', ico: '🗣', el: <Brain /> },
  { id: 'tasks', label: 'Tasks', ico: '⏱', el: <Tasks /> },
  { id: 'skills', label: 'Skills', ico: '🧩', el: <Skills /> },
  { id: 'config', label: 'Config', ico: '⚙', el: <Config /> },
  { id: 'bodylink', label: 'Body', ico: '🦾', el: <BodyLink /> },
  { id: 'perception', label: 'Perception', ico: '🧠', el: <Perception /> },
  { id: 'capture', label: 'Capture', ico: '⏺', el: <Capture /> },
  { id: 'memory', label: 'Memory', ico: '🗃', el: <Memory /> },
  { id: 'feedback', label: 'Feedback', ico: '💬', el: <Feedback /> },
  { id: 'ota', label: 'Updates', ico: '⬆', el: <Ota /> },
  { id: 'bench', label: 'Benchmarks', ico: '📊', el: <Bench /> },
];

function currentHash(): string {
  // tolerate a `?query` suffix on the hash (views may persist filters there,
  // e.g. #cost?window=7d&group=usecase) — route on the bare view id only.
  const h = location.hash.replace('#', '').split('?')[0] ?? '';
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
