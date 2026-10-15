import { sanitize } from '../core/units';
import { World, DEFAULT_SETTINGS, type WorldSettings } from '../sim/world';
import { emptyComposition, normalizeComposition, type Body, type BodyKind, type SimEvent } from '../sim/types';
import { PLANCK18, sanitizeCosmo, type CosmoParams } from '../sim/cosmology';
import type { CosmicGalaxy } from '../procgen/universe';
import type { GalaxyParams } from '../sim/galaxy';

/**
 * Format de sauvegarde versionné et validé. Toute donnée chargée passe par une
 * validation stricte : les champs invalides sont corrigés ou l'objet est rejeté.
 */
export const SAVE_FORMAT = 'superessence-universe';
export const SAVE_VERSION = 1;
/** Nombre maximal de particules conservées dans une sauvegarde (sous-échantillonnage). */
export const MAX_SAVED_PARTICLES = 12000;

export interface WorldSnapshot {
  time: number;
  nextId: number;
  bodies: Body[];
  particles: number[][];
  settings: WorldSettings;
  events: SimEvent[];
}

export type ScaleLevel = 'subatomic' | 'atomic' | 'micro' | 'planet' | 'system' | 'galaxy' | 'cosmic' | 'bigbang';

export interface UniverseLocation {
  level: ScaleLevel;
  galaxyId: string;
  /** Clé du système stellaire courant (« galaxie:index » ou « sol »). */
  systemKey: string;
}

export interface UniverseSave {
  format: typeof SAVE_FORMAT;
  version: number;
  id: string;
  name: string;
  seed: number;
  createdAt: string;
  updatedAt: string;
  cosmology: CosmoParams;
  /** Temps cosmique (Ga depuis le Big Bang). */
  cosmicTime: number;
  location: UniverseLocation;
  /** Galaxies créées par le joueur (vue cosmique). */
  customGalaxies: CosmicGalaxy[];
  /** Paramètres modifiés de galaxies existantes. */
  galaxyOverrides: Record<string, GalaxyParams>;
  /** Systèmes stellaires visités/modifiés (persistance des conséquences). */
  systems: Record<string, WorldSnapshot>;
  /** Système actif. */
  current: WorldSnapshot;
  micro: unknown;
  /** Univers issu du laboratoire cosmologique (graine + paramètres). */
  bigBang: { seed: number; params: CosmoParams } | null;
  stats: { playTimeS: number; creations: number; destructions: number };
}

const round = (v: number, d = 6) => (Number.isFinite(v) ? Number(v.toPrecision(d)) : 0);

export function snapshotWorld(w: World, maxParticles = MAX_SAVED_PARTICLES): WorldSnapshot {
  const P = w.particles;
  const stride = Math.max(1, Math.ceil(P.count / maxParticles));
  const parts: number[][] = [];
  for (let i = 0; i < P.count; i += stride) {
    parts.push([
      round(P.px[i], 9), round(P.py[i], 9), round(P.pz[i], 9), round(P.vx[i], 7), round(P.vy[i], 7), round(P.vz[i], 7),
      round(P.mass[i] * stride, 6), P.kind[i], round(P.temp[i], 4), Number.isFinite(P.life[i]) ? round(P.life[i], 4) : -1,
    ]);
  }
  return {
    time: w.time,
    nextId: w.nextId,
    bodies: JSON.parse(JSON.stringify(w.bodies)) as Body[],
    particles: parts,
    settings: { ...w.settings },
    events: w.events.slice(-150).map((e) => ({ ...e })),
  };
}

const KINDS: BodyKind[] = ['nebula', 'protostar', 'star', 'browndwarf', 'whitedwarf', 'neutronstar', 'blackhole', 'planet', 'moon', 'asteroid', 'comet', 'darkmatter'];

/** Valide et corrige un corps chargé. Retourne null si irrécupérable. */
export function validateBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as BodyKind;
  if (!KINDS.includes(kind)) return null;
  const mass = sanitize(r.mass, NaN, 1e-30, 1e14);
  if (!Number.isFinite(mass)) return null;
  const vec = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { x: sanitize(o.x, 0), y: sanitize(o.y, 0), z: sanitize(o.z, 0) };
  };
  const compRaw = (r.composition ?? {}) as Record<string, unknown>;
  const comp = emptyComposition();
  for (const k of Object.keys(comp) as (keyof typeof comp)[]) comp[k] = sanitize(compRaw[k], 0, 0, 1);
  const b: Body = {
    ...(r as unknown as Body),
    id: Math.round(sanitize(r.id, 0, 0, 1e12)),
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Objet',
    kind,
    mass,
    radius: sanitize(r.radius, 1000, 1e-6, 1e14),
    pos: vec(r.pos),
    vel: vec(r.vel),
    temperature: sanitize(r.temperature, 0, 0, 1e12),
    composition: normalizeComposition(comp),
    seed: Math.round(sanitize(r.seed, 1, 0, 2 ** 32)) >>> 0,
    createdBy: r.createdBy === 'player' ? 'player' : 'gen',
    age: sanitize(r.age, 0, 0, 1e14),
  };
  if (kind === 'blackhole') {
    const bh = (r.bh ?? {}) as Record<string, unknown>;
    b.bh = {
      spin: sanitize(bh.spin, 0.5, 0, 0.998),
      diskMass: sanitize(bh.diskMass, 0, 0, mass),
      accretionRate: sanitize(bh.accretionRate, 0, 0, 1e6),
      jets: bh.jets !== false,
      swallowed: sanitize(bh.swallowed, 0, 0, 1e14),
      axis: vec(bh.axis),
      luminosity: sanitize(bh.luminosity, 0, 0, 1e20),
      merger: undefined,
    };
    const l = Math.hypot(b.bh.axis.x, b.bh.axis.y, b.bh.axis.z);
    b.bh.axis = l > 0 ? { x: b.bh.axis.x / l, y: b.bh.axis.y / l, z: b.bh.axis.z / l } : { x: 0, y: 1, z: 0 };
  }
  if (r.planet && typeof r.planet === 'object') {
    const p = r.planet as Record<string, unknown>;
    b.planet = {
      waterFraction: sanitize(p.waterFraction, 0, 0, 1),
      continents: sanitize(p.continents, 0.5, 0, 1),
      pressure: sanitize(p.pressure, 0, 0, 1e5),
      rotationHours: sanitize(p.rotationHours, 24, 0.1, 1e6),
      axialTilt: sanitize(p.axialTilt, 0, 0, 180),
      volcanism: sanitize(p.volcanism, 0, 0, 1),
      magneticField: sanitize(p.magneticField, 0, 0, 100),
      albedo: sanitize(p.albedo, 0.3, 0, 0.99),
      greenhouse: sanitize(p.greenhouse, 0, 0, 200),
      life: Math.round(sanitize(p.life, 0, 0, 3)),
      lifeTimer: sanitize(p.lifeTimer, 0, 0, 1e12),
      hasRings: p.hasRings === true,
      ringInner: sanitize(p.ringInner, 1.3, 1, 20),
      ringOuter: sanitize(p.ringOuter, 2.3, 1, 30),
      terrainSeed: Math.round(sanitize(p.terrainSeed, 1, 0, 2 ** 32)) >>> 0,
      impacts: Array.isArray(p.impacts)
        ? (p.impacts as Record<string, unknown>[]).slice(-64).map((i) => ({ lat: sanitize(i?.lat, 0, -2, 2), lon: sanitize(i?.lon, 0, -4, 4), size: sanitize(i?.size, 0.1, 0, 1) }))
        : [],
      gasGiant: p.gasGiant === true,
    };
  } else if (kind === 'planet' || kind === 'moon' || kind === 'asteroid' || kind === 'comet') {
    return null;
  }
  if (r.star && typeof r.star === 'object') {
    const s = r.star as Record<string, unknown>;
    b.star = {
      phase: (typeof s.phase === 'string' ? s.phase : 'main') as NonNullable<Body['star']>['phase'],
      zamsMass: sanitize(s.zamsMass, mass, 0.01, 1000),
      metallicity: sanitize(s.metallicity, 0.014, 0, 0.2),
      age: sanitize(s.age, 0, 0, 1e14),
      luminosity: sanitize(s.luminosity, 1, 0, 1e12),
      msLifetime: sanitize(s.msLifetime, 1e10, 1e5, 1e14),
      rotationDays: sanitize(s.rotationDays, 25, 1e-9, 1e6),
    };
  } else if (kind === 'star' || kind === 'protostar') {
    return null;
  }
  if (r.nebula && typeof r.nebula === 'object') {
    const n = r.nebula as Record<string, unknown>;
    b.nebula = {
      gasTemperature: sanitize(n.gasTemperature, 15, 2.7, 1e10),
      density: sanitize(n.density, 1e4, 1e-6, 1e9),
      collapseProgress: sanitize(n.collapseProgress, 0, 0, 1),
      remnant: n.remnant === true,
      expansionSpeed: sanitize(n.expansionSpeed, 0, 0, 1e5),
      colorSeed: Math.round(sanitize(n.colorSeed, 1, 0, 2 ** 32)),
    };
  } else if (kind === 'nebula') {
    return null;
  }
  b.heat = sanitize(r.heat, 0, 0, 1e6);
  b.pinned = r.pinned === true;
  return b;
}

export function validateSettings(raw: unknown): WorldSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    integration: s.integration === 'nbody' || s.integration === 'kepler' ? s.integration : 'auto',
    collisions: s.collisions !== false,
    darkMatterGravity: s.darkMatterGravity !== false,
    gwBoost: sanitize(s.gwBoost, DEFAULT_SETTINGS.gwBoost, 1, 1e16),
    eta: sanitize(s.eta, DEFAULT_SETTINGS.eta, 0.001, 0.2),
    maxSubsteps: Math.round(sanitize(s.maxSubsteps, DEFAULT_SETTINGS.maxSubsteps, 10, 10000)),
    budgetMs: sanitize(s.budgetMs, DEFAULT_SETTINGS.budgetMs, 1, 100),
    stellarEvolution: s.stellarEvolution !== false,
  };
}

export function validateSnapshot(raw: unknown): WorldSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bodies = Array.isArray(r.bodies) ? (r.bodies.map(validateBody).filter(Boolean) as Body[]) : [];
  // identifiants uniques
  const seen = new Set<number>();
  let maxId = 0;
  for (const b of bodies) {
    if (b.id <= 0 || seen.has(b.id)) b.id = 0;
    else seen.add(b.id);
    maxId = Math.max(maxId, b.id);
  }
  for (const b of bodies) if (b.id === 0) { b.id = ++maxId; seen.add(b.id); }
  return {
    time: sanitize(r.time, 0, 0, 1e15),
    nextId: Math.max(maxId + 1, Math.round(sanitize(r.nextId, maxId + 1, 1, 1e12))),
    bodies,
    particles: Array.isArray(r.particles) ? (r.particles as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length >= 10).slice(0, MAX_SAVED_PARTICLES * 2) : [],
    settings: validateSettings(r.settings),
    events: Array.isArray(r.events)
      ? (r.events as SimEvent[]).filter((e) => e && typeof e.message === 'string').slice(-150).map((e) => ({ t: sanitize(e.t, 0), type: e.type ?? 'info', message: e.message.slice(0, 300) }))
      : [],
  };
}

export function restoreWorld(w: World, snapIn: WorldSnapshot): void {
  const snap = validateSnapshot(snapIn);
  w.clear();
  w.time = snap.time;
  w.nextId = snap.nextId;
  w.bodies = snap.bodies.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
  w.particles.loadJSON(snap.particles);
  w.settings = { ...snap.settings };
  w.events = snap.events.map((e) => ({ ...e }));
  w.version++;
}

export function newUniverseId(): string {
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function emptyUniverse(name: string, seed: number, world: World): UniverseSave {
  const now = new Date().toISOString();
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    id: newUniverseId(),
    name,
    seed: seed >>> 0,
    createdAt: now,
    updatedAt: now,
    cosmology: { ...PLANCK18 },
    cosmicTime: 13.79,
    location: { level: 'system', galaxyId: 'home', systemKey: 'sol' },
    customGalaxies: [],
    galaxyOverrides: {},
    systems: {},
    current: snapshotWorld(world),
    micro: null,
    bigBang: null,
    stats: { playTimeS: 0, creations: 0, destructions: 0 },
  };
}

/** Valide un univers complet (chargement, import). Lève une erreur explicite si invalide. */
export function validateUniverse(raw: unknown): UniverseSave {
  if (!raw || typeof raw !== 'object') throw new Error('Fichier vide ou illisible');
  const r = raw as Record<string, unknown>;
  if (r.format !== SAVE_FORMAT) throw new Error('Ce fichier n\'est pas une sauvegarde DEMIURGE');
  const version = sanitize(r.version, 0);
  if (version < 1 || version > SAVE_VERSION) throw new Error(`Version de sauvegarde non prise en charge (${version})`);
  const loc = (r.location ?? {}) as Record<string, unknown>;
  const levels: ScaleLevel[] = ['subatomic', 'atomic', 'micro', 'planet', 'system', 'galaxy', 'cosmic', 'bigbang'];
  const systems: Record<string, WorldSnapshot> = {};
  if (r.systems && typeof r.systems === 'object') {
    for (const [k, v] of Object.entries(r.systems as Record<string, unknown>).slice(0, 500)) systems[k.slice(0, 80)] = validateSnapshot(v);
  }
  const custom = Array.isArray(r.customGalaxies)
    ? (r.customGalaxies as CosmicGalaxy[]).filter((g) => g && typeof g.id === 'string' && Number.isFinite(g.x)).slice(0, 1000)
    : [];
  const stats = (r.stats ?? {}) as Record<string, unknown>;
  const bb = r.bigBang as Record<string, unknown> | null;
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    id: typeof r.id === 'string' && r.id.length < 64 ? r.id : newUniverseId(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 60) : 'Univers sans nom',
    seed: Math.round(sanitize(r.seed, 1, 0, 2 ** 32)) >>> 0,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    cosmology: sanitizeCosmo((r.cosmology ?? {}) as Partial<CosmoParams>),
    cosmicTime: sanitize(r.cosmicTime, 13.79, 0, 1e4),
    location: {
      level: levels.includes(loc.level as ScaleLevel) ? (loc.level as ScaleLevel) : 'system',
      galaxyId: typeof loc.galaxyId === 'string' ? loc.galaxyId : 'home',
      systemKey: typeof loc.systemKey === 'string' ? loc.systemKey : 'sol',
    },
    customGalaxies: custom,
    galaxyOverrides: (r.galaxyOverrides && typeof r.galaxyOverrides === 'object' ? r.galaxyOverrides : {}) as Record<string, GalaxyParams>,
    systems,
    current: validateSnapshot(r.current),
    micro: r.micro ?? null,
    bigBang: bb && typeof bb === 'object' ? { seed: Math.round(sanitize(bb.seed, 1, 0, 2 ** 32)) >>> 0, params: sanitizeCosmo((bb.params ?? {}) as Partial<CosmoParams>) } : null,
    stats: {
      playTimeS: sanitize(stats.playTimeS, 0, 0, 1e10),
      creations: Math.round(sanitize(stats.creations, 0, 0, 1e9)),
      destructions: Math.round(sanitize(stats.destructions, 0, 0, 1e9)),
    },
  };
}
