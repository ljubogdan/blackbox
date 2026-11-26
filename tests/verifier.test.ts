import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Citation, EvidenceRecord, Scalar } from '../shared/types';
import { checkCitations, missingCoverage } from '../server/agents/verify';
import { buildCase, chainIntegrity, seal } from '../server/data/scenarios';
import { Rng } from '../server/rng';

// The Verifier is the reason a figure in a finding can be trusted: a cited value either matches
// the sealed record or the finding is rejected. These tests pin that rule down.

const NOW = 1_700_000_000_000;

// A fresh case each time, so a test that tampers with a record cannot affect another.
function sealedCase(n = 1) {
  const { caseFile } = buildCase(new Rng(7), n, 'quantity', n, NOW);
  const evidence = new Map<string, EvidenceRecord>(caseFile.evidence.map((e) => [e.id, e]));
  const record = (kind: EvidenceRecord['kind']) => caseFile.evidence.find((e) => e.kind === kind)!;
  const check = (evidence_id: string, field: string, value: Scalar) => checkCitations(caseFile.id, [{ evidence_id, field, value } as Citation], evidence)[0];
  return { caseFile, evidence, record, check };
}

test('a value copied from the record is accepted', () => {
  const { record, check } = sealedCase();
  const ord = record('ORD');
  const total = ord.data.total as number;
  assert.equal(check(ord.id, 'total', total).ok, true);
  assert.equal(check(ord.id, 'quantity', ord.data.quantity).ok, true);
  assert.equal(check(ord.id, 'merchant', ord.data.merchant).ok, true);
});

test('an amount written the way a person writes it is accepted', () => {
  const { record, check } = sealedCase();
  const ord = record('ORD');
  const total = ord.data.total as number;
  assert.equal(check(ord.id, 'total', `€${total.toFixed(2)}`).ok, true);
  assert.equal(check(ord.id, 'total', String(total)).ok, true);
});

test('an amount that is one cent out is rejected, and the record value is reported', () => {
  const { record, check } = sealedCase();
  const ord = record('ORD');
  const total = ord.data.total as number;
  for (const wrong of [total + 0.01, total - 0.01, total * 2, 0]) {
    const result = check(ord.id, 'total', wrong);
    assert.equal(result.ok, false, `${wrong} should not pass for ${total}`);
    assert.equal(result.actual, total);
    assert.equal(result.reason, 'value does not match the record');
  }
  assert.equal(check(ord.id, 'total', 'about three hundred').ok, false);
});

test('true, false and empty values are compared as what they are', () => {
  const { record, check } = sealedCase();
  const ses = record('SES');
  assert.equal(ses.data.same_device, true);
  assert.equal(check(ses.id, 'same_device', true).ok, true);
  assert.equal(check(ses.id, 'same_device', 'TRUE').ok, true);
  assert.equal(check(ses.id, 'same_device', false).ok, false);
  const trl = record('TRL');
  assert.equal(trl.data.observed_price, null);
  assert.equal(check(trl.id, 'observed_price', null).ok, true);
  assert.equal(check(trl.id, 'observed_price', 0).ok, false);
});

test('a quoted excerpt counts only for long text, and only if it is a real excerpt', () => {
  const { record, check } = sealedCase();
  const mnd = record('MND');
  const instruction = String(mnd.data.instruction);
  assert.equal(check(mnd.id, 'instruction', instruction.slice(0, 30)).ok, true);
  assert.equal(check(mnd.id, 'instruction', instruction.slice(0, 8)).ok, false, 'too short to be evidence of anything');
  assert.equal(check(mnd.id, 'instruction', 'Spend as much as you like on shoes').ok, false);
  // A short field must match in full: part of a merchant's name is not the merchant.
  const ord = record('ORD');
  assert.equal(check(ord.id, 'merchant', String(ord.data.merchant).slice(0, 5)).ok, false);
});

test('a citation to a record or field that does not exist is rejected', () => {
  const { record, check } = sealedCase();
  const ord = record('ORD');
  assert.equal(check('ORD-9999', 'total', ord.data.total).reason, 'no such record in this case');
  assert.equal(check(ord.id, 'grand_total', ord.data.total).reason, 'record has no field "grand_total"');
});

test('a record from another case cannot be cited', () => {
  const mine = sealedCase(1);
  const other = sealedCase(2);
  const theirs = other.record('ORD');
  mine.evidence.set(theirs.id, theirs);
  const result = mine.check(theirs.id, 'total', theirs.data.total);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no such record in this case');
});

test('a record altered after it was sealed is rejected, even when the citation matches the altered value', () => {
  const { record, check } = sealedCase();
  const ord = record('ORD');
  ord.data.total = 1;
  const result = check(ord.id, 'total', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /integrity/);
  // Every field of that record is now untrustworthy, not only the one that changed.
  assert.equal(check(ord.id, 'quantity', ord.data.quantity).ok, false);
});

test('the hash chain covers every record and breaks on any later edit', () => {
  const { caseFile } = sealedCase();
  const before = chainIntegrity(caseFile.evidence);
  assert.equal(before.ok, true);
  assert.equal(before.records, caseFile.evidence.length);
  assert.equal(before.head, caseFile.evidence.at(-1)!.hash);
  assert.equal(before.head, caseFile.integrity.head);

  // Edit a record in the middle of the chain.
  caseFile.evidence[3].data.note = 'edited';
  assert.equal(chainIntegrity(caseFile.evidence).ok, false);

  // Sealing again makes the chain consistent, but the head no longer matches the one on file.
  const resealed = seal(caseFile.evidence);
  assert.equal(chainIntegrity(caseFile.evidence).ok, true);
  assert.notEqual(resealed.head, before.head);
});

test('removing or reordering records breaks the chain', () => {
  const { caseFile } = sealedCase();
  const [a, b, ...rest] = caseFile.evidence;
  assert.equal(chainIntegrity([b, a, ...rest]).ok, false);
  assert.equal(chainIntegrity([a, ...rest]).ok, false);
});

// ───────────────────────── coverage ─────────────────────────

// True values that are beside the point: each investigator must cite the records its question is about.
function citeFrom(record: EvidenceRecord): Citation {
  const [field, value] = Object.entries(record.data)[0];
  return { evidence_id: record.id, field, value: value as Scalar };
}

test('a finding that cites the records its question is about has full coverage', () => {
  const { caseFile, evidence, record } = sealedCase();
  const id = caseFile.id;
  assert.deepEqual(missingCoverage('mandate', id, [citeFrom(record('MND')), citeFrom(record('ORD'))], evidence), []);
  assert.deepEqual(missingCoverage('integrity', id, [citeFrom(record('SES'))], evidence), []);
  assert.deepEqual(missingCoverage('merchant', id, [citeFrom(record('LST')), citeFrom(record('ORD'))], evidence), []);
  assert.deepEqual(missingCoverage('intent', id, [citeFrom(record('SES'))], evidence), []);
  assert.deepEqual(missingCoverage('intent', id, [citeFrom(record('MND'))], evidence), []);
});

test('true citations from the wrong records leave the question uncovered', () => {
  const { caseFile, evidence, record } = sealedCase();
  const id = caseFile.id;
  // Session Forensics blaming fraud on the order and the listing alone: every value is real, none is about the session.
  const offTopic = [citeFrom(record('ORD')), citeFrom(record('LST'))];
  assert.ok(checkCitations(id, offTopic, evidence).every((k) => k.ok));
  assert.deepEqual(missingCoverage('integrity', id, offTopic, evidence), ['the session (SES)']);
  assert.deepEqual(missingCoverage('mandate', id, [citeFrom(record('ORD'))], evidence), ['the mandate (MND)']);
  assert.deepEqual(missingCoverage('merchant', id, [citeFrom(record('SES'))], evidence), ['the listing (LST)', 'the order (ORD)']);
});

test("a record from another case does not cover this one's question", () => {
  const mine = sealedCase(1);
  const other = sealedCase(2);
  const evidence = new Map([...mine.evidence, ...other.evidence]);
  assert.deepEqual(missingCoverage('integrity', mine.caseFile.id, [citeFrom(other.record('SES'))], evidence), ['the session (SES)']);
});
