// How often does the team rule correctly? Start the engine with no stream and no network learning,
// run every kind of case the same number of times, and score each ruling against the scenario's
// ground truth. Writes every case to eval-results/. Usage:
//   npm run eval             (each of the 12 kinds once)
//   npm run eval -- 3        (each kind 3 times)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { CaseFile, Lane, Party, Sabotage, ServerMsg } from '../shared/types';
import { PARTIES, ROLES, SCENARIOS } from '../shared/types';
import { config } from '../server/config';

// The same kinds the stream draws from: every fault as a dispute, every fault the screen can catch as a hold, and a clean hold.
const KINDS: { sabotage: Sabotage; stage: 'hold' | 'dispute' }[] = [
  ...SCENARIOS.map((sabotage) => ({ sabotage, stage: 'dispute' as const })),
  ...SCENARIOS.filter((x) => x !== 'friendly').map((sabotage) => ({ sabotage, stage: 'hold' as const })),
  { sabotage: 'clean', stage: 'hold' },
];
const reps = Math.max(1, Number(process.argv[2] ?? 1));
const queue = KINDS.flatMap((k) => Array.from({ length: reps }, () => k));
const total = queue.length;
const open = Number(process.env.MAX_OPEN_CASES ?? (config.mode === 'live' ? 2 : 4));
const limitMs = Number(process.env.EVAL_TIMEOUT_S ?? (config.mode === 'live' ? 900 * reps : 300)) * 1000;
const port = 8798;

console.log(`eval: ${total} cases (${KINDS.length} kinds × ${reps}), ${open} at a time, ${config.mode === 'live' ? `investigators ${config.investigatorModel}, arbiter ${config.arbiterModel}` : 'scripted stand-in'}`);
if (config.mode === 'scripted') console.log('scripted mode: the stand-in was written by the same hand as the scenarios, so this score says nothing about a real model.');

const engine = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, ENGINE_PORT: String(port), STREAM: 'off', NETWORK: 'off', APPROVAL_THRESHOLD: '100000', MAX_CASES: String(total) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
engine.stdout.on('data', (d) => process.stdout.write(`  ${d}`));

const kindOf = new Map<string, string>(); // case id -> "sabotage/stage"
const cases = new Map<string, CaseFile>();
const lanes = new Map<string, Lane>();
let sent = 0;
const started = Date.now();

const top = (s: Record<Party, number>) => PARTIES.reduce((a, b) => (s[b] > s[a] ? b : a));
// Share of the loss put on the wrong party: 0 is the ground truth exactly, 100 is all of it misplaced.
const distance = (a: Record<Party, number>, b: Record<Party, number>) => PARTIES.reduce((n, p) => n + Math.abs(a[p] - b[p]), 0) / 2;

interface Row {
  id: string;
  kind: string;
  status: string;
  correct: boolean | null; // null: no ruling, so nothing to score
  split?: Record<Party, number>;
  truth?: Record<Party, number>;
  off?: number;
  attempts: number[];
  rejected: number; // findings the verifier sent back
  calls: number; // model calls made for this case
  secs: number;
}

function score(c: CaseFile): Row {
  const r = c.arbiter.ruling;
  const truth = c.truth;
  let correct: boolean | null = null;
  if (r && truth) correct = c.stage === 'hold' ? (c.status === 'blocked') === truth.customer < 100 : top(r.split) === top(truth);
  return {
    id: c.id,
    kind: kindOf.get(c.id)!,
    status: c.status,
    correct,
    split: r?.split,
    truth,
    off: r && truth ? distance(r.split, truth) : undefined,
    attempts: ROLES.map((role) => c.investigators[role].attempts),
    rejected: c.log.filter((l) => l.who === 'Verifier' && l.text.startsWith('rejected')).length,
    calls: [...lanes.values()].filter((l) => l.caseId === c.id).length,
    secs: Math.round((c.closedAt! - c.openedAt) / 100) / 10,
  };
}

function finish(timedOut = false) {
  const rows = [...kindOf.keys()].map((id) => cases.get(id)).filter((c): c is CaseFile => !!c?.closedAt).map(score);
  const fmt = (s?: Record<Party, number>) => (s ? PARTIES.map((p) => s[p]).join('/') : '-');
  console.log('\ncase    kind                  status          ok   split c/a/m/f   truth c/a/m/f   off  rejected  secs');
  for (const r of rows) {
    const ok = r.correct === null ? '-' : r.correct ? 'yes' : 'NO';
    console.log(`${r.id}  ${r.kind.padEnd(20)}  ${r.status.padEnd(14)}  ${ok.padEnd(3)}  ${fmt(r.split).padEnd(14)}  ${fmt(r.truth).padEnd(14)}  ${String(r.off ?? '-').padEnd(3)}  ${String(r.rejected).padEnd(8)}  ${r.secs}`);
  }
  console.log('\nkind                  correct   no ruling   mean off');
  for (const k of KINDS) {
    const name = `${k.sabotage}/${k.stage}`;
    const mine = rows.filter((r) => r.kind === name);
    const scored = mine.filter((r) => r.correct !== null);
    const offs = scored.map((r) => r.off!);
    const mean = offs.length ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length) : '-';
    console.log(`${name.padEnd(20)}  ${`${scored.filter((r) => r.correct).length}/${mine.length}`.padEnd(8)}  ${String(mine.length - scored.length).padEnd(10)}  ${mean}`);
  }
  const right = rows.filter((r) => r.correct).length;
  console.log(`\ncorrect: ${right} of ${total}   closed without a ruling: ${rows.filter((r) => r.correct === null).length}   not finished: ${total - rows.length}   model calls: ${lanes.size}`);
  if (timedOut) console.log(`timed out after ${limitMs / 1000}s (EVAL_TIMEOUT_S)`);

  mkdirSync('eval-results', { recursive: true });
  const file = `eval-results/${config.mode}-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`;
  const meta = { mode: config.mode, ...(config.mode === 'live' && { investigatorModel: config.investigatorModel, arbiterModel: config.arbiterModel }), reps, seed: config.seed, started: new Date(started).toISOString(), secs: Math.round((Date.now() - started) / 1000) };
  writeFileSync(file, JSON.stringify({ meta, rows, cases: [...kindOf.keys()].map((id) => cases.get(id)).filter(Boolean) }, null, 2));
  console.log(`every case, with its findings and log: ${file}`);
  engine.kill();
  process.exit(0);
}

function connect(tries = 0) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on('error', () => (tries < 40 ? setTimeout(() => connect(tries + 1), 250) : (engine.kill(), process.exit(1))));
  // Keep a few cases open at once, as the stream does, so a paced key is not flooded.
  const topUp = () => {
    const running = sent - [...kindOf.keys()].filter((id) => cases.get(id)?.closedAt).length; // counts cases asked for but not yet created
    for (let i = running; i < open && sent < total; i++) {
      const k = queue[sent];
      ws.send(JSON.stringify({ type: 'trigger', scenario: k.sabotage, stage: k.stage, nonce: `${sent++}:${k.sabotage}/${k.stage}` }));
    }
  };
  ws.on('open', topUp);
  ws.on('message', (raw) => {
    const msg: ServerMsg = JSON.parse(String(raw));
    if (msg.type === 'created') kindOf.set(msg.caseId, msg.nonce.split(':')[1]);
    if (msg.type === 'lane') lanes.set(msg.lane.loopId, msg.lane);
    if (msg.type !== 'case' || !kindOf.has(msg.case.id)) return;
    const was = cases.get(msg.case.id)?.closedAt;
    cases.set(msg.case.id, msg.case);
    if (msg.case.closedAt && !was) {
      const done = [...kindOf.keys()].filter((id) => cases.get(id)?.closedAt).length;
      console.log(`  ${done}/${total} closed: ${msg.case.id} ${kindOf.get(msg.case.id)} → ${msg.case.status}`);
      if (done === total) finish();
      else topUp();
    }
  });
}
connect();
setTimeout(() => finish(true), limitMs);
