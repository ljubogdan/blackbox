import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sabotage } from '../shared/types';
import { assembleTeam } from '../server/agents/team';
import { buildCase } from '../server/data/scenarios';
import { GuardedRunner } from '../server/model/guard';
import { ScriptedRunner } from '../server/model/scripted';
import { stripeGateway, type PaymentGateway } from '../server/payments/stripe';
import { Rng } from '../server/rng';
import { initializeRuntime, publish, state } from '../server/runtime';
import { BlackboxState } from '../server/state';

// What reaches Stripe. The gateway is checked against a fake fetch, and the Payments participant
// against a fake gateway while the whole team rules on the scripted model, so no network is used.

test('only a Stripe test key is accepted', () => {
  assert.throws(() => stripeGateway('sk_live_abc'), /test key/);
  assert.throws(() => stripeGateway('pk_test_abc'), /test key/);
  assert.doesNotThrow(() => stripeGateway('sk_test_abc'));
  assert.doesNotThrow(() => stripeGateway('rk_test_abc'));
});

test('a hold is authorised without capture, once per case, and a refund names its amount', async () => {
  const sent: { url: string; body: URLSearchParams; key?: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: new URLSearchParams(String(init.body)), key: (init.headers as Record<string, string>)['Idempotency-Key'] });
    return new Response(JSON.stringify({ id: url.endsWith('refunds') ? 're_1' : 'pi_1' }), { status: 200 });
  }) as typeof fetch;
  const gateway = stripeGateway('sk_test_abc', fake, 'run1');

  assert.equal(await gateway.authorise('C-0001', 12345, 'test'), 'pi_1');
  assert.equal(sent[0].url, 'https://api.stripe.com/v1/payment_intents');
  assert.equal(sent[0].body.get('amount'), '12345');
  assert.equal(sent[0].body.get('currency'), 'eur');
  assert.equal(sent[0].body.get('capture_method'), 'manual');
  assert.equal(sent[0].body.get('metadata[blackbox_case]'), 'C-0001');
  assert.equal(sent[0].key, 'blackbox-run1-C-0001-manual');

  assert.equal(await gateway.refund('pi_1', 4200), 're_1');
  assert.equal(sent[1].body.get('payment_intent'), 'pi_1');
  assert.equal(sent[1].body.get('amount'), '4200');
});

test('a Stripe error comes back with its message', async () => {
  const fake = (async () => new Response(JSON.stringify({ error: { message: 'Your card was declined.' } }), { status: 402 })) as unknown as typeof fetch;
  await assert.rejects(stripeGateway('sk_test_abc', fake).charge('C-0001', 100, 'test'), /declined/);
});

// The team on the scripted model, with a gateway that records what it was asked to do.
const calls: string[] = [];
let n = 0;
const recording: PaymentGateway = {
  authorise: async (ref, cents) => (calls.push(`authorise ${ref} ${cents}`), `pi_${++n}`),
  charge: async (ref, cents) => (calls.push(`charge ${ref} ${cents}`), `pi_${++n}`),
  capture: async (id) => void calls.push(`capture ${id}`),
  cancel: async (id) => void calls.push(`cancel ${id}`),
  refund: async (id, cents) => (calls.push(`refund ${id} ${cents}`), `re_${id}`),
};
initializeRuntime({ state: new BlackboxState(), inferenceRunnerConfig: { runner: new GuardedRunner(new ScriptedRunner(7, 0), 64) } });
const team = assembleTeam(recording);
const rng = new Rng(11);
let caseN = 0;

async function run(sabotage: Sabotage, stage: 'hold' | 'dispute') {
  const { caseFile } = buildCase(rng, ++caseN, sabotage, caseN, Date.now(), { stage });
  const s = state();
  for (const e of caseFile.evidence) s.evidence.set(e.id, e);
  s.cases.set(caseFile.id, caseFile);
  if (stage === 'hold') publish('purchase.pending', team.intake.getId(), { purchase: caseFile.purchase, caseId: caseFile.id });
  else publish('dispute.opened', team.intake.getId(), { caseId: caseFile.id });
  const done = () => ['captured', 'cancelled', 'refunded', 'left_authorised', 'failed'].includes(caseFile.payment?.status ?? '') || (caseFile.payment?.status === 'charged' && caseFile.log.some((l) => l.text.startsWith('no refund')));
  // The scripted model takes 0.65 to 1.9 s a call, like a real one, and a dispute takes several.
  for (let i = 0; i < 1200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  const cents = Math.round(Number(caseFile.evidence.find((e) => e.kind === 'ORD')!.data.total) * 100);
  return { c: caseFile, cents, mine: calls.filter((l) => l.includes(caseFile.id) || l.includes(caseFile.payment?.id ?? '-')) };
}

test('a blocked hold is cancelled in Stripe, and nothing is captured', async () => {
  const { c, cents, mine } = await run('quantity', 'hold');
  assert.equal(c.status, 'blocked');
  assert.deepEqual(mine, [`authorise ${c.id} ${cents}`, `cancel ${c.payment!.id}`]);
  assert.equal(c.payment!.status, 'cancelled');
});

test('a hold the team clears is captured', async () => {
  const { c, cents, mine } = await run('clean', 'hold');
  assert.equal(c.status, 'released');
  assert.deepEqual(mine, [`authorise ${c.id} ${cents}`, `capture ${c.payment!.id}`]);
});

test("a ruled dispute is refunded by exactly the Ledger's refund line", async () => {
  const { c, cents, mine } = await run('price_switch', 'dispute');
  assert.equal(c.status, 'ruled');
  const refund = Math.round(c.settlement!.find((l) => l.label === 'Refund to customer')!.amount * 100);
  assert.ok(refund > 0);
  assert.deepEqual(mine, [`charge ${c.id} ${cents}`, `refund ${c.payment!.id} ${refund}`]);
});

test('a denied claim keeps the charge and refunds nothing', async () => {
  const { c, mine } = await run('friendly', 'dispute');
  assert.equal(c.status, 'ruled');
  assert.equal(mine.filter((l) => l.startsWith('refund')).length, 0);
  assert.equal(c.payment!.status, 'charged');
});
