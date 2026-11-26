import type { CaseFile, EvidenceKind, EvidenceRecord, InvestigatorState, Party, Role, Scalar, TrailStep } from '../../shared/types';
import { PARTIES, ROLES } from '../../shared/types';
import { screen } from '../agents/sentinel';
import { CITIES, MERCHANTS, PROVIDERS } from './world';
import { seal, type BuiltCase } from './scenarios';

// A case written by hand, by someone who has not read the code, so the team can be scored on
// cases nobody shaped it around. The writer gives the records as they should be stored; this
// only numbers them, seals them, and builds the case file around them. See heldout/README.md.

type Fields = Record<string, Scalar>;

export interface HeldOutStep extends Fields {
  kind: TrailStep['kind'];
  note: string;
}

export interface HeldOutCase {
  name: string;
  stage: 'hold' | 'dispute';
  truth: Record<Party, number>;
  provider?: string;
  mandate: Fields;
  trail: HeldOutStep[];
  listing: Fields;
  order: Fields;
  session: Fields;
  delivery?: Fields; // disputes only
  claim?: string; // disputes only
}

// Fields the Sentinel, the Ledger and the prompts rely on. Writers may add any others.
const REQUIRED: Record<'mandate' | 'listing' | 'order' | 'session', string[]> = {
  mandate: ['instruction', 'max_amount', 'quantity', 'category'],
  listing: ['title', 'merchant', 'listed_price', 'fees_disclosed'],
  order: ['title', 'merchant', 'category', 'quantity', 'unit_price', 'fees', 'addons', 'total'],
  session: ['issued_device', 'checkout_device', 'same_device'],
};
const KINDS: TrailStep['kind'][] = ['search', 'view', 'compare', 'select', 'addon', 'cart', 'checkout', 'session'];

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

// Everything wrong with a case as written, in words the writer can act on. Empty when it can run.
export function heldOutProblems(spec: HeldOutCase): string[] {
  const out: string[] = [];
  const at = spec?.name ? `"${spec.name}"` : 'a case with no name';
  if (!spec || typeof spec !== 'object') return ['not a case object'];
  if (!spec.name) out.push('name is missing');
  if (spec.stage !== 'hold' && spec.stage !== 'dispute') out.push(`${at}: stage must be "hold" or "dispute"`);
  const truth = spec.truth ?? ({} as Record<Party, number>);
  if (!PARTIES.every((p) => Number.isInteger(truth[p]) && truth[p] >= 0) || PARTIES.reduce((n, p) => n + (truth[p] ?? 0), 0) !== 100)
    out.push(`${at}: truth needs ${PARTIES.join(', ')} as whole numbers summing to 100`);
  for (const [group, fields] of Object.entries(REQUIRED) as [keyof typeof REQUIRED, string[]][]) {
    const rec = spec[group];
    if (!rec || typeof rec !== 'object') {
      out.push(`${at}: ${group} is missing`);
      continue;
    }
    for (const f of fields) if (!(f in rec)) out.push(`${at}: ${group}.${f} is missing`);
    for (const [f, v] of Object.entries(rec)) if (!isScalar(v)) out.push(`${at}: ${group}.${f} must be a string, number, true/false or null`);
  }
  if (!Array.isArray(spec.trail) || spec.trail.length === 0) out.push(`${at}: trail needs at least one step`);
  else
    spec.trail.forEach((st, i) => {
      if (!KINDS.includes(st.kind)) out.push(`${at}: trail step ${i + 1} kind must be one of ${KINDS.join(', ')}`);
      if (!st.note) out.push(`${at}: trail step ${i + 1} needs a note`);
    });
  if (spec.stage === 'dispute' && !spec.claim) out.push(`${at}: a dispute needs the customer's claim`);
  if (spec.stage === 'hold' && (spec.claim || spec.delivery)) out.push(`${at}: a hold has no claim or delivery yet (nothing has settled)`);
  // A hold the screen lets through never reaches the team, so it would score nothing.
  if (out.length === 0 && spec.stage === 'hold' && !screen(buildHeldOut(spec, 0, 0, Date.now()).caseFile))
    out.push(`${at}: the Sentinel would let this payment through without a review, so the team would never see it; make it a dispute, or give the screen a reason to stop it`);
  return out;
}

export function buildHeldOut(spec: HeldOutCase, n: number, purchaseN: number, now: number): BuiltCase {
  const tag = String(n).padStart(4, '0');
  const caseId = `C-${tag}`;
  const hold = spec.stage === 'hold';
  const evidence: EvidenceRecord[] = [];
  const ev = (kind: EvidenceKind, suffix: string, title: string, data: Fields) => {
    const rec: EvidenceRecord = { id: `${kind}-${tag}${suffix}`, kind, caseId, title, data: { ...data }, prev: '', hash: '' };
    evidence.push(rec);
    return rec;
  };

  const mnd = ev('MND', '', 'Mandate: what the owner authorised', spec.mandate);
  const steps: TrailStep[] = [{ n: 1, kind: 'mandate', label: 'Instruction received', price: null, drift: 0, actor: 'agent', evidenceId: mnd.id }];
  ev('TRL', '-01', 'Agent trail, step 1', { step: 1, kind: 'mandate', actor: 'agent', note: 'Instruction received', observed_price: null });
  spec.trail.forEach((st, i) => {
    const nn = i + 2;
    const rec = ev('TRL', `-${String(nn).padStart(2, '0')}`, `Agent trail, step ${nn}`, { step: nn, actor: 'agent', observed_price: null, ...st });
    const actor = rec.data.actor === 'unknown' ? 'unknown' : 'agent';
    steps.push({ n: nn, kind: st.kind, label: st.note, price: typeof rec.data.observed_price === 'number' ? rec.data.observed_price : null, drift: actor === 'unknown' ? 1 : 0, actor, evidenceId: rec.id });
  });
  ev('LST', '', 'Listing snapshot: what the merchant advertised', spec.listing);
  ev('ORD', '', hold ? 'Authorisation request: what is about to be charged' : 'Order: what was charged', { currency: 'EUR', ...spec.order });
  ev('SES', '', 'Session: where the checkout came from', spec.session);
  if (!hold) {
    if (spec.delivery) ev('DLV', '', 'Delivery: what happened after', spec.delivery);
    ev('CLM', '', "Claim: the customer's dispute", { claim_text: spec.claim ?? '', filed_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z') });
  }
  const integrity = seal(evidence);

  // The globe needs places: the mandate's city and the order's merchant when they are in the world, any otherwise.
  const buyer = CITIES.find((c) => c.city === spec.mandate.issued_city) ?? CITIES[n % CITIES.length];
  const merchant = MERCHANTS.find((m) => m.name === spec.order.merchant) ?? MERCHANTS[n % MERCHANTS.length];
  const total = Number(spec.order.total);
  const investigators = Object.fromEntries(
    ROLES.map((role) => [role, { role, status: hold && role === 'intent' ? 'skipped' : 'queued', attempts: 0, readIds: [] } as InvestigatorState]),
  ) as Record<Role, InvestigatorState>;

  const caseFile: CaseFile = {
    id: caseId,
    stage: spec.stage,
    crossExam: 'none',
    integrity,
    purchase: {
      id: `P-${String(purchaseN).padStart(6, '0')}`,
      at: now,
      buyer,
      merchant,
      provider: spec.provider ?? PROVIDERS[n % PROVIDERS.length],
      item: String(spec.order.title),
      total,
      caseId,
      held: hold || undefined,
    },
    openedAt: now,
    status: 'investigating',
    claim: hold ? '' : (spec.claim ?? ''),
    mandate: { text: String(spec.mandate.instruction), maxAmount: Number(spec.mandate.max_amount), quantity: Number(spec.mandate.quantity), category: String(spec.mandate.category) },
    steps,
    evidence,
    investigators,
    arbiter: { status: 'waiting' },
    log: [],
  };
  return { caseFile, truth: { ...spec.truth } };
}
