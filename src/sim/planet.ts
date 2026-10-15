import { G_SI, M_SUN_KG, R_EARTH_KM, R_JUP_KM, M_EARTH_SUN, M_JUP_SUN, clamp } from '../core/units';
import { densityOf } from './matter';
import type { Body, Composition, PlanetState } from './types';

/**
 * Propriétés dérivées des planètes.
 * [Science établie] gravité de surface, vitesse de libération, température d'équilibre,
 * point d'ébullition (Clausius–Clapeyron), échappement de Jeans (critère).
 * [Approximation] effet de serre paramétrique, indice d'habitabilité, apparition de la vie.
 */

export function defaultPlanetState(seed: number, gasGiant = false): PlanetState {
  return {
    waterFraction: gasGiant ? 0 : 0.6,
    continents: 0.5,
    pressure: gasGiant ? 1000 : 1,
    rotationHours: gasGiant ? 10 : 24,
    axialTilt: 23.4,
    volcanism: 0.2,
    magneticField: 1,
    albedo: gasGiant ? 0.5 : 0.3,
    greenhouse: 33,
    life: 0,
    lifeTimer: 0,
    hasRings: false,
    ringInner: 1.3,
    ringOuter: 2.3,
    terrainSeed: seed,
    impacts: [],
    gasGiant,
  };
}

/** Rayon (km) depuis la masse (M☉) et la composition, incluant la compression gravitationnelle. */
export function radiusFromMass(mSun: number, c: Composition): number {
  const gasFrac = c.hydrogen;
  const mEarth = mSun / M_EARTH_SUN;
  if (gasFrac > 0.5 && mSun > 5 * M_EARTH_SUN) {
    // géantes gazeuses : rayon ~constant (dégénérescence partielle)
    const mj = mSun / M_JUP_SUN;
    if (mj < 0.3) return R_JUP_KM * (0.45 + 0.55 * Math.pow(mj / 0.3, 0.5));
    const lm = Math.log10(mj);
    return R_JUP_KM * clamp(1.0 + 0.05 * lm - 0.12 * Math.max(0, lm) ** 2, 0.8, 1.12);
  }
  const rho = densityOf(c);
  const r = Math.cbrt((3 * mSun * M_SUN_KG) / (4 * Math.PI * rho)) / 1000;
  // compression : les grosses planètes rocheuses sont plus denses que leurs matériaux
  // densité moyenne/densité non comprimée ≈ 1 + 0.45 √(M/M⊕) (Lune 1.05, Mars 1.15, Terre 1.45)
  const compress = 1 + 0.45 * Math.sqrt(Math.min(mEarth, 20));
  return Math.max(0.5, r / Math.cbrt(compress));
}

export function surfaceGravity(b: Body): number {
  const r = b.radius * 1000;
  return (G_SI * b.mass * M_SUN_KG) / (r * r);
}

export function escapeVelocity(b: Body): number {
  return Math.sqrt((2 * G_SI * b.mass * M_SUN_KG) / (b.radius * 1000));
}

export function bulkDensity(b: Body): number {
  const r = b.radius * 1000;
  return (b.mass * M_SUN_KG) / ((4 / 3) * Math.PI * r * r * r);
}

/** Température d'équilibre (K) pour un flux total F = Σ L_i / d_i² (L☉/UA²). */
export function equilibriumTemperature(fluxLsunPerAU2: number, albedo: number): number {
  return 278.6 * Math.pow(Math.max(0, fluxLsunPerAU2) * (1 - clamp(albedo, 0, 0.99)), 0.25);
}

/** Réchauffement par effet de serre (K) : paramétrique, calé sur Terre (33 K) et Vénus (~500 K). */
export function greenhouseWarming(p: PlanetState): number {
  if (p.pressure <= 0) return 0;
  return p.greenhouse * Math.pow(p.pressure, 0.6);
}

/** Température d'ébullition de l'eau (K) à une pression (atm). */
export function waterBoilingPoint(pressureAtm: number): number {
  if (pressureAtm < 0.006) return 273.15; // sous le point triple : sublimation
  return 1 / (1 / 373.15 - Math.log(pressureAtm) / 4890);
}

export type WaterState = 'aucune' | 'glace' | 'liquide' | 'vapeur';

export function waterState(tempK: number, p: PlanetState): WaterState {
  if (p.waterFraction <= 0.001 || p.gasGiant) return 'aucune';
  if (tempK < 273.15) return 'glace';
  if (p.pressure < 0.006) return 'glace';
  if (tempK < waterBoilingPoint(p.pressure)) return 'liquide';
  return 'vapeur';
}

/** Rétention atmosphérique : rapport v_libération / v_thermique (N₂). > 6 : stable sur Ga. */
export function atmosphereRetention(b: Body): number {
  const vth = Math.sqrt((3 * 1.380649e-23 * Math.max(10, b.temperature)) / (28 * 1.6605e-27));
  return escapeVelocity(b) / vth;
}

/** Indice d'habitabilité ∈ [0, 1] (modèle spéculatif inspiré de l'ESI). */
export function habitability(b: Body): number {
  const p = b.planet;
  if (!p || p.gasGiant) return 0;
  const T = b.temperature;
  const ws = waterState(T, p);
  const fT = ws === 'liquide' ? Math.exp(-Math.pow((T - 288) / 45, 2)) : 0.02;
  const g = surfaceGravity(b) / 9.81;
  const fG = Math.exp(-Math.pow(Math.log(Math.max(0.05, g)) / 0.9, 2));
  const fP = Math.exp(-Math.pow(Math.log10(Math.max(1e-4, p.pressure)) / 1.2, 2));
  const fW = clamp(p.waterFraction * 3, 0, 1) * (p.waterFraction > 0.97 ? 0.7 : 1);
  const fM = 0.5 + 0.5 * clamp(p.magneticField, 0, 1);
  const fO = 0.8 + 0.2 * clamp(b.composition.organic * 10, 0, 1);
  return clamp(fT * fG * fP * fW * fM * fO, 0, 1);
}

export const LIFE_LABELS = ['Aucune', 'Microbienne', 'Végétale', 'Complexe'];
export const LIFE_THRESHOLDS = [0, 3e8, 2e9, 3.2e9]; // années de conditions habitables

export function planetTypeLabel(b: Body): string {
  const p = b.planet;
  const c = b.composition;
  if (!p) return '—';
  if (p.gasGiant) return c.ice > 0.2 ? 'Géante de glace' : 'Géante gazeuse';
  const T = b.temperature;
  if (T > 1000) return 'Monde de lave';
  const ws = waterState(T, p);
  if (ws === 'liquide' && p.waterFraction > 0.85) return 'Planète océan';
  if (ws === 'glace' && (p.waterFraction > 0.3 || c.ice > 0.3)) return 'Monde glacé';
  if (ws === 'liquide' && p.life >= 1) return 'Monde vivant';
  if (ws === 'liquide') return 'Tellurique tempérée';
  if (p.waterFraction < 0.05) return 'Désertique';
  return 'Tellurique';
}

/** Masse maximale (M☉) considérée comme planète rocheuse avant capture de gaz. */
export const ROCKY_MAX = 10 * M_EARTH_SUN;
export const R_EARTH = R_EARTH_KM;
