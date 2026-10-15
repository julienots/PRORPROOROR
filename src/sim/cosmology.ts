import { clamp, sanitize } from '../core/units';

/**
 * Modèle cosmologique de Friedmann–Lemaître–Robertson–Walker.
 * [Science établie] : équations de Friedmann, température du fond diffus ∝ 1/a,
 * croissance linéaire des structures.
 * [Approximation] : énergie noire de paramètre d'état w constant ; pas d'inflation
 * physique (l'étape d'inflation est illustrative) ; époques datées par T(a).
 */
export interface CosmoParams {
  H0: number; // km/s/Mpc
  omegaM: number; // matière totale (ordinaire + noire)
  omegaB: number; // matière ordinaire (baryons)
  omegaL: number; // énergie noire
  omegaR: number; // rayonnement
  w: number; // équation d'état de l'énergie noire
  ns: number; // indice spectral des fluctuations
  sigma8: number; // amplitude des fluctuations
  T0: number; // température actuelle du fond diffus (K)
}

export const PLANCK18: CosmoParams = {
  H0: 67.7, omegaM: 0.31, omegaB: 0.049, omegaL: 0.69, omegaR: 9.1e-5, w: -1, ns: 0.965, sigma8: 0.81, T0: 2.7255,
};

export function sanitizeCosmo(p: Partial<CosmoParams>): CosmoParams {
  const q = { ...PLANCK18, ...p };
  return {
    H0: sanitize(q.H0, 67.7, 10, 300),
    omegaM: sanitize(q.omegaM, 0.31, 0.01, 5),
    omegaB: sanitize(q.omegaB, 0.049, 0.001, Math.min(1, sanitize(q.omegaM, 0.31, 0.01, 5))),
    omegaL: sanitize(q.omegaL, 0.69, -3, 5),
    omegaR: sanitize(q.omegaR, 9.1e-5, 0, 0.1),
    w: sanitize(q.w, -1, -3, 0),
    ns: sanitize(q.ns, 0.965, 0.5, 1.5),
    sigma8: sanitize(q.sigma8, 0.81, 0.05, 3),
    T0: sanitize(q.T0, 2.7255, 0.1, 100),
  };
}

/** Temps de Hubble 1/H0 en Ga. */
export const hubbleTimeGyr = (H0: number) => 977.8 / H0;

export const omegaK = (p: CosmoParams) => 1 - p.omegaM - p.omegaL - p.omegaR;

/** H(a)²/H0². */
export function E2(p: CosmoParams, a: number): number {
  return p.omegaR / a ** 4 + p.omegaM / a ** 3 + omegaK(p) / a ** 2 + p.omegaL * Math.pow(a, -3 * (1 + p.w));
}

/** ä/a / H0² (équation d'accélération). */
export function accel(p: CosmoParams, a: number): number {
  return -0.5 * (2 * p.omegaR / a ** 4 + p.omegaM / a ** 3 + (1 + 3 * p.w) * p.omegaL * Math.pow(a, -3 * (1 + p.w)));
}

export type CosmicFate = 'bigfreeze' | 'bigcrunch' | 'bigrip' | 'static';

export interface CosmoHistory {
  /** Temps en Ga depuis le Big Bang. */
  t: Float64Array;
  a: Float64Array;
  n: number;
  /** Âge actuel (a = 1) en Ga, NaN si jamais atteint. */
  age: number;
  fate: CosmicFate;
  /** Temps de la fin (Big Crunch / Big Rip) en Ga, Infinity sinon. */
  tEnd: number;
  aMax: number;
}

/**
 * Intègre a(t) depuis a = 1e-8 (époque du rayonnement, solution analytique a ∝ √t)
 * avec un RK4 sur (a, ȧ), en suivant le rebond éventuel (Big Crunch).
 */
export function integrateHistory(pIn: CosmoParams, tMaxGyr = 200, steps = 4000): CosmoHistory {
  const p = sanitizeCosmo(pIn);
  const tH = hubbleTimeGyr(p.H0);
  // variables sans dimension : τ = t / tH
  const a0 = 1e-6;
  let a = a0;
  let adot = Math.sqrt(Math.max(0, E2(p, a))) * a;
  // temps initial (ère radiation/matière) : intégrale de da/(a·√E2) approchée
  let tau = (a * a) / (2 * Math.sqrt(p.omegaR + 1e-12)) * (p.omegaR > 0 ? 1 : 0) + (p.omegaR > 0 ? 0 : (2 / 3) * Math.pow(a, 1.5) / Math.sqrt(p.omegaM));
  const tArr: number[] = [tau * tH], aArr: number[] = [a];
  let age = NaN;
  let fate: CosmicFate = 'bigfreeze';
  let tEnd = Infinity;
  let aMax = a;
  const tauMax = tMaxGyr / tH;
  // pas adaptatif en ln a (au début), puis en temps
  let i = 0;
  while (tau < tauMax && i < steps * 50) {
    i++;
    const h = Math.min(0.02 * a / Math.max(Math.abs(adot), 1e-12), 0.002 * tauMax + 1e-9, Math.max(1e-12, tauMax - tau));
    // RK4 sur y = (a, ȧ) avec ä = a · accel(a)
    const f = (aa: number, vv: number): [number, number] => [vv, aa * accel(p, Math.max(aa, 1e-12))];
    const [k1a, k1v] = f(a, adot);
    const [k2a, k2v] = f(a + 0.5 * h * k1a, adot + 0.5 * h * k1v);
    const [k3a, k3v] = f(a + 0.5 * h * k2a, adot + 0.5 * h * k2v);
    const [k4a, k4v] = f(a + h * k3a, adot + h * k3v);
    const aNew = a + (h / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);
    const vNew = adot + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    // contrainte de Friedmann pour limiter la dérive pendant l'expansion
    const e2 = E2(p, Math.max(aNew, 1e-12));
    let v = vNew;
    if (e2 > 0 && vNew > 0) v = Math.sqrt(e2) * aNew;
    if (Number.isNaN(aNew)) break;
    if (Number.isNaN(age) && a < 1 && aNew >= 1) age = (tau + h * (1 - a) / Math.max(aNew - a, 1e-12)) * tH;
    a = aNew;
    adot = v;
    tau += h;
    if (a > aMax) aMax = a;
    if (tArr.length < 200000 && (i % 2 === 0 || a < 0.01)) { tArr.push(tau * tH); aArr.push(a); }
    if (a <= a0) { fate = 'bigcrunch'; tEnd = tau * tH; break; }
    if (a > 1e8) { fate = 'bigrip'; tEnd = tau * tH; break; }
  }
  if (fate === 'bigfreeze' && adot < 0) fate = 'bigcrunch';
  if (fate === 'bigfreeze' && p.w < -1 && p.omegaL > 0) fate = 'bigrip';
  if (fate === 'bigfreeze' && Math.abs(adot) < 1e-6) fate = 'static';
  return { t: Float64Array.from(tArr), a: Float64Array.from(aArr), n: tArr.length, age, fate, tEnd, aMax };
}

/** Facteur d'échelle à l'instant t (Ga), interpolé dans l'historique. */
export function scaleFactorAt(h: CosmoHistory, tGyr: number): number {
  const { t, a, n } = h;
  if (n === 0) return 1;
  if (tGyr <= t[0]) return a[0] * Math.sqrt(Math.max(tGyr, 1e-30) / t[0]);
  if (tGyr >= t[n - 1]) return a[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tGyr) lo = mid; else hi = mid;
  }
  const f = (tGyr - t[lo]) / (t[hi] - t[lo] || 1);
  return a[lo] + f * (a[hi] - a[lo]);
}

/** Instant (Ga) où le facteur d'échelle vaut a (première occurrence). */
export function timeAtScale(h: CosmoHistory, aTarget: number): number {
  const { t, a, n } = h;
  if (aTarget <= a[0]) return t[0] * (aTarget / a[0]) ** 2;
  for (let i = 1; i < n; i++) {
    if (a[i] >= aTarget) {
      const f = (aTarget - a[i - 1]) / (a[i] - a[i - 1] || 1);
      return t[i - 1] + f * (t[i] - t[i - 1]);
    }
  }
  return NaN;
}

/** Température du rayonnement fossile (K). */
export const radiationTemperature = (p: CosmoParams, a: number) => p.T0 / Math.max(a, 1e-30);

/** Paramètre de Hubble H(a) (km/s/Mpc). */
export const hubbleAt = (p: CosmoParams, a: number) => p.H0 * Math.sqrt(Math.max(0, E2(p, a)));

/** Distance comobile (Mpc) jusqu'au décalage z (intégration trapèze). */
export function comovingDistance(p: CosmoParams, z: number, n = 512): number {
  const c = 299792.458;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const z0 = (z * i) / n, z1 = (z * (i + 1)) / n;
    const f0 = 1 / Math.sqrt(Math.max(1e-12, E2(p, 1 / (1 + z0))));
    const f1 = 1 / Math.sqrt(Math.max(1e-12, E2(p, 1 / (1 + z1))));
    s += 0.5 * (f0 + f1) * (z1 - z0);
  }
  return (c / p.H0) * s;
}

/**
 * Facteur de croissance linéaire D(a) normalisé à D(1) = 1, par intégration de
 * D'' + (2 + dlnH/dlna) D' = 1.5 Ωm(a) D en ln a.
 */
export function growthFactor(p: CosmoParams, aTarget: number): number {
  const lnA0 = Math.log(1e-3);
  const integrate = (lnEnd: number) => {
    let x = lnA0;
    let D = Math.exp(lnA0), dD = Math.exp(lnA0); // domination de la matière : D ∝ a
    const n = 400;
    const h = (lnEnd - lnA0) / n;
    const deriv = (lx: number, d: number, dd: number): [number, number] => {
      const a = Math.exp(lx);
      const e2 = Math.max(1e-12, E2(p, a));
      const eps = 1e-4;
      const dlnH = (Math.log(Math.max(1e-12, E2(p, a * Math.exp(eps)))) - Math.log(Math.max(1e-12, E2(p, a * Math.exp(-eps))))) / (4 * eps);
      const om = p.omegaM / a ** 3 / e2;
      return [dd, -(2 + dlnH) * dd + 1.5 * om * d];
    };
    for (let i = 0; i < n; i++) {
      const [k1, l1] = deriv(x, D, dD);
      const [k2, l2] = deriv(x + h / 2, D + (h / 2) * k1, dD + (h / 2) * l1);
      const [k3, l3] = deriv(x + h / 2, D + (h / 2) * k2, dD + (h / 2) * l2);
      const [k4, l4] = deriv(x + h, D + h * k3, dD + h * l3);
      D += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      dD += (h / 6) * (l1 + 2 * l2 + 2 * l3 + l4);
      x += h;
    }
    return D;
  };
  const a = clamp(aTarget, 1e-3, 1e3);
  return integrate(Math.log(a)) / integrate(0);
}

/** Classification lisible du destin. */
export const FATE_LABEL: Record<CosmicFate, string> = {
  bigfreeze: 'Mort thermique (Big Freeze) — expansion éternelle',
  bigcrunch: 'Big Crunch — l\'expansion s\'inverse et l\'univers s\'effondre',
  bigrip: 'Big Rip — l\'énergie fantôme (w < −1) déchire toutes les structures',
  static: 'Univers quasi statique',
};

/** Époques cosmiques (température seuil en K, description). */
export interface CosmicEpoch {
  id: string;
  name: string;
  /** Température à laquelle l'époque commence (K). */
  T: number;
  description: string;
  science: 'etabli' | 'approx' | 'hypothese';
}

export const EPOCHS: CosmicEpoch[] = [
  { id: 'planck', name: 'Ère de Planck', T: 1e32, description: 'Physique inconnue : la relativité générale et la mécanique quantique ne sont pas unifiées. Représentation purement symbolique.', science: 'hypothese' },
  { id: 'inflation', name: 'Inflation (hypothèse)', T: 1e28, description: 'Expansion exponentielle supposée, qui aurait figé les fluctuations quantiques en germes de structures. Modèle largement admis mais non confirmé.', science: 'hypothese' },
  { id: 'quark', name: 'Plasma de quarks et gluons', T: 1e15, description: 'Quarks et gluons libres dans un plasma extrêmement chaud.', science: 'etabli' },
  { id: 'hadron', name: 'Formation des hadrons', T: 1.5e12, description: 'Les quarks se confinent en protons et neutrons.', science: 'etabli' },
  { id: 'nucleo', name: 'Nucléosynthèse primordiale', T: 1e9, description: '≈ 3 minutes : formation de ~75 % H, ~25 % He, traces de deutérium et lithium.', science: 'etabli' },
  { id: 'recomb', name: 'Recombinaison', T: 3000, description: '≈ 380 000 ans : les électrons se lient aux noyaux, l\'univers devient transparent (fond diffus cosmologique).', science: 'etabli' },
  { id: 'dark', name: 'Âges sombres', T: 2900, description: 'Aucune étoile : la matière noire s\'effondre en halos qui attirent le gaz.', science: 'etabli' },
  { id: 'firststars', name: 'Premières étoiles', T: 60, description: '≈ 100–200 Ma : étoiles de population III, très massives, sans métaux.', science: 'approx' },
  { id: 'galaxies', name: 'Formation des galaxies', T: 20, description: 'Les halos fusionnent hiérarchiquement ; les premières galaxies se forment.', science: 'approx' },
  { id: 'planets', name: 'Systèmes planétaires', T: 8, description: 'Les éléments lourds forgés par les étoiles permettent la formation de planètes rocheuses.', science: 'approx' },
  { id: 'today', name: 'Aujourd\'hui', T: 2.7255, description: 'Univers actuel : l\'énergie noire domine et accélère l\'expansion.', science: 'etabli' },
];

/** Époque correspondant à une température du rayonnement. */
export function epochAt(T: number): CosmicEpoch {
  let cur = EPOCHS[0];
  for (const e of EPOCHS) if (T <= e.T) cur = e;
  return cur;
}
