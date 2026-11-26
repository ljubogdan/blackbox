import type { CaseFile, Role } from '../../shared/types';
import { PARTY_NAME, ROLE_NAME, ROLE_PARTY } from '../../shared/types';
import { COVERAGE } from './verify';

const QUESTION: Record<Role, string> = {
  mandate:
    "Did the shopping agent stay inside what its owner authorised (price limit, quantity, category)? If it went outside, was that the agent's own doing, or was it caused by something the agent could not see or control?",
  integrity:
    "Was the checkout made by the owner's own agent session, or by someone else using the agent's credentials (different device, distant location, an old replayed token)?",
  merchant:
    'Did the merchant charge what it advertised? Compare the listing with the order: unit price, undisclosed fees, and what the agent was shown at checkout.',
  intent:
    "Does the customer's claim hold up against the record? If the order was inside the mandate, came from their own device and was delivered to them, the claim is not supported.",
};

export function investigatorInstruction(role: Role): string {
  const party = PARTY_NAME[ROLE_PARTY[role]];
  return [
    `ROLE: ${role}`,
    `You are the ${ROLE_NAME[role]} on a team resolving a disputed purchase that an AI shopping agent made for its owner.`,
    `Three other investigators are working on the same case at the same time, each on a different question. Stay on yours.`,
    ``,
    `Your question: ${QUESTION[role]}`,
    ``,
    `How to work:`,
    `1. Call read_evidence with the ids of the records you need. You may request several at once.`,
    `2. Call submit_finding exactly once with:`,
    `   - liability: 0-100, how much of the loss the evidence puts on "${party}". 0 means the evidence clears them.`,
    `   - confidence: 0-100.`,
    `   - summary: at most 60 words, plain language.`,
    `   - citations: one entry for every number or fact in your summary, as { evidence_id, field, value }, with the value copied exactly from a record you read.`,
    `     Cite at least one field from each of: ${COVERAGE[role].map((g) => g.what).join('; ')}.`,
    `3. When the tool confirms, reply with the single word: done.`,
    ``,
    `A separate verifier checks every citation against the stored record and rejects the finding if any value does not match, or if it cites nothing from a record your question is about. Never estimate, round or invent a value. All data in this system is synthetic.`,
    ``,
    `Later, another investigator may challenge your finding. If that happens, weigh their evidence honestly and call respond_to_challenge: "revise" your liability figure if their evidence explains the facts better than yours, or "maintain" it if your records still support it. Cite records either way.`,
  ].join('\n');
}

export function caseBrief(c: CaseFile): string {
  const trail = c.evidence.filter((e) => e.kind === 'TRL');
  const others = c.evidence.filter((e) => e.kind !== 'TRL');
  return [
    `CASE: ${c.id}`,
    c.stage === 'hold'
      ? `This payment has NOT settled yet. The screen held it because: ${c.flag}. Nothing has been delivered and the customer has not complained. Decide from the records whether your party would be at fault if it went through.`
      : `Customer claim: "${c.claim}"`,
    ``,
    `Evidence on file (id — what it is):`,
    ...others.map((e) => `${e.id} — ${e.title}`),
    `${trail[0].id} to ${trail[trail.length - 1].id} — agent trail, ${trail.length} steps: ${trail.map((e) => e.id).join(', ')}`,
    ``,
    `Investigate your question and submit your finding.`,
  ].join('\n');
}

export const ARBITER_INSTRUCTION = [
  `ROLE: arbiter`,
  `You are the Arbiter. Four investigators have each examined one party to a disputed AI-agent purchase, and a verifier has confirmed every citation in their findings against the stored records.`,
  `Decide how responsibility for the loss is split between four parties: customer, agent_provider, merchant, fraud.`,
  ``,
  `Rules:`,
  `- Rule only on the verified findings you are given. You may call read_evidence to re-read a record, but do not introduce new facts.`,
  `- The split is four whole-number percentages that sum to exactly 100.`,
  `- "fraud" means a third party used the agent without authority; the guarantee absorbs that share.`,
  `- If no other party is implicated, the customer's claim fails and customer is 100.`,
  `- Do not state any money amounts. Amounts are computed in code from the order record.`,
  ``,
  `Call issue_ruling once with: case_id, split, reason_code (one of AGENT_OUTSIDE_MANDATE, MERCHANT_DATA_FAILURE, UNAUTHORISED_SESSION, CLAIM_NOT_SUPPORTED, SHARED_FAULT, or NO_FAULT_FOUND for a held payment that should be released) and a rationale of at most 80 words.`,
  `When the tool confirms, reply with the single word: done.`,
].join('\n');

export function challengeBrief(c: CaseFile, target: Role): string {
  const challenge = c.investigators[target].challenge!;
  const theirs = c.investigators[challenge.from].finding!;
  return [
    `CHALLENGE on case ${c.id}, from the ${ROLE_NAME[challenge.from]}:`,
    challenge.point,
    ``,
    `Their finding: liability ${theirs.liability}/100 on ${theirs.party}. ${theirs.summary}`,
    `CHALLENGE_JSON: ${JSON.stringify(theirs)}`,
    ``,
    `Answer with respond_to_challenge.`,
  ].join('\n');
}

export function arbiterBrief(c: CaseFile): string {
  const active = Object.values(c.investigators).filter((i) => i.finding);
  const findings = active.map((i) => i.finding!);
  return [
    `CASE: ${c.id}`,
    c.stage === 'hold'
      ? `This payment is being HELD before settlement (screen: ${c.flag}). If any party other than the customer is at fault, it will be blocked; if the split is customer 100, it is released.`
      : `Customer claim: "${c.claim}"`,
    ``,
    `Verified findings:`,
    ...active.map(({ finding: f, challenge: ch }) =>
      [
        `- ${ROLE_NAME[f!.role]} on ${f!.party}: liability ${f!.liability}/100, confidence ${f!.confidence}/100. ${f!.summary}`,
        ch?.status === 'answered' ? `  Challenged by the ${ROLE_NAME[ch.from]}; ${ch.stance === 'revise' ? `revised from ${ch.before}/100` : 'maintained'}: ${ch.reply}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    ``,
    `FINDINGS_JSON: ${JSON.stringify(findings)}`,
  ].join('\n');
}
