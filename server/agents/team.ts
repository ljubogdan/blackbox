import {
  Agent,
  createAgent,
  createHuman,
  DeveloperMessageItem,
  ModelContext,
  SituationSpecification,
  type InterceptionHandler,
  type Participant,
  type SituationContext,
  type SituationHandler,
} from '@mozaik-ai/core';
import type { BoardRow, CaseFile, Lane, Party, PurchaseLite, Role, Ruling, SettlementLine } from '../../shared/types';
import { PARTIES, PARTY_NAME, ROLE_NAME, ROLES } from '../../shared/types';
import { config } from '../config';
import { round2 } from '../rng';
import { GuardedRunner } from '../model/guard';
import { join, note, publish, pushCase, resolveRuntime, runLoop, state } from '../runtime';
import { keyOf, push, splitKey } from '../state';
import { chainIntegrity } from '../data/scenarios';
import { dashboardUrl, type PaymentGateway } from '../payments/stripe';
import { ARBITER_INSTRUCTION, arbiterBrief, caseBrief, challengeBrief, investigatorInstruction } from './prompts';
import { learnable, marksIn } from './network';
import { screen } from './sentinel';
import { issueRulingTool, readEvidenceTool, respondToChallengeTool, submitFindingTool } from './tools';
import { checkCitations, missingCoverage } from './verify';

// The team. Nobody calls anybody: each participant declares the situations it
// reacts to, and the runtime fans every event out to all of them.
//
//   Intake (code)            publishes purchase.settled, purchase.pending and dispute.opened
//   Sentinel (code)          screens a pending payment and holds the risky ones before they settle
//   4 investigators (model)  wake on dispute.opened or purchase.held, all at once, one question each
//   Verifier (code)          wakes on finding.submitted, checks citations against records
//   Moderator (code)         when findings point at different parties, has them challenge each other
//   Arbiter (model)          wakes on case.ready, once the findings are verified and any challenge is answered
//   Risk officer (human)     approves or rejects rulings on large orders (interception)
//   Ledger (code)            wakes on ruling.issued, computes the money from the order record
//   Network (code)           wakes on case.closed, learns attack signatures from rulings and shares them with every merchant
//   Bridge (code)            observes everything and streams it to the browser

const when = (pred: (ctx: SituationContext) => boolean): SituationSpecification =>
  new (class extends SituationSpecification {
    isSatisfiedBy(ctx: SituationContext): boolean {
      return pred(ctx);
    }
  })();

const payloadOf = <T>(ctx: SituationContext) => ctx.event.payload as T;
const isOwn = (type: string) => when(({ event, participant }) => event.type === type && event.producerId === participant.getId());

// A turn that ended because the model could not be reached says so in its last message. Put the
// reason on the case file, so a case that stalls shows why instead of only "could not produce".
function noteModelFailure(ctx: SituationContext, c: CaseFile, who: string) {
  const text = payloadOf<{ answer?: { content?: { text?: string } } }>(ctx).answer?.content?.text ?? '';
  if (!text.startsWith('INFERENCE_ERROR: ')) return;
  note(c, who, `model call failed: ${text.slice('INFERENCE_ERROR: '.length, 220)}`);
  pushCase(c);
}

const codeParticipant = (name: string, handlers: SituationHandler[]) =>
  createAgent({ name, capabilities: ['code'], instruction: 'Code-only participant. It never calls a model.', tools: [], handlers });

// Start one agent turn on a context that belongs to this (case, agent) pair only.
function startLoop(agent: Agent, caseId: string, message: string, model: string, interception?: InterceptionHandler) {
  const s = state();
  const key = keyOf(caseId, agent.getManifest().name);
  let context = s.contexts.get(key);
  if (!context) {
    context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
    s.contexts.set(key, context);
    s.contextKey.set(context.id, key);
  }
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  s.running.set(key, { promise, resolve });
  runLoop(agent.getId(), message, { model, context, tools: agent.getTools(), maxOutputTokens: 1500 }, interception);
}

// Called from an agent's own model.answer: the loop for this key is now idle.
function loopEnded(loopId: string): { caseId: string; c: CaseFile | undefined } | null {
  const s = state();
  const key = s.loopKey.get(loopId);
  if (!key) return null;
  s.loopKey.delete(loopId);
  s.running.get(key)?.resolve();
  s.running.delete(key);
  const { caseId } = splitKey(key);
  return { caseId, c: s.cases.get(caseId) };
}

function closeUnresolved(c: CaseFile, who: string, why: string, senderId: string) {
  if (c.closedAt) return;
  c.status = 'manual_review';
  c.closedAt = Date.now();
  note(c, who, why);
  pushCase(c);
  publish('case.closed', senderId, { caseId: c.id });
}

// ───────────────────────── investigators ─────────────────────────

function createInvestigator(role: Role): Agent {
  const name = ROLE_NAME[role];
  let self: Agent;

  const attempt = (c: CaseFile, message: string) => {
    const inv = c.investigators[role];
    if (inv.attempts >= config.maxAttempts) {
      inv.status = 'failed';
      closeUnresolved(c, name, `could not produce a verifiable finding in ${config.maxAttempts} attempts`, self.getId());
      return;
    }
    inv.attempts++;
    inv.status = 'reading';
    pushCase(c);
    startLoop(self, c.id, message, config.investigatorModel);
  };

  const onDispute: SituationHandler = {
    specification: when(({ event }) => event.type === 'dispute.opened' || event.type === 'purchase.held'),
    processor: {
      apply(ctx) {
        const c = state().cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        if (!c || c.investigators[role].status === 'skipped') return;
        c.investigators[role].startedAt = Date.now();
        attempt(c, caseBrief(c));
      },
    },
  };

  // Check between agents: a rejected citation sends this investigator back to the records.
  const onRejected: SituationHandler = {
    specification: when(({ event }) => event.type === 'finding.rejected' && (event.payload as { role: Role }).role === role),
    processor: {
      async apply(ctx) {
        const { caseId, errors } = payloadOf<{ caseId: string; errors: string }>(ctx);
        const s = state();
        await s.running.get(keyOf(caseId, name))?.promise; // never run two turns on one context
        const c = s.cases.get(caseId);
        if (!c || c.closedAt) return;
        attempt(c, `The verifier rejected your finding:\n${errors}\nSubmit a corrected finding. Copy every cited value exactly from the record.`);
      },
    },
  };

  // Cross-examination: another investigator's finding points somewhere else.
  const onChallenged: SituationHandler = {
    specification: when(({ event }) => event.type === 'challenge.opened' && (event.payload as { target: Role }).target === role),
    processor: {
      async apply(ctx) {
        const { caseId } = payloadOf<{ caseId: string }>(ctx);
        const s = state();
        const key = keyOf(caseId, name);
        await s.running.get(key)?.promise; // the finding turn may still be finishing
        const c = s.cases.get(caseId);
        if (!c || c.closedAt || c.investigators[role].challenge?.status !== 'pending') return;
        s.challengeLoops.add(key);
        startLoop(self, c.id, challengeBrief(c, role), config.investigatorModel);
      },
    },
  };

  const onOwnAnswer: SituationHandler = {
    specification: isOwn('model.answer'),
    processor: {
      apply(ctx) {
        const ended = loopEnded(payloadOf<{ loopId: string }>(ctx).loopId);
        const c = ended?.c;
        if (!c || c.closedAt) return;
        noteModelFailure(ctx, c, name);
        const inv = c.investigators[role];
        const key = keyOf(c.id, name);
        if (state().challengeLoops.delete(key) && inv.challenge?.status === 'pending') {
          // The turn ended without an answer: the finding stands as it was.
          inv.challenge = { ...inv.challenge, status: 'answered', stance: 'maintain', reply: 'No answer was given; the finding stands as submitted.', before: inv.finding?.liability };
          note(c, name, 'did not answer the challenge; its finding stands');
          pushCase(c);
          publish('challenge.answered', self.getId(), { caseId: c.id, role });
          return;
        }
        // The turn ended and nothing was submitted.
        if (inv.status === 'reading') attempt(c, 'Your turn ended without a finding. Call submit_finding now.');
      },
    },
  };

  self = createAgent({
    name,
    capabilities: ['inference', `investigates:${role}`],
    instruction: investigatorInstruction(role),
    tools: [readEvidenceTool(name, role), submitFindingTool(role, () => self.getId()), respondToChallengeTool(role, () => self.getId())],
    handlers: [onDispute, onRejected, onChallenged, onOwnAnswer],
  });
  return self;
}

// ───────────────────────── verifier (code) ─────────────────────────

function createVerifier(): Agent {
  const onSubmitted: SituationHandler = {
    specification: when(({ event }) => event.type === 'finding.submitted'),
    processor: {
      apply(ctx) {
        const { caseId, role } = payloadOf<{ caseId: string; role: Role }>(ctx);
        const me = ctx.participant.getId();
        setTimeout(() => {
          const s = state();
          const c = s.cases.get(caseId);
          const inv = c?.investigators[role];
          if (!c || !inv?.finding || inv.status !== 'submitted') return;
          const checks = checkCitations(caseId, inv.finding.citations, s.evidence);
          inv.checks = checks;
          c.integrity = chainIntegrity(c.evidence); // re-walk the hash chain every time records are relied on
          s.stats.citationsChecked += checks.length;
          const bad = checks.filter((k) => !k.ok);
          s.stats.citationsRejected += bad.length;
          const missing = missingCoverage(role, caseId, inv.finding.citations, s.evidence);
          if (bad.length === 0 && missing.length === 0) {
            inv.status = 'verified';
            inv.finishedAt = Date.now();
            note(c, 'Verifier', `confirmed ${checks.length} citation${checks.length === 1 ? '' : 's'} from ${ROLE_NAME[role]}`);
            pushCase(c);
            publish('finding.verified', me, { caseId, role });
          } else {
            inv.status = 'rejected';
            const errors = [
              ...bad.map((k) => `- ${k.evidence_id}.${k.field}: you cited ${JSON.stringify(k.value)}; ${k.reason}${k.actual !== undefined ? ` (record says ${JSON.stringify(k.actual)})` : ''}`),
              ...missing.map((what) => `- your question is about ${what}, but you cited nothing from it`),
            ].join('\n');
            const why = [
              bad.length > 0 ? `${bad.length} citation${bad.length === 1 ? '' : 's'} did not match the record` : '',
              missing.length > 0 ? `nothing cited from ${missing.join(' or ')}` : '',
            ].filter(Boolean);
            note(c, 'Verifier', `rejected ${ROLE_NAME[role]}: ${why.join('; ')}`);
            pushCase(c);
            publish('finding.rejected', me, { caseId, role, errors });
          }
        }, 450);
      },
    },
  };
  return codeParticipant('Verifier', [onSubmitted]);
}

// ───────────────────────── arbiter ─────────────────────────

function createArbiter(): Agent {
  let self: Agent;
  const attempts = new Map<string, number>();

  // Human in the loop: a ruling on a large order is held mid-turn until a person
  // decides. Only this loop waits; every other agent keeps working.
  const approvalGate: InterceptionHandler = {
    isSatisfiedBy: (t) => t.nextStateId === 'function_call' && t.input.call.name === 'issue_ruling',
    async handle(t) {
      if (t.nextStateId !== 'function_call') return t;
      const s = state();
      let args: { case_id: string; split: Record<Party, number>; reason_code: string; rationale: string };
      try {
        args = JSON.parse(t.input.call.args);
      } catch {
        return t;
      }
      const c = s.cases.get(args.case_id);
      const total = Number(c?.evidence.find((e) => e.kind === 'ORD')?.data.total);
      const sum = PARTIES.reduce((n, p) => n + Number(args.split?.[p]), 0);
      // A held payment has not moved any money, so there is no payout to approve.
      if (!c || c.stage === 'hold' || !(total >= config.approvalThreshold) || sum !== 100) return t; // small order, or the tool will reject it anyway
      c.status = 'awaiting_approval';
      c.arbiter = { status: 'awaiting_approval', ruling: { split: args.split, reason_code: args.reason_code, rationale: args.rationale } };
      note(c, 'Arbiter', `ruling held for human approval (order of €${total.toFixed(2)} is at or above €${config.approvalThreshold})`);
      pushCase(c);
      publish('approval.requested', self.getId(), { caseId: c.id });
      const approved = await new Promise<boolean>((r) => s.approvals.set(c.id, r));
      c.status = 'arbitrating';
      c.arbiter = { status: 'deliberating' };
      if (approved) {
        note(c, 'Risk officer', 'approved the ruling');
        return t;
      }
      // Rejected: marked in shared state, never in the call's arguments, which the model writes.
      s.rejected.add(c.id);
      return t;
    },
  };

  const deliberate = (c: CaseFile, message: string) => {
    const n = (attempts.get(c.id) ?? 0) + 1;
    attempts.set(c.id, n);
    if (n > config.maxAttempts) {
      c.arbiter = { status: 'failed' };
      closeUnresolved(c, 'Arbiter', `could not issue a valid ruling in ${config.maxAttempts} attempts`, self.getId());
      return;
    }
    c.status = 'arbitrating';
    c.arbiter = { status: 'deliberating' };
    pushCase(c);
    startLoop(self, c.id, message, config.arbiterModel, approvalGate);
  };

  const onReady: SituationHandler = {
    specification: when(({ event }) => event.type === 'case.ready'),
    processor: {
      apply(ctx) {
        const s = state();
        const { caseId } = payloadOf<{ caseId: string }>(ctx);
        const c = s.cases.get(caseId);
        if (!c || c.closedAt || s.arbiterClaimed.has(caseId)) return;
        s.arbiterClaimed.add(caseId); // claimed synchronously, so two events cannot start two rulings
        deliberate(c, arbiterBrief(c));
      },
    },
  };

  const onOwnAnswer: SituationHandler = {
    specification: isOwn('model.answer'),
    processor: {
      apply(ctx) {
        const c = loopEnded(payloadOf<{ loopId: string }>(ctx).loopId)?.c;
        if (!c || c.closedAt) return;
        noteModelFailure(ctx, c, 'Arbiter');
        if (c.arbiter.status === 'deliberating') deliberate(c, 'Your turn ended without a ruling. Call issue_ruling now.');
      },
    },
  };

  const onApproval: SituationHandler = {
    specification: when(({ event }) => event.type === 'approval.decided'),
    processor: {
      apply(ctx) {
        const { caseId, approved } = payloadOf<{ caseId: string; approved: boolean }>(ctx);
        const s = state();
        s.approvals.get(caseId)?.(approved);
        s.approvals.delete(caseId);
      },
    },
  };

  self = createAgent({
    name: 'Arbiter',
    capabilities: ['inference', 'rules'],
    instruction: ARBITER_INSTRUCTION,
    tools: [readEvidenceTool('Arbiter'), issueRulingTool(() => self.getId())],
    handlers: [onReady, onOwnAnswer, onApproval],
  });
  return self;
}

// ───────────────────────── moderator (code) ─────────────────────────

const settledOrSkipped = (c: CaseFile) => ROLES.every((r) => ['verified', 'skipped'].includes(c.investigators[r].status));

// State-based trigger: the moderator acts when the shared case file is complete,
// whichever investigator happens to finish last. If two findings put real
// weight on different parties, each of those two investigators must answer the
// other's evidence before anyone rules. Otherwise the case goes straight on.
function createModerator(): Agent {
  const onVerified: SituationHandler = {
    specification: when(({ event }) => {
      if (event.type !== 'finding.verified') return false;
      const c = state().cases.get((event.payload as { caseId: string }).caseId);
      return !!c && !c.closedAt && settledOrSkipped(c);
    }),
    processor: {
      apply(ctx) {
        const s = state();
        const me = ctx.participant.getId();
        const { caseId } = payloadOf<{ caseId: string }>(ctx);
        if (s.moderated.has(caseId)) return;
        s.moderated.add(caseId);
        const c = s.cases.get(caseId)!;
        const weighty = ROLES.map((r) => c.investigators[r])
          .filter((i) => i.finding && i.finding.liability >= 10)
          .sort((a, b) => b.finding!.liability - a.finding!.liability);
        if (weighty.length < 2) {
          publish('case.ready', me, { caseId });
          return;
        }
        const [a, b] = weighty;
        c.crossExam = 'open';
        for (const [target, from] of [
          [b, a],
          [a, b],
        ] as const) {
          target.challenge = {
            from: from.role,
            status: 'pending',
            point: `I put ${from.finding!.liability}/100 on ${PARTY_NAME[from.finding!.party]}; you put ${target.finding!.liability}/100 on ${PARTY_NAME[target.finding!.party]}. Does your figure survive my evidence?`,
          };
          s.stats.challenges++;
        }
        note(c, 'Moderator', `${ROLE_NAME[a.role]} and ${ROLE_NAME[b.role]} point at different parties; each must answer the other`);
        pushCase(c);
        // Both challenges go out together, so the two answers are worked on at the same time.
        publish('challenge.opened', me, { caseId, target: b.role });
        publish('challenge.opened', me, { caseId, target: a.role });
      },
    },
  };

  const onAnswered: SituationHandler = {
    specification: when(({ event }) => event.type === 'challenge.answered'),
    processor: {
      apply(ctx) {
        const c = state().cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        if (!c || c.closedAt || c.crossExam !== 'open') return;
        if (ROLES.some((r) => c.investigators[r].challenge?.status === 'pending')) return;
        c.crossExam = 'closed';
        pushCase(c);
        publish('case.ready', ctx.participant.getId(), { caseId: c.id });
      },
    },
  };
  return codeParticipant('Moderator', [onVerified, onAnswered]);
}

// ───────────────────────── sentinel (code) ─────────────────────────

function createSentinel(): Agent {
  const onPending: SituationHandler = {
    specification: when(({ event }) => event.type === 'purchase.pending'),
    processor: {
      apply(ctx) {
        const s = state();
        const me = ctx.participant.getId();
        const c = s.cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        if (!c) return;
        // An attack the network already learned at another merchant needs no investigation.
        const known = marksIn(c)
          .map((m) => s.signatures.get(m.id))
          .find((sig) => !!sig);
        if (known) {
          c.network = { signature: known.id, label: known.label, sourceCaseId: known.learnedFrom, sourceMerchant: known.merchant };
          c.flag = `matches a known attack: ${known.label}`;
          for (const r of ROLES) c.investigators[r].status = 'skipped';
          c.status = 'arbitrating';
          c.arbiter = {
            status: 'done',
            ruling: {
              split: known.kind === 'widget' ? { customer: 0, agent_provider: 100, merchant: 0, fraud: 0 } : { customer: 0, agent_provider: 0, merchant: 0, fraud: 100 },
              reason_code: 'KNOWN_ATTACK',
              rationale: `Blocked on arrival: ${known.label}. The network learned this attack from ${known.learnedFrom} at ${known.merchant}, so no investigation was needed.`,
            },
          };
          s.stats.held++;
          note(c, 'Sentinel', `blocked on arrival: matches ${known.id}, learned from ${known.learnedFrom} at ${known.merchant}`);
          pushCase(c);
          publish('ruling.issued', me, { caseId: c.id });
          return;
        }
        const reason = screen(c);
        if (!reason) {
          // Nothing to look at: the payment goes through untouched.
          c.status = 'released';
          c.closedAt = Date.now();
          for (const r of ROLES) c.investigators[r].status = 'skipped';
          note(c, 'Sentinel', 'screened the payment and found nothing to check; released');
          pushCase(c);
          publish('purchase.settled', me, { purchase: { ...c.purchase, held: undefined }, quiet: true });
          publish('case.closed', me, { caseId: c.id });
          return;
        }
        c.flag = reason;
        s.stats.held++;
        note(c, 'Sentinel', `held the payment before settlement: ${reason}`);
        pushCase(c);
        publish('purchase.held', me, { caseId: c.id });
      },
    },
  };
  return codeParticipant('Sentinel', [onPending]);
}

// ───────────────────────── ledger (code) ─────────────────────────

// Money is never produced by a model: every amount is order total x share, in code, in whole cents.
// The refund is rounded once. What is recovered or absorbed is then shared out so that those lines
// add up to the refund exactly: rounding each share on its own can leave them a cent apart.
export function settle(c: CaseFile, ruling: Ruling): SettlementLine[] {
  const ord = c.evidence.find((e) => e.kind === 'ORD')!;
  const total = Number(ord.data.total);
  const cents = Math.round(total * 100);
  const f = (pct: number) => `€${total.toFixed(2)} × ${pct}%`;
  const source = `${ord.id}.total`;
  const refundPct = 100 - ruling.split.customer;
  const refund = Math.round((cents * refundPct) / 100);

  // Largest remainder: everyone gets their share rounded down, and the cents left over go to the
  // shares that lost the most by it.
  const payers = (['agent_provider', 'merchant', 'fraud'] as const).filter((p) => ruling.split[p] > 0);
  const owed = new Map(payers.map((p) => [p, Math.floor((cents * ruling.split[p]) / 100)]));
  let left = refund - [...owed.values()].reduce((sum, n) => sum + n, 0);
  for (const p of [...payers].sort((a, b) => ((cents * ruling.split[b]) % 100) - ((cents * ruling.split[a]) % 100))) {
    if (left <= 0) break;
    owed.set(p, owed.get(p)! + 1);
    left--;
  }

  const label: Record<(typeof payers)[number], string> = {
    agent_provider: `Recovered from ${c.purchase.provider}`,
    merchant: `Recovered from ${String(ord.data.merchant)}`,
    fraud: 'Absorbed by the guarantee',
  };
  return [
    { label: refundPct > 0 ? 'Refund to customer' : 'Claim denied, no refund', party: 'customer', formula: f(refundPct), amount: refund / 100, source },
    ...payers.map((p): SettlementLine => ({ label: label[p], party: p === 'fraud' ? 'guarantee' : p, formula: f(ruling.split[p]), amount: owed.get(p)! / 100, source })),
  ];
}

const top = (x: Record<Party, number>) => [...PARTIES].sort((a, b) => x[b] - x[a])[0];

function createLedger(): Agent {
  const row = (map: Map<string, BoardRow>, name: string): BoardRow => {
    let r = map.get(name);
    if (!r) map.set(name, (r = { name, purchases: 0, gmv: 0, cases: 0, atFault: 0, bps: config.premiumBps }));
    return r;
  };
  // The price of the guarantee for a party: the base rate plus that party's own loss rate.
  const reprice = (r: BoardRow) => {
    r.bps = Math.min(900, config.premiumBps + (r.gmv > 0 ? Math.round((r.atFault / r.gmv) * 10_000) : 0));
  };
  const publishBoard = () => {
    const s = state();
    const rank = (map: Map<string, BoardRow>) => [...map.values()].sort((a, b) => b.atFault - a.atFault || b.gmv - a.gmv).map((r) => ({ ...r }));
    s.stats.board = { providers: rank(s.providers), merchants: rank(s.merchants) };
  };
  const book = (purchase: PurchaseLite) => {
    const s = state();
    s.stats.purchases++;
    s.stats.gmv = round2(s.stats.gmv + purchase.total);
    s.stats.premiums = round2(s.stats.premiums + (purchase.total * config.premiumBps) / 10_000);
    for (const r of [row(s.providers, purchase.provider), row(s.merchants, purchase.merchant.name)]) {
      r.purchases++;
      r.gmv = round2(r.gmv + purchase.total);
      reprice(r);
    }
    publishBoard();
  };

  const onPurchase: SituationHandler = {
    specification: when(({ event }) => event.type === 'purchase.settled'),
    processor: {
      apply(ctx) {
        book(payloadOf<{ purchase: PurchaseLite }>(ctx).purchase);
      },
    },
  };

  const onRuling: SituationHandler = {
    specification: when(({ event }) => event.type === 'ruling.issued'),
    processor: {
      apply(ctx) {
        const s = state();
        const c = s.cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        const ruling = c?.arbiter.ruling;
        if (!c || !ruling || c.closedAt) return;
        const ord = c.evidence.find((e) => e.kind === 'ORD')!;
        const total = Number(ord.data.total);
        const truth = s.truths.get(c.id);

        if (c.stage === 'hold') {
          // Nothing has moved yet, so the outcome is binary: stop it, or let it through.
          const block = ruling.split.customer < 100;
          c.status = block ? 'blocked' : 'released';
          c.settlement = [
            {
              label: block ? 'Blocked before settlement, loss prevented' : 'Released to the merchant',
              party: block ? 'customer' : 'merchant',
              formula: `€${total.toFixed(2)} × 100%`,
              amount: total,
              source: `${ord.id}.total`,
            },
          ];
          if (block) {
            s.stats.blocked++;
            s.stats.prevented = round2(s.stats.prevented + total);
            if (c.network) {
              s.stats.networkCaught++;
              s.stats.networkPrevented = round2(s.stats.networkPrevented + total);
            }
          } else {
            s.stats.released++;
            book(c.purchase);
          }
          if (truth) {
            s.stats.scored++;
            if (block === truth.customer < 100) s.stats.agreed++;
          }
        } else {
          c.settlement = settle(c, ruling);
          for (const line of c.settlement) {
            if (line.party === 'customer') s.stats.refunds = round2(s.stats.refunds + line.amount);
            else if (line.party === 'guarantee') s.stats.absorbed = round2(s.stats.absorbed + line.amount);
            else s.stats.recovered = round2(s.stats.recovered + line.amount);
          }
          c.status = 'ruled';
          // Scoring only: compare the largest share with the scenario's ground truth.
          if (truth) {
            s.stats.scored++;
            if (top(truth) === top(ruling.split)) s.stats.agreed++;
          }
        }

        // Risk board: what each party's own conduct cost (or would have cost).
        const provider = row(s.providers, c.purchase.provider);
        const merchant = row(s.merchants, String(ord.data.merchant));
        provider.cases++;
        merchant.cases++;
        provider.atFault = round2(provider.atFault + (total * ruling.split.agent_provider) / 100);
        merchant.atFault = round2(merchant.atFault + (total * ruling.split.merchant) / 100);
        reprice(provider);
        reprice(merchant);
        publishBoard();

        c.closedAt = Date.now();
        if (truth) c.truth = truth;
        note(c, 'Ledger', `settled: ${c.settlement.map((l) => `${l.label} €${l.amount.toFixed(2)}`).join('; ')}`);
        pushCase(c);
        publish('case.closed', ctx.participant.getId(), { caseId: c.id });
      },
    },
  };
  return codeParticipant('Ledger', [onPurchase, onRuling]);
}

// ───────────────────────── payments (code) ─────────────────────────

// Mirrors each case's money in Stripe test mode. A held payment is authorised but not captured;
// the team's outcome then captures it (released) or cancels it (blocked). A disputed purchase is
// charged, and refunded by exactly the amount the Ledger computed. No model is involved, and a
// Stripe failure is written to the case's log without touching the ruling.
function createPayments(gateway: PaymentGateway): Agent {
  const payments = new Map<string, Promise<string | null>>(); // case id -> its Stripe payment id
  const finished = new Set<string>();
  // A case can close before its payment opens: a known attack is blocked, or a clean payment let
  // through, within the same event that opened it. Such a close is remembered and acted on as
  // soon as the payment exists.
  const closed = new Set<string>();
  const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;
  // The order record's total, the figure the Ledger computes from.
  const centsOf = (c: CaseFile) => Math.round(Number(c.evidence.find((e) => e.kind === 'ORD')!.data.total) * 100);
  const failed = (c: CaseFile, what: string, e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    if (c.payment) c.payment.status = 'failed';
    console.error(`[stripe] ${c.id}: ${what} failed: ${why}`); // on the console too, so a failing run cannot look clean
    note(c, 'Payments', `Stripe ${what} failed: ${why}`);
    pushCase(c);
  };

  const open = (c: CaseFile, how: 'authorise' | 'charge') => {
    const description = `Blackbox ${c.id}: ${c.purchase.item} at ${c.purchase.merchant.name}`;
    payments.set(
      c.id,
      gateway[how](c.id, centsOf(c), description).then(
        (id) => {
          c.payment = { id, url: dashboardUrl(id), status: how === 'authorise' ? 'authorised' : 'charged' };
          note(c, 'Payments', how === 'authorise' ? `Stripe authorised ${eur(centsOf(c))} without capturing it: ${id}` : `Stripe charged ${eur(centsOf(c))}, the purchase as it settled: ${id}`);
          pushCase(c);
          return id;
        },
        (e) => (failed(c, how === 'authorise' ? 'authorisation' : 'charge', e), null),
      ),
    );
  };

  const onOpened: SituationHandler = {
    specification: when(({ event }) => event.type === 'purchase.pending' || event.type === 'dispute.opened'),
    processor: {
      apply(ctx) {
        const c = state().cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        if (!c || payments.has(c.id)) return;
        open(c, ctx.event.type === 'purchase.pending' ? 'authorise' : 'charge');
        if (closed.has(c.id)) settleIn(c);
      },
    },
  };

  const onClosed: SituationHandler = {
    specification: when(({ event }) => event.type === 'case.closed'),
    processor: {
      apply(ctx) {
        const c = state().cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        if (!c) return;
        closed.add(c.id);
        settleIn(c);
      },
    },
  };

  // Settle the case's payment in Stripe the way the case closed: once, after the payment opened.
  function settleIn(c: CaseFile) {
    const pending = payments.get(c.id);
    if (!pending || finished.has(c.id)) return;
    finished.add(c.id);
    void pending.then(async (id) => {
      if (!id || !c.payment) return;
      const p = c.payment;
      try {
        if (c.status === 'released' && p.status === 'authorised') {
          await gateway.capture(id);
          p.status = 'captured';
          note(c, 'Payments', `Stripe captured ${eur(centsOf(c))}: released to the merchant`);
        } else if (c.status === 'blocked' && p.status === 'authorised') {
          await gateway.cancel(id);
          p.status = 'cancelled';
          note(c, 'Payments', 'Stripe cancelled the authorisation: blocked, nothing was charged');
        } else if (c.status === 'ruled' && p.status === 'charged') {
          const refund = c.settlement?.find((l) => l.party === 'customer' && l.label === 'Refund to customer');
          const cents = Math.round((refund?.amount ?? 0) * 100);
          if (cents <= 0) {
            note(c, 'Payments', 'no refund: the claim was denied, so the Stripe charge stands');
          } else {
            p.refund = await gateway.refund(id, cents);
            p.status = 'refunded';
            note(c, 'Payments', `Stripe refunded ${eur(cents)}, the Ledger's figure: ${p.refund}`);
          }
        } else if (p.status === 'authorised') {
          p.status = 'left_authorised';
          note(c, 'Payments', 'left the Stripe authorisation in place for manual review');
        }
        pushCase(c);
      } catch (e) {
        failed(c, 'settlement', e);
      }
    });
  }
  return codeParticipant('Payments', [onOpened, onClosed]);
}

// ───────────────────────── network (code) ─────────────────────────

// Learns from rulings and shares what it learned. Every merchant runs its own
// Blackbox; this participant is what makes them one network.
function createNetwork(): Agent {
  const onClosed: SituationHandler = {
    specification: when(({ event }) => event.type === 'case.closed'),
    processor: {
      apply(ctx) {
        const s = state();
        const me = ctx.participant.getId();
        const c = s.cases.get(payloadOf<{ caseId: string }>(ctx).caseId);
        const ruling = c?.arbiter.ruling;
        if (!c || !ruling) return;
        if (c.network) {
          // A catch: credit the signature that made it.
          const sig = s.signatures.get(c.network.signature);
          if (!sig) return;
          sig.catches++;
          sig.prevented = round2(sig.prevented + c.purchase.total);
          note(c, 'Network', `credited ${sig.id} with this catch`);
          publish('signature.updated', me, { id: sig.id });
          return;
        }
        if (!config.networkLearning || (c.status !== 'ruled' && c.status !== 'blocked')) return;
        const mark = learnable(c, ruling);
        if (!mark || s.signatures.has(mark.id)) return;
        s.signatures.set(mark.id, { ...mark, learnedFrom: c.id, merchant: c.purchase.merchant.name, at: Date.now(), catches: 0, prevented: 0 });
        s.stats.signatures = s.signatures.size;
        note(c, 'Network', `learned ${mark.id} from this ruling and shared it with every merchant`);
        pushCase(c);
        publish('signature.learned', me, { id: mark.id });
      },
    },
  };
  return codeParticipant('Network', [onClosed]);
}

// ───────────────────────── bridge (observer) ─────────────────────────

function createBridge(): Agent {
  let seq = 0;
  let lastStats = 0;
  const pushStats = (force = false) => {
    const now = Date.now();
    if (!force && now - lastStats < 400) return;
    lastStats = now;
    push({ type: 'stats', stats: { ...state().stats } });
  };

  const observe: SituationHandler = {
    specification: when(() => true),
    processor: {
      apply({ event }) {
        const s = state();
        const p = event.payload as Record<string, any>;
        switch (event.type) {
          case 'message_received.started': {
            const key = s.contextKey.get(p.input?.context?.id);
            if (key) s.loopKey.set(p.loopId, key);
            break;
          }
          case 'inference.started': {
            const key = s.loopKey.get(p.loopId);
            if (!key) break;
            // A tool call the model already asked for is being handed to the loop: no model is called.
            const runner = resolveRuntime().getInferenceRunner();
            if (runner instanceof GuardedRunner && runner.hasQueued(p.context)) break;
            const { caseId, agent } = splitKey(key);
            const lane: Lane = { loopId: `${p.loopId}#${++seq}`, agent, caseId, start: Date.now() };
            s.activeLanes.set(p.loopId, lane);
            s.lanes.push(lane);
            if (s.lanes.length > 400) s.lanes.shift();
            s.stats.inferences++;
            s.stats.peakConcurrent = Math.max(s.stats.peakConcurrent, s.activeLanes.size);
            push({ type: 'lane', lane });
            break;
          }
          case 'inference.completed': {
            const lane = s.activeLanes.get(p.loopId);
            if (!lane) break;
            lane.end = Date.now();
            s.activeLanes.delete(p.loopId);
            push({ type: 'lane', lane });
            break;
          }
          case 'purchase.settled':
            if (!p.quiet) push({ type: 'purchase', purchase: p.purchase });
            pushStats();
            break;
          case 'purchase.pending':
            push({ type: 'purchase', purchase: p.purchase });
            break;
          case 'signature.learned':
          case 'signature.updated': {
            const signature = s.signatures.get(p.id);
            if (signature) push({ type: 'signature', signature: { ...signature }, fresh: event.type === 'signature.learned' });
            pushStats(true);
            break;
          }
          case 'purchase.held':
          case 'dispute.opened': {
            const c = s.cases.get(p.caseId);
            if (c) pushCase(c);
            pushStats(true);
            break;
          }
          case 'case.closed': {
            if (s.cases.get(p.caseId)?.stage === 'dispute') s.stats.disputesClosed++;
            for (const [key, context] of s.contexts) {
              if (!key.startsWith(`${p.caseId}:`)) continue;
              s.contextKey.delete(context.id);
              s.contexts.delete(key);
            }
            // Keep the store bounded: drop the oldest closed cases and their evidence.
            const closed = [...s.cases.values()].filter((c) => c.closedAt).sort((a, b) => a.closedAt! - b.closedAt!);
            for (const old of closed.slice(0, Math.max(0, closed.length - 40))) {
              for (const e of old.evidence) s.evidence.delete(e.id);
              s.cases.delete(old.id);
              s.truths.delete(old.id);
            }
            pushStats(true);
            break;
          }
        }
      },
    },
  };
  return codeParticipant('Bridge', [observe]);
}

// ───────────────────────── assembly ─────────────────────────

export interface Team {
  intake: Agent;
  officer: Participant;
  roster: { name: string; kind: 'llm' | 'code' | 'human' }[];
}

export function assembleTeam(gateway?: PaymentGateway): Team {
  const bridge = createBridge();
  const intake = codeParticipant('Intake', []);
  const investigators = ROLES.map(createInvestigator);
  const sentinel = createSentinel();
  const verifier = createVerifier();
  const moderator = createModerator();
  const arbiter = createArbiter();
  const ledger = createLedger();
  const network = createNetwork();
  const officer = createHuman({ name: 'Risk officer', capabilities: ['approves-rulings'], handlers: [] });
  const payments = gateway ? createPayments(gateway) : null;

  // The bridge joins first so it has mapped a loop to its case before anyone else needs it.
  for (const p of [bridge, intake, sentinel, ...investigators, verifier, moderator, arbiter, ledger, network, officer, ...(payments ? [payments] : [])]) join(p);

  return {
    intake,
    officer,
    roster: [
      { name: 'Intake', kind: 'code' },
      { name: 'Sentinel', kind: 'code' },
      ...investigators.map((a) => ({ name: a.getManifest().name, kind: 'llm' as const })),
      { name: 'Verifier', kind: 'code' },
      { name: 'Moderator', kind: 'code' },
      { name: 'Arbiter', kind: 'llm' },
      { name: 'Risk officer', kind: 'human' },
      { name: 'Ledger', kind: 'code' },
      { name: 'Network', kind: 'code' },
      ...(payments ? [{ name: 'Payments', kind: 'code' as const }] : []),
      { name: 'Bridge', kind: 'code' },
    ],
  };
}
