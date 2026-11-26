import { useMemo } from 'react';
import type { CaseFile, CitationCheck, EvidenceRecord, Role } from '../../../shared/types';
import { PARTIES, PARTY_NAME, ROLE_NAME, ROLE_PARTY, ROLES } from '../../../shared/types';
import { useEffect, useState } from 'react';
import { downloadPack } from '../pack';
import { dockOpen, eur, nonce, PARTY_COLOR, ROLE_COLOR, topParty, useStore } from '../store';
import { CaseState } from './State';

const QUESTION: Record<Role, string> = {
  mandate: 'Did the agent stay inside its instruction?',
  integrity: "Was this the owner's own session?",
  merchant: 'Did the merchant charge what it advertised?',
  intent: "Does the customer's claim hold up?",
};

const STATUS_TEXT: Record<string, string> = {
  queued: 'Waiting',
  reading: 'Reading evidence',
  submitted: 'Verifier checking citations',
  verified: 'Verified',
  rejected: 'Rejected, re-reading',
  failed: 'Failed',
  skipped: 'Not needed',
};

function show(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (v === null || v === undefined) return '—';
  return String(v);
}

function InvestigatorCard({ c, role }: { c: CaseFile; role: Role }) {
  const inv = c.investigators[role];
  const setInspect = useStore((s) => s.setInspect);
  const f = inv.finding;
  const busy = inv.status === 'reading' || inv.status === 'submitted';
  const checks = new Map<string, CitationCheck>((inv.checks ?? []).map((k) => [`${k.evidence_id}.${k.field}`, k]));
  if (inv.status === 'skipped') {
    return (
      <div className="inv skipped" style={{ ['--c' as string]: ROLE_COLOR[role] }}>
        <div className="head">
          <div>
            <b>{ROLE_NAME[role]}</b>
            <span className="q">{QUESTION[role]}</span>
          </div>
        </div>
        <p className="idle">
          {c.network
            ? 'Not needed. The network already knew this attack.'
            : 'Not needed yet. The payment was stopped before it settled, so there is no claim to examine.'}
        </p>
      </div>
    );
  }
  const ch = inv.challenge;
  return (
    <div className={`inv ${inv.status}`} style={{ ['--c' as string]: ROLE_COLOR[role] }}>
      <div className="head">
        <div>
          <b>{ROLE_NAME[role]}</b>
          <span className="q">{QUESTION[role]}</span>
        </div>
        {f && inv.status !== 'reading' && (
          <div className="score" title={`How much of the loss the evidence puts on: ${PARTY_NAME[ROLE_PARTY[role]]}`}>
            <b>{f.liability}</b>
            <span>/100</span>
          </div>
        )}
      </div>
      <div className="progress">
        {busy && <span className="spin" />}
        {inv.status === 'verified' && <span className="ok">✓</span>}
        {inv.status === 'rejected' && <span className="no">✗</span>}
        <span>{STATUS_TEXT[inv.status]}</span>
        {inv.attempts > 1 && <span className="retry">attempt {inv.attempts}</span>}
      </div>
      {f && inv.status !== 'reading' && (
        <>
          <p>{f.summary}</p>
          {ch && (
            <div className={`challenge ${ch.status} ${ch.stance ?? ''}`} style={{ ['--from' as string]: ROLE_COLOR[ch.from] }}>
              <b>
                Challenged by the {ROLE_NAME[ch.from]}
                {ch.status === 'pending' && <span className="spin" />}
              </b>
              <span>“{ch.point}”</span>
              {ch.status === 'answered' && (
                <em>
                  {ch.stance === 'revise' ? `Revised ${ch.before} → ${f.liability}. ` : /^maintained\b/i.test(ch.reply ?? '') ? '' : 'Maintained. '}
                  {ch.reply}
                </em>
              )}
            </div>
          )}
          <div className="cites">
            {f.citations.map((k, i) => {
              const check = checks.get(`${k.evidence_id}.${k.field}`);
              return (
                <button
                  key={i}
                  className={`cite ${check ? (check.ok ? 'ok' : 'bad') : ''}`}
                  onClick={() => setInspect({ evidenceId: k.evidence_id, field: k.field })}
                  title={check && !check.ok ? `Cited ${show(k.value)}; the record says ${show(check.actual)}` : 'Open the source record'}
                >
                  <span className="mono">{k.evidence_id}</span>.{k.field} = <b>{show(k.value)}</b>
                  {check && <i>{check.ok ? '✓' : '✗'}</i>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// What a page looked like to a person, and what the agent actually read from it.
function PageMock({ rec }: { rec: EvidenceRecord }) {
  const mode = useStore((s) => s.pageMode);
  const set = useStore((s) => s.set);
  const d = rec.data;
  if (rec.kind !== 'TRL' || typeof d.item !== 'string') return null;
  const hidden = typeof d.hidden_text === 'string' ? d.hidden_text : null;
  const banner = typeof d.page_banner === 'string' ? d.page_banner : null;
  const agent = mode === 'agent';
  return (
    <div className={`page ${agent ? 'agent' : 'human'} ${hidden ? 'planted' : ''}`}>
      <div className="page-tabs">
        <button className={!agent ? 'on' : ''} onClick={() => set({ pageMode: 'human' })}>
          What a person sees
        </button>
        <button className={agent ? 'on' : ''} onClick={() => set({ pageMode: 'agent' })}>
          What the agent read
        </button>
      </div>
      <div className="browser">
        <div className="chrome">
          <span>{String(d.merchant).toLowerCase().replace(/[^a-z]+/g, '')}.example/product</span>
        </div>
        <div className="body">
          <div className="thumb" />
          <div className="info">
            <b>{d.item}</b>
            {typeof d.observed_price === 'number' && <span className="price">{eur(d.observed_price)}</span>}
            {banner && <span className="banner">{banner}</span>}
            <span className="btn">Add to cart</span>
          </div>
        </div>
        {hidden && (
          <div className="uv">
            <label>Hidden text · {String(d.hidden_text_origin)}</label>
            <p>{hidden}</p>
          </div>
        )}
      </div>
      {hidden && !agent && <p className="tip">This page held text no person could see. Switch to “What the agent read”.</p>}
    </div>
  );
}

// Try changing a sealed record. The engine runs its own checks on a copy and says what they would catch;
// the record on file stays as it is.
function TamperTry({ c, rec }: { c: CaseFile; rec: EvidenceRecord }) {
  const fields = Object.keys(rec.data);
  const cited = ROLES.flatMap((r) => c.investigators[r].finding?.citations ?? []).find((k) => k.evidence_id === rec.id)?.field;
  const [field, setField] = useState(cited ?? fields[0]);
  const [value, setValue] = useState(show(rec.data[field]));
  const result = useStore((s) => (s.tamper?.evidenceId === rec.id ? s.tamper : null));
  useEffect(() => {
    const f = cited ?? fields[0];
    setField(f);
    setValue(show(rec.data[f]));
  }, [rec.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = useStore((s) => s.send);
  const changed = value !== show(rec.data[field]);
  return (
    <div className="tamper">
      <label>Try to change this record</label>
      <div className="tamper-row">
        <select
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setValue(show(rec.data[e.target.value]));
          }}
        >
          {fields.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
      </div>
      <button className="btn" disabled={!changed} onClick={() => send({ type: 'tamper', nonce: nonce(), caseId: c.id, evidenceId: rec.id, field, value })}>
        Change it and check
      </button>
      {result && (
        <div className="tamper-result">
          <p>
            <b>The seal of {result.evidenceId} no longer matches.</b> Its hash covers every field, so {result.field} changing from {show(result.before)} to{' '}
            {show(result.after)} shows at once.
          </p>
          {result.later.length > 0 && (
            <p>
              Sealing it again would change the {result.later.length} seal{result.later.length === 1 ? '' : 's'} after it, and the chain would end on{' '}
              <span className="mono">{result.resealedHead.slice(0, 10)}…</span> instead of the <span className="mono">{result.headOnFile.slice(0, 10)}…</span>{' '}
              recorded when the case opened.
            </p>
          )}
          {result.rejected.length > 0 ? (
            <ul>
              {result.rejected.map((k, i) => (
                <li key={i} style={{ ['--c' as string]: ROLE_COLOR[k.role] }}>
                  <b>{ROLE_NAME[k.role]}</b> would be sent back: <span className="mono">{k.evidence_id}.{k.field}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No finding cites this record, so no ruling rests on it.</p>
          )}
          <small>Checked on a copy. The case on file is unchanged.</small>
        </div>
      )}
    </div>
  );
}

export function Inspector({ c }: { c: CaseFile }) {
  const inspect = useStore((s) => s.inspect);
  const setInspect = useStore((s) => s.setInspect);
  const rec: EvidenceRecord | undefined = c.evidence.find((e) => e.id === inspect?.evidenceId);
  // which investigators cited which field of this record
  const cited = useMemo(() => {
    const m = new Map<string, Role[]>();
    for (const r of ROLES) for (const k of c.investigators[r].finding?.citations ?? []) if (k.evidence_id === rec?.id) m.set(k.field, [...(m.get(k.field) ?? []), r]);
    return m;
  }, [c, rec?.id]);
  const groups = ['MND', 'TRL', 'LST', 'ORD', 'SES', 'DLV', 'CLM'] as const;
  return (
    <aside className={`inspector ${rec ? 'open' : ''}`}>
      <h3>Evidence on file</h3>
      <div className="chips">
        {groups.map((g) =>
          c.evidence
            .filter((e) => e.kind === g)
            .map((e) => (
              <button key={e.id} className={`chip ${e.id === rec?.id ? 'on' : ''}`} onClick={() => setInspect({ evidenceId: e.id })}>
                {g === 'TRL' ? `TRL ${e.id.slice(-2)}` : g}
              </button>
            )),
        )}
      </div>
      {rec && <PageMock rec={rec} />}
      {rec ? (
        <div className="record">
          <div className="rec-head">
            <span className="mono">{rec.id}</span>
            <span>{rec.title}</span>
          </div>
          <table>
            <tbody>
              {Object.entries(rec.data).map(([k, v]) => (
                <tr key={k} className={`${inspect?.field === k ? 'focus' : ''} ${cited.has(k) ? 'cited' : ''}`}>
                  <td>{k}</td>
                  <td>
                    {show(v)}
                    {(cited.get(k) ?? []).map((r) => (
                      <i key={r} title={`Cited by ${ROLE_NAME[r]}`} style={{ background: ROLE_COLOR[r] }} />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={`seal ${c.integrity.ok ? 'ok' : 'bad'}`} title={`sha256 ${rec.hash}\nprevious ${rec.prev}`}>
            <span className="mono">sha256 {rec.hash.slice(0, 16)}…</span>
            <span>{c.integrity.ok ? `sealed · chain of ${c.integrity.records} verified` : 'chain broken'}</span>
          </div>
          <TamperTry c={c} rec={rec} />
        </div>
      ) : null}
      <div className="feed">
        <h3>Activity</h3>
        {c.log
          .slice(-6)
          .reverse()
          .map((l, i) => (
            <div key={i}>
              <b>{l.who}</b> {l.text}
            </div>
          ))}
      </div>
    </aside>
  );
}

export function Verdict({ c }: { c: CaseFile }) {
  const ruling = c.arbiter.ruling;
  const awaiting = c.status === 'awaiting_approval';
  const active = ROLES.filter((r) => c.investigators[r].status !== 'skipped');
  const verified = active.filter((r) => c.investigators[r].status === 'verified').length;
  const hold = c.stage === 'hold';

  return (
    <section className={`verdict ${c.status}`}>
      <div className="bar-wrap">
        <div className="bar-title">
          <h3>{awaiting ? 'Proposed ruling' : hold ? 'Who would have paid' : 'Who pays'}</h3>
          {!ruling && (
            <span className="pending">
              {c.arbiter.status === 'deliberating'
                ? `Arbiter is weighing ${active.length} verified findings…`
                : c.crossExam === 'open'
                  ? 'Two investigators are answering each other…'
                  : `${verified} of ${active.length} findings verified`}
            </span>
          )}
        </div>
        <div className={`bar ${ruling ? '' : 'empty'} ${awaiting ? 'draft' : ''}`}>
          {ruling
            ? PARTIES.filter((p) => ruling.split[p] > 0).map((p) => (
                <div key={p} style={{ width: `${ruling.split[p]}%`, background: PARTY_COLOR[p] }}>
                  <b>{ruling.split[p]}%</b>
                  <span>{PARTY_NAME[p]}</span>
                </div>
              ))
            : active.map((r) => <div key={r} className={`slot ${c.investigators[r].status}`} style={{ ['--c' as string]: ROLE_COLOR[r] }} />)}
        </div>
      </div>

      {(c.status === 'blocked' || c.status === 'released') && (
        <div className={`outcome ${c.status}`}>
          <b>{c.status === 'blocked' ? 'Blocked' : 'Released'}</b>
          <span>
            {c.status === 'blocked'
              ? `${eur(c.purchase.total)} never left the customer's account.`
              : `Nothing was wrong with it. ${eur(c.purchase.total)} went through after a short hold.`}
          </span>
        </div>
      )}

      {awaiting && <p className="draft-note">A draft. It is not in force until a person approves it.</p>}

      {ruling && <p className="rationale">{ruling.rationale}</p>}

      {c.settlement && (
        <div className="settlement">
          {c.settlement.map((l, i) => (
            <div key={i} className="line">
              <span className="lbl">{l.label}</span>
              <span className="formula mono">
                {l.formula} <em>{l.source}</em>
              </span>
              <b>{eur(l.amount)}</b>
            </div>
          ))}
        </div>
      )}
      {c.status === 'manual_review' && <p className="rationale">This case was moved to manual review. No ruling was recorded and no money was assigned.</p>}
      {c.closedAt && (
        <button className="export" onClick={() => downloadPack(c)}>
          Download the evidence pack
        </button>
      )}
    </section>
  );
}

// Drag the spending limit and watch the journey fall inside or outside it, then
// have the team rule on the case again with that limit.
function WhatIf({ c }: { c: CaseFile }) {
  const preview = useStore((s) => s.limitPreview);
  const set = useStore((s) => s.set);
  const request = useStore((s) => s.request);
  const total = c.purchase.total;
  const top = Math.ceil((Math.max(total, c.mandate.maxAmount) * 1.8) / 10) * 10;
  const value = preview ?? c.mandate.maxAmount;
  const changed = preview !== null && preview !== c.mandate.maxAmount;
  return (
    <div className="whatif">
      <label>
        What if the limit were <b>{eur(value, 0)}</b>?
      </label>
      <input type="range" min={10} max={top} step={10} value={value} onChange={(e) => set({ limitPreview: Number(e.target.value) })} aria-label="Spending limit" />
      <div className="row">
        <span>{value >= total ? 'The charge would fit under it.' : `The charge would be ${eur(total - value)} over.`}</span>
        {changed && (
          <button className="btn small" onClick={() => set({ limitPreview: null })}>
            Reset
          </button>
        )}
      </div>
      <button className="btn primary" disabled={!changed} onClick={() => request({ type: 'whatif', nonce: nonce(), caseId: c.id, max: value })}>
        Re-run the case with this limit
      </button>
    </div>
  );
}

export function CaseInfo({ c }: { c: CaseFile }) {
  const back = useStore((s) => s.back);
  const p = c.purchase;
  return (
    <aside className="case-info">
      <button className="backlink" onClick={back}>
        ← Network
      </button>
      <div className="case-title">
        <CaseState c={c} />
      </div>
      <h2>{p.item}</h2>
      <div className="meta">
        <span className="amount">{eur(p.total)}</span>
        <span>{p.merchant.name}</span>
        <span>bought by {p.provider}</span>
        <span>customer in {p.buyer.city}</span>
      </div>
      {c.whatIfOf && (
        <div className="whatif-note">
          What-if re-run of <button onClick={() => useStore.getState().open(c.whatIfOf!)}>{c.whatIfOf}</button> with the limit set to {eur(c.mandate.maxAmount, 0)}
        </div>
      )}
      {c.network ? (
        <blockquote className="held network">
          <label>Stopped by the network</label>
          This payment carried {c.network.label}. The network learned that attack from{' '}
          <button onClick={() => useStore.getState().open(c.network!.sourceCaseId)}>{c.network.sourceCaseId}</button> at {c.network.sourceMerchant}, so it
          was blocked on arrival.
        </blockquote>
      ) : c.stage === 'hold' ? (
        <blockquote className="held">
          <label>Held before settlement</label>
          The screen stopped this payment: {c.flag ?? 'checking'}.
        </blockquote>
      ) : (
        <blockquote>“{c.claim}”</blockquote>
      )}
      <div className="mandate">
        <label>What the owner told the agent</label>
        <p>{c.mandate.text}</p>
      </div>
      <WhatIf c={c} />
    </aside>
  );
}

export function Investigators({ c }: { c: CaseFile }) {
  return (
    <div className="inv-row">
      {ROLES.map((r) => (
        <InvestigatorCard key={r} c={c} role={r} />
      ))}
    </div>
  );
}

// Under the case: the team's cards, shown or put away.
export function ReplayLens() {
  const set = useStore((s) => s.set);
  const dock = useStore(dockOpen);
  return (
    <div className="replay-lens">
      <button className="dock-toggle" onClick={() => set({ dockChoice: !dock })} aria-expanded={dock}>
        {dock ? 'Hide the team' : 'Show the team'}
      </button>
    </div>
  );
}

// How long the arbiter has been stopped, from the engine's own log of when it stopped.
// The moment a person is needed. The arbiter has drafted a ruling on a large
// order and stopped mid-turn; nothing moves on this case until someone decides.
export function ApprovalBanner({ c }: { c: CaseFile }) {
  const send = useStore((s) => s.send);
  const info = useStore((s) => s.info);
  const ruling = c.arbiter.ruling;
  if (c.status !== 'awaiting_approval' || !ruling) return null;
  return (
    <div className="approval-banner" role="alertdialog" aria-label="A ruling is waiting for your approval">
      <div className="what">
        <b>
          The arbiter has stopped. This ruling needs a person.
        </b>
        <span>
          {eur(c.purchase.total)} is at or above the {eur(info?.approvalThreshold ?? 0, 0)} line.
        </span>
      </div>
      <div className="proposal" title={ruling.rationale}>
        <span>
          {PARTIES.filter((p) => ruling.split[p] > 0)
            .map((p) => `${ruling.split[p]}% ${PARTY_NAME[p]}`)
            .join(' · ')}
        </span>
      </div>
      <button className="btn" onClick={() => send({ type: 'approve', caseId: c.id, approved: false })}>
        Send to manual review
      </button>
      <button className="btn primary" onClick={() => send({ type: 'approve', caseId: c.id, approved: true })}>
        Approve ruling
      </button>
    </div>
  );
}
