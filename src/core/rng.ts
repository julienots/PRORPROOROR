/**
 * Générateurs pseudo-aléatoires reproductibles.
 * Toute la génération procédurale du jeu dérive d'une graine 32 bits,
 * combinée hiérarchiquement (univers → galaxie → étoile → planète).
 */

/** Hash 32 bits d'une chaîne (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mélange robuste de plusieurs entiers en une graine (variante de murmur3 fmix). */
export function hashCombine(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    let k = (Math.floor(v) | 0) >>> 0;
    k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
    k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
    k ^= k >>> 16;
    h = Math.imul(h ^ k, 0x27d4eb2d) + 0x165667b1;
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** RNG sfc32 initialisé par splitmix32. Période ~2^128, rapide, reproductible. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    let s = this.seed;
    const split = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = split();
    this.b = split();
    this.c = split();
    this.d = split();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Flottant uniforme dans [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Loi normale (Box–Muller). */
  gauss(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Distribution log-uniforme entre min et max (> 0). */
  logRange(min: number, max: number): number {
    return Math.exp(this.range(Math.log(min), Math.log(max)));
  }

  /** Point uniforme sur la sphère unité. */
  onSphere(): [number, number, number] {
    const z = this.range(-1, 1);
    const t = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), r * Math.sin(t), z];
  }

  /** Sous-générateur indépendant et reproductible. */
  fork(tag: number | string): Rng {
    const t = typeof tag === 'string' ? hashString(tag) : tag;
    return new Rng(hashCombine(this.seed, t));
  }
}
