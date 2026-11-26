import { useEffect, useRef, useState } from 'react';
import { eur, useStore, waitingCases } from '../store';
import { endTour, startTour } from './Tour';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICON = {
  play: 'M5 3.5v9l7-4.5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  soundOn: 'M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5zM10.6 5.8a3.2 3.2 0 0 1 0 4.4M12.4 4a5.8 5.8 0 0 1 0 8',
  soundOff: 'M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5zM10.8 6.4l3 3.2M13.8 6.4l-3 3.2',
};

// A figure that glides to its new value, so a change reads as movement, not a flicker.
function useGlide(target: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 600);
      const v = a + (target - a) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

function Money({ value }: { value: number }) {
  return <>{eur(Math.round(useGlide(value)), 0)}</>;
}

function Metric({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="metric">
      <label>{label}</label>
      <b>{value}</b>
      {note && <em>{note}</em>}
    </div>
  );
}

export function TopBar() {
  const stats = useStore((s) => s.stats);
  const heldNow = useStore((s) => Object.values(s.cases).filter((c) => c.stage === 'hold' && !c.closedAt).length);
  const inCase = useStore((s) => (s.view === 'case' ? s.selected : null));
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const back = useStore((s) => s.back);
  const sound = useStore((s) => s.sound);
  const tour = useStore((s) => s.tour);
  const set = useStore((s) => s.set);
  const cases = useStore((s) => s.cases);
  const open = useStore((s) => s.open);
  const waiting = waitingCases(cases);
  const next = waiting.find((c) => c.id !== inCase) ?? waiting[0];

  return (
    <header className="topbar">
      <button className="brand" onClick={back} title="Back to the live view">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
          <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 1.5v17" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="5.9" cy="10" r="1.7" fill="currentColor" />
        </svg>
        <span>Blackbox</span>
      </button>
      {inCase && (
        <nav className="crumbs">
          <button onClick={back}>Live</button>
          <i>/</i>
          <span className="mono">{inCase}</span>
        </nav>
      )}
      <div className="metrics">
        <Metric label="Guaranteed" value={stats ? <Money value={stats.gmv} /> : '—'} />
        <Metric label="Held in the box" value={String(heldNow)} />
        <Metric label="Stopped before settlement" value={stats ? <Money value={stats.prevented} /> : '—'} />
      </div>
      <div className="controls">
        {waiting.length > 0 && (
          <button className="btn wait" onClick={() => open(next.id)} title="Open the ruling that has waited longest">
            <i />
            {waiting.length === 1 ? '1 ruling is waiting for you' : `${waiting.length} rulings are waiting for you`}
          </button>
        )}
        <button className="btn" onClick={() => (tour ? endTour() : void startTour())}>
          {tour ? 'Stop tour' : 'Guided tour'}
        </button>
        <button className="btn primary" onClick={() => set({ builder: true })}>
          Simulate
        </button>
        <span className="sep" />
        <button className="icon" onClick={() => set({ sound: !sound })} title={sound ? 'Sound on' : 'Sound off'} aria-pressed={sound}>
          <Icon d={sound ? ICON.soundOn : ICON.soundOff} />
        </button>
        <button className="icon" onClick={() => setPaused(!paused)} title={paused ? 'Resume the purchase stream' : 'Pause the purchase stream'}>
          <Icon d={paused ? ICON.play : ICON.pause} />
        </button>
      </div>
    </header>
  );
}
