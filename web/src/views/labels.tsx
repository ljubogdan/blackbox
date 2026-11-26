import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from 'react';
import * as THREE from 'three';

// Text labels pinned to points in a 3D scene, drawn as ordinary DOM outside the
// canvas. Scene components register an anchor (a function giving a world
// position and whether it is currently visible); the Projector turns anchors
// into pixel positions every frame; the LabelLayer moves the DOM to match.

export type AnchorFn = (out: THREE.Vector3) => boolean;

const registry = new Map<string, AnchorFn>();
const screen = new Map<string, { x: number; y: number; on: boolean }>();

export function useAnchor(id: string, fn: AnchorFn) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    registry.set(id, (out) => latest.current(out));
    return () => {
      registry.delete(id);
      screen.delete(id);
    };
  }, [id]);
}

// Goes inside the <Canvas>.
export function Projector() {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (const [id, fn] of registry) {
      const on = fn(v);
      v.project(camera);
      const s = screen.get(id) ?? { x: 0, y: 0, on: false };
      s.x = (v.x * 0.5 + 0.5) * size.width;
      s.y = (-v.y * 0.5 + 0.5) * size.height;
      s.on = on && v.z < 1;
      screen.set(id, s);
    }
  });
  return null;
}

// Goes next to the <Canvas>, covering it.
export function LabelLayer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      for (const el of ref.current?.querySelectorAll<HTMLElement>('[data-anchor]') ?? []) {
        const s = screen.get(el.dataset.anchor!);
        el.style.transform = s ? `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)` : '';
        el.style.opacity = s?.on ? '1' : '0';
        el.style.pointerEvents = s?.on ? '' : 'none';
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="labels" ref={ref}>
      {children}
    </div>
  );
}

export function Label({ anchor, children, ...rest }: { anchor: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="label" data-anchor={anchor} style={{ opacity: 0 }}>
      <div {...rest}>{children}</div>
    </div>
  );
}
