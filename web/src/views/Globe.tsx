import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import land from 'world-atlas/land-110m.json';
import { MERCHANTS } from '../../../shared/types';
import { BG, BREACH, eur, INK, useStore } from '../store';
import { Label, LabelLayer, Projector, useAnchor } from './labels';

// The network as a planet. Every merchant runs its own Blackbox in its own city.
// Each purchase an agent makes flies from the buyer's city to the merchant's.
// When a ruling teaches the network an attack, a wave leaves that city and goes
// round the world, and every merchant it passes is shielded. When the same
// attack lands somewhere else, it breaks on that city's shield, and a line
// points back to where the knowledge came from.

const R = 2; // globe radius
const DEG = Math.PI / 180;
const N = MERCHANTS.length;
const WAVE_SPEED = 1.15; // radians of arc per second
const MAX_WAVES = 4;

function onGlobe(lat: number, lon: number, r = R, out = new THREE.Vector3()) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return out.set(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

const CITY = MERCHANTS.map((m) => onGlobe(m.lat, m.lon));
const CITY_DIR = CITY.map((p) => p.clone().normalize());
const indexOf = (name: string) => MERCHANTS.findIndex((m) => m.name === name);

// The European merchants sit close together, so each of their labels takes its own side of the city.
const SIDE: Record<string, 'left' | 'right' | 'above' | 'below' | 'below-left' | 'below-right'> = {
  London: 'left',
  Paris: 'below-left',
  Berlin: 'right',
  Stockholm: 'above',
  Belgrade: 'below-right',
};

// When each city last lit up: an arrival, a shield going up as a wave passed, a hit on the shield.
const arrivedAt = new Float64Array(N).fill(-1e9);
const shieldedAt = new Float64Array(N).fill(-1e9);
const hitAt = new Float64Array(N).fill(-1e9);

// ───────────────────────── the planet ─────────────────────────

// Land as a field of dots: the coastlines are drawn once onto a small map, and
// evenly spread points on the sphere keep only the ones that fall on land.
function landDots(): Float32Array {
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const topo = land as unknown as Topology;
  const geo = feature(topo, topo.objects.land) as unknown as { features: Feature<Polygon | MultiPolygon>[] };
  ctx.fillStyle = '#fff';
  for (const f of geo.features) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    // A ring that crosses the date line would jump across the whole map, so each is made continuous
    // and drawn three times, a world apart; the canvas keeps only what falls on it.
    for (const rings of polygons)
      for (const shift of [-360, 0, 360]) {
        ctx.beginPath();
        for (const ring of rings) {
          let prev = ring[0][0];
          let offset = 0;
          ring.forEach(([lon, lat], k) => {
            if (lon - prev > 180) offset -= 360;
            else if (prev - lon > 180) offset += 360;
            prev = lon;
            const x = ((lon + offset + shift + 180) / 360) * W;
            const y = ((90 - lat) / 180) * H;
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
        }
        ctx.fill('evenodd');
      }
  }
  const mask = ctx.getImageData(0, 0, W, H).data;
  const out: number[] = [];
  const total = 42000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const p = new THREE.Vector3();
  for (let i = 0; i < total; i++) {
    const y = 1 - (i / (total - 1)) * 2;
    const lat = Math.asin(y) / DEG;
    const lon = ((((i * golden) / DEG) % 360) + 360) % 360 - 180;
    const px = Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
    const py = Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
    if (mask[(py * W + px) * 4] < 128) continue;
    onGlobe(lat, lon, R * 1.001, p);
    out.push(p.x, p.y, p.z);
  }
  return new Float32Array(out);
}

const dotShader = {
  uniforms: { uSize: { value: 1 } },
  vertexShader: /* glsl */ `
    uniform float uSize;
    varying float vFacing;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vFacing = dot(normalize(normalMatrix * normalize(position)), normalize(-mv.xyz));
      gl_PointSize = uSize * (19.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vFacing;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      if (dot(c, c) > 0.25) discard;
      gl_FragColor = vec4(0.46, 0.48, 0.52, 0.85 * smoothstep(0.0, 0.45, vFacing));
    }`,
};

// A faint rim of light around the planet.
const rimShader = {
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      float rim = pow(1.0 - abs(dot(vNormal, vView)), 4.0);
      gl_FragColor = vec4(vec3(0.75, 0.8, 0.9), rim * 0.22);
    }`,
};

// The waves of what the network has learned, drawn on a shell just above the surface.
const waveShader = {
  uniforms: {
    uDir: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector3(0, 1, 0)) },
    uAge: { value: new Array(MAX_WAVES).fill(99) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vDir = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uDir[${MAX_WAVES}];
    uniform float uAge[${MAX_WAVES}];
    varying vec3 vDir;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      float glow = 0.0;
      for (int i = 0; i < ${MAX_WAVES}; i++) {
        float front = uAge[i] * ${WAVE_SPEED.toFixed(3)};
        if (front > 3.3) continue;
        float ang = acos(clamp(dot(vDir, uDir[i]), -1.0, 1.0));
        float fade = 1.0 - smoothstep(2.4, 3.2, front);
        float band = 0.55 * exp(-pow((ang - front) / 0.028, 2.0));
        float wake = step(ang, front) * 0.07 * exp(-(front - ang) * 2.5);
        glow += (band + wake) * fade;
      }
      float facing = smoothstep(0.0, 0.3, dot(vNormal, vView));
      gl_FragColor = vec4(vec3(1.0), glow * facing);
    }`,
};

function Planet() {
  const dots = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(landDots(), 3));
    return g;
  }, []);
  const dotMat = useRef<THREE.ShaderMaterial>(null!);
  const dpr = useThree((s) => s.viewport.dpr);
  const { size } = useThree();
  useEffect(() => {
    dotMat.current.uniforms.uSize.value = dpr * (size.height / 800) * 1.15;
  }, [dpr, size.height]);

  // Lines of latitude and longitude, barely there.
  const grid = useMemo(() => {
    const pts: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let lat = -60; lat <= 60; lat += 30)
      for (let lon = -180; lon < 180; lon += 3) {
        onGlobe(lat, lon, R * 1.0005, a);
        onGlobe(lat, lon + 3, R * 1.0005, b);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    for (let lon = -180; lon < 180; lon += 30)
      for (let lat = -84; lat < 84; lat += 3) {
        onGlobe(lat, lon, R * 1.0005, a);
        onGlobe(lat + 3, lon, R * 1.0005, b);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  return (
    <>
      <mesh>
        <sphereGeometry args={[R * 0.998, 96, 96]} />
        <meshBasicMaterial color="#0b0b0e" />
      </mesh>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.045} depthWrite={false} />
      </lineSegments>
      <points geometry={dots}>
        <shaderMaterial ref={dotMat} args={[dotShader]} transparent depthWrite={false} />
      </points>
      <mesh scale={1.05}>
        <sphereGeometry args={[R, 64, 64]} />
        <shaderMaterial args={[rimShader]} transparent depthWrite={false} side={THREE.BackSide} blending={THREE.AdditiveBlending} />
      </mesh>
    </>
  );
}

// Stars far behind the planet: small, sparse and faint, each twinkling a little at its own pace.
const starShader = {
  uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
  vertexShader: /* glsl */ `
    attribute float size;
    attribute float phase;
    uniform float uTime;
    uniform float uScale;
    varying float vAlpha;
    void main() {
      vAlpha = (0.18 + 0.3 * size) * (0.75 + 0.25 * sin(uTime * (0.6 + phase) + phase * 6.283));
      gl_PointSize = (0.8 + size * 1.6) * uScale;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying float vAlpha;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = dot(c, c);
      if (d > 0.25) discard;
      gl_FragColor = vec4(vec3(0.9, 0.92, 1.0), vAlpha * (1.0 - d * 4.0));
    }`,
};

function Stars() {
  const geometry = useMemo(() => {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(55 + Math.random() * 25);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = Math.pow(Math.random(), 3); // mostly tiny, a few brighter
      phase[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    return g;
  }, []);
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const dpr = useThree((s) => s.viewport.dpr);
  useFrame(({ clock }) => {
    mat.current.uniforms.uTime.value = clock.elapsedTime;
    mat.current.uniforms.uScale.value = dpr;
  });
  return (
    <points geometry={geometry}>
      <shaderMaterial ref={mat} args={[starShader]} transparent depthWrite={false} />
    </points>
  );
}

// ───────────────────────── merchants ─────────────────────────

const UP = new THREE.Vector3(0, 1, 0);
const BASE = new THREE.Color('#e9e9e6');
const RED = new THREE.Color(BREACH);
const WHITE = new THREE.Color('#ffffff');

function City({ i, signatures, open }: { i: number; signatures: number; open: number }) {
  const name = MERCHANTS[i].name;
  const focus = useStore((s) => s.focus);
  const focusCity = useStore((s) => s.focusCity);
  const [over, setOver] = useState(false);
  const beam = useRef<THREE.MeshBasicMaterial>(null!);
  const ring = useRef<THREE.Mesh>(null!);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null!);
  const shield = useRef<THREE.ShaderMaterial>(null!);
  const tint = useMemo(() => new THREE.Color(), []);
  const turn = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, CITY_DIR[i]), [i]);
  const facing = useMemo(() => new THREE.Vector3(), []);
  const { camera } = useThree();
  const visible = () => facing.copy(camera.position).normalize().dot(CITY_DIR[i]) > 0.18;
  useAnchor(`city:${i}`, (out) => (out.copy(CITY[i]), visible()));
  useAnchor(`city-top:${i}`, (out) => (out.copy(CITY_DIR[i]).multiplyScalar(R + 0.42), visible()));

  const shieldMat = useMemo(
    () => ({
      uniforms: { uColor: { value: new THREE.Color(WHITE) }, uLevel: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vY;
        void main() {
          vY = position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uLevel;
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vY;
        void main() {
          float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.0);
          float bands = 0.5 + 0.5 * sin(vY * 200.0);
          gl_FragColor = vec4(uColor, uLevel * (0.25 + rim * 0.9) * (0.75 + 0.25 * bands));
        }`,
    }),
    [],
  );

  useFrame(({ clock }) => {
    const now = performance.now();
    const arrived = Math.exp(-(now - arrivedAt[i]) / 500);
    const raised = Math.exp(-(now - shieldedAt[i]) / 700);
    const hit = Math.exp(-(now - hitAt[i]) / 1100);
    const chosen = focus === name;
    tint.copy(BASE).lerp(WHITE, Math.max(arrived, raised)).lerp(RED, hit);
    beam.current.color.copy(tint);
    beam.current.opacity = 0.55 + 0.45 * Math.max(arrived, hit, over || chosen ? 1 : 0);
    // A city with cases open pulses.
    const pulse = open > 0 ? (clock.elapsedTime * 0.8 + i * 0.13) % 1 : 1;
    ring.current.scale.setScalar(0.6 + pulse * 1.6);
    ringMat.current.opacity = open > 0 ? 0.7 * (1 - pulse) : 0;
    // Once the network has learned anything, every city keeps a faint shield.
    shield.current.uniforms.uLevel.value = (signatures > 0 ? 0.05 : 0) + 0.8 * raised + 1.4 * hit;
    (shield.current.uniforms.uColor.value as THREE.Color).copy(WHITE).lerp(RED, hit);
  });

  return (
    <group position={CITY[i]} quaternion={turn}>
      {/* a dark clearing in the land dots, so a city never reads as one more dot */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
        <circleGeometry args={[0.075, 32]} />
        <meshBasicMaterial color={BG} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <ringGeometry args={[0.058, 0.066, 48]} />
        <meshBasicMaterial color={INK} transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.03, 24]} />
        <meshBasicMaterial color={[1.8, 1.8, 1.75]} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.21, 0]}>
        <cylinderGeometry args={[0.0035, 0.009, 0.42, 8]} />
        <meshBasicMaterial ref={beam} transparent toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry args={[0.07, 0.078, 40]} />
        <meshBasicMaterial ref={ringMat} color={INK} transparent opacity={0} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.12, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <shaderMaterial ref={shield} args={[shieldMat]} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh
        position={[0, 0.08, 0]}
        onClick={(e) => {
          e.stopPropagation();
          focusCity(focus === name ? null : name);
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
        <sphereGeometry args={[0.13, 12, 12]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ───────────────────────── what moves ─────────────────────────

// A path over the surface from a to b, lifted higher the further apart they are.
function arcPoints(a: THREE.Vector3, b: THREE.Vector3, segments = 64, lift = 1) {
  const ua = a.clone().normalize();
  const ub = b.clone().normalize();
  const angle = ua.angleTo(ub);
  const height = (0.05 + 0.3 * (angle / Math.PI)) * R * lift;
  const pts: THREE.Vector3[] = [];
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3().crossVectors(ua, ub);
  if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
  axis.normalize();
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    q.setFromAxisAngle(axis, angle * t);
    pts.push(ua.clone().applyQuaternion(q).multiplyScalar(R + Math.sin(Math.PI * t) * height));
  }
  return pts;
}

// A comet along a path: a bright head and a tail that fades behind it.
const cometShader = {
  uniforms: { uHead: { value: 0 }, uColor: { value: new THREE.Color() }, uFade: { value: 1 }, uTail: { value: 0.32 } },
  vertexShader: /* glsl */ `
    attribute float t;
    varying float vT;
    void main() {
      vT = t;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uHead;
    uniform float uTail;
    uniform float uFade;
    uniform vec3 uColor;
    varying float vT;
    void main() {
      if (vT > uHead) discard;
      float a = smoothstep(uHead - uTail, uHead, vT);
      gl_FragColor = vec4(uColor, a * uFade);
    }`,
};

interface Flight {
  line: THREE.Line;
  head: THREE.Vector3[];
  start: number;
  ms: number;
  hold: number; // how long the full line stays before fading
  to: number; // city it lands in, or -1
}

function flight(pts: THREE.Vector3[], color: THREE.Color, start: number, ms: number, opts: { tail?: number; hold?: number; to?: number } = {}): Flight {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  g.setAttribute('t', new THREE.Float32BufferAttribute(pts.map((_, k) => k / (pts.length - 1)), 1));
  const mat = new THREE.ShaderMaterial({ ...cometShader, uniforms: THREE.UniformsUtils.clone(cometShader.uniforms), transparent: true, depthWrite: false, toneMapped: false });
  mat.uniforms.uColor.value.copy(color);
  mat.uniforms.uTail.value = opts.tail ?? 0.32;
  return { line: new THREE.Line(g, mat), head: pts, start, ms, hold: opts.hold ?? 0, to: opts.to ?? -1 };
}

const PURCHASE = new THREE.Color('#9a9a97');
const HELD = new THREE.Color('#ffffff');
const KNOWLEDGE = new THREE.Color(INK);

// Purchases arriving, and the line from a stopped attack back to where it was learned.
function Traffic() {
  const group = useRef<THREE.Group>(null!);
  const heads = useRef<THREE.InstancedMesh>(null!);
  const flights = useRef<Flight[]>([]);
  const seen = useRef(new Set<string>());
  const seenCatches = useRef(0);
  const seenWaves = useRef(0);
  const waves = useRef<{ dir: THREE.Vector3; source: number; at: number; reached: Set<number> }[]>([]);
  const waveMat = useRef<THREE.ShaderMaterial>(null!);
  const mounted = useMemo(() => performance.now(), []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const s = useMemo(() => new THREE.Vector3(), []);
  const color = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const now = performance.now();
    const st = useStore.getState();

    for (const a of st.arcs) {
      if (seen.current.has(a.id) || now - a.seenAt > 1500) continue;
      seen.current.add(a.id);
      const to = indexOf(a.merchant.name);
      if (to < 0) continue;
      const from = onGlobe(a.buyer.lat, a.buyer.lon);
      const f = flight(arcPoints(from, CITY[to], 48, 0.8), a.held || a.caseId ? HELD : PURCHASE, Math.max(a.seenAt, now - 200), 1500, { to, tail: 0.4 });
      group.current.add(f.line);
      flights.current.push(f);
    }
    if (seen.current.size > 600) seen.current = new Set([...seen.current].slice(-200));

    for (const c of st.catches.slice(seenCatches.current)) {
      const to = indexOf(c.merchant);
      const from = indexOf(c.source);
      if (to < 0 || c.at < mounted - 4000) continue;
      hitAt[to] = c.at;
      if (from >= 0 && from !== to) {
        const f = flight(arcPoints(CITY[from], CITY[to], 80, 1.25), KNOWLEDGE, c.at, 900, { tail: 1, hold: 1600 });
        group.current.add(f.line);
        flights.current.push(f);
      }
    }
    seenCatches.current = st.catches.length;

    for (const w of st.waves.slice(seenWaves.current)) {
      const source = indexOf(w.merchant);
      if (source < 0 || w.at < mounted - 4000) continue;
      shieldedAt[source] = w.at;
      waves.current.push({ dir: CITY_DIR[source], source, at: w.at, reached: new Set([source]) });
    }
    seenWaves.current = st.waves.length;

    // Each flight draws in, then fades; its landing lights the city.
    let n = 0;
    flights.current = flights.current.filter((f) => {
      const mat = f.line.material as THREE.ShaderMaterial;
      const k = (now - f.start) / f.ms;
      const after = now - f.start - f.ms - f.hold;
      if (k < 0) {
        mat.uniforms.uHead.value = 0;
        return true;
      }
      const head = Math.min(1, k);
      mat.uniforms.uHead.value = head;
      mat.uniforms.uFade.value = after > 0 ? Math.max(0, 1 - after / 500) : 1;
      if (k < 1 && n < 64) {
        const p = f.head[Math.min(f.head.length - 1, Math.round(head * (f.head.length - 1)))];
        m.compose(p, q, s.setScalar(f.to >= 0 ? 1 : 1.6));
        heads.current.setMatrixAt(n, m);
        heads.current.setColorAt(n, color.copy(mat.uniforms.uColor.value));
        n++;
      }
      if (k >= 1 && f.to >= 0 && arrivedAt[f.to] < f.start + f.ms) arrivedAt[f.to] = f.start + f.ms;
      if (after < 500) return true;
      group.current.remove(f.line);
      f.line.geometry.dispose();
      mat.dispose();
      return false;
    });
    heads.current.count = n;
    heads.current.instanceMatrix.needsUpdate = true;
    if (heads.current.instanceColor) heads.current.instanceColor.needsUpdate = true;

    // Waves go round the world; each city they pass raises its shield.
    waves.current = waves.current.filter((w) => (now - w.at) / 1000 * WAVE_SPEED < 3.4);
    const live = waves.current.slice(-MAX_WAVES);
    for (let k = 0; k < MAX_WAVES; k++) {
      const w = live[k];
      waveMat.current.uniforms.uAge.value[k] = w ? (now - w.at) / 1000 : 99;
      if (!w) continue;
      (waveMat.current.uniforms.uDir.value[k] as THREE.Vector3).copy(w.dir);
      const front = ((now - w.at) / 1000) * WAVE_SPEED;
      for (let i = 0; i < N; i++)
        if (!w.reached.has(i) && CITY_DIR[i].angleTo(w.dir) <= front) {
          w.reached.add(i);
          shieldedAt[i] = now;
        }
    }
  });

  return (
    <>
      <group ref={group} />
      <instancedMesh ref={heads} args={[undefined, undefined, 64]} frustumCulled={false}>
        <sphereGeometry args={[0.016, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh scale={1.004}>
        <sphereGeometry args={[R, 128, 128]} />
        <shaderMaterial ref={waveMat} args={[waveShader]} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </>
  );
}

// ───────────────────────── camera ─────────────────────────

const DISTANCE = 10.5;

// The planet turns slowly on its own. Clicking a city brings it to the front; when nobody is
// touching the controls, the camera also turns to wherever the network has just learned or
// stopped something, so the moment is never on the far side.
function Rig() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean; autoRotate: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void } | null;
  const focus = useStore((s) => s.focus);
  const touched = useRef(-1e9);
  const glide = useRef<{ from: THREE.Vector3; to: THREE.Vector3; start: number; ms: number } | null>(null);
  const seenCatches = useRef(useStore.getState().catches.length);
  const seenWaves = useRef(useStore.getState().waves.length);
  const lastTurn = useRef(-1e9);
  const intro = useRef<number | null>(null); // when the first frame was drawn: a hidden tab draws none

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const right = size.width >= 900 ? 362 : 0;
    cam.setViewOffset(size.width, size.height, right / 2, 0, size.width, size.height);
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  useEffect(() => {
    if (!controls) return;
    const take = () => {
      touched.current = performance.now();
      glide.current = null;
    };
    controls.addEventListener('start', take);
    return () => controls.removeEventListener('start', take);
  }, [controls]);

  const turnTo = (i: number, ms: number) => {
    const to = CITY_DIR[i].clone().multiplyScalar(camera.position.length());
    // Look a little from above, so the city sits below the middle of the screen with its label free.
    to.addScaledVector(UP, 0.9).setLength(camera.position.length());
    glide.current = { from: camera.position.clone(), to, start: performance.now(), ms };
  };

  useEffect(() => {
    if (focus) turnTo(indexOf(focus), 1100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useFrame(() => {
    const now = performance.now();
    const st = useStore.getState();
    // At most one turn every twelve seconds, and none to a city already in view.
    const idle = now - touched.current > 9000 && now - lastTurn.current > 12000 && !st.focus && !glide.current;
    const c = st.catches.length > seenCatches.current ? st.catches.at(-1) : undefined;
    const w = st.waves.length > seenWaves.current ? st.waves.at(-1) : undefined;
    const i = indexOf(c?.merchant ?? w?.merchant ?? '');
    if (idle && i >= 0 && camera.position.clone().normalize().dot(CITY_DIR[i]) < 0.55) {
      turnTo(i, 1400);
      lastTurn.current = now;
    }
    seenCatches.current = st.catches.length;
    seenWaves.current = st.waves.length;

    // The first seconds: the planet comes in from far away, and always ends at the same distance.
    intro.current ??= now;
    if (intro.current > 0) {
      const k = Math.min(1, (now - intro.current) / 3200);
      camera.position.setLength(DISTANCE * (1 + 0.7 * Math.pow(1 - k, 3)));
      if (k >= 1) intro.current = -1;
    }

    if (glide.current) {
      const g = glide.current;
      const t = Math.min(1, (now - g.start) / g.ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const len = camera.position.length();
      camera.position.copy(g.from).normalize().lerp(g.to.clone().normalize(), e).setLength(len);
      camera.lookAt(0, 0, 0);
      if (t >= 1) glide.current = null;
    }
    if (controls) controls.autoRotate = !glide.current && !st.focus && now - touched.current > 6000;
  });
  return null;
}

// ───────────────────────── labels ─────────────────────────

function CityLabels({ counts }: { counts: { open: number; caught: number }[] }) {
  const waves = useStore((s) => s.waves);
  const catches = useStore((s) => s.catches);
  const focus = useStore((s) => s.focus);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const now = performance.now();
  // The most recent note per city: a catch outranks something learned.
  const notes = new Map<number, { kind: 'caught' | 'learned'; text: string }>();
  for (const w of waves) if (now - w.at < 4500) notes.set(indexOf(w.merchant), { kind: 'learned', text: `Learned: ${w.label}` });
  for (const c of catches) if (now - c.at < 3500) notes.set(indexOf(c.merchant), { kind: 'caught', text: `Stopped on arrival · ${eur(c.total)}` });

  return (
    <LabelLayer>
      {MERCHANTS.map((m, i) => (
        <Label key={m.name} anchor={`city:${i}`} className={`net-name city ${SIDE[m.city] ?? 'below'} ${focus === m.name ? 'on' : ''}`}>
          <b>{m.name}</b>
          {/* the details only for the city turned to: in Europe the cities are too close for more than a name each */}
          {focus === m.name && (
            <span>
              {m.city}
              {counts[i].open > 0 ? ` · ${counts[i].open} open` : ''}
              {counts[i].caught > 0 ? ` · ${counts[i].caught} stopped by the network` : ''}
            </span>
          )}
        </Label>
      ))}
      {[...notes].map(([i, note]) => (
        <Label key={`${i}-${note.text}`} anchor={`city-top:${i}`} className={`net-note ${note.kind}`}>
          {note.text}
        </Label>
      ))}
    </LabelLayer>
  );
}

export function GlobeScene() {
  const cases = useStore((s) => s.cases);
  const signatures = useStore((s) => Object.keys(s.signatures).length);
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
  // Start over Europe, where most of the merchants are.
  const start = useMemo(() => onGlobe(38, 10, DISTANCE).addScaledVector(UP, 1.2).setLength(DISTANCE * 1.7), []);

  return (
    <>
      <Canvas camera={{ position: start.toArray(), fov: 32, near: 0.1, far: 200 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={[BG]} />
        <Rig />
        <Projector />
        <Stars />
        <Planet />
        {MERCHANTS.map((m, i) => (
          <City key={m.name} i={i} signatures={signatures} open={counts[i].open} />
        ))}
        <Traffic />
        <OrbitControls makeDefault enablePan={false} enableZoom minDistance={5.5} maxDistance={18} autoRotateSpeed={0.35} enableDamping dampingFactor={0.08} rotateSpeed={0.45} />
        <EffectComposer>
          <Bloom intensity={0.8} luminanceThreshold={0.3} luminanceSmoothing={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.3} darkness={0.75} />
        </EffectComposer>
      </Canvas>
      <CityLabels counts={counts} />
    </>
  );
}
