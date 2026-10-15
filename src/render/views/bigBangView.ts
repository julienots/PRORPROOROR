import * as THREE from 'three';
import { clamp, YEAR_S } from '../../core/units';
import type { Vec3 } from '../../core/vec';
import { generateStructure, type StructureField } from '../../sim/bigbang';
import {
  PLANCK18, sanitizeCosmo, integrateHistory, scaleFactorAt, growthFactor, radiationTemperature, epochAt, hubbleAt,
  type CosmoParams, type CosmoHistory, type CosmicEpoch,
} from '../../sim/cosmology';
import { BLACKBODY_GLSL } from '../shaders/noise';
import { LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from '../objects/common';
import type { View, PickResult } from './view';
import type { Game } from '../../game';

const PT_VERT = /* glsl */ `
${LOGDEPTH_VERT_HEAD}
attribute vec3 psi; attribute float aCol; attribute float rnd;
uniform float D; uniform float aNow; uniform float pixelRatio; uniform float hot; uniform float time; uniform float lit;
varying vec3 vCol; varying float vA;
${BLACKBODY_GLSL}
void main() {
  vec3 p = position + D * psi;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float fog = exp(-dist / 140.0);
  // matière (noire + baryonique) : gris-bleu ; plasma : lueur thermique ; étoiles : blanc chaud
  vec3 dm = vec3(0.25, 0.32, 0.55);
  vec3 plasma = vec3(1.0, 0.75, 0.45);
  float star = lit * step(aCol, aNow) * (0.6 + 0.4 * sin(time * 3.0 + rnd * 40.0));
  vCol = mix(dm * 0.5, plasma, hot) + vec3(1.0, 0.9, 0.75) * star * 2.5;
  vA = fog * (hot > 0.5 ? 0.5 : 1.0);
  gl_PointSize = clamp((hot > 0.5 ? 3.0 : 1.6 + star * 2.0) * 80.0 / max(dist, 1.0), 1.0, 7.0) * pixelRatio;
  ${LOGDEPTH_VERT_MAIN}
}`;

const PT_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_HEAD}
varying vec3 vCol; varying float vA;
void main() {
  ${LOGDEPTH_FRAG_MAIN}
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vCol * smoothstep(0.5, 0.0, d) * vA, 1.0);
}`;

export interface BigBangState {
  tSeconds: number;
  a: number;
  z: number;
  T: number;
  H: number;
  D: number;
  epoch: CosmicEpoch;
  progress: number;
  haloCount: number;
  starsLit: number;
  physicalSeparationMpc: number;
}

/** Laboratoire « CRÉATION D'UN UNIVERS » : séquence cosmologique jouable. */
export class BigBangView implements View {
  readonly scene = new THREE.Scene();
  readonly level = 'bigbang' as const;
  readonly renderScale = 1;
  params: CosmoParams = { ...PLANCK18 };
  seed = 2026;
  field: StructureField | null = null;
  history: CosmoHistory = integrateHistory(PLANCK18, 60);
  progress = 0; // 0..1 sur une échelle logarithmique du temps
  playing = false;
  speed = 0.04; // progression par seconde
  generating = false;
  private points: THREE.Points | null = null;
  private halos: THREE.Points | null = null;
  private grid: THREE.LineSegments;
  private dTable: { a: number; D: number }[] = [];
  private bg = new THREE.Color();
  state: BigBangState | null = null;
  private lastEpoch = '';

  constructor(private game: Game) {
    this.scene.background = this.bg;
    const lines: number[] = [];
    const L = 100, step = 25;
    for (let a = -L; a <= L; a += step) for (let b = -L; b <= L; b += step) {
      lines.push(-L, a, b, L, a, b, a, -L, b, a, L, b, a, b, -L, a, b, L);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a6aa0, transparent: true, opacity: 0.12, depthWrite: false }));
    this.scene.add(this.grid);
  }

  /** Paramètres et graine, puis génération du champ (asynchrone pour ne pas figer l'interface). */
  configure(p: Partial<CosmoParams>, seed: number): void {
    this.params = sanitizeCosmo({ ...this.params, ...p });
    this.seed = seed >>> 0;
    this.history = integrateHistory(this.params, 80);
    this.dTable = [];
    for (let k = 0; k <= 50; k++) {
      const a = Math.pow(10, -3 + (k / 50) * 3);
      this.dTable.push({ a, D: growthFactor(this.params, a) });
    }
    this.field = null;
    this.progress = 0;
    this.playing = false;
  }

  generate(): Promise<void> {
    if (this.generating) return Promise.resolve();
    this.generating = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          const N = this.game.engine.settings.bigBangGrid;
          this.field = generateStructure(this.seed, this.params, N, 200);
          this.buildPoints();
        } finally {
          this.generating = false;
          resolve();
        }
      }, 30);
    });
  }

  private buildPoints(): void {
    const f = this.field!;
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
    if (this.halos) { this.scene.remove(this.halos); this.halos.geometry.dispose(); }
    const n = f.N ** 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f.q, 3));
    g.setAttribute('psi', new THREE.BufferAttribute(f.psi, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(f.aCollapse, 1));
    const rnd = new Float32Array(n);
    for (let i = 0; i < n; i++) rnd[i] = Math.random();
    g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { D: { value: 0 }, aNow: { value: 0 }, pixelRatio: { value: 1 }, hot: { value: 1 }, time: { value: 0 }, lit: { value: 0 } },
      vertexShader: PT_VERT, fragmentShader: PT_FRAG, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    // halos → galaxies (apparaissent à leur facteur d'échelle de formation)
    const hs = f.halos;
    const hp = new Float32Array(hs.length * 3);
    const hsz = new Float32Array(hs.length);
    const ha = new Float32Array(hs.length);
    hs.forEach((h, i) => { hp[i * 3] = h.x; hp[i * 3 + 1] = h.y; hp[i * 3 + 2] = h.z; hsz[i] = clamp(Math.log10(h.mass) - 11, 0.5, 4); ha[i] = h.aForm; });
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    hg.setAttribute('hsize', new THREE.BufferAttribute(hsz, 1));
    hg.setAttribute('aForm', new THREE.BufferAttribute(ha, 1));
    this.halos = new THREE.Points(hg, new THREE.ShaderMaterial({
      uniforms: { aNow: { value: 0 }, pixelRatio: { value: 1 }, show: { value: 0 } },
      vertexShader: /* glsl */ `
        ${LOGDEPTH_VERT_HEAD}
        attribute float hsize; attribute float aForm; uniform float aNow; uniform float pixelRatio; uniform float show; varying float vOn;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vOn = show * smoothstep(aForm, aForm * 1.6, aNow);
          gl_PointSize = clamp(hsize * 260.0 / max(-mv.z, 1.0), 2.0, 40.0) * pixelRatio * vOn;
          ${LOGDEPTH_VERT_MAIN}
        }`,
      fragmentShader: /* glsl */ `
        ${LOGDEPTH_FRAG_HEAD}
        varying float vOn;
        void main() {
          ${LOGDEPTH_FRAG_MAIN}
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c);
          if (r > 0.5 || vOn <= 0.0) discard;
          float a = exp(-r * 9.0) + 0.3 * exp(-r * 4.0) * (0.5 + 0.5 * cos(atan(c.y, c.x) * 2.0 + r * 20.0));
          gl_FragColor = vec4(vec3(1.0, 0.85, 0.65) * a * vOn, 1.0);
        }`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this.halos.frustumCulled = false;
    this.scene.add(this.halos);
  }

  enter(): void {
    const rig = this.game.engine.rig;
    rig.minDistance = 1;
    rig.maxDistance = 600;
    rig.mode = 'cinematic';
    rig.set({ x: 0, y: 0, z: 0 }, 90);
    if (!this.dTable.length) this.configure(this.params, this.seed);
  }

  exit(): void {
    this.playing = false;
    this.game.labels.clear();
    this.game.engine.rig.mode = 'orbit';
  }

  /** Temps (s) correspondant à la progression (échelle logarithmique de 10⁻⁴³ s à la fin). */
  timeAt(progress: number): number {
    const tEndGyr = Number.isFinite(this.history.tEnd) ? this.history.tEnd : Number.isFinite(this.history.age) ? this.history.age : 13.8;
    const lEnd = Math.log10(tEndGyr * 1e9 * YEAR_S);
    return Math.pow(10, -43 + clamp(progress, 0, 1) * (lEnd + 43));
  }

  /** Facteur d'échelle à t (s) : ère radiative analytique puis intégration de Friedmann. */
  scaleAt(tS: number): number {
    const tGyr = tS / YEAR_S / 1e9;
    const h = this.history;
    if (tGyr >= h.t[0]) return scaleFactorAt(h, tGyr);
    if (tS < 1e-32) {
      // avant / pendant l'inflation (hypothèse) : facteur ~e^60 en 1e-32 s
      const aEnd = Math.sqrt(2 * Math.sqrt(this.params.omegaR) * (this.params.H0 / 977.8) * (1e-32 / YEAR_S / 1e9));
      const f = clamp((Math.log10(tS) + 36) / 4, 0, 1);
      return aEnd * Math.exp(-60 * (1 - f));
    }
    // ère radiative : a = √(2 √Ωr H0 t)
    return Math.sqrt(2 * Math.sqrt(this.params.omegaR) * (this.params.H0 / 977.8) * tGyr);
  }

  private growthAt(a: number): number {
    const t = this.dTable;
    if (!t.length || a <= t[0].a) return a / 1e-3 * (t[0]?.D ?? 1e-3);
    for (let k = 1; k < t.length; k++) if (t[k].a >= a) {
      const f = (a - t[k - 1].a) / (t[k].a - t[k - 1].a);
      return t[k - 1].D + f * (t[k].D - t[k - 1].D);
    }
    return t[t.length - 1].D * (a / t[t.length - 1].a);
  }

  play(): void {
    if (!this.field) {
      void this.generate().then(() => { this.playing = true; this.game.audio.play('bigbang'); });
      return;
    }
    if (this.progress >= 1) this.progress = 0;
    if (this.progress === 0) this.game.audio.play('bigbang');
    this.playing = true;
  }

  update(dt: number): void {
    const g = this.game;
    if (this.playing && !g.paused) {
      // ralentissement automatique aux étapes clés (recombinaison, premières étoiles)
      const tS = this.timeAt(this.progress);
      const slow = tS > 3e12 && tS < 3e13 ? 0.35 : tS > 1e15 && tS < 5e16 ? 0.5 : 1;
      this.progress = clamp(this.progress + dt * this.speed * slow, 0, 1);
      if (this.progress >= 1) this.playing = false;
    }
    const tS = this.timeAt(this.progress);
    const a = Math.max(1e-80, this.scaleAt(tS));
    const T = radiationTemperature(this.params, a);
    const D = a > 1e-3 ? this.growthAt(a) : a / 1e-3 * (this.dTable[0]?.D ?? 1e-3);
    const epoch = epochAt(T);
    if (epoch.id !== this.lastEpoch) {
      this.lastEpoch = epoch.id;
      if (this.playing) {
        g.toast(`${epoch.name} — ${epoch.description}`, epoch.science === 'hypothese' ? 'divine' : 'science');
        g.audio.play(epoch.id === 'recomb' ? 'confirm' : 'whoosh');
      }
    }
    const hot = T > 3000 ? 1 : T > 2900 ? (T - 2900) / 100 : 0;
    // fond : lueur du plasma (opaque) puis fond diffus refroidi
    if (T > 2900) {
      const k = clamp(Math.log10(T / 2900) / 3, 0.25, 1);
      const bb = new THREE.Color().setRGB(1, 0.6, 0.3);
      if (T > 6000) bb.setRGB(1, 0.85, 0.7);
      if (T > 1e6) bb.setRGB(0.85, 0.9, 1);
      this.bg.copy(bb).multiplyScalar(k * 0.9);
    } else {
      const k = clamp((T - 3) / 2900, 0, 1);
      this.bg.setRGB(0.5 * k + 0.004, 0.18 * k + 0.004, 0.05 * k + 0.01);
    }
    const eye = g.engine.rig.eye;
    let lit = 0;
    if (this.points) {
      this.points.position.set(-eye.x, -eye.y, -eye.z);
      const u = (this.points.material as THREE.ShaderMaterial).uniforms;
      u.D.value = D;
      u.aNow.value = a;
      u.hot.value = hot;
      u.time.value += dt;
      u.pixelRatio.value = g.engine.renderer.getPixelRatio();
      u.lit.value = T < 100 ? 1 : 0;
      if (this.field && T < 100) {
        const ac = this.field.aCollapse;
        for (let i = 0; i < ac.length; i += 37) if (ac[i] < a) lit++;
        lit *= 37;
      }
    }
    let haloCount = 0;
    if (this.halos && this.field) {
      this.halos.position.set(-eye.x, -eye.y, -eye.z);
      const u = (this.halos.material as THREE.ShaderMaterial).uniforms;
      u.aNow.value = a;
      u.show.value = T < 25 ? 1 : 0;
      u.pixelRatio.value = g.engine.renderer.getPixelRatio();
      if (T < 25) haloCount = this.field.halos.filter((h) => h.aForm < a).length;
    }
    this.grid.position.set(-eye.x, -eye.y, -eye.z);
    (this.grid.material as THREE.LineBasicMaterial).opacity = 0.05 + 0.12 * (1 - hot);
    // deux « galaxies témoins » : leur distance physique croît avec a (l'espace s'étend)
    const sepComoving = 100;
    this.state = {
      tSeconds: tS, a, z: 1 / a - 1, T, H: hubbleAt(this.params, Math.max(a, 1e-30)), D, epoch, progress: this.progress,
      haloCount, starsLit: lit, physicalSeparationMpc: sepComoving * a,
    };
    g.labels.begin();
    g.labels.add('bbgrid', `Maille de la grille : 25 Mpc comobiles = ${fmtMpc(25 * a)} physiques`, 20, g.engine.height - 150, 'k-info');
    g.labels.end();
  }

  /** Adopte l'univers simulé : paramètres + catalogue de halos pour la vue cosmique. */
  adopt(): void {
    if (!this.field) return;
    const g = this.game;
    g.universe.bigBang = { seed: this.seed, params: { ...this.params } };
    g.setCosmology(this.params);
    g.cosmic.haloCatalog = { halos: this.field.halos, box: this.field.boxMpc };
    g.cosmic.clearCache();
    const age = Number.isFinite(this.history.age) ? this.history.age : this.timeAt(this.progress) / YEAR_S / 1e9;
    g.universe.cosmicTime = age;
    g.toast(`Univers adopté : ${this.field.halos.length} halos deviennent les galaxies de la vue cosmique.`, 'divine');
    void g.goCosmic();
  }

  /** Restaure un univers adopté depuis une sauvegarde (régénère le catalogue de halos). */
  adoptSilently(seed: number, params: CosmoParams): void {
    this.configure(params, seed);
    try {
      this.field = generateStructure(seed, params, 32, 200);
      this.game.cosmic.haloCatalog = { halos: this.field.halos, box: this.field.boxMpc };
      this.buildPoints();
    } catch {
      /* champ non régénérable : on garde la génération procédurale */
    }
  }

  pick(): PickResult | null {
    return null;
  }

  positionOf(): Vec3 | null {
    return { x: 0, y: 0, z: 0 };
  }

  framingDistance(): number {
    return 90;
  }
}

function fmtMpc(v: number): string {
  if (v < 1e-6) return `${(v * 3.086e19).toExponential(2)} km`;
  if (v < 1e-3) return `${(v * 3.26156e6).toPrecision(3)} al`;
  if (v < 1) return `${(v * 1000).toPrecision(3)} kpc`;
  return `${v.toPrecision(3)} Mpc`;
}
