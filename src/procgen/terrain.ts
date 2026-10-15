import { SimplexNoise } from '../core/noise';
import { Rng } from '../core/rng';
import { clamp, smoothstep, lerp } from '../core/units';
import type { Body } from '../sim/types';
import { waterState, surfaceGravity } from '../sim/planet';

/**
 * Terrains planétaires procéduraux (fonction de hauteur sur la sphère unité).
 * Continents (fBm), chaînes de montagnes (bruit à crêtes), canyons, cratères
 * (graine + impacts réels de la simulation), volcans. Le niveau de la mer est
 * calculé pour que la fraction océanique corresponde au réglage `waterFraction`.
 */
export interface Crater { x: number; y: number; z: number; r: number; depth: number }
export interface Volcano { x: number; y: number; z: number; r: number; h: number }

export interface TerrainModel {
  seed: number;
  noise: SimplexNoise;
  noise2: SimplexNoise;
  continents: number;
  craters: Crater[];
  volcanoes: Volcano[];
  seaLevel: number;
  /** Amplitude du relief relativement au rayon. */
  relief: number;
  /** Signature des paramètres (pour savoir s'il faut régénérer). */
  signature: string;
}

export function terrainSignature(b: Body): string {
  const p = b.planet!;
  return [p.terrainSeed, p.continents.toFixed(2), p.waterFraction.toFixed(2), p.volcanism.toFixed(2), p.impacts.length, Math.round(b.radius / 50)].join('|');
}

export function buildTerrain(b: Body): TerrainModel {
  const p = b.planet!;
  const rng = new Rng(p.terrainSeed);
  const noise = new SimplexNoise(p.terrainSeed);
  const noise2 = new SimplexNoise(p.terrainSeed ^ 0x9e37);
  const g = Math.max(0.3, surfaceGravity(b));
  const relief = clamp(0.012 * Math.sqrt(9.81 / g), 0.006, 0.05) * (b.kind === 'asteroid' || b.kind === 'comet' ? 6 : 1);
  const craters: Crater[] = [];
  // densité de cratères : forte sans atmosphère ni érosion
  const atmo = p.pressure;
  const nCr = Math.round((atmo < 0.01 ? 140 : atmo < 0.5 ? 40 : 8) * (b.kind === 'moon' || b.kind === 'asteroid' ? 1.5 : 1));
  for (let i = 0; i < nCr; i++) {
    const [x, y, z] = rng.onSphere();
    const r = Math.pow(rng.next(), 3) * 0.25 + 0.01;
    craters.push({ x, y, z, r, depth: 0.5 + rng.next() * 0.5 });
  }
  for (const im of p.impacts) {
    const cl = Math.cos(im.lat);
    craters.push({ x: cl * Math.cos(im.lon), y: Math.sin(im.lat), z: cl * Math.sin(im.lon), r: clamp(im.size * 0.6, 0.02, 0.8), depth: 1.4 });
  }
  const volcanoes: Volcano[] = [];
  const nV = Math.round(p.volcanism * 8);
  for (let i = 0; i < nV; i++) {
    const [x, y, z] = rng.onSphere();
    volcanoes.push({ x, y, z, r: rng.range(0.04, 0.12), h: rng.range(0.4, 1.2) * p.volcanism });
  }
  const t: TerrainModel = { seed: p.terrainSeed, noise, noise2, continents: p.continents, craters, volcanoes, seaLevel: 0, relief, signature: terrainSignature(b) };
  // niveau de la mer par échantillonnage (quantile)
  const samples: number[] = [];
  const srng = new Rng(p.terrainSeed + 17);
  for (let i = 0; i < 1500; i++) {
    const [x, y, z] = srng.onSphere();
    samples.push(rawHeight(t, x, y, z));
  }
  samples.sort((a, b) => a - b);
  const wf = clamp(p.waterFraction, 0, 0.999);
  t.seaLevel = wf <= 0.001 ? -10 : samples[Math.floor(wf * (samples.length - 1))];
  return t;
}

/** Hauteur brute (sans unité, ≈ [-1.5, 1.5]) en un point de la sphère unité. */
export function rawHeight(t: TerrainModel, x: number, y: number, z: number): number {
  const n = t.noise;
  // continents : basse fréquence, contrôlée par le paramètre « continents »
  const freq = lerp(0.8, 2.4, t.continents);
  const cont = n.fbm(x * freq, y * freq, z * freq, 5, 2.0, 0.5);
  // montagnes aux bords de plaques (crêtes), modulées par l'altitude continentale
  const ridge = n.ridged(x * 3.1 + 7, y * 3.1, z * 3.1, 5, 2.1, 0.5);
  const mountainMask = smoothstep(-0.05, 0.35, cont);
  let h = cont * 1.1 + Math.pow(ridge, 2.2) * 0.9 * mountainMask;
  // canyons
  const can = 1 - Math.abs(t.noise2.noise3(x * 2.3, y * 2.3, z * 2.3));
  h -= Math.pow(smoothstep(0.93, 1, can), 2) * 0.35;
  // détail
  h += t.noise2.fbm(x * 12, y * 12, z * 12, 4, 2.0, 0.5) * 0.12;
  // cratères (profil en cuvette avec rebord)
  for (const c of t.craters) {
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (d > c.r * 1.6) continue;
    const u = d / c.r;
    if (u < 1) h -= c.depth * 0.5 * (1 - u * u) * Math.min(1, c.r * 6);
    h += c.depth * 0.25 * Math.exp(-((u - 1) ** 2) * 18) * Math.min(1, c.r * 6);
  }
  // volcans (cônes avec caldeira)
  for (const v of t.volcanoes) {
    const d = Math.hypot(x - v.x, y - v.y, z - v.z);
    if (d > v.r) continue;
    const u = d / v.r;
    h += v.h * (1 - u) * (1 - u) - (u < 0.12 ? v.h * 0.4 * (1 - u / 0.12) : 0);
  }
  return h;
}

export interface SurfaceSample {
  height: number; // relatif au rayon (déplacement radial)
  color: [number, number, number];
  emissive: number; // lave
  water: boolean;
}

/**
 * Couleur et altitude d'un point : biomes dépendant de la température (latitude,
 * altitude), de l'état de l'eau, de la vie et de la composition.
 */
export function sampleSurface(t: TerrainModel, b: Body, x: number, y: number, z: number): SurfaceSample {
  const p = b.planet!;
  const h = rawHeight(t, x, y, z);
  const above = h - t.seaLevel;
  const T0 = b.temperature;
  const ws = waterState(T0, p);
  // la latitude refroidit (calottes polaires) ; l'inclinaison axiale adoucit le contraste
  const lat = Math.abs(y);
  const tilt = (p.axialTilt * Math.PI) / 180;
  const polarCooling = 55 * Math.pow(lat, 2) * (1 - 0.4 * Math.abs(Math.sin(tilt)));
  const T = T0 + 20 - polarCooling - Math.max(0, above) * 35;
  const c = b.composition;
  // roche de base : basaltique / oxydée (rouge) / métallique / glacée
  const oxid = clamp(1 - p.waterFraction * 2, 0, 1) * clamp(c.rock * 1.2, 0, 1) * (p.pressure > 0.001 ? 1 : 0.5);
  let col: [number, number, number] = [
    lerp(0.36, 0.62, oxid) + c.metal * 0.1,
    lerp(0.33, 0.32, oxid) + c.metal * 0.1,
    lerp(0.30, 0.2, oxid) + c.metal * 0.12,
  ];
  if (b.kind === 'moon' || b.kind === 'asteroid' || p.pressure < 0.01) {
    const gr = 0.42 + 0.1 * t.noise2.noise3(x * 5, y * 5, z * 5);
    col = [lerp(col[0], gr, 0.6), lerp(col[1], gr, 0.6), lerp(col[2], gr * 0.95, 0.6)];
  }
  const iceFrac = c.ice + (ws === 'glace' ? p.waterFraction : 0);
  let water = false;
  let emissive = 0;
  let height = Math.max(h, t.seaLevel) - t.seaLevel;
  if (above < 0 && (ws === 'liquide' || ws === 'glace')) {
    water = ws === 'liquide';
    const depth = clamp(-above / 0.8, 0, 1);
    if (ws === 'liquide') col = [lerp(0.05, 0.01, depth), lerp(0.25, 0.06, depth), lerp(0.42, 0.22, depth)];
    else col = [0.82, 0.88, 0.95];
    height = 0;
  } else {
    // biomes terrestres
    if (ws === 'liquide' && p.life >= 2) {
      const moist = 0.5 + 0.5 * t.noise.noise3(x * 4 + 3, y * 4, z * 4);
      const Tc = T - 273;
      if (Tc > 22 && moist < 0.4) col = [0.76, 0.66, 0.45]; // désert
      else if (Tc > 18) col = [lerp(0.13, 0.25, 1 - moist), lerp(0.35, 0.4, 1 - moist), 0.12]; // forêt tropicale / savane
      else if (Tc > 0) col = [0.17, 0.36, 0.15]; // forêt tempérée
      else if (Tc > -10) col = [0.4, 0.45, 0.35]; // toundra
    } else if (ws === 'liquide' && p.life === 1) {
      col = [col[0] * 0.8, col[1] * 0.9 + 0.05, col[2] * 0.8]; // tapis microbiens
    }
    if (above > 0.55) col = [col[0] * 0.8 + 0.1, col[1] * 0.8 + 0.1, col[2] * 0.8 + 0.1]; // roche nue en altitude
  }
  // neige / glace
  const snowLine = T < 268 ? 1 : 0;
  if ((snowLine && (ws !== 'aucune' || iceFrac > 0.1)) || iceFrac > 0.5) {
    const k = clamp((268 - T) / 15, 0, 1) * clamp(p.waterFraction * 3 + iceFrac, 0, 1);
    col = [lerp(col[0], 0.92, k), lerp(col[1], 0.95, k), lerp(col[2], 0.98, k)];
    if (k > 0.5) water = false;
  }
  // lave : surface très chaude ou chaleur d'impact
  const hot = T0 + (b.heat ?? 0) * 0.5;
  if (hot > 900) {
    const crack = Math.pow(1 - Math.abs(t.noise2.noise3(x * 9, y * 9, z * 9)), 8);
    const k = clamp((hot - 900) / 1200, 0, 1);
    col = [lerp(col[0], 0.12, k), lerp(col[1], 0.08, k), lerp(col[2], 0.07, k)];
    emissive = k * crack * 3 + k * 0.15;
    water = false;
  }
  return { height: height * t.relief, color: col, emissive, water };
}
