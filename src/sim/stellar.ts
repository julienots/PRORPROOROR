import { G_SI, K_B, M_H, M_SUN_KG, R_SUN_KM, T_SUN_K, AU_M, YEAR_S, M_JUP_SUN, clamp, lerp } from '../core/units';
import type { StarPhase, StarState } from './types';

/**
 * Évolution stellaire simplifiée (relations d'échelle sur la séquence principale
 * et phases post-séquence paramétrées). [Approximation] : pas de modèle de structure
 * interne ; les durées et grandeurs suivent les ordres de grandeur observés.
 */

export const BROWN_DWARF_MIN = 13 * M_JUP_SUN; // ≈ 0.0124 M☉ (fusion du deutérium)
export const HYDROGEN_BURNING_MIN = 0.075; // M☉
export const SUPERNOVA_MIN = 8; // M☉ initiale
export const BLACKHOLE_MIN = 20; // M☉ initiale
export const CHANDRASEKHAR = 1.44;
export const TOV_LIMIT = 2.2; // masse maximale d'une étoile à neutrons (approx.)

/** Durée de vie sur la séquence principale (années). */
export function mainSequenceLifetime(m: number): number {
  return clamp(1e10 * Math.pow(m, -2.5), 3e6, 1e13);
}

/** Luminosité de séquence principale (L☉), relation masse–luminosité par morceaux. */
export function mainSequenceLuminosity(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 55) return 1.4 * Math.pow(m, 3.5);
  return 32000 * m;
}

/** Rayon de séquence principale (R☉). */
export function mainSequenceRadius(m: number): number {
  return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
}

/** Température effective (K) depuis L (L☉) et R (R☉) via Stefan–Boltzmann. */
export function effectiveTemperature(lum: number, radiusSun: number): number {
  return T_SUN_K * Math.pow(lum / (radiusSun * radiusSun), 0.25);
}

/** Masse de la naine blanche finale (relation masse initiale–finale, Kalirai 2008). */
export function whiteDwarfMass(mInit: number): number {
  return clamp(0.109 * mInit + 0.394, 0.45, 1.38);
}

/** Rayon d'une naine blanche (km) — relation masse–rayon approchée. */
export function whiteDwarfRadiusKm(m: number): number {
  const r = 0.0126 * Math.pow(m, -1 / 3) * Math.sqrt(Math.max(0.01, 1 - Math.pow(m / CHANDRASEKHAR, 4 / 3)));
  return r * R_SUN_KM;
}

/** Masse du rémanent compact après effondrement de cœur. */
export function remnantMass(mInit: number): number {
  if (mInit < SUPERNOVA_MIN) return whiteDwarfMass(mInit);
  if (mInit < BLACKHOLE_MIN) return clamp(1.1 + 0.05 * (mInit - 8), 1.2, 2.0);
  return clamp(0.35 * mInit, 3, 80);
}

/** Temps de contraction de Kelvin–Helmholtz approché pour une protoétoile (années). */
export function protostarDuration(m: number): number {
  return clamp(3e7 * Math.pow(m, -2.5), 5e4, 1e8);
}

/** Masse de Jeans (M☉) pour un gaz de température T (K) et densité n (cm⁻³). */
export function jeansMass(T: number, n: number, mu = 2.33): number {
  const rho = Math.max(1e-30, n * 1e6 * mu * M_H); // kg/m³
  const term = Math.pow((5 * K_B * Math.max(1, T)) / (G_SI * mu * M_H), 1.5);
  return (term * Math.sqrt(3 / (4 * Math.PI * rho))) / M_SUN_KG;
}

/** Temps de chute libre (années) pour une densité n (cm⁻³). */
export function freeFallTime(n: number, mu = 2.33): number {
  const rho = Math.max(1e-30, n * 1e6 * mu * M_H);
  return Math.sqrt((3 * Math.PI) / (32 * G_SI * rho)) / YEAR_S;
}

/** Rayon d'un nuage (km) de masse M (M☉) et densité n (cm⁻³). */
export function cloudRadiusKm(m: number, n: number, mu = 2.33): number {
  const rho = Math.max(1e-30, n * 1e6 * mu * M_H);
  const r = Math.cbrt((3 * m * M_SUN_KG) / (4 * Math.PI * rho));
  return r / 1000;
}

export function initialStarState(mass: number, metallicity = 0.014, rotationDays = 25, phase: StarPhase = 'main', age = 0): StarState {
  return {
    phase,
    zamsMass: mass,
    metallicity,
    age,
    luminosity: mainSequenceLuminosity(mass),
    msLifetime: mainSequenceLifetime(mass),
    rotationDays,
  };
}

export interface StellarSnapshot {
  luminosity: number; // L☉
  radiusKm: number;
  temperature: number;
  phase: StarPhase;
  /** Masse actuelle (perte par vents en phase géante). */
  mass: number;
}

/**
 * Grandeurs observables d'une étoile vivante (protoétoile → supergéante) selon son âge.
 * Retourne `ended: true` quand l'étoile atteint la fin de vie.
 */
export function stellarStateAt(s: StarState): StellarSnapshot & { ended: boolean } {
  const M = s.zamsMass;
  const L0 = mainSequenceLuminosity(M);
  const R0 = mainSequenceRadius(M);
  const tMS = s.msLifetime;
  if (s.phase === 'protostar') {
    const d = protostarDuration(M);
    const f = clamp(s.age / d, 0, 1);
    const R = R0 * lerp(5, 1, Math.sqrt(f));
    const L = L0 * lerp(3, 1, f);
    return { luminosity: L, radiusKm: R * R_SUN_KM, temperature: effectiveTemperature(L, R), phase: 'protostar', mass: M, ended: false };
  }
  const f = s.age / tMS;
  if (f < 1) {
    const L = L0 * (1 + 0.6 * f * f);
    const R = R0 * (1 + 0.25 * f);
    return { luminosity: L, radiusKm: R * R_SUN_KM, temperature: effectiveTemperature(L, R), phase: 'main', mass: M, ended: false };
  }
  const massive = M >= SUPERNOVA_MIN;
  // phase post-séquence principale : durée ~ 10 % (étoiles légères) à 12 % (massives) de tMS
  const post = (s.age - tMS) / tMS;
  if (!massive) {
    if (post < 0.05) {
      const g = post / 0.05;
      const L = L0 * lerp(1.6, 3, g);
      const R = R0 * lerp(1.25, 3, g);
      return { luminosity: L, radiusKm: R * R_SUN_KM, temperature: effectiveTemperature(L, R), phase: 'subgiant', mass: M, ended: false };
    }
    if (post < 0.12) {
      const g = (post - 0.05) / 0.07;
      const L = lerp(3 * L0, 2000 * Math.pow(M, 0.8), g * g);
      const R = lerp(3 * R0, 150 * Math.pow(M, 0.5), g * g);
      const mass = M - (M - whiteDwarfMass(M)) * 0.5 * g; // vents stellaires
      return { luminosity: L, radiusKm: R * R_SUN_KM, temperature: effectiveTemperature(L, R), phase: 'redgiant', mass, ended: false };
    }
    return { luminosity: 2000, radiusKm: 150 * R_SUN_KM, temperature: 3200, phase: 'redgiant', mass: M, ended: true };
  }
  if (post < 0.1) {
    const g = post / 0.1;
    const L = L0 * lerp(1.6, 2.5, g);
    const R = lerp(R0 * 1.3, 800 * Math.pow(M / 15, 0.6), g);
    const mass = M * (1 - 0.3 * g);
    return { luminosity: L, radiusKm: R * R_SUN_KM, temperature: effectiveTemperature(L, R), phase: 'supergiant', mass, ended: false };
  }
  return { luminosity: L0 * 2.5, radiusKm: 800 * R_SUN_KM, temperature: 3500, phase: 'supergiant', mass: M * 0.7, ended: true };
}

export type StellarFate = 'whitedwarf' | 'neutronstar' | 'blackhole';

export function stellarFate(mInit: number): StellarFate {
  if (mInit < SUPERNOVA_MIN) return 'whitedwarf';
  if (mInit < BLACKHOLE_MIN) return 'neutronstar';
  return 'blackhole';
}

/** Énergie cinétique typique d'une supernova (J) et vitesse des éjectas (UA/an). */
export const SUPERNOVA_ENERGY_J = 1e44;
export function supernovaEjectaSpeedAUyr(ejectaMassSun: number): number {
  const m = Math.max(0.1, ejectaMassSun) * M_SUN_KG;
  const v = Math.sqrt((2 * SUPERNOVA_ENERGY_J) / m); // m/s
  return (v * YEAR_S) / AU_M;
}

/** Zone habitable (UA) pour une luminosité L (L☉) — Kasting et al. simplifié. */
export function habitableZone(lum: number): [number, number] {
  const s = Math.sqrt(Math.max(1e-8, lum));
  return [0.95 * s, 1.67 * s];
}

/** Classification d'un objet par sa masse (M☉) pour la matière gazeuse. */
export function gasObjectClass(m: number): 'planet' | 'browndwarf' | 'star' {
  if (m < BROWN_DWARF_MIN) return 'planet';
  if (m < HYDROGEN_BURNING_MIN) return 'browndwarf';
  return 'star';
}
