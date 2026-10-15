import * as THREE from 'three';
import { LY_AU, km2au, au2km, clamp } from './core/units';
import type { Vec3 } from './core/vec';
import { planeBasis } from './sim/galaxy';
import type { Game } from './game';
import type { GalaxyView } from './render/views/galaxyView';
import type { CosmicView } from './render/views/cosmicView';
import type { SystemView } from './render/views/systemView';
import type { CosmicGalaxy } from './procgen/universe';

/**
 * Monde ouvert : continuité entre les échelles stellaire ↔ galactique ↔ cosmique.
 *
 * Chaque échelle a son propre repère (UA, kal, Mpc) mais les passages se font
 * SANS coupure : la position et l'orientation de la caméra sont converties exactement
 * d'un repère à l'autre, et les ciels sont construits à partir des mêmes objets
 * (étoiles de la galaxie simulée, galaxies voisines). Le passage est déclenché par la
 * position de l'œil (vol libre, zoom, pilote automatique), avec hystérésis.
 */
export const KAL_AU = 1000 * LY_AU; // 1 kal (1000 al) en UA
export const MPC_KAL = 3261.56; // 1 Mpc en kal

/** Sortie d'un système stellaire (UA de l'objet central) — ≈ 5 al. */
export const SYSTEM_EXIT_AU = 3.2e5;
/** Entrée dans un système depuis la galaxie (kal) — ≈ 3,5 al (< sortie : hystérésis). */
export const STAR_ENTER_KAL = 0.0035;

export interface SurfaceState {
  bodyId: number;
  /** Direction du point sous le joueur, dans le repère fixe de l'astre. */
  dir: THREE.Vector3;
  altKm: number;
}

export type Autopilot = { kind: 'star'; idx: number } | { kind: 'galaxy'; id: string } | null;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const addS = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });

export class OpenWorld {
  surface: SurfaceState | null = null;
  autopilot: Autopilot = null;
  /** Empêche une ré-entrée immédiate juste après un passage manuel. */
  private suppressEnter = false;
  /** Statistiques de vol pour l'affichage tête haute. */
  hud = { speed: '', nearest: '', altitude: '', mode: '' };
  private lastToast = '';

  constructor(private game: Game) {}

  private get rig() {
    return this.game.engine.rig;
  }

  // -------------------------------------------------------------------------
  // Passages d'échelle sans coupure
  // -------------------------------------------------------------------------

  systemToGalaxy(suppress = true): void {
    const g = this.game;
    const rig = this.rig;
    if (this.surface) this.leaveSurface();
    g.storeCurrentSystem();
    g.ensureGalaxy();
    const o = this.systemCenter();
    const idx = g.currentStarIndex();
    const gv = g.views.galaxy as GalaxyView;
    const sp = gv.starPosition(idx);
    const relT = sub(rig.target, o), relE = sub(rig.eye, o);
    const dist = rig.distance / KAL_AU;
    const mode = rig.mode;
    g.switchView('galaxy', gv);
    rig.mode = mode === 'free' ? 'free' : 'orbit';
    if (mode === 'free') rig.setEye(addS(sp, relE, 1 / KAL_AU), Math.max(dist, 1e-7));
    else rig.set(addS(sp, relT, 1 / KAL_AU), Math.max(dist, 1e-7));
    rig.update(0);
    g.select(`s${idx}`);
    this.suppressEnter = suppress;
    this.note(`Échelle galactique : ${g.currentGalaxy?.params.name}`);
  }

  galaxyToSystem(idx: number): void {
    const g = this.game;
    const rig = this.rig;
    const gv = g.views.galaxy as GalaxyView;
    const params = g.currentGalaxy?.params;
    if (!params) return;
    const sp = gv.starPosition(idx);
    const relT = sub(rig.target, sp), relE = sub(rig.eye, sp);
    const dist = rig.distance * KAL_AU;
    const mode = rig.mode;
    const key = params.id === 'home' && idx === g.solIndex ? 'sol' : `${params.id}:${idx}`;
    g.systemKey = key;
    g.universe.location.systemKey = key;
    g.loadSystem(key, idx);
    g.switchView('system', g.views.system);
    const p = g.world.primary() ?? g.world.bodies[0];
    const o = this.systemCenter();
    rig.mode = mode === 'free' ? 'free' : 'orbit';
    if (mode === 'free') rig.setEye(addS(o, relE, KAL_AU), dist);
    else rig.set(addS(o, relT, KAL_AU), dist);
    rig.update(0);
    if (p) g.select(`b${p.id}`);
    if (this.autopilot?.kind === 'star') {
      rig.mode = 'orbit';
      if (p) rig.flyTo(p.pos, Math.max(g.systemExtent() * 2.2, km2au(p.radius) * 3), 4);
    }
    this.autopilot = null;
    this.suppressEnter = false;
    const known = g.universe.systems[key] ? 'déjà visité' : 'inexploré — généré à la demande';
    this.note(`Système de ${p?.name ?? 'l\'étoile'} (${known})`);
  }

  /** Repère local de la galaxie courante dans l'espace cosmique (physique). */
  private galaxyFrame(cg: CosmicGalaxy) {
    const a = Math.max(1e-4, this.game.scaleFactorNow());
    const b = planeBasis({ x: cg.nx, y: cg.ny, z: cg.nz });
    return { G: { x: cg.x * a, y: cg.y * a, z: cg.z * a }, ...b };
  }

  galaxyToCosmic(suppress = true): void {
    const g = this.game;
    const rig = this.rig;
    const cg = g.currentGalaxy?.cosmic;
    if (!cg) return;
    const F = this.galaxyFrame(cg);
    const toCos = (v: Vec3): Vec3 => ({
      x: F.G.x + (F.e1.x * v.x + F.n.x * v.y + F.e2.x * v.z) / MPC_KAL,
      y: F.G.y + (F.e1.y * v.x + F.n.y * v.y + F.e2.y * v.z) / MPC_KAL,
      z: F.G.z + (F.e1.z * v.x + F.n.z * v.y + F.e2.z * v.z) / MPC_KAL,
    });
    const f = rig.forward();
    const fc = { x: F.e1.x * f.x + F.n.x * f.y + F.e2.x * f.z, y: F.e1.y * f.x + F.n.y * f.y + F.e2.y * f.z, z: F.e1.z * f.x + F.n.z * f.y + F.e2.z * f.z };
    const eye = toCos(rig.eye), target = toCos(rig.target);
    const dist = rig.distance / MPC_KAL;
    const mode = rig.mode;
    g.storeGalaxyState();
    g.switchView('cosmic', g.views.cosmic);
    rig.setForward(fc);
    rig.mode = mode === 'free' ? 'free' : 'orbit';
    if (mode === 'free') rig.setEye(eye, dist);
    else rig.set(target, dist);
    rig.update(0);
    g.select(`g${cg.id}`);
    this.suppressEnter = suppress;
    this.note('Échelle cosmique : la toile des galaxies se génère autour de vous');
  }

  cosmicToGalaxy(cg: CosmicGalaxy): void {
    const g = this.game;
    const rig = this.rig;
    const F = this.galaxyFrame(cg);
    const toLoc = (p: Vec3): Vec3 => {
      const d = sub(p, F.G);
      return {
        x: (d.x * F.e1.x + d.y * F.e1.y + d.z * F.e1.z) * MPC_KAL,
        y: (d.x * F.n.x + d.y * F.n.y + d.z * F.n.z) * MPC_KAL,
        z: (d.x * F.e2.x + d.y * F.e2.y + d.z * F.e2.z) * MPC_KAL,
      };
    };
    const f = rig.forward();
    const fl = { x: f.x * F.e1.x + f.y * F.e1.y + f.z * F.e1.z, y: f.x * F.n.x + f.y * F.n.y + f.z * F.n.z, z: f.x * F.e2.x + f.y * F.e2.y + f.z * F.e2.z };
    const eye = toLoc(rig.eye), target = toLoc(rig.target);
    const dist = rig.distance * MPC_KAL;
    const mode = rig.mode;
    g.universe.location.galaxyId = cg.id;
    g.galaxy = null;
    g.ensureGalaxy();
    g.switchView('galaxy', g.views.galaxy);
    rig.setForward(fl);
    rig.mode = mode === 'free' ? 'free' : 'orbit';
    if (mode === 'free') rig.setEye(eye, dist);
    else rig.set(target, dist);
    rig.update(0);
    if (this.autopilot?.kind === 'galaxy') {
      rig.mode = 'orbit';
      rig.flyTo({ x: 0, y: 0, z: 0 }, (g.currentGalaxy?.params.radius ?? 40) * 2.5, 4);
      this.autopilot = null;
    }
    this.suppressEnter = false;
    this.note(`Entrée dans ${cg.name}`);
  }

  /** Rayon d'entrée dans une galaxie depuis l'espace cosmique (Mpc physiques). */
  private galaxyEnterRadius(cg: CosmicGalaxy): number {
    return Math.max(cg.size * 2.5, 0.02);
  }

  /** Rayon de sortie de la galaxie courante (kal). */
  private galaxyExitRadius(): number {
    const g = this.game;
    const cg = g.currentGalaxy;
    if (!cg) return 600;
    // doit dépasser le rayon d'entrée vu depuis le cosmos (hystérésis)
    return Math.max(cg.params.radius * 10, this.galaxyEnterRadius(cg.cosmic) * MPC_KAL * 1.5);
  }

  /** Centre du système courant : objet central, sinon premier corps (nébuleuse…), sinon origine. */
  systemCenter(): Vec3 {
    const g = this.game;
    const p = g.world.primary() ?? g.world.bodies[0];
    return p ? { ...p.pos } : { x: 0, y: 0, z: 0 };
  }

  // -------------------------------------------------------------------------
  // Pilote automatique
  // -------------------------------------------------------------------------

  travelToStar(idx: number): void {
    const g = this.game;
    if (g.level === 'system' || g.level === 'planet') this.systemToGalaxy(true);
    if (g.level !== 'galaxy') return;
    const gv = g.views.galaxy as GalaxyView;
    const sp = gv.starPosition(idx);
    const rig = this.rig;
    const d = Math.hypot(sp.x - rig.eye.x, sp.y - rig.eye.y, sp.z - rig.eye.z);
    // suivi : la cible est l'étoile en mouvement (rotation galactique)
    rig.mode = 'follow';
    this.autopilot = { kind: 'star', idx };
    g.select(`s${idx}`);
    rig.flyTo(sp, 0.0008, clamp(3 + Math.log10(1 + d * 1000) * 1.5, 3, 9));
    this.note(`Pilote automatique : cap sur l'étoile #${idx} (${(d * 1000).toFixed(d < 0.01 ? 2 : 0)} al)`);
    g.audio.play('whoosh');
  }

  travelToGalaxy(id: string): void {
    const g = this.game;
    if (g.level !== 'cosmic') return;
    const cv = g.views.cosmic as CosmicView;
    const p = cv.positionOf(`g${id}`);
    const cg = g.findCosmicGalaxy(id);
    if (!p || !cg) return;
    this.autopilot = { kind: 'galaxy', id };
    this.suppressEnter = false;
    this.rig.mode = 'orbit';
    const d = Math.hypot(p.x - this.rig.eye.x, p.y - this.rig.eye.y, p.z - this.rig.eye.z);
    this.rig.flyTo(p, cg.size * 1.2, clamp(3 + Math.log10(1 + d) * 1.5, 3, 9));
    this.note(`Pilote automatique : cap sur ${cg.name}`);
  }

  // -------------------------------------------------------------------------
  // Exploration au sol
  // -------------------------------------------------------------------------

  land(bodyId?: number): boolean {
    const g = this.game;
    const b = bodyId !== undefined ? g.world.get(bodyId) : g.selectedBody();
    if (!b?.planet || b.planet.gasGiant) {
      g.toast('Impossible d\'atterrir : choisissez une planète, une lune ou un astéroïde solide.', 'error');
      return false;
    }
    const sv = g.views.system as SystemView;
    const pv = sv.planetVisual(b.id);
    if (!pv) return false;
    const rig = this.rig;
    const toEye = new THREE.Vector3(rig.eye.x - b.pos.x, rig.eye.y - b.pos.y, rig.eye.z - b.pos.z);
    const dKm = au2km(toEye.length());
    if (toEye.lengthSq() === 0) toEye.set(0, 0, 1);
    const q = pv.frameQuaternion(g.world.time);
    toEye.normalize();
    // se poser du côté jour (vers l'étoile principale), sauf si l'on est déjà de jour
    const star = g.world.primary();
    if (star && star !== b) {
      const sun = new THREE.Vector3(star.pos.x - b.pos.x, star.pos.y - b.pos.y, star.pos.z - b.pos.z).normalize();
      if (toEye.dot(sun) < 0.35) toEye.addScaledVector(sun, 1.3).normalize();
    }
    let dir = toEye.applyQuaternion(q.clone().invert());
    // chercher une terre émergée à proximité (spirale), sinon rester au-dessus de l'eau
    if (pv.groundRadius(dir) <= 1) {
      const ref = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const t1 = new THREE.Vector3().crossVectors(ref, dir).normalize();
      const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();
      for (let k = 1; k < 2500; k++) {
        const r = 0.02 * Math.sqrt(k), a = k * 2.39996;
        const cand = dir.clone().addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
        if (pv.groundRadius(cand) > 1 + 2e-5) { dir = cand; break; }
      }
    }
    const alt = clamp(dKm - b.radius, 0.05, b.radius * 0.03);
    this.surface = { bodyId: b.id, dir, altKm: alt };
    rig.mode = 'surface';
    rig.minDistance = km2au(0.0015);
    rig.maxDistance = km2au(b.radius * 0.4);
    rig.distance = km2au(alt);
    rig.yaw = 0;
    rig.pitch = 0.25;
    g.select(`b${b.id}`);
    if (g.level !== 'planet') { g.level = 'planet'; g.bus.emit('level', 'planet'); }
    this.note(`Exploration de ${b.name} — ZQSD/WASD pour avancer, glisser pour regarder, molette pour l'altitude`);
    return true;
  }

  leaveSurface(): void {
    const g = this.game;
    const s = this.surface;
    this.surface = null;
    const rig = this.rig;
    rig.external = null;
    if (!s) return;
    const b = g.world.get(s.bodyId);
    rig.mode = 'follow';
    rig.minDistance = km2au(0.002);
    rig.maxDistance = 1e9;
    if (b) {
      const f = sub(b.pos, rig.eye);
      rig.setForward(f);
      rig.set(b.pos, km2au(b.radius) * 1.6);
    }
  }

  private surfaceTick(dt: number): void {
    const g = this.game;
    const s = this.surface!;
    const rig = this.rig;
    const b = g.world.get(s.bodyId);
    const pv = b ? (g.views.system as SystemView).planetVisual(b.id) : null;
    if (!b || !pv || g.level === 'galaxy' || g.level === 'cosmic') { this.leaveSurface(); return; }
    const q = pv.frameQuaternion(g.world.time);
    const R = b.radius;
    let alt = au2km(rig.distance);
    // déplacement au sol (repère fixe de l'astre)
    const up = s.dir.clone().normalize();
    const pole = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3().crossVectors(pole, up);
    if (east.lengthSq() < 1e-10) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east).normalize();
    const h = rig.yaw;
    const fwdH = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    const right = east.clone().multiplyScalar(Math.cos(h)).addScaledVector(north, -Math.sin(h));
    const k = rig.keys;
    let mz = 0, mx = 0;
    if (k.has('w') || k.has('z') || k.has('arrowup')) mz += 1;
    if (k.has('s') || k.has('arrowdown')) mz -= 1;
    if (k.has('a') || k.has('q') || k.has('arrowleft')) mx -= 1;
    if (k.has('d') || k.has('arrowright')) mx += 1;
    const speedKm = Math.max(alt * 0.15, 0.004) * (k.has('shift') ? 10 : 1);
    if (mz || mx) {
      const ang = (speedKm * dt) / R;
      s.dir.addScaledVector(fwdH, mz * ang).addScaledVector(right, mx * ang).normalize();
    }
    if (k.has('e') || k.has(' ')) alt *= 1 + dt * 1.2;
    if (k.has('c')) alt /= 1 + dt * 1.2;
    alt = clamp(alt, 0.0015, R * 0.4);
    rig.distance = km2au(alt);
    s.altKm = alt;
    // position : sol + altitude
    const groundKm = pv.groundRadius(s.dir) * R;
    const local = s.dir.clone().multiplyScalar(groundKm + alt);
    const w = local.applyQuaternion(q);
    const eye = { x: b.pos.x + km2au(w.x), y: b.pos.y + km2au(w.y), z: b.pos.z + km2au(w.z) };
    // orientation : horizon local, cap et inclinaison du regard
    const upW = s.dir.clone().applyQuaternion(q);
    const fwdW = fwdH.clone().multiplyScalar(Math.cos(rig.pitch)).addScaledVector(up, -Math.sin(rig.pitch)).applyQuaternion(q).normalize();
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), fwdW, upW);
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    rig.external = { eye, quat, near: Math.max(1e-9, alt * 1e-3 * 0.05) };
    this.hud.altitude = alt < 1 ? `${(alt * 1000).toFixed(0)} m` : `${alt.toFixed(alt < 100 ? 2 : 0)} km`;
    this.hud.mode = `Au sol : ${b.name}`;
    this.hud.speed = `${speedKm < 1 ? (speedKm * 1000).toFixed(0) + ' m/s' : speedKm.toFixed(1) + ' km/s'}${alt < 0.01 ? ' (à pied)' : ' (en vol)'}`;
    this.hud.nearest = '';
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  /** Avant la mise à jour de la caméra : vitesse de vol et exploration au sol. */
  preCamera(dt: number): void {
    const g = this.game;
    if (this.surface) { this.surfaceTick(dt); return; }
    this.rig.external = null;
    const near = this.nearestDistance();
    this.rig.freeSpeedAbs = near !== null ? Math.max(near.dist, near.floor) * this.rig.freeSpeed : null;
    this.updateHud(near?.label ?? '');
    void g;
  }

  /** Après la mise à jour de la caméra : passages d'échelle selon la position de l'œil. */
  postCamera(): void {
    const g = this.game;
    if (this.surface || g.isTransitioning()) return;
    const rig = this.rig;
    switch (g.level) {
      case 'system':
      case 'planet': {
        const o = this.systemCenter();
        const d = Math.hypot(rig.eye.x - o.x, rig.eye.y - o.y, rig.eye.z - o.z);
        if (d > SYSTEM_EXIT_AU && !rig.isFlying()) this.systemToGalaxy(false);
        // vol libre : posé automatiquement en rasant une planète solide
        if (rig.mode === 'free') {
          for (const b of g.world.bodies) {
            if (!b.planet || b.planet.gasGiant) continue;
            const alt = au2km(Math.hypot(rig.eye.x - b.pos.x, rig.eye.y - b.pos.y, rig.eye.z - b.pos.z)) - b.radius;
            if (alt < b.radius * 0.02) { this.land(b.id); break; }
          }
        }
        break;
      }
      case 'galaxy': {
        const gv = g.views.galaxy as GalaxyView;
        const n = gv.nearestStar(rig.eye);
        const inside = n.dist < STAR_ENTER_KAL;
        if (this.suppressEnter) { if (!inside) this.suppressEnter = false; }
        else if (inside && n.idx >= 0 && (!rig.isFlying() || this.autopilot)) { this.galaxyToSystem(n.idx); break; }
        const c = g.galaxy?.components[0]?.center ?? { x: 0, y: 0, z: 0 };
        const dc = Math.hypot(rig.eye.x - c.x, rig.eye.y - c.y, rig.eye.z - c.z);
        if (dc > this.galaxyExitRadius() && !rig.isFlying()) this.galaxyToCosmic(false);
        break;
      }
      case 'cosmic': {
        const cv = g.views.cosmic as CosmicView;
        const a = Math.max(1e-4, g.scaleFactorNow());
        let best: CosmicGalaxy | null = null, bd = Infinity;
        for (const x of cv.galaxies) {
          const d = Math.hypot(x.x * a - rig.eye.x, x.y * a - rig.eye.y, x.z * a - rig.eye.z);
          if (d < this.galaxyEnterRadius(x) && d < bd) { bd = d; best = x; }
        }
        if (this.suppressEnter) { if (!best) this.suppressEnter = false; }
        else if (best && (!rig.isFlying() || this.autopilot)) this.cosmicToGalaxy(best);
        break;
      }
    }
  }

  /** Distance à l'objet le plus proche (unités de la vue) pour régler la vitesse de vol. */
  private nearestDistance(): { dist: number; floor: number; label: string } | null {
    const g = this.game;
    const eye = this.rig.eye;
    if (g.level === 'system' || g.level === 'planet') {
      let best = Infinity, name = '';
      for (const b of g.world.bodies) {
        if (b.kind === 'darkmatter' || b.kind === 'nebula') continue;
        const d = Math.hypot(eye.x - b.pos.x, eye.y - b.pos.y, eye.z - b.pos.z) - km2au(b.radius);
        if (d < best) { best = d; name = b.name; }
      }
      if (!Number.isFinite(best)) return null;
      return { dist: Math.max(best, 0), floor: km2au(0.5), label: `${name} à ${fmtAU(best)}` };
    }
    if (g.level === 'galaxy') {
      const n = (g.views.galaxy as GalaxyView).nearestStar(eye);
      if (n.idx < 0) return null;
      return { dist: n.dist, floor: 1e-5, label: `Étoile #${n.idx} à ${(n.dist * 1000).toPrecision(3)} al` };
    }
    if (g.level === 'cosmic') {
      const cv = g.views.cosmic as CosmicView;
      const a = Math.max(1e-4, g.scaleFactorNow());
      let best = Infinity, name = '';
      for (const x of cv.galaxies) {
        const d = Math.hypot(x.x * a - eye.x, x.y * a - eye.y, x.z * a - eye.z);
        if (d < best) { best = d; name = x.name; }
      }
      if (!Number.isFinite(best)) return null;
      return { dist: best, floor: 0.01, label: `${name} à ${best.toPrecision(3)} Mpc` };
    }
    return null;
  }

  private updateHud(nearest: string): void {
    const g = this.game;
    const rig = this.rig;
    this.hud.nearest = nearest;
    this.hud.altitude = '';
    this.hud.mode = rig.mode === 'free' ? 'Vol libre' : this.autopilot ? 'Pilote automatique' : '';
    const v = Math.hypot(rig.flightVel.x, rig.flightVel.y, rig.flightVel.z);
    if (rig.mode !== 'free') { this.hud.speed = ''; return; }
    // vitesse en km/s et en multiples de c
    let kms = 0;
    if (g.level === 'system' || g.level === 'planet') kms = v * 1.495978707e8;
    else if (g.level === 'galaxy') kms = v * KAL_AU * 1.495978707e8;
    else if (g.level === 'cosmic') kms = v * MPC_KAL * KAL_AU * 1.495978707e8;
    const c = kms / 299792.458;
    this.hud.speed = c > 0.5 ? `${c < 1e4 ? c.toPrecision(3) : c.toExponential(2)} c (pouvoir divin)` : `${kms < 1 ? (kms * 1000).toFixed(0) + ' m/s' : kms.toPrecision(4) + ' km/s'}`;
  }

  private note(msg: string): void {
    if (msg === this.lastToast) return;
    this.lastToast = msg;
    this.game.toast(msg, 'info');
  }
}

function fmtAU(au: number): string {
  const km = au2km(au);
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  if (au < 0.01) return `${km.toPrecision(3)} km`;
  if (au < 5000) return `${au.toPrecision(3)} UA`;
  return `${(au / LY_AU).toPrecision(3)} al`;
}
