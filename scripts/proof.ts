// Headless check: start the engine on a spare port, watch N cases close, and
// print what each agent did and how many inferences overlapped. Usage:
//   npm run proof            (8 cases)
//   npm run proof -- 20
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import type { CaseFile, Lane, Party, ServerMsg, Stats } from '../shared/types';
import { PARTIES, ROLES } from '../shared/types';
import { config } from '../server/config';

// Never wait for more cases than the engine is allowed to open (MAX_CASES).
const want = Math.min(Number(process.argv[2] ?? 8), config.maxCases);
// A real model is slower, and a free-tier key is paced to a few calls a minute. PROOF_TIMEOUT_S overrides.
const limitMs = Number(process.env.PROOF_TIMEOUT_S ?? (config.mode === 'live' ? 900 : 240)) * 1000;
const port = 8799;
const engine = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, ENGINE_PORT: String(port), DISPUTE_EVERY_MS: process.env.DISPUTE_EVERY_MS ?? '1500', APPROVAL_THRESHOLD: '100000' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
engine.stdout.on('data', (d) => process.stdout.write(`  ${d}`));

const cases = new Map<string, CaseFile>();
const lanes = new Map<string, Lane>();
let stats: Stats | undefined;

function finish() {
  const closed = [...cases.values()].filter((c) => c.closedAt).slice(0, want);
  console.log('\ncase    stage    outcome        reason                  split c/a/m/f   truth c/a/m/f   tries     challenged          secs');
  for (const c of closed) {
    const r = c.arbiter.ruling;
    const split = r ? PARTIES.map((p) => r.split[p]).join('/') : '-';
    const truth = c.truth ? PARTIES.map((p) => c.truth![p]).join('/') : '-';
    const attempts = ROLES.map((role) => c.investigators[role].attempts).join(',');
    const challenged = ROLES.filter((role) => c.investigators[role].challenge).map((role) => `${role}:${c.investigators[role].challenge!.stance ?? '?'}`).join(' ') || '-';
    console.log(
      `${c.id}  ${c.stage.padEnd(7)}  ${c.status.padEnd(13)}  ${(r?.reason_code ?? '-').padEnd(22)}  ${split.padEnd(14)}  ${truth.padEnd(14)}  ${attempts.padEnd(8)}  ${challenged.padEnd(18)}  ${((c.closedAt! - c.openedAt) / 1000).toFixed(1)}`,
    );
  }
  // Peak overlap, recomputed here from the raw inference intervals.
  const marks = [...lanes.values()].flatMap((l) => [
    { t: l.start, d: 1 },
    { t: l.end ?? Date.now(), d: -1 },
  ]);
  marks.sort((a, b) => a.t - b.t || a.d - b.d);
  let live = 0;
  let peak = 0;
  for (const m of marks) peak = Math.max(peak, (live += m.d));
  // The engine's own counters cover every case it opened, including ones still running. Everything
  // below the first line is counted from the cases in the table, so the two always agree.
  console.log(`\nwhole run: inferences ${lanes.size}   peak running at once: ${peak}   citations checked: ${stats?.citationsChecked}   rejected: ${stats?.citationsRejected}`);
  const holds = closed.filter((c) => c.stage === 'hold');
  const blocked = holds.filter((c) => c.status === 'blocked');
  const protectedEur = blocked.reduce((n, c) => n + c.purchase.total, 0);
  console.log(`cases above: held ${holds.length}   blocked ${blocked.length}   released ${holds.filter((c) => c.status === 'released').length}   value protected: €${protectedEur.toFixed(2)}`);
  const challenged = closed.flatMap((c) => ROLES.map((role) => c.investigators[role].challenge).filter((ch) => ch !== undefined));
  console.log(`challenges between investigators: ${challenged.length}   findings revised: ${challenged.filter((ch) => ch.stance === 'revise').length}`);
  // A payment the network blocked on a learned signature was decided by a match, not by the team.
  const byNetwork = closed.filter((c) => c.network);
  const team = closed.filter((c) => !c.network && c.truth && c.arbiter.ruling);
  const top = (s: Record<Party, number>) => PARTIES.reduce((a, b) => (s[b] > s[a] ? b : a));
  const right = team.filter((c) => (c.stage === 'hold' ? (c.status === 'blocked') === c.truth!.customer < 100 : top(c.arbiter.ruling!.split) === top(c.truth!)));
  console.log(`decided by the team: ${right.length} of ${team.length} match the ground truth   blocked by the network on a learned signature: ${byNetwork.length}`);
  console.log('this shows the system working; for accuracy by kind of case, use npm run eval');
  engine.kill();
  process.exit(0);
}

function connect(tries = 0) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on('error', () => (tries < 40 ? setTimeout(() => connect(tries + 1), 250) : (engine.kill(), process.exit(1))));
  ws.on('message', (raw) => {
    const msg: ServerMsg = JSON.parse(String(raw));
    if (msg.type === 'case') cases.set(msg.case.id, msg.case);
    if (msg.type === 'lane') lanes.set(msg.lane.loopId, msg.lane);
    if (msg.type === 'stats') stats = msg.stats;
    if ([...cases.values()].filter((c) => c.closedAt).length >= want && stats && stats.scored >= want) finish();
  });
}
connect();
setTimeout(() => {
  console.error(`timed out after ${limitMs / 1000}s`);
  finish();
}, limitMs);
