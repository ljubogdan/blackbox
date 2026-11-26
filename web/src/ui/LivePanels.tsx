import { useState } from 'react';
import type { BoardRow, CaseFile } from '../../../shared/types';
import { PARTIES, PARTY_NAME, ROLES } from '../../../shared/types';
import { caseList, eur, PARTY_COLOR, ROLE_COLOR, STATUS_LABEL, useStore } from '../store';

function CaseRow({ c }: { c: CaseFile }) {
  const open = useStore((s) => s.open);
  const ruling = c.arbiter.ruling;
  return (
    <button className={`case-row ${c.status}`} onClick={() => open(c.id)}>
      <div className="row1">
        <span className="mono id">
          {c.id}
          <i className={`kind ${c.stage}`}>{c.whatIfOf ? 'what-if' : c.stage === 'hold' ? 'held' : 'dispute'}</i>
        </span>
        <span className="amount">{eur(c.purchase.total)}</span>
      </div>
      <div className="item">{c.purchase.item}</div>
      <div className="claim">{c.stage === 'hold' ? `Held: ${c.flag ?? 'being screened'}` : `“${c.claim}”`}</div>
      <div className="row3">
        {c.closedAt && ruling ? (
          <div className="minibar" title={PARTIES.filter((p) => ruling.split[p] > 0).map((p) => `${PARTY_NAME[p]} ${ruling.split[p]}%`).join(' · ')}>
            {PARTIES.filter((p) => ruling.split[p] > 0).map((p) => (
              <i key={p} style={{ width: `${ruling.split[p]}%`, background: PARTY_COLOR[p] }} />
            ))}
          </div>
        ) : (
          <div className="pips">
            {ROLES.filter((r) => c.investigators[r].status !== 'skipped').map((r) => (
              <i key={r} className={c.investigators[r].status} style={{ ['--c' as string]: ROLE_COLOR[r] }} />
            ))}
          </div>
        )}
        <span className={`status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
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
  const info = useStore((s) => s.info);
  const list = caseList(cases);
  const waiting = list.filter((c) => c.status === 'awaiting_approval');
  const [tab, setTab] = useState<'cases' | 'board'>('cases');

  return (
    <>
      <section className="pitch">
        <h1>
          An AI bought this.
          <br />
          The customer says they never asked.
          <br />
          <em>Who pays?</em>
        </h1>
        <p>
          Every arc is a purchase made by a shopping agent on Black Friday. A risky one is stopped in mid-air; a disputed one is traced
          back. Either way, investigators examine it at the same time, a verifier checks every figure they cite against the sealed record,
          and an arbiter decides who is at fault.
        </p>
        <div className="legend">
          {PARTIES.map((p) => (
            <span key={p}>
              <i style={{ background: PARTY_COLOR[p] }} />
              {PARTY_NAME[p]}
            </span>
          ))}
        </div>
        {stats && (
          <div className="book">
            <div className="good">
              <label>Stopped before settlement</label>
              <b>{eur(stats.prevented)}</b>
            </div>
            <div>
              <label>Refunded to customers</label>
              <b>{eur(stats.refunds)}</b>
            </div>
            <div>
              <label>Recovered from the party at fault</label>
              <b>{eur(stats.recovered)}</b>
            </div>
            <div>
              <label>Absorbed by the guarantee</label>
              <b>{eur(stats.absorbed)}</b>
            </div>
          </div>
        )}
        {info && info.mode === 'scripted' && (
          <p className="fine">
            Running without an API key: the agents' decisions come from a rule-based stand-in model, and{' '}
            {Math.round(info.faultRate * 100)}% of first submissions carry a deliberately wrong citation so the verifier has something to
            catch.
          </p>
        )}
      </section>

      <aside className="cases">
        <header>
          <div className="tabs">
            <button className={tab === 'cases' ? 'on' : ''} onClick={() => setTab('cases')}>
              Cases
            </button>
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
              Risk board
            </button>
          </div>
          {waiting.length > 0 && <span className="badge">{waiting.length} need approval</span>}
        </header>
        {tab === 'cases' ? (
          <div className="scroll">
            {list.length === 0 && <div className="empty">Waiting for the first case…</div>}
            {list.map((c) => (
              <CaseRow key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <div className="scroll">
            <p className="board-note">
              What each party's own conduct has cost, from the rulings so far. The percentage is what the guarantee should charge on their
              purchases: the base rate plus their own loss rate.
            </p>
            {stats && <Board title="Agent providers" rows={stats.board.providers} base={stats.premiumBps} />}
            {stats && <Board title="Merchants" rows={stats.board.merchants} base={stats.premiumBps} />}
          </div>
        )}
      </aside>
    </>
  );
}
