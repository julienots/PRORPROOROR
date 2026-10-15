/**
 * Particules-tests (structure de tableaux) : débris de collisions, éjectas de supernova,
 * flux de marée, matière de disque d'accrétion. Elles subissent la gravité des corps
 * massifs dominants mais n'en exercent pas (approximation de masse négligeable,
 * leur masse est toutefois comptabilisée lorsqu'elles sont absorbées).
 */
export const PARTICLE_DEBRIS = 0;
export const PARTICLE_EJECTA = 1;
export const PARTICLE_GAS = 2;
export const PARTICLE_ICE = 3;

export class ParticleSet {
  readonly capacity: number;
  count = 0;
  px: Float64Array; py: Float64Array; pz: Float64Array;
  vx: Float64Array; vy: Float64Array; vz: Float64Array;
  mass: Float64Array;
  life: Float32Array; // années restantes (Infinity = permanent)
  temp: Float32Array; // K
  kind: Uint8Array;
  /** Incrémenté à chaque modification structurelle (pour le rendu). */
  version = 0;

  constructor(capacity = 40000) {
    this.capacity = capacity;
    this.px = new Float64Array(capacity); this.py = new Float64Array(capacity); this.pz = new Float64Array(capacity);
    this.vx = new Float64Array(capacity); this.vy = new Float64Array(capacity); this.vz = new Float64Array(capacity);
    this.mass = new Float64Array(capacity);
    this.life = new Float32Array(capacity);
    this.temp = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, mass: number, kind: number, temp: number, life = Infinity): number {
    let i = this.count;
    if (i >= this.capacity) {
      // remplace une particule au hasard (les plus anciennes disparaissent)
      i = Math.floor(Math.random() * this.capacity);
    } else {
      this.count++;
    }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.mass[i] = mass; this.kind[i] = kind; this.temp[i] = temp; this.life[i] = life;
    this.version++;
    return i;
  }

  remove(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.mass[i] = this.mass[last]; this.kind[i] = this.kind[last]; this.temp[i] = this.temp[last]; this.life[i] = this.life[last];
    }
    this.count--;
    this.version++;
  }

  clear(): void {
    this.count = 0;
    this.version++;
  }

  totalMass(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) m += this.mass[i];
    return m;
  }

  toJSON(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.count; i++) {
      out.push([this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i], this.mass[i], this.kind[i], this.temp[i], Number.isFinite(this.life[i]) ? this.life[i] : -1]);
    }
    return out;
  }

  loadJSON(rows: unknown): void {
    this.clear();
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 10 || !r.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
      this.add(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9] < 0 ? Infinity : r[9]);
    }
  }
}
