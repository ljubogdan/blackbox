import { useEffect, useRef, useState } from 'react';
import { eur, useStore, waitingCases } from '../store';

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
  const inCase = useStore((s) => (s.view === 'case' ? s.selected : null));
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const toNetwork = useStore((s) => s.toNetwork);
  const view = useStore((s) => s.view);
  const sound = useStore((s) => s.sound);
  const set = useStore((s) => s.set);
  const cases = useStore((s) => s.cases);
  const open = useStore((s) => s.open);
  const waiting = waitingCases(cases);
  const next = waiting.find((c) => c.id !== inCase) ?? waiting[0];

  return (
    <header className="topbar">
      <button className="brand" onClick={toNetwork} title="The network">
        {/* the black box itself: a cube lit from above, its top brightest and its right side in shadow */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <defs>
            <linearGradient id="bb-top" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#9c9ca6" />
              <stop offset="1" stopColor="#5b5b64" />
            </linearGradient>
            <linearGradient id="bb-left" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3a3a42" />
              <stop offset="1" stopColor="#1d1d22" />
            </linearGradient>
            <linearGradient id="bb-right" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1b1b20" />
              <stop offset="1" stopColor="#0c0c0f" />
            </linearGradient>
          </defs>
          <path d="M12 2.2 21 7.4 12 12.6 3 7.4Z" fill="url(#bb-top)" />
          <path d="M3 7.4 12 12.6V22.8L3 17.6Z" fill="url(#bb-left)" />
          <path d="M21 7.4 12 12.6V22.8L21 17.6Z" fill="url(#bb-right)" />
          {/* edges catching the light: brightest along the top, fading down the sides */}
          <path d="M3 7.4 12 2.2 21 7.4" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="0.9" strokeLinejoin="round" />
          <path d="M3 7.4 12 12.6 21 7.4M12 12.6V22.8" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="0.8" strokeLinejoin="round" />
          <path d="M3 7.4V17.6L12 22.8 21 17.6V7.4" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" strokeLinejoin="round" />
        </svg>
        <span>Blackbox</span>
      </button>
      <div className="metrics">
        <Metric label="Guaranteed" value={stats ? <Money value={stats.gmv} /> : '—'} />
        <Metric label="Stopped before settlement" value={stats ? <Money value={stats.prevented} /> : '—'} />
        <Metric label="Stopped by the network" value={stats ? <Money value={stats.networkPrevented} /> : '—'} />
      </div>
      <div className="controls">
        {waiting.length > 0 && (
          <button className="btn wait" onClick={() => open(next.id)} title="Open the ruling that has waited longest">
            <span className="wide">{waiting.length === 1 ? '1 ruling is waiting for you' : `${waiting.length} rulings are waiting for you`}</span>
            <span className="narrow">{waiting.length} waiting</span>
          </button>
        )}
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
