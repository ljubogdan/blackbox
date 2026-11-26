// Types shared by the Mozaik engine (server) and the 3D client (web).

export type Party = 'customer' | 'agent_provider' | 'merchant' | 'fraud';
export const PARTIES: Party[] = ['customer', 'agent_provider', 'merchant', 'fraud'];

export type Role = 'mandate' | 'integrity' | 'merchant' | 'intent';
export const ROLES: Role[] = ['mandate', 'integrity', 'merchant', 'intent'];

// Which party each investigator examines.
export const ROLE_PARTY: Record<Role, Party> = {
  mandate: 'agent_provider',
  integrity: 'fraud',
  merchant: 'merchant',
  intent: 'customer',
};

export const ROLE_NAME: Record<Role, string> = {
  mandate: 'Mandate Analyst',
  integrity: 'Session Forensics',
  merchant: 'Listing Auditor',
  intent: 'Claim Examiner',
};

export const PARTY_NAME: Record<Party, string> = {
  customer: 'Customer',
  agent_provider: 'Agent provider',
  merchant: 'Merchant',
  fraud: 'Fraud (guarantee absorbs)',
};

export type Scalar = string | number | boolean | null;

export type EvidenceKind = 'MND' | 'TRL' | 'LST' | 'ORD' | 'SES' | 'CLM' | 'DLV';

export interface EvidenceRecord {
  id: string; // e.g. ORD-0042
  kind: EvidenceKind;
  caseId: string;
  title: string;
  data: Record<string, Scalar>;
  // Tamper evidence: each record's hash covers its content and the previous record's hash.
  prev: string;
  hash: string;
}

export interface Citation {
  evidence_id: string;
  field: string;
  value: Scalar;
}

export interface CitationCheck extends Citation {
  ok: boolean;
  actual: Scalar | undefined;
  reason?: string;
}

export interface Finding {
  role: Role;
  party: Party;
  liability: number; // 0-100: how much of the loss the evidence puts on this party
  confidence: number; // 0-100
  summary: string;
  citations: Citation[];
}

export type InvestigatorStatus = 'queued' | 'reading' | 'submitted' | 'verified' | 'rejected' | 'failed' | 'skipped';

// One investigator questioning another's finding before the arbiter rules.
export interface Challenge {
  from: Role;
  point: string;
  status: 'pending' | 'answered';
  stance?: 'maintain' | 'revise';
  reply?: string;
  before?: number; // liability before the challenge
}

export interface InvestigatorState {
  role: Role;
  status: InvestigatorStatus;
  attempts: number;
  finding?: Finding;
  checks?: CitationCheck[];
  readIds: string[];
  challenge?: Challenge;
  startedAt?: number;
  finishedAt?: number;
}

export interface TrailStep {
  n: number;
  kind: 'mandate' | 'search' | 'view' | 'compare' | 'select' | 'addon' | 'cart' | 'checkout' | 'session';
  label: string;
  price: number | null; // amount in focus at this step, in mandate currency
  drift: number; // 0 = inside the mandate's scope; >0 = off-scope (different actor, category or merchant)
  actor: 'agent' | 'unknown';
  evidenceId: string;
}

export interface GeoPoint {
  city: string;
  country: string;
  lat: number;
  lon: number;
}

export interface PurchaseLite {
  id: string;
  at: number;
  buyer: GeoPoint;
  merchant: GeoPoint & { name: string };
  provider: string;
  item: string;
  total: number;
  caseId?: string;
  held?: boolean; // stopped before settlement while the team checks it
}

export interface Ruling {
  split: Record<Party, number>; // sums to 100
  reason_code: string;
  rationale: string;
}

export interface SettlementLine {
  label: string;
  party: Party | 'guarantee';
  formula: string;
  amount: number;
  source: string; // evidence id the amount derives from
}

export type CaseStatus = 'investigating' | 'arbitrating' | 'awaiting_approval' | 'ruled' | 'blocked' | 'released' | 'manual_review' | 'failed';

export interface CaseFile {
  id: string;
  // hold: caught before the money moved. dispute: the customer complained afterwards.
  stage: 'hold' | 'dispute';
  flag?: string; // why the screen held it
  whatIfOf?: string; // set on a re-run of another case with a different limit
  custom?: boolean; // built by a person in the UI
  crossExam: 'none' | 'open' | 'closed';
  integrity: { ok: boolean; records: number; head: string };
  purchase: PurchaseLite;
  openedAt: number;
  closedAt?: number;
  status: CaseStatus;
  claim: string;
  mandate: { text: string; maxAmount: number; quantity: number; category: string };
  steps: TrailStep[];
  evidence: EvidenceRecord[];
  investigators: Record<Role, InvestigatorState>;
  arbiter: { status: 'waiting' | 'deliberating' | 'awaiting_approval' | 'done' | 'failed'; ruling?: Ruling };
  settlement?: SettlementLine[];
  // Scenario ground truth. Only attached once the case is closed, never shown to the agents.
  truth?: Record<Party, number>;
  log: { t: number; who: string; text: string }[];
}

export interface Stats {
  purchases: number;
  gmv: number;
  premiums: number;
  disputesOpened: number;
  disputesClosed: number;
  refunds: number;
  recovered: number;
  absorbed: number;
  citationsChecked: number;
  citationsRejected: number;
  peakConcurrent: number;
  inferences: number;
  agreed: number; // outcomes that match the scenario ground truth
  scored: number; // closed cases that have a ground truth to compare with
  premiumBps: number;
  held: number;
  blocked: number;
  released: number;
  prevented: number; // value of payments blocked before settlement
  challenges: number;
  revised: number; // findings changed after a challenge
  board: { providers: BoardRow[]; merchants: BoardRow[] };
}

export interface BoardRow {
  name: string;
  purchases: number;
  gmv: number;
  cases: number;
  atFault: number; // loss attributed to this party by rulings
  bps: number; // what the guarantee should cost for this party, in basis points
}

export interface Lane {
  loopId: string;
  agent: string;
  caseId: string;
  start: number;
  end?: number;
}

export interface EngineInfo {
  mode: 'scripted' | 'live';
  model: string;
  faultRate: number;
  approvalThreshold: number;
  participants: { name: string; kind: 'llm' | 'code' | 'human' }[];
}

export type ServerMsg =
  | { type: 'hello'; info: EngineInfo; stats: Stats; cases: CaseFile[]; purchases: PurchaseLite[]; lanes: Lane[]; now: number }
  | { type: 'purchase'; purchase: PurchaseLite }
  | { type: 'case'; case: CaseFile }
  | { type: 'stats'; stats: Stats }
  | { type: 'lane'; lane: Lane }
  | { type: 'created'; caseId: string; nonce: string };

export type ClientMsg =
  | { type: 'approve'; caseId: string; approved: boolean }
  | { type: 'trigger'; scenario: string }
  | { type: 'pace'; paused: boolean }
  | { type: 'custom'; nonce: string; spec: CustomSpec }
  | { type: 'whatif'; nonce: string; caseId: string; max: number };

export const SCENARIOS = ['injection', 'quantity', 'price_switch', 'hidden_fee', 'hijack', 'friendly'] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type Sabotage = Scenario | 'clean';

export interface CustomSpec {
  item: number; // index into the catalogue
  max: number;
  sabotage: Sabotage;
  stage: 'hold' | 'dispute';
}

export const CATALOG_TITLES = [
  'Trail running shoes, size 43',
  'Noise-cancelling headphones',
  '27-inch 4K monitor',
  'Espresso machine',
  'Robot vacuum',
  'Mechanical keyboard',
  'Winter jacket, size M',
  'Ultrabook 14-inch',
  'Smartwatch',
  'Air purifier',
  'Water filter cartridge',
  'Standing desk frame',
];
export const CATALOG_PRICES = [104, 229, 349, 279, 319, 139, 189, 949, 259, 199, 34, 389];

// Invented names of the companies whose shopping agents make the purchases.
export const PROVIDER_NAMES = ['Orbit Assist', 'Kestrel Agent', 'Mira Shopper', 'Pilot One', 'Tandem'];
