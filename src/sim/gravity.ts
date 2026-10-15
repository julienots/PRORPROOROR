import { G_SIM } from '../core/units';

/**
 * Calcul des accélérations gravitationnelles (unités UA, M☉, an).
 * - Somme directe O(N²) pour N ≤ BH_THRESHOLD (exacte, avec adoucissement de Plummer).
 * - Arbre de Barnes–Hut O(N log N) au-delà (critère d'ouverture θ).
 */
export const BH_THRESHOLD = 300;

export interface GravityBuffers {
  n: number;
  px: Float64Array; py: Float64Array; pz: Float64Array;
  vx: Float64Array; vy: Float64Array; vz: Float64Array;
  m: Float64Array;
  eps: Float64Array; // longueur d'adoucissement par corps (UA)
  ax: Float64Array; ay: Float64Array; az: Float64Array;
}

export function createBuffers(capacity: number): GravityBuffers {
  const f = () => new Float64Array(capacity);
  return { n: 0, px: f(), py: f(), pz: f(), vx: f(), vy: f(), vz: f(), m: f(), eps: f(), ax: f(), ay: f(), az: f() };
}

/**
 * Accélérations par somme directe. Retourne l'échelle de temps dynamique minimale
 * (années) utilisée pour adapter le pas d'intégration.
 */
export function accelDirect(b: GravityBuffers): number {
  const { n, px, py, pz, vx, vy, vz, m, eps, ax, ay, az } = b;
  ax.fill(0, 0, n); ay.fill(0, 0, n); az.fill(0, 0, n);
  let minTau2 = Infinity;
  for (let i = 0; i < n; i++) {
    const xi = px[i], yi = py[i], zi = pz[i], mi = m[i], ei = eps[i] * eps[i];
    let axi = 0, ayi = 0, azi = 0;
    for (let j = i + 1; j < n; j++) {
      const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi;
      const r2 = dx * dx + dy * dy + dz * dz;
      const s2 = r2 + ei + eps[j] * eps[j];
      const inv = 1 / Math.sqrt(s2);
      const inv3 = inv * inv * inv;
      const fj = G_SIM * m[j] * inv3;
      const fi = G_SIM * mi * inv3;
      axi += dx * fj; ayi += dy * fj; azi += dz * fj;
      ax[j] -= dx * fi; ay[j] -= dy * fi; az[j] -= dz * fi;
      // échelles de temps : chute libre et croisement
      const mt = mi + m[j];
      if (mt > 0) {
        const tff2 = (s2 * Math.sqrt(s2)) / (G_SIM * mt);
        if (tff2 < minTau2) minTau2 = tff2;
        const dvx = vx[j] - vx[i], dvy = vy[j] - vy[i], dvz = vz[j] - vz[i];
        const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
        if (v2 > 0) {
          const tc2 = s2 / v2;
          // la traversée n'est critique que pour des paires liées gravitationnellement proches
          if (tc2 < minTau2 && tc2 < tff2 * 4) minTau2 = tc2;
        }
      }
    }
    ax[i] += axi; ay[i] += ayi; az[i] += azi;
  }
  return Math.sqrt(minTau2);
}

// ---------------------------------------------------------------------------
// Barnes–Hut
// ---------------------------------------------------------------------------

interface OctNode {
  cx: number; cy: number; cz: number; half: number;
  mass: number; mx: number; my: number; mz: number; // centre de masse
  body: number; // index si feuille contenant un corps, -1 sinon, -2 si interne
  children: (OctNode | null)[] | null;
  epsMax: number;
}

const pool: OctNode[] = [];
let poolUsed = 0;

function newNode(cx: number, cy: number, cz: number, half: number): OctNode {
  let nd = pool[poolUsed];
  if (!nd) {
    nd = { cx: 0, cy: 0, cz: 0, half: 0, mass: 0, mx: 0, my: 0, mz: 0, body: -1, children: null, epsMax: 0 };
    pool[poolUsed] = nd;
  }
  poolUsed++;
  nd.cx = cx; nd.cy = cy; nd.cz = cz; nd.half = half;
  nd.mass = 0; nd.mx = 0; nd.my = 0; nd.mz = 0; nd.body = -1; nd.children = null; nd.epsMax = 0;
  return nd;
}

function octant(nd: OctNode, x: number, y: number, z: number): number {
  return (x > nd.cx ? 1 : 0) | (y > nd.cy ? 2 : 0) | (z > nd.cz ? 4 : 0);
}

function child(nd: OctNode, o: number): OctNode {
  if (!nd.children) nd.children = [null, null, null, null, null, null, null, null];
  let c = nd.children[o];
  if (!c) {
    const h = nd.half / 2;
    c = newNode(nd.cx + (o & 1 ? h : -h), nd.cy + (o & 2 ? h : -h), nd.cz + (o & 4 ? h : -h), h);
    nd.children[o] = c;
  }
  return c;
}

function insert(nd: OctNode, i: number, b: GravityBuffers, depth: number): void {
  const x = b.px[i], y = b.py[i], z = b.pz[i];
  if (nd.body === -1 && !nd.children) {
    nd.body = i;
    return;
  }
  if (depth > 48) {
    // corps quasi superposés : on agrège dans la feuille
    nd.body = -2;
    return;
  }
  if (nd.body >= 0) {
    const j = nd.body;
    nd.body = -2;
    insert(child(nd, octant(nd, b.px[j], b.py[j], b.pz[j])), j, b, depth + 1);
  }
  nd.body = -2;
  insert(child(nd, octant(nd, x, y, z)), i, b, depth + 1);
}

function summarize(nd: OctNode, b: GravityBuffers): void {
  if (nd.body >= 0 && !nd.children) {
    const i = nd.body;
    nd.mass = b.m[i];
    nd.mx = b.px[i]; nd.my = b.py[i]; nd.mz = b.pz[i];
    nd.epsMax = b.eps[i];
    return;
  }
  let m = 0, x = 0, y = 0, z = 0, e = 0;
  if (nd.children) {
    for (const c of nd.children) {
      if (!c) continue;
      summarize(c, b);
      m += c.mass; x += c.mx * c.mass; y += c.my * c.mass; z += c.mz * c.mass;
      if (c.epsMax > e) e = c.epsMax;
    }
  }
  nd.mass = m;
  if (m > 0) { nd.mx = x / m; nd.my = y / m; nd.mz = z / m; } else { nd.mx = nd.cx; nd.my = nd.cy; nd.mz = nd.cz; }
  nd.epsMax = e;
}

function walk(nd: OctNode, i: number, b: GravityBuffers, theta2: number, acc: number[]): void {
  if (nd.mass === 0) return;
  if (nd.body === i && !nd.children) return;
  const dx = nd.mx - b.px[i], dy = nd.my - b.py[i], dz = nd.mz - b.pz[i];
  const r2 = dx * dx + dy * dy + dz * dz;
  const size = nd.half * 2;
  const leaf = nd.body >= 0 && !nd.children;
  if (leaf || (size * size) / Math.max(r2, 1e-300) < theta2) {
    const s2 = r2 + b.eps[i] * b.eps[i] + nd.epsMax * nd.epsMax;
    const inv = 1 / Math.sqrt(s2);
    const f = G_SIM * nd.mass * inv * inv * inv;
    acc[0] += dx * f; acc[1] += dy * f; acc[2] += dz * f;
    if (leaf) {
      const tff2 = (s2 * Math.sqrt(s2)) / (G_SIM * (nd.mass + b.m[i]));
      if (tff2 < acc[3]) acc[3] = tff2;
    }
    return;
  }
  if (nd.children) for (const c of nd.children) if (c) walk(c, i, b, theta2, acc);
}

export function accelBarnesHut(b: GravityBuffers, theta = 0.6): number {
  const { n, px, py, pz } = b;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i] < minx) minx = px[i]; if (px[i] > maxx) maxx = px[i];
    if (py[i] < miny) miny = py[i]; if (py[i] > maxy) maxy = py[i];
    if (pz[i] < minz) minz = pz[i]; if (pz[i] > maxz) maxz = pz[i];
  }
  const half = Math.max(maxx - minx, maxy - miny, maxz - minz, 1e-12) / 2 * 1.0001;
  poolUsed = 0;
  const root = newNode((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2, half);
  for (let i = 0; i < n; i++) insert(root, i, b, 0);
  summarize(root, b);
  const acc = [0, 0, 0, Infinity];
  const theta2 = theta * theta;
  let minTau2 = Infinity;
  for (let i = 0; i < n; i++) {
    acc[0] = 0; acc[1] = 0; acc[2] = 0; acc[3] = Infinity;
    walk(root, i, b, theta2, acc);
    b.ax[i] = acc[0]; b.ay[i] = acc[1]; b.az[i] = acc[2];
    if (acc[3] < minTau2) minTau2 = acc[3];
  }
  return Math.sqrt(minTau2);
}

export function computeAccelerations(b: GravityBuffers): number {
  return b.n > BH_THRESHOLD ? accelBarnesHut(b) : accelDirect(b);
}

/** Potentiel gravitationnel en un point (UA²/an²) — pour la carte des champs. */
export function potentialAt(b: GravityBuffers, x: number, y: number, z: number): number {
  let phi = 0;
  for (let i = 0; i < b.n; i++) {
    const dx = b.px[i] - x, dy = b.py[i] - y, dz = b.pz[i] - z;
    phi -= (G_SIM * b.m[i]) / Math.sqrt(dx * dx + dy * dy + dz * dz + b.eps[i] * b.eps[i] + 1e-12);
  }
  return phi;
}
