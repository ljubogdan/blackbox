import { EventEmitter } from 'node:events';
import { ModelContext, RuntimeState } from '@mozaik-ai/core';
import type { BoardRow, CaseFile, EvidenceRecord, Lane, Party, PurchaseLite, ServerMsg, Signature, Stats } from '../shared/types';
import { config } from './config';

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

// Everything the participants share lives here, on Mozaik's RuntimeState.
export class BlackboxState extends RuntimeState {
  evidence = new Map<string, EvidenceRecord>();
  cases = new Map<string, CaseFile>();
  truths = new Map<string, Record<Party, number>>();
  purchases: PurchaseLite[] = [];

  // One fresh ModelContext per (case, agent). Two live loops never share one.
  contexts = new Map<string, ModelContext>(); // key -> context
  contextKey = new Map<string, string>(); // context id -> key
  loopKey = new Map<string, string>(); // loop id -> key
  running = new Map<string, Deferred>(); // key -> settles when that loop goes idle

  arbiterClaimed = new Set<string>(); // case ids the arbiter has taken
  moderated = new Set<string>(); // case ids the moderator has already looked at
  challengeLoops = new Set<string>(); // keys whose current turn is answering a challenge

  // Running totals per agent provider and per merchant, for the risk board.
  providers = new Map<string, BoardRow>();
  merchants = new Map<string, BoardRow>();
  approvals = new Map<string, (approved: boolean) => void>(); // case id -> waiting interception
  rejected = new Set<string>(); // case ids whose proposed ruling a person rejected

  // Attacks the network has learned, by signature id.
  signatures = new Map<string, Signature>();

  activeLanes = new Map<string, Lane>();
  lanes: Lane[] = [];

  stats: Stats = {
    purchases: 0,
    gmv: 0,
    premiums: 0,
    disputesOpened: 0,
    disputesClosed: 0,
    refunds: 0,
    recovered: 0,
    absorbed: 0,
    citationsChecked: 0,
    citationsRejected: 0,
    peakConcurrent: 0,
    inferences: 0,
    agreed: 0,
    scored: 0,
    premiumBps: config.premiumBps,
    held: 0,
    blocked: 0,
    released: 0,
    prevented: 0,
    challenges: 0,
    revised: 0,
    networkCaught: 0,
    spentUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    networkPrevented: 0,
    signatures: 0,
    board: { providers: [], merchants: [] },
  };
}

export const keyOf = (caseId: string, agent: string) => `${caseId}:${agent}`;
export const splitKey = (key: string) => {
  const i = key.indexOf(':');
  return { caseId: key.slice(0, i), agent: key.slice(i + 1) };
};

// Outbound channel to the browser. Only the Bridge participant writes to it.
export const ui = new EventEmitter();
export const push = (msg: ServerMsg) => ui.emit('msg', msg);
