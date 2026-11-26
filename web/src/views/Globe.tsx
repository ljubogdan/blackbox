import { OrbitControls, Stars } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { CaseFile } from '../../../shared/types';
import land from '../assets/land.json';
import { caseList, eur, PARTY_COLOR, STATUS_LABEL, topParty, useStore, type Arc } from '../store';
import { Label, LabelLayer, Projector, useAnchor } from './labels';

const R = 2;

function toVec(lat: number, lon: number, r = R): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

function LandDots() {
  const geometry = useMemo(() => {
    const dots = land as number[];
    const positions = new Float32Array((dots.length / 2) * 3);
    for (let i = 0; i < dots.length; i += 2) toVec(dots[i], dots[i + 1], R * 1.002).toArray(positions, (i / 2) * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, []);
  return (
    <points geometry={geometry}>
      <pointsMaterial size={0.024} color="#7f9be0" sizeAttenuation transparent opacity={0.95} depthWrite={false} />
    </points>
  );
}

const atmosphere = {
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vNormal;
    void main() {
      float rim = pow(max(0.62 - dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
      gl_FragColor = vec4(0.22, 0.46, 1.0, 1.0) * rim * 0.85;
    }`,
};

// The surface: nearly black face-on, lifting to deep blue at the edge, so the globe reads as a ball.
const surface = {
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
      float rim = pow(clamp(1.0 - dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.6);
      gl_FragColor = vec4(mix(vec3(0.020, 0.030, 0.062), vec3(0.07, 0.17, 0.42), rim), 1.0);
    }`,
};

function Graticule() {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const push = (lat: number, lon: number) => pts.push(...toVec(lat, lon, R * 1.001).toArray());
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 4) (push(lat, lon), push(lat, lon + 4));
    for (let lon = -180; lon < 180; lon += 30) for (let lat = -80; lat < 80; lat += 4) (push(lat, lon), push(lat + 4, lon));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#6f8fd0" transparent opacity={0.07} depthWrite={false} />
    </lineSegments>
  );
}

const arcShader = {
  vertexShader: /* glsl */ `
    attribute float aT;
    varying float vT;
    void main() {
      vT = aT;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uHead;
    uniform float uLife;
    uniform vec3 uColor;
    varying float vT;
    void main() {
      if (vT > uHead) discard;
      float trail = exp(-(uHead - vT) * 4.0);
      gl_FragColor = vec4(uColor * (0.55 + 1.9 * trail), (0.16 + 0.84 * trail) * uLife);
    }`,
};

const SEGMENTS = 72;
const ARC_COLOR = new THREE.Color('#6aa6ff');
const DISPUTE_COLOR = new THREE.Color('#ffb547');

const HOLD_AT = 0.56; // how far along its arc a held payment is stopped
const HELD_COLOR = new THREE.Color('#ffffff');
const BLOCK_COLOR = new THREE.Color('#ff5a4d');
const RELEASE_COLOR = new THREE.Color('#7cf5d0');

interface LiveArc {
  line: THREE.Line;
  material: THREE.ShaderMaterial;
  born: number;
  travel: number;
  disputed: boolean;
  landed: boolean;
  end: THREE.Vector3;
  caseId?: string;
  held: boolean;
  stop?: THREE.Mesh; // the ring where a held payment hangs
  comet: THREE.Mesh; // the bright head of the arc
  resolvedAt?: number;
  points: Float32Array;
}

interface Ripple {
  mesh: THREE.Mesh;
  born: number;
}

// Purchases flying buyer -> merchant. Managed imperatively: there can be dozens
// alive at once and none of them needs React state.
function Arcs() {
  const group = useRef<THREE.Group>(null!);
  const live = useRef(new Map<string, LiveArc>());
  const ripples = useRef<Ripple[]>([]);
  const ringGeometry = useMemo(() => new THREE.RingGeometry(0.035, 0.05, 40), []);
  const cometGeometry = useMemo(() => new THREE.SphereGeometry(0.017, 10, 10), []);

  useFrame(() => {
    const now = performance.now();
    const arcs = useStore.getState().arcs;
    const cases = useStore.getState().cases;

    for (const a of arcs) {
      if (live.current.has(a.id) || now - a.seenAt > 9000) continue;
      live.current.set(a.id, spawn(a));
    }

    for (const [id, arc] of live.current) {
      const age = (now - arc.born) / 1000;
      const c = arc.caseId ? cases[arc.caseId] : undefined;
      let head = Math.min(1, age / arc.travel);
      let fade: number;

      if (arc.held) {
        // A held payment stops in mid-air until the team decides.
        const decided = !!c?.closedAt;
        if (decided && arc.resolvedAt === undefined) arc.resolvedAt = now;
        const since = arc.resolvedAt === undefined ? 0 : (now - arc.resolvedAt) / 1000;
        const released = decided && c!.status === 'released';
        head = released ? Math.min(1, HOLD_AT + since / arc.travel) : Math.min(HOLD_AT, head);
        arc.material.uniforms.uColor.value = !decided ? HELD_COLOR : released ? RELEASE_COLOR : BLOCK_COLOR;
        fade = !decided ? 1 : Math.max(0, 1 - Math.max(0, since - (released ? arc.travel * (1 - HOLD_AT) : 0.4)) / 1.6);
        if (arc.stop) {
          const i = Math.round(HOLD_AT * SEGMENTS) * 3;
          arc.stop.position.set(arc.points[i], arc.points[i + 1], arc.points[i + 2]);
          arc.stop.visible = head >= HOLD_AT - 0.01 && (!decided || !released);
          const beat = (now / 700) % 1;
          arc.stop.scale.setScalar(decided ? 1 + since * 2.2 : 0.8 + beat * 1.1);
          const m = arc.stop.material as THREE.MeshBasicMaterial;
          m.color.copy(decided ? BLOCK_COLOR : HELD_COLOR);
          m.opacity = decided ? Math.max(0, 1 - since / 1.2) : 1 - beat * 0.7;
        }
      } else {
        // A disputed purchase stays lit while its case is open.
        const stillOpen = arc.disputed && !!c && !c.closedAt;
        fade = stillOpen ? 0.75 : Math.max(0, 1 - Math.max(0, age - arc.travel) / (arc.disputed ? 2.5 : 1.3));
      }

      arc.material.uniforms.uHead.value = head;
      const at = Math.min(SEGMENTS, Math.round(head * SEGMENTS)) * 3;
      arc.comet.position.set(arc.points[at], arc.points[at + 1], arc.points[at + 2]);
      arc.comet.visible = head < 1 && fade > 0.05 && !(arc.held && head >= HOLD_AT - 0.01 && !c?.closedAt);
      (arc.comet.material as THREE.MeshBasicMaterial).color.copy(arc.material.uniforms.uColor.value as THREE.Color);
      if (head >= 1 && !arc.landed) {
        arc.landed = true;
        const mesh = new THREE.Mesh(
          ringGeometry,
          new THREE.MeshBasicMaterial({ color: arc.held ? RELEASE_COLOR : arc.disputed ? DISPUTE_COLOR : ARC_COLOR, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        mesh.position.copy(arc.end).multiplyScalar(1.004);
        mesh.lookAt(arc.end.clone().multiplyScalar(2));
        group.current.add(mesh);
        ripples.current.push({ mesh, born: now });
      }
      arc.material.uniforms.uLife.value = fade;
      if (fade <= 0) {
        group.current.remove(arc.line);
        group.current.remove(arc.comet);
        (arc.comet.material as THREE.Material).dispose();
        if (arc.stop) {
          group.current.remove(arc.stop);
          (arc.stop.material as THREE.Material).dispose();
        }
        arc.line.geometry.dispose();
        arc.material.dispose();
        live.current.delete(id);
      }
    }

    ripples.current = ripples.current.filter((r) => {
      const t = (now - r.born) / 900;
      if (t >= 1) {
        group.current.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        return false;
      }
      r.mesh.scale.setScalar(1 + t * 3.2);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      return true;
    });
  });

  function spawn(a: Arc): LiveArc {
    const from = toVec(a.buyer.lat, a.buyer.lon, 1).normalize();
    const to = toVec(a.merchant.lat, a.merchant.lon, 1).normalize();
    const angle = Math.max(0.02, from.angleTo(to));
    const lift = 0.1 + 0.42 * (angle / Math.PI);
    const positions = new Float32Array((SEGMENTS + 1) * 3);
    const ts = new Float32Array(SEGMENTS + 1);
    const sin = Math.sin(angle);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      // spherical interpolation, lifted off the surface in the middle
      const p = from
        .clone()
        .multiplyScalar(Math.sin((1 - t) * angle) / sin)
        .add(to.clone().multiplyScalar(Math.sin(t * angle) / sin))
        .multiplyScalar(R * (1.006 + lift * Math.sin(Math.PI * t)));
      p.toArray(positions, i * 3);
      ts[i] = t;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
    const held = !!a.held;
    const disputed = !!a.caseId && !held;
    const material = new THREE.ShaderMaterial({
      ...arcShader,
      uniforms: { uHead: { value: 0 }, uLife: { value: 1 }, uColor: { value: held ? HELD_COLOR : disputed ? DISPUTE_COLOR : ARC_COLOR } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geometry, material);
    group.current.add(line);
    const comet = new THREE.Mesh(cometGeometry, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    group.current.add(comet);
    let stop: THREE.Mesh | undefined;
    if (held) {
      stop = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 16, 16),
        new THREE.MeshBasicMaterial({ color: HELD_COLOR, transparent: true, depthWrite: false, toneMapped: false }),
      );
      stop.visible = false;
      group.current.add(stop);
    }
    return { line, material, born: a.seenAt, travel: 1.1 + angle * 0.55, disputed, landed: false, end: to.clone().multiplyScalar(R), caseId: a.caseId, held, stop, comet, points: positions };
  }

  return <group ref={group} />;
}

function markerColor(c: CaseFile): string {
  if (c.status === 'blocked') return '#ff5a4d';
  if (c.status === 'released') return '#7cf5d0';
  if (c.stage === 'hold' && !c.closedAt) return '#ffffff';
  if (c.status === 'ruled' && c.arbiter.ruling) return PARTY_COLOR[topParty(c.arbiter.ruling.split)];
  if (c.status === 'awaiting_approval') return '#ffffff';
  if (c.status === 'manual_review' || c.status === 'failed') return '#8b93a7';
  return '#ffb547';
}

// A disputed purchase, pinned where the buyer is. Click to open the case.
function CaseMarker({ c }: { c: CaseFile }) {
  const open = useStore((s) => s.open);
  const position = useMemo(() => toVec(c.purchase.buyer.lat, c.purchase.buyer.lon, R * 1.012), [c.purchase.buyer]);
  const normal = useMemo(() => position.clone().normalize(), [position]);
  const group = useRef<THREE.Group>(null!);
  const ring = useRef<THREE.Mesh>(null!);
  const { camera } = useThree();
  const active = !c.closedAt;
  const color = markerColor(c);
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal), [normal]);
  const world = useMemo(() => new THREE.Vector3(), []);
  // The tag is hidden while the marker is on the far side of the globe.
  useAnchor(`case:${c.id}`, (out) => {
    group.current?.getWorldPosition(out);
    return world.copy(out).normalize().dot(camera.position.clone().normalize()) > 0.15;
  });

  useFrame(({ clock }) => {
    const pulse = active ? (clock.elapsedTime * 0.9 + Math.abs(position.x)) % 1 : 0.35;
    ring.current.scale.setScalar(1 + pulse * 2.4);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = active ? 1 - pulse : 0.5;
  });

  return (
    <group ref={group} position={position} quaternion={quaternion}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          open(c.id);
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <circleGeometry args={[0.085, 24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.03, 24]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh ref={ring}>
        <ringGeometry args={[0.04, 0.05, 40]} />
        <meshBasicMaterial color={color} transparent depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

const shownCases = (cases: Record<string, CaseFile>) => caseList(cases).slice(0, 14);

function Markers() {
  const cases = useStore((s) => s.cases);
  const shown = useMemo(() => shownCases(cases), [cases]);
  return (
    <>
      {shown.map((c) => (
        <CaseMarker key={c.id} c={c} />
      ))}
    </>
  );
}

// Size the globe to the free space between the headline and the dispute list.
function FitGlobe() {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const free = Math.max(320, Math.min(size.height - 220, size.width - 700));
    const distance = (R * size.height) / (free * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    cam.position.setLength(distance);
  }, [camera, size.width, size.height]);
  return null;
}

function GlobeLabels() {
  const cases = useStore((s) => s.cases);
  const open = useStore((s) => s.open);
  return (
    <LabelLayer>
      {shownCases(cases)
        .filter((c) => !c.closedAt)
        .map((c) => (
          <Label key={c.id} anchor={`case:${c.id}`} className="globe-tag" style={{ borderColor: markerColor(c) }} onClick={() => open(c.id)} title={STATUS_LABEL[c.status]}>
            {c.stage === 'hold' && <b>HELD</b>}
            <span className="mono">{c.id}</span>
            <span>{eur(c.purchase.total)}</span>
          </Label>
        ))}
    </LabelLayer>
  );
}

export function GlobeScene() {
  return (
    <>
      <Canvas camera={{ position: [0, 2.3, 8.4], fov: 36 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={['#04060c']} />
        <FitGlobe />
        <Projector />
        <Stars radius={60} depth={30} count={1400} factor={2.2} saturation={0} fade speed={0.4} />
        <group rotation={[0.12, 0, 0]}>
          <mesh>
            <sphereGeometry args={[R, 64, 64]} />
            <shaderMaterial args={[surface]} />
          </mesh>
          <Graticule />
          <mesh scale={1.1}>
            <sphereGeometry args={[R, 64, 64]} />
            <shaderMaterial args={[atmosphere]} side={THREE.BackSide} blending={THREE.AdditiveBlending} transparent depthWrite={false} />
          </mesh>
          <LandDots />
          <Arcs />
          <Markers />
        </group>
        <OrbitControls enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={0.32} minPolarAngle={0.9} maxPolarAngle={2.0} rotateSpeed={0.5} />
        <EffectComposer>
          <Bloom intensity={1.05} luminanceThreshold={0.18} luminanceSmoothing={0.6} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <GlobeLabels />
    </>
  );
}
