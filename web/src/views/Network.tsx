import { MeshReflectorMaterial, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CaseFile } from '../../../shared/types';
import { MERCHANTS, PARTIES, PROVIDER_NAMES } from '../../../shared/types';
import { BG, BREACH, DIVE_MS, eur, INK, PARTY_COLOR, topParty, useStore } from '../store';
import { footprintShader, glassShader, hash, isFiled } from './Gate';
import { Label, LabelLayer, Projector, useAnchor } from './labels';

// The network: one glass box per merchant, each the same box as the merchant
// view at small scale (bay by who was liable, height by order value, depth by
// agent provider). The lines between them are the network. When a ruling
// teaches it an attack, a pulse spreads from that merchant's box to every
// other; when a box later stops that attack on arrival, it flashes and a line
// points back to the merchant the knowledge came from.

const COLS = 4;
const N = MERCHANTS.length;
const ROWS = Math.ceil(N / COLS);
const BW = 2.0; // box length
const BH = 1.15; // box height
const BD = 1.25; // box depth
const SX = 3.5; // spacing between columns
const SZ = 3.5; // spacing between rows
const HOP_MS = 260; // how long a pulse takes from one box to the next

const HOME = MERCHANTS.map((_, i) => new THREE.Vector3((i % COLS - (COLS - 1) / 2) * SX, 0, (Math.floor(i / COLS) - (ROWS - 1) / 2) * SZ));
const indexOf = (name: string) => MERCHANTS.findIndex((m) => m.name === name);

// Each box is linked to its neighbours, diagonals included: a mesh, not a hub.
const EDGES: [number, number][] = [];
for (let a = 0; a < N; a++)
  for (let b = a + 1; b < N; b++)
    if (Math.max(Math.abs((a % COLS) - (b % COLS)), Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS))) === 1) EDGES.push([a, b]);

// The order a pulse reaches every box from a source, one hop at a time.
function spread(source: number): { from: number; to: number; depth: number }[] {
  const depth = new Array(N).fill(-1);
  depth[source] = 0;
  const hops: { from: number; to: number; depth: number }[] = [];
  for (let queue = [source]; queue.length; ) {
    const next: number[] = [];
    for (const u of queue)
      for (const [a, b] of EDGES) {
        const v = a === u ? b : b === u ? a : -1;
        if (v < 0 || depth[v] >= 0) continue;
        depth[v] = depth[u] + 1;
        hops.push({ from: u, to: v, depth: depth[u] });
        next.push(v);
      }
    queue = next;
  }
  return hops;
}

// When each box last lit up: white when the network taught it something, red when it stopped an attack.
const litAt = new Float64Array(N).fill(-1e9);
const hitAt = new Float64Array(N).fill(-1e9);

const BAYS = PARTIES.length + 1; // held, then one per party that can be liable
function inside(c: CaseFile, i: number, out: THREE.Vector3) {
  const b = HOME[i];
  const bay = isFiled(c) ? 1 + PARTIES.indexOf(topParty(c.arbiter.ruling!.split)) : 0;
  const v = (Math.log10(THREE.MathUtils.clamp(c.purchase.total, 10, 5000)) - 1) / (Math.log10(5000) - 1);
  const lane = Math.max(0, PROVIDER_NAMES.indexOf(c.purchase.provider));
  return out.set(
    b.x - BW / 2 + ((bay + 0.5 + (hash(c.id) - 0.5) * 0.6) * BW) / BAYS,
    0.14 + v * (BH - 0.28),
    b.z + ((lane - (PROVIDER_NAMES.length - 1) / 2) / PROVIDER_NAMES.length) * (BD - 0.25) + (hash(c.id + 'z') - 0.5) * 0.12,
  );
}

const BOX = new THREE.BoxGeometry(BW, BH, BD);
const EDGE_LINES = new THREE.EdgesGeometry(BOX);
const BASE = new THREE.Color('#e9e9e6');
const WHITE = new THREE.Color('#ffffff');
const RED = new THREE.Color(BREACH);

function MerchantBox({ i }: { i: number }) {
  const name = MERCHANTS[i].name;
  const edges = useRef<THREE.LineBasicMaterial>(null!);
  const floor = useRef<THREE.ShaderMaterial>(null!);
  const fill = useRef<THREE.MeshBasicMaterial>(null!);
  const enterBox = useStore((s) => s.enterBox);
  const [over, setOver] = useState(false);
  const tint = useMemo(() => new THREE.Color(), []);
  useAnchor(`net:${i}`, (out) => (out.set(HOME[i].x, 0, HOME[i].z + BD / 2 + 0.35), true));
  useAnchor(`net-top:${i}`, (out) => (out.set(HOME[i].x, BH + 0.25, HOME[i].z), true));

  useFrame(() => {
    const now = performance.now();
    const lit = Math.exp(-(now - litAt[i]) / 450);
    const hit = Math.exp(-(now - hitAt[i]) / 900);
    tint.copy(BASE).lerp(WHITE, lit).lerp(RED, hit);
    edges.current.color.copy(tint);
    edges.current.opacity = (over ? 0.95 : 0.55) + 0.45 * Math.max(lit, hit);
    floor.current.uniforms.uGain.value = 0.7 + 2.5 * Math.max(lit, hit) + (over ? 0.8 : 0);
    fill.current.color.copy(hit > lit ? RED : WHITE);
    fill.current.opacity = 0.22 * Math.max(lit, hit);
  });

  return (
    <group position={HOME[i]}>
      {/* the layers of a box draw in a fixed order, so they cannot swap places as the camera moves */}
      <mesh position={[0, BH / 2, 0]} geometry={BOX} renderOrder={1}>
        <meshBasicMaterial color="#000000" transparent opacity={0.45} depthWrite={false} side={THREE.BackSide} />
      </mesh>
      <mesh position={[0, BH / 2, 0]} geometry={BOX} renderOrder={2}>
        <shaderMaterial args={[glassShader]} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, BH / 2, 0]} geometry={BOX} renderOrder={3}>
        <meshBasicMaterial ref={fill} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <lineSegments position={[0, BH / 2, 0]} geometry={EDGE_LINES} renderOrder={4}>
        <lineBasicMaterial ref={edges} color={BASE} transparent opacity={0.55} toneMapped={false} />
      </lineSegments>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={0}>
        <planeGeometry args={[BW + 0.9, BD + 0.8]} />
        <shaderMaterial
          ref={floor}
          args={[{ ...footprintShader, uniforms: { uGain: { value: 1 } }, fragmentShader: footprintShader.fragmentShader.replace('void main() {', 'uniform float uGain;\nvoid main() {').replace('gl_FragColor = vec4(vec3(0.95), 0.08', 'gl_FragColor = vec4(vec3(0.95), 0.08 * uGain') }]}
          transparent
          depthWrite={false}
        />
      </mesh>
      {/* the whole box is the click target */}
      <mesh
        position={[0, BH / 2, 0]}
        geometry={BOX}
        onClick={(e) => {
          e.stopPropagation();
          document.body.style.cursor = '';
          enterBox(name);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
          setOver(true);
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
          setOver(false);
        }}
      >
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Mesh() {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    for (const [a, b] of EDGES) pts.push(HOME[a].x, 0.012, HOME[a].z, HOME[b].x, 0.012, HOME[b].z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.13} />
    </lineSegments>
  );
}

// Every decided case, filed inside its merchant's box in the colour of who was liable.
const MAX_DOTS = 400;
function Filed() {
  const cases = useStore((s) => s.cases);
  const dots = useRef<THREE.InstancedMesh>(null!);
  const holds = useRef<THREE.InstancedMesh>(null!);
  const open = useMemo(() => Object.values(cases).filter((c) => !c.closedAt), [cases]);

  useEffect(() => {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    let n = 0;
    for (const c of Object.values(cases)) {
      if (!isFiled(c) || n >= MAX_DOTS) continue;
      const i = indexOf(c.purchase.merchant.name);
      if (i < 0) continue;
      m.makeTranslation(inside(c, i, p));
      dots.current.setMatrixAt(n, m);
      dots.current.setColorAt(n, color.set(PARTY_COLOR[topParty(c.arbiter.ruling!.split)]));
      n++;
    }
    dots.current.count = n;
    dots.current.instanceMatrix.needsUpdate = true;
    if (dots.current.instanceColor) dots.current.instanceColor.needsUpdate = true;
  }, [cases]);

  // Payments being held or waiting for a person pulse in the first bay.
  useFrame(({ clock }) => {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.25;
    let n = 0;
    for (const c of open) {
      const i = indexOf(c.purchase.merchant.name);
      if (i < 0 || n >= 40) continue;
      m.compose(inside(c, i, p), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
      holds.current.setMatrixAt(n++, m);
    }
    holds.current.count = n;
    holds.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={dots} args={[undefined, undefined, MAX_DOTS]} frustumCulled={false}>
        <sphereGeometry args={[0.048, 12, 12]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={holds} args={[undefined, undefined, 40]} frustumCulled={false}>
        <octahedronGeometry args={[0.07, 0]} />
        <meshBasicMaterial color={INK} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

// Purchases arriving: small beads travelling into the side of each merchant's box. They are
// solid and fade by size, not light: glowing points add up wherever they line up on screen,
// and seen along a row of boxes they piled into bright blobs.
const BEADS = 240;
const BEAD = new THREE.Color('#d6d6d3');
const HELD_BEAD = new THREE.Color('#ffffff');
function Arrivals() {
  const beads = useRef<THREE.InstancedMesh>(null!);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const now = performance.now();
    let n = 0;
    for (const a of useStore.getState().arcs) {
      const age = (now - a.seenAt) / 1500;
      if (age < 0 || age > 1 || n >= BEADS) continue;
      const i = indexOf(a.merchant.name);
      if (i < 0) continue;
      const b = HOME[i];
      const k = 1 - Math.pow(1 - age, 2);
      const start = b.x - BW / 2 - 1.5;
      p.set(start + (BW / 2 + 1.5 - 0.1) * k, 0.2 + hash(a.id) * (BH - 0.4), b.z + (hash(a.id + 'z') - 0.5) * (BD - 0.3));
      const size = Math.sin(Math.PI * age) * (a.held ? 1.3 : 1);
      m.compose(p, q, v.setScalar(Math.max(0.001, size)));
      beads.current.setMatrixAt(n, m);
      beads.current.setColorAt(n, a.held ? HELD_BEAD : BEAD);
      n++;
    }
    beads.current.count = n;
    beads.current.instanceMatrix.needsUpdate = true;
    if (beads.current.instanceColor) beads.current.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={beads} args={[undefined, undefined, BEADS]} frustumCulled={false}>
      <sphereGeometry args={[0.032, 10, 10]} />
      <meshBasicMaterial />
    </instancedMesh>
  );
}

interface Pulse {
  from: number;
  to: number;
  start: number;
}

// What the network learned travelling, box to box; what it stopped, pointing home.
function Signals() {
  const pulseMesh = useRef<THREE.InstancedMesh>(null!);
  const arcs = useRef<THREE.Group>(null!);
  const pulses = useRef<Pulse[]>([]);
  const seenWaves = useRef(0);
  const seenCatches = useRef(0);
  const mounted = useMemo(() => performance.now(), []);
  const live = useRef<{ line: THREE.Line; at: number }[]>([]);

  useFrame(() => {
    const now = performance.now();
    const { waves, catches } = useStore.getState();

    for (const w of waves.slice(seenWaves.current)) {
      const source = indexOf(w.merchant);
      if (source < 0 || w.at < mounted - 4000) continue;
      litAt[source] = w.at;
      for (const hop of spread(source)) pulses.current.push({ from: hop.from, to: hop.to, start: w.at + hop.depth * HOP_MS });
    }
    seenWaves.current = waves.length;

    for (const c of catches.slice(seenCatches.current)) {
      const to = indexOf(c.merchant);
      const from = indexOf(c.source);
      if (to < 0 || c.at < mounted - 4000) continue;
      hitAt[to] = c.at;
      if (from >= 0 && from !== to) {
        const a = HOME[from].clone().setY(BH + 0.1);
        const b = HOME[to].clone().setY(BH + 0.1);
        const mid = a.clone().lerp(b, 0.5).setY(BH + 1.2 + a.distanceTo(b) * 0.12);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(48)),
          new THREE.LineBasicMaterial({ color: INK, transparent: true, toneMapped: false }),
        );
        arcs.current.add(line);
        live.current.push({ line, at: c.at });
      }
    }
    seenCatches.current = catches.length;

    // pulses along the mesh
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let n = 0;
    pulses.current = pulses.current.filter((q) => {
      const t = (now - q.start) / HOP_MS;
      if (t >= 1) {
        litAt[q.to] = Math.max(litAt[q.to], q.start + HOP_MS);
        return false;
      }
      if (t >= 0 && n < 80) {
        p.lerpVectors(HOME[q.from], HOME[q.to], t).setY(0.08);
        m.makeTranslation(p);
        pulseMesh.current.setMatrixAt(n++, m);
      }
      return true;
    });
    pulseMesh.current.count = n;
    pulseMesh.current.instanceMatrix.needsUpdate = true;

    // the line from a catch back to where the knowledge came from fades out
    live.current = live.current.filter((l) => {
      const t = (now - l.at) / 2600;
      (l.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, 0.9 * (1 - t));
      if (t < 1) return true;
      arcs.current.remove(l.line);
      l.line.geometry.dispose();
      (l.line.material as THREE.Material).dispose();
      return false;
    });
  });

  return (
    <>
      <instancedMesh ref={pulseMesh} args={[undefined, undefined, 80]} frustumCulled={false}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <group ref={arcs} />
    </>
  );
}

const TARGET = new THREE.Vector3(0, 0.3, 0.35);
const VIEW = new THREE.Vector3(0, 1.55, 1).normalize();
const SCENE_W = COLS * SX + 2.6;
const SCENE_H = ROWS * SZ * 0.85 + 2.2;

// Frames the whole network, flies into a box when one is opened, and pulls out
// of the box just left when coming back.
function Rig() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; enabled: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void } | null;
  const boxing = useStore((s) => s.boxing);
  const fit = useRef(new THREE.Vector3());
  const offset = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const dive = useRef<{ from: THREE.Vector3; to: THREE.Vector3; at: THREE.Vector3; start: number } | null>(null);
  const arrive = useRef<{ from: THREE.Vector3; look: THREE.Vector3; start: number } | null>(null);
  const taken = useRef(false);

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const right = size.width >= 900 ? 362 : 0;
    const free = Math.max(360, size.width - right);
    const half = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const distance = Math.max(SCENE_W / 2 / (half * (free / size.height)), SCENE_H / 2 / half);
    fit.current.copy(TARGET).addScaledVector(VIEW, distance);
    cam.setViewOffset(size.width, size.height, right / 2, 0, size.width, size.height);
    cam.updateProjectionMatrix();
    if (!arrive.current && !taken.current) camera.position.copy(fit.current);
  }, [camera, size.width, size.height]);

  // Coming back from a box: start inside it and pull out to the whole network.
  useEffect(() => {
    const last = useStore.getState().lastMerchant;
    const i = last ? indexOf(last) : -1;
    if (i < 0) return;
    const box = HOME[i].clone().setY(BH / 2);
    arrive.current = { from: box.clone().add(new THREE.Vector3(0, 0.5, 1.4)), look: box, start: performance.now() };
  }, []);

  useEffect(() => {
    if (!boxing) return;
    const i = indexOf(boxing.merchant);
    if (i < 0) return;
    const box = HOME[i].clone().setY(BH / 2);
    dive.current = { from: camera.position.clone(), to: box.clone().add(new THREE.Vector3(0, 0.25, 0.75)), at: box, start: boxing.at };
    if (controls) controls.enabled = false;
  }, [boxing, camera, controls]);

  useEffect(() => {
    if (!controls) return;
    const take = () => (taken.current = true);
    controls.addEventListener('start', take);
    return () => controls.removeEventListener('start', take);
  }, [controls]);

  useFrame(({ clock }) => {
    const now = performance.now();
    if (dive.current) {
      const k = Math.min(1, (now - dive.current.start) / DIVE_MS);
      camera.position.lerpVectors(dive.current.from, dive.current.to, k * k * k);
      camera.lookAt(look.lerpVectors(controls?.target ?? TARGET, dive.current.at, Math.min(1, k * 2)));
      return;
    }
    if (arrive.current) {
      const k = Math.min(1, (now - arrive.current.start) / 1100);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(arrive.current.from, fit.current, e);
      camera.lookAt(look.lerpVectors(arrive.current.look, TARGET, e));
      if (k >= 1) arrive.current = null;
      return;
    }
    if (taken.current) return;
    offset.copy(fit.current).sub(TARGET).applyAxisAngle(THREE.Object3D.DEFAULT_UP, Math.sin(clock.elapsedTime * 0.14) * 0.06);
    camera.position.copy(TARGET).add(offset);
    camera.lookAt(TARGET);
  });
  return null;
}

// Names under the boxes, and short notes when the network learns or stops something.
function NetworkLabels() {
  const cases = useStore((s) => s.cases);
  const waves = useStore((s) => s.waves);
  const catches = useStore((s) => s.catches);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const now = performance.now();
  const counts = useMemo(() => {
    const out = MERCHANTS.map(() => ({ open: 0, caught: 0 }));
    for (const c of Object.values(cases)) {
      const i = indexOf(c.purchase.merchant.name);
      if (i < 0) continue;
      if (!c.closedAt) out[i].open++;
      if (c.network && c.closedAt) out[i].caught++;
    }
    return out;
  }, [cases]);
  // The most recent note per box: a catch outranks something learned.
  const notes = new Map<number, { kind: 'caught' | 'learned'; text: string }>();
  for (const w of waves) if (now - w.at < 4500) notes.set(indexOf(w.merchant), { kind: 'learned', text: `Learned: ${w.label}` });
  for (const c of catches) if (now - c.at < 3500) notes.set(indexOf(c.merchant), { kind: 'caught', text: `Stopped on arrival · ${eur(c.total)}` });

  return (
    <LabelLayer>
      {MERCHANTS.map((m, i) => (
        <Label key={m.name} anchor={`net:${i}`} className="net-name">
          <b>{m.name}</b>
          <span>
            {counts[i].open > 0 ? `${counts[i].open} open` : m.city}
            {counts[i].caught > 0 ? ` · ${counts[i].caught} stopped by the network` : ''}
          </span>
        </Label>
      ))}
      {[...notes].map(([i, note]) => (
        <Label key={`${i}-${note.text}`} anchor={`net-top:${i}`} className={`net-note ${note.kind}`}>
          {note.text}
        </Label>
      ))}
    </LabelLayer>
  );
}

export function NetworkScene() {
  return (
    <>
      <Canvas camera={{ position: [0, 9, 11], fov: 30, near: 0.5, far: 200 }} dpr={[1, 1.5]} gl={{ antialias: false }}>
        <color attach="background" args={[BG]} />
        <fog attach="fog" args={[BG, 16, 40]} />
        <Rig />
        <Projector />
        {/* just below the boxes: level with their bottom faces, the two would flicker */}
        <mesh position={[0, -0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[90, 70]} />
          <MeshReflectorMaterial resolution={512} blur={[420, 140]} mixBlur={1} mixStrength={2} mixContrast={1} roughness={1} depthScale={0} color="#0c0c0e" metalness={0.6} mirror={0.5} />
        </mesh>
        <Mesh />
        {MERCHANTS.map((m, i) => (
          <MerchantBox key={m.name} i={i} />
        ))}
        <Filed />
        <Arrivals />
        <Signals />
        <OrbitControls makeDefault enablePan={false} enableZoom minDistance={6} maxDistance={40} target={TARGET} minPolarAngle={0.05} maxPolarAngle={1.45} enableDamping dampingFactor={0.08} rotateSpeed={0.5} />
        <EffectComposer multisampling={2}>
          <Bloom intensity={0.6} luminanceThreshold={0.35} luminanceSmoothing={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.25} darkness={0.7} />
        </EffectComposer>
      </Canvas>
      <NetworkLabels />
    </>
  );
}
