import { useEffect, useRef } from 'react';
import { ROLE_NAME, ROLES } from '../../../shared/types';
import { ROLE_COLOR, useStore } from '../store';

const ROWS = [...ROLES.map((r) => ROLE_NAME[r]), 'Arbiter'];
const COLORS = [...ROLES.map((r) => ROLE_COLOR[r]), '#f2f2f0'];
const WINDOW_MS = 45_000;

// The strip at the bottom. Closed, it carries the notice and a live count of
// model calls. Open, it shows which calls were in flight and when: overlapping
// bars are agents genuinely working at the same moment, read from the engine.
export function Engine({ caseId }: { caseId: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const now = useRef<HTMLElement>(null);
  const stats = useStore((s) => s.stats);
  const info = useStore((s) => s.info);
  const open = useStore((s) => s.engine);
  const set = useStore((s) => s.set);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { lanes, skew } = useStore.getState();
      const t1 = Date.now() + skew;
      if (now.current) now.current.textContent = String(lanes.filter((l) => !l.end).length);
      const el = canvas.current;
      if (!el) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      const g = el.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const t0 = t1 - WINDOW_MS;
      const rowH = h / ROWS.length;
      const x = (t: number) => ((t - t0) / WINDOW_MS) * w;
      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < ROWS.length; i++) g.fillRect(0, Math.round(i * rowH + rowH / 2), w, 1);
      for (const l of lanes) {
        const end = l.end ?? t1;
        if (end < t0) continue;
        const row = ROWS.indexOf(l.agent);
        if (row < 0) continue;
        const mine = !caseId || l.caseId === caseId;
        g.globalAlpha = mine ? (l.end ? 0.8 : 1) : 0.16;
        g.fillStyle = COLORS[row];
        const x0 = Math.max(0, x(l.start));
        g.beginPath();
        g.roundRect(x0, row * rowH + rowH / 2 - 3, Math.max(3, x(end) - x0), 6, 2);
        g.fill();
      }
      g.globalAlpha = 1;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [caseId]);

  return (
    <footer className={`engine ${open ? 'open' : ''}`}>
      {open && (
        <div className="lanes">
          <div className="names">
            {ROWS.map((r, i) => (
              <span key={r}>
                <i style={{ background: COLORS[i] }} />
                {r}
              </span>
            ))}
          </div>
          <canvas ref={canvas} />
          <p>
            Each bar is one model call, over the last 45 seconds. Bars that overlap are agents working at the same moment.
            {info?.mode === 'scripted' &&
              ` No API key is set, so the agents' decisions come from a rule-based stand-in model, and ${Math.round(info.faultRate * 100)}% of first submissions carry a deliberately wrong citation for the verifier to catch.`}
          </p>
        </div>
      )}
      <div className="strip">
        <span className="notice">Synthetic data. No real money. Not financial or legal advice.</span>
        <button className="engine-toggle" onClick={() => set({ engine: !open })} aria-expanded={open}>
          <span className={`live ${info?.mode ?? ''}`}>{info?.mode === 'live' ? 'Live model' : 'Scripted stand-in model'}</span>
          <span>
            <b ref={now}>0</b> model calls in flight
          </span>
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={open ? 'M2.5 4.5 6 8l3.5-3.5' : 'M2.5 7.5 6 4l3.5 3.5'} />
          </svg>
        </button>
      </div>
    </footer>
  );
}
