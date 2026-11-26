import type { Citation, CitationCheck, EvidenceRecord, Scalar } from '../../shared/types';
import { recordHash } from '../data/scenarios';

// Plain code, no model: a cited value either matches the stored record or it does not.

const LONG_TEXT = new Set(['instruction', 'hidden_text', 'claim_text', 'note', 'post_purchase_activity', 'title']);

function same(field: string, cited: Scalar, actual: Scalar): boolean {
  if (typeof actual === 'number') {
    const n = typeof cited === 'number' ? cited : Number(String(cited).replace(/[€,\s]/g, ''));
    return Number.isFinite(n) && Math.abs(n - actual) < 0.005;
  }
  if (typeof actual === 'boolean') return cited === actual || String(cited).toLowerCase() === String(actual);
  if (actual === null) return cited === null || cited === 'null';
  const a = String(actual).trim().toLowerCase();
  const c = String(cited).trim().toLowerCase();
  if (a === c) return true;
  // A quoted excerpt of a long text field counts, as long as it is a real excerpt.
  return LONG_TEXT.has(field) && c.length >= 12 && a.includes(c);
}

export function checkCitations(caseId: string, citations: Citation[], evidence: Map<string, EvidenceRecord>): CitationCheck[] {
  return citations.map((c) => {
    const rec = evidence.get(c.evidence_id);
    if (!rec || rec.caseId !== caseId) return { ...c, ok: false, actual: undefined, reason: 'no such record in this case' };
    if (rec.hash !== recordHash(rec.prev, rec.id, rec.data)) return { ...c, ok: false, actual: undefined, reason: 'record fails its integrity check (altered after it was sealed)' };
    if (!(c.field in rec.data)) return { ...c, ok: false, actual: undefined, reason: `record has no field "${c.field}"` };
    const actual = rec.data[c.field];
    const ok = same(c.field, c.value, actual);
    return { ...c, ok, actual, reason: ok ? undefined : 'value does not match the record' };
  });
}
