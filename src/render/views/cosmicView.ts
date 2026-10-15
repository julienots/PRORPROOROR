import * as THREE from 'three';
import { clamp } from '../../core/units';
import { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/vec';
import { SECTOR_MPC, type CosmicGalaxy } from '../../procgen/universe';
import { radiationTemperature } from '../../sim/cosmology';
import { blackbodyRGB } from '../../core/color';
import { NOISE_GLSL } from '../shaders/noise';
import { ringTexture } from '../objects/common';
import { LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from '../objects/common';
import type { View, PickResult } from './view';
import type { Game } from '../../game';

const TYPE_INDEX: Record<string, number> = { spiral: 0, barred: 1, elliptical: 2, lenticular: 3, irregular: 4 };
const MAX_GAL = 6000;

const GAL_VERT = /* glsl */ `
${LOGDEPTH_VERT_HEAD}
attribute float gType; attribute float gSeed; attribute vec3 gColor;
varying vec2 vUv; varying float vType; varying float vSeed; varying vec3 vColor;
void main() {
  vUv = uv * 2.0 - 1.0; vType = gType; vSeed = gSeed; vColor = gColor;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
  ${LOGDEPTH_VERT_MAIN}
}`;

const GAL_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_HEAD}
${NOISE_GLSL}
uniform float rip; uniform float time;
varying vec2 vUv; varying float vType; varying float vSeed; varying vec3 vColor;
void main() {
  ${LOGDEPTH_FRAG_MAIN}
  vec2 p = vUv;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float I = 0.0;
  if (vType < 1.5) {
    // spirale (barrée si type 1)
    float arms = 2.0 + mod(vSeed, 2.0);
    float sp = cos(arms * (ang + log(r + 0.05) * 3.0 + vSeed));
    float bar = vType > 0.5 ? exp(-pow(p.y * 9.0, 2.0)) * exp(-pow(p.x * 2.2, 2.0)) : 0.0;
    I = exp(-r * 4.0) * 1.4 + pow(max(sp, 0.0), 2.0) * exp(-r * 2.6) * 0.7 + bar * 0.8;
    I *= 0.75 + 0.25 * snoise(vec3(p * 9.0, vSeed));
  } else if (vType < 2.5) {
    I = exp(-pow(r * 2.8, 1.0)) * 1.5; // elliptique : profil ~ de Vaucouleurs
  } else if (vType < 3.5) {
    I = exp(-r * 3.5) * 1.3 + exp(-pow((r - 0.5) * 6.0, 2.0)) * 0.1;
  } else {
    I = smoothstep(0.1, 0.7, snoise(vec3(p * 3.0, vSeed)) * 0.5 + 0.5) * exp(-r * 2.5) * 1.6;
  }
  I *= smoothstep(1.0, 0.7, r);
  // Big Rip : les structures se dissolvent
  if (rip > 0.0) I *= clamp(1.0 - rip + 0.4 * snoise(vec3(p * 6.0, time + vSeed)), 0.0, 1.0);
  vec3 col = mix(vColor, vec3(1.0, 0.85, 0.65), exp(-r * 5.0));
  gl_FragColor = vec4(col * I, 1.0);
}`;

/** Vue cosmique : unités = Mpc physiques (comobile × a(t)). */
export class CosmicView implements View {
  readonly scene = new THREE.Scene();
  readonly level = 'cosmic' as const;
  readonly renderScale = 1;
  private mesh: THREE.InstancedMesh;
  private aType: THREE.InstancedBufferAttribute;
  private aSeed: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  galaxies: CosmicGalaxy[] = [];
  private byId = new Map<string, CosmicGalaxy>();
  private loadedCenter: Vec3 | null = null;
  private loadedRadius = 0;
  private web: THREE.Points;
  private webPos = new Float32Array(30000 * 3);
  private webCount = 0;
  private sel: THREE.Sprite;
  private bubble: THREE.Mesh;
  private scenario: { kind: string; t: number; origin: Vec3 } | null = null;
  private bg = new THREE.Color();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();

  constructor(private game: Game) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { rip: { value: 0 }, time: { value: 0 } },
      vertexShader: GAL_VERT, fragmentShader: GAL_FRAG,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, MAX_GAL);
    this.aType = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GAL), 1);
    this.aSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GAL), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GAL * 3), 3);
    geo.setAttribute('gType', this.aType);
    geo.setAttribute('gSeed', this.aSeed);
    geo.setAttribute('gColor', this.aColor);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(this.webPos, 3));
    this.web = new THREE.Points(wg, new THREE.PointsMaterial({ color: 0x3050a0, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.web.frustumCulled = false;
    this.scene.add(this.web);
    this.sel = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, transparent: true }));
    this.sel.renderOrder = 20;
    this.scene.add(this.sel);
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshBasicMaterial({ color: 0xaa66ff, wireframe: true, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.bubble.visible = false;
    this.scene.add(this.bubble);
    this.scene.background = this.bg;
  }

  reset(): void {
    this.loadedCenter = null;
    this.galaxies = [];
    this.byId.clear();
    this.scenario = null;
  }

  enter(): void {
    const rig = this.game.engine.rig;
    rig.minDistance = 0.08;
    rig.maxDistance = 2500;
  }

  exit(): void {
    this.game.labels.clear();
  }

  galaxyById(id: string): CosmicGalaxy | undefined {
    return this.byId.get(id);
  }

  startScenario(kind: string): void {
    const t = this.game.engine.rig.target;
    const a = this.game.scaleFactorNow();
    this.scenario = { kind, t: 0, origin: { x: t.x / a + 60, y: t.y / a, z: t.z / a - 40 } };
  }

  private ensureLoaded(): void {
    const g = this.game;
    const a = Math.max(1e-3, g.scaleFactorNow());
    const t = g.engine.rig.target;
    const c = { x: t.x / a, y: t.y / a, z: t.z / a };
    const radius = clamp((g.engine.rig.distance / a) * 2.2, 40, 160);
    if (this.loadedCenter && Math.hypot(c.x - this.loadedCenter.x, c.y - this.loadedCenter.y, c.z - this.loadedCenter.z) < SECTOR_MPC * 0.8 && Math.abs(radius - this.loadedRadius) < this.loadedRadius * 0.3) return;
    this.loadedCenter = c;
    this.loadedRadius = radius;
    const list = g.cosmic.galaxiesNear(c.x, c.y, c.z, radius);
    for (const cg of g.universe.customGalaxies) list.push(cg);
    list.sort((p, q) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2 - ((q.x - c.x) ** 2 + (q.y - c.y) ** 2 + (q.z - c.z) ** 2));
    this.galaxies = list.slice(0, MAX_GAL);
    for (const x of this.galaxies) this.byId.set(x.id, x);
    this.galaxies.forEach((x, i) => {
      this.aType.setX(i, TYPE_INDEX[x.type] ?? 0);
      this.aSeed.setX(i, (x.seed % 1000) / 100);
      const col = x.type === 'elliptical' || x.type === 'lenticular' ? [1.0, 0.75, 0.5] : x.type === 'irregular' ? [0.6, 0.75, 1.0] : [0.7, 0.8, 1.0];
      this.aColor.setXYZ(i, col[0], col[1], col[2]);
    });
    this.aType.needsUpdate = true;
    this.aSeed.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.mesh.count = this.galaxies.length;
    // filaments de la toile cosmique (gaz intergalactique diffus)
    const rng = new Rng(Math.floor(c.x) * 73856093 ^ Math.floor(c.z) * 19349663);
    let k = 0;
    for (let tries = 0; tries < 400000 && k < 30000; tries++) {
      const x = c.x + rng.range(-radius, radius), y = c.y + rng.range(-radius, radius), z = c.z + rng.range(-radius, radius);
      if (rng.next() < g.cosmic.webDensity(x, y, z) * 0.25) {
        this.webPos[k * 3] = x; this.webPos[k * 3 + 1] = y; this.webPos[k * 3 + 2] = z;
        k++;
      }
    }
    this.webCount = k;
  }

  update(dt: number): void {
    const g = this.game;
    this.ensureLoaded();
    const a = Math.max(1e-4, g.scaleFactorNow());
    const eye = g.engine.rig.eye;
    const rig = g.engine.rig;
    const H = g.engine.height;
    const pf = H / (2 * Math.tan((rig.camera.fov * Math.PI) / 360));
    this.mat.uniforms.time.value += dt;
    // scénarios de fin
    let rip = 0;
    if (this.scenario) this.scenario.t += dt * g.timeSpeed();
    if (g.cosmoHistory.fate === 'bigrip' && Number.isFinite(g.cosmoHistory.tEnd)) {
      rip = clamp((g.universe.cosmicTime - (g.cosmoHistory.tEnd - 3)) / 3, 0, 1);
    }
    this.mat.uniforms.rip.value = rip;
    let bubbleR = 0;
    if (this.scenario?.kind === 'vacuum') {
      bubbleR = this.scenario.t * 306.6; // vitesse de la lumière ≈ 306,6 Mpc/Ga
      this.bubble.visible = true;
      const o = this.scenario.origin;
      this.bubble.position.set(o.x * a - eye.x, o.y * a - eye.y, o.z * a - eye.z);
      this.bubble.scale.setScalar(bubbleR * a);
    } else this.bubble.visible = false;
    for (let i = 0; i < this.galaxies.length; i++) {
      const x = this.galaxies[i];
      this.tmpP.set(x.x * a - eye.x, x.y * a - eye.y, x.z * a - eye.z);
      const dist = this.tmpP.length();
      let size = Math.max(x.size * (1 + rip * 3), (2.2 * dist) / pf);
      if (this.scenario?.kind === 'vacuum') {
        const o = this.scenario.origin;
        if (Math.hypot(x.x - o.x, x.y - o.y, x.z - o.z) < bubbleR) size = 0;
      }
      this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(x.nx, x.ny, x.nz));
      if (x.type === 'elliptical') this.tmpQ.copy(rig.camera.quaternion);
      this.tmpS.set(size, size * (x.type === 'elliptical' ? 0.7 : 1), size);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.web.position.set(-eye.x, -eye.y, -eye.z);
    this.web.scale.setScalar(a);
    this.web.geometry.setDrawRange(0, this.webCount);
    (this.web.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    // fond : température du rayonnement fossile (visible en Big Crunch)
    const T = radiationTemperature(g.universe.cosmology, a);
    if (T > 600) {
      const [r, gg, b] = blackbodyRGB(Math.min(T, 20000));
      const k = clamp(Math.log10(T / 600) / 2, 0, 1);
      this.bg.setRGB(r * k, gg * k, b * k);
    } else this.bg.setRGB(0.004, 0.004, 0.012);
    // sélection
    const sid = g.selectionId?.startsWith('g') ? g.selectionId.slice(1) : null;
    const sg = sid ? this.byId.get(sid) : undefined;
    this.sel.visible = !!sg;
    if (sg) {
      this.sel.position.set(sg.x * a - eye.x, sg.y * a - eye.y, sg.z * a - eye.z);
      const d = this.sel.position.length();
      this.sel.scale.setScalar(Math.max(sg.size * 2.5, (30 * d) / pf));
    }
    // étiquettes des galaxies proches
    g.labels.begin();
    let n = 0;
    for (const x of this.galaxies) {
      if (n > 25) break;
      const rel = new THREE.Vector3(x.x * a - eye.x, x.y * a - eye.y, x.z * a - eye.z);
      const px = (x.size / Math.max(rel.length(), 1e-6)) * pf;
      if (px < 6 && x.id !== 'home' && x.id !== sid && x.createdBy !== 'player') continue;
      const s = g.engine.toScreen(rel);
      if (!s.visible) continue;
      g.labels.add(`g${x.id}`, x.name, s.x * g.engine.width, s.y * g.engine.height + 10, x.id === 'home' ? 'k-sol' : 'k-galaxy');
      n++;
    }
    g.labels.end();
  }

  pick(px: number, py: number): PickResult | null {
    const g = this.game;
    const a = Math.max(1e-4, g.scaleFactorNow());
    const eye = g.engine.rig.eye;
    let best: CosmicGalaxy | null = null, bd = Infinity;
    for (const x of this.galaxies) {
      const s = g.engine.toScreen(new THREE.Vector3(x.x * a - eye.x, x.y * a - eye.y, x.z * a - eye.z));
      if (!s.visible) continue;
      const d = Math.hypot(s.x * g.engine.width - px, s.y * g.engine.height - py);
      if (d < 14 && d < bd) { bd = d; best = x; }
    }
    return best ? { kind: 'galaxy', id: `g${best.id}`, label: best.name } : null;
  }

  positionOf(id: string): Vec3 | null {
    if (!id.startsWith('g')) return null;
    const x = this.byId.get(id.slice(1)) ?? this.game.findCosmicGalaxy(id.slice(1));
    if (!x) return null;
    const a = Math.max(1e-4, this.game.scaleFactorNow());
    return { x: x.x * a, y: x.y * a, z: x.z * a };
  }

  framingDistance(id: string): number {
    const x = this.byId.get(id.slice(1));
    return x ? Math.max(0.15, x.size * 12) : 1;
  }

  /** Ajoute une galaxie créée par le joueur près de la cible caméra. */
  addCustom(g: CosmicGalaxy): void {
    this.byId.set(g.id, g);
    this.loadedCenter = null;
  }
}
