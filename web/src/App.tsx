import { Component, useEffect, useState, type ReactNode } from 'react';
import { canDraw3D, connect, dockOpen, useStore } from './store';
import { ApprovalBanner, CaseInfo, Inspector, Investigators, ReplayLens, Verdict } from './ui/CasePanels';
import { Engine } from './ui/Engine';
import { LivePanels } from './ui/LivePanels';
import { Builder } from './ui/Builder';
import { TopBar } from './ui/TopBar';
import { CaseStage } from './ui/CaseStage';
import { GlobeScene } from './views/Globe';

// Without WebGL (graphics acceleration turned off, or the GPU blocked after a crash) a 3D scene cannot
// start. Everything around it still works, so a scene that cannot run is replaced by a note instead of
// taking the whole page down with it.
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: !canDraw3D };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="no-3d">
        <b>3D is not available in this browser</b>
        <span>Turn on graphics acceleration in the browser's settings and reload. The cases and panels work without it.</span>
      </div>
    );
  }
}

export function App() {
  const view = useStore((s) => s.view);
  const selected = useStore((s) => s.selected);
  const c = useStore((s) => (s.selected ? s.cases[s.selected] : undefined));
  const back = useStore((s) => s.back);
  const connected = useStore((s) => s.connected);
  const builder = useStore((s) => s.builder);
  const engine = useStore((s) => s.engine);
  const entering = useStore((s) => !!s.entering);

  useEffect(() => connect(), []);
  // The first seconds after loading: the scene alone, then the rest arrives.
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setOpening(false), 4200);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (useStore.getState().builder ? useStore.getState().set({ builder: false }) : back());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  const dock = useStore(dockOpen);

  const inCase = view === 'case' && !!c;
  return (
    <div className={`app ${engine ? 'engine-open' : ''} ${entering ? 'entering' : ''} ${opening ? 'opening' : ''}`}>
      <TopBar />
      {inCase ? (
        <main className={`case-view ${dock ? 'dock-open' : ''}`} key={selected}>
          <div className="stage">
            <CaseStage c={c!} />
            <CaseInfo c={c!} />
            <Inspector c={c!} />
            {c!.status === 'awaiting_approval' ? <ApprovalBanner c={c!} /> : <ReplayLens />}
          </div>
          <section className={`dock ${dock ? '' : 'closed'}`}>
            <Investigators c={c!} />
            <Verdict c={c!} />
          </section>
        </main>
      ) : (
        <>
          <div className="stage live"><SceneBoundary>
              <GlobeScene />
            </SceneBoundary></div>
          <LivePanels />
        </>
      )}
      <Engine caseId={inCase ? c!.id : null} />
      {builder && <Builder />}
      {!connected && <div className="offline">Connecting to the engine…</div>}
    </div>
  );
}
