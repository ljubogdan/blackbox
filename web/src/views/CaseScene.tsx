import { Line, MeshReflectorMaterial, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CaseFile, Role, TrailStep } from '../../../shared/types';
import { ROLE_NAME, ROLES } from '../../../shared/types';
import { BG, BREACH, DOCK_H, dockOpen, eur, INK, MINT, PARTY_COLOR, reducedMotion, ROLE_COLOR, useStore, type Lens } from '../store';
import { Label, LabelLayer, Projector, useAnchor } from './labels';

// The replay. The owner's instruction is a corridor:
//   height  = money. The ceiling is the spending limit.
//   width   = scope. The walls are "this agent, this errand".
// The agent's journey is a path through it, plotted from the recorded steps.
// Where the path leaves the corridor is where the purchase left the mandate.

const L = 7.6; // corridor length
const H = 2.3; // ceiling height = 100% of the limit
const W = 1.15; // half-width
const X0 = -L / 2;
const X1 = L / 2 - 0.5;
const LIFT = -1.2; // the whole replay sits this far below the origin

export interface Node {
  key: string;
  kind: TrailStep['kind'] | 'charged' | 'claim';
  label: string;
  price: number | null;
  pos: THREE.Vector3;
  outside: boolean;
  unknown: boolean;
  evidenceId: string;
  u: number; // position along the path, 0-1
}

export interface Layout {
  nodes: Node[]; // steps, then the charge
  claim: Node | null; // absent while a payment is only held: nobody has complained yet
  curve: THREE.CatmullRomCurve3;
  breach: { pos: THREE.Vector3; kind: 'limit' | 'scope'; node: Node } | null;
  anchors: Map<string, THREE.Vector3>;
  max: number;
  total: number;
  ordId: string;
  mndId: string;
}

const isOutside = (p: THREE.Vector3) => p.y > H + 0.02 || Math.abs(p.z) > W + 0.02;

export function layoutCase(c: CaseFile, limit?: number | null): Layout {
  const max = limit ?? c.mandate.maxAmount;
  const ord = c.evidence.find((e) => e.kind === 'ORD')!;
  const mnd = c.evidence.find((e) => e.kind === 'MND')!;
  const total = Number(ord.data.total);
  // Above the limit the scale is compressed so a 3x overspend still fits on screen.
  const yOf = (price: number) => {
    const r = price / max;
    return Math.min(r <= 1 ? r : 1 + (r - 1) * 0.62, 2.05) * H;
  };

  const n = c.steps.length;
  const span = X1 - 1.9 - (X0 + 0.7);
  let y = 0.3 * H;
  const nodes: Node[] = c.steps.map((s, i) => {
    if (s.price !== null) y = yOf(s.price);
    const pos = new THREE.Vector3(X0 + 0.7 + (n > 1 ? (i / (n - 1)) * span : 0), y, s.drift * 1.3);
    return { key: `s${s.n}`, kind: s.kind, label: s.label, price: s.price, pos, outside: isOutside(pos), unknown: s.actor === 'unknown', evidenceId: s.evidenceId, u: 0 };
  });
  const last = nodes[nodes.length - 1];
  const chargedPos = new THREE.Vector3(X1 - 0.75, yOf(total), last.pos.z);
  nodes.push({
    key: 'charged',
    kind: 'charged',
    label: c.stage === 'hold' ? 'About to be charged' : 'Charged to the card',
    price: total,
    pos: chargedPos,
    outside: isOutside(chargedPos),
    unknown: last.unknown,
    evidenceId: ord.id,
    u: 1,
  });
  const clm = c.evidence.find((e) => e.kind === 'CLM');
  const claim: Node | null = clm
    ? {
        key: 'claim',
        kind: 'claim',
        label: 'Customer disputes',
        price: null,
        pos: new THREE.Vector3(X1 + 1.25, 0.42 * H, 0),
        outside: false,
        unknown: false,
        evidenceId: clm.id,
        u: 1,
      }
    : null;

  const curve = new THREE.CatmullRomCurve3(
    nodes.map((nd) => nd.pos),
    false,
    'catmullrom',
    0.08,
  );
  const lengths = curve.getLengths(nodes.length - 1 > 0 ? (nodes.length - 1) * 40 : 40);
  const totalLen = lengths[lengths.length - 1] || 1;
  nodes.forEach((nd, i) => (nd.u = lengths[Math.min(i * 40, lengths.length - 1)] / totalLen));

  // First place the journey leaves the corridor.
  let breach: Layout['breach'] = null;
  for (let i = 1; i < nodes.length; i++) {
    if (!nodes[i].outside || nodes[i - 1].outside) continue;
    const a = nodes[i - 1].pos;
    const b = nodes[i].pos;
    const scope = Math.abs(b.z) > W + 0.02;
    const t = scope ? (W - Math.abs(a.z)) / (Math.abs(b.z) - Math.abs(a.z) || 1) : (H - a.y) / (b.y - a.y || 1);
    breach = { pos: a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1)), kind: scope ? 'scope' : 'limit', node: nodes[i] };
    break;
  }

  // Where each evidence record "lives" in the scene, so a citation can point at it.
  const anchors = new Map<string, THREE.Vector3>();
  for (const nd of nodes) anchors.set(nd.evidenceId, nd.pos);
  c.steps.forEach((s, i) => anchors.set(c.evidence.find((e) => e.kind === 'TRL' && Number(e.data.step) === s.n)?.id ?? '', nodes[i].pos));
  const stepOf = (kind: TrailStep['kind']) => [...nodes].reverse().find((nd) => nd.kind === kind);
  const lst = c.evidence.find((e) => e.kind === 'LST');
  const ses = c.evidence.find((e) => e.kind === 'SES');
  const dlv = c.evidence.find((e) => e.kind === 'DLV');
  if (lst) anchors.set(lst.id, (stepOf('view') ?? last).pos);
  if (ses) anchors.set(ses.id, (stepOf('session') ?? stepOf('checkout') ?? last).pos);
  if (dlv && claim) anchors.set(dlv.id, claim.pos);
  if (clm && claim) anchors.set(clm.id, claim.pos);
  anchors.set(mnd.id, nodes[0].pos);

  return { nodes, claim, curve, breach, anchors, max, total, ordId: ord.id, mndId: mnd.id };
}

// The moment the journey leaves the corridor: the replay slows down through it and the camera
// leans in. Set by the replay, read by the camera.
const SLOW_MS = 1100;
const PUNCH_MS = 2300;
const moment = { at: -1e9, pos: new THREE.Vector3() };

const TUBULAR = 420;
const RADIAL = 10;

const ceilingShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform float uTime;
    uniform float uAspect;  // length / width of the ceiling, so distances are round
    uniform vec2 uBreach;   // where the journey went through, in uv
    uniform float uHit;     // 0 until the journey gets there, then 1
    uniform float uWave;    // 0-1, the shockwave spreading from that point
    void main() {
      vec3 mint = vec3(0.31, 0.82, 0.63);
      vec3 red = vec3(1.0, 0.36, 0.28);
      float scan = 0.5 + 0.5 * sin(vUv.x * 70.0 - uTime * 1.6);
      float rim = 1.0 - smoothstep(0.0, 0.07, vUv.y) * (1.0 - smoothstep(0.93, 1.0, vUv.y));
      float d = distance(vec2(vUv.x * uAspect, vUv.y), vec2(uBreach.x * uAspect, uBreach.y));
      float scar = uHit * exp(-d * d * 9.0);
      float ring = uHit * (1.0 - smoothstep(0.0, 0.05, abs(d - uWave * 1.6))) * (1.0 - uWave);
      vec3 color = mix(mint, red, clamp(scar * 1.5 + ring, 0.0, 1.0));
      float alpha = 0.04 + 0.018 * scan + rim * 0.10 + scar * 0.5 + ring * 0.9;
      gl_FragColor = vec4(color * (1.0 + scar * 1.4 + ring), alpha);
    }`,
};

const wallShader = {
  vertexShader: ceilingShader.vertexShader,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      // the back wall glows faintly towards the limit, which gives the corridor its depth
      float a = pow(clamp(vUv.y, 0.0, 1.0), 2.2) * 0.13 + 0.015;
      gl_FragColor = vec4(0.31, 0.82, 0.63, a);
    }`,
};

function Corridor({ layout, progress, flash }: { layout: Layout; progress: React.MutableRefObject<number>; flash: { color: string; at: number } | null }) {
  const len = X1 - X0;
  useAnchor('limit', (out) => (out.set(X0, H + LIFT, W), true));
  const cx = (X0 + X1) / 2;
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(len, H, W * 2)), [len]);
  const grid = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const x = X0 + (i / 20) * len;
      pts.push(x, 0, -W, x, 0, W);
    }
    for (const z of [-W, -W / 2, 0, W / 2, W]) pts.push(X0, 0, z, X1, 0, z);
    // quarter lines on the back wall: 25 / 50 / 75 % of the limit
    for (const f of [0.25, 0.5, 0.75]) pts.push(X0, H * f, -W, X1, H * f, -W);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [len]);

  const ceiling = useMemo(
    () =>
      new THREE.ShaderMaterial({
        ...ceilingShader,
        uniforms: { uTime: { value: 0 }, uAspect: { value: len / (W * 2) }, uBreach: { value: new THREE.Vector2(-9, -9) }, uHit: { value: 0 }, uWave: { value: 0 } },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    [len],
  );
  const edgeMaterial = useRef<THREE.LineBasicMaterial>(null!);
  const mint = useMemo(() => new THREE.Color(MINT), []);
  const tint = useMemo(() => new THREE.Color(), []);
  const hitAt = useRef<number | null>(null);
  const b = layout.breach;

  useEffect(() => {
    hitAt.current = null;
  }, [layout]);

  useFrame(({ clock }) => {
    const u = ceiling.uniforms;
    u.uTime.value = clock.elapsedTime;
    // The ceiling only scars where the journey actually went through it.
    const through = !!b && b.kind === 'limit' && progress.current >= b.node.u - 0.03;
    if (through && hitAt.current === null) hitAt.current = clock.elapsedTime;
    if (!through) hitAt.current = null;
    u.uHit.value = through ? 1 : 0;
    if (b && through) {
      u.uBreach.value.set((b.pos.x - X0) / len, 0.5 - b.pos.z / (W * 2));
      u.uWave.value = ((clock.elapsedTime - hitAt.current!) / 2.2) % 1;
    }
    // When the outcome lands, the frame of the corridor takes its colour for a moment.
    const age = flash ? (performance.now() - flash.at) / 2600 : 1;
    const k = flash && age < 1 ? 1 - age : 0;
    edgeMaterial.current.color.copy(mint).lerp(tint.set(flash?.color ?? MINT), k);
    edgeMaterial.current.opacity = 0.34 + k * 0.66;
  });

  return (
    <group>
      <lineSegments geometry={edges} position={[cx, H / 2, 0]}>
        <lineBasicMaterial ref={edgeMaterial} color={MINT} transparent opacity={0.4} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.07} />
      </lineSegments>
      {/* the ceiling: the spending limit */}
      <mesh position={[cx, H, 0]} rotation={[-Math.PI / 2, 0, 0]} material={ceiling}>
        <planeGeometry args={[len, W * 2]} />
      </mesh>
      <mesh position={[cx, H / 2, -W]}>
        <planeGeometry args={[len, H]} />
        <shaderMaterial args={[wallShader]} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[cx, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[len, W * 2]} />
        <meshBasicMaterial color="#141417" transparent opacity={0.7} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

// A dark polished floor under the corridor: the journey, the walls and the sealed records are
// mirrored in it, softly, which gives the scene its weight.
function Ground() {
  return (
    <mesh position={[(X0 + X1) / 2, -0.02, 0.6]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[40, 30]} />
      <MeshReflectorMaterial resolution={512} blur={[300, 90]} mixBlur={1} mixStrength={1.6} mixContrast={1} roughness={1} depthScale={0} color="#0a0a0c" metalness={0.55} mirror={0.45} />
    </mesh>
  );
}

// The journey itself, drawn progressively, mint inside the corridor and red outside.
function Journey({ layout, progress }: { layout: Layout; progress: React.MutableRefObject<number> }) {
  const mesh = useRef<THREE.Mesh>(null!);
  const head = useRef<THREE.Mesh>(null!);
  const pulse = useRef<THREE.Mesh>(null!);

  const geometry = useMemo(() => {
    const g = new THREE.TubeGeometry(layout.curve, TUBULAR, 0.034, RADIAL, false);
    const inside = new THREE.Color(MINT).multiplyScalar(1.25);
    const out = new THREE.Color(BREACH).multiplyScalar(1.6);
    const intruder = new THREE.Color(PARTY_COLOR.fraud).multiplyScalar(1.5);
    const colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i <= TUBULAR; i++) {
      const u = i / TUBULAR;
      const p = layout.curve.getPointAt(u);
      const seg = layout.nodes.findIndex((nd) => nd.u >= u - 1e-4);
      const unknown = seg >= 0 && layout.nodes[seg].unknown;
      const color = unknown ? intruder : isOutside(p) ? out : inside;
      for (let j = 0; j <= RADIAL; j++) color.toArray(colors, (i * (RADIAL + 1) + j) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [layout]);

  // The same line again, wider and faint: the glow around it.
  const halo = useMemo(() => {
    const g = new THREE.TubeGeometry(layout.curve, TUBULAR, 0.13, RADIAL, false);
    g.setAttribute('color', geometry.attributes.color);
    return g;
  }, [layout, geometry]);

  useEffect(
    () => () => {
      geometry.dispose();
      halo.dispose();
    },
    [geometry, halo],
  );

  useFrame(({ clock }) => {
    const p = progress.current;
    geometry.setDrawRange(0, Math.floor(p * TUBULAR) * RADIAL * 6);
    halo.setDrawRange(0, Math.floor(p * TUBULAR) * RADIAL * 6);
    head.current.visible = p < 1;
    if (p < 1) head.current.position.copy(layout.curve.getPointAt(p));
    // once drawn, a pulse keeps travelling so the direction of the journey stays readable
    pulse.current.visible = p >= 1;
    if (p >= 1) pulse.current.position.copy(layout.curve.getPointAt((clock.elapsedTime * 0.16) % 1));
  });

  return (
    <group>
      <mesh ref={mesh} geometry={geometry}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
      <mesh geometry={halo}>
        <meshBasicMaterial vertexColors transparent opacity={0.06} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={head}>
        <sphereGeometry args={[0.09, 20, 20]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
      <mesh ref={pulse}>
        <sphereGeometry args={[0.055, 16, 16]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
    </group>
  );
}

const allNodes = (layout: Layout) => (layout.claim ? [...layout.nodes, layout.claim] : layout.nodes);
const nodeColor = (node: Node) => (node.unknown ? PARTY_COLOR.fraud : node.outside ? BREACH : node.kind === 'claim' ? PARTY_COLOR.customer : MINT);

const KIND_WORD: Record<Node['kind'], string> = {
  mandate: 'Instruction',
  search: 'Search',
  view: 'View',
  compare: 'Compare',
  select: 'Switch',
  addon: 'Add-on',
  cart: 'Cart',
  checkout: 'Checkout',
  session: 'New session',
  charged: 'Charged',
  claim: 'Dispute',
};

function StepNode({ node, progress }: { node: Node; progress: React.MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const setInspect = useStore((s) => s.setInspect);
  const selected = useStore((s) => s.inspect?.evidenceId === node.evidenceId);
  const color = nodeColor(node);
  useAnchor(`node:${node.key}`, (out) => (out.copy(node.pos).setY(node.pos.y + LIFT), progress.current >= node.u - 0.002));

  useFrame(() => {
    group.current.visible = progress.current >= node.u - 0.002;
  });

  return (
    <group ref={group} position={node.pos}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          setInspect({ evidenceId: node.evidenceId });
        }}
        onPointerOver={() => {
          document.body.style.cursor = 'pointer';
          useStore.getState().set({ stepHover: node.key });
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
          if (useStore.getState().stepHover === node.key) useStore.getState().set({ stepHover: null });
        }}
      >
        <sphereGeometry args={[0.2, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[node.kind === 'charged' ? 0.1 : 0.072, 20, 20]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {(node.outside || selected || node.kind === 'charged') && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[selected ? 0.2 : 0.15, 0.008, 8, 48]} />
          <meshBasicMaterial color={selected ? '#ffffff' : color} toneMapped={false} />
        </mesh>
      )}
      {/* drop line to the floor: reads the height as an amount */}
      <Line points={[[0, 0, 0], [0, -node.pos.y, 0]]} color={color} transparent opacity={0.22} lineWidth={1} dashed dashSize={0.05} gapSize={0.05} />
    </group>
  );
}

const SPARKS = 90;

function Breach({ layout, progress }: { layout: Layout; progress: React.MutableRefObject<number> }) {
  const ring = useRef<THREE.Mesh>(null!);
  const sparks = useRef<THREE.Points>(null!);
  const firedAt = useRef<number | null>(null);
  const b = layout.breach;

  // Each spark gets a direction once; the frame loop only moves it along.
  const { geometry, velocity } = useMemo(() => {
    const velocity = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.4 + Math.random() * 1.6;
      const out = 0.3 + Math.random() * 1.2;
      velocity.set([Math.cos(a) * out, up, Math.sin(a) * out], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    return { geometry, velocity };
  }, []);

  useEffect(() => {
    firedAt.current = null;
  }, [layout]);

  useFrame(({ clock }) => {
    if (!b) return;
    const through = progress.current >= b.node.u - 0.03;
    ring.current.visible = through;
    const t = (clock.elapsedTime * 0.8) % 1;
    ring.current.scale.setScalar(1 + t * 2.8);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 1 - t;

    if (through && firedAt.current === null) firedAt.current = clock.elapsedTime;
    if (!through) firedAt.current = null;
    const age = firedAt.current === null ? 9 : clock.elapsedTime - firedAt.current;
    sparks.current.visible = age < 1.5;
    if (age < 1.5) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < SPARKS; i++) {
        pos.setXYZ(i, velocity[i * 3] * age, velocity[i * 3 + 1] * age - 1.7 * age * age, velocity[i * 3 + 2] * age);
      }
      pos.needsUpdate = true;
      (sparks.current.material as THREE.PointsMaterial).opacity = 1 - age / 1.5;
    }
  });

  if (!b) return null;
  return (
    <group position={b.pos}>
      <mesh ref={ring} rotation={b.kind === 'limit' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}>
        <torusGeometry args={[0.16, 0.014, 8, 48]} />
        <meshBasicMaterial color={BREACH} transparent toneMapped={false} depthWrite={false} />
      </mesh>
      <points ref={sparks} geometry={geometry}>
        <pointsMaterial color={BREACH} size={0.05} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </points>
    </group>
  );
}

// The sealed records in the order they were sealed: glass blocks along the front of the corridor,
// each linked to the one before it by its hash. A change tried on one cracks it, and the seals after
// it light up one by one: every one of them would have to be redone to hide the change.
const CHAIN_Z = W + 0.8;
const CHAIN_Y = 0.13;
const BLOCK = new THREE.BoxGeometry(0.2, 0.2, 0.2);
const BLOCK_EDGES = new THREE.EdgesGeometry(BLOCK);
const chainX = (i: number, n: number) => X0 + 0.25 + (n > 1 ? (i / (n - 1)) * (X1 - X0 - 0.5) : 0);
const RIPPLE_MS = 110; // how long the crack takes to reach the next seal

function ChainAnchor({ id, i, n }: { id: string; i: number; n: number }) {
  useAnchor(`chain:${id}`, (out) => (out.set(chainX(i, n), CHAIN_Y + LIFT - 0.2, CHAIN_Z), true));
  return null;
}

function EvidenceChain({ c, layout }: { c: CaseFile; layout: Layout }) {
  const records = c.evidence;
  const n = records.length;
  const setInspect = useStore((s) => s.setInspect);
  const inspected = useStore((s) => s.inspect?.evidenceId);
  const edges = useRef<(THREE.LineBasicMaterial | null)[]>([]);
  const fills = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const white = useMemo(() => new THREE.Color('#ffffff'), []);
  const red = useMemo(() => new THREE.Color(BREACH), []);
  const links = useMemo(() => {
    const pts: number[] = [];
    for (let i = 1; i < n; i++) pts.push(chainX(i - 1, n) + 0.1, CHAIN_Y, CHAIN_Z, chainX(i, n) - 0.1, CHAIN_Y, CHAIN_Z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pts.length).fill(0.35), 3));
    return g;
  }, [n]);

  useFrame(({ clock }) => {
    const t = useStore.getState().tamper;
    const at = t ? records.findIndex((r) => r.id === t.evidenceId) : -1;
    const age = t ? performance.now() - t.at : 0;
    const linkColor = links.attributes.color as THREE.BufferAttribute;
    records.forEach((r, i) => {
      const edge = edges.current[i];
      const fill = fills.current[i];
      if (!edge || !fill) return;
      const hit = at >= 0 && i >= at && age > (i - at) * RIPPLE_MS;
      const broken = hit && i === at;
      edge.color.copy(hit ? red : white);
      edge.opacity = broken ? 0.7 + 0.3 * Math.sin(clock.elapsedTime * 8) : hit ? 0.75 : r.id === inspected ? 1 : 0.45;
      fill.color.copy(hit ? red : white);
      fill.opacity = broken ? 0.55 : hit ? 0.16 : r.id === inspected ? 0.22 : 0.07;
      // the broken one shakes a little where it cracked
      groups.current[i]?.position.set(chainX(i, n) + (broken && age < 600 ? Math.sin(age * 0.09) * 0.02 : 0), CHAIN_Y, CHAIN_Z);
      if (i > 0) {
        const c2 = hit ? [1, 0.36, 0.28] : [0.35, 0.35, 0.35];
        linkColor.setXYZ((i - 1) * 2, c2[0], c2[1], c2[2]);
        linkColor.setXYZ((i - 1) * 2 + 1, c2[0], c2[1], c2[2]);
      }
    });
    linkColor.needsUpdate = true;
  });

  // A thread from the record being read to the moment of the journey it belongs to.
  const i = records.findIndex((r) => r.id === inspected);
  const anchor = inspected ? layout.anchors.get(inspected) : undefined;

  return (
    <group>
      <lineSegments geometry={links}>
        <lineBasicMaterial vertexColors transparent opacity={0.8} toneMapped={false} />
      </lineSegments>
      {records.map((r, k) => (
        <ChainAnchor key={`a-${r.id}`} id={r.id} i={k} n={n} />
      ))}
      {records.map((r, k) => (
        <group key={r.id} ref={(g) => void (groups.current[k] = g)} position={[chainX(k, n), CHAIN_Y, CHAIN_Z]}>
          <mesh geometry={BLOCK}>
            <meshBasicMaterial ref={(m) => void (fills.current[k] = m)} transparent opacity={0.07} depthWrite={false} toneMapped={false} />
          </mesh>
          <lineSegments geometry={BLOCK_EDGES}>
            <lineBasicMaterial ref={(m) => void (edges.current[k] = m)} transparent opacity={0.45} toneMapped={false} />
          </lineSegments>
          <mesh
            onClick={(e) => {
              e.stopPropagation();
              setInspect({ evidenceId: r.id });
            }}
            onPointerOver={() => (document.body.style.cursor = 'pointer')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <boxGeometry args={[0.3, 0.3, 0.3]} />
            <meshBasicMaterial colorWrite={false} depthWrite={false} />
          </mesh>
        </group>
      ))}
      {i >= 0 && anchor && (
        <Line points={[[chainX(i, n), CHAIN_Y + 0.1, CHAIN_Z], [anchor.x, anchor.y, anchor.z]]} color="#ffffff" transparent opacity={0.3} lineWidth={1} dashed dashSize={0.06} gapSize={0.06} />
      )}
    </group>
  );
}

const STATUS_WORD: Record<string, string> = {
  queued: 'waiting',
  reading: 'reading evidence',
  submitted: 'being verified',
  verified: 'verified',
  rejected: 'citation rejected',
  failed: 'failed',
};

// One investigator, as a light in the scene. While it reads it roams the
// corridor; once it has a finding it parks on the evidence it cited.
const probeGroups = new Map<Role, THREE.Group>();

// The line between two investigators while one is answering the other's challenge.
function ChallengeBeam({ c }: { c: CaseFile }) {
  const roles = ROLES.filter((r) => c.investigators[r].challenge?.status === 'pending' || (c.crossExam === 'open' && c.investigators[r].challenge));
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), []);
  const line = useMemo(() => new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: INK, transparent: true, toneMapped: false })), [geometry]);
  useFrame(({ clock }) => {
    const a = probeGroups.get(roles[0]);
    const b = probeGroups.get(roles[1]);
    line.visible = c.crossExam === 'open' && !!a && !!b;
    if (!line.visible) return;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, a!.position.x, a!.position.y, a!.position.z);
    pos.setXYZ(1, b!.position.x, b!.position.y, b!.position.z);
    pos.needsUpdate = true;
    (line.material as THREE.LineBasicMaterial).opacity = 0.55 + Math.sin(clock.elapsedTime * 9) * 0.4;
  });
  return <primitive object={line} />;
}

function Probe({ c, role, index, layout }: { c: CaseFile; role: Role; index: number; layout: Layout }) {
  const inv = c.investigators[role];
  const group = useRef<THREE.Group>(null!);
  const halo = useRef<THREE.Mesh>(null!);
  const beam = useRef<THREE.Line>(null!);
  const color = ROLE_COLOR[role];
  const phase = index * 1.7;

  const anchor = useMemo(() => {
    const cited = inv.finding?.citations.map((k) => layout.anchors.get(k.evidence_id)).filter((v): v is THREE.Vector3 => !!v) ?? [];
    return cited[0] ?? null;
  }, [inv.finding, layout]);

  const beamGeometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), []);
  const beamObject = useMemo(
    () => new THREE.Line(beamGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7, toneMapped: false })),
    [beamGeometry, color],
  );
  const target = useMemo(() => new THREE.Vector3(), []);
  useAnchor(`probe:${role}`, (out) => (group.current?.getWorldPosition(out), true));
  useEffect(() => {
    probeGroups.set(role, group.current);
    return () => void probeGroups.delete(role);
  }, [role]);
  const arguing = inv.challenge?.status === 'pending';

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const settled = (inv.status === 'verified' || inv.status === 'submitted') && anchor;
    if (inv.status === 'queued') {
      target.set(X0 - 0.8, H - 0.1 - index * 0.36, 0.4);
    } else if (arguing) {
      // cross-examination: the two investigators leave their evidence and face each other above the corridor
      target.set((index % 2 === 0 ? -1 : 1) * 0.9 - 0.2, H + 1.15 + Math.sin(t * 3 + phase) * 0.05, 0.2);
    } else if (settled) {
      target.set(anchor.x + 0.1, anchor.y + 0.6 + index * 0.3, anchor.z + (index - 1.5) * 0.18);
    } else {
      // roaming: each probe traces its own slow figure over the corridor
      target.set(Math.sin(t * 0.55 + phase) * L * 0.4 - 0.3, H * 0.6 + Math.sin(t * 0.9 + phase * 2) * 1.0, Math.cos(t * 0.7 + phase) * 1.7);
    }
    group.current.position.lerp(target, 1 - Math.exp(-dt * 3.2));
    const busy = inv.status === 'reading' || inv.status === 'submitted';
    const s = busy ? 1 + Math.sin(t * 7 + phase) * 0.22 : 1;
    halo.current.scale.setScalar(s);
    (halo.current.material as THREE.MeshBasicMaterial).color.set(inv.status === 'rejected' && Math.sin(t * 14) > 0 ? BREACH : color);
    beamObject.visible = !!settled && !arguing;
    if (settled && !arguing) {
      const pos = beamGeometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, group.current.position.x, group.current.position.y, group.current.position.z);
      pos.setXYZ(1, anchor.x, anchor.y, anchor.z);
      pos.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={beamObject} ref={beam} />
      <group ref={group} position={[X0 - 0.8, H - 0.1 - index * 0.36, 0.4]}>
        <mesh ref={halo}>
          <sphereGeometry args={[0.075, 20, 20]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
        {inv.status === 'verified' && (
          <mesh>
            <torusGeometry args={[0.14, 0.01, 8, 40]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        )}
      </group>
    </>
  );
}

// While the arbiter deliberates, a sheet of light sweeps the length of the corridor.
// When the ruling needs a person, it stops where it is, drifts to the middle and waits.
function ArbiterSweep({ mode }: { mode: 'off' | 'sweep' | 'held' }) {
  const mesh = useRef<THREE.Mesh>(null!);
  useAnchor('arbiter', (out) => (mesh.current?.getWorldPosition(out), (out.y += H / 2 + 0.25), mode === 'held'));
  useFrame(({ clock }, dt) => {
    mesh.current.visible = mode !== 'off';
    const material = mesh.current.material as THREE.MeshBasicMaterial;
    if (mode === 'sweep') {
      mesh.current.position.x = X0 + (((clock.elapsedTime * 0.45) % 1) * (X1 - X0));
      material.opacity = 0.16;
    } else if (mode === 'held') {
      mesh.current.position.x += ((X0 + X1) / 2 - mesh.current.position.x) * (1 - Math.exp(-dt * 2.5));
      material.opacity = 0.2 + Math.sin(clock.elapsedTime * 1.6) * 0.07;
    }
  });
  return (
    <mesh ref={mesh} position={[X0, H / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
      <planeGeometry args={[W * 2, H]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

const outcomeColor = (c: CaseFile) =>
  c.status === 'ruled' && c.arbiter.ruling
    ? PARTY_COLOR[(Object.keys(c.arbiter.ruling.split) as (keyof typeof PARTY_COLOR)[]).sort((a, b) => c.arbiter.ruling!.split[b] - c.arbiter.ruling!.split[a])[0]]
    : c.status === 'blocked' || c.status === 'released'
      ? c.status === 'blocked'
        ? BREACH
        : MINT
      : MINT;

function Replay({ c, layout }: { c: CaseFile; layout: Layout }) {
  const progress = useRef(0);
  const started = useRef(performance.now());
  // Flash the corridor once, at the moment the case closes while you are watching.
  const wasOpen = useRef(!c.closedAt);
  const [flash, setFlash] = useState<{ color: string; at: number } | null>(null);
  useEffect(() => {
    if (c.closedAt && wasOpen.current) {
      wasOpen.current = false;
      setFlash({ color: outcomeColor(c), at: performance.now() });
    }
  }, [c.closedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // On arrival the corridor unfolds from the first step, then the journey is drawn through it,
  // in slow motion for a moment where it leaves the corridor.
  const unfold = useRef<THREE.Group>(null!);
  const played = useRef(0); // ms of the journey drawn so far
  const breachAt = useRef<number | null>(null);
  const told = useRef(false); // whether the rest of the page has been told the journey is drawn
  useEffect(() => {
    moment.at = -1e9;
  }, []);
  useFrame((_, dt) => {
    const now = performance.now();
    const slow = breachAt.current !== null && now - breachAt.current < SLOW_MS && !reducedMotion();
    played.current += Math.min(dt, 0.1) * 1000 * (slow ? 0.12 : 1);
    const t = Math.min(1, (played.current - 350) / 3400);
    progress.current = t <= 0 ? 0 : 1 - Math.pow(1 - t, 2.2);
    const b = layout.breach;
    if (progress.current >= 1 && !told.current) {
      told.current = true;
      setTimeout(() => useStore.getState().set({ drawn: c.id }), 500);
    }
    if (b && breachAt.current === null && progress.current >= b.node.u - 0.03) {
      breachAt.current = now;
      moment.at = now;
      moment.pos.copy(b.pos).setY(b.pos.y + LIFT);
    }
    const u = Math.min(1, (performance.now() - started.current) / 1100);
    const k = Math.max(0.001, 1 - Math.pow(1 - u, 3));
    unfold.current.scale.x = k;
    unfold.current.position.x = X0 * (1 - k);
  });

  return (
    <group position={[0, LIFT, 0]}>
      <Ground />
      <group ref={unfold}>
        <Corridor layout={layout} progress={progress} flash={flash} />
      </group>
      <Journey layout={layout} progress={progress} />
      {allNodes(layout).map((nd) => (
        <StepNode key={nd.key} node={nd} progress={progress} />
      ))}
      {layout.claim && (
        <Line
          points={[layout.nodes[layout.nodes.length - 1].pos, layout.claim.pos]}
          color={PARTY_COLOR.customer}
          transparent
          opacity={0.5}
          lineWidth={1.2}
          dashed
          dashSize={0.09}
          gapSize={0.07}
        />
      )}
      <Breach layout={layout} progress={progress} />
      <EvidenceChain c={c} layout={layout} />
      {ROLES.map((r, i) => c.investigators[r].status !== 'skipped' && <Probe key={r} c={c} role={r} index={i} layout={layout} />)}
      <ChallengeBeam c={c} />
      <ArbiterSweep mode={c.arbiter.status === 'awaiting_approval' ? 'held' : c.arbiter.status === 'deliberating' ? 'sweep' : 'off'} />
    </group>
  );
}

// Everything written on top of the replay. Plain DOM, positioned by the anchors above.
function ReplayLabels({ c, layout }: { c: CaseFile; layout: Layout }) {
  const setInspect = useStore((s) => s.setInspect);
  const inspect = useStore((s) => s.inspect);
  const stepHover = useStore((s) => s.stepHover);
  const tamper = useStore((s) => s.tamper);
  // Labels on every step crowd out the one that matters, so only the story keeps one: what the owner
  // asked, where the journey left the mandate, what was charged and the dispute. The rest show on hover.
  const story = (nd: Node, i: number) =>
    i === 0 || nd.kind === 'charged' || nd.kind === 'claim' || nd === layout.breach?.node || nd.key === stepHover || nd.evidenceId === inspect?.evidenceId;
  const b = layout.breach;
  const over = b && b.node.price !== null ? b.node.price - layout.max : 0;
  // The corridor draws money and session only. An order for more units than the owner asked for
  // can fit under the limit and still be outside the mandate, so it is read from the records too.
  const ordered = Number(c.evidence.find((e) => e.kind === 'ORD')?.data.quantity ?? c.mandate.quantity);
  const extra = !b && ordered > c.mandate.quantity;

  return (
    <LabelLayer>
      <Label anchor="limit" className="tag3d limit">
        <b>Limit {eur(layout.max)}</b>
      </Label>
      {allNodes(layout).map((nd, i) => {
        if (!story(nd, i)) return null;
        return (
          <Label
            key={nd.key}
            anchor={`node:${nd.key}`}
            className={`tag3d step ${i % 2 === 0 ? 'up' : 'down'} ${nd.outside ? 'out' : ''} ${inspect?.evidenceId === nd.evidenceId ? 'sel' : ''}`}
            style={{ ['--c' as string]: nodeColor(nd) }}
            onClick={() => setInspect({ evidenceId: nd.evidenceId })}
            title={nd.label}
          >
            <span className="k">{nd.kind === 'charged' && c.stage === 'hold' ? 'To charge' : KIND_WORD[nd.kind]}</span>
            {nd.price !== null && <b>{eur(nd.price)}</b>}
          </Label>
        );
      })}
      {ROLES.map((role) => {
        const inv = c.investigators[role];
        return (
          // Once verified, the probe parks on its evidence and its colour dot on that step's label says the rest.
          inv.status !== 'skipped' &&
          (inv.status !== 'verified' || inv.challenge?.status === 'pending') && (
            <Label key={role} anchor={`probe:${role}`} className={`tag3d probe ${inv.status}`} style={{ ['--c' as string]: ROLE_COLOR[role] }}>
              <b>{ROLE_NAME[role]}</b>
              <span>
                {inv.challenge?.status === 'pending' ? 'answering a challenge' : STATUS_WORD[inv.status]}
                {inv.attempts > 1 ? ` · try ${inv.attempts}` : ''}
              </span>
            </Label>
          )
        );
      })}
      {c.evidence.map((r) => (
        <Label key={r.id} anchor={`chain:${r.id}`} className={`tag3d chain ${tamper?.evidenceId === r.id ? 'broken' : ''} ${inspect?.evidenceId === r.id ? 'sel' : ''}`}>
          {tamper?.evidenceId === r.id ? 'Seal broken' : r.kind}
        </Label>
      ))}
      {c.status === 'awaiting_approval' && (
        <Label anchor="arbiter" className="tag3d paused">
          Arbiter stopped here
        </Label>
      )}
      {/* What the replay itself shows, computed from the records before any agent rules on it. */}
      <div className={`replay-fact ${b || extra ? 'breach' : 'inside'}`}>
        {b?.kind === 'limit' && (
          <>
            <b>Went over the limit</b>
            <span>
              {eur(over)} over at “{KIND_WORD[b.node.kind]}”
            </span>
          </>
        )}
        {b?.kind === 'scope' && (
          <>
            <b>Left the owner’s session</b>
            <span>
              a different device took over at step {b.node.key.slice(1)}
            </span>
          </>
        )}
        {extra && (
          <>
            <b>Ordered more than asked</b>
            <span>
              {ordered} units against {c.mandate.quantity} allowed, within the {eur(layout.max)} limit
            </span>
          </>
        )}
        {!b && !extra && (
          <>
            <b>Stayed inside the mandate</b>
            <span>
              {eur(layout.total)} charged against a limit of {eur(layout.max)}
            </span>
          </>
        )}
      </div>
    </LabelLayer>
  );
}

const TARGET = new THREE.Vector3(-0.1, 0.7, 0);
const SCENE_W = 12.4; // corridor plus the probe dock on the left and the dispute node on the right
const SCENE_H = 5.9; // floor to the top of the overspend scale

// Where the camera stands for each reading of the corridor.
const VIEW: Record<Lens, THREE.Vector3> = {
  flow: new THREE.Vector3(0.16, 0.2, 1).normalize(), // from the side: money against time
  agents: new THREE.Vector3(-0.95, 0.2, 0.26).normalize(), // down the corridor: money against scope
  liability: new THREE.Vector3(0, 0.985, 0.17).normalize(), // from above: scope against time
};

// Looking down the corridor puts its near end close to the camera, so that view stands further back.
const STAND_BACK: Record<Lens, number> = { flow: 1, agents: 1.38, liability: 1.05 };

function lensOf(dir: THREE.Vector3): Lens {
  if (Math.abs(dir.y) > 0.8) return 'liability';
  return Math.abs(dir.x) > Math.abs(dir.z) ? 'agents' : 'flow';
}

// Side panels overlay the canvas; these are the widths they cover (see theme.css).
// The canvas runs under the floating bars and panels; this is how much of it each covers (see theme.css).
export const overlays = (width: number, dock: boolean) => ({ left: 292, right: width >= 1300 ? 300 : 0, top: 68, bottom: 54 + (dock ? DOCK_H + 12 : 0) });

const INTRO_MS = 3800;

// The camera starts close on the first step and pulls back as the journey is
// drawn, ending where the whole replay fits the part of the canvas the panels
// leave free. After that it turns to a side when asked, and drifts slightly
// until the user takes hold of it. They can look from any side.
function Director({ layout }: { layout: Layout }) {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; enabled: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void } | null;
  const go = useStore((s) => s.replayGo);
  const dock = useStore(dockOpen);
  const distance = useRef(14);
  const shown = useRef<number | null>(null); // the distance the camera is at, easing to the fitted one
  const fit = useMemo(() => new THREE.Vector3(), []);
  const from = useMemo(() => new THREE.Vector3(), []);
  const fromTarget = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const dir = useMemo(() => VIEW.flow.clone(), []);
  const goal = useRef<THREE.Vector3 | null>(VIEW.flow);
  const back = useRef(1);
  const backGoal = useRef(1);
  const started = useRef(performance.now());
  const taken = useRef(false);
  const lean = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const { left, right, top, bottom } = overlays(size.width, dock);
    const free = Math.max(360, size.width - left - right);
    const freeH = Math.max(240, size.height - top - bottom);
    const half = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    distance.current = Math.max(SCENE_W / 2 / (half * (free / size.height)), SCENE_H / 2 / (half * (freeH / size.height)));
    fit.copy(TARGET).addScaledVector(VIEW.flow, distance.current);
    cam.setViewOffset(size.width, size.height, -(left - right) / 2, -(top - bottom) / 2, size.width, size.height);
    cam.updateProjectionMatrix();
    const first = layout.nodes[0].pos;
    fromTarget.set(first.x + 0.6, first.y + LIFT + 0.2, 0);
    from.copy(fromTarget).add(new THREE.Vector3(-1.4, 0.7, 4.2));
  }, [camera, size.width, size.height, fit, from, fromTarget, layout, dock]);

  useEffect(() => {
    if (!go) return;
    goal.current = VIEW[go.to];
    backGoal.current = STAND_BACK[go.to];
    taken.current = false;
    started.current = Math.min(started.current, performance.now() - INTRO_MS); // a request ends the opening shot
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

  useFrame(({ clock }, dt) => {
    const t = Math.min(1, (performance.now() - started.current) / INTRO_MS);
    // Orbit limits would fight the close opening shot, so the controls wait until it is over.
    if (controls) controls.enabled = t >= 1;
    if (t < 1) {
      const k = t * t * (3 - 2 * t);
      camera.position.lerpVectors(from, fit, k);
      controls?.target.lerpVectors(fromTarget, TARGET, k);
      camera.lookAt(controls?.target ?? TARGET);
    } else if (!taken.current && goal.current) {
      dir.lerp(goal.current, 1 - Math.exp(-dt * 3.2)).normalize();
      back.current += (backGoal.current - back.current) * (1 - Math.exp(-dt * 3.2));
      // idle: swing a few degrees either way
      offset.copy(dir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, Math.sin(clock.elapsedTime * 0.22) * 0.07);
      shown.current ??= distance.current;
      shown.current += (distance.current - shown.current) * (1 - Math.exp(-dt * 2.5));
      camera.position.copy(TARGET).addScaledVector(offset, shown.current * back.current);
      controls?.target.copy(TARGET);
      camera.lookAt(TARGET);
    } else {
      dir.copy(camera.position).sub(controls?.target ?? TARGET).normalize();
    }
    // The breach: lean in towards it and back out, unless the person has taken the camera.
    const age = performance.now() - moment.at;
    if (age < PUNCH_MS && !taken.current && !reducedMotion()) {
      const x = Math.sin(Math.PI * Math.min(1, age / PUNCH_MS));
      const e = x * x * (3 - 2 * x);
      lean.copy(camera.position).sub(moment.pos).setLength(3.4).add(moment.pos);
      camera.position.lerp(lean, 0.55 * e);
      look.copy(controls?.target ?? TARGET).lerp(moment.pos, 0.7 * e);
      camera.lookAt(look);
      if (controls) controls.enabled = false;
    }
    const lens = t < 1 ? 'flow' : lensOf(dir);
    if (lens !== useStore.getState().replayLens) useStore.getState().set({ replayLens: lens });
  });
  return null;
}

export function CaseScene({ c }: { c: CaseFile }) {
  const limitPreview = useStore((s) => s.limitPreview);
  // Rebuilt only for a new case or when the what-if slider moves the limit.
  const layout = useMemo(() => layoutCase(c, limitPreview), [c.id, limitPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {/* Memory: the composer draws the frame, so the canvas needs no multisampled buffer of its own, and
          the composer's default of 8x MSAA on full-size half-float buffers costs hundreds of MB per
          canvas. On a laptop whose graphics share the system's RAM, that is the system's RAM. */}
      <Canvas camera={{ position: [1.6, 2.5, 13], fov: 34 }} dpr={[1, 1.5]} gl={{ antialias: false }}>
        <Director layout={layout} />
        <Projector />
        <color attach="background" args={[BG]} />
        <fog attach="fog" args={[BG, 22, 48]} />
        <Replay c={c} layout={layout} />
        <OrbitControls
          makeDefault
          enablePan={false}
          target={[-0.1, 0.7, 0]}
          minDistance={6}
          maxDistance={40}
          minPolarAngle={0.05}
          maxPolarAngle={1.62}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.5}
        />
        <EffectComposer multisampling={2}>
          <Bloom intensity={0.6} luminanceThreshold={0.35} luminanceSmoothing={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.25} darkness={0.7} />
        </EffectComposer>
      </Canvas>
      <ReplayLabels c={c} layout={layout} />
    </>
  );
}
