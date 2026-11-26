import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InputTokenDetails, ModelContext, ModelMessageItem, OutputTokenDetails, TokenUsage, type InferenceOutput, type InferenceRunner } from '@mozaik-ai/core';
import { screen } from '../server/agents/sentinel';
import { buildHeldOut, heldOutProblems, type HeldOutCase } from '../server/data/heldout';
import { chainIntegrity } from '../server/data/scenarios';
import { callCost } from '../server/model/cost';
import { GuardedRunner } from '../server/model/guard';

// Cases written by hand, the meter that prices model calls, and the cap that stops a run.

const examples: HeldOutCase[] = JSON.parse(readFileSync('heldout/example.json', 'utf8'));
const copy = (c: HeldOutCase): HeldOutCase => JSON.parse(JSON.stringify(c));

test('the example cases have no problems', () => {
  for (const c of examples) assert.deepEqual(heldOutProblems(c), []);
});

test('a hand-written case becomes a sealed case file, with its truth kept apart', () => {
  const { caseFile, truth } = buildHeldOut(examples[0], 7, 7, Date.now());
  assert.equal(caseFile.id, 'C-0007');
  assert.equal(chainIntegrity(caseFile.evidence).ok, true);
  assert.deepEqual(caseFile.evidence.map((e) => e.kind), ['MND', 'TRL', 'TRL', 'TRL', 'TRL', 'TRL', 'LST', 'ORD', 'SES', 'DLV', 'CLM']);
  assert.equal(caseFile.truth, undefined);
  assert.deepEqual(truth, examples[0].truth);
  assert.equal(caseFile.investigators.intent.status, 'queued');
});

test('a hold has no claim, skips the Claim Examiner, and is stopped by the screen', () => {
  const { caseFile } = buildHeldOut(examples[1], 1, 1, Date.now());
  assert.equal(caseFile.claim, '');
  assert.equal(caseFile.investigators.intent.status, 'skipped');
  assert.ok(!caseFile.evidence.some((e) => e.kind === 'CLM' || e.kind === 'DLV'));
  assert.ok(screen(caseFile));
});

test('a case with mistakes is refused with every mistake named', () => {
  const bad = copy(examples[0]);
  bad.truth = { customer: 50, agent_provider: 40, merchant: 0, fraud: 0 };
  delete (bad.order as Record<string, unknown>).total;
  delete bad.claim;
  const problems = heldOutProblems(bad);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /truth needs/);
  assert.match(problems.join('\n'), /order\.total is missing/);
  assert.match(problems.join('\n'), /needs the customer's claim/);
});

test('a hold the screen would let through is refused, since the team would never see it', () => {
  const quiet = copy(examples[1]);
  quiet.session.first_purchase_at_merchant = false;
  assert.match(heldOutProblems(quiet).join('\n'), /Sentinel would let this payment through/);
});

const usage = (input: number, output: number, cached = 0) => new TokenUsage(input, output, input + output, new InputTokenDetails(cached), new OutputTokenDetails(0));

test('a call is priced at list prices, cached input as a cache write, an unknown model at zero', () => {
  assert.equal(callCost('claude-haiku-4-5', usage(1_000_000, 0)), 1);
  assert.equal(callCost('claude-haiku-4-5', usage(0, 1_000_000)), 5);
  assert.equal(callCost('claude-sonnet-4-6', usage(2000, 400, 1000)), (2000 * 3 + 1000 * 3.75 + 400 * 15) / 1e6);
  assert.equal(callCost('some-other-model', usage(1_000_000, 1_000_000)), 0);
});

test('the guard stops calling the model once the spending cap is reached', async () => {
  let calls = 0;
  const inner: InferenceRunner = {
    async run(): Promise<InferenceOutput> {
      calls++;
      return { items: [ModelMessageItem.rehydrate({ text: 'ok' })], tokenUsage: usage(100_000, 10_000), rowResponse: null }; // $0.15 on Haiku 4.5
    },
    async *stream() {},
  };
  const seen: number[] = [];
  const guard = new GuardedRunner(inner, 8, 99, 90_000, 0, { spendCapUsd: 0.4, onSpend: (s) => seen.push(s.usd) });
  const ask = () => guard.run({ model: 'claude-haiku-4-5', context: ModelContext.create() });
  for (let i = 0; i < 3; i++) assert.equal(((await ask()).items[0] as ModelMessageItem).content.text, 'ok');
  const refused = ((await ask()).items[0] as ModelMessageItem).content.text;
  assert.match(refused, /^INFERENCE_ERROR: spending cap of \$0.4 reached/);
  assert.equal(calls, 3);
  assert.equal(seen.length, 3);
  assert.ok(Math.abs(guard.spend.usd - 0.45) < 1e-9);
  assert.equal(guard.spend.inputTokens, 300_000);
});
