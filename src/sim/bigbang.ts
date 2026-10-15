import { Rng } from '../core/rng';
import { clamp } from '../core/units';
import { type CosmoParams, sanitizeCosmo, growthFactor, integrateHistory, type CosmoHistory, timeAtScale } from './cosmology';

/**
 * Formation des grandes structures par l'approximation de Zel'dovich (1970) :
 *   x(q, a) = q + D(a) · ψ(q),   ∇·ψ = −δ_lin(q)
 * Le champ initial δ est un champ gaussien de spectre P(k) ∝ k^ns T(k)²
 * (fonction de transfert BBKS, Γ = Ωm h), généré par FFT 3D à partir d'une graine.
 * [Approximation] : valable jusqu'au croisement des trajectoires (formation des
 * filaments/« crêpes ») ; les halos sont identifiés comme pics de densité.
 */

/** FFT complexe 1D en place (radix-2), n puissance de 2. */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean, offset = 0, stride = 1, n = re.length): void {
  // permutation par inversion de bits
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride, b = offset + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = offset + (i + k) * stride, b = offset + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[offset + i * stride] /= n; im[offset + i * stride] /= n; }
}

/** FFT 3D (grille N³ indexée [x + N(y + N z)]). */
export function fft3d(re: Float64Array, im: Float64Array, N: number, inverse: boolean): void {
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) fft1d(re, im, inverse, N * (y + N * z), 1, N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) fft1d(re, im, inverse, x + N * N * z, N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) fft1d(re, im, inverse, x + N * y, N * N, N);
}

export interface Halo {
  x: number; y: number; z: number; // position comobile (Mpc)
  mass: number; // M☉ (estimation)
  /** Facteur d'échelle de formation (effondrement sphérique δ = 1.686). */
  aForm: number;
  peak: number;
}

export interface StructureField {
  N: number;
  boxMpc: number;
  /** Positions de Lagrange (grille) et déplacements ψ (Mpc, à D = 1). */
  q: Float32Array;
  psi: Float32Array;
  /** Densité linéaire initiale au point de chaque particule (normalisée à D = 1). */
  delta: Float32Array;
  /** Facteur d'échelle auquel chaque particule entre dans une structure effondrée. */
  aCollapse: Float32Array;
  halos: Halo[];
  history: CosmoHistory;
  params: CosmoParams;
  seed: number;
}

/** Fonction de transfert BBKS. */
function transferBBKS(k: number, gamma: number): number {
  const q = k / gamma;
  if (q === 0) return 1;
  return (Math.log(1 + 2.34 * q) / (2.34 * q)) * Math.pow(1 + 3.89 * q + (16.1 * q) ** 2 + (5.46 * q) ** 3 + (6.71 * q) ** 4, -0.25);
}

/**
 * Génère le champ de déplacement et le catalogue de halos d'une boîte comobile.
 * N = 32 ou 64 (N³ particules).
 */
export function generateStructure(seed: number, pIn: Partial<CosmoParams>, N = 48, boxMpc = 200): StructureField {
  const p = sanitizeCosmo(pIn);
  // N doit être une puissance de 2 pour la FFT
  const n = N <= 32 ? 32 : N <= 64 ? 64 : 128;
  const N3 = n * n * n;
  const rng = new Rng(seed);
  const re = new Float64Array(N3), im = new Float64Array(N3);
  // bruit blanc gaussien dans l'espace réel → spectre
  for (let i = 0; i < N3; i++) re[i] = rng.gauss();
  fft3d(re, im, n, false);
  const h = p.H0 / 100;
  const gamma = p.omegaM * h * Math.exp(-p.omegaB * (1 + Math.sqrt(2 * h) / p.omegaM));
  const kf = (2 * Math.PI) / boxMpc;
  const dRe = new Float64Array(N3), dIm = new Float64Array(N3);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = x + n * (y + n * z);
    const kx = (x <= n / 2 ? x : x - n) * kf, ky = (y <= n / 2 ? y : y - n) * kf, kz = (z <= n / 2 ? z : z - n) * kf;
    const k = Math.sqrt(kx * kx + ky * ky + kz * kz);
    if (k === 0) { re[i] = 0; im[i] = 0; continue; }
    const T = transferBBKS(k / h, gamma);
    const amp = Math.sqrt(Math.pow(k, p.ns) * T * T);
    dRe[i] = re[i] * amp;
    dIm[i] = im[i] * amp;
  }
  // normalisation : écart-type de δ lissé à l'échelle de la cellule ~ σ8 (approximation de jeu)
  const tmpRe = Float64Array.from(dRe), tmpIm = Float64Array.from(dIm);
  fft3d(tmpRe, tmpIm, n, true);
  let s2 = 0;
  for (let i = 0; i < N3; i++) s2 += tmpRe[i] * tmpRe[i];
  const sd = Math.sqrt(s2 / N3) || 1;
  const cell = boxMpc / n;
  const targetSigma = p.sigma8 * 2.2 * Math.pow(8 / cell, 0.6); // σ à l'échelle de la cellule
  const norm = targetSigma / sd;
  // δ réel normalisé
  const delta = new Float64Array(N3);
  for (let i = 0; i < N3; i++) delta[i] = tmpRe[i] * norm;
  // ψ_k = i k δ_k / k²  (pour chaque composante)
  const psi = new Float32Array(N3 * 3);
  for (let comp = 0; comp < 3; comp++) {
    const pr = new Float64Array(N3), pi = new Float64Array(N3);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = x + n * (y + n * z);
      const kx = (x <= n / 2 ? x : x - n) * kf, ky = (y <= n / 2 ? y : y - n) * kf, kz = (z <= n / 2 ? z : z - n) * kf;
      const k2 = kx * kx + ky * ky + kz * kz;
      if (k2 === 0) continue;
      const kc = comp === 0 ? kx : comp === 1 ? ky : kz;
      // i·kc/k² × (dRe + i dIm) · norm
      pr[i] = (-kc / k2) * dIm[i] * norm;
      pi[i] = (kc / k2) * dRe[i] * norm;
    }
    fft3d(pr, pi, n, true);
    for (let i = 0; i < N3; i++) psi[i * 3 + comp] = pr[i];
  }
  const q = new Float32Array(N3 * 3);
  const d32 = new Float32Array(N3);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = x + n * (y + n * z);
    q[i * 3] = (x + 0.5) * cell - boxMpc / 2;
    q[i * 3 + 1] = (y + 0.5) * cell - boxMpc / 2;
    q[i * 3 + 2] = (z + 0.5) * cell - boxMpc / 2;
    d32[i] = delta[i];
  }
  const history = integrateHistory(p, 60);
  // effondrement sphérique : δ_lin · D(a) = 1.686 ; on tabule D(a) pour inverser
  const aTab: number[] = [], dTab: number[] = [];
  for (let k = 0; k <= 60; k++) {
    const a = Math.pow(10, -3 + (k / 60) * 3.3); // 1e-3 → ~2
    aTab.push(a);
    dTab.push(growthFactor(p, a));
  }
  const aOfD = (D: number) => {
    if (D <= dTab[0]) return aTab[0];
    for (let k = 1; k < dTab.length; k++) if (dTab[k] >= D) {
      const f = (D - dTab[k - 1]) / (dTab[k] - dTab[k - 1]);
      return aTab[k - 1] + f * (aTab[k] - aTab[k - 1]);
    }
    return Infinity;
  };
  // densité lissée (moyenne sur les 6 voisins) pour l'effondrement et les halos
  const smooth = new Float64Array(N3);
  const idx = (x: number, y: number, z: number) => ((x + n) % n) + n * (((y + n) % n) + n * ((z + n) % n));
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    smooth[idx(x, y, z)] = (2 * delta[idx(x, y, z)] + delta[idx(x + 1, y, z)] + delta[idx(x - 1, y, z)] + delta[idx(x, y + 1, z)] + delta[idx(x, y - 1, z)] + delta[idx(x, y, z + 1)] + delta[idx(x, y, z - 1)]) / 8;
  }
  const aCollapse = new Float32Array(N3);
  for (let i = 0; i < N3; i++) aCollapse[i] = smooth[i] > 0 ? Math.min(1e3, aOfD(1.686 / smooth[i])) : 1e3;
  // halos : maxima locaux de la densité lissée au-dessus du seuil
  const halos: Halo[] = [];
  const rhoCrit = 2.775e11 * h * h; // M☉/Mpc³ · h² → M☉/Mpc³
  const mCell = p.omegaM * rhoCrit * cell * cell * cell;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = smooth[idx(x, y, z)];
    if (v < 1.0) continue;
    let isMax = true;
    for (let dz = -1; dz <= 1 && isMax; dz++) for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy || dz) && smooth[idx(x + dx, y + dy, z + dz)] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const i = idx(x, y, z);
    // position eulérienne actuelle (a = 1)
    let mass = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mass += Math.max(0, 1 + smooth[idx(x + dx, y + dy, z + dz)]);
    halos.push({
      x: q[i * 3] + psi[i * 3], y: q[i * 3 + 1] + psi[i * 3 + 1], z: q[i * 3 + 2] + psi[i * 3 + 2],
      mass: mass * mCell * clamp(v, 1, 5),
      aForm: aCollapse[i],
      peak: v,
    });
  }
  halos.sort((a, b) => b.mass - a.mass);
  return { N: n, boxMpc, q, psi, delta: d32, aCollapse, halos: halos.slice(0, 4000), history, params: p, seed };
}

/** Position d'une particule à un facteur de croissance D (périodique dans la boîte). */
export function particlePosition(f: StructureField, i: number, D: number): [number, number, number] {
  const L = f.boxMpc;
  const wrap = (v: number) => ((((v + L / 2) % L) + L) % L) - L / 2;
  return [wrap(f.q[i * 3] + D * f.psi[i * 3]), wrap(f.q[i * 3 + 1] + D * f.psi[i * 3 + 1]), wrap(f.q[i * 3 + 2] + D * f.psi[i * 3 + 2])];
}

/** Statistique : écart-type de la densité CIC à un facteur D (diagnostic de formation de structures). */
export function densityContrast(f: StructureField, D: number, grid = 32): number {
  const counts = new Float64Array(grid ** 3);
  const n3 = f.N ** 3;
  const L = f.boxMpc;
  for (let i = 0; i < n3; i++) {
    const [x, y, z] = particlePosition(f, i, D);
    const gx = Math.min(grid - 1, Math.floor(((x + L / 2) / L) * grid));
    const gy = Math.min(grid - 1, Math.floor(((y + L / 2) / L) * grid));
    const gz = Math.min(grid - 1, Math.floor(((z + L / 2) / L) * grid));
    counts[gx + grid * (gy + grid * gz)]++;
  }
  const mean = n3 / grid ** 3;
  let s = 0;
  for (const c of counts) s += ((c - mean) / mean) ** 2;
  return Math.sqrt(s / counts.length);
}

/** Âge (Ga) de formation d'un halo. */
export const haloFormationTime = (f: StructureField, h: Halo) => timeAtScale(f.history, h.aForm);
