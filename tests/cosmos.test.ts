import { describe, it, expect } from 'vitest';
import { GalaxySim, defaultGalaxyParams, rotationCurve, makeComponent, KMS_TO_KALMA } from '../src/sim/galaxy';
import { PLANCK18, integrateHistory, growthFactor, comovingDistance, scaleFactorAt, epochAt, radiationTemperature } from '../src/sim/cosmology';
import { generateStructure, densityContrast, fft3d } from '../src/sim/bigbang';
import { CosmicGenerator, galaxyParamsFor } from '../src/procgen/universe';

describe('Galaxies', () => {
  it('courbe de rotation plate avec matière noire, képlérienne sans', () => {
    const c = makeComponent(defaultGalaxyParams(42, 'spiral'));
    const rc = rotationCurve(c, 30);
    const n = rc.r.length;
    // à grand rayon : avec halo, la vitesse reste élevée ; sans halo, elle décroît
    expect(rc.withDM[n - 1] / Math.max(...rc.withDM)).toBeGreaterThan(0.75);
    expect(rc.withoutDM[n - 1] / Math.max(...rc.withoutDM)).toBeLessThan(0.8);
    expect(rc.withDM[n - 1]).toBeGreaterThan(rc.withoutDM[n - 1] * 1.4);
    // ordre de grandeur Voie lactée : 150–350 km/s
    expect(Math.max(...rc.withDM)).toBeGreaterThan(100);
    expect(Math.max(...rc.withDM)).toBeLessThan(600);
  });

  it('les étoiles restent liées avec halo ; sans halo, le disque se disperse', () => {
    const p = defaultGalaxyParams(7, 'spiral');
    p.starCount = 3000;
    const g1 = GalaxySim.create({ ...p });
    const g2 = GalaxySim.create({ ...p });
    g2.setHalo(false);
    for (let i = 0; i < 60; i++) { g1.step(10, 20); g2.step(10, 20); }
    const d1 = g1.diagnostics(), d2 = g2.diagnostics();
    expect(d1.boundFraction).toBeGreaterThan(0.95);
    expect(d2.meanRadius).toBeGreaterThan(d1.meanRadius * 1.15);
  });

  it('fusion de galaxies : rapprochement et fusion des centres', () => {
    const p = defaultGalaxyParams(1, 'spiral');
    p.starCount = 1500;
    const q = defaultGalaxyParams(2, 'spiral');
    q.starCount = 1500;
    const g = GalaxySim.create(p);
    g.startMerger(q);
    const A = g.components[0], B = g.components[1];
    const d0 = Math.hypot(B.center.x - A.center.x, B.center.y - A.center.y, B.center.z - A.center.z);
    let minD = d0;
    for (let i = 0; i < 400 && !g.merged; i++) {
      g.step(10, 12);
      minD = Math.min(minD, Math.hypot(B.center.x - A.center.x, B.center.y - A.center.y, B.center.z - A.center.z));
    }
    expect(minD).toBeLessThan(d0 * 0.3);
    expect(g.n).toBe(3000);
  });

  it('vitesse circulaire convertie correctement (km/s ↔ kal/Ma)', () => {
    expect(220 * KMS_TO_KALMA).toBeCloseTo(0.734, 2);
  });
});

describe('Cosmologie', () => {
  it('âge de l\'univers Planck 2018 ≈ 13,8 Ga', () => {
    const h = integrateHistory(PLANCK18);
    expect(h.age).toBeGreaterThan(13.5);
    expect(h.age).toBeLessThan(14.1);
    expect(h.fate).toBe('bigfreeze');
    expect(scaleFactorAt(h, h.age)).toBeCloseTo(1, 1);
  });
  it('Big Crunch pour un univers très dense sans énergie noire', () => {
    const h = integrateHistory({ ...PLANCK18, omegaM: 3, omegaL: 0 }, 300);
    expect(h.fate).toBe('bigcrunch');
    expect(h.aMax).toBeLessThan(5);
    expect(Number.isFinite(h.tEnd)).toBe(true);
  });
  it('Big Rip pour une énergie fantôme w < −1', () => {
    const h = integrateHistory({ ...PLANCK18, w: -1.5 }, 400);
    expect(h.fate).toBe('bigrip');
  });
  it('facteur de croissance et distances', () => {
    const d = growthFactor(PLANCK18, 0.5);
    expect(d).toBeGreaterThan(0.55);
    expect(d).toBeLessThan(0.68);
    const dc = comovingDistance(PLANCK18, 1);
    expect(dc).toBeGreaterThan(3200);
    expect(dc).toBeLessThan(3500);
    expect(radiationTemperature(PLANCK18, 1 / 1100)).toBeCloseTo(2998, -2);
    expect(epochAt(3000).id).toBe('recomb');
  });
});

describe('Big Bang (Zel\'dovich)', () => {
  it('FFT 3D aller-retour', () => {
    const N = 8;
    const re = new Float64Array(N ** 3).map((_, i) => Math.sin(i * 0.37));
    const im = new Float64Array(N ** 3);
    const ref = Float64Array.from(re);
    fft3d(re, im, N, false);
    fft3d(re, im, N, true);
    for (let i = 0; i < re.length; i++) expect(re[i]).toBeCloseTo(ref[i], 9);
  });
  it('structures reproductibles qui se contrastent avec le temps, halos détectés', () => {
    const f1 = generateStructure(123, PLANCK18, 32, 150);
    const f2 = generateStructure(123, PLANCK18, 32, 150);
    expect(f1.psi[100]).toBe(f2.psi[100]);
    expect(f1.halos.length).toBeGreaterThan(5);
    const c0 = densityContrast(f1, 0.05, 16);
    const c1 = densityContrast(f1, 1, 16);
    expect(c1).toBeGreaterThan(c0 * 3);
    const f3 = generateStructure(124, PLANCK18, 32, 150);
    expect(f3.psi[100]).not.toBe(f1.psi[100]);
  });
});

describe('Univers procédural', () => {
  it('secteurs reproductibles et galaxie d\'origine', () => {
    const a = new CosmicGenerator(99), b = new CosmicGenerator(99);
    const ga = a.galaxiesNear(0, 0, 0, 40), gb = b.galaxiesNear(0, 0, 0, 40);
    expect(ga.map((g) => g.id)).toEqual(gb.map((g) => g.id));
    expect(ga.find((g) => g.id === 'home')).toBeDefined();
    expect(ga.length).toBeGreaterThan(20);
    const p = galaxyParamsFor(ga.find((g) => g.id === 'home')!);
    expect(p.name).toBe('Voie lactée');
  });
});
