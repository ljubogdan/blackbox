import { create } from 'zustand';
import { play } from './sound';
import type { CaseFile, ClientMsg, EngineInfo, Lane, Party, PurchaseLite, Role, ServerMsg, Stats } from '../../shared/types';

export const PARTY_COLOR: Record<Party, string> = {
  customer: '#a78bfa',
  agent_provider: '#fbbf24',
  merchant: '#22d3ee',
  fraud: '#fb7185',
};
export const ROLE_COLOR: Record<Role, string> = {
  mandate: PARTY_COLOR.agent_provider,
  integrity: PARTY_COLOR.fraud,
  merchant: PARTY_COLOR.merchant,
  intent: PARTY_COLOR.customer,
};
export const MINT = '#7cf5d0';
export const BREACH = '#ff5a4d';

export interface Arc extends PurchaseLite {
  seenAt: number; // performance.now() when this browser first saw it
}

interface Store {
  connected: boolean;
  info: EngineInfo | null;
  stats: Stats | null;
  cases: Record<string, CaseFile>;
  arcs: Arc[];
  lanes: Lane[];
  skew: number; // server clock minus browser clock, ms
  view: 'live' | 'case';
  selected: string | null;
  inspect: { evidenceId: string; field?: string } | null;
  paused: boolean;
  sound: boolean;
  builder: boolean; // the "break it yourself" dialog
  limitPreview: number | null; // the limit being tried on the what-if slider
  pageMode: 'human' | 'agent';
  awaiting: string | null; // nonce of a case we asked for and want to open when it exists
  lastCreated: { nonce: string; caseId: string } | null;
  tour: { caption: string; step: number; of: number } | null;
  request: (msg: ClientMsg & { nonce: string }, open?: boolean) => void;
  set: (patch: Partial<Store>) => void;
  open: (caseId: string) => void;
  back: () => void;
  setInspect: (i: Store['inspect']) => void;
  send: (msg: ClientMsg) => void;
  setPaused: (p: boolean) => void;
}

let socket: WebSocket | null = null;

export const useStore = create<Store>((set, get) => ({
  connected: false,
  info: null,
  stats: null,
  cases: {},
  arcs: [],
  lanes: [],
  skew: 0,
  view: 'live',
  selected: null,
  inspect: null,
  paused: false,
  sound: false,
  builder: false,
  limitPreview: null,
  pageMode: 'human',
  awaiting: null,
  lastCreated: null,
  tour: null,
  request: (msg, open = true) => {
    if (open) set({ awaiting: msg.nonce });
    get().send(msg);
  },
  set: (patch) => set(patch),
  open: (caseId) => set({ view: 'case', selected: caseId, inspect: null, limitPreview: null, pageMode: 'human' }),
  back: () => set({ view: 'live', inspect: null, limitPreview: null }),
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
  if (before && !before.closedAt && after.closedAt) play(after.status === 'blocked' ? 'block' : 'verdict');
  if (before && Object.values(after.investigators).some((i) => i.status === 'rejected' && before.investigators[i.role].status !== 'rejected')) play('reject');
}

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
