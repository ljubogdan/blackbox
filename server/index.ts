import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join as joinPath, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultInferenceRunner, supportedModels } from '@mozaik-ai/core';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, EngineInfo, Sabotage, ServerMsg } from '../shared/types';
import { SCENARIOS } from '../shared/types';
import { assembleTeam } from './agents/team';
import { tamperCheck } from './agents/verify';
import { config } from './config';
import { buildCase, buildPurchase, cloneWithLimit, type BuildOptions } from './data/scenarios';
import { CATALOG, MERCHANTS, WIDGET_DOMAINS } from './data/world';
import { GeminiSignatures } from './model/gemini';
import { GuardedRunner } from './model/guard';
import { localModels } from './model/local';
import { isTestKey, stripeGateway } from './payments/stripe';
import { ScriptedRunner } from './model/scripted';
import { Rng } from './rng';
import { initializeRuntime, publish, state } from './runtime';
import { BlackboxState, ui } from './state';

// Mozaik's cloud client repeats this notice for every loop; once is enough.
const warn = console.warn;
let toldAboutCloud = false;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('mozaik cloud: no API key')) {
    if (toldAboutCloud) return;
    toldAboutCloud = true;
  }
  warn(...args);
};

// A stray rejection inside an agent loop must not take the whole room down.
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

const models = config.localBaseUrl
  ? [...supportedModels, ...localModels(config.localBaseUrl, [config.investigatorModel, config.arbiterModel, ...config.fallbackModels])]
  : supportedModels;
const inner =
  config.mode === 'live'
    ? new GeminiSignatures(new DefaultInferenceRunner(models, { validate() {} } as never), models)
    : new ScriptedRunner(config.seed, config.faultRate);
const runner = new GuardedRunner(inner, config.maxConcurrentInferences, 14, config.inferenceTimeoutMs, config.maxRpm, { fallbacks: config.fallbackModels });

initializeRuntime({ state: new BlackboxState(), inferenceRunnerConfig: { runner } });
if (config.stripeKey && !isTestKey(config.stripeKey)) console.error('STRIPE_SECRET_KEY is not a test key, so Stripe stays off: Blackbox never moves real money.');
const gateway = config.stripeKey && isTestKey(config.stripeKey) ? stripeGateway(config.stripeKey) : undefined;
const team = assembleTeam(gateway);
const rng = new Rng(config.seed);

const info: EngineInfo = {
  mode: config.mode,
  model: config.mode === 'live' ? `${config.investigatorModel} + ${config.arbiterModel}` : 'scripted stand-in (no API key)',
  faultRate: config.faultRate,
  approvalThreshold: config.approvalThreshold,
  participants: team.roster,
};

// ───────────────────────── synthetic Black Friday stream ─────────────────────────

let purchaseN = 0;
let caseN = 0;
let paused = false;
let bag: { sabotage: Sabotage; stage: 'hold' | 'dispute' }[] = [];

// One round of the bag: every kind of fault once as a dispute after the fact,
// every kind the screen can catch once as a hold, and one clean payment that
// gets held and released.
function nextScenario() {
  if (bag.length === 0) {
    bag = [
      ...SCENARIOS.map((sabotage) => ({ sabotage, stage: 'dispute' as const })),
      ...SCENARIOS.filter((x) => x !== 'friendly').map((sabotage) => ({ sabotage, stage: 'hold' as const })),
      { sabotage: 'clean' as const, stage: 'hold' as const },
    ].sort(() => rng.next() - 0.5);
  }
  return bag.pop()!;
}

function remember(p: ReturnType<typeof buildPurchase>) {
  const s = state();
  s.purchases.push(p);
  if (s.purchases.length > 90) s.purchases.shift();
}

function tickPurchase() {
  if (!paused) {
    const p = buildPurchase(rng, ++purchaseN, Date.now());
    remember(p);
    publish('purchase.settled', team.intake.getId(), { purchase: p });
  }
  setTimeout(tickPurchase, rng.range(260, 800));
}

function register(caseFile: ReturnType<typeof buildCase>['caseFile']) {
  const s = state();
  for (const e of caseFile.evidence) s.evidence.set(e.id, e);
  s.cases.set(caseFile.id, caseFile);
}

function openCase(sabotage: Sabotage, opts: BuildOptions = {}, custom = false): string | null {
  if (caseN >= config.maxCases) return null;
  const s = state();
  const { caseFile, truth } = buildCase(rng, ++caseN, sabotage, ++purchaseN, Date.now(), opts);
  caseFile.custom = custom || undefined;
  register(caseFile);
  // A limit set by hand changes what the right answer is, so there is no ground truth to score against.
  if (opts.max === undefined) s.truths.set(caseFile.id, truth);
  remember(caseFile.purchase);
  if (caseFile.stage === 'hold') {
    // Not settled yet: the Sentinel decides whether to stop it.
    publish('purchase.pending', team.intake.getId(), { purchase: caseFile.purchase, caseId: caseFile.id });
  } else {
    s.stats.disputesOpened++;
    publish('purchase.settled', team.intake.getId(), { purchase: caseFile.purchase });
    publish('dispute.opened', team.intake.getId(), { caseId: caseFile.id });
  }
  return caseFile.id;
}

// Run an existing case again with a different spending limit.
function whatIf(caseId: string, max: number): string | null {
  const s = state();
  const source = s.cases.get(caseId);
  if (!source || caseN >= config.maxCases) return null;
  const clone = cloneWithLimit(source, ++caseN, Math.max(10, Math.min(5000, Math.round(max))), Date.now());
  register(clone);
  if (clone.stage === 'hold') {
    publish('purchase.pending', team.intake.getId(), { purchase: { ...clone.purchase, id: `${clone.purchase.id}-${clone.id}` }, caseId: clone.id });
  } else {
    s.stats.disputesOpened++;
    publish('dispute.opened', team.intake.getId(), { caseId: clone.id });
  }
  return clone.id;
}

// Items cheap enough that no scenario takes the order to the approval threshold (the worst case is four units, about 4.2x the price).
const SMALL_ITEMS = CATALOG.map((c, i) => ({ i, price: c.price }))
  .filter((c) => c.price * 4.4 < config.approvalThreshold)
  .map((c) => c.i);

// ───────────────────────── attack campaigns ─────────────────────────
// Real attacks are not one-offs: the same widget is embedded in many shops, the
// same stolen-token farm spends at many merchants. A campaign keeps its source
// and lands at a different merchant each time, so once a ruling teaches the
// network its signature, the next landing is caught on arrival.

interface Campaign {
  kind: 'injection' | 'hijack';
  source: string;
  hit: Set<string>; // merchants it has already landed at
}
const campaigns: Campaign[] = [];

const newSource = (kind: Campaign['kind']) =>
  kind === 'injection'
    ? rng.pick(WIDGET_DOMAINS.filter((d) => !campaigns.some((c) => c.source === d))) ?? `widget-${rng.int(100, 999)}.example`
    : `${rng.pick(['vm-chrome', 'headless-linux', 'emulator-android'])}-${rng.int(0x1000, 0xffff).toString(16)}`;

const signatureOf = (c: Campaign) => `${c.kind === 'injection' ? 'widget' : 'device'}:${c.source}`;
const unhit = (c: Campaign) => MERCHANTS.filter((m) => !c.hit.has(m.name));

// Where the next attack of this kind comes from: usually a campaign still being learned, sometimes a new one.
function campaignFor(kind: Campaign['kind']): Campaign {
  const open = campaigns.filter((c) => c.kind === kind && unhit(c).length > 0 && !state().signatures.has(signatureOf(c)));
  if (open.length && rng.next() < 0.5) return rng.pick(open);
  const c: Campaign = { kind, source: newSource(kind), hit: new Set() };
  campaigns.push(c);
  return c;
}

function land(c: Campaign, opts: BuildOptions) {
  const target = rng.pick(unhit(c));
  c.hit.add(target.name);
  return openCase(c.kind, { ...opts, merchant: target.name, source: c.source });
}

// A learned campaign keeps trying other merchants. These are the payments the network stops.
function networkTick() {
  if (paused) return;
  const learned = campaigns.filter((c) => state().signatures.has(signatureOf(c)) && unhit(c).length > 0);
  if (learned.length) land(rng.pick(learned), { stage: 'hold' });
}

function disputeTick() {
  if (paused) return;
  const open = [...state().cases.values()].filter((c) => c.status === 'investigating' || c.status === 'arbitrating').length;
  if (open >= config.maxOpenCases) return;
  const next = nextScenario();
  // A person can only review so much. While enough rulings are waiting for one, the stream keeps
  // new disputes to small orders, which the arbiter may rule on alone.
  const waiting = [...state().cases.values()].filter((c) => c.status === 'awaiting_approval').length;
  const item = next.stage === 'dispute' && waiting >= config.maxAwaiting ? rng.pick(SMALL_ITEMS) : undefined;
  if (next.sabotage === 'injection' || next.sabotage === 'hijack') land(campaignFor(next.sabotage), { stage: next.stage, item });
  else openCase(next.sabotage, { stage: next.stage, item });
}

// ───────────────────────── http + websocket ─────────────────────────

const dist = joinPath(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = joinPath(dist, path === '/' ? 'index.html' : path);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = joinPath(dist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Blackbox engine is running. Start the UI with `npm run dev`, or build it with `npm run build`.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const send = (ws: WebSocket, msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

ui.on('msg', (msg: ServerMsg) => {
  const raw = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(raw);
});

wss.on('connection', (ws) => {
  const s = state();
  send(ws, {
    type: 'hello',
    info,
    stats: { ...s.stats },
    cases: [...s.cases.values()],
    purchases: s.purchases,
    lanes: s.lanes.slice(-200),
    signatures: [...s.signatures.values()],
    now: Date.now(),
  });
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'approve') {
      // The human's decision enters the runtime as an event from the Risk officer.
      publish('approval.decided', team.officer.getId(), { caseId: msg.caseId, approved: !!msg.approved });
    } else if (msg.type === 'trigger' && (msg.scenario === 'clean' || (SCENARIOS as readonly string[]).includes(msg.scenario))) {
      const id = openCase(msg.scenario as Sabotage, msg.stage ? { stage: msg.stage === 'hold' ? 'hold' : 'dispute' } : {});
      if (id && msg.nonce) send(ws, { type: 'created', caseId: id, nonce: String(msg.nonce) });
    } else if (msg.type === 'custom') {
      const { item, max, sabotage, stage } = msg.spec ?? ({} as never);
      const valid = sabotage === 'clean' || (SCENARIOS as readonly string[]).includes(sabotage);
      const id = valid ? openCase(sabotage, { item: Number(item), max: Number.isFinite(Number(max)) ? Number(max) : undefined, stage: stage === 'hold' ? 'hold' : 'dispute' }, true) : null;
      if (id) send(ws, { type: 'created', caseId: id, nonce: String(msg.nonce) });
    } else if (msg.type === 'whatif') {
      const id = whatIf(String(msg.caseId), Number(msg.max));
      if (id) send(ws, { type: 'created', caseId: id, nonce: String(msg.nonce) });
    } else if (msg.type === 'tamper') {
      const c = state().cases.get(String(msg.caseId));
      const result = c ? tamperCheck(c, String(msg.evidenceId), String(msg.field), msg.value) : null;
      if (result) send(ws, { type: 'tampered', nonce: String(msg.nonce), result });
    } else if (msg.type === 'pace') {
      paused = !!msg.paused;
    }
  });
});

server.listen(config.port, () => {
  console.log(`Blackbox engine on http://localhost:${config.port}  ·  mode: ${info.mode}  ·  model: ${info.model}`);
  console.log(`Participants: ${team.roster.map((p) => `${p.name} (${p.kind})`).join(', ')}`);
  if (gateway) console.log(`Stripe test mode, run ${gateway.run}: every case's money is mirrored at https://dashboard.stripe.com/test/payments`);
  if (!config.stream) return;
  tickPurchase();
  setTimeout(() => openCase('injection', { stage: 'hold' }), 1800);
  setInterval(disputeTick, config.disputeEveryMs);
  setInterval(networkTick, config.disputeEveryMs * 2.2);
});
