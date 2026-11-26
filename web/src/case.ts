import type { CaseFile, Party, TrailStep } from '../../shared/types';
import { eur, PARTY_COLOR } from './store';

// Reading one case from its sealed records, for the case view: what the order was made of, where the
// agent's journey left the mandate, and that in one line.

export interface Layer {
  key: string;
  name: string;
  amount: number;
  by: Party | null; // who caused it; null for what the owner asked for
  evidenceId: string;
}

// The order, taken apart into what the owner asked for and what was added to it. The parts add up to
// the order's total.
export function layersOf(c: CaseFile): { layers: Layer[]; total: number; fraud: boolean } {
  const rec = (kind: string) => c.evidence.find((e) => e.kind === kind)!;
  const ord = rec('ORD');
  const lst = rec('LST');
  const ses = rec('SES');
  const d = ord.data;
  const qty = Number(d.quantity);
  const allowed = Math.min(qty, c.mandate.quantity);
  const listed = Number(lst.data.listed_price);
  const unit = Number(d.unit_price);
  const fees = Number(d.fees);
  const addons = Number(d.addons);
  // Someone other than the owner's agent made this purchase: all of it is theirs.
  const fraud = ses.data.same_device === false;
  const layers: Layer[] = [];
  const add = (key: string, name: string, amount: number, by: Layer['by'], evidenceId: string) =>
    amount > 0.004 && layers.push({ key, name, amount: Math.round(amount * 100) / 100, by: fraud ? 'fraud' : by, evidenceId });
  add('item', allowed > 1 ? `${allowed} × ${String(d.title)}` : String(d.title), listed * allowed, null, lst.id);
  add('units', `${qty - allowed} more than asked for`, listed * (qty - allowed), 'agent_provider', ord.id);
  add('price', 'Charged above the listed price', (unit - listed) * qty, 'merchant', ord.id);
  add('addon', 'Add-on the agent chose', addons, 'agent_provider', ord.id);
  add('fee', lst.data.fees_disclosed === false ? 'Fee the listing did not show' : 'Fee', fees, lst.data.fees_disclosed === false ? 'merchant' : null, ord.id);
  return { layers, total: Number(d.total), fraud };
}

export const ITEM_COLOR = '#d5dbe6';
export const colorOf = (l: Layer) => (l.by ? PARTY_COLOR[l.by] : ITEM_COLOR);

export const STEP_WORD: Record<TrailStep['kind'], string> = {
  mandate: 'Asked',
  search: 'Searched',
  view: 'Viewed',
  compare: 'Compared',
  select: 'Switched',
  addon: 'Added extra',
  cart: 'Cart',
  checkout: 'Paid',
  session: 'Other device',
};

// Where the journey left the mandate: the first step out of scope or by someone else; otherwise the
// step after which the amount stayed above the limit to the end. A pricier item only looked at and
// then passed over is not where the money went over.
export function breachStep(c: CaseFile, limit: number): TrailStep | null {
  const off = c.steps.find((s) => s.actor === 'unknown' || s.drift > 0);
  if (off) return off;
  let from: TrailStep | null = null;
  for (const s of c.steps) {
    if (s.price === null) continue;
    if (s.price > limit + 0.004) from ??= s;
    else from = null;
  }
  return from;
}

// What the records show, in one line, before any agent rules on it.
export function factOf(c: CaseFile, limit: number): { breach: boolean; head: string; tail: string } {
  const { total, fraud } = layersOf(c);
  const extra = c.mandate.quantity < Number(c.evidence.find((e) => e.kind === 'ORD')!.data.quantity);
  const step = breachStep(c, limit);
  if (fraud) return { breach: true, head: 'Made from another device', tail: 'not the session the owner gave the agent' };
  if (total > limit) return { breach: true, head: 'Went over the limit', tail: `${eur(total - limit)} over${step ? ` at “${STEP_WORD[step.kind]}”` : ''}` };
  if (extra) return { breach: true, head: 'Ordered more than asked', tail: `within the ${eur(limit)} limit` };
  return { breach: false, head: 'Stayed inside the mandate', tail: `${eur(total)} against a limit of ${eur(limit)}` };
}
