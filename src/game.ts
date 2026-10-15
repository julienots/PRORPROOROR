import * as THREE from 'three';
import { EventBus } from './core/events';
import { hashCombine, hashString } from './core/rng';
import { clamp, km2au, sanitize, fmtYears, LY_AU, M_EARTH_SUN } from './core/units';
import type { Vec3 } from './core/vec';
import { World } from './sim/world';
import { History } from './sim/history';
import { MicroLab } from './sim/micro';
import { GalaxySim, starSystemSeed, type GalaxyParams } from './sim/galaxy';
import { PLANCK18, integrateHistory, scaleFactorAt, type CosmoHistory, type CosmoParams, sanitizeCosmo } from './sim/cosmology';
import type { SimEvent } from './sim/types';
import { makeStar, makePlanet, makeBlackHole, makeNebula, makeDarkMatter, bodyFromMatter, type MatterCreation } from './sim/factory';
import { generateSolarSystem, generateSystem } from './procgen/starsystem';
import { CosmicGenerator, galaxyParamsFor, type CosmicGalaxy } from './procgen/universe';
import { Engine, PRESETS, type GraphicsSettings, type QualityPreset } from './render/engine';
import { LabelLayer } from './render/labels';
import { SystemView } from './render/views/systemView';
import { GalaxyView } from './render/views/galaxyView';
import { CosmicView } from './render/views/cosmicView';
import { MicroView } from './render/views/microView';
import { BigBangView } from './render/views/bigBangView';
import type { View } from './render/views/view';
import { AudioEngine } from './audio/audio';
import { OpenWorld } from './openworld';
import { SaveStore } from './save/storage';
import {
  emptyUniverse, snapshotWorld, restoreWorld, type UniverseSave, type ScaleLevel, type WorldSnapshot,
} from './save/serialize';

export type Tool = 'select' | 'move' | 'create' | 'push' | 'collide' | 'destroy';

export interface CreationSpec {
  type: 'matter' | 'star' | 'planet' | 'blackhole' | 'nebula' | 'darkmatter';
  matter?: MatterCreation;
  star?: { mass: number; metallicity: number; rotationDays: number; protostar: boolean };
  planet?: Parameters<typeof makePlanet>[0];
  blackhole?: { mass: number; spin: number; diskMass: number; jets: boolean; environment: number };
  nebula?: { mass: number; density: number; temperature: number };
  darkmatter?: { mass: number; radiusAU: number };
  /** Vitesse initiale : orbite circulaire autour du corps dominant ou repos. */
  orbit: 'circular' | 'rest';
  speedKms?: number;
}

export interface GameEvents extends Record<string, unknown> {
  select: string | null;
  level: ScaleLevel;
  toast: { text: string; kind?: 'info' | 'warn' | 'error' | 'science' | 'divine' };
  simevent: SimEvent;
  tool: Tool;
  universe: UniverseSave;
  saved: string;
  history: void;
  frame: number;
}

export const LEVEL_ORDER: ScaleLevel[] = ['subatomic', 'atomic', 'micro', 'planet', 'system', 'galaxy', 'cosmic'];
export const LEVEL_LABEL: Record<ScaleLevel, string> = {
  subatomic: 'Subatomique', atomic: 'Atomique', micro: 'Microscopique', planet: 'Planétaire', system: 'Stellaire', galaxy: 'Galactique', cosmic: 'Cosmique', bigbang: 'Big Bang',
};

/** Pas de temps (unités par seconde réelle) disponibles par échelle. */
export const TIME_STEPS: Record<string, { values: number[]; unit: string }> = {
  system: { values: [1 / 365.25 / 24 / 60, 1 / 365.25 / 24, 1 / 365.25, 7 / 365.25, 30 / 365.25, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9], unit: 'an' },
  galaxy: { values: [0.1, 1, 5, 20, 50, 100, 250], unit: 'Ma' },
  cosmic: { values: [0.001, 0.01, 0.1, 0.5, 1, 5, 20], unit: 'Ga' },
  micro: { values: [0.1, 0.25, 0.5, 1, 2, 4], unit: '×' },
};

const DEFAULT_TIME_INDEX: Record<string, number> = { system: 3, galaxy: 2, cosmic: 2, micro: 3 };

/**
 * Orchestration du jeu : boucle principale, échelles, transitions, pouvoirs divins,
 * sélection, sauvegardes. L'interface (ui/) s'abonne aux évènements.
 */
export class Game {
  readonly bus = new EventBus<GameEvents>();
  readonly engine: Engine;
  readonly labels: LabelLayer;
  readonly world = new World();
  readonly history: History;
  readonly micro = new MicroLab(7);
  readonly audio = new AudioEngine();
  readonly store = new SaveStore();
  cosmic: CosmicGenerator;
  universe: UniverseSave;
  cosmoHistory: CosmoHistory;
  galaxy: GalaxySim | null = null;
  currentGalaxy: { params: GalaxyParams; cosmic: CosmicGalaxy } | null = null;
  views: Record<'system' | 'galaxy' | 'cosmic' | 'micro' | 'bigbang', View>;
  level: ScaleLevel = 'system';
  view: View;
  realTime = 0;
  paused = false;
  timeIndex: Record<string, number> = { ...DEFAULT_TIME_INDEX };
  selectionId: string | null = null;
  analysis = false;
  tool: Tool = 'select';
  creation: CreationSpec = { type: 'planet', planet: { massEarth: 1 }, orbit: 'circular' };
  /** Premier corps choisi pour l'outil Collision. */
  collideFirst: number | null = null;
  started = false;
  private fade: HTMLDivElement;
  private transitioning = false;
  private lastT = performance.now();
  private dragState: { id: number; plane: THREE.Plane; start: Vec3 } | null = null;
  private pushState: { id: number; x: number; y: number; line: SVGLineElement | null } | null = null;
  /** Clé du système courant. */
  systemKey = 'sol';
  /** Monde ouvert : passages d'échelle continus, vol libre, atterrissage, pilote automatique. */
  readonly ow: OpenWorld = new OpenWorld(this);
  get surface() { return this.ow.surface; }
  isTransitioning(): boolean { return this.transitioning; }
  /** Index de l'étoile du Soleil dans la Voie lactée. */
  solIndex = 0;
  frameCount = 0;
  /** Âge du système depuis l'arrivée (affichage). */
  private overlay: SVGSVGElement;

  constructor(container: HTMLElement, quality: QualityPreset = 'equilibre') {
    const gs: GraphicsSettings = { preset: quality, ...PRESETS[quality] };
    this.engine = new Engine(container, gs);
    this.labels = new LabelLayer(container);
    this.labels.onClick = (id) => this.select(id, true);
    this.fade = document.createElement('div');
    this.fade.className = 'fade';
    container.appendChild(this.fade);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.classList.add('tool-overlay');
    container.appendChild(this.overlay);
    this.history = new History(this.world);
    this.universe = emptyUniverse('Univers primordial', 2026, this.world);
    this.cosmic = new CosmicGenerator(this.universe.seed);
    this.cosmoHistory = integrateHistory(this.universe.cosmology, 200);
    this.views = {
      system: new SystemView(this),
      galaxy: new GalaxyView(this),
      cosmic: new CosmicView(this),
      micro: new MicroView(this),
      bigbang: new BigBangView(this),
    };
    this.view = this.views.system;
    this.world.onEvent((e) => this.onSimEvent(e));
    this.micro.onEvent((e) => {
      if (e.kind === 'discovery') this.toast(e.message, 'science');
      if (e.kind === 'bond') this.audio.play('bond');
      if (e.kind === 'fusion') this.audio.play('impact', 0.3);
      this.bus.emit('simevent', { t: this.micro.time, type: 'info', message: e.message });
    });
    this.engine.rig.onZoomLimit = (dir) => this.onZoomLimit(dir);
    this.engine.rig.followFn = () => (this.selectionId && this.engine.rig.mode !== 'orbit' ? this.view.positionOf(this.selectionId) : null);
    this.bindPointer();
    this.newUniverse('Univers primordial', 2026, true);
    requestAnimationFrame(this.loop);
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  private loop = (now: number) => {
    requestAnimationFrame(this.loop);
    const real = clamp((now - this.lastT) / 1000, 0, 0.5);
    this.lastT = now;
    this.frame(Math.min(real, 0.1), real);
  };

  /** Une image : simulation, caméra, rendu. Public pour les tests. */
  frame(dt: number, realDt = dt): void {
    this.realTime += dt;
    this.frameCount++;
    this.universe.stats.playTimeS += dt;
    this.audio.tick(dt);
    const speed = this.timeSpeed();
    if (!this.paused && this.started) {
      switch (this.level) {
        case 'system':
        case 'planet':
          this.world.step(speed * dt);
          break;
        case 'galaxy': {
          // caméra co-mobile : près d'une étoile, elle est entraînée par la rotation galactique
          const gv = this.views.galaxy as GalaxyView;
          const rig = this.engine.rig;
          const n = gv.nearestStar(rig.eye);
          const before = n.idx >= 0 && n.dist < 0.08 ? gv.starPosition(n.idx) : null;
          this.galaxy?.step(speed * dt, this.engine.settings.galaxyStars > 40000 ? 6 : 10);
          if (before && rig.mode !== 'follow') {
            const after = gv.starPosition(n.idx);
            rig.translate({ x: after.x - before.x, y: after.y - before.y, z: after.z - before.z });
          }
          this.universe.cosmicTime += (speed * dt) / 1000;
          break;
        }
        case 'cosmic':
          this.universe.cosmicTime = clamp(this.universe.cosmicTime + speed * dt, 0, Math.min(1e4, Number.isFinite(this.cosmoHistory.tEnd) ? this.cosmoHistory.tEnd : 1e4));
          break;
        case 'micro':
        case 'atomic':
        case 'subatomic':
          this.micro.speed = speed;
          this.micro.step(dt);
          break;
      }
    } else {
      this.world.lastReport = { requested: 0, achieved: 0, substeps: 0, mode: 'nbody', ms: 0 };
    }
    this.world.updateMergers(dt);
    this.ow.preCamera(realDt);
    this.updateCameraLimits();
    this.engine.rig.update(realDt);
    this.ow.postCamera();
    this.view.update(realDt);
    this.engine.render(this.view.scene, dt);
    this.bus.emit('frame', this.frameCount);
  }

  /** Unités de temps simulées par seconde réelle à l'échelle courante. */
  timeSpeed(): number {
    const k = this.timeKey();
    const steps = TIME_STEPS[k];
    if (!steps) return 0;
    return steps.values[clamp(this.timeIndex[k] ?? 0, 0, steps.values.length - 1)];
  }

  timeKey(): string {
    if (this.level === 'planet') return 'system';
    if (this.level === 'atomic' || this.level === 'subatomic') return 'micro';
    return this.level;
  }

  changeSpeed(delta: number): void {
    const k = this.timeKey();
    const steps = TIME_STEPS[k];
    if (!steps) return;
    this.timeIndex[k] = clamp((this.timeIndex[k] ?? 0) + delta, 0, steps.values.length - 1);
    this.audio.play('click');
  }

  setSpeedIndex(i: number): void {
    const k = this.timeKey();
    const steps = TIME_STEPS[k];
    if (!steps) return;
    this.timeIndex[k] = clamp(Math.round(i), 0, steps.values.length - 1);
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.audio.play('click');
  }

  private updateCameraLimits(): void {
    const rig = this.engine.rig;
    if (this.ow.surface) return;
    if (this.level === 'system' || this.level === 'planet') {
      const sel = this.selectedBody();
      const followed = sel && (rig.mode === 'follow' || rig.mode === 'cinematic' || rig.isFlying() || this.isNear(sel));
      if (sel && followed) {
        const r = km2au(sel.radius);
        const surf = sel.kind === 'blackhole' ? r * 1.6 : sel.kind === 'nebula' || sel.kind === 'darkmatter' ? r * 0.05 : r * 1.0004 + km2au(0.0005);
        rig.minDistance = surf;
        // niveau « planétaire » quand la caméra est proche de la surface
        const near = rig.distance < r * 6 && !!sel.planet;
        const lvl: ScaleLevel = near ? 'planet' : 'system';
        if (lvl !== this.level) { this.level = lvl; this.bus.emit('level', lvl); }
      } else {
        rig.minDistance = km2au(0.002);
        if (this.level === 'planet') { this.level = 'system'; this.bus.emit('level', 'system'); }
      }
    }
  }

  private isNear(b: { pos: Vec3; radius: number }): boolean {
    const rig = this.engine.rig;
    const d = Math.hypot(rig.target.x - b.pos.x, rig.target.y - b.pos.y, rig.target.z - b.pos.z);
    return d < km2au(b.radius) * 1.5;
  }

  selectedBody() {
    return this.selectionId?.startsWith('b') ? this.world.get(Number(this.selectionId.slice(1))) : undefined;
  }

  // -------------------------------------------------------------------------
  // Échelles et transitions
  // -------------------------------------------------------------------------

  private onZoomLimit(dir: 'in' | 'out'): void {
    if (this.transitioning) return;
    if (this.ow.surface) {
      if (dir === 'out') this.ow.leaveSurface();
      else void this.goMicro();
      return;
    }
    const L = this.level;
    if (dir === 'out') {
      if (L === 'system' || L === 'planet') void this.goGalaxy();
      else if (L === 'galaxy') void this.goCosmic();
      else if (L === 'micro' || L === 'atomic' || L === 'subatomic') (this.views.micro as MicroView).zoomOut();
    } else {
      if (L === 'planet') {
        const b = this.selectedBody();
        if (b?.planet) void this.goMicro();
      } else if (L === 'galaxy') {
        const id = this.selectionId;
        if (id?.startsWith('s')) void this.enterStar(Number(id.slice(1)));
      } else if (L === 'cosmic') {
        const id = this.selectionId;
        if (id?.startsWith('g')) void this.enterGalaxy(id.slice(1));
      } else if (L === 'micro' || L === 'atomic') {
        (this.views.micro as MicroView).zoomIn();
      }
    }
  }

  private async fadeTo(fn: () => void, color = '#000'): Promise<void> {
    this.transitioning = true;
    this.fade.style.background = color;
    this.fade.classList.add('on');
    this.audio.play('whoosh');
    await new Promise((r) => setTimeout(r, 380));
    try {
      fn();
    } finally {
      this.frame(0.016);
      this.fade.classList.remove('on');
      setTimeout(() => (this.transitioning = false), 400);
    }
  }

  switchView(level: ScaleLevel, view: View): void {
    this.view.exit();
    this.view = view;
    this.level = level;
    this.labels.clear();
    this.engine.lenses = [];
    this.engine.ripples = [];
    view.enter();
    this.engine.rig.renderScale = view.renderScale;
    this.select(null);
    this.bus.emit('level', level);
    this.audio.setMood(level === 'cosmic' || level === 'galaxy' ? 'cosmic' : level === 'micro' ? 'micro' : 'calm');
  }

  /** Mémorise l'état du système courant (persistance des conséquences). */
  storeCurrentSystem(): void {
    this.universe.systems[this.systemKey] = snapshotWorld(this.world, 6000);
    const keys = Object.keys(this.universe.systems);
    if (keys.length > 40) delete this.universe.systems[keys.find((k) => k !== this.systemKey)!];
  }

  /** Charge (ou génère) la galaxie courante. */
  ensureGalaxy(): void {
    const gid = this.universe.location.galaxyId;
    if (this.galaxy && this.currentGalaxy?.params.id === gid) return;
    let cg = this.findCosmicGalaxy(gid);
    if (!cg) cg = this.findCosmicGalaxy('home')!;
    const params = this.universe.galaxyOverrides[cg.id] ?? galaxyParamsFor(cg, this.engine.settings.galaxyStars);
    params.starCount = this.engine.settings.galaxyStars;
    this.currentGalaxy = { params, cosmic: cg };
    this.galaxy = GalaxySim.create(params);
    // étoile du Soleil : à ~26 kal du centre dans le disque
    if (cg.id === 'home') {
      let best = 0, bd = Infinity;
      for (let i = 0; i < this.galaxy.n; i++) {
        const x = this.galaxy.pos[i * 3], y = this.galaxy.pos[i * 3 + 1], z = this.galaxy.pos[i * 3 + 2];
        const d = Math.abs(Math.hypot(x, z) - 26) + Math.abs(y) * 4;
        if (d < bd) { bd = d; best = i; }
      }
      this.solIndex = best;
    }
    (this.views.galaxy as GalaxyView).setGalaxy(this.galaxy, params);
  }

  /** Mémorise les paramètres de la galaxie courante (persistance). */
  storeGalaxyState(): void {
    if (this.currentGalaxy) this.universe.galaxyOverrides[this.currentGalaxy.params.id] = { ...this.currentGalaxy.params };
  }

  findCosmicGalaxy(id: string): CosmicGalaxy | undefined {
    if (id === 'home') return this.cosmic.sector(0, 0, 0).find((g) => g.id === 'home');
    const custom = this.universe.customGalaxies.find((g) => g.id === id);
    if (custom) return custom;
    return (this.views.cosmic as CosmicView).galaxyById(id);
  }

  async goGalaxy(): Promise<void> {
    if (this.level === 'galaxy') return;
    if (this.level === 'system' || this.level === 'planet') {
      // monde ouvert : pas de coupure, la caméra recule continûment dans la galaxie
      this.ow.systemToGalaxy(true);
      const p = (this.views.galaxy as GalaxyView).starPosition(this.currentStarIndex());
      this.engine.rig.flyTo(p, 0.6, 3);
      return;
    }
    await this.fadeTo(() => {
      if (this.level === 'system' || this.level === 'planet') this.storeCurrentSystem();
      this.ensureGalaxy();
      const gv = this.views.galaxy as GalaxyView;
      this.switchView('galaxy', gv);
      const idx = this.currentStarIndex();
      const p = gv.starPosition(idx);
      this.engine.rig.set(p, 0.004);
      this.engine.rig.flyTo(p, 0.6, 2.5);
      this.select(`s${idx}`);
      this.toast(`Échelle galactique : ${this.currentGalaxy!.params.name}. Les étoiles sont des traceurs dans un potentiel galactique (approximation).`, 'science');
    });
  }

  currentStarIndex(): number {
    if (this.systemKey === 'sol') return this.solIndex;
    const parts = this.systemKey.split(':');
    return Number(parts[1] ?? 0) || 0;
  }

  async goCosmic(): Promise<void> {
    if (this.level === 'cosmic') return;
    if (this.level === 'galaxy' || this.level === 'system' || this.level === 'planet') {
      if (this.level !== 'galaxy') this.ow.systemToGalaxy(true);
      this.ow.galaxyToCosmic(true);
      const g = this.currentGalaxy?.cosmic;
      const p = g ? (this.views.cosmic as CosmicView).positionOf(`g${g.id}`) : null;
      if (p) this.engine.rig.flyTo(p, 40, 3.5);
      return;
    }
    await this.fadeTo(() => {
      if (this.level === 'system' || this.level === 'planet') this.storeCurrentSystem();
      const cv = this.views.cosmic as CosmicView;
      this.switchView('cosmic', cv);
      const gid = this.universe.location.galaxyId;
      const g = this.findCosmicGalaxy(gid) ?? this.findCosmicGalaxy('home')!;
      const p = cv.positionOf(`g${g.id}`) ?? { x: 0, y: 0, z: 0 };
      this.engine.rig.set(p, 0.25);
      this.engine.rig.flyTo(p, 40, 2.5);
      this.select(`g${g.id}`);
      this.toast('Échelle cosmique : toile cosmique de galaxies générée à la demande (secteurs de 25 Mpc).', 'science');
    });
  }

  async enterGalaxy(id: string): Promise<void> {
    const g = this.findCosmicGalaxy(id);
    if (!g) return;
    if (this.level === 'cosmic') {
      const p = (this.views.cosmic as CosmicView).positionOf(`g${g.id}`);
      if (p) {
        this.engine.rig.set(p, Math.max(g.size * 2, 0.015));
        this.engine.rig.update(0);
        this.ow.cosmicToGalaxy(g);
        this.engine.rig.flyTo({ x: 0, y: 0, z: 0 }, (this.currentGalaxy?.params.radius ?? 40) * 3, 3);
        return;
      }
    }
    await this.fadeTo(() => {
      this.universe.location.galaxyId = g.id;
      this.galaxy = null;
      this.ensureGalaxy();
      const gv = this.views.galaxy as GalaxyView;
      this.switchView('galaxy', gv);
      const R = this.currentGalaxy!.params.radius;
      this.engine.rig.set({ x: 0, y: 0, z: 0 }, R * 8);
      this.engine.rig.flyTo({ x: 0, y: 0, z: 0 }, R * 3, 2.5);
      this.toast(`Entrée dans ${g.name} (${this.currentGalaxy!.params.type}).`, 'info');
    });
  }

  /** Entre dans le système d'une étoile de la galaxie courante. */
  async enterStar(idx: number): Promise<void> {
    if (!this.galaxy || !this.currentGalaxy) return;
    if (this.level === 'galaxy') {
      // monde ouvert : la caméra plonge vers l'étoile, sans coupure
      const sp = (this.views.galaxy as GalaxyView).starPosition(idx);
      this.engine.rig.set(sp, 0.003);
      this.engine.rig.update(0);
      this.ow.galaxyToSystem(idx);
      const p = this.world.primary();
      if (p) this.engine.rig.flyTo(p.pos, this.systemExtent() * 2.2, 3);
      return;
    }
    const params = this.currentGalaxy.params;
    const key = params.id === 'home' && idx === this.solIndex ? 'sol' : `${params.id}:${idx}`;
    await this.fadeTo(() => {
      this.systemKey = key;
      this.universe.location.systemKey = key;
      this.loadSystem(key, idx);
      this.switchView('system', this.views.system);
      const p = this.world.primary();
      if (p) {
        this.engine.rig.set(p.pos, 3e4);
        this.engine.rig.flyTo(p.pos, this.systemExtent() * 2.2, 2.5);
        this.select(`b${p.id}`);
      }
    });
  }

  /** Taille caractéristique du système (UA). */
  systemExtent(): number {
    const p = this.world.primary();
    if (!p) return 10;
    let m = 1;
    for (const b of this.world.bodies) {
      if (b.kind === 'nebula') { m = Math.max(m, km2au(b.radius)); continue; }
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y, b.pos.z - p.pos.z);
      if (d < 1000) m = Math.max(m, d);
    }
    return m;
  }

  loadSystem(key: string, idx: number): void {
    this.history.clear();
    const stored = this.universe.systems[key];
    if (stored) {
      restoreWorld(this.world, stored);
      return;
    }
    if (key === 'sol') {
      generateSolarSystem(this.world);
      return;
    }
    const gp = this.currentGalaxy?.params;
    const seed = starSystemSeed(gp?.seed ?? 1, idx);
    const g = this.galaxy;
    const mass = g ? g.starMass[idx] : undefined;
    const r = (seed % 1000) / 1000;
    const central = r < 0.01 ? 'blackhole' : r < 0.04 ? 'nebula' : 'star';
    generateSystem(this.world, { seed, starMass: mass && central === 'star' ? clamp(mass, 0.08, 60) : undefined, centralKind: central, name: undefined });
  }

  async goMicro(): Promise<void> {
    const b = this.selectedBody();
    await this.fadeTo(() => {
      this.storeCurrentSystem();
      const mv = this.views.micro as MicroView;
      mv.setSource(b ?? null);
      this.switchView('micro', mv);
      this.toast('Échelle microscopique : représentation stylisée de la matière (règles simplifiées).', 'science');
    }, '#0a1420');
  }

  async leaveMicro(): Promise<void> {
    await this.fadeTo(() => {
      this.switchView('system', this.views.system);
      const src = (this.views.micro as MicroView).source;
      const b = src ? this.world.get(src.id) : this.world.primary();
      if (b) {
        this.engine.rig.set(b.pos, km2au(b.radius) * 1.01);
        this.engine.rig.flyTo(b.pos, km2au(b.radius) * 3.5, 2);
        this.select(`b${b.id}`);
        this.engine.rig.mode = 'follow';
      }
    });
  }

  async goBigBang(): Promise<void> {
    await this.fadeTo(() => {
      if (this.level === 'system' || this.level === 'planet') this.storeCurrentSystem();
      this.switchView('bigbang', this.views.bigbang);
    }, '#fff');
  }

  /** Navigation par le fil d'Ariane des échelles. */
  async jumpToLevel(l: ScaleLevel): Promise<void> {
    if (l === this.level) return;
    if (l === 'cosmic') return this.goCosmic();
    if (l === 'galaxy') return this.goGalaxy();
    if (l === 'bigbang') return this.goBigBang();
    if (l === 'micro' || l === 'atomic' || l === 'subatomic') {
      if (this.level === 'micro' || this.level === 'atomic' || this.level === 'subatomic') {
        (this.views.micro as MicroView).setSubLevel(l);
        return;
      }
      if (!this.selectedBody()?.planet) {
        const pl = this.world.bodies.find((b) => b.planet && !b.planet.gasGiant) ?? this.world.bodies.find((b) => b.planet);
        if (pl) this.select(`b${pl.id}`);
      }
      await this.goMicro();
      (this.views.micro as MicroView).setSubLevel(l);
      return;
    }
    if (l === 'system' || l === 'planet') {
      if (this.level === 'micro' || this.level === 'atomic' || this.level === 'subatomic') return this.leaveMicro();
      if (this.level === 'galaxy') return this.enterStar(this.currentStarIndex());
      if (this.level === 'cosmic' || this.level === 'bigbang') {
        await this.fadeTo(() => {
          this.ensureGalaxy();
          this.loadSystem(this.systemKey, this.currentStarIndex());
          this.switchView('system', this.views.system);
          const p = this.world.primary();
          if (p) this.engine.rig.set(p.pos, this.systemExtent() * 2.2);
        });
      }
      if (l === 'planet') {
        const pl = this.world.bodies.find((b) => b.name === 'Terre') ?? this.world.bodies.find((b) => b.planet);
        if (pl) this.focus(`b${pl.id}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sélection, caméra
  // -------------------------------------------------------------------------

  select(id: string | null, fly = false): void {
    this.selectionId = id;
    this.bus.emit('select', id);
    if (id && fly) this.focus(id);
  }

  focus(id: string): void {
    if (id.startsWith('n')) { this.ow.travelToStar(Number(id.slice(1))); return; }
    const p = this.view.positionOf(id);
    if (!p) return;
    this.selectionId = id;
    this.bus.emit('select', id);
    const d = this.view.framingDistance(id);
    this.engine.rig.flyTo(p, d, 1.8);
    if (this.engine.rig.mode === 'orbit' || this.engine.rig.mode === 'free') this.engine.rig.mode = 'follow';
    this.audio.play('whoosh');
  }

  shakeCamera(k: number): void {
    this.engine.rig.shake = Math.max(this.engine.rig.shake, k);
  }

  /** Vue rapprochée de la surface (exploration). */
  exploreSurface(): void {
    if (this.ow.land()) return;
    const b = this.selectedBody();
    if (!b?.planet) return;
    const rig = this.engine.rig;
    rig.mode = 'follow';
    rig.flyTo(b.pos, km2au(b.radius) * 1.003 + km2au(2), 2.5);
    rig.pitch = 0.02;
    this.toast(`Exploration de la surface de ${b.name} — molette pour descendre, zoom extrême : microscope.`, 'info');
  }

  // -------------------------------------------------------------------------
  // Interaction souris / outils divins
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    const c = this.engine.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.started) return;
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if ((this.level === 'system' || this.level === 'planet') && e.button === 0) {
        const pick = this.view.pick(px, py);
        if (this.tool === 'move' && pick?.kind === 'body') {
          const b = this.world.get(Number(pick.id.slice(1)));
          if (b) {
            this.history.record(`Déplacement de ${b.name}`);
            const n = this.engine.rig.forward();
            this.dragState = { id: b.id, plane: new THREE.Plane(new THREE.Vector3(n.x, n.y, n.z), 0), start: { ...b.pos } };
            this.engine.rig.enabled = false;
            this.select(pick.id);
          }
        } else if (this.tool === 'push' && pick?.kind === 'body') {
          this.pushState = { id: Number(pick.id.slice(1)), x: px, y: py, line: null };
          this.engine.rig.enabled = false;
          this.select(pick.id);
        }
      }
    });
    window.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (this.dragState) {
        const b = this.world.get(this.dragState.id);
        if (!b) return;
        const p = this.screenToPlane(px, py, b.pos);
        if (p) { b.pos = p; this.world.version++; }
      }
      if (this.pushState) this.drawPushArrow(px, py);
    });
    window.addEventListener('pointerup', (e) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (this.dragState) {
        const b = this.world.get(this.dragState.id);
        if (b) {
          const parent = b.parentId !== undefined ? this.world.get(b.parentId) : this.world.primary();
          if (parent && parent !== b) {
            const r = Math.hypot(b.pos.x - parent.pos.x, b.pos.y - parent.pos.y, b.pos.z - parent.pos.z);
            // conserve une orbite circulaire autour du parent à la nouvelle distance
            const rel = { x: b.pos.x - parent.pos.x, z: b.pos.z - parent.pos.z };
            const ang = Math.atan2(rel.z, rel.x);
            const yOff = b.pos.y - parent.pos.y;
            this.world.placeInOrbit(b, parent, Math.hypot(r, 0), 0, ang);
            b.pos.y = parent.pos.y + yOff;
          }
          this.toast(`${b.name} déplacé(e) : nouvelle orbite. Le système va réagir.`, 'divine');
          this.audio.play('whoosh');
          this.bus.emit('history', undefined);
        }
        this.dragState = null;
        this.engine.rig.enabled = true;
        return;
      }
      if (this.pushState) {
        const st = this.pushState;
        this.pushState = null;
        this.engine.rig.enabled = true;
        this.overlay.innerHTML = '';
        const dx = px - st.x, dy = py - st.y;
        const len = Math.hypot(dx, dy);
        const b = this.world.get(st.id);
        if (b && len > 5) {
          const r = this.engine.rig.right(), u = this.engine.rig.up();
          const vScale = Math.max(0.05, Math.hypot(b.vel.x, b.vel.y, b.vel.z)) * (len / 300);
          const dir = { x: (r.x * dx - u.x * dy) / len, y: (r.y * dx - u.y * dy) / len, z: (r.z * dx - u.z * dy) / len };
          this.history.record(`Poussée de ${b.name}`);
          this.world.applyImpulse(b.id, { x: dir.x * vScale, y: dir.y * vScale, z: dir.z * vScale });
          this.toast(`Impulsion de ${(vScale / 0.21095).toFixed(1)} km/s appliquée à ${b.name}`, 'divine');
          this.audio.play('whoosh');
          this.bus.emit('history', undefined);
        }
        return;
      }
      if (e.button !== 0 || !this.engine.rig.clickCandidate || (e.target as HTMLElement) !== c) return;
      this.engine.rig.clickCandidate = false;
      this.onCanvasClick(px, py);
    });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const pick = this.view.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (pick) this.focus(pick.id);
    });
  }

  private drawPushArrow(px: number, py: number): void {
    const st = this.pushState!;
    this.overlay.innerHTML = `<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#ffcc55"/></marker></defs><line x1="${st.x}" y1="${st.y}" x2="${px}" y2="${py}" stroke="#ffcc55" stroke-width="2.5" marker-end="url(#ah)"/>`;
  }

  /** Intersection du rayon écran avec le plan horizontal (ou de vue) passant par `through`. */
  screenToPlane(px: number, py: number, through?: Vec3): Vec3 | null {
    const rig = this.engine.rig;
    const cam = rig.camera;
    const ndc = new THREE.Vector3((px / this.engine.width) * 2 - 1, -(py / this.engine.height) * 2 + 1, 0.5);
    ndc.unproject(cam);
    const dir = ndc.normalize();
    const ref = through ?? rig.target;
    // plan horizontal y = ref.y en coordonnées relatives à l'œil
    const scale = this.view.renderScale;
    const py0 = (ref.y - rig.eye.y) * scale;
    let t: number;
    if (Math.abs(dir.y) > 0.08) t = py0 / dir.y;
    else t = -1;
    if (!(t > 0)) {
      // plan perpendiculaire à la visée
      const f = rig.forward();
      const rel = { x: (ref.x - rig.eye.x) * scale, y: (ref.y - rig.eye.y) * scale, z: (ref.z - rig.eye.z) * scale };
      const dn = dir.x * f.x + dir.y * f.y + dir.z * f.z;
      t = (rel.x * f.x + rel.y * f.y + rel.z * f.z) / Math.max(dn, 1e-6);
    }
    if (!Number.isFinite(t) || t <= 0) return null;
    return { x: rig.eye.x + (dir.x * t) / scale, y: rig.eye.y + (dir.y * t) / scale, z: rig.eye.z + (dir.z * t) / scale };
  }

  private onCanvasClick(px: number, py: number): void {
    if (!this.started) return;
    const pick = this.view.pick(px, py);
    const sys = this.level === 'system' || this.level === 'planet';
    if (sys && this.tool === 'create') {
      const pos = this.screenToPlane(px, py);
      if (pos) this.createAt(pos);
      return;
    }
    if (sys && this.tool === 'destroy' && pick?.kind === 'body') {
      const b = this.world.get(Number(pick.id.slice(1)));
      if (b) {
        this.history.record(`Destruction de ${b.name}`);
        this.world.explode(b.id);
        this.universe.stats.destructions++;
        this.bus.emit('history', undefined);
      }
      return;
    }
    if (sys && this.tool === 'collide' && pick?.kind === 'body') {
      const id = Number(pick.id.slice(1));
      if (this.collideFirst === null || !this.world.get(this.collideFirst)) {
        this.collideFirst = id;
        this.toast(`Projectile : ${pick.label}. Choisissez maintenant la cible.`, 'divine');
        this.select(pick.id);
      } else if (this.collideFirst !== id) {
        const a = this.world.get(this.collideFirst)!;
        this.history.record(`Collision ${a.name} → ${pick.label}`);
        this.world.collide(this.collideFirst, id, 40);
        this.collideFirst = null;
        this.audio.setMood('destruction', 12);
        this.bus.emit('history', undefined);
      }
      return;
    }
    if (this.level === 'micro' || this.level === 'atomic' || this.level === 'subatomic') {
      (this.views.micro as MicroView).onClick(px, py, pick);
      return;
    }
    this.select(pick?.id ?? null);
    if (pick) this.audio.play('click');
  }

  // -------------------------------------------------------------------------
  // Création
  // -------------------------------------------------------------------------

  setTool(t: Tool): void {
    this.tool = t;
    this.collideFirst = null;
    this.bus.emit('tool', t);
    this.audio.play('click');
  }

  /** Crée l'objet défini par `creation` à une position (UA). Retourne l'identifiant. */
  createAt(pos: Vec3, spec: CreationSpec = this.creation): number | null {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      this.toast('Position de création invalide.', 'error');
      return null;
    }
    const s = spec;
    let body = null;
    let label = '';
    try {
      switch (s.type) {
        case 'matter': {
          if (!s.matter) return null;
          if (s.matter.matter === 'energy') {
            this.history.record('Impulsion de rayonnement');
            this.world.radiationBurst(pos, Math.pow(10, 30 + sanitize(s.matter.amount, 1, 0, 1e7) ** 0.1 * 8));
            this.audio.play('explosion', 1.2);
            this.bus.emit('history', undefined);
            return null;
          }
          if (s.matter.matter === 'particles') {
            void this.goMicro();
            return null;
          }
          body = bodyFromMatter({ ...s.matter, pos });
          label = s.matter.matter;
          break;
        }
        case 'star':
          body = makeStar({ ...s.star, pos });
          break;
        case 'planet':
          body = makePlanet({ ...s.planet, pos });
          break;
        case 'blackhole':
          body = makeBlackHole({ ...s.blackhole, pos });
          break;
        case 'nebula':
          body = makeNebula({ ...s.nebula, pos });
          break;
        case 'darkmatter':
          body = makeDarkMatter({ ...s.darkmatter, pos });
          break;
      }
    } catch (e) {
      this.toast(`Création impossible : ${(e as Error).message}`, 'error');
      return null;
    }
    if (!body) return null;
    void label;
    this.history.record(`Création : ${body.name}`);
    body.createdBy = 'player';
    // vitesse initiale
    const host = this.dominantAt(pos, body.mass);
    if (s.orbit === 'circular' && host) {
      const r = Math.hypot(pos.x - host.pos.x, pos.y - host.pos.y, pos.z - host.pos.z);
      const ang = Math.atan2(pos.z - host.pos.z, pos.x - host.pos.x);
      this.world.placeInOrbit(body, host, r, 0, ang);
      body.pos.y = pos.y;
    } else if (host) {
      body.vel = { ...host.vel };
      if (s.speedKms) {
        const f = this.engine.rig.forward();
        const v = s.speedKms * 0.21095;
        body.vel.x += f.x * v; body.vel.y += f.y * v; body.vel.z += f.z * v;
      }
    }
    try {
      this.world.add(body);
    } catch (e) {
      this.toast(`Création impossible : ${(e as Error).message}`, 'error');
      return null;
    }
    if (body.kind === 'blackhole' && s.blackhole?.environment) this.world.addAccretionMatter(body.id, s.blackhole.environment);
    this.world.refreshDerived(body);
    this.universe.stats.creations++;
    this.audio.play('create');
    this.audio.setMood('creation', 8);
    (this.views.system as SystemView).spawnEffect(pos, 1.5, 'flash', 0xa0d8ff);
    this.select(`b${body.id}`);
    this.bus.emit('history', undefined);
    return body.id;
  }

  /** Corps dominant gravitationnellement en un point (pour l'orbite initiale). */
  dominantAt(pos: Vec3, mass = 0): ReturnType<World['primary']> {
    let best: ReturnType<World['primary']>;
    let bestAcc = 0;
    for (const b of this.world.bodies) {
      if (b.kind === 'nebula' || b.mass <= mass) continue;
      const d2 = (b.pos.x - pos.x) ** 2 + (b.pos.y - pos.y) ** 2 + (b.pos.z - pos.z) ** 2;
      // critère de Hill approximé : accélération pondérée
      const acc = b.mass / Math.max(d2, 1e-12) * (b.kind === 'star' || b.kind === 'blackhole' ? 1 : 0.6);
      if (acc > bestAcc && Math.sqrt(d2) > km2au(b.radius) * 1.5) { bestAcc = acc; best = b; }
    }
    return best ?? this.world.primary();
  }

  // -------------------------------------------------------------------------
  // Évènements de simulation
  // -------------------------------------------------------------------------

  private onSimEvent(e: SimEvent): void {
    this.bus.emit('simevent', e);
    const sv = this.views.system as SystemView;
    const pos = e.pos;
    switch (e.type) {
      case 'supernova':
        this.audio.play('supernova');
        this.audio.setMood('destruction', 20);
        if (pos) { sv.spawnEffect(pos, 6, 'flash', 0xffffff); sv.spawnEffect(pos, 5, 'shell', 0x80c0ff); }
        this.shakeCamera(1.5);
        this.toast(e.message, 'warn');
        break;
      case 'bhmerger':
        this.audio.play('chirp');
        if (pos) { sv.gravitationalWave(pos, 2.5); sv.spawnEffect(pos, 3, 'flash', 0xc0d8ff); }
        this.toast(e.message, 'science');
        break;
      case 'collision':
      case 'destroy':
        this.audio.play(e.magnitude && e.magnitude > 3 ? 'explosion' : 'impact', (e.magnitude ?? 1) / 2);
        if (pos) { sv.spawnEffect(pos, e.magnitude ?? 1, 'flash', 0xffb070); if ((e.magnitude ?? 0) > 2.5) sv.spawnEffect(pos, e.magnitude ?? 1, 'shell', 0xff9050); }
        if ((e.magnitude ?? 0) > 2) this.shakeCamera(0.6);
        break;
      case 'tidal':
      case 'swallow':
        this.audio.play('impact', 0.8);
        if (pos) sv.spawnEffect(pos, 2, 'flash', 0xffa060);
        this.toast(e.message, 'warn');
        break;
      case 'ignite':
      case 'life':
      case 'phase':
        this.toast(e.message, 'science');
        this.audio.play('confirm');
        break;
      case 'merge':
        if (pos) sv.spawnEffect(pos, e.magnitude ?? 1, 'flash');
        this.audio.play('impact', 0.6);
        break;
    }
  }

  toast(text: string, kind: 'info' | 'warn' | 'error' | 'science' | 'divine' = 'info'): void {
    this.bus.emit('toast', { text, kind });
  }

  // -------------------------------------------------------------------------
  // Pouvoirs sur l'objet sélectionné
  // -------------------------------------------------------------------------

  act(action: string, arg?: number): void {
    const b = this.selectedBody();
    const w = this.world;
    const rec = (l: string) => this.history.record(l);
    switch (action) {
      case 'supernova':
        if (b) { rec(`Supernova de ${b.name}`); if (!w.forceSupernova(b.id)) this.toast('Seules les étoiles peuvent exploser en supernova.', 'error'); }
        break;
      case 'age':
        if (b) { rec(`Vieillissement de ${b.name}`); w.ageStar(b.id, arg ?? 1.0); }
        break;
      case 'explode':
        if (b) { rec(`Destruction de ${b.name}`); w.explode(b.id); this.select(null); }
        break;
      case 'impact':
        if (b) { rec(`Impact sur ${b.name}`); w.asteroidImpact(b.id, arg ?? 0.001, 25); this.audio.setMood('destruction', 10); }
        break;
      case 'feed': {
        const bh = w.bodies.find((x) => x.kind === 'blackhole');
        if (b && bh && b !== bh) { rec(`${b.name} jeté dans ${bh.name}`); w.feedBlackHole(bh.id, b.id); }
        else this.toast('Il faut un trou noir dans le système (et un autre objet sélectionné).', 'error');
        break;
      }
      case 'accrete':
        if (b?.kind === 'blackhole') { rec('Ajout de matière'); w.addAccretionMatter(b.id, arg ?? 0.05); }
        break;
      case 'bhbinary':
        if (b?.kind === 'blackhole') {
          rec('Binaire de trous noirs');
          const c = makeBlackHole({ mass: b.mass * 0.7, spin: 0.5 });
          c.createdBy = 'player';
          w.add(c);
          w.placeInOrbit(c, b, Math.max(0.002, km2au(b.radius) * 400), 10, 0);
          this.toast('Binaire formée : le rayonnement gravitationnel (amplifié par le pouvoir divin) va la faire spiraler.', 'divine');
        }
        break;
      case 'pin':
        if (b) b.pinned = !b.pinned;
        break;
      case 'circularize':
        if (b) {
          const p = b.parentId !== undefined ? w.get(b.parentId) : w.primary();
          if (p && p !== b) { rec(`Orbite circulaire de ${b.name}`); w.placeInOrbit(b, p, Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y, b.pos.z - p.pos.z), 0, Math.atan2(b.pos.z - p.pos.z, b.pos.x - p.pos.x)); }
        }
        break;
      case 'stop':
        if (b) { rec(`Arrêt de ${b.name}`); const p = w.primary(); b.vel = p && p !== b ? { ...p.vel } : { x: 0, y: 0, z: 0 }; }
        break;
      case 'addmoon':
        if (b?.planet) {
          rec(`Lune pour ${b.name}`);
          const m = makePlanet({ mass: Math.min(b.mass * 0.012, 0.0123 * M_EARTH_SUN * 3), kind: 'moon', gasGiant: false, pressure: 0, waterFraction: 0 });
          m.createdBy = 'player';
          w.add(m);
          w.placeInOrbit(m, b, km2au(b.radius) * (20 + Math.random() * 40), Math.random() * 10, Math.random() * 6.28);
        }
        break;
    }
    this.bus.emit('history', undefined);
  }

  undo(): void {
    const l = this.history.undo();
    if (l) { this.toast(`Annulé : ${l}`, 'info'); this.audio.play('click'); }
    this.bus.emit('history', undefined);
  }

  redo(): void {
    const l = this.history.redo();
    if (l) { this.toast(`Rétabli : ${l}`, 'info'); this.audio.play('click'); }
    this.bus.emit('history', undefined);
  }

  // -------------------------------------------------------------------------
  // Cosmologie
  // -------------------------------------------------------------------------

  setCosmology(p: Partial<CosmoParams>): void {
    this.universe.cosmology = sanitizeCosmo({ ...this.universe.cosmology, ...p });
    this.cosmoHistory = integrateHistory(this.universe.cosmology, 400);
    if (!Number.isFinite(this.cosmoHistory.age)) this.universe.cosmicTime = Math.min(this.universe.cosmicTime, this.cosmoHistory.tEnd * 0.9 || 10);
  }

  scaleFactorNow(): number {
    return scaleFactorAt(this.cosmoHistory, this.universe.cosmicTime);
  }

  /** Scénarios de fin d'univers (fictifs ou hypothétiques). */
  endOfUniverse(kind: 'bigrip' | 'bigcrunch' | 'bigfreeze' | 'vacuum'): void {
    const base = { ...PLANCK18 };
    if (kind === 'bigrip') this.setCosmology({ ...base, w: -1.6 });
    if (kind === 'bigcrunch') this.setCosmology({ ...base, omegaM: 2.5, omegaL: -0.3 });
    if (kind === 'bigfreeze') this.setCosmology(base);
    (this.views.cosmic as CosmicView).startScenario(kind);
    if (this.level !== 'cosmic') void this.goCosmic();
    this.timeIndex.cosmic = 5;
    this.audio.setMood('destruction', 30);
    this.toast(
      kind === 'vacuum'
        ? 'Désintégration du vide : scénario hypothétique (spéculatif) — une bulle de « vrai vide » s\'étend à la vitesse de la lumière.'
        : kind === 'bigrip' ? 'Big Rip : énergie fantôme w = −1,6 (hypothétique). Les structures seront déchirées.'
          : kind === 'bigcrunch' ? 'Big Crunch : densité de matière très élevée et constante cosmologique négative.' : 'Big Freeze : expansion éternelle (modèle standard).',
      'divine',
    );
  }

  // -------------------------------------------------------------------------
  // Univers et sauvegardes
  // -------------------------------------------------------------------------

  newUniverse(name: string, seed: number, silent = false): void {
    if (this.ow) { this.ow.surface = null; this.ow.autopilot = null; this.engine.rig.external = null; }
    this.world.clear();
    generateSolarSystem(this.world);
    this.history.clear();
    this.universe = emptyUniverse(name, seed, this.world);
    this.cosmic = new CosmicGenerator(seed);
    (this.views.cosmic as CosmicView).reset();
    this.cosmoHistory = integrateHistory(this.universe.cosmology, 200);
    this.galaxy = null;
    this.currentGalaxy = null;
    this.systemKey = 'sol';
    this.ensureGalaxy();
    this.micro.clear();
    this.switchView('system', this.views.system);
    const sun = this.world.primary()!;
    this.engine.rig.set(sun.pos, 45);
    this.engine.rig.yaw = 0.5;
    this.engine.rig.pitch = 0.45;
    this.engine.rig.mode = 'orbit';
    if (!silent) this.toast(`Nouvel univers « ${name} » (graine ${seed}).`, 'info');
    this.bus.emit('universe', this.universe);
  }

  /** Construit la sauvegarde à partir de l'état courant. */
  buildSave(): UniverseSave {
    const u = this.universe;
    if (this.level === 'system' || this.level === 'planet') this.storeCurrentSystem();
    u.current = this.universe.systems[this.systemKey] ?? snapshotWorld(this.world);
    u.location = { level: this.level === 'planet' ? 'system' : this.level, galaxyId: this.universe.location.galaxyId, systemKey: this.systemKey };
    u.micro = this.micro.toJSON();
    if (this.currentGalaxy) u.galaxyOverrides[this.currentGalaxy.params.id] = { ...this.currentGalaxy.params };
    return u;
  }

  save(label = 'Sauvegarde manuelle'): boolean {
    try {
      const u = this.buildSave();
      this.store.save(u, label);
      this.toast(`Univers « ${u.name} » sauvegardé.`, 'info');
      this.audio.play('confirm');
      this.bus.emit('saved', u.id);
      return true;
    } catch (e) {
      this.toast((e as Error).message, 'error');
      this.audio.play('error');
      return false;
    }
  }

  /** Applique un univers chargé. */
  applySave(u: UniverseSave): void {
    this.ow.surface = null;
    this.ow.autopilot = null;
    this.engine.rig.external = null;
    this.universe = u;
    this.cosmic = new CosmicGenerator(u.seed);
    (this.views.cosmic as CosmicView).reset();
    if (u.bigBang) (this.views.bigbang as BigBangView).adoptSilently(u.bigBang.seed, u.bigBang.params);
    this.cosmoHistory = integrateHistory(u.cosmology, 200);
    this.systemKey = u.location.systemKey;
    this.galaxy = null;
    this.currentGalaxy = null;
    this.ensureGalaxy();
    restoreWorld(this.world, u.current);
    this.history.clear();
    this.micro.loadJSON(u.micro);
    this.switchView('system', this.views.system);
    const p = this.world.primary();
    if (p) this.engine.rig.set(p.pos, this.systemExtent() * 2.2);
    this.bus.emit('universe', u);
    this.toast(`Univers « ${u.name} » chargé (${fmtYears(this.world.time)} de simulation locale).`, 'info');
  }

  load(id: string, version?: number): boolean {
    try {
      this.applySave(this.store.load(id, version));
      this.audio.play('confirm');
      return true;
    } catch (e) {
      this.toast(`Chargement impossible : ${(e as Error).message}`, 'error');
      return false;
    }
  }

  /** Point de restauration rapide (en mémoire). */
  quickSnapshots: { label: string; at: number; snap: WorldSnapshot; date: string }[] = [];
  checkpoint(label?: string): void {
    this.quickSnapshots.push({ label: label ?? `Point ${this.quickSnapshots.length + 1}`, at: this.world.time, snap: snapshotWorld(this.world, 8000), date: new Date().toLocaleTimeString('fr-FR') });
    if (this.quickSnapshots.length > 12) this.quickSnapshots.shift();
    this.toast('Point de restauration créé.', 'info');
    this.audio.play('confirm');
  }

  restoreCheckpoint(i: number): void {
    const s = this.quickSnapshots[i];
    if (!s) return;
    this.history.record('Restauration');
    restoreWorld(this.world, s.snap);
    this.toast(`Restauré : ${s.label}`, 'info');
    this.bus.emit('history', undefined);
  }

  /** Graine textuelle → entier. */
  static seedFrom(text: string): number {
    const n = Number(text);
    return Number.isFinite(n) && text.trim() !== '' ? Math.abs(Math.floor(n)) >>> 0 : hashString(text || 'superessence');
  }

  /** Distance d'affichage en années-lumière d'une étoile de la galaxie (pour l'UI). */
  static kalToLy(k: number): number {
    return k * 1000;
  }

  static auToLy(a: number): number {
    return a / LY_AU;
  }

  hashSeed(...v: number[]): number {
    return hashCombine(this.universe.seed, ...v);
  }

  setQuality(p: QualityPreset): void {
    const gs: GraphicsSettings = { preset: p, ...PRESETS[p] };
    this.engine.applySettings(gs);
    this.toast(`Qualité graphique : ${p}`, 'info');
  }
}
