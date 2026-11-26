import { useEffect, useMemo, useState } from 'react';
import type { CaseFile } from '../../../shared/types';
import { breachStep, colorOf, factOf, layersOf, STEP_WORD } from '../case';
import { eur, useStore } from '../store';

// The middle of the case view. What was charged, and what that charge is made of: one bar, its parts
// in the colour of whoever caused them, with the owner's limit drawn across it. Whatever lies past the
// limit is struck through. Under it, what the agent did, step by step.

const PART_MS = 380; // between one part of the bar filling and the next

export function CaseStage({ c }: { c: CaseFile }) {
  const limit = useStore((s) => s.limitPreview) ?? c.mandate.maxAmount;
  const setInspect = useStore((s) => s.setInspect);
  const { layers, total } = useMemo(() => layersOf(c), [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fact = factOf(c, limit);
  const [lit, setLit] = useState<string | null>(null); // the part under the pointer, in the bar or the legend
  const scale = Math.max(limit, total) * 1.08;
  const pct = (x: number) => (x / scale) * 100;
  const starts = layers.map((_, i) => layers.slice(0, i).reduce((n, l) => n + l.amount, 0));
  const over = total > limit + 0.004;

  // Once the bar has filled, the team's cards may come up.
  useEffect(() => {
    const id = setTimeout(() => useStore.getState().set({ drawn: c.id }), 500 + layers.length * PART_MS + 500);
    return () => clearTimeout(id);
  }, [c.id, layers.length]);

  return (
    <section className="case-stage">
      <div className="hero">
        <span className="caption">{c.stage === 'hold' ? 'About to be charged' : 'Charged'}</span>
        <b className="total">{eur(total)}</b>
        <span className={`fact ${fact.breach ? 'breach' : 'inside'}`}>
          <b>{fact.head}</b> {fact.tail}
        </span>
      </div>

      <div className="budget" onMouseLeave={() => setLit(null)}>
        <div className={`limit ${over ? 'over' : ''}`} style={{ left: `${pct(limit)}%` }}>
          <span>Limit {eur(limit)}</span>
        </div>
        <div className="track">
          {layers.map((l, i) => (
            <button
              key={l.key}
              className={`part ${lit && lit !== l.key ? 'dim' : ''}`}
              style={{ left: `calc(${pct(starts[i])}% + 2px)`, width: `calc(${pct(l.amount)}% - 4px)`, ['--c' as string]: colorOf(l), animationDelay: `${300 + i * PART_MS}ms` }}
              onMouseEnter={() => setLit(l.key)}
              onClick={() => setInspect({ evidenceId: l.evidenceId })}
              aria-label={`${l.name}, ${eur(l.amount)}`}
            />
          ))}
          {over && <div className="past" style={{ left: `${pct(limit)}%`, width: `${pct(total - limit)}%`, animationDelay: `${300 + layers.length * PART_MS}ms` }} />}
        </div>
      </div>

      <ul className="legend">
        {layers.map((l) => (
          <li key={l.key}>
            <button
              className={lit && lit !== l.key ? 'dim' : ''}
              style={{ ['--c' as string]: colorOf(l) }}
              onMouseEnter={() => setLit(l.key)}
              onMouseLeave={() => setLit(null)}
              onClick={() => setInspect({ evidenceId: l.evidenceId })}
            >
              <span>{l.name}</span>
              <b>{eur(l.amount)}</b>
            </button>
          </li>
        ))}
      </ul>

      <Journey c={c} limit={limit} />
    </section>
  );
}

// What the agent did, in order, with the step where it left the mandate marked.
function Journey({ c, limit }: { c: CaseFile; limit: number }) {
  const setInspect = useStore((s) => s.setInspect);
  const inspected = useStore((s) => s.inspect?.evidenceId);
  const breach = breachStep(c, limit);
  return (
    <ol className="journey">
      {c.steps.map((s) => (
        <li key={s.n}>
          <button className={`${s === breach ? 'breach' : ''} ${s.evidenceId === inspected ? 'on' : ''}`} onClick={() => setInspect({ evidenceId: s.evidenceId })} title={s.label}>
            <span>{STEP_WORD[s.kind]}</span>
            {s.price !== null && <b>{eur(s.price)}</b>}
          </button>
        </li>
      ))}
    </ol>
  );
}
