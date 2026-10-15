import { describe, it, expect } from 'vitest';
import { Rng, hashCombine } from '../src/core/rng';
import { SimplexNoise } from '../src/core/noise';
import { G_SIM, M_EARTH_SUN, sanitize } from '../src/core/units';
import { World } from '../src/sim/world';
import { makeStar, makePlanet, makeBlackHole, makeNebula, bodyFromMatter } from '../src/sim/factory';
import { keplerPropagate, orbitalElements } from '../src/sim/kepler';
import { createBuffers, accelDirect, accelBarnesHut } from '../src/sim/gravity';
import {
  mainSequenceLifetime, stellarFate, jeansMass, freeFallTime, stellarStateAt, initialStarState,
} from '../src/sim/stellar';
import {
  schwarzschildRadiusKm, iscoRadiusM, mergeBlackHoles, radiativeEfficiency, coalescenceTime,
} from '../src/sim/blackhole';
import { surfaceGravity, equilibriumTemperature, waterBoilingPoint, habitability } from '../src/sim/planet';
import { generateSolarSystem, generateSystem } from '../src/procgen/starsystem';

describe('RNG et bruit reproductibles', () => {
  it('même graine → même suite', () => {
    const a = new Rng(1234), b = new Rng(1234), c = new Rng(1235);
    const sa = Array.from({ length: 10 }, () => a.next());
    const sb = Array.from({ length: 10 }, () => b.next());
    const sc = Array.from({ length: 10 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it('hashCombine est déterministe et sensible à chaque argument', () => {
    expect(hashCombine(1, 2, 3)).toBe(hashCombine(1, 2, 3));
    expect(hashCombine(1, 2, 3)).not.toBe(hashCombine(1, 3, 2));
  });
  it('bruit simplex borné et reproductible', () => {
    const n1 = new SimplexNoise(7), n2 = new SimplexNoise(7);
    for (let i = 0; i < 100; i++) {
      const v = n1.noise3(i * 0.37, i * 0.11, -i * 0.23);
      expect(v).toBe(n2.noise3(i * 0.37, i * 0.11, -i * 0.23));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('Gravité et intégration', () => {
  it('orbite terrestre : période d\'un an, énergie conservée', () => {
    const w = new World();
    w.settings.integration = 'nbody';
    w.settings.budgetMs = 1e9;
    w.settings.maxSubsteps = 1e6;
    w.settings.stellarEvolution = false;
    const sun = w.add(makeStar({ mass: 1 }), true);
    const earth = makePlanet({ massEarth: 1 });
    w.add(earth, true);
    w.placeInOrbit(earth, sun, 1);
    const e0 = w.energy();
    const start = { ...earth.pos };
    for (let i = 0; i < 100; i++) w.step(0.01);
    const d = Math.hypot(earth.pos.x - start.x, earth.pos.y - start.y, earth.pos.z - start.z);
    expect(d).toBeLessThan(0.01);
    expect(Math.abs((w.energy() - e0) / e0)).toBeLessThan(1e-4);
  });

  it('Kepler universel ≡ N-corps sur une orbite elliptique', () => {
    const r0 = { x: 1, y: 0, z: 0 };
    const v0 = { x: 0, y: 0, z: 7.5 };
    const res = keplerPropagate(r0, v0, G_SIM, 0.37)!;
    const w = new World();
    w.settings.integration = 'nbody'; w.settings.budgetMs = 1e9; w.settings.maxSubsteps = 1e6; w.settings.stellarEvolution = false; w.settings.eta = 0.002;
    const s = w.add(makeStar({ mass: 1 }), true); s.pinned = true;
    const p = makePlanet({ mass: 1e-15 }); p.pos = { ...r0 }; p.vel = { ...v0 };
    w.add(p, true);
    w.step(0.37);
    expect(Math.hypot(p.pos.x - res.r.x, p.pos.y - res.r.y, p.pos.z - res.r.z)).toBeLessThan(1e-3);
    const el = orbitalElements(r0, v0, G_SIM);
    expect(el.e).toBeGreaterThan(0.3);
    expect(el.a).toBeGreaterThan(1);
  });

  it('Barnes–Hut ≈ somme directe (erreur < 3 %) et rapide pour N = 3000', () => {
    const rng = new Rng(5);
    const n = 3000;
    const b = createBuffers(n);
    b.n = n;
    for (let i = 0; i < n; i++) {
      b.px[i] = rng.gauss(); b.py[i] = rng.gauss(); b.pz[i] = rng.gauss();
      b.m[i] = rng.range(0.1, 1); b.eps[i] = 0.01;
    }
    accelDirect(b);
    const ax = Float64Array.from(b.ax.subarray(0, n)), ay = Float64Array.from(b.ay.subarray(0, n)), az = Float64Array.from(b.az.subarray(0, n));
    const t0 = performance.now();
    accelBarnesHut(b, 0.5);
    const dt = performance.now() - t0;
    let errSum = 0, normSum = 0;
    for (let i = 0; i < n; i++) {
      errSum += Math.hypot(b.ax[i] - ax[i], b.ay[i] - ay[i], b.az[i] - az[i]);
      normSum += Math.hypot(ax[i], ay[i], az[i]);
    }
    expect(errSum / normSum).toBeLessThan(0.03);
    expect(dt).toBeLessThan(1000);
  });

  it('mode Kepler séculaire : stable sur un million d\'années', () => {
    const w = new World();
    generateSolarSystem(w);
    w.settings.integration = 'kepler';
    w.settings.stellarEvolution = false;
    const earth = w.bodies.find((b) => b.name === 'Terre')!;
    const r0 = Math.hypot(earth.pos.x, earth.pos.y, earth.pos.z);
    for (let i = 0; i < 100; i++) w.step(1e4);
    const r1 = Math.hypot(earth.pos.x, earth.pos.y, earth.pos.z);
    expect(Math.abs(r1 - r0)).toBeLessThan(0.05);
    expect(w.time).toBeCloseTo(1e6, 0);
  });
});

describe('Évolution stellaire', () => {
  it('durées de vie et destins', () => {
    expect(mainSequenceLifetime(1)).toBeCloseTo(1e10, -8);
    expect(mainSequenceLifetime(10)).toBeLessThan(5e7);
    expect(stellarFate(1)).toBe('whitedwarf');
    expect(stellarFate(12)).toBe('neutronstar');
    expect(stellarFate(30)).toBe('blackhole');
  });
  it('le Soleil devient géante rouge puis naine blanche', () => {
    const w = new World();
    w.settings.stellarEvolution = true;
    const s = w.add(makeStar({ mass: 1 }), true);
    s.star!.age = 1.05e10;
    w.step(1e7);
    expect(['subgiant', 'redgiant']).toContain(s.star!.phase);
    w.ageStar(s.id, 1.2);
    const wd = w.get(s.id)!;
    expect(wd.kind).toBe('whitedwarf');
    expect(wd.mass).toBeGreaterThan(0.45);
    expect(wd.mass).toBeLessThan(0.7);
    expect(w.bodies.some((b) => b.kind === 'nebula' && b.nebula?.remnant)).toBe(true);
  });
  it('supernova d\'une étoile de 25 M☉ → trou noir, rémanent et éjectas', () => {
    const w = new World();
    const s = w.add(makeStar({ mass: 25 }), true);
    const p = makePlanet({ massEarth: 1 });
    w.add(p, true);
    w.placeInOrbit(p, s, 5);
    w.forceSupernova(s.id);
    const rem = w.get(s.id)!;
    expect(rem.kind).toBe('blackhole');
    expect(w.particles.count).toBeGreaterThan(1000);
    expect(w.events.some((e) => e.type === 'supernova')).toBe(true);
    // la perte de masse délie la planète
    const el = orbitalElements(
      { x: p.pos.x - rem.pos.x, y: p.pos.y - rem.pos.y, z: p.pos.z - rem.pos.z },
      { x: p.vel.x - rem.vel.x, y: p.vel.y - rem.vel.y, z: p.vel.z - rem.vel.z },
      G_SIM * rem.mass,
    );
    expect(el.e).toBeGreaterThan(0.5);
  });
  it('protoétoile → séquence principale', () => {
    const st = initialStarState(1, 0.014, 25, 'protostar');
    expect(stellarStateAt(st).phase).toBe('protostar');
    expect(stellarStateAt(st).radiusKm).toBeGreaterThan(695700 * 3);
  });
  it('masse de Jeans et effondrement d\'un nuage en système planétaire', () => {
    expect(jeansMass(10, 1e4)).toBeGreaterThan(1);
    expect(jeansMass(10, 1e4)).toBeLessThan(20);
    expect(freeFallTime(1e4)).toBeGreaterThan(1e5);
    const w = new World();
    const neb = w.add(makeNebula({ mass: 10, density: 1e5, temperature: 10 }), true);
    for (let i = 0; i < 200 && w.get(neb.id); i++) w.step(2e4);
    expect(w.get(neb.id)).toBeUndefined();
    expect(w.bodies.some((b) => b.kind === 'protostar' || b.kind === 'star')).toBe(true);
    expect(w.bodies.filter((b) => b.kind === 'planet').length).toBeGreaterThanOrEqual(2);
  });
});

describe('Trous noirs', () => {
  it('rayon de Schwarzschild, ISCO, efficacité', () => {
    expect(schwarzschildRadiusKm(1)).toBeCloseTo(2.95, 1);
    expect(iscoRadiusM(0)).toBeCloseTo(6, 5);
    expect(iscoRadiusM(0.998)).toBeLessThan(1.5);
    expect(radiativeEfficiency(0)).toBeCloseTo(0.057, 2);
    expect(radiativeEfficiency(0.998)).toBeGreaterThan(0.3);
  });
  it('fusion type GW150914 (36 + 29 M☉)', () => {
    const r = mergeBlackHoles(36, 29);
    expect(r.finalMass).toBeGreaterThan(60);
    expect(r.finalMass).toBeLessThan(63.5);
    expect(r.finalSpin).toBeGreaterThan(0.6);
    expect(r.finalSpin).toBeLessThan(0.75);
    expect(coalescenceTime(10, 10, 1)).toBeGreaterThan(1e13);
  });
  it('binaire de trous noirs : spirale (OG amplifiées) puis fusion', () => {
    const w = new World();
    w.settings.gwBoost = 1e14;
    w.settings.budgetMs = 1e9;
    w.settings.maxSubsteps = 200000;
    w.settings.integration = 'nbody';
    const a = w.add(makeBlackHole({ mass: 30 }), true);
    const b = makeBlackHole({ mass: 20 });
    w.add(b, true);
    w.placeInOrbit(b, a, 0.002);
    const m0 = a.mass + b.mass;
    let merged = false;
    for (let i = 0; i < 400 && !merged; i++) {
      w.step(0.01);
      merged = w.bodies.filter((x) => x.kind === 'blackhole').length === 1;
    }
    expect(merged).toBe(true);
    const fin = w.bodies.find((x) => x.kind === 'blackhole')!;
    expect(fin.mass).toBeLessThan(m0);
    expect(fin.bh!.merger).toBeDefined();
    expect(w.events.some((e) => e.type === 'bhmerger')).toBe(true);
  });
  it('rupture de marée d\'une étoile passant près d\'un trou noir', () => {
    const w = new World();
    w.settings.budgetMs = 1e9; w.settings.maxSubsteps = 1e5; w.settings.integration = 'nbody';
    const bh = w.add(makeBlackHole({ mass: 1e6 }), true);
    const s = makeStar({ mass: 1 });
    s.pos = { x: 0.3, y: 0, z: 0 };
    w.add(s, true);
    w.feedBlackHole(bh.id, s.id);
    for (let i = 0; i < 300 && w.get(s.id); i++) w.step(0.0005);
    expect(w.get(s.id)).toBeUndefined();
    expect(w.events.some((e) => e.type === 'tidal' || e.type === 'swallow')).toBe(true);
  });
});

describe('Planètes', () => {
  it('Terre : gravité, température d\'équilibre, ébullition', () => {
    const e = makePlanet({ massEarth: 1 });
    expect(surfaceGravity(e)).toBeGreaterThan(8.5);
    expect(surfaceGravity(e)).toBeLessThan(11);
    expect(equilibriumTemperature(1, 0.3)).toBeCloseTo(255, -1);
    expect(waterBoilingPoint(1)).toBeCloseTo(373.15, 1);
    expect(waterBoilingPoint(0.1)).toBeLessThan(330);
  });
  it('déplacer la Terre vers Vénus la rend inhabitable (conséquences)', () => {
    const w = new World();
    generateSolarSystem(w);
    const earth = w.bodies.find((b) => b.name === 'Terre')!;
    for (let i = 0; i < 20; i++) w.step(1);
    const h0 = habitability(earth);
    expect(earth.temperature).toBeGreaterThan(270);
    expect(earth.temperature).toBeLessThan(310);
    expect(h0).toBeGreaterThan(0.4);
    const sun = w.bodies.find((b) => b.name === 'Soleil')!;
    w.placeInOrbit(earth, sun, 0.4);
    for (let i = 0; i < 50; i++) w.step(10);
    expect(earth.temperature).toBeGreaterThan(400);
    expect(habitability(earth)).toBeLessThan(0.1);
  });
  it('collision : accrétion avec conservation de la quantité de mouvement', () => {
    const w = new World();
    w.settings.stellarEvolution = false; w.settings.integration = 'nbody'; w.settings.budgetMs = 1e9;
    const a = makePlanet({ massEarth: 1 }); a.pos = { x: 0, y: 0, z: 0 }; a.vel = { x: 0, y: 0, z: 0 };
    const b = makePlanet({ massEarth: 0.01 }); b.pos = { x: 0.0001, y: 0, z: 0 }; b.vel = { x: -0.5, y: 0, z: 0 };
    w.add(a, true); w.add(b, true);
    const p0 = w.momentum();
    const m0 = w.totalMass();
    for (let i = 0; i < 50; i++) w.step(1e-5);
    expect(w.bodies.length).toBe(1);
    const p1 = w.momentum();
    expect(Math.abs(p1.x - p0.x)).toBeLessThan(Math.abs(p0.x) * 0.05 + 1e-12);
    expect(w.totalMass()).toBeCloseTo(m0, 12);
    expect(w.bodies[0].planet!.impacts.length).toBe(1);
  });
});

describe('Matière et validation', () => {
  it('création de matière selon type et masse', () => {
    expect(bodyFromMatter({ matter: 'rock', amount: M_EARTH_SUN })?.kind).toBe('planet');
    expect(bodyFromMatter({ matter: 'ice', amount: 1e-11 })?.kind).toBe('comet');
    expect(bodyFromMatter({ matter: 'gas', amount: 20 })?.kind).toBe('nebula');
    expect(bodyFromMatter({ matter: 'plasma', amount: 2, temperature: 1e7 })?.kind).toBe('star');
    expect(bodyFromMatter({ matter: 'darkmatter', amount: 1 })?.kind).toBe('darkmatter');
    expect(bodyFromMatter({ matter: 'energy', amount: 1 })).toBeNull();
  });
  it('valeurs invalides ramenées dans les bornes', () => {
    expect(sanitize(NaN, 3)).toBe(3);
    expect(sanitize('abc', 2)).toBe(2);
    expect(sanitize(1e9, 1, 0, 10)).toBe(10);
    const s = makeStar({ mass: -5 });
    expect(s.mass).toBeGreaterThan(0);
    const bh = makeBlackHole({ mass: Number.POSITIVE_INFINITY, spin: 7 });
    expect(Number.isFinite(bh.mass)).toBe(true);
    expect(bh.bh!.spin).toBeLessThanOrEqual(0.998);
    const p = makePlanet({ massEarth: NaN, pos: { x: NaN, y: 1, z: 2 }, vel: { x: 1e12, y: 0, z: 0 } });
    expect(Number.isFinite(p.pos.x)).toBe(true);
    expect(Math.abs(p.vel.x)).toBeLessThan(63240);
    const w = new World();
    expect(w.step(NaN).achieved).toBe(0);
    expect(w.step(-5).achieved).toBe(0);
  });
});

describe('Génération procédurale', () => {
  it('système reproductible depuis une graine', () => {
    const w1 = new World(), w2 = new World(), w3 = new World();
    generateSystem(w1, { seed: 777 });
    generateSystem(w2, { seed: 777 });
    generateSystem(w3, { seed: 778 });
    const sig = (w: World) => w.bodies.map((b) => `${b.name}:${b.mass.toPrecision(8)}:${b.pos.x.toFixed(6)}`).join('|');
    expect(sig(w1)).toBe(sig(w2));
    expect(sig(w1)).not.toBe(sig(w3));
    expect(w1.particles.count).toBe(w2.particles.count);
  });
});

describe('Performances', () => {
  it('pas de simulation avec 250 corps et 20 000 particules < 200 ms', () => {
    const w = new World();
    w.settings.maxSubsteps = 50;
    generateSystem(w, { seed: 9 });
    const star = w.primary()!;
    const rng = new Rng(3);
    for (let i = 0; i < 250; i++) {
      const p = makePlanet({ massEarth: rng.logRange(1e-4, 1), seed: rng.nextU32(), name: `P${i}` });
      w.add(p, true);
      w.placeInOrbit(p, star, rng.range(0.5, 40), rng.range(-5, 5), rng.range(0, 6.28));
    }
    for (let i = 0; i < 20000; i++) w.particles.add(rng.range(-30, 30), 0, rng.range(-30, 30), 0, 0, 0, 1e-15, 0, 100);
    const t0 = performance.now();
    w.step(0.01);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(200);
  });
});

describe('Trous noirs à forte accélération du temps', () => {
  it('mode Kepler : la binaire spirale (Peters) et fusionne', () => {
    const w = new World();
    w.settings.integration = 'kepler';
    w.settings.gwBoost = 1e10;
    const a = w.add(makeBlackHole({ mass: 4e6 }), true);
    const b = makeBlackHole({ mass: 2e6 });
    w.add(b, true);
    w.placeInOrbit(b, a, 30);
    for (let i = 0; i < 50 && w.bodies.length > 1; i++) w.step(1);
    expect(w.bodies.filter((x) => x.kind === 'blackhole').length).toBe(1);
    expect(w.events.some((e) => e.type === 'bhmerger')).toBe(true);
  });
});
