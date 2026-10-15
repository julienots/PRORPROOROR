import { Rng } from '../core/rng';

const SYL_A = ['Ae', 'Al', 'Ar', 'Be', 'Ca', 'Cy', 'De', 'El', 'Eo', 'Fa', 'Ga', 'He', 'Il', 'Io', 'Ka', 'Ky', 'Le', 'Ly', 'Ma', 'Ne', 'No', 'Or', 'Pa', 'Ph', 'Qu', 'Ra', 'Rh', 'Sa', 'Se', 'Sy', 'Ta', 'Th', 'Ul', 'Va', 'Ve', 'Xa', 'Ys', 'Za', 'Ze'];
const SYL_B = ['ra', 'ri', 'ro', 'la', 'li', 'lo', 'na', 'ne', 'ni', 'th', 'sa', 'si', 'ta', 'te', 'da', 'do', 'ma', 'mi', 'xa', 've', 'ga', 'ka', 'sh', 'dr', 'ph'];
const SYL_C = ['n', 's', 'x', 'r', 'on', 'is', 'us', 'ar', 'a', 'e', 'ia', 'ix', 'or', 'ea', 'yn', 'um', 'el', 'ae', 'os'];

export function properName(rng: Rng): string {
  const n = rng.int(1, 2);
  let s = rng.pick(SYL_A);
  for (let i = 0; i < n; i++) s += rng.pick(SYL_B);
  return s + rng.pick(SYL_C);
}

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];

export function catalogName(prefix: string, rng: Rng): string {
  return `${prefix} ${rng.int(1000, 99999)}`;
}

export function greekLetter(i: number): string {
  return GREEK[i % GREEK.length];
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
export const planetSuffix = (i: number) => String.fromCharCode(98 + Math.min(i, 24)); // b, c, d…
