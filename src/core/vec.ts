/** Petits utilitaires vectoriels en double précision (objets simples, sérialisables). */
export interface Vec3 { x: number; y: number; z: number }

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vclone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vlen2 = (a: Vec3) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vdist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 0 ? vscale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
export const vset = (o: Vec3, a: Vec3) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vaddInPlace = (o: Vec3, a: Vec3, s = 1) => { o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o; };
export const visFinite = (a: Vec3) => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/** Vecteur perpendiculaire quelconque (non nul). */
export function vperp(a: Vec3): Vec3 {
  const ax = Math.abs(a.x), ay = Math.abs(a.y), az = Math.abs(a.z);
  const other = ax < ay ? (ax < az ? v3(1, 0, 0) : v3(0, 0, 1)) : ay < az ? v3(0, 1, 0) : v3(0, 0, 1);
  return vnorm(vcross(a, other));
}

/** Rotation de v autour de l'axe unitaire k d'un angle θ (Rodrigues). */
export function vrotate(v: Vec3, k: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  const kxv = vcross(k, v);
  const kdv = vdot(k, v);
  return {
    x: v.x * c + kxv.x * s + k.x * kdv * (1 - c),
    y: v.y * c + kxv.y * s + k.y * kdv * (1 - c),
    z: v.z * c + kxv.z * s + k.z * kdv * (1 - c),
  };
}
