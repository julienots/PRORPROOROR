import { G_SIM, AU_KM, C_AU_YR, M_EARTH_SUN, clamp, sanitize, km2au, fmtMassSun, fmtYears } from '../core/units';
import { Rng } from '../core/rng';
import { v3, vclone, vsub, vlen, vnorm, vscale, vcross, vperp, vdot, type Vec3, visFinite } from '../core/vec';
import { createBuffers, computeAccelerations, type GravityBuffers } from './gravity';
import { keplerPropagate, hillRadius } from './kepler';
import { ParticleSet, PARTICLE_DEBRIS, PARTICLE_EJECTA, PARTICLE_GAS, PARTICLE_ICE } from './particles';
import {
  stellarStateAt, stellarFate, remnantMass, whiteDwarfMass, jeansMass, freeFallTime, cloudRadiusKm, protostarDuration,
  supernovaEjectaSpeedAUyr, HYDROGEN_BURNING_MIN, BROWN_DWARF_MIN,
} from './stellar';
import {
  schwarzschildRadiusKm, iscoRadiusRs, accretionLuminosity, radiativeEfficiency, gwPower, mergeBlackHoles, tidalRadiusKm, gwFrequency,
} from './blackhole';
import {
  equilibriumTemperature, greenhouseWarming, waterState, habitability, LIFE_THRESHOLDS, LIFE_LABELS, atmosphereRetention, bulkDensity,
} from './planet';
import {
  makeCompactRemnant, makeBlackHole, makeNebula, makePlanet, makeStar, makeBrownDwarf, refreshStar, refreshPlanetRadius,
} from './factory';
import { mixComposition, type Body, type SimEvent } from './types';

export interface WorldSettings {
  integration: 'auto' | 'nbody' | 'kepler';
  collisions: boolean;
  /** Inclure la gravité des halos de matière noire (comparaison avec/sans). */
  darkMatterGravity: boolean;
  /** Amplification divine du rayonnement gravitationnel (1 = physique réelle). */
  gwBoost: number;
  /** Précision : fraction de l'échelle de temps dynamique par sous-pas. */
  eta: number;
  maxSubsteps: number;
  /** Budget de calcul par image (ms). */
  budgetMs: number;
  stellarEvolution: boolean;
}

export const DEFAULT_SETTINGS: WorldSettings = {
  integration: 'auto',
  collisions: true,
  darkMatterGravity: true,
  gwBoost: 1e10,
  eta: 0.02,
  maxSubsteps: 600,
  budgetMs: 8,
  stellarEvolution: true,
};

export interface StepReport {
  requested: number;
  achieved: number;
  substeps: number;
  mode: 'nbody' | 'kepler';
  ms: number;
}

const KMS_TO_AUYR = 0.2109495;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Monde simulé d'un système stellaire : corps massifs (N-corps), particules-tests,
 * évolution stellaire, collisions, marées, trous noirs et évènements.
 * Module pur : aucune dépendance au rendu.
 */
export class World {
  bodies: Body[] = [];
  particles = new ParticleSet(40000);
  time = 0;
  nextId = 1;
  events: SimEvent[] = [];
  settings: WorldSettings = { ...DEFAULT_SETTINGS };
  /** Incrémenté à chaque ajout/suppression de corps (pour le rendu). */
  version = 0;
  lastReport: StepReport = { requested: 0, achieved: 0, substeps: 0, mode: 'nbody', ms: 0 };
  /** Animation des fusions de trous noirs en cours (temps réel). */
  private listeners = new Set<(e: SimEvent) => void>();
  private buf: GravityBuffers = createBuffers(64);
  private idx: Body[] = [];
  private rng = new Rng(12345);
  /** Corps dont l'équilibre thermique initial a déjà été calculé. */
  private thermalInit = new WeakSet<Body>();
  /** Ondes gravitationnelles récentes (pour la visualisation et l'analyse). */
  gwSignals: { t: number; pos: Vec3; strain: number; freq: number; amp: number; age: number }[] = [];

  onEvent(fn: (e: SimEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: Omit<SimEvent, 't'>): void {
    const ev: SimEvent = { ...e, t: this.time };
    this.events.push(ev);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    for (const l of this.listeners) l(ev);
  }

  // -------------------------------------------------------------------------
  // Gestion des corps
  // -------------------------------------------------------------------------

  add(b: Body, silent = false): Body {
    if (!visFinite(b.pos) || !visFinite(b.vel) || !Number.isFinite(b.mass) || b.mass <= 0) {
      throw new Error(`Corps invalide : ${b.name}`);
    }
    b.id = this.nextId++;
    this.bodies.push(b);
    this.version++;
    if (!silent) this.emit({ type: 'create', message: `Création : ${b.name} (${fmtMassSun(b.mass)})`, bodyId: b.id, pos: vclone(b.pos) });
    return b;
  }

  get(id: number | undefined): Body | undefined {
    if (id === undefined) return undefined;
    return this.bodies.find((b) => b.id === id);
  }

  remove(id: number, reason?: string): Body | undefined {
    const i = this.bodies.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    const [b] = this.bodies.splice(i, 1);
    this.version++;
    if (reason) this.emit({ type: 'destroy', message: reason, bodyId: b.id, pos: vclone(b.pos) });
    return b;
  }

  clear(): void {
    this.bodies = [];
    this.particles.clear();
    this.events = [];
    this.gwSignals = [];
    this.time = 0;
    this.version++;
  }

  /** Corps le plus massif (étoile/trou noir central). */
  primary(): Body | undefined {
    let best: Body | undefined;
    for (const b of this.bodies) if (b.kind !== 'darkmatter' && b.kind !== 'nebula' && (!best || b.mass > best.mass)) best = b;
    return best;
  }

  totalMass(includeParticles = true): number {
    let m = 0;
    for (const b of this.bodies) m += b.mass;
    if (includeParticles) m += this.particles.totalMass();
    return m;
  }

  centerOfMass(): { pos: Vec3; vel: Vec3 } {
    const pos = v3(), vel = v3();
    let m = 0;
    for (const b of this.bodies) {
      pos.x += b.pos.x * b.mass; pos.y += b.pos.y * b.mass; pos.z += b.pos.z * b.mass;
      vel.x += b.vel.x * b.mass; vel.y += b.vel.y * b.mass; vel.z += b.vel.z * b.mass;
      m += b.mass;
    }
    if (m > 0) { pos.x /= m; pos.y /= m; pos.z /= m; vel.x /= m; vel.y /= m; vel.z /= m; }
    return { pos, vel };
  }

  momentum(includeParticles = true): Vec3 {
    const p = v3();
    for (const b of this.bodies) { p.x += b.vel.x * b.mass; p.y += b.vel.y * b.mass; p.z += b.vel.z * b.mass; }
    if (includeParticles) {
      const P = this.particles;
      for (let i = 0; i < P.count; i++) { p.x += P.vx[i] * P.mass[i]; p.y += P.vy[i] * P.mass[i]; p.z += P.vz[i] * P.mass[i]; }
    }
    return p;
  }

  /** Énergie mécanique totale (M☉ UA²/an²) des corps massifs. */
  energy(): number {
    let e = 0;
    const bs = this.activeBodies();
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i];
      e += 0.5 * a.mass * (a.vel.x ** 2 + a.vel.y ** 2 + a.vel.z ** 2);
      for (let j = i + 1; j < bs.length; j++) {
        const b = bs[j];
        const eps2 = this.softening(a) ** 2 + this.softening(b) ** 2;
        e -= (G_SIM * a.mass * b.mass) / Math.sqrt((a.pos.x - b.pos.x) ** 2 + (a.pos.y - b.pos.y) ** 2 + (a.pos.z - b.pos.z) ** 2 + eps2);
      }
    }
    return e;
  }

  private activeBodies(): Body[] {
    return this.settings.darkMatterGravity ? this.bodies : this.bodies.filter((b) => b.kind !== 'darkmatter');
  }

  /** Longueur d'adoucissement (UA) : objets étendus = rayon, compacts ≈ 0. */
  softening(b: Body): number {
    if (b.kind === 'darkmatter') return km2au(b.radius) * 0.6;
    if (b.kind === 'nebula') return km2au(b.radius) * 0.5;
    return km2au(b.radius) * 0.02;
  }

  // -------------------------------------------------------------------------
  // Intégration
  // -------------------------------------------------------------------------

  private loadBuffers(list: Body[]): void {
    const n = list.length;
    if (this.buf.px.length < n) this.buf = createBuffers(Math.max(n, this.buf.px.length * 2));
    const b = this.buf;
    b.n = n;
    for (let i = 0; i < n; i++) {
      const o = list[i];
      b.px[i] = o.pos.x; b.py[i] = o.pos.y; b.pz[i] = o.pos.z;
      b.vx[i] = o.vel.x; b.vy[i] = o.vel.y; b.vz[i] = o.vel.z;
      b.m[i] = o.mass; b.eps[i] = this.softening(o);
    }
  }

  /**
   * Avance la simulation de `dt` années. Si le nombre de sous-pas nécessaire dépasse le
   * budget, bascule (mode auto) sur la propagation képlérienne hiérarchique.
   */
  step(dtRequested: number): StepReport {
    const t0 = now();
    const dt = sanitize(dtRequested, 0, 0, 1e12);
    const report: StepReport = { requested: dt, achieved: 0, substeps: 0, mode: 'nbody', ms: 0 };
    if (dt <= 0 || this.bodies.length === 0) {
      this.updateMergers(0);
      report.ms = now() - t0;
      this.lastReport = report;
      return report;
    }
    const list = this.activeBodies();
    this.idx = list;
    let useKepler = this.settings.integration === 'kepler';
    if (!useKepler && list.length > 0) {
      this.loadBuffers(list);
      const tau = computeAccelerations(this.buf);
      const needed = Number.isFinite(tau) ? dt / (this.settings.eta * tau) : 1;
      if (this.settings.integration === 'auto' && needed > this.settings.maxSubsteps * 4 && list.length > 1) useKepler = true;
    }
    if (useKepler) {
      this.keplerStep(dt);
      this.applyGWSecular(dt);
      report.mode = 'kepler';
      report.achieved = dt;
      report.substeps = 1;
      this.particleKeplerStep(dt);
    } else {
      let remaining = dt;
      let sub = 0;
      while (remaining > 1e-15 && sub < this.settings.maxSubsteps) {
        this.loadBuffers(this.idx);
        const tau = computeAccelerations(this.buf);
        let h = Number.isFinite(tau) ? this.settings.eta * tau : remaining;
        h = Math.min(h, remaining);
        if (h <= 0 || !Number.isFinite(h)) h = remaining;
        this.kdk(h);
        remaining -= h;
        report.achieved += h;
        sub++;
        if (this.settings.collisions) this.handleCollisions();
        this.applyGWReaction(h);
        if (now() - t0 > this.settings.budgetMs) break;
      }
      report.substeps = sub;
      this.stepParticles(report.achieved);
    }
    this.time += report.achieved;
    this.evolve(report.achieved);
    this.updateMergers(0);
    for (const s of this.gwSignals) s.age += report.achieved;
    report.ms = now() - t0;
    this.lastReport = report;
    return report;
  }

  /** Pas leapfrog KDK (kick–drift–kick) sur la liste courante. */
  private kdk(h: number): void {
    const b = this.buf;
    const list = this.idx;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const o = list[i];
      if (o.pinned) continue;
      o.vel.x += 0.5 * h * b.ax[i]; o.vel.y += 0.5 * h * b.ay[i]; o.vel.z += 0.5 * h * b.az[i];
      o.pos.x += h * o.vel.x; o.pos.y += h * o.vel.y; o.pos.z += h * o.vel.z;
      // expansion des rémanents
      if (o.nebula?.remnant && o.nebula.expansionSpeed > 0) o.radius += o.nebula.expansionSpeed * h * AU_KM;
    }
    this.loadBuffers(list);
    computeAccelerations(this.buf);
    for (let i = 0; i < n; i++) {
      const o = list[i];
      if (o.pinned) continue;
      o.vel.x += 0.5 * h * b.ax[i]; o.vel.y += 0.5 * h * b.ay[i]; o.vel.z += 0.5 * h * b.az[i];
    }
  }

  /** Détermine le parent gravitationnel de chaque corps (sphères de Hill emboîtées). */
  computeParents(): void {
    const sorted = this.bodies.filter((b) => b.kind !== 'darkmatter').sort((a, b) => b.mass - a.mass);
    const hill = new Map<number, number>();
    if (sorted.length === 0) return;
    const root = sorted[0];
    root.parentId = undefined;
    hill.set(root.id, Infinity);
    for (let k = 1; k < sorted.length; k++) {
      const b = sorted[k];
      let best: Body | undefined;
      let bestMass = Infinity;
      for (let j = 0; j < k; j++) {
        const c = sorted[j];
        const d = Math.hypot(b.pos.x - c.pos.x, b.pos.y - c.pos.y, b.pos.z - c.pos.z);
        if (d < (hill.get(c.id) ?? 0) && c.mass < bestMass && c.mass > b.mass) {
          best = c;
          bestMass = c.mass;
        }
      }
      if (!best) best = root;
      b.parentId = best.id;
      const pp = best;
      const dp = Math.hypot(b.pos.x - pp.pos.x, b.pos.y - pp.pos.y, b.pos.z - pp.pos.z);
      hill.set(b.id, hillRadius(dp, b.mass, pp.mass));
    }
    for (const b of this.bodies) if (b.kind === 'darkmatter') b.parentId = root.id;
  }

  /** Propagation képlérienne hiérarchique (mode séculaire, interactions mutuelles négligées). */
  private keplerStep(dt: number): void {
    this.computeParents();
    const byId = new Map(this.bodies.map((b) => [b.id, b]));
    const depth = (b: Body): number => {
      let d = 0;
      let c: Body | undefined = b;
      while (c?.parentId !== undefined && d < 50) { c = byId.get(c.parentId); d++; }
      return d;
    };
    const order = [...this.bodies].sort((a, b) => depth(a) - depth(b));
    // états relatifs initiaux
    const rel = new Map<number, { r: Vec3; v: Vec3 }>();
    for (const b of order) {
      const p = b.parentId !== undefined ? byId.get(b.parentId) : undefined;
      if (p) rel.set(b.id, { r: vsub(b.pos, p.pos), v: vsub(b.vel, p.vel) });
    }
    for (const b of order) {
      const p = b.parentId !== undefined ? byId.get(b.parentId) : undefined;
      if (!p) {
        if (!b.pinned) { b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt; b.pos.z += b.vel.z * dt; }
        continue;
      }
      const s = rel.get(b.id)!;
      const res = keplerPropagate(s.r, s.v, G_SIM * (p.mass + b.mass), dt);
      if (!res) continue;
      b.pos = { x: p.pos.x + res.r.x, y: p.pos.y + res.r.y, z: p.pos.z + res.r.z };
      b.vel = { x: p.vel.x + res.v.x, y: p.vel.y + res.v.y, z: p.vel.z + res.v.z };
      if (b.nebula?.remnant && b.nebula.expansionSpeed > 0) b.radius += b.nebula.expansionSpeed * dt * AU_KM;
    }
  }

  // -------------------------------------------------------------------------
  // Particules
  // -------------------------------------------------------------------------

  private attractors(k = 8): Body[] {
    return [...this.bodies]
      .filter((b) => b.kind !== 'nebula' && (b.kind !== 'darkmatter' || this.settings.darkMatterGravity))
      .sort((a, b) => b.mass - a.mass)
      .slice(0, k);
  }

  private stepParticles(dt: number): void {
    const P = this.particles;
    if (P.count === 0 || dt <= 0) return;
    const att = this.attractors();
    // sous-pas adaptés à l'échelle de temps la plus courte (borne de coût)
    let minTau = Infinity;
    const sample = Math.min(P.count, 200);
    for (let s = 0; s < sample; s++) {
      const i = Math.floor((s / sample) * P.count);
      for (const a of att) {
        const r = Math.hypot(P.px[i] - a.pos.x, P.py[i] - a.pos.y, P.pz[i] - a.pos.z);
        const tau = Math.sqrt((r * r * r) / (G_SIM * a.mass + 1e-30));
        if (tau < minTau) minTau = tau;
      }
    }
    const nsub = clamp(Math.ceil(dt / (0.05 * minTau)), 1, P.count > 10000 ? 6 : 16);
    const h = dt / nsub;
    const ax = att.map((a) => a.pos.x), ay = att.map((a) => a.pos.y), az = att.map((a) => a.pos.z);
    const gm = att.map((a) => G_SIM * a.mass);
    const ep2 = att.map((a) => this.softening(a) ** 2 + 1e-14);
    const captureR = att.map((a) =>
      a.kind === 'blackhole' && a.bh ? Math.max(km2au(a.radius) * iscoRadiusRs(a.bh.spin) * 1.0, 2e-5) : km2au(a.radius),
    );
    const vxA = att.map((a) => a.vel.x), vyA = att.map((a) => a.vel.y), vzA = att.map((a) => a.vel.z);
    for (let s = 0; s < nsub; s++) {
      for (let i = P.count - 1; i >= 0; i--) {
        let x = P.px[i], y = P.py[i], z = P.pz[i];
        let axx = 0, ayy = 0, azz = 0;
        let absorbedBy = -1;
        for (let k = 0; k < att.length; k++) {
          const dx = ax[k] - x, dy = ay[k] - y, dz = az[k] - z;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (att[k].kind !== 'darkmatter' && r2 < captureR[k] * captureR[k]) { absorbedBy = k; break; }
          const s2 = r2 + ep2[k];
          const inv = 1 / Math.sqrt(s2);
          const f = gm[k] * inv * inv * inv;
          axx += dx * f; ayy += dy * f; azz += dz * f;
          // viscosité du disque autour d'un trou noir : spirale vers l'intérieur
          if (att[k].kind === 'blackhole' && P.kind[i] === PARTICLE_GAS && r2 < 0.04) {
            // perte de moment cinétique ~1 % par orbite (paramètre α effectif, approx.)
            const tOrb = 2 * Math.PI * Math.sqrt((r2 * Math.sqrt(r2)) / gm[k]);
            const d = Math.min(0.2, (0.01 * h) / Math.max(tOrb, 1e-12));
            P.vx[i] -= (P.vx[i] - vxA[k]) * d;
            P.vy[i] -= (P.vy[i] - vyA[k]) * d;
            P.vz[i] -= (P.vz[i] - vzA[k]) * d;
          }
        }
        if (absorbedBy >= 0) {
          this.absorbParticle(att[absorbedBy], P.mass[i], P.vx[i], P.vy[i], P.vz[i]);
          P.remove(i);
          continue;
        }
        P.vx[i] += axx * h; P.vy[i] += ayy * h; P.vz[i] += azz * h;
        x += P.vx[i] * h; y += P.vy[i] * h; z += P.vz[i] * h;
        P.px[i] = x; P.py[i] = y; P.pz[i] = z;
        if (Number.isFinite(P.life[i])) {
          P.life[i] -= h;
          if (P.life[i] <= 0) { P.remove(i); continue; }
        }
        // refroidissement
        if (P.temp[i] > 50) P.temp[i] *= Math.exp(-h / 50);
      }
    }
    // retrait des particules très lointaines (sorties du système)
    for (let i = P.count - 1; i >= 0; i--) {
      if (Math.abs(P.px[i]) > 2e5 || Math.abs(P.py[i]) > 2e5 || Math.abs(P.pz[i]) > 2e5 || !Number.isFinite(P.px[i])) P.remove(i);
    }
  }

  private particleKeplerStep(dt: number): void {
    const P = this.particles;
    const root = this.primary();
    if (!root || P.count === 0) return;
    const mu = G_SIM * root.mass;
    for (let i = P.count - 1; i >= 0; i--) {
      const r = { x: P.px[i] - root.pos.x, y: P.py[i] - root.pos.y, z: P.pz[i] - root.pos.z };
      const v = { x: P.vx[i] - root.vel.x, y: P.vy[i] - root.vel.y, z: P.vz[i] - root.vel.z };
      const res = keplerPropagate(r, v, mu, dt);
      if (!res) { P.remove(i); continue; }
      P.px[i] = root.pos.x + res.r.x; P.py[i] = root.pos.y + res.r.y; P.pz[i] = root.pos.z + res.r.z;
      P.vx[i] = root.vel.x + res.v.x; P.vy[i] = root.vel.y + res.v.y; P.vz[i] = root.vel.z + res.v.z;
      if (Number.isFinite(P.life[i])) {
        P.life[i] -= dt;
        if (P.life[i] <= 0) P.remove(i);
      }
    }
  }

  private absorbParticle(b: Body, m: number, vx: number, vy: number, vz: number): void {
    if (m <= 0) return;
    // quantité de mouvement transférée au corps absorbant
    const mt = b.mass + m;
    b.vel.x = (b.vel.x * b.mass + vx * m) / mt;
    b.vel.y = (b.vel.y * b.mass + vy * m) / mt;
    b.vel.z = (b.vel.z * b.mass + vz * m) / mt;
    b.mass = mt;
    // pour un trou noir, la matière capturée alimente d'abord le disque (incluse dans sa masse gravitationnelle)
    if (b.kind === 'blackhole' && b.bh) b.bh.diskMass += m;
  }

  // -------------------------------------------------------------------------
  // Collisions, marées, absorption
  // -------------------------------------------------------------------------

  private handleCollisions(): void {
    const bs = this.bodies;
    if (bs.length < 2) return;
    // balayage selon x (sweep and prune)
    const items = bs
      .filter((b) => b.kind !== 'darkmatter')
      .map((b) => {
        const r = this.interactionRadiusAU(b);
        return { b, lo: b.pos.x - r, hi: b.pos.x + r, r };
      })
      .sort((a, b) => a.lo - b.lo);
    const pairs: [Body, Body][] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length && items[j].lo <= items[i].hi; j++) {
        const A = items[i].b, B = items[j].b;
        const d = Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y, A.pos.z - B.pos.z);
        if (d < items[i].r + items[j].r) pairs.push([A, B]);
      }
    }
    const dead = new Set<number>();
    for (const [A, B] of pairs) {
      if (dead.has(A.id) || dead.has(B.id)) continue;
      const d = Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y, A.pos.z - B.pos.z);
      const res = this.resolveContact(A, B, d);
      for (const id of res) dead.add(id);
    }
  }

  /** Rayon d'interaction (UA) : rayon physique, de marée ou de capture. */
  private interactionRadiusAU(b: Body): number {
    const r = km2au(b.radius);
    if (b.kind === 'blackhole') return Math.max(r * 3, 1e-6) + 0.002; // inclut la zone de marée potentielle
    if (b.kind === 'star' || b.kind === 'neutronstar' || b.kind === 'whitedwarf' || (b.planet?.gasGiant ?? false)) return r * 3;
    return r;
  }

  /** Résout un contact potentiel ; retourne les identifiants de corps détruits. */
  private resolveContact(A: Body, B: Body, d: number): number[] {
    // ordonner : A = le plus massif
    if (B.mass > A.mass) [A, B] = [B, A];
    const rA = km2au(A.radius), rB = km2au(B.radius);
    if (A.kind === 'nebula' || B.kind === 'nebula') {
      if (A.kind === 'nebula' && B.kind === 'nebula' && d < Math.max(rA, rB) * 0.6) {
        this.mergeNebulae(A, B);
        return [B.id];
      }
      // une étoile traversant un nuage : enrichissement du nuage par un rémanent
      if (A.kind === 'nebula' && A.nebula && B.kind !== 'nebula' && d < rA) return [];
      if (B.kind === 'nebula' && B.nebula && A.kind !== 'nebula') {
        if (d < rB * 0.3 && (A.kind === 'blackhole')) {
          // un trou noir dans un nuage : accrétion de gaz
          const take = Math.min(B.mass, B.mass * 0.01);
          B.mass -= take;
          A.mass += take;
          A.bh!.diskMass += take;
          if (B.mass < 0.005) { this.remove(B.id, `${B.name} entièrement avalée par ${A.name}`); return [B.id]; }
        }
        return [];
      }
      return [];
    }
    // trou noir : marée puis absorption
    if (A.kind === 'blackhole') {
      if (B.kind === 'blackhole') {
        if (d < Math.max(rA, rB) * 6 + 1e-4) {
          this.startBHMerger(A, B);
          return [B.id];
        }
        return [];
      }
      const rt = km2au(tidalRadiusKm(A.mass, B.mass, B.radius));
      if (d < Math.max(rt, rA * 3) && B.mass < A.mass) {
        if (rt > rA * 3 && B.kind !== 'neutronstar') {
          this.tidalDisrupt(A, B, true);
        } else {
          this.swallow(A, B);
        }
        return [B.id];
      }
      return [];
    }
    // dislocation de marée par une étoile / géante (limite de Roche)
    const isPrimaryBig = A.kind === 'star' || A.kind === 'whitedwarf' || A.kind === 'neutronstar' || A.planet?.gasGiant || A.kind === 'browndwarf';
    if (isPrimaryBig && B.mass < 0.05 * A.mass && B.kind !== 'neutronstar' && B.kind !== 'whitedwarf') {
      const rhoA = bulkDensity(A), rhoB = bulkDensity(B);
      const roche = rA * 2.44 * Math.cbrt(rhoA / Math.max(1, rhoB));
      if (d < rA + rB) {
        this.engulf(A, B);
        return [B.id];
      }
      if (d < roche && B.radius > 20 && (B.kind === 'planet' || B.kind === 'moon' || B.kind === 'comet' || B.kind === 'star')) {
        this.tidalDisrupt(A, B, false);
        return [B.id];
      }
      return [];
    }
    if (d >= rA + rB) return [];
    // contact physique
    if ((A.kind === 'star' || A.kind === 'protostar') && (B.kind === 'star' || B.kind === 'protostar' || B.kind === 'browndwarf' || B.kind === 'whitedwarf')) {
      this.mergeStars(A, B);
      return [B.id];
    }
    if (A.kind === 'neutronstar' && B.kind === 'neutronstar') {
      // kilonova → trou noir si masse > limite TOV
      const m = A.mass + B.mass;
      const p = this.momentumOf(A, B);
      this.remove(A.id); this.remove(B.id);
      const nb = m > 2.2 ? makeBlackHole({ mass: m * 0.95, spin: 0.7, pos: this.comPos(A, B), vel: vscale(p, 1 / m) }) : makeCompactRemnant('neutronstar', m * 0.97, A);
      if (nb.kind === 'neutronstar') { nb.pos = this.comPos(A, B); nb.vel = vscale(p, 1 / m); }
      this.add(nb, true);
      this.spawnShell(nb.pos, nb.vel, 0.05 * m, PARTICLE_EJECTA, 1500, 1e9, 0.3 * C_AU_YR * 0.1);
      this.emit({ type: 'supernova', message: `Kilonova : fusion d'étoiles à neutrons → ${nb.kind === 'blackhole' ? 'trou noir' : 'étoile à neutrons'} (éléments lourds r-process)`, bodyId: nb.id, pos: vclone(nb.pos), magnitude: 3 });
      return [A.id, B.id];
    }
    return this.collideSolid(A, B);
  }

  private momentumOf(A: Body, B: Body): Vec3 {
    return {
      x: A.vel.x * A.mass + B.vel.x * B.mass,
      y: A.vel.y * A.mass + B.vel.y * B.mass,
      z: A.vel.z * A.mass + B.vel.z * B.mass,
    };
  }

  private comPos(A: Body, B: Body): Vec3 {
    const m = A.mass + B.mass;
    return {
      x: (A.pos.x * A.mass + B.pos.x * B.mass) / m,
      y: (A.pos.y * A.mass + B.pos.y * B.mass) / m,
      z: (A.pos.z * A.mass + B.pos.z * B.mass) / m,
    };
  }

  /** Fusion parfaitement inélastique de B dans A (conservation masse + quantité de mouvement). */
  private absorbInto(A: Body, B: Body): void {
    const m = A.mass + B.mass;
    const p = this.momentumOf(A, B);
    A.pos = this.comPos(A, B);
    A.vel = vscale(p, 1 / m);
    A.composition = mixComposition(A.composition, A.mass, B.composition, B.mass);
    A.mass = m;
  }

  private engulf(A: Body, B: Body): void {
    this.absorbInto(A, B);
    if (A.star) A.star.metallicity = clamp(A.composition.heavy + A.composition.metal + A.composition.rock, 0.0001, 0.1);
    this.remove(B.id);
    this.emit({ type: 'swallow', message: `${B.name} est englouti(e) par ${A.name}`, bodyId: A.id, pos: vclone(A.pos), magnitude: 1 });
  }

  private swallow(A: Body, B: Body): void {
    const m = B.mass;
    this.absorbInto(A, B);
    A.radius = schwarzschildRadiusKm(A.mass);
    if (A.bh) A.bh.swallowed += m;
    this.remove(B.id);
    this.emit({ type: 'swallow', message: `${B.name} franchit l'horizon de ${A.name} (+${fmtMassSun(m)})`, bodyId: A.id, pos: vclone(A.pos), magnitude: 2 });
  }

  /** Dislocation de marée : le corps devient un flux de débris (moitié liée, moitié éjectée pour un TN). */
  private tidalDisrupt(A: Body, B: Body, tde: boolean): void {
    const n = clamp(Math.round(400 + Math.log10(B.mass / 1e-10 + 1) * 120), 300, 2500);
    const kind = B.kind === 'star' ? PARTICLE_GAS : B.composition.ice + B.composition.water > 0.4 ? PARTICLE_ICE : PARTICLE_DEBRIS;
    const rel = vsub(B.pos, A.pos);
    const relV = vsub(B.vel, A.vel);
    const dist = vlen(rel);
    const axis = vnorm(vcross(rel, relV));
    const ax = vlen(axis) > 0 ? axis : vperp(vnorm(rel));
    const vc = Math.sqrt((G_SIM * A.mass) / Math.max(dist, 1e-9));
    const pm = B.mass / n;
    for (let i = 0; i < n; i++) {
      const u = this.rng.next();
      if (tde) {
        // flux de débris : dispersion en énergie autour de l'orbite du corps
        const spread = (u - 0.5) * 0.5;
        const dir = vnorm(vcross(ax, rel));
        const sp = vc * (1 + spread);
        const off = (this.rng.next() - 0.5) * km2au(B.radius) * 4;
        this.particles.add(
          B.pos.x + rel.x / dist * off, B.pos.y + rel.y / dist * off, B.pos.z + rel.z / dist * off,
          A.vel.x + dir.x * sp + relV.x * 0.2, A.vel.y + dir.y * sp + relV.y * 0.2, A.vel.z + dir.z * sp + relV.z * 0.2,
          pm, kind === PARTICLE_DEBRIS ? PARTICLE_GAS : kind, 5e5, Infinity,
        );
      } else {
        // anneau : particules sur orbites circulaires proches de la distance de dislocation
        const ang = u * Math.PI * 2;
        const rr = dist * (0.85 + 0.3 * this.rng.next());
        const e1 = vnorm(rel), e2 = vnorm(vcross(ax, e1));
        const px = Math.cos(ang), py = Math.sin(ang);
        const pos = { x: A.pos.x + (e1.x * px + e2.x * py) * rr, y: A.pos.y + (e1.y * px + e2.y * py) * rr, z: A.pos.z + (e1.z * px + e2.z * py) * rr };
        const v = Math.sqrt((G_SIM * A.mass) / rr);
        const tdir = { x: -e1.x * py + e2.x * px, y: -e1.y * py + e2.y * px, z: -e1.z * py + e2.z * px };
        const jitter = (this.rng.next() - 0.5) * 0.002 * rr;
        this.particles.add(pos.x, pos.y + jitter, pos.z, A.vel.x + tdir.x * v, A.vel.y + tdir.y * v, A.vel.z + tdir.z * v, pm, kind, 300, Infinity);
      }
    }
    this.remove(B.id);
    if (A.planet && !tde) {
      A.planet.hasRings = true;
      const rr = dist / km2au(A.radius);
      A.planet.ringInner = clamp(rr * 0.75, 1.1, 10);
      A.planet.ringOuter = clamp(rr * 1.25, A.planet.ringInner + 0.2, 12);
    }
    this.emit({
      type: 'tidal',
      message: tde
        ? `Évènement de rupture par effet de marée : ${B.name} est déchiqueté(e) par ${A.name}`
        : `${B.name} franchit la limite de Roche de ${A.name} et se disloque${A.planet ? ' en anneau' : ''}`,
      bodyId: A.id, pos: vclone(B.pos), magnitude: 2,
    });
  }

  private mergeStars(A: Body, B: Body): void {
    const mB = B.mass;
    this.absorbInto(A, B);
    if (A.star) {
      const m = Math.min(A.mass, 150);
      // l'étoile fusionnée « rajeunit » (traînarde bleue) : âge mélangé
      const frac = A.star.age / A.star.msLifetime;
      A.star.zamsMass = m;
      A.star.msLifetime = 1e10 * Math.pow(m, -2.5);
      A.star.age = Math.min(frac * 0.6, 0.95) * A.star.msLifetime;
      A.mass = m;
      if (A.kind === 'protostar') A.star.phase = 'protostar';
      refreshStar(A);
    }
    this.remove(B.id);
    this.emit({ type: 'merge', message: `Fusion stellaire : ${A.name} absorbe ${B.name} (+${fmtMassSun(mB)})`, bodyId: A.id, pos: vclone(A.pos), magnitude: 3 });
  }

  private mergeNebulae(A: Body, B: Body): void {
    const nA = A.nebula!, nB = B.nebula!;
    const m = A.mass + B.mass;
    nA.gasTemperature = (nA.gasTemperature * A.mass + nB.gasTemperature * B.mass) / m;
    nA.density = Math.max(nA.density, nB.density) * 1.3; // compression par la collision
    nA.remnant = false;
    nA.expansionSpeed = 0;
    this.absorbInto(A, B);
    A.radius = cloudRadiusKm(A.mass, nA.density);
    this.remove(B.id);
    this.emit({ type: 'merge', message: `Les nuages ${A.name} et ${B.name} fusionnent et se compriment`, bodyId: A.id, pos: vclone(A.pos), magnitude: 1 });
  }

  /** Collision de corps solides : accrétion ou fragmentation selon l'énergie d'impact. */
  private collideSolid(A: Body, B: Body): number[] {
    const m = A.mass + B.mass;
    const rSum = km2au(A.radius + B.radius);
    const vEsc = Math.sqrt((2 * G_SIM * m) / rSum);
    const vRel = vlen(vsub(A.vel, B.vel));
    const ratio = B.mass / A.mass;
    const impactDir = vnorm(vsub(B.pos, A.pos));
    const energyRatio = (vRel / Math.max(vEsc, 1e-12)) ** 2;
    if (energyRatio < 2.5 || ratio < 1e-4) {
      // accrétion avec cratère
      if (A.planet) {
        const lat = Math.asin(clamp(impactDir.y, -1, 1));
        const lon = Math.atan2(impactDir.z, impactDir.x);
        const size = clamp(Math.cbrt(ratio) * 0.8 * Math.sqrt(1 + energyRatio), 0.01, 0.6);
        A.planet.impacts.push({ lat, lon, size });
        if (A.planet.impacts.length > 64) A.planet.impacts.shift();
        A.heat = (A.heat ?? 0) + clamp(ratio * 20000 * (1 + energyRatio), 10, 3000);
        if (ratio > 0.01 && A.planet.life > 0) {
          A.planet.life = Math.max(0, A.planet.life - 2);
          this.emit({ type: 'life', message: `Extinction massive sur ${A.name} après l'impact`, bodyId: A.id, pos: vclone(A.pos) });
        }
      }
      // éjectas
      const nDeb = clamp(Math.round(30 + 400 * Math.sqrt(ratio) * energyRatio), 20, 800);
      const vcom = vscale(this.momentumOf(A, B), 1 / m);
      this.spawnDebris(A, B, nDeb, B.mass * 0.02, vEsc * 0.6);
      this.absorbInto(A, { ...B, mass: B.mass * 0.98 });
      A.vel = vcom; // les éjectas (2 %) partent aussi à la vitesse du centre de masse en moyenne
      refreshPlanetRadius(A);
      this.remove(B.id);
      this.emit({ type: 'collision', message: `Impact : ${B.name} percute ${A.name} à ${(vRel / KMS_TO_AUYR).toFixed(1)} km/s (accrétion)`, bodyId: A.id, pos: vclone(B.pos), magnitude: clamp(Math.log10(1 + ratio * 1e4), 0.3, 4) });
      return [B.id];
    }
    // fragmentation catastrophique
    const lossFrac = clamp(0.5 * ratio * energyRatio, 0.05, 0.95);
    const debrisMass = B.mass + A.mass * lossFrac;
    const p = this.momentumOf(A, B);
    const pos = this.comPos(A, B);
    const nDeb = clamp(Math.round(600 + 1500 * lossFrac), 400, 3000);
    this.spawnDebris(A, B, nDeb, debrisMass * 0.7, vEsc * 1.2);
    this.remove(B.id);
    const survivors: number[] = [B.id];
    if (lossFrac > 0.9) {
      this.remove(A.id);
      survivors.push(A.id);
      this.emit({ type: 'collision', message: `Collision cataclysmique : ${A.name} et ${B.name} sont pulvérisés`, pos, magnitude: 4 });
    } else {
      A.mass = A.mass * (1 - lossFrac) + debrisMass * 0.1;
      A.vel = vscale(p, 1 / (m));
      A.pos = pos;
      refreshPlanetRadius(A);
      A.heat = (A.heat ?? 0) + 2500;
      if (A.planet) {
        A.planet.life = 0;
        A.planet.impacts.push({ lat: Math.asin(clamp(impactDir.y, -1, 1)), lon: Math.atan2(impactDir.z, impactDir.x), size: 0.7 });
      }
      this.emit({ type: 'collision', message: `Collision géante : ${B.name} détruit, ${A.name} perd ${(lossFrac * 100).toFixed(0)} % de sa masse`, bodyId: A.id, pos, magnitude: 3.5 });
      // quelques fragments massifs (futurs satellites)
      const nFrag = Math.min(3, Math.floor(lossFrac * 6));
      for (let k = 0; k < nFrag; k++) {
        const dir = vnorm({ x: this.rng.gauss(), y: this.rng.gauss() * 0.3, z: this.rng.gauss() });
        const r = km2au(A.radius) * (3 + k * 1.5);
        const vc = Math.sqrt((G_SIM * A.mass) / r);
        const t = vnorm(vcross({ x: 0, y: 1, z: 0 }, dir));
        const frag = makePlanet({
          mass: debrisMass * 0.08, kind: 'moon', composition: A.composition, gasGiant: false, name: `${A.name}-F${k + 1}`,
          pos: { x: A.pos.x + dir.x * r, y: A.pos.y + dir.y * r, z: A.pos.z + dir.z * r },
          vel: { x: A.vel.x + t.x * vc, y: A.vel.y + t.y * vc, z: A.vel.z + t.z * vc },
        });
        this.add(frag, true);
      }
    }
    return survivors;
  }

  private spawnDebris(A: Body, B: Body, n: number, totalMass: number, speed: number): void {
    const pos = this.comPos(A, B);
    const p = this.momentumOf(A, B);
    const vcom = vscale(p, 1 / (A.mass + B.mass));
    const r0 = km2au(A.radius);
    const kind = A.composition.ice + B.composition.ice > 0.4 ? PARTICLE_ICE : PARTICLE_DEBRIS;
    // tirages antithétiques (±d) : la quantité de mouvement totale est conservée exactement
    const half = Math.max(1, Math.floor(n / 2));
    for (let i = 0; i < half; i++) {
      const [dx, dy, dz] = this.rng.onSphere();
      const s = speed * (0.4 + this.rng.next() * 1.2);
      const life = 5e4 + this.rng.next() * 5e4;
      for (const sg of [1, -1]) {
        this.particles.add(pos.x + sg * dx * r0 * 1.2, pos.y + sg * dy * r0 * 1.2, pos.z + sg * dz * r0 * 1.2, vcom.x + sg * dx * s, vcom.y + sg * dy * s, vcom.z + sg * dz * s, totalMass / (2 * half), kind, 2000, life);
      }
    }
  }

  /** Coquille d'éjectas sphérique. */
  spawnShell(pos: Vec3, vel: Vec3, mass: number, kind: number, n: number, temp: number, speed: number, life = Infinity): void {
    for (let i = 0; i < n; i++) {
      const [dx, dy, dz] = this.rng.onSphere();
      const s = speed * (0.7 + 0.6 * this.rng.next());
      this.particles.add(pos.x, pos.y, pos.z, vel.x + dx * s, vel.y + dy * s, vel.z + dz * s, mass / n, kind, temp, life);
    }
  }

  // -------------------------------------------------------------------------
  // Trous noirs : rayonnement gravitationnel et fusion
  // -------------------------------------------------------------------------

  private applyGWReaction(h: number): void {
    const bhs = this.bodies.filter((b) => b.kind === 'blackhole' || b.kind === 'neutronstar');
    if (bhs.length < 2) return;
    for (let i = 0; i < bhs.length; i++) {
      for (let j = i + 1; j < bhs.length; j++) {
        const A = bhs[i], B = bhs[j];
        const r = vsub(B.pos, A.pos);
        const d = vlen(r);
        if (d === 0) continue;
        // Perte d'énergie orbitale (Peters), amplifiée par le pouvoir divin
        const P = gwPower(A.mass, B.mass, d); // W
        const PSim = (P / 1.98847e30 / (1.495978707e11 ** 2)) * (3.15576e7 ** 3) * this.settings.gwBoost; // M☉ UA²/an³
        const vrel = vsub(B.vel, A.vel);
        const v2 = vdot(vrel, vrel);
        if (v2 <= 0) continue;
        const mu = (A.mass * B.mass) / (A.mass + B.mass);
        // dE = -P h ; on retire l'énergie le long de la vitesse relative
        const frac = clamp((PSim * h) / (0.5 * mu * v2), 0, 0.2);
        const k = 1 - Math.sqrt(1 - frac);
        const dv = vscale(vrel, k);
        const mt = A.mass + B.mass;
        A.vel.x += dv.x * (B.mass / mt); A.vel.y += dv.y * (B.mass / mt); A.vel.z += dv.z * (B.mass / mt);
        B.vel.x -= dv.x * (A.mass / mt); B.vel.y -= dv.y * (A.mass / mt); B.vel.z -= dv.z * (A.mass / mt);
        // signal GW pour l'analyse
        if (P > 1e20 && (this.gwSignals.length === 0 || this.gwSignals[this.gwSignals.length - 1].age > 0.01)) {
          const f = gwFrequency(A.mass, B.mass, d);
          this.gwSignals.push({ t: this.time, pos: this.comPos(A, B), strain: P, freq: f, amp: clamp(Math.log10(P) - 20, 0, 40), age: 0 });
          if (this.gwSignals.length > 400) this.gwSignals.shift();
        }
        // seuil de coalescence : on bascule sur la phase finale analytique
        const threshold = Math.max(km2au(A.radius + B.radius) * 30, 2e-5);
        if (A.kind === 'blackhole' && B.kind === 'blackhole' && d < threshold) {
          this.startBHMerger(A.mass >= B.mass ? A : B, A.mass >= B.mass ? B : A);
          return;
        }
      }
    }
  }

  /**
   * Mode séculaire : décroissance orbitale moyenne de Peters (orbite circulaire)
   * da/dt = −(64/5) G³ m₁m₂(m₁+m₂) / (c⁵ a³), amplifiée par le pouvoir divin.
   */
  private applyGWSecular(dt: number): void {
    const bhs = this.bodies.filter((b) => b.kind === 'blackhole' || b.kind === 'neutronstar');
    if (bhs.length < 2) return;
    const c5 = Math.pow(C_AU_YR, 5);
    for (let i = 0; i < bhs.length; i++) {
      for (let j = i + 1; j < bhs.length; j++) {
        const A = bhs[i], B = bhs[j];
        if (!this.bodies.includes(A) || !this.bodies.includes(B)) continue;
        const r = vsub(B.pos, A.pos);
        const a = vlen(r);
        if (a === 0) continue;
        const k = ((64 / 5) * Math.pow(G_SIM, 3) * A.mass * B.mass * (A.mass + B.mass)) / c5 * this.settings.gwBoost;
        // a⁴(t) = a₀⁴ − 4 k t
        const a4 = Math.pow(a, 4) - 4 * k * dt;
        const threshold = Math.max(km2au(A.radius + B.radius) * 30, 2e-5);
        if (a4 <= Math.pow(threshold, 4)) {
          this.startBHMerger(A.mass >= B.mass ? A : B, A.mass >= B.mass ? B : A);
          return;
        }
        const aNew = Math.pow(a4, 0.25);
        if (aNew / a > 0.999999) continue;
        const com = this.comPos(A, B);
        const vcom = vscale(this.momentumOf(A, B), 1 / (A.mass + B.mass));
        const s = aNew / a, sv = Math.sqrt(a / aNew);
        for (const [o, w] of [[A, -B.mass / (A.mass + B.mass)], [B, A.mass / (A.mass + B.mass)]] as [Body, number][]) {
          o.pos = { x: com.x + r.x * w * s, y: com.y + r.y * w * s, z: com.z + r.z * w * s };
          const rv = vsub(o.vel, vcom);
          o.vel = { x: vcom.x + rv.x * sv, y: vcom.y + rv.y * sv, z: vcom.z + rv.z * sv };
        }
      }
    }
  }

  /** Remplace deux trous noirs par le trou noir final ; la coalescence est animée en temps réel. */
  startBHMerger(A: Body, B: Body): void {
    if (!A.bh || !B.bh) return;
    const res = mergeBlackHoles(A.mass, B.mass, A.bh.spin, B.bh.spin);
    const p = this.momentumOf(A, B);
    const pos = this.comPos(A, B);
    const sep = Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y, A.pos.z - B.pos.z) * AU_KM;
    const m1 = A.mass, m2 = B.mass;
    this.remove(B.id);
    A.mass = res.finalMass;
    A.pos = pos;
    A.vel = vscale(p, 1 / (m1 + m2));
    A.radius = schwarzschildRadiusKm(A.mass);
    A.bh.spin = res.finalSpin;
    A.bh.diskMass += B.bh.diskMass;
    A.bh.merger = {
      m1, m2, startTime: 0, duration: 6, sep0Km: Math.max(sep, A.radius * 8), radiatedMass: res.radiatedMass, peakFrequencyHz: res.peakFrequencyHz, phase: 0,
    };
    this.gwSignals.push({ t: this.time, pos: vclone(pos), strain: 1e49, freq: res.peakFrequencyHz, amp: 40, age: 0 });
    this.emit({
      type: 'bhmerger',
      message: `Fusion de trous noirs : ${fmtMassSun(m1)} + ${fmtMassSun(m2)} → ${fmtMassSun(res.finalMass)}, spin ${res.finalSpin.toFixed(2)} ; ${fmtMassSun(res.radiatedMass)} rayonnées en ondes gravitationnelles`,
      bodyId: A.id, pos: vclone(pos), magnitude: 5,
    });
  }

  /** Avance l'animation des coalescences (appelée avec le temps réel écoulé). */
  updateMergers(realDt: number): void {
    for (const b of this.bodies) {
      const m = b.bh?.merger;
      if (!m) continue;
      m.startTime += realDt;
      m.phase += realDt * (2 + 40 * Math.pow(Math.min(1, m.startTime / m.duration), 3));
      if (m.startTime >= m.duration) b.bh!.merger = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Évolution astrophysique (par image)
  // -------------------------------------------------------------------------

  private evolve(dt: number): void {
    if (dt <= 0) return;
    const lum = this.bodies.filter((b) => (b.star && (b.kind === 'star' || b.kind === 'protostar' || b.kind === 'whitedwarf')) || (b.bh && b.bh.luminosity > 0));
    for (const b of [...this.bodies]) {
      b.age += dt;
      if (b.heat) {
        b.heat *= Math.exp(-dt / 2000);
        if (b.heat < 1) b.heat = 0;
      }
      switch (b.kind) {
        case 'star':
        case 'protostar':
          if (this.settings.stellarEvolution) this.evolveStar(b, dt);
          break;
        case 'whitedwarf':
          // refroidissement (loi de Mestel simplifiée)
          b.temperature = Math.max(3000, 100000 * Math.pow(1 + b.age / 1e8, -0.4));
          if (b.star) b.star.luminosity = 0.01 * Math.pow(b.temperature / 10000, 4) * 1e-2;
          break;
        case 'browndwarf':
          b.temperature = Math.max(300, b.temperature * Math.exp(-dt / 5e9));
          break;
        case 'blackhole':
          this.evolveBlackHole(b, dt);
          break;
        case 'nebula':
          this.evolveNebula(b, dt);
          break;
        case 'planet':
        case 'moon':
        case 'asteroid':
        case 'comet':
          this.evolvePlanet(b, dt, lum);
          break;
      }
    }
  }

  private evolveStar(b: Body, dt: number): void {
    const s = b.star!;
    const prevPhase = s.phase;
    s.age += dt;
    if (s.phase === 'protostar' && s.age >= protostarDuration(s.zamsMass)) {
      s.phase = 'main';
      s.age = 0;
      b.kind = 'star';
      this.emit({ type: 'ignite', message: `Allumage de la fusion de l'hydrogène : ${b.name} entre sur la séquence principale`, bodyId: b.id, pos: vclone(b.pos), magnitude: 2 });
    }
    const snap = stellarStateAt(s);
    b.radius = snap.radiusKm;
    b.temperature = snap.temperature;
    s.luminosity = snap.luminosity;
    // perte de masse par vents (les orbites s'élargissent en conséquence)
    if (snap.mass < b.mass) {
      const lost = b.mass - snap.mass;
      b.mass = snap.mass;
      if (lost > 1e-3 && this.rng.next() < 0.5) this.spawnShell(b.pos, b.vel, lost, PARTICLE_GAS, 40, 3000, 0.002 * C_AU_YR * 0.01 + 4, 2e4);
    }
    if (snap.phase !== prevPhase && snap.phase !== 'main' && s.phase !== 'protostar') {
      s.phase = snap.phase;
      const label: Record<string, string> = { subgiant: 'sous-géante', redgiant: 'géante rouge', supergiant: 'supergéante rouge' };
      this.emit({ type: 'phase', message: `${b.name} devient une ${label[snap.phase] ?? snap.phase}`, bodyId: b.id, pos: vclone(b.pos), magnitude: 1 });
    }
    if (snap.ended) this.endOfLife(b);
  }

  /** Fin de vie : nébuleuse planétaire + naine blanche, ou supernova + rémanent compact. */
  endOfLife(b: Body, forced = false): void {
    if (!b.star) return;
    const mInit = b.star.zamsMass;
    const fate = stellarFate(mInit);
    if (fate === 'whitedwarf' && !forced) {
      const mwd = Math.min(whiteDwarfMass(mInit), b.mass);
      const shellMass = Math.max(0, b.mass - mwd);
      const wd = makeCompactRemnant('whitedwarf', mwd, b);
      this.replaceBody(b, wd);
      if (shellMass > 0) {
        const neb = makeNebula({ mass: Math.max(0.01, shellMass), density: 1e4, temperature: 10000, pos: b.pos, vel: b.vel, remnant: true, expansionSpeed: 5, name: `Nébuleuse planétaire de ${b.name}`, composition: { hydrogen: 0.9, heavy: 0.1 } });
        neb.radius = 100 * AU_KM / 100;
        this.add(neb, true);
        this.spawnShell(b.pos, b.vel, 0, PARTICLE_GAS, 1200, 12000, 5, 4e4);
      }
      this.emit({ type: 'phase', message: `${b.name} expulse ses couches externes (nébuleuse planétaire) et devient une naine blanche de ${fmtMassSun(mwd)}`, bodyId: wd.id, pos: vclone(b.pos), magnitude: 2 });
      return;
    }
    this.supernova(b);
  }

  /** Supernova à effondrement de cœur (ou thermonucléaire si forcée sur une petite étoile). */
  supernova(b: Body): void {
    const mInit = b.star?.zamsMass ?? b.mass;
    const fate = stellarFate(mInit);
    const pos = vclone(b.pos), vel = vclone(b.vel);
    let remnant: Body | null = null;
    let rem = 0;
    if (fate === 'neutronstar') {
      rem = Math.min(remnantMass(mInit), b.mass * 0.9);
      remnant = makeCompactRemnant('neutronstar', rem, b);
      // impulsion natale (« kick ») de 200–500 km/s
      const [kx, ky, kz] = this.rng.onSphere();
      const kick = (200 + 300 * this.rng.next()) * KMS_TO_AUYR;
      remnant.vel = { x: vel.x + kx * kick, y: vel.y + ky * kick, z: vel.z + kz * kick };
      remnant.name = `Pulsar ${b.name}`;
    } else if (fate === 'blackhole') {
      rem = Math.min(remnantMass(mInit), b.mass * 0.9);
      remnant = makeBlackHole({ mass: Math.max(3, rem), spin: clamp(0.3 + 10 / Math.max(1, b.star?.rotationDays ?? 25), 0, 0.95), pos, vel, name: `TN ${b.name}`, diskMass: 0.05 });
    }
    const ejecta = Math.max(0.1, b.mass - rem);
    const speed = supernovaEjectaSpeedAUyr(ejecta); // ~ 2000 UA/an (10 000 km/s)
    if (remnant) this.replaceBody(b, remnant); else this.remove(b.id);
    // rémanent : nuage enrichi en éléments lourds en expansion
    const neb = makeNebula({
      mass: ejecta * 0.7, density: 50, temperature: 1e7, pos, vel, remnant: true, expansionSpeed: speed * 0.4,
      name: `Rémanent de ${b.name}`, composition: { hydrogen: 0.6, heavy: 0.3, metal: 0.1 },
    });
    neb.radius = 5 * AU_KM;
    this.add(neb, true);
    this.spawnShell(pos, vel, ejecta * 0.3, PARTICLE_EJECTA, 3000, 5e6, speed, 2e3);
    // Souffle : chauffage, arrachement d'atmosphères et extinction
    const Lsn = 1e9; // L☉ au pic (approx.)
    for (const o of this.bodies) {
      if (o === remnant || o === neb) continue;
      const d = Math.max(1e-3, Math.hypot(o.pos.x - pos.x, o.pos.y - pos.y, o.pos.z - pos.z));
      if (o.planet) {
        const fluence = Lsn / (d * d);
        if (fluence > 1e7) {
          o.planet.pressure *= 0.05;
          o.heat = (o.heat ?? 0) + Math.min(5000, fluence / 1e6);
          o.planet.waterFraction *= 0.3;
          if (o.planet.life > 0) {
            o.planet.life = 0;
            o.planet.lifeTimer = 0;
            this.emit({ type: 'life', message: `La vie sur ${o.name} est anéantie par la supernova`, bodyId: o.id, pos: vclone(o.pos) });
          }
        }
        // poussée par les éjectas interceptés : Δv = M_ej v πR² / (4π d² m)
        const R = km2au(o.radius);
        const dv = (ejecta * 0.3 * speed * R * R) / (4 * d * d * o.mass);
        const dir = vnorm(vsub(o.pos, pos));
        const dvc = Math.min(dv, speed * 0.5);
        o.vel.x += dir.x * dvc; o.vel.y += dir.y * dvc; o.vel.z += dir.z * dvc;
      }
      if (o.nebula && !o.nebula.remnant) {
        // compression et enrichissement des nuages voisins → formation stellaire déclenchée
        o.nebula.density *= 3;
        o.composition.heavy = Math.min(0.2, o.composition.heavy + 0.02);
        o.radius = cloudRadiusKm(o.mass, o.nebula.density);
        this.emit({ type: 'info', message: `L'onde de choc comprime et enrichit ${o.name}`, bodyId: o.id, pos: vclone(o.pos) });
      }
    }
    const kindLabel = remnant ? (remnant.kind === 'blackhole' ? 'un trou noir' : 'une étoile à neutrons (pulsar)') : 'aucun rémanent';
    this.emit({ type: 'supernova', message: `SUPERNOVA : ${b.name} explose (${fmtMassSun(ejecta)} éjectées à ${(speed / KMS_TO_AUYR).toFixed(0)} km/s) et laisse ${kindLabel}`, bodyId: remnant?.id, pos, magnitude: 5 });
  }

  /** Remplace un corps par un autre en gardant son identité d'affichage (sélection). */
  private replaceBody(old: Body, nb: Body): void {
    const i = this.bodies.indexOf(old);
    nb.id = old.id;
    nb.createdBy = old.createdBy;
    if (i >= 0) this.bodies[i] = nb; else this.bodies.push(nb);
    this.version++;
  }

  private evolveBlackHole(b: Body, dt: number): void {
    const h = b.bh!;
    // accrétion visqueuse (temps caractéristique de jeu : 50 ans)
    // la masse du disque est déjà incluse dans b.mass ; une fraction η est rayonnée
    const accreted = h.diskMass * (1 - Math.exp(-dt / 50));
    h.diskMass -= accreted;
    h.accretionRate = dt > 0 ? accreted / dt : 0;
    if (accreted > 0) b.mass -= accreted * radiativeEfficiency(h.spin);
    b.radius = schwarzschildRadiusKm(Math.max(1e-6, b.mass - h.diskMass));
    h.luminosity = accretionLuminosity(h.accretionRate, h.spin, b.mass);
    // matériau visible du disque : particules de gaz réinjectées si le disque est massif
    if (h.diskMass > 1e-6 && this.particles.count < 30000) {
      const n = Math.min(40, Math.ceil(h.diskMass * 200));
      const rs = km2au(b.radius);
      const ax = h.axis;
      const e1 = vperp(ax), e2 = vcross(ax, e1);
      for (let i = 0; i < n; i++) {
        if (this.rng.next() > 0.3) continue;
        const r = rs * (iscoRadiusRs(h.spin) * 2 + this.rng.next() * 400);
        const a = this.rng.next() * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        const v = Math.sqrt((G_SIM * b.mass) / r);
        this.particles.add(
          b.pos.x + (e1.x * c + e2.x * s) * r, b.pos.y + (e1.y * c + e2.y * s) * r, b.pos.z + (e1.z * c + e2.z * s) * r,
          b.vel.x + (-e1.x * s + e2.x * c) * v, b.vel.y + (-e1.y * s + e2.y * c) * v, b.vel.z + (-e1.z * s + e2.z * c) * v,
          0, PARTICLE_GAS, 1e6, 30,
        );
      }
    }
  }

  private evolveNebula(b: Body, dt: number): void {
    const n = b.nebula!;
    if (n.remnant) {
      n.density = Math.max(1e-3, n.density * Math.exp(-dt / 2000));
      n.gasTemperature = Math.max(50, n.gasTemperature * Math.exp(-dt / 5000));
      b.temperature = n.gasTemperature;
      if (km2au(b.radius) > 5e4 || n.density < 0.01) this.remove(b.id, `${b.name} s'est dilué(e) dans le milieu interstellaire`);
      return;
    }
    // refroidissement radiatif vers ~10 K
    n.gasTemperature = 10 + (n.gasTemperature - 10) * Math.exp(-dt / 1e4);
    b.temperature = n.gasTemperature;
    const mJ = jeansMass(n.gasTemperature, n.density, 2.33);
    if (b.mass > mJ) {
      const tff = freeFallTime(n.density);
      n.collapseProgress += dt / tff;
      // contraction visible du nuage
      b.radius = cloudRadiusKm(b.mass, n.density) * Math.max(0.15, 1 - 0.8 * n.collapseProgress);
      if (n.collapseProgress >= 1) this.formStar(b);
    } else {
      n.collapseProgress = Math.max(0, n.collapseProgress - dt / 1e6);
    }
  }

  /** Effondrement d'un nuage : protoétoile + disque protoplanétaire → planètes. */
  formStar(cloud: Body): void {
    const eff = 0.3;
    const metal = cloud.composition.heavy + cloud.composition.metal + cloud.composition.rock;
    const starMass = clamp(cloud.mass * eff, 0.01, 120);
    const pos = vclone(cloud.pos), vel = vclone(cloud.vel);
    const rng = new Rng(cloud.seed ^ 0x5eed);
    this.remove(cloud.id);
    let star: Body;
    if (starMass >= HYDROGEN_BURNING_MIN) {
      star = makeStar({ mass: starMass, metallicity: clamp(metal, 0.0001, 0.08), pos, vel, protostar: true, seed: cloud.seed, name: cloud.name.replace('Nébuleuse ', '') });
    } else if (starMass >= BROWN_DWARF_MIN) {
      star = makeBrownDwarf({ mass: starMass, pos, vel, seed: cloud.seed });
    } else {
      star = makePlanet({ mass: starMass, gasGiant: true, pos, vel, seed: cloud.seed });
    }
    star.createdBy = cloud.createdBy;
    this.add(star, true);
    this.emit({ type: 'ignite', message: `Le nuage ${cloud.name} s'effondre : naissance d'une ${star.kind === 'protostar' ? 'protoétoile' : star.kind === 'browndwarf' ? 'naine brune' : 'planète géante'} de ${fmtMassSun(starMass)}`, bodyId: star.id, pos, magnitude: 2 });
    // disque protoplanétaire : quelques planètes (plus rocheuses si le nuage est enrichi)
    if (star.kind === 'protostar') {
      const nPl = rng.int(2, 6);
      const lum = Math.max(0.05, Math.pow(starMass, 3.5));
      const snow = 2.7 * Math.sqrt(lum);
      let a = 0.3 * Math.sqrt(lum) + rng.range(0, 0.2);
      for (let i = 0; i < nPl; i++) {
        const beyondSnow = a > snow;
        const massEarth = beyondSnow ? rng.logRange(2, 300) : rng.logRange(0.05, 3) * (0.5 + metal * 30);
        const gas = massEarth > 15;
        const pl = makePlanet({
          massEarth, gasGiant: gas, seed: rng.nextU32(), rings: gas && rng.chance(0.4),
          composition: beyondSnow && !gas ? { ice: 0.4, rock: 0.4, metal: 0.15, water: 0.05 } : undefined,
          waterFraction: beyondSnow ? 0.8 : rng.range(0, 0.8),
        });
        const ang = rng.range(0, Math.PI * 2);
        const vc = Math.sqrt((G_SIM * starMass) / a);
        pl.pos = { x: pos.x + Math.cos(ang) * a, y: pos.y + rng.gauss(0, 0.01) * a, z: pos.z + Math.sin(ang) * a };
        pl.vel = { x: vel.x - Math.sin(ang) * vc, y: vel.y, z: vel.z + Math.cos(ang) * vc };
        pl.createdBy = cloud.createdBy;
        this.add(pl, true);
        a *= rng.range(1.5, 2.2);
      }
      this.emit({ type: 'info', message: `Un disque protoplanétaire forme ${nPl} planètes autour de ${star.name}`, bodyId: star.id, pos });
    }
  }

  private evolvePlanet(b: Body, dt: number, lum: Body[]): void {
    const p = b.planet;
    if (!p) return;
    let flux = 0;
    for (const s of lum) {
      if (s === b) continue;
      const L = s.star?.luminosity ?? s.bh?.luminosity ?? 0;
      if (L <= 0) continue;
      const d2 = (s.pos.x - b.pos.x) ** 2 + (s.pos.y - b.pos.y) ** 2 + (s.pos.z - b.pos.z) ** 2;
      flux += L / Math.max(d2, 1e-8);
    }
    const teq = equilibriumTemperature(flux, p.albedo);
    const internal = p.gasGiant ? 60 * Math.cbrt(b.mass / 9.5e-4) : 15 * p.volcanism;
    // géantes gazeuses : pas de surface, la « température » est celle de la haute atmosphère (pas d'effet de serre)
    const target = Math.max(3, teq + (p.gasGiant ? 0 : greenhouseWarming(p)) + internal) + (b.heat ?? 0);
    // inertie thermique (~ 50 ans) ; équilibre immédiat à la première évaluation
    if (!this.thermalInit.has(b)) {
      this.thermalInit.add(b);
      b.temperature = target;
    } else {
      b.temperature = b.temperature + (target - b.temperature) * (1 - Math.exp(-dt / 50));
    }
    if (p.gasGiant) return;
    const ws = waterState(b.temperature, p);
    // emballement de l'effet de serre : l'eau s'évapore, la pression monte
    if (ws === 'vapeur' && p.waterFraction > 0.001) {
      const evap = p.waterFraction * (1 - Math.exp(-dt / 2e5));
      p.waterFraction -= evap;
      p.pressure += evap * 250;
      p.greenhouse = Math.min(120, p.greenhouse + evap * 40);
    }
    // échappement atmosphérique (Jeans + vent stellaire si pas de magnétosphère)
    const ret = atmosphereRetention(b);
    if (p.pressure > 0 && (ret < 6 || p.magneticField < 0.05)) {
      const tau = ret < 3 ? 1e5 : ret < 6 ? 5e7 : 5e8;
      p.pressure *= Math.exp(-dt / tau);
      if (p.pressure < 1e-4) p.pressure = 0;
    }
    // volcanisme : dégazage
    if (p.volcanism > 0.5 && ret > 6) p.pressure = Math.min(100, p.pressure + p.volcanism * dt * 1e-7);
    // vie
    const hab = habitability(b);
    if (hab > 0.35) {
      p.lifeTimer += dt * hab * (1 + b.composition.organic * 50);
      for (let lvl = 3; lvl >= 1; lvl--) {
        if (p.life < lvl && p.lifeTimer >= LIFE_THRESHOLDS[lvl]) {
          p.life = lvl;
          this.emit({ type: 'life', message: `Vie ${LIFE_LABELS[lvl].toLowerCase()} apparue sur ${b.name} (modèle spéculatif, après ${fmtYears(p.lifeTimer)} de conditions habitables)`, bodyId: b.id, pos: vclone(b.pos), magnitude: 1 });
          break;
        }
      }
    } else if (p.life > 0 && hab < 0.05) {
      p.lifeTimer *= Math.exp(-dt / 1e6);
      if (p.lifeTimer < LIFE_THRESHOLDS[p.life] * 0.5) {
        p.life--;
        this.emit({ type: 'life', message: `La biosphère de ${b.name} décline (conditions devenues hostiles)`, bodyId: b.id, pos: vclone(b.pos) });
        if (p.life <= 0) p.lifeTimer = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pouvoirs divins
  // -------------------------------------------------------------------------

  /** Place un corps en orbite circulaire autour d'un parent. */
  placeInOrbit(b: Body, parent: Body, radiusAU: number, inclinationDeg = 0, phase = 0): void {
    const r = sanitize(radiusAU, 1, km2au(parent.radius) * 1.5 + km2au(b.radius), 1e6);
    const inc = (sanitize(inclinationDeg, 0, -180, 180) * Math.PI) / 180;
    const c = Math.cos(phase), s = Math.sin(phase);
    const rel = { x: c * r, y: 0, z: s * r };
    const vc = Math.sqrt((G_SIM * (parent.mass + b.mass)) / r);
    const vrel = { x: -s * vc, y: 0, z: c * vc };
    // inclinaison autour de l'axe x
    const ci = Math.cos(inc), si = Math.sin(inc);
    const rot = (v: Vec3) => ({ x: v.x, y: v.y * ci - v.z * si, z: v.y * si + v.z * ci });
    const rr = rot(rel), vv = rot(vrel);
    b.pos = { x: parent.pos.x + rr.x, y: parent.pos.y + rr.y, z: parent.pos.z + rr.z };
    b.vel = { x: parent.vel.x + vv.x, y: parent.vel.y + vv.y, z: parent.vel.z + vv.z };
  }

  applyImpulse(id: number, dv: Vec3): boolean {
    const b = this.get(id);
    if (!b || !visFinite(dv)) return false;
    b.vel.x += dv.x; b.vel.y += dv.y; b.vel.z += dv.z;
    return true;
  }

  /** Lance A sur une trajectoire de collision avec B. */
  collide(aId: number, bId: number, speedKms = 30): boolean {
    const A = this.get(aId), B = this.get(bId);
    if (!A || !B || A === B) return false;
    const dir = vnorm(vsub(B.pos, A.pos));
    const s = sanitize(speedKms, 30, 0.1, 30000) * KMS_TO_AUYR;
    A.vel = { x: B.vel.x + dir.x * s, y: B.vel.y + dir.y * s, z: B.vel.z + dir.z * s };
    this.emit({ type: 'info', message: `Pouvoir divin : ${A.name} est précipité(e) vers ${B.name} à ${speedKms} km/s`, bodyId: A.id, pos: vclone(A.pos) });
    return true;
  }

  /** Fait tomber un astéroïde sur une planète. */
  asteroidImpact(targetId: number, massEarth = 0.001, speedKms = 25): Body | null {
    const T = this.get(targetId);
    if (!T) return null;
    const ast = makePlanet({ massEarth: sanitize(massEarth, 0.001, 1e-9, 10), kind: massEarth < 1e-3 ? 'asteroid' : 'planet', gasGiant: false, name: 'Impacteur', composition: { rock: 0.7, metal: 0.3 } });
    const [dx, dy, dz] = this.rng.onSphere();
    const dist = km2au(T.radius) * 6 + km2au(ast.radius) * 2;
    ast.pos = { x: T.pos.x + dx * dist, y: T.pos.y + dy * dist * 0.3, z: T.pos.z + dz * dist };
    this.add(ast, true);
    this.collide(ast.id, T.id, speedKms);
    this.emit({ type: 'info', message: `Un astéroïde (${fmtMassSun(ast.mass)}) fonce vers ${T.name}`, bodyId: ast.id, pos: vclone(ast.pos) });
    return ast;
  }

  /** Impulsion de rayonnement : chauffe et repousse la matière (pouvoir divin). */
  radiationBurst(pos: Vec3, energyJ: number): void {
    const E = sanitize(energyJ, 1e40, 1e20, 1e47);
    for (const o of this.bodies) {
      if (o.kind === 'darkmatter' || o.kind === 'blackhole') continue;
      const d = Math.max(1e-4, Math.hypot(o.pos.x - pos.x, o.pos.y - pos.y, o.pos.z - pos.z));
      const R = Math.max(km2au(o.radius), 1e-8);
      const frac = Math.min(0.5, (R * R) / (4 * d * d)); // fraction interceptée
      const p = (E * frac) / 299792458; // quantité de mouvement (kg m/s)
      const dvMs = p / (o.mass * 1.98847e30);
      const dv = Math.min(dvMs / 1000 * KMS_TO_AUYR, 5000);
      const dir = vnorm(vsub(o.pos, pos));
      o.vel.x += dir.x * dv; o.vel.y += dir.y * dv; o.vel.z += dir.z * dv;
      if (o.planet) o.heat = (o.heat ?? 0) + Math.min(10000, (E * frac) / (o.mass * 1.98847e30 * 1000));
      if (o.nebula) { o.nebula.gasTemperature += Math.min(1e7, E * frac / 1e30); }
    }
    for (let i = 0; i < this.particles.count; i++) {
      const P = this.particles;
      const dx = P.px[i] - pos.x, dy = P.py[i] - pos.y, dz = P.pz[i] - pos.z;
      const d = Math.hypot(dx, dy, dz) + 1e-6;
      const k = Math.min(200, Math.log10(E) * 2 / (d + 0.1));
      P.vx[i] += (dx / d) * k; P.vy[i] += (dy / d) * k; P.vz[i] += (dz / d) * k;
    }
    this.spawnShell(pos, v3(), 0, PARTICLE_EJECTA, 800, 1e7, 50 + Math.log10(E), 50);
    this.emit({ type: 'info', message: `Pouvoir divin : libération de ${E.toExponential(1)} J de rayonnement`, pos: vclone(pos), magnitude: clamp(Math.log10(E) - 38, 1, 5) });
  }

  /** Déclenche la fin de vie d'une étoile (pouvoir divin si la masse est insuffisante). */
  forceSupernova(id: number): boolean {
    const b = this.get(id);
    if (!b || !b.star || (b.kind !== 'star' && b.kind !== 'protostar')) return false;
    if (b.star.zamsMass < 8) {
      this.emit({ type: 'info', message: `Pouvoir divin : ${b.name} (${fmtMassSun(b.mass)}) est trop légère pour une supernova réelle — explosion forcée (fiction).`, bodyId: b.id });
    }
    this.supernova(b);
    return true;
  }

  /** Avance artificiellement une étoile jusqu'à la fin de sa séquence principale. */
  ageStar(id: number, fraction: number): boolean {
    const b = this.get(id);
    if (!b?.star || (b.kind !== 'star' && b.kind !== 'protostar')) return false;
    if (b.star.phase === 'protostar') { b.star.phase = 'main'; b.kind = 'star'; b.star.age = 0; }
    b.star.age = clamp(fraction, 0, 1.2) * b.star.msLifetime;
    refreshStar(b);
    const snap = stellarStateAt(b.star);
    b.star.phase = snap.phase;
    if (snap.ended) this.endOfLife(b);
    return true;
  }

  /** Envoie un corps sur une orbite plongeante vers un trou noir. */
  feedBlackHole(bhId: number, targetId: number): boolean {
    const B = this.get(bhId), T = this.get(targetId);
    if (!B || !T || B.kind !== 'blackhole' || T === B) return false;
    const rel = vsub(T.pos, B.pos);
    const d = vlen(rel);
    const vc = Math.sqrt((G_SIM * B.mass) / Math.max(d, 1e-9));
    const t = vnorm(vcross(B.bh!.axis, rel));
    // faible moment cinétique → péricentre proche (rupture de marée probable)
    T.vel = { x: B.vel.x + t.x * vc * 0.12 - (rel.x / d) * vc * 0.3, y: B.vel.y + t.y * vc * 0.12 - (rel.y / d) * vc * 0.3, z: B.vel.z + t.z * vc * 0.12 - (rel.z / d) * vc * 0.3 };
    this.emit({ type: 'info', message: `${T.name} est envoyé(e) vers ${B.name}`, bodyId: T.id, pos: vclone(T.pos) });
    return true;
  }

  /** Ajoute de la matière environnante (disque) autour d'un trou noir. */
  addAccretionMatter(bhId: number, massSun: number): boolean {
    const B = this.get(bhId);
    if (!B?.bh) return false;
    const m = sanitize(massSun, 0.1, 0, B.mass);
    const n = 1500;
    const rs = km2au(B.radius);
    const ax = B.bh.axis;
    const e1 = vperp(ax), e2 = vcross(ax, e1);
    for (let i = 0; i < n; i++) {
      const r = rs * (8 + Math.pow(this.rng.next(), 1.5) * 4000);
      const a = this.rng.next() * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const v = Math.sqrt((G_SIM * B.mass) / r);
      const h = this.rng.gauss(0, 0.03) * r;
      this.particles.add(
        B.pos.x + (e1.x * c + e2.x * s) * r + ax.x * h, B.pos.y + (e1.y * c + e2.y * s) * r + ax.y * h, B.pos.z + (e1.z * c + e2.z * s) * r + ax.z * h,
        B.vel.x + (-e1.x * s + e2.x * c) * v, B.vel.y + (-e1.y * s + e2.y * c) * v, B.vel.z + (-e1.z * s + e2.z * c) * v,
        m / n, PARTICLE_GAS, 1e5, Infinity,
      );
    }
    this.emit({ type: 'info', message: `${fmtMassSun(m)} de gaz injectées autour de ${B.name}`, bodyId: B.id, pos: vclone(B.pos) });
    return true;
  }

  /** Détruit un corps en le pulvérisant (débris persistants). */
  explode(id: number): boolean {
    const b = this.get(id);
    if (!b) return false;
    if (b.kind === 'star' || b.kind === 'protostar') return this.forceSupernova(id);
    if (b.kind === 'blackhole') {
      this.remove(id, `${b.name} est effacé par un pouvoir divin (impossible physiquement)`);
      return true;
    }
    if (b.kind === 'nebula' || b.kind === 'darkmatter') {
      this.remove(id, `${b.name} est dispersé(e)`);
      return true;
    }
    const n = clamp(Math.round(800 + Math.log10(b.mass / 1e-12) * 150), 300, 3000);
    const vEsc = Math.sqrt((2 * G_SIM * b.mass) / Math.max(km2au(b.radius), 1e-9));
    const kind = b.composition.ice + b.composition.water > 0.4 ? PARTICLE_ICE : PARTICLE_DEBRIS;
    for (let i = 0; i < n; i++) {
      const [dx, dy, dz] = this.rng.onSphere();
      const s = vEsc * (1 + this.rng.next() * 1.5);
      const r0 = km2au(b.radius);
      this.particles.add(b.pos.x + dx * r0, b.pos.y + dy * r0, b.pos.z + dz * r0, b.vel.x + dx * s, b.vel.y + dy * s, b.vel.z + dz * s, b.mass / n, kind, 3000, Infinity);
    }
    this.remove(id);
    this.emit({ type: 'destroy', message: `Pouvoir divin : ${b.name} est pulvérisé(e) en ${n} fragments`, pos: vclone(b.pos), magnitude: 3 });
    return true;
  }

  /** Masse de Jeans courante d'un nuage. */
  jeansMassOf(b: Body): number {
    return b.nebula ? jeansMass(b.nebula.gasTemperature, b.nebula.density) : Infinity;
  }

  /** Mise à jour après modification d'une propriété par l'éditeur. */
  refreshDerived(b: Body): void {
    if (b.kind === 'blackhole') b.radius = schwarzschildRadiusKm(b.mass);
    else if (b.planet) refreshPlanetRadius(b);
    else if (b.star && (b.kind === 'star' || b.kind === 'protostar')) {
      b.star.zamsMass = b.mass;
      b.star.msLifetime = 1e10 * Math.pow(b.mass, -2.5);
      refreshStar(b);
    } else if (b.nebula) b.radius = cloudRadiusKm(b.mass, b.nebula.density);
    this.version++;
  }

  /** Trajectoire prédite (copie indépendante, N-corps) pour le mode analyse. */
  predictTrajectories(years: number, samples = 200): Map<number, Vec3[]> {
    const clone = new World();
    clone.settings = { ...this.settings, collisions: false, stellarEvolution: false, integration: 'nbody', budgetMs: 1e9, maxSubsteps: 4000 };
    clone.bodies = this.bodies.map((b) => ({ ...b, pos: vclone(b.pos), vel: vclone(b.vel) }));
    const out = new Map<number, Vec3[]>();
    for (const b of clone.bodies) out.set(b.id, [vclone(b.pos)]);
    const dt = years / samples;
    const t0 = now();
    for (let s = 0; s < samples; s++) {
      clone.step(dt);
      for (const b of clone.bodies) out.get(b.id)?.push(vclone(b.pos));
      if (now() - t0 > 60) break;
    }
    return out;
  }
}

export const M_EARTH = M_EARTH_SUN;
