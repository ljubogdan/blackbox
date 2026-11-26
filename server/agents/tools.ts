import type { Tool } from '@mozaik-ai/core';
import type { Citation, Party, Role, Ruling } from '../../shared/types';
import { checkCitations } from './verify';
import { PARTIES, ROLE_NAME, ROLE_PARTY } from '../../shared/types';
import { note, publish, pushCase, state } from '../runtime';

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Who is calling is fixed by closure, so one agent cannot submit as another.
export function readEvidenceTool(reader: string, role?: Role): Tool {
  return {
    type: 'function',
    name: 'read_evidence',
    description: 'Read stored evidence records for a case. Returns each record with its id and fields.',
    parameters: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Record ids, e.g. ["MND-0007", "ORD-0007"]' },
      },
      required: ['case_id', 'evidence_ids'],
      additionalProperties: false,
    },
    strict: false,
    invoke: async ({ case_id, evidence_ids }: { case_id: string; evidence_ids: string[] }) => {
      const s = state();
      const c = s.cases.get(case_id);
      if (!c) return `Error: unknown case ${case_id}`;
      const ids = Array.isArray(evidence_ids) ? evidence_ids : [];
      const records = ids.map((id) => s.evidence.get(id)).filter((r) => r && r.caseId === case_id);
      const missing = ids.filter((id) => !records.some((r) => r!.id === id));
      if (role) {
        const inv = c.investigators[role];
        inv.readIds = [...new Set([...inv.readIds, ...records.map((r) => r!.id)])];
        pushCase(c);
      }
      note(c, reader, `read ${records.length} record${records.length === 1 ? '' : 's'}`);
      return { records, missing };
    },
  };
}

export function submitFindingTool(role: Role, agentId: () => string): Tool {
  return {
    type: 'function',
    name: 'submit_finding',
    description: 'Submit your finding for this case. Every citation is checked against the stored record.',
    parameters: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        liability: { type: 'number', description: '0-100' },
        confidence: { type: 'number', description: '0-100' },
        summary: { type: 'string' },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              evidence_id: { type: 'string' },
              field: { type: 'string' },
              value: { type: ['string', 'number', 'boolean', 'null'] },
            },
            required: ['evidence_id', 'field', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['case_id', 'liability', 'confidence', 'summary', 'citations'],
      additionalProperties: false,
    },
    strict: false,
    invoke: async (args: { case_id: string; liability: number; confidence: number; summary: string; citations: Citation[] }) => {
      const c = state().cases.get(args.case_id);
      if (!c) return `Error: unknown case ${args.case_id}`;
      const inv = c.investigators[role];
      if (inv.status === 'verified') return 'Error: your finding for this case is already verified.';
      const citations = Array.isArray(args.citations) ? args.citations : [];
      if (citations.length === 0) return 'Error: a finding needs at least one citation.';
      inv.finding = {
        role,
        party: ROLE_PARTY[role],
        liability: clamp(args.liability),
        confidence: clamp(args.confidence),
        summary: String(args.summary ?? '').slice(0, 600),
        citations,
      };
      inv.status = 'submitted';
      inv.checks = undefined;
      note(c, ROLE_NAME[role], `submitted a finding: liability ${inv.finding.liability}/100`);
      pushCase(c);
      publish('finding.submitted', agentId(), { caseId: c.id, role });
      return 'Received. The verifier is checking your citations.';
    },
  };
}

export function respondToChallengeTool(role: Role, agentId: () => string): Tool {
  return {
    type: 'function',
    name: 'respond_to_challenge',
    description: "Answer another investigator's challenge to your finding: maintain it, or revise your liability figure.",
    parameters: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        stance: { type: 'string', enum: ['maintain', 'revise'] },
        liability: { type: 'number', description: '0-100, your figure after considering the challenge' },
        reasoning: { type: 'string' },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { evidence_id: { type: 'string' }, field: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] } },
            required: ['evidence_id', 'field', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['case_id', 'stance', 'liability', 'reasoning', 'citations'],
      additionalProperties: false,
    },
    strict: false,
    invoke: async (args: { case_id: string; stance: string; liability: number; reasoning: string; citations: Citation[] }) => {
      const s = state();
      const c = s.cases.get(args.case_id);
      const inv = c?.investigators[role];
      if (!c || !inv?.finding || !inv.challenge) return 'Error: there is no open challenge for you on this case.';
      if (inv.challenge.status === 'answered') return 'Error: you have already answered this challenge.';
      const citations = Array.isArray(args.citations) ? args.citations : [];
      if (citations.length === 0) return 'Error: back your answer with at least one citation.';
      // Same rule as for findings: a cited value must match the stored record.
      const checks = checkCitations(c.id, citations, s.evidence);
      s.stats.citationsChecked += checks.length;
      const bad = checks.filter((k) => !k.ok);
      s.stats.citationsRejected += bad.length;
      if (bad.length > 0) return `Error: ${bad.map((k) => `${k.evidence_id}.${k.field} ${k.reason}`).join('; ')}. Correct the citation and answer again.`;
      const revised = args.stance === 'revise';
      inv.challenge = { ...inv.challenge, status: 'answered', stance: revised ? 'revise' : 'maintain', reply: String(args.reasoning ?? '').slice(0, 500), before: inv.finding.liability };
      if (revised) {
        inv.finding = { ...inv.finding, liability: clamp(args.liability) };
        s.stats.revised++;
      }
      note(c, ROLE_NAME[role], revised ? `revised its figure to ${inv.finding.liability}/100 after the challenge` : 'maintained its finding under challenge');
      pushCase(c);
      publish('challenge.answered', agentId(), { caseId: c.id, role });
      return 'Recorded.';
    },
  };
}

export function issueRulingTool(agentId: () => string): Tool {
  return {
    type: 'function',
    name: 'issue_ruling',
    description: 'Issue the ruling for a case: how responsibility is split between the four parties.',
    parameters: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        split: {
          type: 'object',
          properties: Object.fromEntries(PARTIES.map((p) => [p, { type: 'number' }])),
          required: PARTIES,
          additionalProperties: false,
        },
        reason_code: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['case_id', 'split', 'reason_code', 'rationale'],
      additionalProperties: false,
    },
    strict: false,
    invoke: async (args: { case_id: string; split: Record<Party, number>; reason_code: string; rationale: string; human_rejected?: boolean }) => {
      const c = state().cases.get(args.case_id);
      if (!c) return `Error: unknown case ${args.case_id}`;
      if (c.arbiter.ruling) return 'Error: this case already has a ruling.';
      const split = Object.fromEntries(PARTIES.map((p) => [p, Number(args.split?.[p])])) as Record<Party, number>;
      const valid = PARTIES.every((p) => Number.isInteger(split[p]) && split[p] >= 0);
      const sum = PARTIES.reduce((s, p) => s + split[p], 0);
      if (!valid || sum !== 100) return `Error: split must be four whole numbers that sum to 100 (got ${sum}).`;
      const ruling: Ruling = { split, reason_code: String(args.reason_code), rationale: String(args.rationale ?? '').slice(0, 900) };
      if (args.human_rejected) {
        c.arbiter = { status: 'failed' }; // the rejected proposal is not kept as a ruling
        c.status = 'manual_review';
        c.closedAt = Date.now();
        note(c, 'Risk officer', 'rejected the proposed ruling; case moved to manual review');
        pushCase(c);
        publish('case.closed', agentId(), { caseId: c.id });
        return 'The human reviewer rejected this ruling. The case has moved to manual review.';
      }
      c.arbiter = { status: 'done', ruling };
      note(c, 'Arbiter', `ruled ${ruling.reason_code}`);
      publish('ruling.issued', agentId(), { caseId: c.id });
      return 'Ruling recorded.';
    },
  };
}
