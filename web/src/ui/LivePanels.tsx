import { useState } from 'react';
import type { BoardRow, CaseFile } from '../../../shared/types';
import { PARTIES, PARTY_NAME } from '../../../shared/types';
import { caseList, eur, PARTY_COLOR, useStore, type Lens } from '../store';
import { CaseState } from './State';

// The box reads differently from each side.
const LENSES: { id: Lens; name: string; text: string }[] = [
  { id: 'flow', name: 'Side', text: 'The path of a payment, left to right. Height is the order value.' },
  { id: 'agents', name: 'Front', text: 'Each column is an agent provider. Each dot, a decided case.' },
  { id: 'liability', name: 'Top', text: 'Agent providers against who was held liable.' },
];

function CaseRow({ c }: { c: CaseFile }) {
  const open = useStore((s) => s.open);
  const hot = useStore((s) => s.hover === c.id);
  const ruling = c.arbiter.ruling;
  const point = (id: string | null) => useStore.getState().set({ hover: id });
  return (
    <button className={`case-row ${c.status} ${hot ? 'hot' : ''}`} onClick={() => open(c.id)} onMouseEnter={() => point(c.id)} onMouseLeave={() => point(null)} onFocus={() => point(c.id)} onBlur={() => point(null)}>
      <div className="l1">
        <span className="item">{c.purchase.item}</span>
        <span className="amount">{eur(c.purchase.total)}</span>
      </div>
      <div className="l2">{c.stage === 'hold' ? `Held: ${c.flag ?? 'being screened'}` : `“${c.claim}”`}</div>
      <div className="l3">
        <CaseState c={c} detail />
        {c.closedAt && ruling && (
          <span className="minibar" title={PARTIES.filter((p) => ruling.split[p] > 0).map((p) => `${PARTY_NAME[p]} ${ruling.split[p]}%`).join(' · ')}>
            {PARTIES.filter((p) => ruling.split[p] > 0).map((p) => (
              <i key={p} style={{ width: `${ruling.split[p]}%`, background: PARTY_COLOR[p] }} />
            ))}
          </span>
        )}
        <span className="mono id">{c.whatIfOf ? `${c.id} · what-if` : c.id}</span>
      </div>
    </button>
  );
}

function Board({ title, rows, base }: { title: string; rows: BoardRow[]; base: number }) {
  const worst = Math.max(1, ...rows.map((r) => r.atFault));
  return (
    <div className="board">
      <h3>{title}</h3>
      {rows.slice(0, 6).map((r) => (
        <div key={r.name} className="brow">
          <div className="top">
            <b>{r.name}</b>
            <span className={`bps ${r.bps > base ? 'up' : ''}`}>{(r.bps / 100).toFixed(2)}%</span>
          </div>
          <div className="meter">
            <i style={{ width: `${(r.atFault / worst) * 100}%` }} />
          </div>
          <div className="sub">
            <span>{eur(r.atFault)} at fault</span>
            <span>
              {r.cases} case{r.cases === 1 ? '' : 's'} · {r.purchases} purchases
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LivePanels() {
  const cases = useStore((s) => s.cases);
  const stats = useStore((s) => s.stats);
  const list = caseList(cases);
  const [tab, setTab] = useState<'cases' | 'board'>('cases');
  const lens = useStore((s) => s.lens);
  const set = useStore((s) => s.set);

  return (
    <>
      <section className="intro">
        <h1>When an AI agent buys the wrong thing, who pays?</h1>
        <p>Every purchase an AI agent makes passes through the box.</p>
      </section>
      <div className="lens">
        <div className="seg" role="tablist" aria-label="Which side of the box to look at">
          {LENSES.map((l) => (
            <button key={l.id} role="tab" aria-selected={lens === l.id} className={lens === l.id ? 'on' : ''} onClick={() => set({ lensGo: { to: l.id, n: Date.now() } })}>
              {l.name}
            </button>
          ))}
        </div>
        <p>{LENSES.find((l) => l.id === lens)!.text}</p>
      </div>

      <aside className="cases">
        <header>
          <div className="tabs">
            <button className={tab === 'cases' ? 'on' : ''} onClick={() => setTab('cases')}>
              Cases
            </button>
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
              Risk pricing
            </button>
          </div>
        </header>
        {tab === 'cases' ? (
          <div className="scroll">
            {list.length === 0 && <div className="empty">Waiting for the first case…</div>}
            {list.map((c) => (
              <CaseRow key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <div className="scroll pad">
            <p className="board-note">
              What each party's own conduct has cost, from the rulings so far. The percentage is what the guarantee should charge on their
              purchases: the base rate of {stats ? (stats.premiumBps / 100).toFixed(2) : '—'}% plus their own loss rate.
            </p>
            {stats && <Board title="Agent providers" rows={stats.board.providers} base={stats.premiumBps} />}
            {stats && <Board title="Merchants" rows={stats.board.merchants} base={stats.premiumBps} />}
          </div>
        )}
      </aside>
    </>
  );
}
