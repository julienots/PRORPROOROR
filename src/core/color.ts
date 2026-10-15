/**
 * Couleur approximative d'un corps noir (température en K → RGB linéaire 0..1).
 * Ajustement de Tanner Helland sur les données CIE 1964, valable 1000–40000 K.
 */
export function blackbodyRGB(tempK: number): [number, number, number] {
  const t = Math.min(40000, Math.max(800, tempK)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (x: number) => Math.min(1, Math.max(0, x / 255));
  // sRGB → linéaire
  const lin = (x: number) => Math.pow(c(x), 2.2);
  return [lin(r), lin(g), lin(b)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const s = (x: number) => Math.round(Math.pow(Math.min(1, Math.max(0, x)), 1 / 2.2) * 255).toString(16).padStart(2, '0');
  return `#${s(r)}${s(g)}${s(b)}`;
}

/** Classe spectrale de Harvard d'après la température effective. */
export function spectralClass(tempK: number): string {
  if (tempK >= 30000) return 'O';
  if (tempK >= 10000) return 'B';
  if (tempK >= 7500) return 'A';
  if (tempK >= 6000) return 'F';
  if (tempK >= 5200) return 'G';
  if (tempK >= 3700) return 'K';
  if (tempK >= 2400) return 'M';
  if (tempK >= 1300) return 'L';
  return 'T';
}
