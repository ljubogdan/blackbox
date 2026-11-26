import type { CaseFile, Citation, CitationCheck, EvidenceKind, EvidenceRecord, Party, Role, Scalar, TamperResult } from '../../shared/types';
import { PARTIES, ROLE_PARTY, ROLES } from '../../shared/types';
import { recordHash, seal } from '../data/scenarios';

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

// A finding below this puts no real weight on its party: models hedge with 5 or 10 where the
// evidence clears someone. On a held payment any share outside the customer's blocks it, so a
// hedge alone would stop a clean purchase.
export const MATERIAL = 20;

// The parties the verified findings implicate: those a finding puts at least MATERIAL on. On a held
// payment nobody examines a claim, so the customer is the residual party (a share there means "let
// it through"). On a dispute the Claim Examiner speaks for the customer like any other investigator.
export function implicated(c: CaseFile): Party[] {
  return PARTIES.filter((party) => {
    const role = ROLES.find((r) => ROLE_PARTY[r] === party)!;
    const finding = c.investigators[role].finding;
    if (party === 'customer' && !finding) return true;
    return (finding?.liability ?? 0) >= MATERIAL;
  });
}

// Parties a split gives a share to without a verified finding that implicates them.
export function unsupportedShares(c: CaseFile, split: Record<Party, number>): Party[] {
  const ok = implicated(c);
  return PARTIES.filter((p) => split[p] > 0 && !ok.includes(p));
}

// Change one field of one record on a copy of the case's records, and run the same checks the
// Verifier runs. The case on file is never touched: this only shows what an edit would set off.
export function tamperCheck(c: CaseFile, evidenceId: string, field: string, value: Scalar): TamperResult | null {
  const copy = c.evidence.map((e) => ({ ...e, data: { ...e.data } }));
  const target = copy.find((e) => e.id === evidenceId);
  if (!target || !(field in target.data)) return null;
  const before = target.data[field];
  // Keep the field's type, so a number stays a number.
  const after: Scalar = typeof before === 'number' && Number.isFinite(Number(value)) ? Number(value) : typeof before === 'boolean' ? String(value) === 'true' : value;
  target.data[field] = after;
  const broken = copy.filter((e) => e.hash !== recordHash(e.prev, e.id, e.data)).map((e) => e.id);
  const at = copy.indexOf(target);
  const resealed = seal(copy.map((e) => ({ ...e })));
  const records = new Map(copy.map((e) => [e.id, e]));
  const rejected = ROLES.flatMap((role) =>
    checkCitations(c.id, c.investigators[role].finding?.citations ?? [], records)
      .filter((k) => !k.ok)
      .map((k) => ({ role, evidence_id: k.evidence_id, field: k.field, reason: k.reason ?? 'rejected' })),
  );
  return {
    caseId: c.id,
    evidenceId,
    field,
    before,
    after,
    broken,
    later: copy.slice(at + 1).map((e) => e.id),
    headOnFile: c.integrity.head,
    resealedHead: resealed.head,
    rejected,
  };
}
