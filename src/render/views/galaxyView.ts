import * as THREE from 'three';
import { clamp } from '../../core/units';
import { blackbodyRGB } from '../../core/color';
import type { Vec3 } from '../../core/vec';
import type { GalaxySim, GalaxyParams } from '../../sim/galaxy';
import { Sky } from '../objects/sky';
import { glowTexture, ringTexture } from '../objects/common';
import { createHaloMaterial } from '../objects/stellarMesh';
import { LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from '../objects/common';
import type { View, PickResult } from './view';
import type { Game } from '../../game';

const STAR_VERT = /* glsl */ `
${LOGDEPTH_VERT_HEAD}
attribute vec3 color; attribute float size;
uniform float pixelRatio; uniform float scale;
varying vec3 vCol; varying float vA;
void main() {
  vCol = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 1e-6);
  float s = size * scale / d;
  vA = clamp(s, 0.15, 1.0);
  gl_PointSize = clamp(s, 1.2, 9.0) * pixelRatio;
  ${LOGDEPTH_VERT_MAIN}
}`;

const STAR_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_HEAD}
uniform float dark;
varying vec3 vCol; varying float vA;
void main() {
  ${LOGDEPTH_FRAG_MAIN}
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  if (dark > 0.5) gl_FragColor = vec4(vCol, a * 0.5 * vA);
  else gl_FragColor = vec4(vCol * a * a * vA, 1.0);
}`;

/** Vue galactique : unités = kal (1000 années-lumière). */
export class GalaxyView implements View {
  readonly scene = new THREE.Scene();
  readonly level = 'galaxy' as const;
  readonly renderScale = 1;
  sim: GalaxySim | null = null;
  params: GalaxyParams | null = null;
  private stars: THREE.Points | null = null;
  private dust: THREE.Points | null = null;
  private dustIdx: Uint32Array = new Uint32Array(0);
  private colors = new Float32Array(0);
  private builtN = 0;
  private builtVersion = -1;
  private bulges: THREE.Sprite[] = [];
  private halos: THREE.Mesh[] = [];
  private sel: THREE.Sprite;
  private solMarker: THREE.Sprite;
  private sky: Sky;
  private hii: THREE.Points | null = null;

  constructor(private game: Game) {
    this.sky = new Sky(777, 4000);
    this.sky.bandVisible = false;
    this.sky.intensity = 0.4;
    this.scene.add(this.sky.group);
    this.sel = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, transparent: true }));
    this.sel.renderOrder = 20;
    this.scene.add(this.sel);
    this.solMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: 0xffd060, depthTest: false, transparent: true }));
    this.solMarker.renderOrder = 19;
    this.scene.add(this.solMarker);
  }

  setGalaxy(sim: GalaxySim, params: GalaxyParams): void {
    this.sim = sim;
    this.params = params;
    this.rebuild();
  }

  /** (Re)construit les géométries quand le nombre d'étoiles change (ex. fusion). */
  private rebuild(): void {
    const sim = this.sim!;
    for (const o of [this.stars, this.dust, this.hii]) if (o) { this.scene.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    for (const b of this.bulges) this.scene.remove(b);
    for (const h of this.halos) { this.scene.remove(h); h.geometry.dispose(); }
    this.bulges = [];
    this.halos = [];
    const n = sim.n;
    this.colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const age = sim.age[i];
      const m = sim.starMass[i];
      const T = age < 0.25 ? 9000 + 15000 * (1 - age * 4) : 3500 + 3000 * (1 - age) + m * 800;
      const [r, g, b] = blackbodyRGB(T);
      const br = age < 0.25 ? 1.6 : 0.6 + 0.3 * Math.random();
      this.colors[i * 3] = r * br; this.colors[i * 3 + 1] = g * br; this.colors[i * 3 + 2] = b * br;
      sizes[i] = age < 0.25 ? 2.2 : 1.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sim.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setDrawRange(0, n);
    const mat = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: 1 }, scale: { value: 4 }, dark: { value: 0 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
    // bandes de poussière : sous-ensemble d'étoiles jeunes proches du plan, rendues absorbantes
    const idx: number[] = [];
    const hii: number[] = [];
    for (let i = 0; i < n; i++) {
      if (sim.age[i] < 0.35 && Math.random() < 0.6) idx.push(i);
      if (sim.age[i] < 0.08 && Math.random() < 0.08) hii.push(i);
    }
    this.dustIdx = Uint32Array.from(idx);
    const dpos = new Float32Array(idx.length * 3);
    const dcol = new Float32Array(idx.length * 3).fill(0.0);
    for (let k = 0; k < idx.length; k++) { dcol[k * 3] = 0.05; dcol[k * 3 + 1] = 0.035; dcol[k * 3 + 2] = 0.03; }
    const dsize = new Float32Array(idx.length).fill(6);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
    dg.setAttribute('size', new THREE.BufferAttribute(dsize, 1));
    const dm = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: 1 }, scale: { value: 14 }, dark: { value: 1 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      blending: THREE.NormalBlending, transparent: true, depthWrite: false,
    });
    this.dust = new THREE.Points(dg, dm);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 1;
    this.scene.add(this.dust);
    // régions HII (nébuleuses d'émission roses autour des étoiles très jeunes)
    const hpos = new Float32Array(hii.length * 3);
    const hcol = new Float32Array(hii.length * 3);
    for (let k = 0; k < hii.length; k++) { hcol[k * 3] = 0.9; hcol[k * 3 + 1] = 0.25; hcol[k * 3 + 2] = 0.45; }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(hpos, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute('color', new THREE.BufferAttribute(hcol, 3));
    hg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(hii.length).fill(5), 1));
    this.hii = new THREE.Points(hg, new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: 1 }, scale: { value: 10 }, dark: { value: 0 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    (this.hii.userData as { idx: number[] }).idx = hii;
    this.hii.frustumCulled = false;
    this.scene.add(this.hii);
    for (const c of sim.components) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: c.params.type === 'elliptical' ? 0xffd8a8 : 0xffe0b0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
      this.bulges.push(s);
      this.scene.add(s);
      const h = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), createHaloMaterial());
      this.halos.push(h);
      this.scene.add(h);
    }
    this.builtN = n;
    this.builtVersion = sim.version;
  }

  enter(): void {
    const rig = this.game.engine.rig;
    rig.minDistance = 0.0025;
    rig.maxDistance = (this.params?.radius ?? 50) * 14;
  }

  exit(): void {
    this.game.labels.clear();
  }

  starPosition(i: number): Vec3 {
    const s = this.sim;
    if (!s || i < 0 || i >= s.n) return { x: 0, y: 0, z: 0 };
    return { x: s.pos[i * 3], y: s.pos[i * 3 + 1], z: s.pos[i * 3 + 2] };
  }

  update(_dt: number): void {
    const sim = this.sim;
    if (!sim || !this.stars) return;
    if (sim.n !== this.builtN) this.rebuild();
    const game = this.game;
    const rig = game.engine.rig;
    rig.maxDistance = (this.params?.radius ?? 50) * 14 * Math.max(1, sim.components.length);
    const eye = rig.eye;
    const pr = game.engine.renderer.getPixelRatio();
    for (const o of [this.stars, this.dust!, this.hii!]) {
      o.position.set(-eye.x, -eye.y, -eye.z);
      (o.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = pr;
    }
    if (sim.version !== this.builtVersion) {
      (this.stars.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      const dp = this.dust!.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < this.dustIdx.length; k++) {
        const i = this.dustIdx[k];
        dp.array[k * 3] = sim.pos[i * 3]; dp.array[k * 3 + 1] = sim.pos[i * 3 + 1]; dp.array[k * 3 + 2] = sim.pos[i * 3 + 2];
      }
      dp.needsUpdate = true;
      const hp = this.hii!.geometry.attributes.position as THREE.BufferAttribute;
      const hidx = (this.hii!.userData as { idx: number[] }).idx;
      for (let k = 0; k < hidx.length; k++) {
        const i = hidx[k];
        hp.array[k * 3] = sim.pos[i * 3]; hp.array[k * 3 + 1] = sim.pos[i * 3 + 1]; hp.array[k * 3 + 2] = sim.pos[i * 3 + 2];
      }
      hp.needsUpdate = true;
      this.builtVersion = sim.version;
    }
    // bulbes et halos
    sim.components.forEach((c, k) => {
      const b = this.bulges[k];
      b.position.set(c.center.x - eye.x, c.center.y - eye.y, c.center.z - eye.z);
      const R = c.params.type === 'elliptical' ? c.aBulge * 6 : c.aBulge * 10 + c.params.radius * 0.15;
      b.scale.setScalar(R);
      const h = this.halos[k];
      h.visible = game.analysis && c.haloOn;
      h.position.copy(b.position);
      h.scale.setScalar(c.rsHalo * 4);
    });
    // marqueurs
    const selIdx = game.selectionId?.startsWith('s') ? Number(game.selectionId.slice(1)) : -1;
    const H = game.engine.height;
    const pf = H / (2 * Math.tan((rig.camera.fov * Math.PI) / 360));
    const setMarker = (spr: THREE.Sprite, idx: number, px: number) => {
      if (idx < 0 || idx >= sim.n) { spr.visible = false; return; }
      spr.visible = true;
      const p = this.starPosition(idx);
      spr.position.set(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      const d = spr.position.length();
      spr.scale.setScalar((px * d) / pf);
    };
    setMarker(this.sel, selIdx, 30);
    const isHome = this.params?.id === 'home';
    setMarker(this.solMarker, isHome ? game.solIndex : -1, 22);
    game.labels.begin();
    if (isHome) this.label('s' + game.solIndex, 'Soleil (vous êtes ici)', game.solIndex, 'k-sol');
    if (selIdx >= 0 && selIdx !== game.solIndex) this.label('s' + selIdx, `Étoile #${selIdx}`, selIdx, 'sel');
    sim.components.forEach((c, k) => {
      const s = game.engine.toScreen(this.bulges[k].position);
      if (s.visible) game.labels.add(`c${k}`, c.params.name, s.x * game.engine.width, s.y * game.engine.height + 18, 'k-galaxy');
    });
    game.labels.end();
    this.sky.setPixelRatio(pr);
  }

  private label(id: string, text: string, idx: number, cls: string): void {
    const p = this.starPosition(idx);
    const eye = this.game.engine.rig.eye;
    const s = this.game.engine.toScreen(new THREE.Vector3(p.x - eye.x, p.y - eye.y, p.z - eye.z));
    if (s.visible) this.game.labels.add(id, text, s.x * this.game.engine.width, s.y * this.game.engine.height, cls);
  }

  pick(px: number, py: number): PickResult | null {
    const sim = this.sim;
    if (!sim) return null;
    const rig = this.game.engine.rig;
    const cam = rig.camera;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = m.elements;
    const W = this.game.engine.width, H = this.game.engine.height;
    const eye = rig.eye;
    let best = -1, bestScore = Infinity;
    const v = new THREE.Vector4();
    for (let i = 0; i < sim.n; i++) {
      v.set(sim.pos[i * 3] - eye.x, sim.pos[i * 3 + 1] - eye.y, sim.pos[i * 3 + 2] - eye.z, 1);
      const w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
      if (w <= 0) continue;
      const sx = ((e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) / w + 1) / 2 * W;
      const sy = (1 - (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) / w) / 2 * H;
      const d = Math.hypot(sx - px, sy - py);
      if (d > 9) continue;
      const score = d + w * 0.001 - (sim.age[i] < 0.25 ? 2 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) return { kind: 'star', id: `s${best}`, label: best === this.game.solIndex && this.params?.id === 'home' ? 'Soleil' : `Étoile #${best}` };
    // composantes galactiques (centres)
    for (let k = 0; k < sim.components.length; k++) {
      const s = this.game.engine.toScreen(this.bulges[k]?.position ?? new THREE.Vector3());
      if (s.visible && Math.hypot(s.x * W - px, s.y * H - py) < 30) return { kind: 'galaxy', id: `c${k}`, label: sim.components[k].params.name };
    }
    return null;
  }

  positionOf(id: string): Vec3 | null {
    if (id.startsWith('s')) return this.starPosition(Number(id.slice(1)));
    if (id.startsWith('c') && this.sim) {
      const c = this.sim.components[Number(id.slice(1))];
      return c ? { ...c.center } : null;
    }
    return null;
  }

  framingDistance(id: string): number {
    if (id.startsWith('s')) return 0.4;
    return (this.params?.radius ?? 40) * 3;
  }

  /** Informations sur une étoile-traceur (pour le panneau). */
  starInfo(i: number): { mass: number; age: number; distanceFromCenter: number; speedKms: number } | null {
    const s = this.sim;
    if (!s || i < 0 || i >= s.n) return null;
    const c = s.components[s.owner[i]];
    const x = s.pos[i * 3] - c.center.x, y = s.pos[i * 3 + 1] - c.center.y, z = s.pos[i * 3 + 2] - c.center.z;
    const vx = s.vel[i * 3] - c.vel.x, vy = s.vel[i * 3 + 1] - c.vel.y, vz = s.vel[i * 3 + 2] - c.vel.z;
    return { mass: s.starMass[i], age: clamp(s.age[i], 0, 1), distanceFromCenter: Math.hypot(x, y, z), speedKms: Math.hypot(vx, vy, vz) / 0.0033356 };
  }
}
