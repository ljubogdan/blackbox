import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAgent,
  FunctionCallItem,
  ModelContext,
  ModelMessageItem,
  SituationSpecification,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type InterceptionHandler,
  type SemanticEvent,
  type SituationContext,
  type Tool,
} from '@mozaik-ai/core';
import { GuardedRunner } from '../server/model/guard';
import { initializeRuntime, join, runLoop } from '../server/runtime';
import { BlackboxState } from '../server/state';

// A real model can ask for several tools in one response. Mozaik's loop runs only the first, so
// the guard hands the rest to the loop one at a time. These tests drive Mozaik's own loop with a
// model that answers from a script.

class ScriptedModel implements InferenceRunner {
  script: InferenceOutput[] = [];
  seen: string[][] = []; // the kinds of item in the context at each model call

  async run(request: InferenceInput): Promise<InferenceOutput> {
    this.seen.push(request.context.getItems().map((it) => it.type));
    const next = this.script.shift();
    if (!next) throw new Error('the model was called more often than the script allows');
    return next;
  }
  async *stream(): AsyncGenerator<SemanticEvent> {}
}

const calls = (...ids: string[]): InferenceOutput => ({
  items: ids.map((id) => FunctionCallItem.rehydrate({ callId: `call-${id}`, name: 'lookup', args: JSON.stringify({ id }) })),
  tokenUsage: undefined,
  rowResponse: null,
});
const answer = (text: string): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null });

const model = new ScriptedModel();
const runner = new GuardedRunner(model, 8);
initializeRuntime({ state: new BlackboxState(), inferenceRunnerConfig: { runner } });

const when = (pred: (ctx: SituationContext) => boolean) =>
  new (class extends SituationSpecification {
    isSatisfiedBy(ctx: SituationContext) {
      return pred(ctx);
    }
  })();

// One agent turn on a fresh context. Resolves when the loop goes idle.
function turn(script: InferenceOutput[], interception?: InterceptionHandler) {
  model.script = script;
  model.seen = [];
  const looked: string[] = [];
  const replayed: boolean[] = []; // at each inference step: was it a waiting call, not a model call?
  const lookup: Tool = {
    type: 'function',
    name: 'lookup',
    description: 'Look one record up.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    strict: false,
    invoke: async ({ id }: { id: string }) => {
      looked.push(id);
      return `record ${id}`;
    },
  };
  const context = ModelContext.create();
  return new Promise<{ looked: string[]; replayed: boolean[]; context: ModelContext }>((resolve) => {
    const agent = createAgent({
      name: `reader-${crypto.randomUUID()}`,
      capabilities: ['inference'],
      instruction: 'Test agent.',
      tools: [lookup],
      handlers: [
        {
          specification: when(({ event, participant }) => event.type === 'inference.started' && event.producerId === participant.getId()),
          processor: { apply: ({ event }) => void replayed.push(runner.hasQueued((event.payload as InferenceInput).context)) },
        },
        {
          specification: when(({ event, participant }) => event.type === 'model.answer' && event.producerId === participant.getId()),
          processor: { apply: () => resolve({ looked, replayed, context }) },
        },
      ],
    });
    join(agent);
    runLoop(agent.getId(), 'Look the records up.', { model: 'scripted', context, tools: [lookup] }, interception);
  });
}

test('every tool call in one model response is run, in order', async () => {
  const { looked, context } = await turn([calls('A', 'B', 'C'), answer('done')]);
  assert.deepEqual(looked, ['A', 'B', 'C']);
  // Two model calls, not four: the waiting calls cost no inference.
  assert.equal(model.seen.length, 2);
  // By its second call the model sees each call next to its own result.
  assert.deepEqual(model.seen[1], ['message', 'function_call', 'function_call_output', 'function_call', 'function_call_output', 'function_call', 'function_call_output']);
  const ids = context.getItems().flatMap((it) => (it instanceof FunctionCallItem ? [it.callId] : []));
  assert.deepEqual(ids, ['call-A', 'call-B', 'call-C']);
});

test('a waiting call is told apart from a model call, so it is not counted as one', async () => {
  const { replayed } = await turn([calls('A', 'B', 'C'), answer('done')]);
  assert.deepEqual(replayed, [false, true, true, false]);
});

test('one call per response still works as before', async () => {
  const { looked, replayed } = await turn([calls('A'), calls('B'), answer('done')]);
  assert.deepEqual(looked, ['A', 'B']);
  assert.equal(model.seen.length, 3);
  assert.deepEqual(replayed, [false, false, false]);
});

test('each waiting call still passes through interception', async () => {
  const gated: string[] = [];
  const gate: InterceptionHandler = {
    isSatisfiedBy: (t) => t.nextStateId === 'function_call',
    async handle(t) {
      if (t.nextStateId === 'function_call') gated.push(t.input.call.callId);
      return t;
    },
  };
  await turn([calls('A', 'B'), answer('done')], gate);
  assert.deepEqual(gated, ['call-A', 'call-B']);
});

test('waiting calls are dropped if the turn moved on without them', async () => {
  const inner = new ScriptedModel();
  const guard = new GuardedRunner(inner, 8);
  const context = ModelContext.create();
  inner.script = [calls('A', 'B'), answer('fresh')];
  const first = await guard.run({ model: 'scripted', context });
  assert.equal(first.items.length, 1);
  // The loop never recorded A's result, so B must not be replayed into a context it does not follow.
  const second = await guard.run({ model: 'scripted', context });
  assert.equal(second.items[0].type, 'message');
  assert.equal(inner.seen.length, 2);
});
