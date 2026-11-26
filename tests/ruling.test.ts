import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InferenceRunner } from '@mozaik-ai/core';
import { assembleTeam } from '../server/agents/team';
import { issueRulingTool } from '../server/agents/tools';
import { buildCase } from '../server/data/scenarios';
import { Rng } from '../server/rng';
import { initializeRuntime, state } from '../server/runtime';
import { BlackboxState } from '../server/state';

// Only a person can reject a ruling. The rejection lives in shared state, so nothing the model
// writes into the tool call can fake one.

const noModel: InferenceRunner = {
  run: async () => {
    throw new Error('issue_ruling must not call a model');
  },
  async *stream() {},
};
initializeRuntime({ state: new BlackboxState(), inferenceRunnerConfig: { runner: noModel } });
const team = assembleTeam();

const rng = new Rng(5);
let caseN = 0;
function onFile() {
  const { caseFile } = buildCase(rng, ++caseN, 'quantity', caseN, 1_700_000_000_000);
  const st = state();
  for (const e of caseFile.evidence) st.evidence.set(e.id, e);
  st.cases.set(caseFile.id, caseFile);
  return caseFile;
}
const tool = issueRulingTool(() => team.intake.getId());
const args = (caseId: string) => ({
  case_id: caseId,
  split: { customer: 0, agent_provider: 100, merchant: 0, fraud: 0 },
  reason_code: 'AGENT_OUTSIDE_MANDATE',
  rationale: 'test',
});

test('a rejection written into the arguments by the model is ignored', async () => {
  const c = onFile();
  const reply = await tool.invoke({ ...args(c.id), human_rejected: true });
  assert.equal(reply, 'Ruling recorded.');
  assert.equal(c.arbiter.status, 'done');
  assert.notEqual(c.status, 'manual_review');
  assert.ok(!c.log.some((l) => l.who === 'Risk officer'));
});

test('a rejection by the person moves the case to manual review and records no ruling', async () => {
  const c = onFile();
  state().rejected.add(c.id);
  const reply = await tool.invoke(args(c.id));
  assert.match(String(reply), /rejected/);
  assert.equal(c.arbiter.status, 'failed');
  assert.equal(c.status, 'manual_review');
  assert.ok(c.log.some((l) => l.who === 'Risk officer'));
});
