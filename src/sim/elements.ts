/**
 * Tableau périodique (sous-ensemble Z = 1 → 30, plus quelques éléments lourds notables).
 * Données : masse atomique standard, valence usuelle, isotope stable principal (N),
 * couleur CPK pour le rendu, énergie de première ionisation (eV).
 */
export interface ElementData {
  Z: number;
  symbol: string;
  name: string;
  mass: number;
  valence: number;
  /** Nombre de neutrons de l'isotope stable le plus abondant. */
  N: number;
  /** Autres nombres de neutrons stables. */
  stableN: number[];
  color: string;
  ionization: number; // eV
  category: 'nonmetal' | 'noble' | 'alkali' | 'alkaline' | 'metalloid' | 'halogen' | 'metal' | 'transition';
}

const E = (Z: number, symbol: string, name: string, mass: number, valence: number, N: number, stableN: number[], color: string, ionization: number, category: ElementData['category']): ElementData =>
  ({ Z, symbol, name, mass, valence, N, stableN, color, ionization, category });

export const ELEMENTS: ElementData[] = [
  E(1, 'H', 'Hydrogène', 1.008, 1, 0, [0, 1], '#ffffff', 13.6, 'nonmetal'),
  E(2, 'He', 'Hélium', 4.0026, 0, 2, [1, 2], '#d9ffff', 24.6, 'noble'),
  E(3, 'Li', 'Lithium', 6.94, 1, 4, [3, 4], '#cc80ff', 5.39, 'alkali'),
  E(4, 'Be', 'Béryllium', 9.012, 2, 5, [5], '#c2ff00', 9.32, 'alkaline'),
  E(5, 'B', 'Bore', 10.81, 3, 6, [5, 6], '#ffb5b5', 8.3, 'metalloid'),
  E(6, 'C', 'Carbone', 12.011, 4, 6, [6, 7], '#4a4a4a', 11.26, 'nonmetal'),
  E(7, 'N', 'Azote', 14.007, 3, 7, [7, 8], '#3050f8', 14.53, 'nonmetal'),
  E(8, 'O', 'Oxygène', 15.999, 2, 8, [8, 9, 10], '#ff0d0d', 13.62, 'nonmetal'),
  E(9, 'F', 'Fluor', 18.998, 1, 10, [10], '#90e050', 17.42, 'halogen'),
  E(10, 'Ne', 'Néon', 20.18, 0, 10, [10, 11, 12], '#b3e3f5', 21.56, 'noble'),
  E(11, 'Na', 'Sodium', 22.99, 1, 12, [12], '#ab5cf2', 5.14, 'alkali'),
  E(12, 'Mg', 'Magnésium', 24.305, 2, 12, [12, 13, 14], '#8aff00', 7.65, 'alkaline'),
  E(13, 'Al', 'Aluminium', 26.98, 3, 14, [14], '#bfa6a6', 5.99, 'metal'),
  E(14, 'Si', 'Silicium', 28.085, 4, 14, [14, 15, 16], '#f0c8a0', 8.15, 'metalloid'),
  E(15, 'P', 'Phosphore', 30.974, 3, 16, [16], '#ff8000', 10.49, 'nonmetal'),
  E(16, 'S', 'Soufre', 32.06, 2, 16, [16, 17, 18, 20], '#ffff30', 10.36, 'nonmetal'),
  E(17, 'Cl', 'Chlore', 35.45, 1, 18, [18, 20], '#1ff01f', 12.97, 'halogen'),
  E(18, 'Ar', 'Argon', 39.95, 0, 22, [18, 20, 22], '#80d1e3', 15.76, 'noble'),
  E(19, 'K', 'Potassium', 39.098, 1, 20, [20, 22], '#8f40d4', 4.34, 'alkali'),
  E(20, 'Ca', 'Calcium', 40.078, 2, 20, [20, 22, 23, 24, 26, 28], '#3dff00', 6.11, 'alkaline'),
  E(21, 'Sc', 'Scandium', 44.956, 3, 24, [24], '#e6e6e6', 6.56, 'transition'),
  E(22, 'Ti', 'Titane', 47.867, 4, 26, [24, 25, 26, 27, 28], '#bfc2c7', 6.83, 'transition'),
  E(23, 'V', 'Vanadium', 50.94, 5, 28, [28], '#a6a6ab', 6.75, 'transition'),
  E(24, 'Cr', 'Chrome', 51.996, 3, 28, [26, 28, 29, 30], '#8a99c7', 6.77, 'transition'),
  E(25, 'Mn', 'Manganèse', 54.938, 2, 30, [30], '#9c7ac7', 7.43, 'transition'),
  E(26, 'Fe', 'Fer', 55.845, 2, 30, [28, 30, 31, 32], '#e06633', 7.9, 'transition'),
  E(27, 'Co', 'Cobalt', 58.933, 2, 32, [32], '#f090a0', 7.88, 'transition'),
  E(28, 'Ni', 'Nickel', 58.693, 2, 30, [30, 32, 33, 34, 36], '#50d050', 7.64, 'transition'),
  E(29, 'Cu', 'Cuivre', 63.546, 2, 34, [34, 36], '#c88033', 7.73, 'transition'),
  E(30, 'Zn', 'Zinc', 65.38, 2, 34, [34, 36, 37, 38, 40], '#7d80b0', 9.39, 'transition'),
  E(47, 'Ag', 'Argent', 107.87, 1, 60, [60, 62], '#c0c0c0', 7.58, 'transition'),
  E(79, 'Au', 'Or', 196.97, 1, 118, [118], '#ffd123', 9.23, 'transition'),
  E(92, 'U', 'Uranium', 238.03, 4, 146, [146], '#008fff', 6.19, 'metal'),
];

export const ELEMENT_BY_Z = new Map(ELEMENTS.map((e) => [e.Z, e]));
export const ELEMENT_BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));

/** Un noyau (Z, N) est-il stable dans notre table ? */
export function isStableNucleus(Z: number, N: number): boolean {
  if (Z === 0) return false;
  if (Z === 1 && N === 0) return true;
  const e = ELEMENT_BY_Z.get(Z);
  if (!e) return false;
  return e.stableN.includes(N);
}

/** Nom d'un noyau (ex. « Hélium-4 », « Deutérium »). */
export function nucleusName(Z: number, N: number): string {
  if (Z === 1 && N === 1) return 'Deutérium';
  if (Z === 1 && N === 2) return 'Tritium';
  if (Z === 0) return N === 1 ? 'Neutron' : `${N} neutrons`;
  const e = ELEMENT_BY_Z.get(Z);
  return `${e ? e.name : `Élément ${Z}`}-${Z + N}`;
}

/** Molécules reconnues par formule brute (symboles triés, ex. « H2O »). */
export const KNOWN_MOLECULES: Record<string, string> = {
  H2: 'Dihydrogène', O2: 'Dioxygène', N2: 'Diazote', H2O: 'Eau', CO2: 'Dioxyde de carbone', CO: 'Monoxyde de carbone',
  CH4: 'Méthane', NH3: 'Ammoniac', ClNa: 'Chlorure de sodium (sel)', ClH: 'Chlorure d\'hydrogène', FH: 'Fluorure d\'hydrogène',
  O2Si: 'Silice (quartz)', H2S: 'Sulfure d\'hydrogène', C2H6: 'Éthane', C2H4: 'Éthylène', C2H2: 'Acétylène', CH2O: 'Formaldéhyde',
  CHN: 'Cyanure d\'hydrogène', H2O2: 'Peroxyde d\'hydrogène', O3: 'Ozone', CH4O: 'Méthanol', C2H6O: 'Éthanol', NO: 'Monoxyde d\'azote',
  NO2: 'Dioxyde d\'azote', MgO: 'Oxyde de magnésium', FeO: 'Oxyde de fer (II)', CaO: 'Chaux', H3N: 'Ammoniac', OS: 'Monoxyde de soufre', O2S: 'Dioxyde de soufre',
  C2H5NO2: 'Glycine (acide aminé)', C6H12O6: 'Glucose',
};

/** Formule brute en notation de Hill (C, H puis ordre alphabétique). */
export function hillFormula(symbols: string[]): string {
  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s, (counts.get(s) ?? 0) + 1);
  const keys = [...counts.keys()];
  const hasC = counts.has('C');
  keys.sort((a, b) => {
    if (hasC) {
      if (a === 'C') return -1;
      if (b === 'C') return 1;
      if (a === 'H') return -1;
      if (b === 'H') return 1;
    }
    return a.localeCompare(b);
  });
  return keys.map((k) => k + (counts.get(k)! > 1 ? counts.get(k) : '')).join('');
}
