/**
 * Constantes physiques et unités de simulation.
 *
 * Système stellaire : longueurs en UA, masses en masses solaires, temps en années.
 * Dans ce système G = 4π² exactement (troisième loi de Kepler).
 */
export const G_SIM = 4 * Math.PI * Math.PI; // UA³ / (M☉ · an²)

// SI
export const G_SI = 6.674e-11;
export const C_SI = 299_792_458;
export const SIGMA_SB = 5.670374e-8;
export const K_B = 1.380649e-23;
export const M_H = 1.6735575e-27;

export const AU_M = 1.495978707e11;
export const AU_KM = 1.495978707e8;
export const LY_M = 9.4607304725808e15;
export const LY_AU = 63241.077;
export const PC_LY = 3.26156;
export const MPC_LY = 3.26156e6;
export const YEAR_S = 3.15576e7;
export const DAY_S = 86400;

export const M_SUN_KG = 1.98847e30;
export const R_SUN_KM = 695_700;
export const L_SUN_W = 3.828e26;
export const T_SUN_K = 5772;

export const M_EARTH_SUN = 3.0034896e-6; // masse terrestre en M☉
export const M_JUP_SUN = 9.5458e-4;
export const R_EARTH_KM = 6371;
export const R_JUP_KM = 69_911;
export const M_EARTH_KG = 5.9722e24;

/** Vitesse de la lumière en UA/an. */
export const C_AU_YR = (C_SI * YEAR_S) / AU_M; // ≈ 63 240

export const km2au = (km: number) => km / AU_KM;
export const au2km = (au: number) => au * AU_KM;

/** Ramène toute valeur non finie à une valeur de repli, puis borne. */
export function sanitize(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const SI_PREFIX: [number, string][] = [
  [1e24, 'Y'], [1e21, 'Z'], [1e18, 'E'], [1e15, 'P'], [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
];

/** Formatte un nombre de façon lisible (notation scientifique si nécessaire). */
export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) {
    const e = Math.floor(Math.log10(a));
    const m = v / Math.pow(10, e);
    return `${m.toFixed(digits - 1)}×10${superscript(e)}`;
  }
  return Number(v.toPrecision(digits)).toLocaleString('fr-FR');
}

export function fmtSI(v: number, unit: string, digits = 3): string {
  const a = Math.abs(v);
  for (const [f, p] of SI_PREFIX) if (a >= f) return `${(v / f).toPrecision(digits)} ${p}${unit}`;
  return `${fmt(v, digits)} ${unit}`;
}

function superscript(n: number): string {
  const map: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  return String(n).split('').map((c) => map[c] ?? c).join('');
}

/** Durée en années → texte adapté. */
export function fmtYears(y: number): string {
  const a = Math.abs(y);
  if (a < 1 / 365.25 / 24) return `${fmt(y * 365.25 * 24 * 3600, 3)} s`;
  if (a < 1 / 365.25) return `${fmt(y * 365.25 * 24, 3)} h`;
  if (a < 1) return `${fmt(y * 365.25, 3)} j`;
  if (a < 1e3) return `${fmt(y, 4)} ans`;
  if (a < 1e6) return `${fmt(y / 1e3, 4)} ka`;
  if (a < 1e9) return `${fmt(y / 1e6, 4)} Ma`;
  return `${fmt(y / 1e9, 4)} Ga`;
}

/** Distance en UA → texte adapté à l'échelle. */
export function fmtDistanceAU(au: number): string {
  const km = au * AU_KM;
  if (km < 1) return `${fmt(km * 1000, 3)} m`;
  if (au < 0.01) return `${fmt(km, 4)} km`;
  if (au < 5000) return `${fmt(au, 4)} UA`;
  return `${fmt(au / LY_AU, 4)} al`;
}

export function fmtMassSun(m: number): string {
  if (m < 1e-9) return `${fmt(m * M_SUN_KG, 3)} kg`;
  if (m < 0.003) return `${fmt(m / M_EARTH_SUN, 3)} M⊕`;
  if (m < 0.08) return `${fmt(m / M_JUP_SUN, 3)} M♃`;
  return `${fmt(m, 4)} M☉`;
}
