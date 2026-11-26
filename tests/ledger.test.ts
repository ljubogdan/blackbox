import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InferenceRunner } from '@mozaik-ai/core';
import type { CaseFile, Party, Ruling, Sabotage, SettlementLine } from '../shared/types';
import { assembleTeam, settle } from '../server/agents/team';
import { buildCase, type BuildOptions } from '../server/data/scenarios';
import { Rng } from '../server/rng';
import { initializeRuntime, publish, state } from '../server/runtime';
import { BlackboxState } from '../server/state';

// No model produces a money amount: the Arbiter gives percentages and the Ledger does the sums.
// These tests check the sums, first on their own and then through the Ledger participant.

const NOW = 1_700_000_000_000;
const rng = new Rng(11);
let caseN = 0;

const split = (customer: number, agent_provider: number, merchant: number, fraud: number): Record<Party, number> => ({ customer, agent_provider, merchant, fraud });
const ruling = (s: Record<Party, number>): Ruling => ({ split: s, reason_code: 'TEST', rationale: 'test ruling' });
const cents = (n: number) => Math.round(n * 100);
const order = (c: CaseFile) => c.evidence.find((e) => e.kind === 'ORD')!;

function aCase(sabotage: Sabotage = 'quantity', opts: BuildOptions = {}, total?: number) {
  const { caseFile } = buildCase(rng, ++caseN, sabotage, caseN, NOW, opts);
  if (total !== undefined) {
    order(caseFile).data.total = total;
    caseFile.purchase.total = total;
  }
  return caseFile;
}

// ───────────────────────── the sums ─────────────────────────

test('full fault of the agent provider: the customer is refunded and the provider pays all of it', () => {
  const c = aCase();
  const total = Number(order(c).data.total);
  const lines = settle(c, ruling(split(0, 100, 0, 0)));
  assert.deepEqual(
    lines.map((l) => [l.party, l.amount]),
    [
      ['customer', total],
      ['agent_provider', total],
    ],
  );
  assert.equal(lines[0].label, 'Refund to customer');
  assert.equal(lines[1].label, `Recovered from ${c.purchase.provider}`);
});

test('a claim the customer loses refunds nothing and charges nobody', () => {
  const lines = settle(aCase('friendly'), ruling(split(100, 0, 0, 0)));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, 'Claim denied — no refund');
  assert.equal(lines[0].amount, 0);
});

test('fraud is absorbed by the guarantee, not charged to a party', () => {
  const c = aCase('hijack');
  const lines = settle(c, ruling(split(0, 0, 0, 100)));
  assert.deepEqual(lines.map((l) => l.party), ['customer', 'guarantee']);
  assert.equal(lines[1].amount, Number(order(c).data.total));
});

test('every line names the order record it was computed from and shows the calculation', () => {
  const c = aCase('hidden_fee', {}, 400);
  for (const line of settle(c, ruling(split(10, 50, 40, 0)))) {
    assert.equal(line.source, `${order(c).id}.total`);
    assert.match(line.formula, /^€400\.00 × \d+%$/);
  }
});

test('a shared ruling splits the refund without losing or inventing a cent', () => {
  // €282.77 at 50/50 is €141.385 each. Rounded separately that is €141.39 twice: one cent too many.
  const lines = settle(aCase('hidden_fee', {}, 282.77), ruling(split(0, 50, 50, 0)));
  assert.equal(lines[0].amount, 282.77);
  assert.deepEqual(lines.slice(1).map((l) => l.amount).sort(), [141.38, 141.39]);
});

test('for any order and any split, what is recovered and absorbed adds up to the refund', () => {
  const splits = [split(0, 59, 41, 0), split(0, 50, 50, 0), split(0, 33, 33, 34), split(10, 45, 45, 0), split(25, 25, 25, 25), split(1, 33, 33, 33), split(0, 1, 99, 0), split(97, 1, 1, 1)];
  const check = (total: number, s: Record<Party, number>) => {
    const lines = settle(aCase('hidden_fee', {}, total), ruling(s));
    const [refund, ...paid] = lines;
    const where = `total ${total}, split ${JSON.stringify(s)}`;
    assert.equal(cents(refund.amount), Math.round((cents(total) * (100 - s.customer)) / 100), `refund for ${where}`);
    assert.equal(
      paid.reduce((sum, l) => sum + cents(l.amount), 0),
      cents(refund.amount),
      `lines for ${where}`,
    );
    for (const line of paid) {
      const pct = line.party === 'guarantee' ? s.fraud : s[line.party as Party];
      assert.ok(Math.abs(cents(line.amount) - (cents(total) * pct) / 100) < 1, `${line.label} is within a cent of its share for ${where}`);
      assert.ok(Number.isInteger(cents(line.amount)) && Math.abs(line.amount * 100 - cents(line.amount)) < 1e-6, 'amounts are whole cents');
    }
  };
  const money = new Rng(5);
  for (let i = 0; i < 400; i++) for (const s of splits) check(Math.round(money.range(5, 2500) * 100) / 100, s);
  for (const total of [0.01, 0.03, 0.99, 1, 33.33, 99.99, 4999.99]) for (const s of splits) check(total, s);
});

// ───────────────────────── the Ledger participant ─────────────────────────

const noModel: InferenceRunner = {
  run: async () => {
    throw new Error('the Ledger must not call a model');
  },
  async *stream() {},
};
initializeRuntime({ state: new BlackboxState(), inferenceRunnerConfig: { runner: noModel } });
const team = assembleTeam();

// Put a case on file with a ruling already made, and announce the ruling the way the Arbiter does.
function rule(c: CaseFile, s: Record<Party, number>) {
  const st = state();
  for (const e of c.evidence) st.evidence.set(e.id, e);
  st.cases.set(c.id, c);
  c.arbiter = { status: 'done', ruling: ruling(s) };
  publish('ruling.issued', team.intake.getId(), { caseId: c.id });
  return c;
}
const amounts = (lines: SettlementLine[] | undefined) => (lines ?? []).map((l) => l.amount);

test('a ruling on a dispute is settled, closed and added to the running totals', () => {
  const before = { ...state().stats };
  const c = rule(aCase('hidden_fee', {}, 282.77), split(0, 50, 30, 20));
  assert.equal(c.status, 'ruled');
  assert.ok(c.closedAt);
  assert.deepEqual(amounts(c.settlement), [282.77, 141.39, 84.83, 56.55]);
  const after = state().stats;
  assert.equal(cents(after.refunds - before.refunds), 28277);
  assert.equal(cents(after.recovered - before.recovered), 14139 + 8483);
  assert.equal(cents(after.absorbed - before.absorbed), 5655);
});

test('a ruling is settled once: announcing it again moves no more money', () => {
  const c = rule(aCase(), split(0, 100, 0, 0));
  const once = { ...state().stats };
  publish('ruling.issued', team.intake.getId(), { caseId: c.id });
  assert.equal(state().stats.refunds, once.refunds);
  assert.equal(state().stats.recovered, once.recovered);
});

test('a held payment that is ruled against is blocked in full, and counted as loss prevented', () => {
  const before = { ...state().stats };
  const c = rule(aCase('injection', { stage: 'hold' }), split(0, 100, 0, 0));
  const total = Number(order(c).data.total);
  assert.equal(c.status, 'blocked');
  assert.deepEqual(amounts(c.settlement), [total]);
  assert.equal(c.settlement![0].source, `${order(c).id}.total`);
  const after = state().stats;
  assert.equal(after.blocked - before.blocked, 1);
  assert.equal(cents(after.prevented - before.prevented), cents(total));
  // Nothing settled, so nothing is refunded or recovered and the order is not booked as a sale.
  assert.equal(after.refunds, before.refunds);
  assert.equal(after.recovered, before.recovered);
  assert.equal(after.gmv, before.gmv);
});

test('a held payment that is cleared is released and booked as a normal sale', () => {
  const before = { ...state().stats };
  const c = rule(aCase('clean', { stage: 'hold' }), split(100, 0, 0, 0));
  const total = Number(order(c).data.total);
  assert.equal(c.status, 'released');
  assert.deepEqual(amounts(c.settlement), [total]);
  const after = state().stats;
  assert.equal(after.released - before.released, 1);
  assert.equal(after.prevented, before.prevented);
  assert.equal(cents(after.gmv - before.gmv), cents(total));
});

test("a ruling raises the price of the guarantee for the party at fault, and nobody else's", () => {
  const c = aCase('quantity', {}, 500);
  // A disputed purchase settled first, so it is already on the books when the ruling arrives.
  publish('purchase.settled', team.intake.getId(), { purchase: c.purchase });
  const row = (kind: 'providers' | 'merchants', name: string) => state().stats.board[kind].find((r) => r.name === name)!;
  const merchantName = String(order(c).data.merchant);
  const before = { provider: row('providers', c.purchase.provider).atFault, merchant: row('merchants', merchantName).atFault };

  rule(c, split(0, 100, 0, 0));
  const provider = row('providers', c.purchase.provider);
  assert.equal(cents(provider.atFault - before.provider), 50000);
  assert.ok(provider.bps > state().stats.premiumBps, 'the provider at fault pays more than the base rate');
  assert.equal(row('merchants', merchantName).atFault, before.merchant);
});
