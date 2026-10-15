import { G_SI, C_SI, M_SUN_KG, AU_M, YEAR_S, L_SUN_W, clamp } from '../core/units';

/**
 * Physique des trous noirs.
 * [Science établie] : rayon de Schwarzschild, ISCO de Kerr (Bardeen 1972), efficacité
 * radiative, limite d'Eddington, formule de Peters (1964), température de Hawking.
 * [Approximation] : disque mince, fusion par ajustements numériques simples.
 */

/** Rayon de Schwarzschild (km) pour une masse en M☉. */
export function schwarzschildRadiusKm(mSun: number): number {
  return (2 * G_SI * mSun * M_SUN_KG) / (C_SI * C_SI) / 1000;
}

/** Rayon de l'orbite circulaire stable la plus interne (ISCO), prograde, en unités GM/c². */
export function iscoRadiusM(spin: number): number {
  const a = clamp(spin, 0, 0.9999);
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** ISCO exprimée en rayons de Schwarzschild. */
export const iscoRadiusRs = (spin: number) => iscoRadiusM(spin) / 2;

/** Rayon de l'horizon de Kerr r+ en rayons de Schwarzschild. */
export function horizonRadiusRs(spin: number): number {
  const a = clamp(spin, 0, 0.9999);
  return (1 + Math.sqrt(1 - a * a)) / 2;
}

/** Rayon apparent de l'ombre (≈ √27 GM/c² pour Schwarzschild), en Rs. */
export const shadowRadiusRs = 1.5 * Math.sqrt(3);

/** Efficacité radiative du disque d'accrétion (fraction de mc² rayonnée). */
export function radiativeEfficiency(spin: number): number {
  return 1 - Math.sqrt(1 - 2 / (3 * iscoRadiusM(spin)));
}

/** Luminosité d'Eddington en L☉. */
export function eddingtonLuminosity(mSun: number): number {
  return (1.26e31 * mSun) / L_SUN_W;
}

/** Luminosité d'accrétion (L☉) pour un taux Ṁ (M☉/an), plafonnée à ~Eddington. */
export function accretionLuminosity(mdotSunYr: number, spin: number, mSun: number): number {
  const mdot = (mdotSunYr * M_SUN_KG) / YEAR_S;
  const L = (radiativeEfficiency(spin) * mdot * C_SI * C_SI) / L_SUN_W;
  return Math.min(L, 1.5 * eddingtonLuminosity(mSun));
}

/** Température de Hawking (K). */
export const hawkingTemperature = (mSun: number) => 6.17e-8 / mSun;
/** Temps d'évaporation par rayonnement de Hawking (années). */
export const evaporationTime = (mSun: number) => 2.1e67 * Math.pow(mSun, 3);

/** Rayon de marée (km) au-delà duquel un corps (masse m, rayon r) est disloqué. */
export function tidalRadiusKm(mBh: number, mBody: number, rBodyKm: number): number {
  return rBodyKm * Math.cbrt(mBh / Math.max(1e-20, mBody));
}

/** Température du disque mince (K) à r (en Rs), modèle de Shakura–Sunyaev simplifié. */
export function diskTemperature(mSun: number, mdotSunYr: number, rRs: number, spin: number): number {
  const rin = iscoRadiusRs(spin);
  if (rRs <= rin) return 0;
  const M = mSun * M_SUN_KG;
  const mdot = Math.max(1e-30, (mdotSunYr * M_SUN_KG) / YEAR_S);
  const R = rRs * (2 * G_SI * M) / (C_SI * C_SI);
  const f = 1 - Math.sqrt(rin / rRs);
  const t4 = (3 * G_SI * M * mdot * f) / (8 * Math.PI * 5.670374e-8 * R * R * R);
  return Math.pow(t4, 0.25);
}

// ---------------------------------------------------------------------------
// Ondes gravitationnelles et fusion
// ---------------------------------------------------------------------------

export function chirpMass(m1: number, m2: number): number {
  return Math.pow(m1 * m2, 3 / 5) / Math.pow(m1 + m2, 1 / 5);
}

/** Rapport de masse symétrique ν = m1 m2 / M². */
export const symmetricMassRatio = (m1: number, m2: number) => (m1 * m2) / Math.pow(m1 + m2, 2);

/** Temps de coalescence (années) d'une binaire circulaire de séparation a (UA) — Peters 1964. */
export function coalescenceTime(m1: number, m2: number, aAU: number): number {
  const M1 = m1 * M_SUN_KG, M2 = m2 * M_SUN_KG;
  const a = aAU * AU_M;
  const t = (5 / 256) * Math.pow(C_SI, 5) * Math.pow(a, 4) / (Math.pow(G_SI, 3) * M1 * M2 * (M1 + M2));
  return t / YEAR_S;
}

/** Puissance rayonnée en ondes gravitationnelles (W), binaire circulaire. */
export function gwPower(m1: number, m2: number, aAU: number): number {
  const M1 = m1 * M_SUN_KG, M2 = m2 * M_SUN_KG;
  const a = aAU * AU_M;
  return (32 / 5) * Math.pow(G_SI, 4) / Math.pow(C_SI, 5) * Math.pow(M1 * M2, 2) * (M1 + M2) / Math.pow(a, 5);
}

/** Fréquence des ondes (Hz) = 2 × fréquence orbitale, binaire circulaire. */
export function gwFrequency(m1: number, m2: number, aAU: number): number {
  const M = (m1 + m2) * M_SUN_KG;
  const a = aAU * AU_M;
  return (2 * Math.sqrt((G_SI * M) / (a * a * a))) / (2 * Math.PI);
}

/** Amplitude de déformation h à une distance d (m). */
export function gwStrain(m1: number, m2: number, fHz: number, distanceM: number): number {
  const mc = chirpMass(m1, m2) * M_SUN_KG;
  return (4 * Math.pow(G_SI * mc, 5 / 3) * Math.pow(Math.PI * fHz, 2 / 3)) / (Math.pow(C_SI, 4) * Math.max(1, distanceM));
}

/** Fréquence de l'ISCO du trou noir final (Hz), borne de la phase spiralante. */
export function iscoGwFrequency(totalMassSun: number): number {
  return 4400 / totalMassSun;
}

export interface MergerResult {
  finalMass: number;
  finalSpin: number;
  radiatedMass: number; // M☉ convertie en ondes gravitationnelles
  peakFrequencyHz: number;
  chirpMass: number;
}

/**
 * Résultat de la fusion de deux trous noirs (ajustements aux relativité numérique,
 * simplifiés : spins alignés, sans recul).
 */
export function mergeBlackHoles(m1: number, m2: number, a1 = 0, a2 = 0): MergerResult {
  const M = m1 + m2;
  const nu = symmetricMassRatio(m1, m2);
  // énergie rayonnée : ≈ 4.8 % pour des masses égales sans spin (fit Barausse et al.)
  const erad = M * (0.0559745 * nu + 0.580951 * nu * nu - 0.960673 * nu * nu * nu + 3.35241 * nu * nu * nu * nu) * (1 + 0.15 * (a1 + a2) / 2);
  const radiated = clamp(erad, 0, 0.1 * M);
  const spinIn = (a1 * m1 * m1 + a2 * m2 * m2) / (M * M);
  const finalSpin = clamp(2 * Math.sqrt(3) * nu - 3.871 * nu * nu + 4.028 * nu * nu * nu + spinIn * (1 - 2 * nu) + 0.1 * spinIn, 0, 0.998);
  const finalMass = M - radiated;
  return {
    finalMass,
    finalSpin,
    radiatedMass: radiated,
    peakFrequencyHz: 32000 / M * (1 + 0.5 * finalSpin) / 2,
    chirpMass: chirpMass(m1, m2),
  };
}
