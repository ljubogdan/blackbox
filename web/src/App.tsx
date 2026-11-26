import { useEffect, useState } from 'react';
import { connect, useStore } from './store';
import { ApprovalBanner, CaseInfo, Inspector, Investigators, ReplayLens, Verdict } from './ui/CasePanels';
import { Engine } from './ui/Engine';
import { LivePanels } from './ui/LivePanels';
import { Builder } from './ui/Builder';
import { TopBar } from './ui/TopBar';
import { TourCaption } from './ui/Tour';
import { CaseScene } from './views/CaseScene';
import { GateScene } from './views/Gate';

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
  // The first seconds after loading: the box and the question alone, then the rest arrives.
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

  const inCase = view === 'case' && !!c;
  return (
    <div className={`app ${engine ? 'engine-open' : ''} ${entering ? 'entering' : ''} ${opening ? 'opening' : ''}`}>
      <TopBar />
      {inCase ? (
        <main className="case-view" key={selected}>
          <div className="stage">
            <CaseScene c={c!} />
            <CaseInfo c={c!} />
            <Inspector c={c!} />
            {c!.status === 'awaiting_approval' ? <ApprovalBanner c={c!} /> : <ReplayLens />}
          </div>
          <section className="dock">
            <Investigators c={c!} />
            <Verdict c={c!} />
          </section>
        </main>
      ) : (
        <>
          <div className="stage live">
            <GateScene />
          </div>
          <LivePanels />
        </>
      )}
      <Engine caseId={inCase ? c!.id : null} />
      <TourCaption />
      {builder && <Builder />}
      {!connected && <div className="offline">Connecting to the engine…</div>}
    </div>
  );
}
