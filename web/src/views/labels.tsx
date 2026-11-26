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

// For objects managed outside React (the live view creates and removes them every frame).
export function setAnchor(id: string, fn: AnchorFn | null) {
  if (fn) registry.set(id, fn);
  else {
    registry.delete(id);
    screen.delete(id);
  }
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
  // A label sits on top of the canvas, so a drag that starts on one would not
  // rotate the scene. Once the pointer has moved a little, hand the gesture to
  // the canvas; a press without movement stays a click on the label.
  const onPointerDown = (down: React.PointerEvent) => {
    const { pointerId, pointerType, clientX, clientY, button } = down;
    if (button !== 0) return;
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || Math.hypot(e.clientX - clientX, e.clientY - clientY) < 4) return;
      stop();
      const canvas = ref.current?.parentElement?.querySelector('canvas');
      canvas?.dispatchEvent(new PointerEvent('pointerdown', { pointerId, pointerType, clientX, clientY, button: 0, buttons: 1, isPrimary: true, bubbles: true }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <div className="labels" ref={ref} onPointerDown={onPointerDown}>
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
