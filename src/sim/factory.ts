import { Rng } from '../core/rng';
import { R_SUN_KM, M_EARTH_SUN, sanitize, clamp, M_JUP_SUN } from '../core/units';
import { v3, type Vec3, vclone } from '../core/vec';
import { MATTER, type MatterId } from './matter';
import { defaultPlanetState, radiusFromMass } from './planet';
import {
  initialStarState, stellarStateAt, whiteDwarfRadiusKm, cloudRadiusKm, BROWN_DWARF_MIN, HYDROGEN_BURNING_MIN,
} from './stellar';
import { schwarzschildRadiusKm } from './blackhole';
import { emptyComposition, normalizeComposition, type Body, type Composition, type BodyKind } from './types';
import { properName } from '../procgen/names';

/**
 * Fabriques de corps célestes. Toutes les entrées sont validées (valeurs non finies
 * ou hors bornes ramenées dans des intervalles physiquement acceptables).
 */
export const LIMITS = {
  starMass: [0.08, 150] as const,
  bhMass: [3, 1e10] as const,
  planetMass: [1e-12, 0.012] as const,
  nebulaMass: [0.01, 1e5] as const,
  density: [1, 1e7] as const, // cm⁻³ pour les nuages
  temperature: [2.7, 1e9] as const,
  speed: [0, 63000] as const, // < c (UA/an)
};

const sanePos = (p?: Partial<Vec3>): Vec3 => v3(sanitize(p?.x, 0), sanitize(p?.y, 0), sanitize(p?.z, 0));
function saneVel(v?: Partial<Vec3>): Vec3 {
  const o = v3(sanitize(v?.x, 0), sanitize(v?.y, 0), sanitize(v?.z, 0));
  const s = Math.hypot(o.x, o.y, o.z);
  const max = LIMITS.speed[1] * 0.99;
  if (s > max) { o.x *= max / s; o.y *= max / s; o.z *= max / s; }
  return o;
}

function baseBody(kind: BodyKind, name: string, mass: number, radius: number, seed: number): Body {
  return {
    id: 0, name, kind, mass, radius, pos: v3(), vel: v3(), temperature: 0, composition: emptyComposition(), seed, createdBy: 'player', age: 0,
  };
}

export interface StarOptions {
  mass?: number; metallicity?: number; age?: number; rotationDays?: number; name?: string; seed?: number;
  pos?: Partial<Vec3>; vel?: Partial<Vec3>; protostar?: boolean;
}

export function makeStar(o: StarOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const mass = sanitize(o.mass, 1, LIMITS.starMass[0], LIMITS.starMass[1]);
  const b = baseBody('star', o.name ?? properName(new Rng(seed)), mass, R_SUN_KM, seed);
  b.star = initialStarState(mass, sanitize(o.metallicity, 0.014, 0.0001, 0.1), sanitize(o.rotationDays, 25, 0.1, 1000), o.protostar ? 'protostar' : 'main', sanitize(o.age, 0, 0, 1e13));
  if (o.protostar) b.kind = 'protostar';
  b.composition = normalizeComposition({ ...emptyComposition(), hydrogen: 1 - b.star.metallicity, heavy: b.star.metallicity });
  b.pos = sanePos(o.pos);
  b.vel = saneVel(o.vel);
  refreshStar(b);
  return b;
}

/** Recalcule rayon/température/luminosité d'une étoile vivante. */
export function refreshStar(b: Body): void {
  if (!b.star) return;
  const s = stellarStateAt(b.star);
  b.radius = s.radiusKm;
  b.temperature = s.temperature;
  b.star.luminosity = s.luminosity;
  if (b.kind === 'star' || b.kind === 'protostar') {
    b.star.phase = s.phase;
    b.kind = s.phase === 'protostar' ? 'protostar' : 'star';
  }
}

export interface BrownDwarfOptions { mass?: number; name?: string; seed?: number; pos?: Partial<Vec3>; vel?: Partial<Vec3> }

export function makeBrownDwarf(o: BrownDwarfOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const mass = sanitize(o.mass, 0.04, BROWN_DWARF_MIN, HYDROGEN_BURNING_MIN);
  const b = baseBody('browndwarf', o.name ?? properName(new Rng(seed)), mass, 0.1 * R_SUN_KM, seed);
  b.temperature = 1200 + 1500 * (mass / HYDROGEN_BURNING_MIN);
  b.composition = normalizeComposition({ ...emptyComposition(), hydrogen: 0.98, heavy: 0.02 });
  b.pos = sanePos(o.pos); b.vel = saneVel(o.vel);
  return b;
}

export interface BlackHoleOptions {
  mass?: number; spin?: number; name?: string; seed?: number; pos?: Partial<Vec3>; vel?: Partial<Vec3>;
  diskMass?: number; jets?: boolean; axis?: Vec3;
}

export function makeBlackHole(o: BlackHoleOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const mass = sanitize(o.mass, 10, LIMITS.bhMass[0], LIMITS.bhMass[1]);
  const b = baseBody('blackhole', o.name ?? `TN ${properName(new Rng(seed))}`, mass, schwarzschildRadiusKm(mass), seed);
  const ax = o.axis ?? v3(0, 1, 0);
  const al = Math.hypot(ax.x, ax.y, ax.z) || 1;
  const disk = sanitize(o.diskMass, 0, 0, mass);
  b.mass = mass + disk; // le disque contribue à la masse gravitationnelle
  b.bh = {
    spin: sanitize(o.spin, 0.7, 0, 0.998),
    diskMass: disk,
    accretionRate: 0,
    jets: o.jets ?? true,
    swallowed: 0,
    axis: { x: ax.x / al, y: ax.y / al, z: ax.z / al },
    luminosity: 0,
  };
  b.composition = emptyComposition();
  b.temperature = 0;
  b.pos = sanePos(o.pos); b.vel = saneVel(o.vel);
  return b;
}

export function makeCompactRemnant(kind: 'whitedwarf' | 'neutronstar', mass: number, from: Body): Body {
  const b = baseBody(kind, from.name, mass, kind === 'whitedwarf' ? whiteDwarfRadiusKm(mass) : 12, from.seed);
  b.pos = vclone(from.pos); b.vel = vclone(from.vel);
  b.composition = kind === 'whitedwarf' ? normalizeComposition({ ...emptyComposition(), heavy: 1 }) : normalizeComposition({ ...emptyComposition(), metal: 1 });
  b.temperature = kind === 'whitedwarf' ? 100000 : 1e6;
  b.star = from.star ? { ...from.star, phase: kind === 'neutronstar' ? 'pulsar' : 'whitedwarf', luminosity: kind === 'whitedwarf' ? 1 : 0.01, rotationDays: kind === 'neutronstar' ? 0.033 / 86400 * 1000 : 1 } : undefined;
  b.createdBy = from.createdBy;
  b.age = 0;
  return b;
}

export interface PlanetOptions {
  mass?: number; // M☉
  massEarth?: number;
  composition?: Partial<Composition>;
  gasGiant?: boolean;
  name?: string; seed?: number; pos?: Partial<Vec3>; vel?: Partial<Vec3>;
  waterFraction?: number; pressure?: number; rotationHours?: number; axialTilt?: number;
  volcanism?: number; magneticField?: number; continents?: number; rings?: boolean; greenhouse?: number;
  kind?: 'planet' | 'moon' | 'asteroid' | 'comet';
}

export function makePlanet(o: PlanetOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rng = new Rng(seed);
  let mass = o.massEarth !== undefined ? sanitize(o.massEarth, 1, 1e-9, 4000) * M_EARTH_SUN : sanitize(o.mass, M_EARTH_SUN, LIMITS.planetMass[0], LIMITS.planetMass[1]);
  mass = clamp(mass, LIMITS.planetMass[0], LIMITS.planetMass[1]);
  const gas = o.gasGiant ?? mass > 15 * M_EARTH_SUN;
  const comp: Composition = gas
    ? normalizeComposition({ ...emptyComposition(), hydrogen: 0.85, ice: 0.05, rock: 0.07, metal: 0.03, ...o.composition })
    : normalizeComposition({ ...emptyComposition(), rock: 0.62, metal: 0.32, water: 0.03, ice: 0.01, organic: 0.005, ...o.composition });
  const kind = o.kind ?? 'planet';
  const b = baseBody(kind, o.name ?? properName(rng), mass, radiusFromMass(mass, comp), seed);
  b.composition = comp;
  const p = defaultPlanetState(seed, gas);
  if (o.waterFraction !== undefined) p.waterFraction = sanitize(o.waterFraction, p.waterFraction, 0, 1);
  if (o.pressure !== undefined) p.pressure = sanitize(o.pressure, p.pressure, 0, 1e5);
  if (o.rotationHours !== undefined) p.rotationHours = sanitize(o.rotationHours, 24, 0.5, 1e5);
  if (o.axialTilt !== undefined) p.axialTilt = sanitize(o.axialTilt, 23, 0, 180);
  if (o.volcanism !== undefined) p.volcanism = sanitize(o.volcanism, 0.2, 0, 1);
  if (o.magneticField !== undefined) p.magneticField = sanitize(o.magneticField, 1, 0, 100);
  if (o.continents !== undefined) p.continents = sanitize(o.continents, 0.5, 0, 1);
  if (o.greenhouse !== undefined) p.greenhouse = sanitize(o.greenhouse, 33, 0, 200);
  if (o.rings !== undefined) p.hasRings = o.rings;
  if (kind === 'asteroid' || kind === 'comet') {
    p.pressure = 0; p.waterFraction = kind === 'comet' ? 0.3 : 0; p.magneticField = 0; p.greenhouse = 0;
  }
  b.planet = p;
  b.temperature = 255;
  b.pos = sanePos(o.pos); b.vel = saneVel(o.vel);
  return b;
}

export function refreshPlanetRadius(b: Body): void {
  if (b.planet) b.radius = radiusFromMass(b.mass, b.composition);
}

export interface NebulaOptions {
  mass?: number; density?: number; temperature?: number; name?: string; seed?: number;
  pos?: Partial<Vec3>; vel?: Partial<Vec3>; remnant?: boolean; expansionSpeed?: number; composition?: Partial<Composition>;
}

export function makeNebula(o: NebulaOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const mass = sanitize(o.mass, 10, LIMITS.nebulaMass[0], LIMITS.nebulaMass[1]);
  // les nuages de jeu sont plus compacts que les nuages réels (∼pc) pour rester à l'échelle d'un système
  const density = sanitize(o.density, 1e5, LIMITS.density[0], LIMITS.density[1]);
  const b = baseBody('nebula', o.name ?? `Nébuleuse ${properName(new Rng(seed))}`, mass, cloudRadiusKm(mass, density), seed);
  b.nebula = {
    gasTemperature: sanitize(o.temperature, 15, 2.7, 1e8),
    density,
    collapseProgress: 0,
    remnant: o.remnant ?? false,
    expansionSpeed: sanitize(o.expansionSpeed, 0, 0, 60000),
    colorSeed: seed,
  };
  b.composition = normalizeComposition({ ...emptyComposition(), hydrogen: 0.98, heavy: 0.02, ...o.composition });
  b.temperature = b.nebula.gasTemperature;
  b.pos = sanePos(o.pos); b.vel = saneVel(o.vel);
  return b;
}

export interface DarkMatterOptions { mass?: number; radiusAU?: number; pos?: Partial<Vec3>; vel?: Partial<Vec3>; seed?: number }

export function makeDarkMatter(o: DarkMatterOptions = {}): Body {
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 32);
  const mass = sanitize(o.mass, 1, 1e-6, 1e6);
  const b = baseBody('darkmatter', `Halo sombre ${properName(new Rng(seed))}`, mass, sanitize(o.radiusAU, 20, 0.01, 1e6) * 1.495978707e8, seed);
  b.composition = emptyComposition();
  b.pos = sanePos(o.pos); b.vel = saneVel(o.vel);
  return b;
}

export interface MatterCreation {
  matter: MatterId;
  /** Quantité en M☉. */
  amount: number;
  temperature?: number;
  /** Densité relative (multiplicateur de la densité de référence). */
  density?: number;
  pos?: Partial<Vec3>;
  vel?: Partial<Vec3>;
  seed?: number;
}

/**
 * Crée un corps à partir d'une quantité de matière. Le type d'objet résultant dépend
 * de la matière ET de la masse (ex. : assez de gaz → étoile, de roche → planète).
 * Retourne null pour les matières qui ne forment pas de corps (énergie, particules).
 */
export function bodyFromMatter(c: MatterCreation): Body | null {
  const mt = MATTER[c.matter];
  if (!mt) return null;
  const amount = sanitize(c.amount, M_EARTH_SUN, 1e-15, 1e7);
  const temp = sanitize(c.temperature, mt.defaultTemperature, 2.7, 1e10);
  const dens = sanitize(c.density, 1, 1e-3, 1e3);
  const seed = c.seed ?? Math.floor(Math.random() * 2 ** 32);
  switch (c.matter) {
    case 'energy':
    case 'particles':
      return null;
    case 'darkmatter':
      return makeDarkMatter({ mass: amount, radiusAU: 5 * Math.cbrt(amount) / Math.cbrt(dens), pos: c.pos, vel: c.vel, seed });
    case 'gas':
    case 'plasma': {
      if (amount >= HYDROGEN_BURNING_MIN && temp > 1e5) {
        // plasma très chaud et massif : allumage direct (pouvoir divin)
        const s = makeStar({ mass: amount, pos: c.pos, vel: c.vel, seed });
        return s;
      }
      if (amount >= 0.01 && c.matter === 'gas') {
        return makeNebula({ mass: amount, temperature: temp, density: 1e5 * dens, pos: c.pos, vel: c.vel, seed });
      }
      if (amount >= BROWN_DWARF_MIN) return makeBrownDwarf({ mass: Math.min(amount, HYDROGEN_BURNING_MIN * 0.999), pos: c.pos, vel: c.vel, seed });
      if (amount >= 5 * M_EARTH_SUN) return makePlanet({ mass: amount, gasGiant: true, pos: c.pos, vel: c.vel, seed });
      return makeNebula({ mass: Math.max(0.01, amount), temperature: temp, density: 1e5 * dens, pos: c.pos, vel: c.vel, seed, remnant: c.matter === 'plasma', expansionSpeed: c.matter === 'plasma' ? 2 : 0 });
    }
    default: {
      const comp = normalizeComposition({ ...emptyComposition(), ...mt.composition });
      const massEarth = amount / M_EARTH_SUN;
      const kind = c.matter === 'ice' && massEarth < 1e-4 ? 'comet' : massEarth < 1e-3 ? 'asteroid' : 'planet';
      const p = makePlanet({
        mass: Math.min(amount, 0.0119), composition: comp, gasGiant: false, pos: c.pos, vel: c.vel, seed, kind,
        waterFraction: c.matter === 'water' ? 0.95 : c.matter === 'ice' ? 0.6 : c.matter === 'organic' ? 0.6 : 0.05,
        pressure: massEarth < 0.05 ? 0 : c.matter === 'water' || c.matter === 'organic' ? 1 : 0.3,
      });
      p.temperature = temp;
      p.radius /= Math.cbrt(dens);
      if (amount > 0.0119) p.name += ' (masse plafonnée)';
      return p;
    }
  }
}

export const JUPITER = M_JUP_SUN;
