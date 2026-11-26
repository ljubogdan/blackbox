import { eur, useStore } from '../store';
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

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
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
      <nav className="crumbs">
        {inCase ? (
          <>
            <button onClick={back}>Live</button>
            <i>/</i>
            <span className="mono">{inCase}</span>
          </>
        ) : (
          <span>The guarantee for purchases made by AI agents</span>
        )}
      </nav>
      <div className="metrics">
        <Metric label="Guaranteed" value={stats ? eur(stats.gmv, 0) : '—'} note={stats ? `${stats.purchases.toLocaleString('en-GB')} purchases` : undefined} />
        <Metric label="Held in the box" value={String(heldNow)} note="right now" />
        <Metric label="Stopped before settlement" value={stats ? eur(stats.prevented, 0) : '—'} note={stats ? `${stats.blocked} blocked` : undefined} />
      </div>
      <div className="controls">
        <button className="btn" onClick={() => (tour ? endTour() : void startTour())}>
          {tour ? 'Stop tour' : 'Guided tour'}
        </button>
        <button className="btn primary" onClick={() => set({ builder: true })}>
          Break it yourself
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
