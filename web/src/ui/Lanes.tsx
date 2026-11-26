import { useEffect, useRef } from 'react';
import { ROLE_NAME, ROLES } from '../../../shared/types';
import { ROLE_COLOR, useStore } from '../store';

const ROWS = [...ROLES.map((r) => ROLE_NAME[r]), 'Arbiter'];
const COLORS = [...ROLES.map((r) => ROLE_COLOR[r]), '#ffffff'];
const WINDOW_MS = 45_000;

// Which model calls were in flight, and when. Overlapping bars are agents
// genuinely working at the same moment; nothing here is drawn from a script.
export function Lanes({ caseId }: { caseId: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const now = useRef<HTMLSpanElement>(null);
  const stats = useStore((s) => s.stats);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = canvas.current;
      if (!el) return;
      const { lanes, skew } = useStore.getState();
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
      const t1 = Date.now() + skew;
      const t0 = t1 - WINDOW_MS;
      const rowH = h / ROWS.length;
      const x = (t: number) => ((t - t0) / WINDOW_MS) * w;
      g.fillStyle = 'rgba(255,255,255,0.045)';
      for (let i = 0; i < ROWS.length; i++) g.fillRect(0, i * rowH + rowH / 2, w, 1);
      let running = 0;
      for (const l of lanes) {
        const end = l.end ?? t1;
        if (!l.end) running++;
        if (end < t0) continue;
        const row = ROWS.indexOf(l.agent);
        if (row < 0) continue;
        const mine = !caseId || l.caseId === caseId;
        g.globalAlpha = mine ? (l.end ? 0.85 : 1) : 0.16;
        g.fillStyle = COLORS[row];
        const x0 = Math.max(0, x(l.start));
        g.fillRect(x0, row * rowH + 2, Math.max(2, x(end) - x0), rowH - 4);
      }
      g.globalAlpha = 1;
      if (now.current) now.current.textContent = String(running);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [caseId]);

  return (
    <footer className="lanes">
      <div className="names">
        {ROWS.map((r, i) => (
          <span key={r} style={{ color: COLORS[i] }}>
            {r}
          </span>
        ))}
      </div>
      <canvas ref={canvas} />
      <div className="count">
        <div>
          <b>
            <span ref={now}>0</span>
          </b>
          <label>model calls in flight</label>
        </div>
        <div>
          <b>{stats?.peakConcurrent ?? 0}</b>
          <label>peak at once</label>
        </div>
        <div>
          <b>{stats?.inferences ?? 0}</b>
          <label>total calls</label>
        </div>
      </div>
      <div className="disclaimer">Synthetic data only · no real accounts or money · not financial advice</div>
    </footer>
  );
}
