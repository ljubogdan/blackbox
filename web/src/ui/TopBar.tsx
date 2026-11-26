import { eur, useStore } from '../store';
import { endTour, startTour } from './Tour';

export function TopBar() {
  const info = useStore((s) => s.info);
  const stats = useStore((s) => s.stats);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const back = useStore((s) => s.back);
  const sound = useStore((s) => s.sound);
  const tour = useStore((s) => s.tour);
  const set = useStore((s) => s.set);

  return (
    <header className="topbar">
      <button className="brand" onClick={back} title="Back to the live view">
        <span className="logo" />
        <span className="name">Blackbox</span>
        <span className="tagline">the guarantee for purchases made by AI agents</span>
      </button>
      <div className="kpis">
        <div>
          <label>Purchases guaranteed</label>
          <b>{stats ? stats.purchases.toLocaleString('en-GB') : '—'}</b>
        </div>
        <div>
          <label>Value covered</label>
          <b>{stats ? eur(stats.gmv, 0) : '—'}</b>
        </div>
        <div className="good">
          <label>Stopped before settlement</label>
          <b>
            {stats ? eur(stats.prevented, 0) : '—'}
            {stats && <em> · {stats.blocked} blocked</em>}
          </b>
        </div>
        <div>
          <label>Premiums ({stats ? stats.premiumBps / 100 : '—'}%)</label>
          <b>{stats ? eur(stats.premiums) : '—'}</b>
        </div>
        <div>
          <label>Disputes closed</label>
          <b>{stats ? `${stats.disputesClosed} / ${stats.disputesOpened}` : '—'}</b>
        </div>
        <div>
          <label>Citations checked</label>
          <b>
            {stats?.citationsChecked ?? '—'}
            {stats && stats.citationsRejected > 0 && <em className="bad"> · {stats.citationsRejected} rejected</em>}
          </b>
        </div>
      </div>
      <div className="controls">
        <span className={`mode ${info?.mode ?? ''}`} title={info?.model}>
          {info?.mode === 'live' ? 'LIVE MODEL' : 'SCRIPTED MODEL'}
        </span>
        <button className="ghost" onClick={() => (tour ? endTour() : void startTour())}>
          {tour ? 'Stop tour' : '▶ Guided tour'}
        </button>
        <button className="primary" onClick={() => set({ builder: true })}>
          Break it yourself
        </button>
        <button className="ghost icon" onClick={() => set({ sound: !sound })} title={sound ? 'Sound on' : 'Sound off'} aria-pressed={sound}>
          {sound ? '🔊' : '🔇'}
        </button>
        <button className="ghost icon" onClick={() => setPaused(!paused)} title={paused ? 'Resume the purchase stream' : 'Pause the purchase stream'}>
          {paused ? '▶' : '❚❚'}
        </button>
      </div>
    </header>
  );
}
