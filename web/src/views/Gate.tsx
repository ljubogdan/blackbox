import { MeshReflectorMaterial, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { CaseFile, Party } from '../../../shared/types';
import { PARTIES, PARTY_NAME, PROVIDER_NAMES } from '../../../shared/types';
import { BG, BREACH, caseList, DIVE_MS, eur, INK, MINT, PARTY_COLOR, topParty, useStore, waitingCases, type Arc, type Lens } from '../store';
import { Label, LabelLayer, locate, Projector, setAnchor, useAnchor } from './labels';

// The live view: a glass box that every purchase passes through. Its three
// axes each mean one thing, so each side of the box is a different reading.
//   length (x) = where the payment is: before settlement, inside the box,
//                settled. Inside, the box is divided into bays: one where
//                held payments wait, then one per party a ruling can hold
//                liable. A decided case is filed in the bay of who was liable.
//   height (y) = the order value, on a log scale
//   depth  (z) = which agent provider made the purchase (one lane each)
// From the side you read the flow. From the front, the cases by agent
// provider and order value. From above, agent provider against who was liable.

const XL = -10; // where a purchase appears
const XR = 10; // where it is paid out
const BOX_H = 3.3;
const GAP = 0.95; // distance between lanes
const ZW = ((PROVIDER_NAMES.length - 1) / 2) * GAP + 0.75; // half-depth of the box
const BX = 2.0; // half-length of the box
const BAYS = ['held', ...PARTIES] as const;
const BAY_W = (BX * 2) / BAYS.length;
const bayX = (i: number) => -BX + (i + 0.5) * BAY_W;
const HOLD_X = bayX(0);
const partyX = (p: Party) => bayX(1 + PARTIES.indexOf(p));
const SPEED = 2.5; // units per second
const TAIL = 2.6;
const TICKS = [10, 100, 1000];
const MAX_VALUE = 5000;

const laneZ = (provider: string) => (Math.max(0, PROVIDER_NAMES.indexOf(provider)) - (PROVIDER_NAMES.length - 1) / 2) * GAP;
const yOf = (amount: number) =>
  0.3 + ((Math.log10(THREE.MathUtils.clamp(amount, 10, MAX_VALUE)) - 1) / (Math.log10(MAX_VALUE) - 1)) * (BOX_H - 0.6);
const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
const ease = (k: number) => k * k * (3 - 2 * k);

const NEUTRAL = new THREE.Color('#8d8d94'); // not yet in the box
const RECORDED = new THREE.Color(INK); // in it or through it, and on the record
const HELD = new THREE.Color(INK);
const OK = new THREE.Color(MINT);
const STOP = new THREE.Color(BREACH);
const GREY = new THREE.Color('#77777d');

const plainVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const threadShader = {
  vertexShader: plainVertex,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uAlpha;
    varying vec2 vUv;
    void main() {
      float u = clamp(vUv.x, 0.0, 1.0);
      float across = clamp(1.0 - abs(vUv.y * 2.0 - 1.0), 0.0, 1.0);
      float body = u * u * across * across;
      gl_FragColor = vec4(uColor * (0.7 + 1.5 * u * u * u * u), body * uAlpha);
    }`,
};

const glassShader = {
  vertexShader: plainVertex,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vec2 e = abs(vUv * 2.0 - 1.0);
      float edge = max(e.x, e.y);
      float rim = edge * edge * edge * edge * edge * edge;
      gl_FragColor = vec4(vec3(0.95, 0.95, 0.94), 0.012 + 0.06 * rim);
    }`,
};

const footprintShader = {
  vertexShader: plainVertex,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float across = clamp(1.0 - abs(p.x), 0.0, 1.0);
      float along = clamp(1.0 - abs(p.y), 0.0, 1.0);
      gl_FragColor = vec4(vec3(0.95), 0.08 * across * across * smoothstep(0.0, 0.5, along));
    }`,
};

// Two crossed strips running from x = -1 (the tail) to x = 0 (the head), so a
// purchase reads as a line from any camera angle.
function threadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // prettier-ignore
  const position = [
    -1, -0.5, 0,  0, -0.5, 0,  0, 0.5, 0,  -1, 0.5, 0,
    -1, 0, -0.5,  0, 0, -0.5,  0, 0, 0.5,  -1, 0, 0.5,
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

interface Thread {
  tail: THREE.Mesh;
  material: THREE.ShaderMaterial;
  head: THREE.Mesh;
  born: number;
  y: number;
  z: number;
  caseId?: string;
  held: boolean;
  rest: number; // where a disputed purchase waits, past the box
  stamped: boolean;
  marker?: THREE.Group;
  markerMaterial?: THREE.MeshBasicMaterial;
  pulse?: THREE.Mesh;
  tether?: THREE.Line;
  closedAt?: number;
  summonedAt?: number; // when its ruling stopped to wait for a person
}

interface Stamp {
  mesh: THREE.Mesh;
  born: number;
}

// A case that ends with someone liable is filed in the box. A released hold is not: nothing was wrong with it.
const isFiled = (c: CaseFile) => !!c.closedAt && !!c.arbiter.ruling && (c.status === 'ruled' || c.status === 'blocked');

function outcomeColor(c: CaseFile): THREE.Color {
  if (c.status === 'released') return OK;
  if (isFiled(c)) return new THREE.Color(PARTY_COLOR[topParty(c.arbiter.ruling!.split)]);
  return GREY;
}

// Managed imperatively: there are dozens alive at once and none needs React state.
function Threads() {
  const group = useRef<THREE.Group>(null!);
  const live = useRef(new Map<string, Thread>());
  const stamps = useRef<Stamp[]>([]);
  const { camera } = useThree();
  const geo = useMemo(
    () => ({
      thread: threadGeometry(),
      head: new THREE.SphereGeometry(0.026, 10, 10),
      diamond: new THREE.RingGeometry(0.085, 0.108, 4, 1),
      diamondCore: new THREE.CircleGeometry(0.05, 4),
      ring: new THREE.RingGeometry(0.085, 0.102, 48, 1),
      ringCore: new THREE.CircleGeometry(0.04, 24),
      stamp: new THREE.RingGeometry(0.05, 0.062, 4, 1),
    }),
    [],
  );

  useEffect(() => {
    const threads = live.current;
    return () => {
      for (const th of threads.values()) if (th.caseId) setAnchor(`case:${th.caseId}`, null);
    };
  }, []);

  function spawn(a: Arc): Thread {
    const material = new THREE.ShaderMaterial({
      ...threadShader,
      uniforms: { uColor: { value: NEUTRAL.clone() }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const tail = new THREE.Mesh(geo.thread, material);
    const head = new THREE.Mesh(geo.head, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, toneMapped: false }));
    group.current.add(tail, head);
    const held = !!a.held;
    const th: Thread = { tail, material, head, born: a.seenAt, y: yOf(a.total), z: laneZ(a.provider), caseId: a.caseId, held, rest: BX + 1.5 + (a.at % 5) * 0.5, stamped: false };

    if (a.caseId) {
      // A held payment is a diamond inside the box; a disputed one is a ring on the settled side.
      const markerMaterial = new THREE.MeshBasicMaterial({ color: INK, transparent: true, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
      const marker = new THREE.Group();
      marker.add(new THREE.Mesh(held ? geo.diamond : geo.ring, markerMaterial), new THREE.Mesh(held ? geo.diamondCore : geo.ringCore, markerMaterial));
      const pulse = new THREE.Mesh(held ? geo.diamond : geo.ring, new THREE.MeshBasicMaterial({ color: INK, transparent: true, depthTest: false, toneMapped: false, side: THREE.DoubleSide }));
      marker.add(pulse);
      marker.visible = false;
      marker.renderOrder = 5;
      group.current.add(marker);
      Object.assign(th, { marker, markerMaterial, pulse });
      if (!held) {
        const tether = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(BX, th.y, th.z), new THREE.Vector3(th.rest, th.y, th.z)]),
          new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0 }),
        );
        group.current.add(tether);
        th.tether = tether;
      }
      setAnchor(`case:${a.caseId}`, (out) => {
        out.copy(marker.position);
        return marker.visible && th.closedAt === undefined && th.summonedAt === undefined;
      });
    }
    return th;
  }

  function remove(id: string, th: Thread) {
    group.current.remove(th.tail, th.head);
    th.material.dispose();
    (th.head.material as THREE.Material).dispose();
    if (th.marker) {
      group.current.remove(th.marker);
      th.markerMaterial!.dispose();
      (th.pulse!.material as THREE.Material).dispose();
    }
    if (th.tether) {
      group.current.remove(th.tether);
      th.tether.geometry.dispose();
      (th.tether.material as THREE.Material).dispose();
    }
    if (th.caseId) setAnchor(`case:${th.caseId}`, null);
    live.current.delete(id);
  }

  // The mark a purchase leaves on the face of the box as it goes in.
  function stamp(th: Thread, now: number) {
    const mesh = new THREE.Mesh(geo.stamp, new THREE.MeshBasicMaterial({ color: INK, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    mesh.position.set(-BX + 0.004, th.y, th.z);
    mesh.rotation.y = Math.PI / 2;
    group.current.add(mesh);
    stamps.current.push({ mesh, born: now });
  }

  useFrame(() => {
    const now = performance.now();
    const { arcs, cases, hover } = useStore.getState();

    for (const a of arcs) {
      if (live.current.has(a.id) || now - a.seenAt > 9000) continue;
      // A case that closed before this page opened is already filed in the box.
      if (a.caseId && cases[a.caseId]?.closedAt && now - a.seenAt > 3000) continue;
      live.current.set(a.id, spawn(a));
    }

    for (const [id, th] of live.current) {
      const raw = XL + ((now - th.born) / 1000) * SPEED; // where it would be if nothing stopped it
      const inside = raw >= -BX;
      let x = raw;
      let length = Math.min(TAIL, raw - XL);
      let alpha = (inside ? 0.95 : 0.6) * smooth(XL, XL + 2.5, raw) * (1 - smooth(XR - 3.5, XR, raw));
      let color = inside ? RECORDED : NEUTRAL;
      let done = raw - TAIL > XR;
      let backwards = false;

      if (inside && !th.stamped) {
        th.stamped = true;
        stamp(th, now);
      }

      if (th.caseId) {
        const c = cases[th.caseId];
        const closed = !!c?.closedAt;
        if (closed && th.closedAt === undefined) th.closedAt = now;
        const since = th.closedAt === undefined ? 0 : (now - th.closedAt) / 1000;
        const stopAt = th.held ? HOLD_X : th.rest;
        const arrived = raw >= stopAt;
        const marker = th.marker!;
        const beat = (now / 1100 + th.z + 10) % 1;
        let markerX = stopAt;
        color = HELD;
        alpha = smooth(XL, XL + 2.5, raw);
        done = false;

        if (arrived) {
          x = stopAt;
          length = THREE.MathUtils.clamp(TAIL - (raw - stopAt), 0, TAIL); // the tail catches up with the head
        }
        marker.visible = arrived;
        marker.quaternion.copy(camera.quaternion);
        th.markerMaterial!.color.copy(HELD);
        th.markerMaterial!.opacity = 1;
        const pointed = hover === th.caseId;
        marker.scale.setScalar(pointed ? 1.6 : 1);
        th.pulse!.scale.setScalar(1 + beat * 1.5);
        (th.pulse!.material as THREE.MeshBasicMaterial).opacity = arrived && !closed ? 0.7 * (1 - beat) : 0;
        if (th.tether) (th.tether.material as THREE.LineBasicMaterial).opacity = arrived && !closed ? 0.22 : 0;

        if (!closed && arrived && c?.status === 'awaiting_approval' && c.arbiter.ruling) {
          // The ruling is drafted but needs a person. The case is brought into the box, to where it
          // will be filed if the ruling is approved, and waits there (see Waiting below).
          if (th.summonedAt === undefined) th.summonedAt = now;
          const t = (now - th.summonedAt) / 1000;
          markerX = stopAt + (partyX(topParty(c.arbiter.ruling.split)) - stopAt) * ease(Math.min(1, t / 1.1));
          th.markerMaterial!.opacity = Math.max(0, 1 - Math.max(0, t - 1.1) / 0.3);
          (th.pulse!.material as THREE.MeshBasicMaterial).opacity = 0;
          if (th.tether) (th.tether.material as THREE.LineBasicMaterial).opacity = 0;
        }

        if (closed && c && th.summonedAt !== undefined) {
          // already in the box: its record, or nothing, takes over from the waiting mark
          th.markerMaterial!.opacity = 0;
          length = 0;
          alpha = 0;
          done = since > 0.2;
        } else if (closed && c) {
          const filed = isFiled(c);
          color = c.status === 'blocked' ? STOP : outcomeColor(c);
          th.markerMaterial!.color.copy(outcomeColor(c));
          // The marker carries the case to the bay of whoever was held liable, where its record takes over.
          if (filed) markerX = stopAt + (partyX(topParty(c.arbiter.ruling!.split)) - stopAt) * ease(Math.min(1, since / 1.1));
          th.markerMaterial!.opacity = filed ? Math.max(0, 1 - Math.max(0, since - 1.1) / 0.4) : Math.max(0, 1 - since / 0.6);
          if (!arrived) {
            // decided before it got there: let it fade where it is
            alpha = Math.max(0, 1 - since / 1.2);
            done = since > 1.2;
          } else if (th.held && c.status === 'released') {
            x = HOLD_X + since * SPEED;
            length = Math.min(TAIL, x - HOLD_X);
            alpha = 1 - smooth(XR - 3.5, XR, x);
            done = x - TAIL > XR;
          } else if (th.held) {
            // blocked: the payment goes back where it came from
            x = HOLD_X - since * SPEED * 0.9;
            length = Math.min(TAIL, HOLD_X - x);
            backwards = true;
            alpha = Math.max(0, 1 - since / 1.8);
            done = since > 1.9;
          } else {
            length = 0;
            alpha = Math.max(0, 1 - since / 0.6);
            done = since > 1.6;
          }
        }
        marker.position.set(arrived ? markerX : x, th.y, th.z);
      }

      th.material.uniforms.uColor.value.copy(color);
      th.material.uniforms.uAlpha.value = alpha;
      th.tail.position.set(x, th.y, th.z);
      th.tail.scale.set(Math.max(0.0001, length) * (backwards ? -1 : 1), 0.075, 0.075);
      th.head.position.set(x, th.y, th.z);
      const head = th.head.material as THREE.MeshBasicMaterial;
      head.color.copy(color);
      head.opacity = Math.min(1, alpha * 1.6);
      th.head.visible = !(th.caseId && th.marker!.visible);
      if (done) remove(id, th);
    }

    stamps.current = stamps.current.filter((s) => {
      const t = (now - s.born) / 650;
      if (t >= 1) {
        group.current.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        return false;
      }
      s.mesh.scale.setScalar(1 + t * 1.8);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
      return true;
    });
  });

  return <group ref={group} />;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
};

// Where a case sits in the box once it has a ruling: the bay of the party held liable, the
// height of its order value, the lane of its agent provider, nudged so neighbours do not overlap.
const placeOf = (c: CaseFile) =>
  new THREE.Vector3(
    partyX(topParty(c.arbiter.ruling!.split)) + (hash(c.id) - 0.5) * BAY_W * 0.62,
    yOf(c.purchase.total),
    laneZ(c.purchase.provider) + (hash(c.id + 'z') - 0.5) * GAP * 0.6,
  );

const filedCases = (cases: Record<string, CaseFile>) => caseList(cases).filter(isFiled).slice(0, 80);

// One decided case, filed in the box: in the bay of the party held liable, at
// the height of its order value, in the lane of the agent provider that bought it.
function Filed({ c }: { c: CaseFile }) {
  const mesh = useRef<THREE.Mesh>(null!);
  const open = useStore((s) => s.open);
  const hovered = useStore((s) => s.hover === c.id);
  const party = topParty(c.arbiter.ruling!.split);
  const position = useMemo(() => placeOf(c), [c.id, party, c.purchase.total, c.purchase.provider]); // eslint-disable-line react-hooks/exhaustive-deps
  // If the case closed while this page was open, wait for its marker to bring it here. A ruling
  // that a person approved was already waiting on this spot, so it appears at once.
  const born = useRef(performance.now());
  const fresh = Date.now() + useStore.getState().skew - (c.closedAt ?? 0) < 4000;
  const approved = c.stage === 'dispute' && c.purchase.total >= (useStore.getState().info?.approvalThreshold ?? Infinity);
  const delay = useRef(approved ? 0 : fresh ? 1100 : Math.random() * 500);
  useAnchor(`filed:${c.id}`, (out) => (out.copy(position), hovered));
  useEffect(() => () => void (useStore.getState().hover === c.id && useStore.getState().set({ hover: null })), [c.id]);

  useFrame(() => {
    const k = THREE.MathUtils.clamp((performance.now() - born.current - delay.current) / 450, 0, 1);
    mesh.current.scale.setScalar(ease(k) * (hovered ? 1.7 : 1));
  });

  return (
    <mesh
      ref={mesh}
      position={position}
      scale={0}
      onClick={(e) => {
        e.stopPropagation();
        document.body.style.cursor = '';
        open(c.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
        useStore.getState().set({ hover: c.id });
      }}
      onPointerOut={() => {
        document.body.style.cursor = '';
        useStore.getState().set({ hover: null });
      }}
    >
      {hovered && (
        <mesh position={[0, -position.y / 2 / 1.7, 0]} scale={1 / 1.7}>
          <boxGeometry args={[0.012, position.y, 0.012]} />
          <meshBasicMaterial color={PARTY_COLOR[party]} transparent opacity={0.7} toneMapped={false} />
        </mesh>
      )}
      {/* blocked before settlement keeps the diamond; a ruling after settlement is round */}
      {c.status === 'blocked' ? <octahedronGeometry args={[0.075, 0]} /> : <sphereGeometry args={[0.058, 16, 16]} />}
      <meshBasicMaterial color={PARTY_COLOR[party]} toneMapped={false} />
    </mesh>
  );
}

function FiledCases() {
  const cases = useStore((s) => s.cases);
  const list = useMemo(() => filedCases(cases), [cases]);
  return (
    <>
      {list.map((c) => (
        <Filed key={c.id} c={c} />
      ))}
    </>
  );
}

let sceneMountedAt = 0;

// A ruling that needs a person. It waits where it would be filed, as an empty ring on a column
// of light that runs the height of the box, until someone approves it or sends it away.
function Waiting({ c }: { c: CaseFile }) {
  const group = useRef<THREE.Group>(null!);
  const ring = useRef<THREE.Group>(null!);
  const beam = useRef<THREE.Mesh>(null!);
  const { camera } = useThree();
  const position = useMemo(() => placeOf(c), [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const born = useRef(performance.now());
  // If it stopped while this view was open, let its marker travel here first.
  const delay = useRef(performance.now() - sceneMountedAt > 2500 ? 1100 : 0);
  useAnchor(`wait:${c.id}`, (out) => (out.copy(position), performance.now() - born.current > delay.current));

  useFrame(({ clock }) => {
    const k = ease(THREE.MathUtils.clamp((performance.now() - born.current - delay.current) / 500, 0, 1));
    const beat = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.2);
    group.current.visible = k > 0;
    ring.current.quaternion.copy(camera.quaternion);
    ring.current.scale.setScalar(k * (1 + beat * 0.25));
    beam.current.scale.set(1, k, 1);
    (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.28 + beat * 0.3;
  });

  return (
    <group ref={group} visible={false}>
      <mesh ref={beam} position={[position.x, BOX_H / 2, position.z]}>
        <boxGeometry args={[0.022, BOX_H, 0.022]} />
        <meshBasicMaterial color={INK} transparent opacity={0.4} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[position.x, 0.01, position.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.215, 48]} />
        <meshBasicMaterial color={INK} transparent opacity={0.5} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={ring} position={position}>
        <mesh>
          <ringGeometry args={[0.105, 0.128, 48]} />
          <meshBasicMaterial color={INK} depthTest={false} transparent toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

function WaitingCases() {
  const cases = useStore((s) => s.cases);
  const list = useMemo(() => waitingCases(cases).slice(0, 6), [cases]);
  return (
    <>
      {list.map((c) => (
        <Waiting key={c.id} c={c} />
      ))}
    </>
  );
}

// Which labels make sense from which side.
const shows = (lenses: Lens[]) => () => lenses.includes(useStore.getState().lens);
const fromSideOrFront = shows(['flow', 'agents']);
const fromSideOrTop = shows(['flow', 'liability']);

function Box() {
  const post = '#e9e9e6';
  TICKS.forEach((v, i) => useAnchor(`tick:${i}`, (out) => (out.set(BX, yOf(v), ZW), fromSideOrFront()))); // eslint-disable-line react-hooks/rules-of-hooks
  PROVIDER_NAMES.forEach((name, i) => useAnchor(`lane:${i}`, (out) => (out.set(useStore.getState().lens === 'agents' ? -BX - 0.25 : -BX - 2.4, 0, laneZ(name)), true))); // eslint-disable-line react-hooks/rules-of-hooks
  BAYS.forEach((_, i) => useAnchor(`bay:${i}`, (out) => (out.set(bayX(i), BOX_H, ZW), fromSideOrTop()))); // eslint-disable-line react-hooks/rules-of-hooks
  useAnchor('side:before', (out) => (out.set(-BX - 1.7, 0, ZW + 0.5), fromSideOrTop()));
  useAnchor('side:after', (out) => (out.set(BX + 1.7, 0, ZW + 0.5), fromSideOrTop()));

  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(BX * 2, BOX_H, ZW * 2)), []);
  const lines = useMemo(() => {
    const make = (pts: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return g;
    };
    const lanes: number[] = [];
    for (const name of PROVIDER_NAMES) lanes.push(XL - 6, 0.004, laneZ(name), XR + 6, 0.004, laneZ(name));
    // order-value marks on the near and far faces, and the walls between the bays on the floor and the lid
    const inner: number[] = [];
    for (const v of TICKS) inner.push(BX, yOf(v), -ZW, BX, yOf(v), ZW, -BX, yOf(v), -ZW, BX, yOf(v), -ZW);
    for (let i = 1; i < BAYS.length; i++) {
      const x = -BX + i * BAY_W;
      inner.push(x, 0.008, -ZW, x, 0.008, ZW, x, BOX_H, -ZW, x, BOX_H, ZW, x, 0.008, -ZW, x, BOX_H, -ZW);
    }
    return { lanes: make(lanes), inner: make(inner) };
  }, []);

  return (
    <group>
      {/* the floor: dark and slightly reflective, so everything above it has a footprint */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[80, 60]} />
        <MeshReflectorMaterial resolution={1024} blur={[420, 140]} mixBlur={1} mixStrength={2.2} mixContrast={1} roughness={1} depthScale={0} color="#0c0c0e" metalness={0.6} mirror={0.55} />
      </mesh>
      <lineSegments geometry={lines.lanes}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.09} />
      </lineSegments>
      {/* the box: dark glass, so what is held and filed inside it stays visible */}
      <mesh position={[0, BOX_H / 2, 0]}>
        <boxGeometry args={[BX * 2, BOX_H, ZW * 2]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.4} depthWrite={false} side={THREE.BackSide} />
      </mesh>
      <mesh position={[0, BOX_H / 2, 0]}>
        <boxGeometry args={[BX * 2, BOX_H, ZW * 2]} />
        <shaderMaterial args={[glassShader]} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={edges} position={[0, BOX_H / 2, 0]}>
        <lineBasicMaterial color={post} transparent opacity={0.75} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={lines.inner}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.1} />
      </lineSegments>
      {/* its light on the floor */}
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BX * 2 + 7, ZW * 2 + 3]} />
        <shaderMaterial args={[footprintShader]} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

const TARGET = new THREE.Vector3(0.2, 1.3, 0);
const SCENE_W = 14;
const SCENE_H = 6.6; // the box, the title above it and the lane names on the floor

// Where the camera stands for each reading of the box.
const VIEW: Record<Lens, THREE.Vector3> = {
  flow: new THREE.Vector3(-0.5, 0.26, 0.82).normalize(),
  agents: new THREE.Vector3(-0.93, 0.2, 0.3).normalize(),
  liability: new THREE.Vector3(0, 0.985, 0.17).normalize(),
};

function lensOf(dir: THREE.Vector3): Lens {
  if (Math.abs(dir.y) > 0.8) return 'liability';
  return Math.abs(dir.x) > Math.abs(dir.z) ? 'agents' : 'flow';
}

// Fits the box to the part of the canvas the case list leaves free, turns it
// to a side when asked, and reports which side is being looked at. The user
// can take hold of it at any time and look from anywhere above the floor.
function Rig() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void } | null;
  const go = useStore((s) => s.lensGo);
  const entering = useStore((s) => s.entering);
  const dive = useRef<{ from: THREE.Vector3; to: THREE.Vector3 } | null>(null);
  const look = useMemo(() => new THREE.Vector3(), []);
  const mounted = useRef(performance.now());
  const distance = useRef(12);
  const dir = useMemo(() => VIEW.flow.clone(), []);
  const goal = useRef<THREE.Vector3 | null>(VIEW.flow);
  const taken = useRef(false);
  const offset = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const right = size.width >= 900 ? 362 : 0;
    const free = Math.max(360, size.width - right);
    const half = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    distance.current = Math.max(SCENE_W / 2 / (half * (free / size.height)), SCENE_H / 2 / half, 11);
    // the headline and the view switch sit on the left, so the box stands a little right of centre and above it
    cam.setViewOffset(size.width, size.height, right / 2 - size.width * 0.05, size.height * 0.035, size.width, size.height);
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  useEffect(() => {
    if (!go) return;
    goal.current = VIEW[go.to];
    taken.current = false;
  }, [go]);

  useEffect(() => {
    if (!controls) return;
    const take = () => {
      taken.current = true;
      goal.current = null;
    };
    controls.addEventListener('start', take);
    return () => controls.removeEventListener('start', take);
  }, [controls]);

  // Opening a case: find where it is in the box and remember where the camera started.
  useEffect(() => {
    if (!entering) {
      dive.current = null;
      if (controls) controls.enabled = true;
      return;
    }
    const to = new THREE.Vector3(0, BOX_H / 2, 0);
    if (!locate(`filed:${entering.caseId}`, to) && !locate(`case:${entering.caseId}`, to)) to.set(0, BOX_H / 2, 0);
    dive.current = { from: camera.position.clone(), to };
    if (controls) controls.enabled = false;
  }, [entering, camera, controls]);

  useFrame(({ clock }, dt) => {
    if (dive.current && entering) {
      // accelerate into the box, towards the case
      const k = Math.min(1, (performance.now() - entering.at) / DIVE_MS);
      const e = k * k * k;
      camera.position.lerpVectors(dive.current.from, dive.current.to, e * 0.93);
      camera.lookAt(look.lerpVectors(TARGET, dive.current.to, Math.min(1, k * 2.2)));
      return;
    }
    if (!taken.current && goal.current) {
      dir.lerp(goal.current, 1 - Math.exp(-dt * 3.2)).normalize();
      // arriving: start a little close and settle back
      const settle = 1 - 0.32 * Math.exp(-(performance.now() - mounted.current) / 420);
      // while nobody is holding it, it sways a little so the depth stays readable
      offset.copy(dir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, Math.sin(clock.elapsedTime * 0.16) * 0.05);
      camera.position.copy(TARGET).addScaledVector(offset, distance.current * settle);
      camera.lookAt(TARGET);
    } else {
      dir.copy(camera.position).sub(TARGET).normalize();
    }
    const lens = lensOf(dir);
    if (lens !== useStore.getState().lens) useStore.getState().set({ lens });
  });
  return null;
}

const BAY_NAME: Record<Party, string> = { customer: 'Customer', agent_provider: 'Agent', merchant: 'Merchant', fraud: 'Fraud' };

const openCases = (cases: Record<string, CaseFile>) =>
  caseList(cases)
    .filter((c) => !c.closedAt)
    .slice(0, 14);

function BoxLabels() {
  const cases = useStore((s) => s.cases);
  const open = useStore((s) => s.open);
  const hover = useStore((s) => (s.hover ? s.cases[s.hover] : undefined));
  const lens = useStore((s) => s.lens);
  return (
    <LabelLayer>
      {TICKS.map((v, i) => (
        <Label key={v} anchor={`tick:${i}`} className="gate-text tick">
          {eur(v, 0)}
        </Label>
      ))}
      {PROVIDER_NAMES.map((name, i) => (
        <Label key={name} anchor={`lane:${i}`} className={`gate-text lane ${lens} ${i % 2 ? 'odd' : ''}`}>
          {name}
        </Label>
      ))}
      {BAYS.map((b, i) => (
        <Label key={b} anchor={`bay:${i}`} className={`gate-text bay ${i % 2 ? 'high' : ''}`}>
          {b !== 'held' && <i style={{ background: PARTY_COLOR[b] }} />}
          {b === 'held' ? 'Held' : BAY_NAME[b]}
        </Label>
      ))}
      <Label anchor="side:before" className="gate-text side">
        Before settlement
      </Label>
      <Label anchor="side:after" className="gate-text side">
        Settled
      </Label>
      {openCases(cases).map((c) =>
        c.status === 'awaiting_approval' ? (
          <Label key={`w${c.id}`} anchor={`wait:${c.id}`} className="gate-tag wait" onClick={() => open(c.id)}>
            <b>Waiting for you</b>
            <span>{eur(c.purchase.total)} ruling</span>
            <em>Review</em>
          </Label>
        ) : (
          <Label key={c.id} anchor={`case:${c.id}`} className={`gate-tag ${c.status}`} onClick={() => open(c.id)}>
            <b>{c.stage === 'hold' ? 'Held' : 'Disputed'}</b>
            <span>{eur(c.purchase.total)}</span>
          </Label>
        ),
      )}
      {hover && hover.arbiter.ruling && (
        <Label key={`h${hover.id}`} anchor={`filed:${hover.id}`} className="gate-tag tip">
          <b>{hover.purchase.item}</b>
          <span>
            {eur(hover.purchase.total)} · {hover.purchase.provider} · {PARTY_NAME[topParty(hover.arbiter.ruling.split)]} liable
          </span>
        </Label>
      )}
    </LabelLayer>
  );
}

export function GateScene() {
  useMemo(() => (sceneMountedAt = performance.now()), []);
  return (
    <>
      <Canvas camera={{ position: [-6, 4, 11], fov: 30 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={[BG]} />
        <fog attach="fog" args={[BG, 14, 34]} />
        <Rig />
        <Projector />
        <Box />
        <FiledCases />
        <WaitingCases />
        <Threads />
        <OrbitControls makeDefault enablePan={false} enableZoom={false} target={TARGET} minPolarAngle={0.05} maxPolarAngle={1.5} enableDamping dampingFactor={0.08} rotateSpeed={0.5} />
        <EffectComposer>
          <Bloom intensity={0.55} luminanceThreshold={0.35} luminanceSmoothing={0.5} mipmapBlur />
          <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.35} />
          <Vignette eskil={false} offset={0.25} darkness={0.7} />
        </EffectComposer>
      </Canvas>
      <BoxLabels />
    </>
  );
}
