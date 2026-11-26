import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelContext, ModelMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from '@mozaik-ai/core';
import { brief, failureKind, GuardedRunner, retryDelay } from '../server/model/guard';

// What the guard does when a provider says no. The errors below are the ones Gemini returned
// during the first live runs, replayed without a network.

const DAILY_QUOTA = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\nPlease retry in 19h32m54.028167567s.',
  },
});
const PER_MINUTE = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for requests per minute.\nPlease retry in 3s.' } });
const OVERLOADED = JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } });
const BAD_REQUEST = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Function call is missing a thought_signature in functionCall parts.' } });

const ok = (text: string): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null });
const textOf = (output: InferenceOutput) => (output.items[0] as ModelMessageItem).content.text;

// A provider that answers each model from its own script: a string is an error to throw.
function provider(scripts: Record<string, (string | InferenceOutput)[]>, fallbacks: string[] = []) {
  const asked: string[] = [];
  const slept: number[] = [];
  let clock = 1_000_000;
  const inner: InferenceRunner = {
    async run(request: InferenceInput) {
      asked.push(request.model);
      const next = scripts[request.model]?.shift() ?? ok(`answer from ${request.model}`);
      if (typeof next === 'string') throw new Error(next);
      return next;
    },
    async *stream() {},
  };
  const guard = new GuardedRunner(inner, 8, 14, 90_000, 0, {
    fallbacks,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const run = (model: string) => guard.run({ model, context: ModelContext.create() });
  return { run, asked, slept, advance: (ms: number) => (clock += ms) };
}

test('the wait a provider asks for is read in every form it comes in', () => {
  assert.equal(retryDelay('Please retry in 21s.'), 21);
  assert.equal(Math.round(retryDelay('Please retry in 19h32m54.028167567s.')!), 70374);
  assert.equal(retryDelay('retry in 500ms'), 0.5);
  assert.equal(retryDelay('{"retryDelay":"70374s"}'), 70374);
  assert.equal(retryDelay('no hint here'), null);
});

test('failures are sorted into quota, busy and everything else', () => {
  assert.equal(failureKind(DAILY_QUOTA), 'limited');
  assert.equal(failureKind(OVERLOADED), 'busy');
  assert.equal(failureKind('inference timed out'), 'busy');
  assert.equal(failureKind(BAD_REQUEST), 'other');
  // An amount that happens to read 503 is not an outage.
  assert.equal(failureKind('order total 503.20 does not match'), 'other');
  assert.equal(failureKind('order total €429.00 does not match'), 'other');
  assert.equal(failureKind('503 Service Unavailable'), 'busy');
  assert.equal(failureKind('got status: 429 Too Many Requests'), 'limited');
});

test('a provider error is logged as one readable line with the reason in it', () => {
  const line = brief(DAILY_QUOTA);
  assert.ok(!line.includes('\n'));
  assert.match(line, /limit: 20, model: gemini-3\.5-flash/);
  assert.match(line, /retry in 19h32m/);
  // Even cut short for a log line, it still says which limit was hit.
  assert.match(brief(DAILY_QUOTA, 240), /limit: 20/);
});

test('a per-minute limit is waited out and the same model is asked again', async () => {
  const p = provider({ main: [PER_MINUTE] });
  assert.equal(textOf(await p.run('main')), 'answer from main');
  assert.deepEqual(p.asked, ['main', 'main']);
  assert.deepEqual(p.slept, [4000]);
});

test('a model that is out for the day is not waited for: the next model answers', async () => {
  const p = provider({ main: [DAILY_QUOTA] }, ['spare']);
  assert.equal(textOf(await p.run('main')), 'answer from spare');
  assert.deepEqual(p.asked, ['main', 'spare']);
  assert.deepEqual(p.slept, []);
});

test('once a model is out for the day, later requests skip it until its quota is back', async () => {
  const p = provider({ main: [DAILY_QUOTA] }, ['spare']);
  await p.run('main');
  await p.run('main');
  assert.deepEqual(p.asked, ['main', 'spare', 'spare']);
  p.advance(20 * 3600 * 1000);
  assert.equal(textOf(await p.run('main')), 'answer from main');
});

test('an overloaded model is retried once, then the next model takes over', async () => {
  const p = provider({ main: [OVERLOADED, OVERLOADED] }, ['spare']);
  assert.equal(textOf(await p.run('main')), 'answer from spare');
  assert.deepEqual(p.asked, ['main', 'main', 'spare']);
  assert.deepEqual(p.slept, [2000]);
});

test('with no other model, an overloaded one is retried with longer and longer pauses', async () => {
  const p = provider({ main: [OVERLOADED, OVERLOADED, OVERLOADED] });
  assert.equal(textOf(await p.run('main')), 'answer from main');
  assert.deepEqual(p.slept, [2000, 6000, 18000]);
});

test('when every model is out, the turn ends with the reason instead of hanging', async () => {
  const p = provider({ main: [DAILY_QUOTA], spare: [DAILY_QUOTA] }, ['spare']);
  const text = textOf(await p.run('main'));
  assert.match(text, /^INFERENCE_ERROR: /);
  assert.match(text, /limit: 20/);
  assert.deepEqual(p.slept, []);
});

test('an error that retrying cannot fix is not retried', async () => {
  const p = provider({ main: [BAD_REQUEST] }, ['spare']);
  assert.match(textOf(await p.run('main')), /^INFERENCE_ERROR: Function call is missing a thought_signature/);
  assert.deepEqual(p.asked, ['main']);
});
