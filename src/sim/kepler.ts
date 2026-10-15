import { G_SIM } from '../core/units';
import type { Vec3 } from '../core/vec';

/**
 * Propagation képlérienne analytique par variables universelles (Battin / Vallado).
 * Utilisée par le mode « séculaire » à très forte accélération du temps : chaque corps
 * suit une orbite à deux corps autour de son parent dominant (approximation).
 */

function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24 + (z * z) / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

/**
 * Propage la position/vitesse relative (r0, v0) d'un temps dt sous le paramètre
 * gravitationnel μ = G(M+m). Retourne null si la résolution diverge.
 */
export function keplerPropagate(r0: Vec3, v0: Vec3, mu: number, dt: number): { r: Vec3; v: Vec3 } | null {
  const r0n = Math.hypot(r0.x, r0.y, r0.z);
  const v0n2 = v0.x * v0.x + v0.y * v0.y + v0.z * v0.z;
  if (r0n === 0 || mu <= 0) return null;
  const sqmu = Math.sqrt(mu);
  const vr0 = (r0.x * v0.x + r0.y * v0.y + r0.z * v0.z) / r0n;
  const alpha = 2 / r0n - v0n2 / mu; // 1/a
  // estimation initiale
  let chi: number;
  if (alpha > 1e-12) {
    // elliptique : réduire dt modulo la période pour la stabilité
    const period = (2 * Math.PI) / (sqmu * Math.pow(alpha, 1.5));
    if (Number.isFinite(period) && Math.abs(dt) > period) dt = dt % period;
    chi = sqmu * alpha * dt;
  } else {
    chi = (sqmu * Math.abs(alpha) * dt) || sqmu * dt / r0n;
  }
  let ok = false;
  for (let it = 0; it < 60; it++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z), S = stumpffS(z);
    const F = (r0n * vr0 / sqmu) * chi * chi * C + (1 - alpha * r0n) * chi * chi * chi * S + r0n * chi - sqmu * dt;
    const dF = (r0n * vr0 / sqmu) * chi * (1 - z * S) + (1 - alpha * r0n) * chi * chi * C + r0n;
    if (dF === 0 || !Number.isFinite(dF)) break;
    const d = F / dF;
    chi -= d;
    if (Math.abs(d) < 1e-12 * Math.max(1, Math.abs(chi))) { ok = true; break; }
  }
  if (!ok || !Number.isFinite(chi)) return null;
  const z = alpha * chi * chi;
  const C = stumpffC(z), S = stumpffS(z);
  const f = 1 - (chi * chi / r0n) * C;
  const g = dt - (chi * chi * chi / sqmu) * S;
  const r = { x: f * r0.x + g * v0.x, y: f * r0.y + g * v0.y, z: f * r0.z + g * v0.z };
  const rn = Math.hypot(r.x, r.y, r.z);
  const fdot = (sqmu / (rn * r0n)) * (alpha * chi * chi * chi * S - chi);
  const gdot = 1 - (chi * chi / rn) * C;
  const v = { x: fdot * r0.x + gdot * v0.x, y: fdot * r0.y + gdot * v0.y, z: fdot * r0.z + gdot * v0.z };
  if (!Number.isFinite(r.x) || !Number.isFinite(v.x)) return null;
  return { r, v };
}

export interface OrbitalElements {
  a: number; // demi-grand axe (UA), négatif si hyperbolique
  e: number;
  i: number; // inclinaison (rad)
  period: number; // années (Infinity si non liée)
  periapsis: number;
  apoapsis: number;
}

export function orbitalElements(r: Vec3, v: Vec3, mu: number): OrbitalElements {
  const rn = Math.hypot(r.x, r.y, r.z);
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x;
  const h = Math.hypot(hx, hy, hz);
  const energy = v2 / 2 - mu / rn;
  const a = -mu / (2 * energy);
  const rv = r.x * v.x + r.y * v.y + r.z * v.z;
  const ex = ((v2 - mu / rn) * r.x - rv * v.x) / mu;
  const ey = ((v2 - mu / rn) * r.y - rv * v.y) / mu;
  const ez = ((v2 - mu / rn) * r.z - rv * v.z) / mu;
  const e = Math.hypot(ex, ey, ez);
  const i = h > 0 ? Math.acos(Math.max(-1, Math.min(1, hy / h))) : 0; // plan de référence : écliptique y-up
  const period = a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
  return { a, e, i, period, periapsis: a * (1 - e), apoapsis: a > 0 ? a * (1 + e) : Infinity };
}

/** Vitesse circulaire (UA/an) à la distance r (UA) d'une masse M (M☉). */
export const circularSpeed = (M: number, r: number) => Math.sqrt((G_SIM * M) / r);

/** Rayon de Hill (UA). */
export const hillRadius = (a: number, m: number, M: number) => a * Math.cbrt(m / (3 * M));
