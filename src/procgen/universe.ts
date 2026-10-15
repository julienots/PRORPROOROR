import { Rng, hashCombine } from '../core/rng';
import { SimplexNoise } from '../core/noise';
import { defaultGalaxyParams, type GalaxyParams, type GalaxyType } from '../sim/galaxy';
import { properName } from './names';
import type { Halo } from '../sim/bigbang';

/**
 * Univers procédural à l'échelle cosmique, découpé en secteurs cubiques générés à la
 * demande. La densité de galaxies suit une « toile cosmique » (bruit à crêtes ≈
 * filaments) et les amas contiennent davantage d'elliptiques (relation morphologie–densité).
 * Unité : Mpc (comobile).
 */
export const SECTOR_MPC = 25;

export interface CosmicGalaxy {
  id: string;
  name: string;
  type: GalaxyType;
  seed: number;
  /** Position comobile (Mpc). */
  x: number; y: number; z: number;
  /** Rayon visuel (Mpc). */
  size: number;
  stellarMass: number;
  /** Orientation (normale du disque). */
  nx: number; ny: number; nz: number;
  createdBy: 'gen' | 'player';
}

export class CosmicGenerator {
  readonly seed: number;
  private noise: SimplexNoise;
  private cache = new Map<string, CosmicGalaxy[]>();
  /** Catalogue de halos issu d'une simulation de Big Bang (remplace la génération au centre). */
  haloCatalog: { halos: Halo[]; box: number } | null = null;

  constructor(seed: number) {
    this.seed = seed;
    this.noise = new SimplexNoise(hashCombine(seed, 0xc05));
  }

  /** Densité relative de la toile cosmique en un point (≥ 0). */
  webDensity(x: number, y: number, z: number): number {
    const s = 1 / 60;
    const r = this.noise.ridged(x * s, y * s, z * s, 4, 2.0, 0.55);
    const blob = 0.5 + 0.5 * this.noise.fbm(x * s * 0.5 + 100, y * s * 0.5, z * s * 0.5, 3);
    return Math.pow(r, 4) * 3 * (0.4 + blob);
  }

  sectorKey(ix: number, iy: number, iz: number): string {
    return `${ix},${iy},${iz}`;
  }

  /** Galaxies d'un secteur (générées une seule fois, reproductibles). */
  sector(ix: number, iy: number, iz: number): CosmicGalaxy[] {
    const key = this.sectorKey(ix, iy, iz);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out: CosmicGalaxy[] = [];
    const rng = new Rng(hashCombine(this.seed, ix, iy, iz));
    const x0 = ix * SECTOR_MPC, y0 = iy * SECTOR_MPC, z0 = iz * SECTOR_MPC;
    const fromHalos = this.haloCatalog && Math.max(Math.abs(x0 + SECTOR_MPC / 2), Math.abs(y0 + SECTOR_MPC / 2), Math.abs(z0 + SECTOR_MPC / 2)) < this.haloCatalog.box / 2;
    if (fromHalos && this.haloCatalog) {
      const hs = this.haloCatalog.halos;
      for (let k = 0; k < hs.length; k++) {
        const h = hs[k];
        if (h.x < x0 || h.x >= x0 + SECTOR_MPC || h.y < y0 || h.y >= y0 + SECTOR_MPC || h.z < z0 || h.z >= z0 + SECTOR_MPC) continue;
        out.push(this.makeGalaxy(rng, h.x, h.y, h.z, Math.min(3, Math.log10(1 + h.peak)), k));
      }
    } else {
      const samples = 220;
      for (let k = 0; k < samples; k++) {
        const x = x0 + rng.next() * SECTOR_MPC, y = y0 + rng.next() * SECTOR_MPC, z = z0 + rng.next() * SECTOR_MPC;
        const d = this.webDensity(x, y, z);
        if (rng.next() > d * 0.35) continue;
        out.push(this.makeGalaxy(rng, x, y, z, d, k));
      }
    }
    // la galaxie d'origine occupe le centre
    if (ix === 0 && iy === 0 && iz === 0) {
      out.push({
        id: 'home', name: 'Voie lactée', type: 'barred', seed: hashCombine(this.seed, 0x40e),
        x: 0.001, y: 0.001, z: 0.001, size: 0.03, stellarMass: 6e10, nx: 0, ny: 1, nz: 0, createdBy: 'gen',
      });
    }
    this.cache.set(key, out);
    if (this.cache.size > 400) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return out;
  }

  private makeGalaxy(rng: Rng, x: number, y: number, z: number, density: number, k: number): CosmicGalaxy {
    const seed = rng.nextU32();
    const r2 = new Rng(seed);
    const dense = density > 1.2;
    const u = r2.next();
    const type: GalaxyType = dense
      ? (u < 0.55 ? 'elliptical' : u < 0.75 ? 'lenticular' : u < 0.92 ? 'spiral' : 'barred')
      : (u < 0.45 ? 'spiral' : u < 0.7 ? 'barred' : u < 0.82 ? 'irregular' : u < 0.92 ? 'lenticular' : 'elliptical');
    const mass = type === 'irregular' ? r2.logRange(1e8, 5e9) : type === 'elliptical' && dense ? r2.logRange(5e10, 2e12) : r2.logRange(5e9, 3e11);
    const [nx, ny, nz] = r2.onSphere();
    void k;
    return {
      id: `c${seed.toString(36)}`, name: `${properName(r2)} ${r2.int(1, 9999)}`, type, seed, x, y, z,
      size: 0.012 * Math.pow(mass / 5e10, 0.33), stellarMass: mass, nx, ny, nz, createdBy: 'gen',
    };
  }

  /** Galaxies dans un rayon (Mpc) autour d'un point, générées à la demande. */
  galaxiesNear(cx: number, cy: number, cz: number, radius: number): CosmicGalaxy[] {
    const out: CosmicGalaxy[] = [];
    const r = Math.ceil(radius / SECTOR_MPC);
    const ix0 = Math.floor(cx / SECTOR_MPC), iy0 = Math.floor(cy / SECTOR_MPC), iz0 = Math.floor(cz / SECTOR_MPC);
    for (let ix = ix0 - r; ix <= ix0 + r; ix++) for (let iy = iy0 - r; iy <= iy0 + r; iy++) for (let iz = iz0 - r; iz <= iz0 + r; iz++) {
      for (const g of this.sector(ix, iy, iz)) {
        if ((g.x - cx) ** 2 + (g.y - cy) ** 2 + (g.z - cz) ** 2 <= radius * radius) out.push(g);
      }
    }
    return out;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** Paramètres galactiques complets d'une galaxie cosmique (pour la vue galactique). */
export function galaxyParamsFor(g: CosmicGalaxy, starCount = 40000): GalaxyParams {
  const p = defaultGalaxyParams(g.seed, g.type, g.name);
  p.id = g.id;
  p.stellarMass = g.stellarMass;
  p.radius = g.type === 'irregular' ? 10 * Math.pow(g.stellarMass / 1e9, 0.3) : 35 * Math.pow(g.stellarMass / 5e10, 0.35);
  p.starCount = starCount;
  p.createdBy = g.createdBy;
  if (g.id === 'home') {
    p.radius = 50; p.stellarMass = 6e10; p.arms = 4; p.pitchDeg = 13; p.bulgeFraction = 0.15; p.gasFraction = 0.12; p.name = 'Voie lactée';
  }
  return p;
}
