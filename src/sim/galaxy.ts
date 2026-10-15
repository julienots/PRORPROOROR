import { Rng, hashCombine } from '../core/rng';
import { clamp, sanitize } from '../core/units';
import type { Vec3 } from '../core/vec';

/**
 * Modèle galactique statistique.
 * Unités : longueur en kal (1000 années-lumière), temps en Ma, masse en M☉.
 * Les étoiles sont des particules-traceurs dans un potentiel analytique :
 *   bulbe de Hernquist + disque de Miyamoto–Nagai + halo de matière noire NFW
 *   + perturbation spirale en onde de densité (Lin & Shu) tournant à Ω_p.
 * [Approximation] : pas d'auto-gravité des étoiles (sauf via le potentiel imposé).
 * Fusion de galaxies : N-corps restreint (Toomre & Toomre 1972) avec friction dynamique.
 */
export const G_GAL = 1.5604e-10; // kal³ / (M☉ · Ma²)
export const KMS_TO_KALMA = 0.0033356; // 1 km/s en kal/Ma

export type GalaxyType = 'spiral' | 'barred' | 'elliptical' | 'lenticular' | 'irregular';

export const GALAXY_TYPE_LABEL: Record<GalaxyType, string> = {
  spiral: 'Spirale', barred: 'Spirale barrée', elliptical: 'Elliptique', lenticular: 'Lenticulaire', irregular: 'Irrégulière',
};

export interface GalaxyParams {
  id: string;
  name: string;
  type: GalaxyType;
  seed: number;
  /** Rayon caractéristique du disque (kal). */
  radius: number;
  /** Masse stellaire (M☉). */
  stellarMass: number;
  /** Masse de matière noire du halo (M☉). */
  darkMatterMass: number;
  /** Rayon d'échelle du halo NFW (kal). */
  haloScale: number;
  gasFraction: number;
  bulgeFraction: number;
  arms: number;
  pitchDeg: number;
  /** Nombre d'étoiles-traceurs simulées et rendues. */
  starCount: number;
  /** Fraction d'étoiles possédant un système planétaire. */
  planetFraction: number;
  /** Sens et intensité de rotation (multiplicateur de la vitesse circulaire). */
  rotation: number;
  createdBy: 'gen' | 'player';
}

export function defaultGalaxyParams(seed: number, type: GalaxyType = 'spiral', name = 'Galaxie'): GalaxyParams {
  const rng = new Rng(seed);
  const isDisk = type === 'spiral' || type === 'barred' || type === 'lenticular';
  return {
    id: `g${seed.toString(36)}`,
    name,
    type,
    seed,
    radius: isDisk ? rng.range(25, 60) : type === 'elliptical' ? rng.range(20, 80) : rng.range(5, 20),
    stellarMass: type === 'irregular' ? rng.logRange(1e8, 5e9) : rng.logRange(2e10, 2e11),
    darkMatterMass: 0,
    haloScale: 0,
    gasFraction: type === 'elliptical' ? 0.01 : type === 'lenticular' ? 0.03 : type === 'irregular' ? 0.4 : rng.range(0.08, 0.2),
    bulgeFraction: type === 'elliptical' ? 1 : type === 'lenticular' ? 0.4 : type === 'irregular' ? 0 : rng.range(0.1, 0.3),
    arms: rng.int(2, 4),
    pitchDeg: rng.range(10, 25),
    starCount: 40000,
    planetFraction: 0.5,
    rotation: 1,
    createdBy: 'gen',
  };
}

/** Complète les paramètres dérivés (halo : ~10× la masse stellaire, d'après les relations observées). */
export function normalizeGalaxyParams(p: GalaxyParams): GalaxyParams {
  p.radius = sanitize(p.radius, 40, 1, 500);
  p.stellarMass = sanitize(p.stellarMass, 5e10, 1e6, 5e12);
  p.darkMatterMass = sanitize(p.darkMatterMass || p.stellarMass * 10, p.stellarMass * 10, 0, 1e14);
  p.haloScale = sanitize(p.haloScale || p.radius * 0.8, p.radius * 0.8, 1, 2000);
  p.gasFraction = sanitize(p.gasFraction, 0.1, 0, 0.95);
  p.bulgeFraction = sanitize(p.bulgeFraction, 0.2, 0, 1);
  p.arms = Math.round(sanitize(p.arms, 2, 1, 8));
  p.pitchDeg = sanitize(p.pitchDeg, 15, 3, 45);
  p.starCount = Math.round(sanitize(p.starCount, 40000, 1000, 200000));
  p.planetFraction = sanitize(p.planetFraction, 0.5, 0, 1);
  p.rotation = sanitize(p.rotation, 1, -2, 2);
  return p;
}

/** Composante de potentiel d'une galaxie (centre mobile pour les fusions). */
export interface GalaxyComponent {
  params: GalaxyParams;
  center: Vec3; // kal
  vel: Vec3; // kal/Ma
  /** Normale du plan du disque. */
  axis: Vec3;
  /** Masses et échelles dérivées. */
  mBulge: number; aBulge: number;
  mDisk: number; aDisk: number; bDisk: number;
  mHalo: number; rsHalo: number;
  patternSpeed: number; // rad/Ma
  /** Halo actif (comparaison avec/sans matière noire). */
  haloOn: boolean;
}

export function makeComponent(params: GalaxyParams, center: Vec3 = { x: 0, y: 0, z: 0 }, vel: Vec3 = { x: 0, y: 0, z: 0 }, axis: Vec3 = { x: 0, y: 1, z: 0 }): GalaxyComponent {
  const p = normalizeGalaxyParams(params);
  const mStar = p.stellarMass * (1 + p.gasFraction);
  const ell = p.type === 'elliptical';
  const mBulge = mStar * (ell ? 1 : p.bulgeFraction);
  const mDisk = mStar - mBulge;
  const comp: GalaxyComponent = {
    params: p, center, vel, axis,
    mBulge, aBulge: ell ? p.radius * 0.35 : p.radius * 0.06,
    mDisk, aDisk: p.radius * 0.22, bDisk: p.radius * 0.02,
    mHalo: p.darkMatterMass, rsHalo: p.haloScale,
    patternSpeed: 0,
    haloOn: true,
  };
  // vitesse de motif : corotation vers 0.6 R
  const r = p.radius * 0.6;
  comp.patternSpeed = circularVelocity(comp, r) / r;
  return comp;
}

/** Accélération (kal/Ma²) au point relatif (x, y, z) dans le repère du disque (y = normale). */
export function accelAt(c: GalaxyComponent, x: number, y: number, z: number, t: number, out: number[], spiral = true): void {
  const G = G_GAL;
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2) + 1e-6;
  let ax = 0, ay = 0, az = 0;
  // bulbe de Hernquist
  if (c.mBulge > 0) {
    const f = (-G * c.mBulge) / (r * (r + c.aBulge) * (r + c.aBulge));
    ax += f * x; ay += f * y; az += f * z;
  }
  // disque de Miyamoto–Nagai (plan x–z)
  const R2 = x * x + z * z;
  if (c.mDisk > 0) {
    const B = Math.sqrt(y * y + c.bDisk * c.bDisk);
    const AB = c.aDisk + B;
    const D2 = R2 + AB * AB;
    const D3 = D2 * Math.sqrt(D2);
    const f = (-G * c.mDisk) / D3;
    ax += f * x; az += f * z;
    ay += (f * y * AB) / B;
  }
  // halo NFW
  if (c.haloOn && c.mHalo > 0) {
    const rs = c.rsHalo;
    const dphidr = G * c.mHalo * (Math.log(1 + r / rs) / r2 - 1 / (r * (r + rs)));
    const f = -dphidr / r;
    ax += f * x; ay += f * y; az += f * z;
  }
  // onde de densité spirale (ou barre) : Φs = -ε G M_d / √(R²+(a+b)²) · cos Ψ
  const type = c.params.type;
  if (spiral && (type === 'spiral' || type === 'barred') && c.mDisk > 0) {
    const R = Math.sqrt(R2) + 1e-6;
    const th = Math.atan2(z, x);
    const m = type === 'barred' && R < c.params.radius * 0.25 ? 2 : c.params.arms;
    const cot = 1 / Math.tan((c.params.pitchDeg * Math.PI) / 180);
    const eps = type === 'barred' && R < c.params.radius * 0.25 ? 0.12 : 0.05;
    const ab = c.aDisk + c.bDisk;
    const S = Math.sqrt(R2 + ab * ab);
    const A = (-eps * G * c.mDisk) / S;
    const dA = (eps * G * c.mDisk * R) / (S * S * S);
    const psi = m * (th - c.patternSpeed * t) - (type === 'barred' && R < c.params.radius * 0.25 ? 0 : cot * Math.log(R / (c.params.radius * 0.3)));
    const cp = Math.cos(psi), sp = Math.sin(psi);
    const vz = Math.exp(-(y * y) / (4 * c.bDisk * c.bDisk + 1e-6));
    const dPhidR = (dA * cp + A * sp * (type === 'barred' && R < c.params.radius * 0.25 ? 0 : cot / R)) * vz;
    const dPhidTh = -A * sp * m * vz;
    const aR = -dPhidR;
    const aT = -dPhidTh / R;
    const ct = x / R, st = z / R;
    ax += aR * ct - aT * st;
    az += aR * st + aT * ct;
  }
  out[0] = ax; out[1] = ay; out[2] = az;
}

/** Vitesse circulaire (kal/Ma) dans le plan à la distance R. */
export function circularVelocity(c: GalaxyComponent, R: number, withHalo = c.haloOn): number {
  const save = c.haloOn;
  c.haloOn = withHalo;
  const out = [0, 0, 0];
  accelAt(c, R, 0, 0, 0, out, false);
  c.haloOn = save;
  return Math.sqrt(Math.max(0, -out[0] * R));
}

/** Courbe de rotation (km/s) avec et sans halo de matière noire. */
export function rotationCurve(c: GalaxyComponent, n = 40): { r: number[]; withDM: number[]; withoutDM: number[] } {
  const r: number[] = [], a: number[] = [], b: number[] = [];
  const rmax = c.params.radius * 2;
  for (let i = 1; i <= n; i++) {
    const R = (rmax * i) / n;
    r.push(R);
    a.push(circularVelocity(c, R, true) / KMS_TO_KALMA);
    b.push(circularVelocity(c, R, false) / KMS_TO_KALMA);
  }
  return { r, withDM: a, withoutDM: b };
}

/** Densité de matière noire NFW (M☉/kal³) à r. */
export function nfwDensity(c: GalaxyComponent, r: number): number {
  const rs = c.rsHalo;
  const x = Math.max(1e-3, r / rs);
  const norm = c.mHalo / (4 * Math.PI * rs * rs * rs);
  return norm / (x * (1 + x) * (1 + x));
}

/** Couleur d'étoile selon sa population (0 jeune bleue → 1 vieille rouge). */
export const STAR_POP_YOUNG = 0;

/**
 * Simulation d'une ou plusieurs galaxies (traceurs). Positions en Float32 (rendu direct).
 */
export class GalaxySim {
  components: GalaxyComponent[] = [];
  n = 0;
  pos: Float32Array = new Float32Array(0);
  vel: Float32Array = new Float32Array(0);
  /** Âge relatif de la population (0 = jeune, 1 = vieille) pour la couleur. */
  age: Float32Array = new Float32Array(0);
  /** Masse stellaire individuelle du traceur représentatif (M☉) pour la génération de systèmes. */
  starMass: Float32Array = new Float32Array(0);
  /** Composante d'origine de chaque étoile. */
  owner: Uint8Array = new Uint8Array(0);
  time = 0; // Ma
  merged = false;
  version = 0;
  private tmp = [0, 0, 0];

  static create(params: GalaxyParams): GalaxySim {
    const g = new GalaxySim();
    g.addGalaxy(params, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    return g;
  }

  /** Ajoute une galaxie (ses étoiles) au système simulé. */
  addGalaxy(params: GalaxyParams, center: Vec3, vel: Vec3, axis: Vec3): GalaxyComponent {
    const comp = makeComponent(params, center, vel, normalize(axis));
    const k = this.components.length;
    this.components.push(comp);
    const N = comp.params.starCount;
    const n0 = this.n;
    this.grow(n0 + N);
    const rng = new Rng(hashCombine(comp.params.seed, 0x51a5));
    const p = comp.params;
    const basis = planeBasis(comp.axis);
    for (let i = 0; i < N; i++) {
      const j = n0 + i;
      let x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, age = 1;
      const kind = rng.next();
      const inBulge = p.type === 'elliptical' || kind < p.bulgeFraction * 0.9;
      if (p.type === 'irregular') {
        // amas aléatoires
        const clump = Math.floor(rng.next() * 7);
        const cr = new Rng(hashCombine(p.seed, clump));
        const cx = cr.gauss(0, p.radius * 0.4), cz = cr.gauss(0, p.radius * 0.4), cy = cr.gauss(0, p.radius * 0.1);
        const s = p.radius * cr.range(0.08, 0.25);
        x = cx + rng.gauss(0, s); y = cy + rng.gauss(0, s * 0.5); z = cz + rng.gauss(0, s);
        const R = Math.hypot(x, z) + 0.1;
        const vc = circularVelocity(comp, R) * 0.6 * p.rotation;
        vx = (-z / R) * vc + rng.gauss(0, vc * 0.3); vz = (x / R) * vc + rng.gauss(0, vc * 0.3); vy = rng.gauss(0, vc * 0.2);
        age = rng.next() < p.gasFraction ? rng.range(0, 0.3) : rng.range(0.3, 1);
      } else if (inBulge) {
        // Hernquist : r = a √u / (1 − √u)
        const u = Math.min(0.995, rng.next());
        const r = (comp.aBulge * Math.sqrt(u)) / (1 - Math.sqrt(u));
        const [dx, dy, dz] = rng.onSphere();
        const flat = p.type === 'elliptical' ? 0.5 + 0.5 * new Rng(p.seed).next() : 0.7;
        x = dx * r; y = dy * r * flat; z = dz * r;
        const vc = circularVelocity(comp, Math.max(r, 0.05));
        const sigma = vc / Math.sqrt(3);
        vx = rng.gauss(0, sigma); vy = rng.gauss(0, sigma * flat); vz = rng.gauss(0, sigma);
        // légère rotation d'ensemble
        const R = Math.hypot(x, z) + 1e-3;
        const rot = p.type === 'elliptical' ? 0.15 : 0.35;
        vx += (-z / R) * vc * rot * p.rotation; vz += (x / R) * vc * rot * p.rotation;
        age = rng.range(0.7, 1);
      } else {
        // disque exponentiel (R ~ Γ(2) h), renforcé dans les bras
        const h = p.radius * 0.3;
        let R = 0, th = 0;
        for (let tries = 0; tries < 20; tries++) {
          R = -h * Math.log(rng.next() * rng.next() + 1e-12);
          th = rng.range(0, Math.PI * 2);
          if (p.type === 'lenticular' || R > p.radius * 2.2) break;
          const cot = 1 / Math.tan((p.pitchDeg * Math.PI) / 180);
          const psi = p.arms * th - cot * Math.log(Math.max(R, 0.1) / (p.radius * 0.3));
          const arm = 0.5 + 0.5 * Math.cos(psi);
          if (rng.next() < 0.12 + 0.88 * Math.pow(arm, 5)) {
            age = rng.next() < p.gasFraction * 4.5 * arm * arm ? rng.range(0, 0.25) : rng.range(0.3, 1);
            break;
          }
        }
        x = Math.cos(th) * R; z = Math.sin(th) * R;
        y = rng.gauss(0, comp.bDisk * (age < 0.3 ? 0.6 : 1.5));
        const vc = circularVelocity(comp, Math.max(R, 0.05));
        const sigma = vc * (age < 0.3 ? 0.04 : 0.1);
        vx = (-Math.sin(th)) * vc * p.rotation + rng.gauss(0, sigma);
        vz = Math.cos(th) * vc * p.rotation + rng.gauss(0, sigma);
        vy = rng.gauss(0, sigma * 0.5);
      }
      // passage au repère monde (plan orienté selon l'axe)
      const wx = basis.e1.x * x + basis.n.x * y + basis.e2.x * z;
      const wy = basis.e1.y * x + basis.n.y * y + basis.e2.y * z;
      const wz = basis.e1.z * x + basis.n.z * y + basis.e2.z * z;
      const wvx = basis.e1.x * vx + basis.n.x * vy + basis.e2.x * vz;
      const wvy = basis.e1.y * vx + basis.n.y * vy + basis.e2.y * vz;
      const wvz = basis.e1.z * vx + basis.n.z * vy + basis.e2.z * vz;
      this.pos[j * 3] = center.x + wx; this.pos[j * 3 + 1] = center.y + wy; this.pos[j * 3 + 2] = center.z + wz;
      this.vel[j * 3] = vel.x + wvx; this.vel[j * 3 + 1] = vel.y + wvy; this.vel[j * 3 + 2] = vel.z + wvz;
      this.age[j] = age;
      this.starMass[j] = age < 0.25 ? rng.logRange(1, 30) : rng.logRange(0.1, 1.5);
      this.owner[j] = k;
    }
    this.n = n0 + N;
    this.version++;
    return comp;
  }

  private grow(n: number): void {
    if (this.pos.length >= n * 3) return;
    const cp = <T extends Float32Array | Uint8Array>(a: T, size: number): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a);
      return b;
    };
    this.pos = cp(this.pos, n * 3); this.vel = cp(this.vel, n * 3);
    this.age = cp(this.age, n); this.starMass = cp(this.starMass, n); this.owner = cp(this.owner, n);
  }

  /** Accélération totale au point monde (somme des composantes). */
  private totalAccel(x: number, y: number, z: number, out: number[]): void {
    let ax = 0, ay = 0, az = 0;
    for (const c of this.components) {
      const b = planeBasis(c.axis);
      const rx = x - c.center.x, ry = y - c.center.y, rz = z - c.center.z;
      // vers le repère local
      const lx = rx * b.e1.x + ry * b.e1.y + rz * b.e1.z;
      const ly = rx * b.n.x + ry * b.n.y + rz * b.n.z;
      const lz = rx * b.e2.x + ry * b.e2.y + rz * b.e2.z;
      accelAt(c, lx, ly, lz, this.time, this.tmp, !this.merged);
      const [a0, a1, a2] = this.tmp;
      ax += b.e1.x * a0 + b.n.x * a1 + b.e2.x * a2;
      ay += b.e1.y * a0 + b.n.y * a1 + b.e2.y * a2;
      az += b.e1.z * a0 + b.n.z * a1 + b.e2.z * a2;
    }
    out[0] = ax; out[1] = ay; out[2] = az;
  }

  /** Masse totale (M☉) d'une composante. */
  static mass(c: GalaxyComponent): number {
    return c.mBulge + c.mDisk + (c.haloOn ? c.mHalo : 0);
  }

  /** Avance de dt (Ma), avec un budget de sous-pas. Retourne le temps réellement simulé. */
  step(dtMyr: number, maxSub = 8): number {
    const dt = sanitize(dtMyr, 0, 0, 1e5);
    if (dt <= 0 || this.n === 0) return 0;
    const nsub = clamp(Math.ceil(dt / 0.8), 1, maxSub);
    const h = Math.min(dt / nsub, 2);
    const out = [0, 0, 0];
    for (let s = 0; s < nsub; s++) {
      this.stepCenters(h);
      const P = this.pos, V = this.vel;
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        this.totalAccel(P[k], P[k + 1], P[k + 2], out);
        V[k] += out[0] * h; V[k + 1] += out[1] * h; V[k + 2] += out[2] * h;
        P[k] += V[k] * h; P[k + 1] += V[k + 1] * h; P[k + 2] += V[k + 2] * h;
      }
      this.time += h;
    }
    // vieillissement des populations et formation stellaire dans les bras
    const simulated = nsub * h;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] < 1) this.age[i] = Math.min(1, this.age[i] + simulated / 3000);
    }
    this.version++;
    return simulated;
  }

  /** Mouvement des centres galactiques (deux corps adoucis + friction dynamique). */
  private stepCenters(h: number): void {
    const cs = this.components;
    if (cs.length < 2) return;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const A = cs[i], B = cs[j];
        const dx = B.center.x - A.center.x, dy = B.center.y - A.center.y, dz = B.center.z - A.center.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const soft = 0.5 * (A.rsHalo + B.rsHalo);
        const mA = GalaxySim.mass(A), mB = GalaxySim.mass(B);
        // masse enclose approximative du halo (profil NFW → croissance logarithmique)
        const encl = (m: number, rs: number) => m * Math.min(1, Math.log(1 + d / rs) / Math.log(1 + 10));
        const fA = (G_GAL * encl(mB, B.rsHalo)) / (d * d + soft * soft);
        const fB = (G_GAL * encl(mA, A.rsHalo)) / (d * d + soft * soft);
        const ux = dx / (d + 1e-9), uy = dy / (d + 1e-9), uz = dz / (d + 1e-9);
        A.vel.x += ux * fA * h; A.vel.y += uy * fA * h; A.vel.z += uz * fA * h;
        B.vel.x -= ux * fB * h; B.vel.y -= uy * fB * h; B.vel.z -= uz * fB * h;
        // friction dynamique (Chandrasekhar, forme simplifiée) quand les halos se recouvrent
        const overlap = clamp(1 - d / (2.5 * (A.rsHalo + B.rsHalo)), 0, 1);
        if (overlap > 0) {
          const k = 0.004 * overlap * h;
          const rvx = B.vel.x - A.vel.x, rvy = B.vel.y - A.vel.y, rvz = B.vel.z - A.vel.z;
          const mt = mA + mB;
          A.vel.x += rvx * k * (mB / mt); A.vel.y += rvy * k * (mB / mt); A.vel.z += rvz * k * (mB / mt);
          B.vel.x -= rvx * k * (mA / mt); B.vel.y -= rvy * k * (mA / mt); B.vel.z -= rvz * k * (mA / mt);
        }
        const rv = Math.hypot(B.vel.x - A.vel.x, B.vel.y - A.vel.y, B.vel.z - A.vel.z);
        if (!this.merged && d < 0.15 * (A.params.radius + B.params.radius) && rv < 0.3) this.merged = true;
      }
    }
    for (const c of cs) {
      c.center.x += c.vel.x * h; c.center.y += c.vel.y * h; c.center.z += c.vel.z * h;
    }
  }

  setHalo(on: boolean): void {
    for (const c of this.components) c.haloOn = on;
  }

  /** Dispersion de vitesse et rayon effectif (diagnostics). */
  diagnostics(): { meanRadius: number; boundFraction: number } {
    let sr = 0, bound = 0;
    const c = this.components[0];
    if (!c) return { meanRadius: 0, boundFraction: 0 };
    for (let i = 0; i < this.n; i++) {
      const x = this.pos[i * 3] - c.center.x, y = this.pos[i * 3 + 1] - c.center.y, z = this.pos[i * 3 + 2] - c.center.z;
      const r = Math.hypot(x, y, z);
      sr += r;
      if (r < c.params.radius * 3) bound++;
    }
    return { meanRadius: sr / this.n, boundFraction: bound / this.n };
  }

  /**
   * Lance une fusion : ajoute une seconde galaxie sur une trajectoire parabolique
   * approchante (péricentre ~ rayon du disque).
   */
  startMerger(other: GalaxyParams, distance = 0): GalaxyComponent {
    const A = this.components[0];
    const d = distance || A.params.radius * 5;
    const mA = GalaxySim.mass(A);
    const v = Math.sqrt((2 * G_GAL * mA * 0.6) / d) * 0.8;
    const center = { x: A.center.x + d, y: A.center.y + d * 0.15, z: A.center.z + d * 0.3 };
    const vel = { x: A.vel.x - v * 0.75, y: A.vel.y, z: A.vel.z - v * 0.35 };
    const ax = normalize({ x: 0.4, y: 1, z: -0.3 });
    return this.addGalaxy(other, center, vel, ax);
  }
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Base orthonormée (e1, n, e2) d'un plan de normale n. */
export function planeBasis(n0: Vec3): { e1: Vec3; n: Vec3; e2: Vec3 } {
  const n = normalize(n0);
  const ref = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  // e1 = ref − (ref·n) n
  const d = ref.x * n.x + ref.y * n.y + ref.z * n.z;
  const e1 = normalize({ x: ref.x - d * n.x, y: ref.y - d * n.y, z: ref.z - d * n.z });
  // e2 = e1 × n   (pour garder la convention x→z du repère local, y = n)
  const e2 = { x: e1.y * n.z - e1.z * n.y, y: e1.z * n.x - e1.x * n.z, z: e1.x * n.y - e1.y * n.x };
  return { e1, n, e2 };
}

/** Graine d'un système stellaire d'une étoile d'une galaxie. */
export const starSystemSeed = (galaxySeed: number, starIndex: number) => hashCombine(galaxySeed, starIndex, 0x5757);
