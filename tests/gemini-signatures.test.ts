import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FunctionCallItem, FunctionCallOutputItem, GeminiGenerateContent, ModelContext, UserMessageItem, type InferenceInput, type InferenceRunner } from '@mozaik-ai/core';
import { GeminiSignatures } from '../server/model/gemini';
import { GuardedRunner } from '../server/model/guard';

// Gemini 3 refuses the next request of a turn unless each function call comes back with the
// signature it was issued with. No network here: Gemini's replies are scripted in its own wire
// shape, and the request Mozaik would send next is checked.

interface Part {
  text?: string;
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string };
  thoughtSignature?: string;
}
const reply = (...parts: Part[]) => ({ candidates: [{ content: { role: 'model', parts } }] });
const call = (id: string, signature?: string, callId?: string): Part => ({ functionCall: { id: callId, name: 'lookup', args: { id } }, ...(signature ? { thoughtSignature: signature } : {}) });

function gemini(script: unknown[]) {
  const endpoint = new GeminiGenerateContent();
  const wire: InferenceRunner = {
    run: async () => endpoint.endpointMapper.toResponse(script.shift()),
    async *stream() {},
  };
  const runner = new GuardedRunner(new GeminiSignatures(wire, [{ endpoint }]), 8);
  const context = ModelContext.create().addContextItem(UserMessageItem.create('Look the records up.'));
  const input: InferenceInput = { model: 'gemini-3.5-flash', context };
  // One step of the loop: ask for the next item and, if it is a call, record it with its result.
  const step = async () => {
    const item = (await runner.run(input)).items[0];
    if (item instanceof FunctionCallItem) context.addContextItems([item, FunctionCallOutputItem.create(item.callId, JSON.stringify({ found: JSON.parse(item.args).id }))]);
    return item;
  };
  const request = () => endpoint.endpointMapper.toRequest(input).contents as { role: string; parts: Part[] }[];
  return { step, request, context };
}

const shape = (contents: { role: string; parts: Part[] }[]) =>
  contents.map((c) => `${c.role}: ${c.parts.map((p) => (p.functionCall ? `call${p.thoughtSignature ? `[${p.thoughtSignature}]` : ''}` : p.functionResponse ? 'result' : 'text')).join(' ')}`);

test('a call goes back to Gemini with the signature it came with', async () => {
  const { step, request } = gemini([reply(call('A', 'sig-A', 'gem-1'))]);
  await step();
  const contents = request();
  assert.deepEqual(shape(contents), ['user: text', 'model: call[sig-A]', 'user: result']);
  assert.equal(contents[1].parts[0].functionCall!.id, 'gem-1');
  assert.equal(contents[2].parts[0].functionResponse!.id, 'gem-1');
});

test('calls made one after another each keep their own signature', async () => {
  const { step, request } = gemini([reply(call('A', 'sig-A')), reply(call('B', 'sig-B'))]);
  await step();
  await step();
  assert.deepEqual(shape(request()), ['user: text', 'model: call[sig-A]', 'user: result', 'model: call[sig-B]', 'user: result']);
});

test('calls made together go back together, signed once, with their results in order', async () => {
  // Gemini signs only the first call of a parallel set and expects the set back as one step.
  const { step, request } = gemini([reply(call('A', 'sig-ABC'), call('B'), call('C'))]);
  await step();
  await step();
  await step();
  const contents = request();
  assert.deepEqual(shape(contents), ['user: text', 'model: call[sig-ABC] call call', 'user: result result result']);
  const callIds = contents[1].parts.map((p) => p.functionCall!.id);
  assert.deepEqual(contents[2].parts.map((p) => p.functionResponse!.id), callIds);
});

test('calls without an id from Gemini are given distinct ones', async () => {
  const { step, request, context } = gemini([reply(call('A', 'sig-AB'), call('B'))]);
  await step();
  await step();
  const ids = context.getItems().flatMap((it) => (it instanceof FunctionCallItem ? [it.callId] : []));
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => id.length > 0));
  assert.ok(request()[2].parts.every((p) => p.functionResponse!.name === 'lookup'));
});

test('a new message after the results stays after them', async () => {
  const { step, request, context } = gemini([reply(call('A', 'sig-AB'), call('B'))]);
  await step();
  await step();
  context.addContextItem(UserMessageItem.create('Your turn ended without a finding.'));
  assert.deepEqual(shape(request()), ['user: text', 'model: call[sig-AB] call', 'user: result result text']);
});

test('a reply from another provider passes through unchanged', async () => {
  const output = { items: [FunctionCallItem.rehydrate({ callId: 'toolu_1', name: 'lookup', args: '{}' })], tokenUsage: undefined, rowResponse: { content: [] } };
  const signed = new GeminiSignatures({ run: async () => output, async *stream() {} }, []);
  assert.equal(await signed.run({ model: 'other', context: ModelContext.create() }), output);
});
