import * as THREE from 'three';
import { clamp } from '../core/units';
import type { Vec3 } from '../core/vec';

/**
 * Caméra multi-échelle à double précision.
 * Le rendu se fait « relatif à la caméra » : la caméra three.js reste à l'origine et
 * chaque vue place ses objets à (position − œil). L'œil est stocké en float64.
 *
 * Modes : orbite (autour d'une cible), libre (vol ZQSD/WASD), suivi (cible mobile),
 * cinématique (orbite automatique lente avec dérive du zoom).
 */
export type CameraMode = 'orbit' | 'free' | 'follow' | 'cinematic';

export const CAMERA_MODE_LABEL: Record<CameraMode, string> = {
  orbit: 'Orbitale', free: 'Libre', follow: 'Suivi', cinematic: 'Cinématique',
};

interface Flight {
  from: Vec3; to: Vec3; dFrom: number; dTo: number; t: number; duration: number;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'orbit';
  /** Cible (unités de la vue, float64). */
  target: Vec3 = { x: 0, y: 0, z: 0 };
  distance = 10;
  yaw = 0.6;
  pitch = 0.35;
  minDistance = 1e-6;
  maxDistance = 1e12;
  /** Position de l'œil (float64). */
  eye: Vec3 = { x: 0, y: 0, z: 0 };
  /** Vitesse du mode libre (fraction de la distance par seconde). */
  freeSpeed = 0.6;
  private freePos: Vec3 = { x: 0, y: 0, z: 0 };
  private flight: Flight | null = null;
  private keys = new Set<string>();
  /** Appelé quand l'utilisateur zoome au-delà des bornes (transition d'échelle). */
  onZoomLimit: ((dir: 'in' | 'out') => void) | null = null;
  /** Fonction donnant la position courante d'une cible suivie. */
  followFn: (() => Vec3 | null) | null = null;
  private dom: HTMLElement | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private dragButton = -1;
  private velYaw = 0;
  private velPitch = 0;
  enabled = true;
  /** Intensité de « tremblement » (effets cinématiques). */
  shake = 0;
  /** Unités de rendu par unité de la caméra (ex. Mm par UA). */
  renderScale = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 1e-6, 1e15);
    this.camera.position.set(0, 0, 0);
  }

  attach(dom: HTMLElement): void {
    this.dom = dom;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Vrai si le dernier relâchement de pointeur était un simple clic (pas un glissé). */
  clickCandidate = false;
  private downPos = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragButton = e.button;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.clickCandidate = true;
    this.dom?.setPointerCapture?.(e.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 5) this.clickCandidate = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinch > 0) this.zoom(Math.pow(this.lastPinch / d, 1.5));
      this.lastPinch = d;
      return;
    }
    if (this.dragButton === 2 || e.shiftKey) this.pan(dx, dy);
    else this.rotate(dx, dy);
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;
    this.zoom(Math.exp(e.deltaY * k));
  };

  rotate(dx: number, dy: number): void {
    this.velYaw = -dx * 0.005;
    this.velPitch = dy * 0.005;
    this.yaw += this.velYaw;
    this.pitch = clamp(this.pitch + this.velPitch, -1.55, 1.55);
    if (this.mode === 'cinematic') this.mode = 'orbit';
  }

  pan(dx: number, dy: number): void {
    if (this.mode === 'follow') this.mode = 'orbit';
    const right = this.right(), up = this.up();
    const s = (this.distance * 0.0015);
    this.target.x += (-right.x * dx + up.x * dy) * s;
    this.target.y += (-right.y * dx + up.y * dy) * s;
    this.target.z += (-right.z * dx + up.z * dy) * s;
    this.flight = null;
  }

  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const nd = this.distance * factor;
    if (nd < this.minDistance) {
      this.distance = this.minDistance;
      if (factor < 1) this.onZoomLimit?.('in');
      return;
    }
    if (nd > this.maxDistance) {
      this.distance = this.maxDistance;
      if (factor > 1) this.onZoomLimit?.('out');
      return;
    }
    this.distance = nd;
    if (this.flight) this.flight.dTo = this.distance;
  }

  /** Direction de visée (de l'œil vers la cible). */
  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: -Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  right(): Vec3 {
    return { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
  }

  up(): Vec3 {
    const f = this.forward(), r = this.right();
    return { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  }

  /** Vol progressif vers une cible (interpolation logarithmique de la distance). */
  flyTo(target: Vec3, distance: number, duration = 1.6): void {
    this.flight = { from: { ...this.target }, to: { ...target }, dFrom: this.distance, dTo: clamp(distance, this.minDistance, this.maxDistance), t: 0, duration };
    if (this.mode === 'free') this.mode = 'orbit';
  }

  isFlying(): boolean {
    return this.flight !== null;
  }

  set(target: Vec3, distance: number): void {
    this.target = { ...target };
    this.distance = clamp(distance, this.minDistance, this.maxDistance);
    this.flight = null;
  }

  update(dt: number): void {
    // vol programmé
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.duration;
      const t = clamp(f.t, 0, 1);
      const s = t * t * (3 - 2 * t);
      const live = this.followFn?.();
      const to = live ?? f.to;
      this.target = { x: f.from.x + (to.x - f.from.x) * s, y: f.from.y + (to.y - f.from.y) * s, z: f.from.z + (to.z - f.from.z) * s };
      this.distance = Math.exp(Math.log(f.dFrom) + (Math.log(f.dTo) - Math.log(f.dFrom)) * s);
      if (t >= 1) this.flight = null;
    } else if ((this.mode === 'follow' || this.mode === 'cinematic') && this.followFn) {
      const p = this.followFn();
      if (p) this.target = { ...p };
    }
    if (this.mode === 'cinematic') {
      this.yaw += dt * 0.06;
      this.pitch = 0.25 + 0.15 * Math.sin(performance.now() * 0.00007);
    } else if (this.pointers.size === 0) {
      // inertie
      this.velYaw *= 0.9; this.velPitch *= 0.9;
    }
    if (this.mode === 'free') {
      const f = this.forward(), r = this.right();
      const sp = this.distance * this.freeSpeed * dt * (this.keys.has('shift') ? 4 : 1);
      let mx = 0, mz = 0, my = 0;
      if (this.keys.has('w') || this.keys.has('z') || this.keys.has('arrowup')) mz += 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
      if (this.keys.has('a') || this.keys.has('q') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      if (this.keys.has('e') || this.keys.has(' ')) my += 1;
      if (this.keys.has('c')) my -= 1;
      this.target.x += (f.x * mz + r.x * mx) * sp;
      this.target.y += (f.y * mz + r.y * mx) * sp + my * sp;
      this.target.z += (f.z * mz + r.z * mx) * sp;
    }
    const fwd = this.forward();
    this.eye = { x: this.target.x - fwd.x * this.distance, y: this.target.y - fwd.y * this.distance, z: this.target.z - fwd.z * this.distance };
    // orientation de la caméra three.js (position fixe à l'origine)
    const look = new THREE.Vector3(fwd.x, fwd.y, fwd.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    if (this.shake > 0) {
      this.camera.rotation.x += (Math.random() - 0.5) * this.shake * 0.01;
      this.camera.rotation.y += (Math.random() - 0.5) * this.shake * 0.01;
      this.shake = Math.max(0, this.shake - dt * 2);
    }
    this.camera.near = Math.max(1e-9, this.distance * this.renderScale * 2e-6);
    this.camera.far = this.distance * this.renderScale * 1e8 + 1e3;
    this.camera.updateProjectionMatrix();
    void this.freePos;
  }

  /** Coordonnées « relatives à l'œil » (float64 → float32 sûr). */
  rel(p: Vec3, scale = 1): THREE.Vector3 {
    return new THREE.Vector3((p.x - this.eye.x) * scale, (p.y - this.eye.y) * scale, (p.z - this.eye.z) * scale);
  }

  setRel(o: THREE.Object3D, p: Vec3, scale = 1): void {
    o.position.set((p.x - this.eye.x) * scale, (p.y - this.eye.y) * scale, (p.z - this.eye.z) * scale);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Taille apparente (pixels) d'un objet de rayon r à la distance d. */
  pixelSize(radius: number, dist: number, viewportH: number): number {
    const f = viewportH / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    return (radius / Math.max(dist, 1e-30)) * f;
  }
}
