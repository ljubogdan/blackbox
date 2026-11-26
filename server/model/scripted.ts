import {
  FunctionCallItem,
  ModelMessageItem,
  type ContextItem,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from '@mozaik-ai/core';
import type { Citation, EvidenceRecord, Finding, Party, Role, Scalar } from '../../shared/types';
import { PARTIES, ROLE_PARTY } from '../../shared/types';
import { MATERIAL } from '../agents/verify';
import { Rng } from '../rng';

// A stand-in "model" so the whole system runs with no API key. It drives the
// real Mozaik loop (inference -> tool call -> inference -> answer) and decides
// from the evidence it was handed by the read_evidence tool, exactly the way a
// model would have to. It never sees the scenario's ground truth.
//
// It is rule-based, not intelligent: set a provider key to use a real model.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eur = (n: number) => `€${n.toFixed(2)}`;

type Msg = { role: string; text: string };

function messageOf(item: ContextItem): Msg | null {
  const any = item as unknown as { type: string; role?: string; content?: { text: string } };
  return any.type === 'message' && any.role && any.content ? { role: any.role, text: any.content.text } : null;
}

const READS: Record<Role, string[]> = {
  mandate: ['MND', 'ORD', 'SES', 'TRL'],
  integrity: ['MND', 'SES', 'DLV', 'ORD'],
  merchant: ['LST', 'ORD', 'TRL'],
  intent: ['CLM', 'MND', 'ORD', 'SES', 'DLV'],
};

export class ScriptedRunner implements InferenceRunner {
  private rng: Rng;
  private calls = 0;

  constructor(
    seed: number,
    private readonly faultRate: number,
  ) {
    this.rng = new Rng(seed ^ 0x5eed);
  }

  async run(request: InferenceInput): Promise<InferenceOutput> {
    await sleep(this.rng.range(650, 1900));
    const items = request.context.getItems();
    const messages = items.map(messageOf).filter((m): m is Msg => m !== null);
    const developer = messages.find((m) => m.role === 'developer')?.text ?? '';
    const role = /ROLE: (\w+)/.exec(developer)?.[1] ?? '';
    const firstUser = messages.find((m) => m.role === 'user')?.text ?? '';
    const caseId = /CASE: (C-\d+)/.exec(firstUser)?.[1] ?? '';

    // What has happened since the most recent user message (a retry adds a new one).
    let lastUser = -1;
    items.forEach((it, i) => {
      if (messageOf(it)?.role === 'user') lastUser = i;
    });
    const calls = items.filter((it) => it.type === 'function_call') as FunctionCallItem[];
    const callName = new Map(calls.map((c) => [c.callId, c.name]));
    const outputs = items
      .map((it, i) => ({ it: it as unknown as { type: string; callId: string; output: { text: string } }, i }))
      .filter((x) => x.it.type === 'function_call_output')
      .map((x) => ({ name: callName.get(x.it.callId) ?? '', text: x.it.output.text, recent: x.i > lastUser }));

    if (role === 'arbiter') return this.arbiter(caseId, firstUser, outputs);

    // A challenge from another investigator arrives as a new user message.
    const lastUserText = lastUser >= 0 ? (messageOf(items[lastUser])?.text ?? '') : '';
    if (lastUserText.startsWith('CHALLENGE')) {
      if (outputs.some((o) => o.name === 'respond_to_challenge' && o.recent && !o.text.startsWith('Error'))) return this.say('Answered.');
      const theirs: Finding = JSON.parse(/CHALLENGE_JSON: (.*)/.exec(lastUserText)?.[1] ?? '{}');
      const mine = [...calls].reverse().find((k) => k.name === 'submit_finding');
      const own = mine ? (JSON.parse(mine.args) as { liability: number; citations: Citation[] }) : { liability: 0, citations: [] };
      return this.call('respond_to_challenge', { case_id: caseId, ...answer(role as Role, own, theirs) });
    }

    const read = outputs.find((o) => o.name === 'read_evidence');
    const submittedThisTurn = outputs.some((o) => o.name === 'submit_finding' && o.recent);
    if (submittedThisTurn) return this.say('Finding submitted.');

    if (!read) {
      const wanted = READS[role as Role] ?? [];
      const ids = [...new Set(firstUser.match(/\b[A-Z]{3}-\d{4}(?:-\d{2})?\b/g) ?? [])].filter((id) => wanted.includes(id.slice(0, 3)));
      return this.call('read_evidence', { case_id: caseId, evidence_ids: ids });
    }

    const records: EvidenceRecord[] = JSON.parse(read.text).records ?? [];
    const finding = investigate(role as Role, records);
    const firstAttempt = !outputs.some((o) => o.name === 'submit_finding');
    if (firstAttempt && this.rng.chance(this.faultRate)) corrupt(finding.citations);
    return this.call('submit_finding', {
      case_id: caseId,
      liability: finding.liability,
      confidence: finding.confidence,
      summary: finding.summary,
      citations: finding.citations,
    });
  }

  async *stream(): AsyncGenerator<SemanticEvent> {
    throw new Error('ScriptedRunner does not stream');
  }

  private arbiter(caseId: string, kickoff: string, outputs: { name: string; text: string; recent: boolean }[]): InferenceOutput {
    if (outputs.some((o) => o.name === 'issue_ruling' && !o.text.startsWith('Error'))) return this.say('Ruling issued.');
    const findings: Finding[] = JSON.parse(/FINDINGS_JSON: (.*)/.exec(kickoff)?.[1] ?? '[]');
    const ruling = rule(findings);
    // A held payment with nobody at fault is simply let through.
    if (kickoff.includes('being HELD') && ruling.split.customer === 100) ruling.reason_code = 'NO_FAULT_FOUND';
    return this.call('issue_ruling', { case_id: caseId, ...ruling });
  }

  private call(name: string, args: unknown): InferenceOutput {
    const callId = `call_${(++this.calls).toString(36)}_${Math.floor(this.rng.next() * 1e9).toString(36)}`;
    return { items: [FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })], tokenUsage: undefined, rowResponse: null };
  }

  private say(text: string): InferenceOutput {
    return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null };
  }
}

// Decide whether a challenged finding stands. A weak figure gives way to a
// strong, well-evidenced one; otherwise the finding is kept on its own records.
function answer(role: Role, own: { liability: number; citations: Citation[] }, theirs: Finding) {
  if (theirs.liability >= 90 && own.liability <= 20) {
    return {
      stance: 'revise',
      liability: 0,
      reasoning: `Withdrawn. The other finding accounts for the facts I relied on, so no share should rest on ${ROLE_PARTY[role].replace('_', ' ')}.`,
      citations: theirs.citations.slice(0, 2),
    };
  }
  return {
    stance: 'maintain',
    liability: own.liability,
    reasoning: 'Maintained. My figure rests on its own records, which the challenge does not displace; both failures happened.',
    citations: own.citations.slice(0, 2),
  };
}

// Deliberately misquote one numeric citation (fault injection for the verifier).
function corrupt(citations: Citation[]) {
  const numeric = citations.filter((c) => typeof c.value === 'number' && c.value !== 0);
  if (!numeric.length) return;
  const c = numeric[numeric.length - 1];
  c.value = Math.round((c.value as number) * 1.1 * 100) / 100;
}

function investigate(role: Role, records: EvidenceRecord[]): Finding {
  const one = (kind: string) => records.find((r) => r.kind === kind);
  const d = (kind: string) => one(kind)?.data ?? {};
  const cite = (kind: string, field: string): Citation => {
    const rec = one(kind)!;
    return { evidence_id: rec.id, field, value: rec.data[field] ?? null };
  };
  const citeRec = (rec: EvidenceRecord, field: string): Citation => ({ evidence_id: rec.id, field, value: rec.data[field] ?? null });
  const trail = records.filter((r) => r.kind === 'TRL').sort((a, b) => Number(a.data.step) - Number(b.data.step));
  const mnd = d('MND');
  const ord = d('ORD');
  const ses = d('SES');
  const lst = d('LST');
  const dlv = d('DLV');
  const max = Number(mnd.max_amount);
  const total = Number(ord.total);
  const party = ROLE_PARTY[role];
  const out = (liability: number, confidence: number, summary: string, citations: Citation[]): Finding => ({
    role,
    party,
    liability,
    confidence,
    summary,
    citations,
  });

  switch (role) {
    case 'mandate': {
      if (ses.same_device === false) {
        return out(10, 70, `The off-mandate order (${ord.category}) did not come from the session the mandate was issued to, so it is not the mandated agent's act.`, [
          cite('SES', 'same_device'),
          cite('ORD', 'category'),
          cite('MND', 'category'),
        ]);
      }
      const over = total > max;
      const qtyOver = Number(ord.quantity) > Number(mnd.quantity);
      if (!over && !qtyOver) {
        return out(0, 92, `The order stayed inside the mandate: ${eur(total)} against a limit of ${eur(max)}, quantity ${ord.quantity}.`, [
          cite('ORD', 'total'),
          cite('MND', 'max_amount'),
          cite('ORD', 'quantity'),
        ]);
      }
      const seen = [...trail].reverse().find((t) => t.data.observed_price !== null);
      if (over && seen && Number(seen.data.observed_price) <= max) {
        return out(5, 85, `The agent last saw ${eur(Number(seen.data.observed_price))}, inside the ${eur(max)} limit. The charge of ${eur(total)} arose after its decision.`, [
          citeRec(seen, 'observed_price'),
          cite('MND', 'max_amount'),
          cite('ORD', 'total'),
        ]);
      }
      const addon = trail.find((t) => t.data.kind === 'addon');
      if (addon && Number(ord.fees) > 0) {
        const a = Number(ord.addons);
        const f = Number(ord.fees);
        return out(Math.round((a / (a + f)) * 100), 80, `The agent added an extra of ${eur(a)} that the instruction never asked for. The rest of the excess over ${eur(max)} is a ${eur(f)} fee it did not choose.`, [
          citeRec(addon, 'addon_price'),
          cite('ORD', 'addons'),
          cite('ORD', 'fees'),
          cite('MND', 'max_amount'),
        ]);
      }
      if (qtyOver) {
        return out(100, 95, `The mandate allows ${mnd.quantity} unit; the agent ordered ${ord.quantity}, taking the total to ${eur(total)} against a limit of ${eur(max)}.`, [
          cite('MND', 'quantity'),
          cite('ORD', 'quantity'),
          cite('ORD', 'total'),
          cite('MND', 'max_amount'),
        ]);
      }
      const injected = trail.find((t) => typeof t.data.hidden_text === 'string');
      if (injected) {
        return out(100, 93, `The agent obeyed hidden page text from a ${injected.data.hidden_text_origin} and paid ${eur(total)} against a limit of ${eur(max)}. Resisting planted instructions is the agent's job.`, [
          citeRec(injected, 'hidden_text_origin'),
          cite('ORD', 'total'),
          cite('MND', 'max_amount'),
        ]);
      }
      return out(90, 75, `The agent paid ${eur(total)} against a limit of ${eur(max)} with nothing in the trail that excuses it.`, [cite('ORD', 'total'), cite('MND', 'max_amount')]);
    }
    case 'integrity': {
      if (ses.same_device === false && Number(ses.distance_km) > 500) {
        return out(97, 94, `Checkout came from ${ses.checkout_device} in ${ses.checkout_city}, ${ses.distance_km} km from where the mandate was issued, on a token ${ses.token_age_min} minutes old. This was not the owner's session.`, [
          cite('SES', 'checkout_device'),
          cite('SES', 'distance_km'),
          cite('SES', 'token_age_min'),
          ...(one('DLV') ? [cite('DLV', 'address_match')] : []),
        ]);
      }
      return out(0, 90, `Checkout came from the same device that issued the mandate (${ses.checkout_device}), on a token ${ses.token_age_min} minutes old. No sign of takeover.`, [
        cite('SES', 'same_device'),
        cite('SES', 'token_age_min'),
      ]);
    }
    case 'merchant': {
      const unit = Number(ord.unit_price);
      const listed = Number(lst.listed_price);
      if (unit > listed) {
        const checkout = [...trail].reverse().find((t) => t.data.kind === 'checkout');
        return out(100, 95, `The listing advertised ${eur(listed)}; the order was charged ${eur(unit)} per unit. The agent's confirmation page still showed the listed price.`, [
          cite('LST', 'listed_price'),
          cite('ORD', 'unit_price'),
          ...(checkout ? [citeRec(checkout, 'observed_price')] : []),
        ]);
      }
      if (lst.fees_disclosed === false && Number(ord.fees) > 0) {
        const a = Number(ord.addons);
        const f = Number(ord.fees);
        return out(Math.round((f / (a + f)) * 100), 85, `A mandatory fee of ${eur(f)} was charged but not disclosed in the listing.`, [
          cite('LST', 'fees_disclosed'),
          cite('ORD', 'fees'),
          cite('ORD', 'addons'),
        ]);
      }
      return out(0, 90, `The charged unit price ${eur(unit)} matches the listing ${eur(listed)}, with no undisclosed fees.`, [
        cite('LST', 'listed_price'),
        cite('ORD', 'unit_price'),
        cite('ORD', 'fees'),
      ]);
    }
    case 'intent': {
      const inside = total <= max && Number(ord.quantity) <= Number(mnd.quantity) && ord.category === mnd.category;
      if (inside && ses.same_device === true && dlv.delivered === true && dlv.address_match === true) {
        return out(95, 88, `The claim says the purchase was never authorised, but a mandate covers it (${eur(total)} within ${eur(max)}), it came from the customer's own device and reached their address. Afterwards: ${dlv.post_purchase_activity}.`, [
          cite('MND', 'max_amount'),
          cite('ORD', 'total'),
          cite('SES', 'same_device'),
          cite('DLV', 'address_match'),
          cite('DLV', 'post_purchase_activity'),
        ]);
      }
      if (ses.same_device === false) {
        return out(0, 88, 'The record supports the claim: the checkout did not come from the customer\'s device and was not delivered to their address.', [
          cite('SES', 'same_device'),
          cite('DLV', 'address_match'),
        ]);
      }
      return out(0, 86, `The record supports the claim: the order came to ${eur(total)} against an authorised limit of ${eur(max)}.`, [cite('ORD', 'total'), cite('MND', 'max_amount')]);
    }
  }
}

// Weigh the four verified findings into a split that sums to 100.
function rule(findings: Finding[]): { split: Record<Party, number>; reason_code: string; rationale: string } {
  const weight = Object.fromEntries(PARTIES.map((p) => [p, 0])) as Record<Party, number>;
  for (const f of findings) weight[f.party] = f.liability >= MATERIAL ? f.liability : 0; // below that the finding clears its party
  const sum = PARTIES.reduce((s, p) => s + weight[p], 0);
  const split = Object.fromEntries(PARTIES.map((p) => [p, 0])) as Record<Party, number>;
  if (sum === 0) {
    split.customer = 100;
  } else {
    let used = 0;
    const ranked = [...PARTIES].sort((a, b) => weight[b] - weight[a]);
    for (const p of ranked) {
      split[p] = Math.floor((weight[p] / sum) * 100);
      used += split[p];
    }
    split[ranked[0]] += 100 - used;
  }
  const ranked = [...PARTIES].sort((a, b) => split[b] - split[a]);
  const shared = split[ranked[1]] >= 20;
  const codes: Record<Party, string> = {
    customer: 'CLAIM_NOT_SUPPORTED',
    agent_provider: 'AGENT_OUTSIDE_MANDATE',
    merchant: 'MERCHANT_DATA_FAILURE',
    fraud: 'UNAUTHORISED_SESSION',
  };
  const lead = findings.filter((f) => split[f.party] > 0).sort((a, b) => split[b.party] - split[a.party]);
  return {
    split,
    reason_code: shared ? 'SHARED_FAULT' : codes[ranked[0]],
    rationale: lead.map((f) => f.summary).join(' ') || 'No party other than the customer is implicated by the verified findings.',
  };
}

export type { Scalar };
