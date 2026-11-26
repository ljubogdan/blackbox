// The yardstick for the team: one model call per case, with every record in the prompt and no
// tools, no verifier, no cross-examination and no second opinion. If the team cannot beat this,
// the extra agents are not earning their cost. Scored exactly as npm run eval scores the team.
//   npm run baseline                                     (each of the 12 generated kinds once)
//   EVAL_CASES=heldout/cases.json npm run baseline -- 2  (cases written by hand, each twice)
// Needs a live model. BASELINE_MODEL picks it (default: the arbiter's model); SPEND_CAP_USD caps the run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DefaultInferenceRunner, DeveloperMessageItem, ModelContext, ModelMessageItem, supportedModels, UserMessageItem } from '@mozaik-ai/core';
import type { CaseFile, Party, Sabotage } from '../shared/types';
import { PARTIES, SCENARIOS } from '../shared/types';
import { config } from '../server/config';
import { screen } from '../server/agents/sentinel';
import { buildHeldOut, heldOutProblems, type HeldOutCase } from '../server/data/heldout';
import { buildCase } from '../server/data/scenarios';
import { GuardedRunner } from '../server/model/guard';
import { Rng } from '../server/rng';

if (config.mode !== 'live') {
  console.error('baseline: needs a live model (a provider key in .env, and BLACKBOX_MODE not set to scripted). The stand-in has no baseline to compare.');
  process.exit(1);
}
const model = process.env.BASELINE_MODEL ?? config.arbiterModel;
const reps = Math.max(1, Number(process.argv[2] ?? 1));
const parallel = Number(process.env.BASELINE_PARALLEL ?? 3);

// The same domain knowledge the team's prompts carry, in one prompt. What it lacks is the
// architecture: separate questions, checked citations, challenges, and the refusal of unsupported shares.
const INSTRUCTION = [
  'You resolve disputes about purchases that an AI shopping agent made for its owner.',
  'You are given every stored record of one case. Decide how responsibility for the loss is split between four parties:',
  '- customer: the claim is not supported by the record (the purchase was inside the mandate, from their own session, delivered to them). The customer is the residual party: if no one else is at fault, customer is 100.',
  '- agent_provider: the agent went outside what its owner authorised (price limit, quantity, category, add-ons), including when manipulated by content it read.',
  '- merchant: the merchant charged differently from what it advertised (price above the listing, fees it did not disclose).',
  '- fraud: a third party used the agent without authority (different device, distant location, an old replayed token).',
  'Give a party a share only if the records put real weight on it; where the evidence clears a party, its share is 0. Do not hedge with small shares.',
  'For a payment HELD before settlement: any share outside the customer blocks it; customer 100 releases it.',
  'Reply with your reasoning in at most 80 words, then on the last line a JSON object and nothing after it:',
  '{"split": {"customer": 0, "agent_provider": 0, "merchant": 0, "fraud": 0}}',
  'The four values are whole numbers that sum to exactly 100. All data is synthetic.',
].join('\n');

function brief(c: CaseFile): string {
  return [
    `CASE: ${c.id}`,
    c.stage === 'hold' ? `This payment is being HELD before settlement (screen: ${screen(c)}).` : `Customer claim: "${c.claim}"`,
    '',
    'Records:',
    ...c.evidence.map((e) => `${e.id} (${e.title}): ${JSON.stringify(e.data)}`),
  ].join('\n');
}

interface Item {
  kind: string;
  caseFile: CaseFile;
  truth: Record<Party, number>;
}

function items(): Item[] {
  let n = 0;
  const now = Date.now();
  if (process.env.EVAL_CASES) {
    const specs: HeldOutCase[] = JSON.parse(readFileSync(process.env.EVAL_CASES, 'utf8'));
    const problems = specs.flatMap(heldOutProblems);
    if (problems.length > 0) {
      console.error(`${process.env.EVAL_CASES}: ${problems.length} problem(s), nothing was run:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    return specs.flatMap((spec) => Array.from({ length: reps }, () => ({ kind: spec.name, ...buildHeldOut(spec, ++n, n, now) })));
  }
  // The same kinds the eval runs, drawn from the same seed.
  const rng = new Rng(config.seed);
  const kinds: { sabotage: Sabotage; stage: 'hold' | 'dispute' }[] = [
    ...SCENARIOS.map((sabotage) => ({ sabotage, stage: 'dispute' as const })),
    ...SCENARIOS.filter((x) => x !== 'friendly').map((sabotage) => ({ sabotage, stage: 'hold' as const })),
    { sabotage: 'clean', stage: 'hold' },
  ];
  return kinds.flatMap((k) =>
    Array.from({ length: reps }, () => ({ kind: `${k.sabotage}/${k.stage}`, ...buildCase(rng, ++n, k.sabotage, n, now, { stage: k.stage }) })),
  );
}

const runner = new GuardedRunner(new DefaultInferenceRunner(supportedModels, { validate() {} } as never), parallel, 4, config.inferenceTimeoutMs, config.maxRpm, {
  spendCapUsd: config.spendCapUsd,
});

// The last {...} in the reply that holds a valid split, or null.
function parseSplit(text: string): Record<Party, number> | null {
  for (const m of [...text.matchAll(/\{[^{}]*\{[^{}]*\}[^{}]*\}/g)].reverse()) {
    try {
      const raw = JSON.parse(m[0]).split;
      const split = Object.fromEntries(PARTIES.map((p) => [p, Number(raw?.[p])])) as Record<Party, number>;
      if (PARTIES.every((p) => Number.isInteger(split[p]) && split[p] >= 0) && PARTIES.reduce((s, p) => s + split[p], 0) === 100) return split;
    } catch {
      // not JSON: try the one before
    }
  }
  return null;
}

const top = (s: Record<Party, number>) => PARTIES.reduce((a, b) => (s[b] > s[a] ? b : a));
const distance = (a: Record<Party, number>, b: Record<Party, number>) => PARTIES.reduce((n, p) => n + Math.abs(a[p] - b[p]), 0) / 2;

async function judge(it: Item) {
  const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(INSTRUCTION)).addContextItem(UserMessageItem.create(brief(it.caseFile)));
  const out = await runner.run({ model, context, maxOutputTokens: 1500 });
  const text = out.items.filter((x): x is ModelMessageItem => x instanceof ModelMessageItem).map((x) => x.content.text).join('\n');
  const split = text.startsWith('INFERENCE_ERROR') ? null : parseSplit(text);
  const correct = split ? (it.caseFile.stage === 'hold' ? split.customer < 100 === it.truth.customer < 100 : top(split) === top(it.truth)) : null;
  return { id: it.caseFile.id, kind: it.kind, correct, split: split ?? undefined, truth: it.truth, off: split ? distance(split, it.truth) : undefined, reply: text };
}

const queue = items();
const kinds = [...new Set(queue.map((q) => q.kind))];
console.log(`baseline: ${queue.length} cases (${kinds.length} kinds × ${reps}), one call each on ${model}, ${parallel} at a time`);
console.log(`spending cap: ${Number.isFinite(config.spendCapUsd) ? `$${config.spendCapUsd}` : 'none (set SPEND_CAP_USD)'}`);
const started = Date.now();
const rows: Awaited<ReturnType<typeof judge>>[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < queue.length) {
      const row = await judge(queue[next++]);
      rows.push(row);
      console.log(`  ${rows.length}/${queue.length} ${row.id} ${row.kind} → ${row.correct === null ? 'no valid split' : row.correct ? 'right' : 'WRONG'}`);
    }
  }),
);
rows.sort((a, b) => a.id.localeCompare(b.id));

const fmt = (s?: Record<Party, number>) => (s ? PARTIES.map((p) => s[p]).join('/') : '-');
const w = Math.max(20, ...kinds.map((k) => k.length));
console.log(`\ncase    ${'kind'.padEnd(w)}  ok   split c/a/m/f   truth c/a/m/f   off`);
for (const r of rows) console.log(`${r.id}  ${r.kind.padEnd(w)}  ${(r.correct === null ? '-' : r.correct ? 'yes' : 'NO').padEnd(3)}  ${fmt(r.split).padEnd(14)}  ${fmt(r.truth).padEnd(14)}  ${r.off ?? '-'}`);
console.log(`\n${'kind'.padEnd(w)}  correct   no split   mean off`);
for (const k of kinds) {
  const mine = rows.filter((r) => r.kind === k);
  const offs = mine.filter((r) => r.off !== undefined).map((r) => r.off!);
  console.log(`${k.padEnd(w)}  ${`${mine.filter((r) => r.correct).length}/${mine.length}`.padEnd(8)}  ${String(mine.filter((r) => r.correct === null).length).padEnd(9)}  ${offs.length ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length) : '-'}`);
}
const offs = rows.filter((r) => r.off !== undefined).map((r) => r.off!);
console.log(`\ncorrect: ${rows.filter((r) => r.correct).length} of ${rows.length}   no valid split: ${rows.filter((r) => r.correct === null).length}   mean off: ${offs.length ? (offs.reduce((a, b) => a + b, 0) / offs.length).toFixed(1) : '-'}`);
const spend = runner.spend;
console.log(`spent: $${spend.usd.toFixed(4)} at list prices (${spend.inputTokens} tokens in, ${spend.outputTokens} out), $${(spend.usd / Math.max(1, rows.length)).toFixed(4)} a case`);

mkdirSync('eval-results', { recursive: true });
const file = `eval-results/baseline-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`;
const meta = { model, reps, seed: config.seed, started: new Date(started).toISOString(), secs: Math.round((Date.now() - started) / 1000), ...(process.env.EVAL_CASES && { cases: process.env.EVAL_CASES }), spentUsd: spend.usd, inputTokens: spend.inputTokens, outputTokens: spend.outputTokens };
writeFileSync(file, JSON.stringify({ meta, rows }, null, 2));
console.log(`every reply: ${file}`);
