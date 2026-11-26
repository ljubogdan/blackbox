import { create } from 'zustand';
import { play } from './sound';
import type { CaseFile, ClientMsg, EngineInfo, Lane, Party, PurchaseLite, Role, ServerMsg, Signature, Stats } from '../../shared/types';

export const PARTY_COLOR: Record<Party, string> = {
  customer: '#a593ff',
  agent_provider: '#f0b449',
  merchant: '#5cb8f2',
  fraud: '#f2708d',
};
export const ROLE_COLOR: Record<Role, string> = {
  mandate: PARTY_COLOR.agent_provider,
  integrity: PARTY_COLOR.fraud,
  merchant: PARTY_COLOR.merchant,
  intent: PARTY_COLOR.customer,
};
// Colour means outcome: work in progress is neutral, and only a result is coloured.
export const MINT = '#4fd1a1'; // inside the mandate, released
export const BREACH = '#ff5d47'; // outside the mandate, blocked
export const INK = '#f2f2f0'; // in progress, held
export const BG = '#09090b';

export interface Arc extends PurchaseLite {
  seenAt: number; // performance.now() when this browser first saw it
}

// The box means something different from each side: see views/Gate.tsx.
export type Lens = 'flow' | 'agents' | 'liability';

interface Store {
  connected: boolean;
  info: EngineInfo | null;
  stats: Stats | null;
  cases: Record<string, CaseFile>;
  arcs: Arc[];
  lanes: Lane[];
  skew: number; // server clock minus browser clock, ms
  view: 'network' | 'live' | 'case';
  selected: string | null;
  inspect: { evidenceId: string; field?: string } | null;
  paused: boolean;
  sound: boolean;
  builder: boolean; // the simulator dialog
  engine: boolean; // the engine drawer at the bottom
  lens: Lens; // which way the live view is being looked at
  lensGo: { to: Lens; n: number } | null; // a request to turn the box to a side
  hover: string | null; // the filed case under the pointer
  replayLens: Lens; // the same, for the replay of one case
  replayGo: { to: Lens; n: number } | null;
  entering: { caseId: string; at: number } | null; // the camera is diving into the box towards this case
  // Three levels: the network of every merchant's box, one merchant's box, one case.
  merchant: string | null; // the box being looked at in the 'live' view
  lastMerchant: string | null; // the box just left, so the network view can pull out of it
  boxing: { merchant: string; at: number } | null; // the camera is flying from the network into this box
  from: 'network' | 'live'; // where a case was opened from
  signatures: Record<string, Signature>;
  waves: { merchant: string; label: string; at: number }[]; // signatures learned while this page was open
  catches: { caseId: string; merchant: string; source: string; total: number; at: number }[]; // payments the network stopped
  focus: string | null; // the merchant whose city the globe has turned to; the case list shows only its cases
  focusCity: (merchant: string | null) => void;
  enterBox: (merchant: string) => void;
  toNetwork: () => void;
  limitPreview: number | null; // the limit being tried on the what-if slider
  pageMode: 'human' | 'agent';
  awaiting: string | null; // nonce of a case we asked for and want to open when it exists
  lastCreated: { nonce: string; caseId: string } | null;
  request: (msg: ClientMsg & { nonce: string }, open?: boolean) => void;
  set: (patch: Partial<Store>) => void;
  open: (caseId: string) => void;
  back: () => void;
  setInspect: (i: Store['inspect']) => void;
  send: (msg: ClientMsg) => void;
  setPaused: (p: boolean) => void;
}

let socket: WebSocket | null = null;

// The box an open case goes back to. A case opened from inside one box can belong to another
// (a simulation, a ruling waiting for approval), so its own merchant wins over the box last looked at.
export const caseBox = (s: Store): string | null =>
  s.view === 'case' && s.from === 'live' ? (s.selected && s.cases[s.selected]?.purchase.merchant.name) || s.merchant : null;

export const useStore = create<Store>((set, get) => ({
  connected: false,
  info: null,
  stats: null,
  cases: {},
  arcs: [],
  lanes: [],
  skew: 0,
  view: 'network',
  selected: null,
  inspect: null,
  paused: false,
  sound: false,
  builder: false,
  engine: false,
  lens: 'flow',
  lensGo: null,
  hover: null,
  replayLens: 'flow',
  replayGo: null,
  entering: null,
  merchant: null,
  lastMerchant: null,
  boxing: null,
  from: 'network',
  signatures: {},
  waves: [],
  catches: [],
  focus: null,
  focusCity: (focus) => set({ focus, hover: null }),
  limitPreview: null,
  pageMode: 'human',
  awaiting: null,
  lastCreated: null,
  request: (msg, open = true) => {
    if (open) set({ awaiting: msg.nonce });
    get().send(msg);
  },
  set: (patch) => set(patch),
  open: (caseId) => {
    const view = get().view;
    const from = view === 'case' ? get().from : view;
    const arrive = () => set({ view: 'case', from, selected: caseId, inspect: null, limitPreview: null, pageMode: 'human', replayLens: 'flow', replayGo: null, entering: null, boxing: null, hover: null });
    // From a merchant's box, the camera dives into it first; the replay is what is inside it.
    // A case that sits in another merchant's box is not in this one to dive towards.
    const home = get().cases[caseId]?.purchase.merchant.name;
    if (view !== 'live' || (home && home !== get().merchant)) return arrive();
    if (get().entering) return;
    set({ entering: { caseId, at: performance.now() } });
    setTimeout(arrive, DIVE_MS);
  },
  // One level up: case to wherever it was opened from, box to the network.
  back: () => {
    if (get().view === 'network' && get().focus) return set({ focus: null });
    const box = caseBox(get());
    if (box) return set({ view: 'live', merchant: box, inspect: null, limitPreview: null, entering: null });
    get().toNetwork();
  },
  enterBox: (merchant) => {
    if (get().boxing) return;
    set({ boxing: { merchant, at: performance.now() }, hover: null });
    setTimeout(() => set({ view: 'live', merchant, boxing: null, lensGo: { to: 'flow', n: Date.now() } }), DIVE_MS);
  },
  toNetwork: () => set((s) => ({ view: 'network', lastMerchant: s.merchant, merchant: null, inspect: null, limitPreview: null, entering: null, boxing: null, hover: null })),
  setInspect: (inspect) => set({ inspect }),
  send: (msg) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg)),
  setPaused: (paused) => {
    set({ paused });
    get().send({ type: 'pace', paused });
  },
}));

// Sound cues, from what changed between two versions of a case.
function cue(before: CaseFile | undefined, after: CaseFile) {
  if (!useStore.getState().sound) return;
  if (!before && after.stage === 'hold') play('hold');
  if (before && before.status !== 'awaiting_approval' && after.status === 'awaiting_approval') play('ask');
  if (before && !before.closedAt && after.closedAt) play(after.status === 'blocked' ? 'block' : 'verdict');
  if (before && Object.values(after.investigators).some((i) => i.status === 'rejected' && before.investigators[i.role].status !== 'rejected')) play('reject');
}

export const DIVE_MS = 900;

export const nonce = () => Math.random().toString(36).slice(2, 10);

function apply(msg: ServerMsg) {
  const s = useStore.getState();
  switch (msg.type) {
    case 'hello':
      useStore.setState({
        info: msg.info,
        stats: msg.stats,
        cases: Object.fromEntries(msg.cases.map((c) => [c.id, c])),
        lanes: msg.lanes,
        signatures: Object.fromEntries(msg.signatures.map((x) => [x.id, x])),
        skew: msg.now - Date.now(),
        // Replay only the open disputes; old clean purchases have already landed.
        arcs: msg.purchases.filter((p) => p.caseId).map((p) => ({ ...p, seenAt: performance.now() - 4000 })),
      });
      break;
    case 'purchase':
      useStore.setState({ arcs: [...s.arcs.slice(-80), { ...msg.purchase, seenAt: performance.now() }] });
      break;
    case 'case':
      cue(s.cases[msg.case.id], msg.case);
      // The network stopped a payment: remember it so the network view can show where, and from where.
      if (msg.case.network && msg.case.closedAt && !s.cases[msg.case.id]?.closedAt)
        useStore.setState({
          catches: [
            ...s.catches.slice(-20),
            { caseId: msg.case.id, merchant: msg.case.purchase.merchant.name, source: msg.case.network.sourceMerchant, total: msg.case.purchase.total, at: performance.now() },
          ],
        });
      useStore.setState({ cases: { ...s.cases, [msg.case.id]: msg.case } });
      break;
    case 'created':
      useStore.setState({ lastCreated: { nonce: msg.nonce, caseId: msg.caseId } });
      if (s.awaiting === msg.nonce) {
        useStore.setState({ awaiting: null });
        s.open(msg.caseId);
      }
      break;
    case 'stats':
      useStore.setState({ stats: msg.stats });
      break;
    case 'signature':
      useStore.setState({
        signatures: { ...s.signatures, [msg.signature.id]: msg.signature },
        waves: msg.fresh ? [...s.waves.slice(-10), { merchant: msg.signature.merchant, label: msg.signature.label, at: performance.now() }] : s.waves,
      });
      break;
    case 'lane': {
      const i = s.lanes.findIndex((l) => l.loopId === msg.lane.loopId);
      const lanes = i >= 0 ? s.lanes.map((l, j) => (j === i ? msg.lane : l)) : [...s.lanes.slice(-300), msg.lane];
      useStore.setState({ lanes });
      break;
    }
  }
}

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.onopen = () => useStore.setState({ connected: true });
  socket.onmessage = (e) => apply(JSON.parse(e.data));
  socket.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 1200);
  };
}

export const eur = (n: number, digits = 2) =>
  `€${n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export function caseList(cases: Record<string, CaseFile>): CaseFile[] {
  return Object.values(cases).sort((a, b) => b.openedAt - a.openedAt);
}

// Rulings waiting for a person, the one that has waited longest first.
export function waitingCases(cases: Record<string, CaseFile>): CaseFile[] {
  return Object.values(cases)
    .filter((c) => c.status === 'awaiting_approval' && c.arbiter.ruling)
    .sort((a, b) => a.openedAt - b.openedAt);
}

export function topParty(split: Record<Party, number>): Party {
  return (Object.keys(split) as Party[]).sort((a, b) => split[b] - split[a])[0];
}

export const STATUS_LABEL: Record<CaseFile['status'], string> = {
  investigating: 'Investigating',
  arbitrating: 'Arbiter deliberating',
  awaiting_approval: 'Needs your approval',
  ruled: 'Ruled',
  blocked: 'Blocked before settlement',
  released: 'Released',
  manual_review: 'Manual review',
  failed: 'Failed',
};
