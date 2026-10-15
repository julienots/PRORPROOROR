import { Rng } from '../core/rng';
import { clamp, sanitize } from '../core/units';
import { ELEMENT_BY_Z, isStableNucleus, nucleusName, KNOWN_MOLECULES, hillFormula } from './elements';

/**
 * Laboratoire microscopique : particules, noyaux, atomes et molécules.
 * [Approximation stylisée] : les interactions (fusion, capture électronique, liaisons)
 * suivent des règles à seuils de température inspirées de la physique réelle
 * (barrière coulombienne ∝ Z₁Z₂, énergies d'ionisation, énergies de liaison),
 * mais la dynamique n'est ni quantique ni à l'échelle des temps réels.
 */
export type MicroKind = 'p' | 'n' | 'e' | 'photon' | 'cluster';

export interface MicroAtom {
  Z: number;
  N: number;
  electrons: number;
  /** Position relative au centre du cluster. */
  ox: number; oy: number; oz: number;
}

export interface MicroEntity {
  id: number;
  kind: MicroKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Atomes (pour un cluster : noyau seul, atome, ion ou molécule). */
  atoms?: MicroAtom[];
  bonds?: [number, number, number][]; // i, j, ordre
  /** Minuterie de désintégration (s), pour neutrons libres et noyaux instables. */
  decay?: number;
  life?: number; // photons
  spin?: number;
}

export interface MicroEvent {
  t: number;
  message: string;
  kind: 'fusion' | 'decay' | 'capture' | 'ionize' | 'bond' | 'break' | 'discovery';
  x: number; y: number; z: number;
}

export const LAB_SIZE = 600; // unité arbitraire (≈ pm)

let NEXT_ID = 1;

export class MicroLab {
  entities: MicroEntity[] = [];
  temperature = 300; // K
  /** Échelle de temps du laboratoire (multiplicateur). */
  speed = 1;
  time = 0;
  events: MicroEvent[] = [];
  discoveries = new Set<string>();
  version = 0;
  private rng: Rng;
  private listeners = new Set<(e: MicroEvent) => void>();

  constructor(seed = 1) {
    this.rng = new Rng(seed);
  }

  onEvent(fn: (e: MicroEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: MicroEvent['kind'], message: string, e: { x: number; y: number; z: number }): void {
    const ev = { t: this.time, kind, message, x: e.x, y: e.y, z: e.z };
    this.events.push(ev);
    if (this.events.length > 200) this.events.shift();
    for (const l of this.listeners) l(ev);
  }

  private discover(name: string, e: MicroEntity): void {
    if (this.discoveries.has(name)) return;
    this.discoveries.add(name);
    this.emit('discovery', `Découverte : ${name}`, e);
  }

  setTemperature(T: number): void {
    this.temperature = sanitize(T, 300, 1, 1e10);
  }

  clear(): void {
    this.entities = [];
    this.version++;
  }

  private randomPos(): [number, number, number] {
    const h = LAB_SIZE / 2 * 0.8;
    return [this.rng.range(-h, h), this.rng.range(-h, h), this.rng.range(-h, h)];
  }

  private thermalSpeed(mass: number): number {
    return 6 * Math.sqrt(this.temperature / 300) / Math.sqrt(Math.max(mass, 0.0005));
  }

  spawnParticle(kind: 'p' | 'n' | 'e', pos?: [number, number, number]): MicroEntity {
    const [x, y, z] = pos ?? this.randomPos();
    const m = kind === 'e' ? 0.000544 : 1;
    const s = this.thermalSpeed(m) * 0.5;
    const e: MicroEntity = {
      id: NEXT_ID++, kind, x, y, z,
      vx: this.rng.gauss(0, s), vy: this.rng.gauss(0, s), vz: this.rng.gauss(0, s),
      decay: kind === 'n' ? this.rng.range(25, 60) : undefined,
    };
    this.entities.push(e);
    this.version++;
    return e;
  }

  /** Crée un atome neutre (ou un noyau nu si `ionized`) de numéro atomique Z. */
  spawnAtom(Z: number, ionized = false, pos?: [number, number, number]): MicroEntity | null {
    const el = ELEMENT_BY_Z.get(Math.round(Z));
    if (!el) return null;
    const [x, y, z] = pos ?? this.randomPos();
    const m = el.mass;
    const s = this.thermalSpeed(m) * 0.5;
    const e: MicroEntity = {
      id: NEXT_ID++, kind: 'cluster', x, y, z,
      vx: this.rng.gauss(0, s), vy: this.rng.gauss(0, s), vz: this.rng.gauss(0, s),
      atoms: [{ Z: el.Z, N: el.N, electrons: ionized ? 0 : el.Z, ox: 0, oy: 0, oz: 0 }],
      bonds: [],
      spin: this.rng.range(-1, 1),
    };
    this.entities.push(e);
    this.version++;
    return e;
  }

  spawnMany(kind: 'p' | 'n' | 'e', count: number): void {
    const n = Math.round(sanitize(count, 1, 0, 2000));
    for (let i = 0; i < n; i++) this.spawnParticle(kind);
  }

  remove(e: MicroEntity): void {
    const i = this.entities.indexOf(e);
    if (i >= 0) { this.entities.splice(i, 1); this.version++; }
  }

  /** Masse (u) d'une entité. */
  static mass(e: MicroEntity): number {
    if (e.kind === 'p' || e.kind === 'n') return 1;
    if (e.kind === 'e') return 0.000544;
    if (e.kind === 'photon') return 1e-6;
    let m = 0;
    for (const a of e.atoms ?? []) m += a.Z + a.N + a.electrons * 0.000544;
    return Math.max(m, 0.000544);
  }

  /** Charge électrique (e). */
  static charge(e: MicroEntity): number {
    if (e.kind === 'p') return 1;
    if (e.kind === 'e') return -1;
    if (e.kind !== 'cluster') return 0;
    let q = 0;
    for (const a of e.atoms ?? []) q += a.Z - a.electrons;
    return q;
  }

  /** Nom lisible d'une entité. */
  static describe(e: MicroEntity): string {
    if (e.kind === 'p') return 'Proton (uud)';
    if (e.kind === 'n') return 'Neutron (udd)';
    if (e.kind === 'e') return 'Électron';
    if (e.kind === 'photon') return 'Photon';
    const atoms = e.atoms ?? [];
    if (atoms.length === 1) {
      const a = atoms[0];
      const el = ELEMENT_BY_Z.get(a.Z);
      const q = a.Z - a.electrons;
      if (a.electrons === 0) return `Noyau ${nucleusName(a.Z, a.N)}`;
      const ion = q === 0 ? '' : q > 0 ? ` (ion ${q}+)` : ` (ion ${-q}−)`;
      return `${el?.name ?? 'Élément ' + a.Z}${ion}`;
    }
    const f = MicroLab.formula(e);
    return KNOWN_MOLECULES[f] ? `${KNOWN_MOLECULES[f]} (${f})` : `Molécule ${f}`;
  }

  static formula(e: MicroEntity): string {
    return hillFormula((e.atoms ?? []).map((a) => ELEMENT_BY_Z.get(a.Z)?.symbol ?? '?'));
  }

  private freeValence(e: MicroEntity, i: number): number {
    const a = e.atoms![i];
    const el = ELEMENT_BY_Z.get(a.Z);
    if (!el || a.electrons !== a.Z) return 0;
    let used = 0;
    for (const [p, q, o] of e.bonds ?? []) if (p === i || q === i) used += o;
    return Math.max(0, el.valence - used);
  }

  /** Température de liaison (K) : au-delà, les molécules se dissocient. */
  static bondBreakT = 4000;

  /** Avance la simulation de dt secondes (temps réel × vitesse). */
  step(dtReal: number): void {
    const dt = clamp(sanitize(dtReal, 0, 0, 0.1) * this.speed, 0, 0.2);
    if (dt <= 0) return;
    this.time += dt;
    const T = this.temperature;
    const ents = this.entities;
    const half = LAB_SIZE / 2;
    // forces coulombiennes (adoucies) entre entités chargées proches
    const charged = ents.filter((e) => e.kind !== 'photon' && MicroLab.charge(e) !== 0);
    for (let i = 0; i < charged.length; i++) {
      const a = charged[i];
      const qa = MicroLab.charge(a), ma = MicroLab.mass(a);
      for (let j = i + 1; j < charged.length; j++) {
        const b = charged[j];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > 160 * 160) continue;
        const qb = MicroLab.charge(b), mb = MicroLab.mass(b);
        const f = (-qa * qb * 4000) / (r2 + 100) / Math.sqrt(r2 + 1e-6);
        // f > 0 : attraction
        a.vx += (f * dx * dt) / ma * 0.02; a.vy += (f * dy * dt) / ma * 0.02; a.vz += (f * dz * dt) / ma * 0.02;
        b.vx -= (f * dx * dt) / mb * 0.02; b.vy -= (f * dy * dt) / mb * 0.02; b.vz -= (f * dz * dt) / mb * 0.02;
      }
    }
    // thermostat de Langevin + intégration + parois
    const gamma = 1.5;
    for (const e of ents) {
      if (e.kind === 'photon') {
        e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
        e.life = (e.life ?? 1) - dt;
        continue;
      }
      const m = MicroLab.mass(e);
      const s = this.thermalSpeed(m);
      const k = Math.sqrt(2 * gamma * dt) * s * 0.6;
      e.vx += -gamma * e.vx * dt + this.rng.gauss(0, k);
      e.vy += -gamma * e.vy * dt + this.rng.gauss(0, k);
      e.vz += -gamma * e.vz * dt + this.rng.gauss(0, k);
      const vmax = 400;
      const sp = Math.hypot(e.vx, e.vy, e.vz);
      if (sp > vmax) { e.vx *= vmax / sp; e.vy *= vmax / sp; e.vz *= vmax / sp; }
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      if (e.x < -half) { e.x = -half; e.vx = Math.abs(e.vx); } else if (e.x > half) { e.x = half; e.vx = -Math.abs(e.vx); }
      if (e.y < -half) { e.y = -half; e.vy = Math.abs(e.vy); } else if (e.y > half) { e.y = half; e.vy = -Math.abs(e.vy); }
      if (e.z < -half) { e.z = -half; e.vz = Math.abs(e.vz); } else if (e.z > half) { e.z = half; e.vz = -Math.abs(e.vz); }
    }
    this.entities = ents.filter((e) => e.kind !== 'photon' || (e.life ?? 0) > 0 && Math.abs(e.x) < half * 1.5);
    this.decays(dt);
    this.reactions();
    this.ionization(dt);
    this.relaxMolecules(dt);
  }

  private emitPhoton(x: number, y: number, z: number, energy: number): void {
    const [dx, dy, dz] = this.rng.onSphere();
    this.entities.push({ id: NEXT_ID++, kind: 'photon', x, y, z, vx: dx * 300, vy: dy * 300, vz: dz * 300, life: 1.5, spin: energy });
  }

  private decays(dt: number): void {
    for (const e of [...this.entities]) {
      if (e.decay === undefined) continue;
      e.decay -= dt;
      if (e.decay > 0) continue;
      if (e.kind === 'n') {
        // désintégration β⁻ : n → p + e⁻ + ν̄
        this.remove(e);
        const p = this.spawnParticle('p', [e.x, e.y, e.z]);
        p.vx = e.vx; p.vy = e.vy; p.vz = e.vz;
        const el = this.spawnParticle('e', [e.x + 2, e.y, e.z]);
        el.vx = e.vx + this.rng.gauss(0, 60); el.vy = e.vy + this.rng.gauss(0, 60); el.vz = e.vz + this.rng.gauss(0, 60);
        this.emit('decay', 'Désintégration β⁻ : neutron → proton + électron + antineutrino', e);
        continue;
      }
      if (e.kind === 'cluster' && e.atoms?.length === 1) {
        const a = e.atoms[0];
        e.decay = undefined;
        this.stabilize(e, a);
      }
    }
  }

  /** Ramène un noyau instable vers la vallée de stabilité (β⁻, β⁺ ou émission de neutron). */
  private stabilize(e: MicroEntity, a: MicroAtom): void {
    if (isStableNucleus(a.Z, a.N)) return;
    const el = ELEMENT_BY_Z.get(a.Z);
    const before = nucleusName(a.Z, a.N);
    if (!el) {
      // au-delà de la table : fission symbolique en deux noyaux plus légers
      const Z1 = Math.floor(a.Z / 2), N1 = Math.floor(a.N / 2);
      a.Z -= Z1; a.N -= N1; a.electrons = Math.min(a.electrons, a.Z);
      const other = this.spawnAtom(Math.min(Z1, 30), true, [e.x + 10, e.y, e.z]);
      if (other) other.atoms![0].N = N1;
      this.emit('decay', `Fission : ${before} se scinde`, e);
      e.decay = 1;
      return;
    }
    const target = el.N;
    if (a.N > target + 1) {
      // trop de neutrons : β⁻ si possible, sinon émission de neutron
      if (a.N - target > 3) {
        a.N--;
        this.spawnParticle('n', [e.x + 6, e.y, e.z]);
        this.emit('decay', `${before} émet un neutron`, e);
      } else {
        a.N--; a.Z++;
        this.spawnParticle('e', [e.x + 4, e.y, e.z]);
        this.emit('decay', `Désintégration β⁻ : ${before} → ${nucleusName(a.Z, a.N)}`, e);
      }
    } else if (a.N < target - 1 || !isStableNucleus(a.Z, a.N)) {
      if (a.N < target) {
        // β⁺ : p → n + e⁺ + ν (le positron s'annihile : photons)
        a.Z--; a.N++;
        a.electrons = Math.min(a.electrons, a.Z);
        this.emitPhoton(e.x, e.y, e.z, 511);
        this.emitPhoton(e.x, e.y, e.z, 511);
        this.emit('decay', `Désintégration β⁺ : ${before} → ${nucleusName(a.Z, a.N)} (annihilation e⁺e⁻ → 2γ)`, e);
      } else {
        a.N--;
        this.spawnParticle('n', [e.x + 6, e.y, e.z]);
        this.emit('decay', `${before} émet un neutron`, e);
      }
    }
    if (a.Z <= 0) { this.remove(e); return; }
    if (!isStableNucleus(a.Z, a.N)) e.decay = this.rng.range(0.4, 1.5);
    else this.discover(nucleusName(a.Z, a.N), e);
  }

  /** Seuil de fusion (K) : barrière coulombienne ∝ Z₁Z₂ (échelle stellaire ~10⁷ K pour p+p). */
  static fusionThreshold(z1: number, z2: number): number {
    if (z1 === 0 || z2 === 0) return 0; // le neutron ne subit pas de barrière
    return 1e7 * z1 * z2;
  }

  /** Seuil d'ionisation (K) ≈ I / (k·~12) (Saha simplifiée). */
  static ionizationT(Z: number): number {
    const el = ELEMENT_BY_Z.get(Z);
    return (el?.ionization ?? 10) * 11604 / 12;
  }

  private nuclearZN(e: MicroEntity): [number, number] | null {
    if (e.kind === 'p') return [1, 0];
    if (e.kind === 'n') return [0, 1];
    if (e.kind === 'cluster' && e.atoms?.length === 1) return [e.atoms[0].Z, e.atoms[0].N];
    return null;
  }

  private reactions(): void {
    const ents = this.entities;
    const T = this.temperature;
    const removed = new Set<MicroEntity>();
    // grille spatiale simple
    const cell = 40;
    const grid = new Map<string, MicroEntity[]>();
    for (const e of ents) {
      if (e.kind === 'photon') continue;
      const k = `${Math.floor(e.x / cell)},${Math.floor(e.y / cell)},${Math.floor(e.z / cell)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(e);
    }
    for (const a of ents) {
      if (removed.has(a) || a.kind === 'photon') continue;
      const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell), cz = Math.floor(a.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!l) continue;
        for (const b of l) {
          if (b === a || removed.has(b) || removed.has(a) || b.id < a.id) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          // --- fusion nucléaire ---
          const za = this.nuclearZN(a), zb = this.nuclearZN(b);
          if (za && zb && d < 9) {
            const bareA = a.kind !== 'cluster' || a.atoms![0].electrons === 0 || T > MicroLab.ionizationT(za[0]);
            const bareB = b.kind !== 'cluster' || b.atoms![0].electrons === 0 || T > MicroLab.ionizationT(zb[0]);
            if (bareA && bareB && T >= MicroLab.fusionThreshold(za[0], zb[0]) && za[0] + zb[0] <= 92 && za[0] + zb[0] + za[1] + zb[1] > 1) {
              const Z = za[0] + zb[0], N = za[1] + zb[1];
              if (Z === 0) continue; // n + n : pas de liaison
              this.fuse(a, b, Z, N, removed);
              continue;
            }
          }
          // --- capture électronique (formation d'atomes) ---
          if (d < 18 && (a.kind === 'e' || b.kind === 'e')) {
            const el = a.kind === 'e' ? a : b;
            const other = a.kind === 'e' ? b : a;
            const host = this.toCluster(other);
            if (host && MicroLab.charge(host) > 0) {
              const atom = host.atoms!.find((x) => x.electrons < x.Z);
              if (atom && T < MicroLab.ionizationT(atom.Z) * 1.2) {
                atom.electrons++;
                removed.add(el);
                if (host !== other) removed.add(other);
                this.emitPhoton(host.x, host.y, host.z, 13.6);
                if (atom.electrons === atom.Z) {
                  const name = ELEMENT_BY_Z.get(atom.Z)?.name ?? 'atome';
                  this.emit('capture', `Recombinaison : un atome de ${name} neutre se forme`, host);
                  this.discover(`Atome : ${name}`, host);
                }
                continue;
              }
            }
          }
          // --- liaisons chimiques ---
          if (a.kind === 'cluster' && b.kind === 'cluster' && d < 30 && T < MicroLab.bondBreakT) {
            this.tryBond(a, b, removed);
          }
        }
      }
    }
    if (removed.size) {
      this.entities = this.entities.filter((e) => !removed.has(e));
      this.version++;
    }
  }

  /** Convertit un proton libre en cluster (noyau d'hydrogène) pour la capture. */
  private toCluster(e: MicroEntity): MicroEntity | null {
    if (e.kind === 'cluster') return e;
    if (e.kind === 'p') {
      const c: MicroEntity = { id: NEXT_ID++, kind: 'cluster', x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, atoms: [{ Z: 1, N: 0, electrons: 0, ox: 0, oy: 0, oz: 0 }], bonds: [], spin: 0 };
      this.entities.push(c);
      return c;
    }
    return null;
  }

  private fuse(a: MicroEntity, b: MicroEntity, Z: number, N: number, removed: Set<MicroEntity>): void {
    const ma = MicroLab.mass(a), mb = MicroLab.mass(b);
    const m = ma + mb;
    const c: MicroEntity = {
      id: NEXT_ID++, kind: 'cluster',
      x: (a.x * ma + b.x * mb) / m, y: (a.y * ma + b.y * mb) / m, z: (a.z * ma + b.z * mb) / m,
      vx: (a.vx * ma + b.vx * mb) / m, vy: (a.vy * ma + b.vy * mb) / m, vz: (a.vz * ma + b.vz * mb) / m,
      atoms: [{ Z, N, electrons: 0, ox: 0, oy: 0, oz: 0 }], bonds: [], spin: this.rng.range(-1, 1),
    };
    removed.add(a); removed.add(b);
    this.entities.push(c);
    this.emitPhoton(c.x, c.y, c.z, 2e6);
    const name = nucleusName(Z, N);
    this.emit('fusion', `Fusion nucléaire → ${name}${isStableNucleus(Z, N) ? '' : ' (instable)'}`, c);
    if (isStableNucleus(Z, N)) this.discover(name, c);
    else c.decay = this.rng.range(0.3, 1.2);
  }

  private tryBond(a: MicroEntity, b: MicroEntity, removed: Set<MicroEntity>): void {
    // trouver un atome avec valence libre dans chacun
    let ia = -1, ib = -1;
    for (let i = 0; i < a.atoms!.length && ia < 0; i++) if (this.freeValence(a, i) > 0) ia = i;
    for (let i = 0; i < b.atoms!.length && ib < 0; i++) if (this.freeValence(b, i) > 0) ib = i;
    if (ia < 0 || ib < 0) return;
    if (a.atoms!.length + b.atoms!.length > 24) return;
    // probabilité de réaction (énergie d'activation ~ favorisée par la température modérée)
    if (this.rng.next() > 0.35) return;
    const offset = a.atoms!.length;
    const ma = MicroLab.mass(a), mb = MicroLab.mass(b), m = ma + mb;
    const cx = (a.x * ma + b.x * mb) / m, cy = (a.y * ma + b.y * mb) / m, cz = (a.z * ma + b.z * mb) / m;
    for (const at of a.atoms!) { at.ox += a.x - cx; at.oy += a.y - cy; at.oz += a.z - cz; }
    for (const at of b.atoms!) a.atoms!.push({ ...at, ox: at.ox + b.x - cx, oy: at.oy + b.y - cy, oz: at.oz + b.z - cz });
    for (const [p, q, o] of b.bonds!) a.bonds!.push([p + offset, q + offset, o]);
    a.bonds!.push([ia, ib + offset, 1]);
    // liaisons multiples si les deux atomes ont encore de la valence (O=O, N≡N, O=C=O)
    const bond = a.bonds![a.bonds!.length - 1];
    while (bond[2] < 3 && this.freeValence(a, ia) > 0 && this.freeValence(a, ib + offset) > 0 && a.atoms!.length === 2) bond[2]++;
    a.x = cx; a.y = cy; a.z = cz;
    a.vx = (a.vx * ma + b.vx * mb) / m; a.vy = (a.vy * ma + b.vy * mb) / m; a.vz = (a.vz * ma + b.vz * mb) / m;
    removed.add(b);
    // saturation interne : former des liaisons multiples supplémentaires si possible
    for (const bd of a.bonds!) {
      while (bd[2] < 3 && this.freeValence(a, bd[0]) > 0 && this.freeValence(a, bd[1]) > 0 && this.canMultiBond(a, bd[0]) && this.canMultiBond(a, bd[1])) bd[2]++;
    }
    const f = MicroLab.formula(a);
    const known = KNOWN_MOLECULES[f];
    this.emit('bond', `Liaison chimique : ${known ? `${known} (${f})` : f}`, a);
    if (known) this.discover(`Molécule : ${known}`, a);
  }

  private canMultiBond(e: MicroEntity, i: number): boolean {
    const Z = e.atoms![i].Z;
    return Z === 6 || Z === 7 || Z === 8 || Z === 16;
  }

  private ionization(dt: number): void {
    const T = this.temperature;
    for (const e of [...this.entities]) {
      if (e.kind !== 'cluster') continue;
      // dissociation des molécules
      if (e.atoms!.length > 1 && T > MicroLab.bondBreakT && this.rng.next() < dt * 2 * (T / MicroLab.bondBreakT)) {
        this.remove(e);
        for (const at of e.atoms!) {
          const ne = this.spawnAtom(at.Z, false, [e.x + at.ox, e.y + at.oy, e.z + at.oz]);
          if (ne) { ne.atoms![0].N = at.N; ne.atoms![0].electrons = at.electrons; }
        }
        this.emit('break', `Dissociation thermique de ${MicroLab.describe(e)}`, e);
        continue;
      }
      if (e.atoms!.length !== 1) continue;
      const a = e.atoms![0];
      if (a.electrons > 0 && T > MicroLab.ionizationT(a.Z) && this.rng.next() < dt * 3) {
        a.electrons--;
        const el = this.spawnParticle('e', [e.x + 15, e.y, e.z]);
        el.vx += this.rng.gauss(0, 120); el.vy += this.rng.gauss(0, 120);
        if (a.electrons === a.Z - 1) this.emit('ionize', `Ionisation : ${ELEMENT_BY_Z.get(a.Z)?.name ?? 'atome'} perd un électron`, e);
      }
    }
  }

  private relaxMolecules(dt: number): void {
    const L = 22;
    for (const e of this.entities) {
      if (e.kind !== 'cluster' || !e.atoms || e.atoms.length < 2) continue;
      const at = e.atoms;
      for (let it = 0; it < 3; it++) {
        for (const [i, j, o] of e.bonds!) {
          const A = at[i], B = at[j];
          const dx = B.ox - A.ox, dy = B.oy - A.oy, dz = B.oz - A.oz;
          const d = Math.hypot(dx, dy, dz) + 1e-6;
          const target = L * (1 - 0.08 * (o - 1)) * (A.Z === 1 || B.Z === 1 ? 0.7 : 1);
          const k = ((d - target) / d) * 0.25;
          A.ox += dx * k; A.oy += dy * k; A.oz += dz * k;
          B.ox -= dx * k; B.oy -= dy * k; B.oz -= dz * k;
        }
        // répulsion des paires non liées (géométrie type VSEPR approchée)
        for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) {
          const A = at[i], B = at[j];
          const dx = B.ox - A.ox, dy = B.oy - A.oy, dz = B.oz - A.oz;
          const d = Math.hypot(dx, dy, dz) + 1e-6;
          if (d < L * 1.6) {
            const k = ((L * 1.6 - d) / d) * 0.05;
            A.ox -= dx * k; A.oy -= dy * k; A.oz -= dz * k;
            B.ox += dx * k; B.oy += dy * k; B.oz += dz * k;
          }
        }
      }
      // recentrage
      let sx = 0, sy = 0, sz = 0;
      for (const a of at) { sx += a.ox; sy += a.oy; sz += a.oz; }
      sx /= at.length; sy /= at.length; sz /= at.length;
      for (const a of at) { a.ox -= sx; a.oy -= sy; a.oz -= sz; }
      void dt;
    }
  }

  /** Comptage par espèce (pour l'interface). */
  census(): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of this.entities) {
      if (e.kind === 'photon') continue;
      const k = MicroLab.describe(e);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }

  toJSON(): unknown {
    return { temperature: this.temperature, entities: this.entities.filter((e) => e.kind !== 'photon'), discoveries: [...this.discoveries] };
  }

  loadJSON(d: unknown): void {
    const o = d as { temperature?: number; entities?: MicroEntity[]; discoveries?: string[] } | null;
    if (!o || typeof o !== 'object') return;
    this.temperature = sanitize(o.temperature, 300, 1, 1e10);
    this.entities = Array.isArray(o.entities)
      ? o.entities.filter((e) => e && typeof e === 'object' && ['p', 'n', 'e', 'cluster'].includes(e.kind) && Number.isFinite(e.x)).map((e) => ({ ...e, id: NEXT_ID++ }))
      : [];
    this.discoveries = new Set(Array.isArray(o.discoveries) ? o.discoveries.filter((s) => typeof s === 'string') : []);
    this.version++;
  }
}
