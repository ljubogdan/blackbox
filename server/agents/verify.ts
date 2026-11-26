import type { Citation, CitationCheck, EvidenceKind, EvidenceRecord, Role, Scalar } from '../../shared/types';
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

// A true value can still be beside the point. Each investigator must cite the records its own
// question is about: one record from every group. This checks where it looked, not how it reasoned.
export const COVERAGE: Record<Role, { kinds: EvidenceKind[]; what: string }[]> = {
  mandate: [
    { kinds: ['MND'], what: 'the mandate (MND)' },
    { kinds: ['ORD'], what: 'the order (ORD)' },
  ],
  integrity: [{ kinds: ['SES'], what: 'the session (SES)' }],
  merchant: [
    { kinds: ['LST'], what: 'the listing (LST)' },
    { kinds: ['ORD'], what: 'the order (ORD)' },
  ],
  intent: [{ kinds: ['MND', 'SES'], what: 'the mandate (MND) or the session (SES)' }],
};

export function missingCoverage(role: Role, caseId: string, citations: Citation[], evidence: Map<string, EvidenceRecord>): string[] {
  const cited = new Set(citations.map((c) => evidence.get(c.evidence_id)).filter((r) => r?.caseId === caseId).map((r) => r!.kind));
  return COVERAGE[role].filter((g) => !g.kinds.some((k) => cited.has(k))).map((g) => g.what);
}
