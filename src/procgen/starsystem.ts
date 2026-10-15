import { Rng, hashCombine } from '../core/rng';
import { M_EARTH_SUN, G_SIM, clamp } from '../core/units';
import { World } from '../sim/world';
import { makeStar, makePlanet, makeBlackHole, makeNebula, makeBrownDwarf } from '../sim/factory';
import { mainSequenceLuminosity } from '../sim/stellar';
import { planetSuffix } from './names';
import type { Body } from '../sim/types';

/**
 * Génération procédurale reproductible d'un système stellaire depuis une graine.
 * Distribution des masses stellaires : IMF de Kroupa (échantillonnage par morceaux).
 */
export function sampleIMF(rng: Rng): number {
  const u = rng.next();
  // ~ 60 % naines M, rares étoiles massives
  if (u < 0.6) return rng.range(0.08, 0.5);
  if (u < 0.88) return rng.range(0.5, 1.0);
  if (u < 0.97) return rng.range(1.0, 2.5);
  if (u < 0.995) return rng.logRange(2.5, 15);
  return rng.logRange(15, 60);
}

export interface SystemSpec {
  seed: number;
  name?: string;
  starMass?: number;
  starAgeFrac?: number;
  /** Type particulier d'objet central dicté par la galaxie (ex. trou noir). */
  centralKind?: 'star' | 'blackhole' | 'nebula';
}

function orbitAround(b: Body, parent: Body, a: number, e: number, inc: number, rng: Rng): void {
  const M = parent.mass + b.mass;
  const theta = rng.range(0, Math.PI * 2);
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(theta));
  const h = Math.sqrt(G_SIM * M * a * (1 - e * e));
  const vr = (G_SIM * M / h) * e * Math.sin(theta);
  const vt = h / r;
  const node = rng.range(0, Math.PI * 2);
  // position dans le plan orbital puis rotations (nœud, inclinaison)
  const cx = Math.cos(theta), sx = Math.sin(theta);
  let px = r * cx, pz = r * sx, py = 0;
  let vx = vr * cx - vt * sx, vz = vr * sx + vt * cx, vy = 0;
  const ci = Math.cos(inc), si = Math.sin(inc);
  [py, pz] = [py * ci - pz * si, py * si + pz * ci];
  [vy, vz] = [vy * ci - vz * si, vy * si + vz * ci];
  const cn = Math.cos(node), sn = Math.sin(node);
  [px, pz] = [px * cn - pz * sn, px * sn + pz * cn];
  [vx, vz] = [vx * cn - vz * sn, vx * sn + vz * cn];
  b.pos = { x: parent.pos.x + px, y: parent.pos.y + py, z: parent.pos.z + pz };
  b.vel = { x: parent.vel.x + vx, y: parent.vel.y + vy, z: parent.vel.z + vz };
}

/** Peuple un monde avec un système stellaire généré. */
export function generateSystem(world: World, spec: SystemSpec): Body {
  const rng = new Rng(spec.seed);
  world.clear();
  if (spec.centralKind === 'blackhole') {
    const bh = makeBlackHole({ mass: rng.logRange(5, 40), spin: rng.range(0.2, 0.98), seed: rng.nextU32(), name: spec.name, diskMass: 0.02 });
    bh.createdBy = 'gen';
    world.add(bh, true);
    // compagnon stellaire (binaire X)
    if (rng.chance(0.7)) {
      const comp = makeStar({ mass: rng.range(0.5, 12), seed: rng.nextU32() });
      comp.createdBy = 'gen';
      orbitAround(comp, bh, rng.range(0.2, 3), rng.range(0, 0.3), rng.range(0, 0.3), rng);
      world.add(comp, true);
    }
    world.addAccretionMatter(bh.id, 0.01);
    world.events = [];
    return bh;
  }
  if (spec.centralKind === 'nebula') {
    const neb = makeNebula({ mass: rng.logRange(5, 200), density: rng.logRange(3e4, 3e5), temperature: rng.range(8, 30), seed: rng.nextU32(), name: spec.name });
    neb.createdBy = 'gen';
    world.add(neb, true);
    world.events = [];
    return neb;
  }
  const mass = spec.starMass ?? sampleIMF(rng);
  const star = makeStar({ mass, seed: rng.nextU32(), metallicity: rng.logRange(0.002, 0.04), name: spec.name, rotationDays: rng.range(1, 40) });
  star.createdBy = 'gen';
  star.star!.age = clamp(spec.starAgeFrac ?? rng.range(0.05, 0.8), 0, 0.99) * star.star!.msLifetime;
  world.add(star, true);
  world.refreshDerived(star);
  star.star!.age = clamp(spec.starAgeFrac ?? rng.range(0.05, 0.8), 0, 0.99) * star.star!.msLifetime;
  // compagnon binaire éventuel
  if (rng.chance(0.25)) {
    const m2 = Math.max(0.08, mass * rng.range(0.1, 0.8));
    const c = rng.chance(0.1) ? makeBrownDwarf({ mass: 0.05, seed: rng.nextU32() }) : makeStar({ mass: m2, seed: rng.nextU32(), name: `${star.name} B` });
    c.createdBy = 'gen';
    orbitAround(c, star, rng.range(30, 200), rng.range(0, 0.5), rng.range(0, 0.4), rng);
    world.add(c, true);
  }
  const L = mainSequenceLuminosity(mass);
  const snow = 2.7 * Math.sqrt(L);
  const metallicityBoost = clamp(star.star!.metallicity / 0.014, 0.3, 3);
  const n = rng.int(1, Math.round(4 + 4 * Math.min(1, metallicityBoost)));
  let a = rng.range(0.25, 0.5) * Math.sqrt(L) + 0.05;
  for (let i = 0; i < n; i++) {
    const out = a > snow;
    const giant = out && rng.chance(0.55 * Math.min(1.5, metallicityBoost));
    const massEarth = giant ? rng.logRange(10, 1500) : out ? rng.logRange(0.3, 12) : rng.logRange(0.05, 6);
    const pl = makePlanet({
      massEarth,
      gasGiant: giant,
      seed: rng.nextU32(),
      name: `${star.name} ${planetSuffix(i)}`,
      rings: giant && rng.chance(0.45),
      composition: giant
        ? rng.chance(0.4) ? { hydrogen: 0.6, ice: 0.3, rock: 0.07, metal: 0.03 } : undefined
        : out ? { ice: 0.35, rock: 0.45, metal: 0.15, water: 0.05 } : { rock: 0.62, metal: 0.32, water: rng.range(0, 0.1), organic: rng.range(0, 0.02) },
      waterFraction: giant ? 0 : out ? rng.range(0.4, 1) : rng.range(0, 0.9),
      pressure: giant ? 1000 : massEarth < 0.1 ? 0 : rng.logRange(0.01, 90),
      rotationHours: rng.logRange(8, 2000),
      axialTilt: rng.range(0, 40) * (rng.chance(0.08) ? 3 : 1),
      volcanism: rng.range(0, 1),
      magneticField: rng.range(0, 2),
      continents: rng.range(0.1, 0.9),
      greenhouse: rng.range(10, 60),
    });
    pl.createdBy = 'gen';
    orbitAround(pl, star, a, rng.range(0, 0.15), rng.range(0, 0.06), rng);
    world.add(pl, true);
    // lunes
    const nm = giant ? rng.int(1, 5) : massEarth > 0.5 && rng.chance(0.5) ? rng.int(1, 2) : 0;
    let am = (pl.radius / 1.496e8) * rng.range(4, 8);
    for (let k = 0; k < nm; k++) {
      const mm = Math.min(pl.mass * 0.02, rng.logRange(1e-5, 0.03) * M_EARTH_SUN);
      const moon = makePlanet({
        mass: mm, kind: 'moon', gasGiant: false, seed: rng.nextU32(), name: `${pl.name}-${k + 1}`,
        composition: out ? { ice: 0.5, rock: 0.4, metal: 0.1 } : { rock: 0.8, metal: 0.2 },
        waterFraction: out ? 0.7 : 0, pressure: rng.chance(0.15) ? rng.range(0.1, 2) : 0,
      });
      moon.createdBy = 'gen';
      orbitAround(moon, pl, am, rng.range(0, 0.05), rng.range(0, 0.1), rng);
      world.add(moon, true);
      am *= rng.range(1.5, 2.2);
    }
    a *= rng.range(1.4, 2.1);
  }
  // ceinture d'astéroïdes (particules-tests) entre deux planètes
  const beltR = snow * rng.range(0.6, 0.95);
  const nAst = rng.int(1500, 4000);
  for (let i = 0; i < nAst; i++) {
    const r = beltR * rng.range(0.85, 1.15);
    const th = rng.range(0, Math.PI * 2);
    const v = Math.sqrt((G_SIM * mass) / r);
    world.particles.add(Math.cos(th) * r, rng.gauss(0, 0.02 * r), Math.sin(th) * r, -Math.sin(th) * v, 0, Math.cos(th) * v, 1e-12, 0, 200, Infinity);
  }
  world.events = [];
  return star;
}

/** Données réelles approchées du Système solaire (point de départ « Sol »). */
export function generateSolarSystem(world: World): Body {
  world.clear();
  const rng = new Rng(hashCombine(42, 7));
  const sun = makeStar({ mass: 1, name: 'Soleil', seed: 1, metallicity: 0.0134, rotationDays: 25.4 });
  sun.createdBy = 'gen';
  sun.star!.age = 4.6e9;
  world.add(sun, true);
  world.refreshDerived(sun);
  sun.star!.age = 4.6e9;
  const P = (name: string, me: number, a: number, e: number, incDeg: number, opts: Parameters<typeof makePlanet>[0]) => {
    const p = makePlanet({ massEarth: me, name, seed: rng.nextU32(), ...opts });
    p.createdBy = 'gen';
    orbitAround(p, sun, a, e, (incDeg * Math.PI) / 180, rng);
    world.add(p, true);
    return p;
  };
  P('Mercure', 0.055, 0.387, 0.206, 7, { pressure: 0, waterFraction: 0, magneticField: 0.01, rotationHours: 1408, axialTilt: 0.03, composition: { metal: 0.7, rock: 0.3 }, greenhouse: 0, volcanism: 0 });
  P('Vénus', 0.815, 0.723, 0.007, 3.4, { pressure: 92, waterFraction: 0, magneticField: 0, rotationHours: 5832, axialTilt: 177, greenhouse: 33.2, volcanism: 0.6 });
  const earth = P('Terre', 1, 1, 0.0167, 0, { pressure: 1, waterFraction: 0.71, magneticField: 1, rotationHours: 23.93, axialTilt: 23.44, greenhouse: 33, continents: 0.55, volcanism: 0.3, composition: { rock: 0.62, metal: 0.32, water: 0.03, organic: 0.01 } });
  earth.planet!.life = 3;
  earth.planet!.lifeTimer = 3.8e9;
  earth.planet!.albedo = 0.3;
  const moon = makePlanet({ massEarth: 0.0123, kind: 'moon', name: 'Lune', seed: 3, pressure: 0, waterFraction: 0, magneticField: 0, greenhouse: 0, composition: { rock: 0.9, metal: 0.1 } });
  moon.createdBy = 'gen';
  orbitAround(moon, earth, 0.00257, 0.055, 0.09, rng);
  world.add(moon, true);
  P('Mars', 0.107, 1.524, 0.093, 1.85, { pressure: 0.006, waterFraction: 0.02, magneticField: 0.01, rotationHours: 24.6, axialTilt: 25.2, greenhouse: 8, volcanism: 0.1, continents: 0.8 });
  const jup = P('Jupiter', 317.8, 5.203, 0.048, 1.3, { gasGiant: true, rotationHours: 9.9, axialTilt: 3.1 });
  const sat = P('Saturne', 95.2, 9.537, 0.054, 2.5, { gasGiant: true, rotationHours: 10.7, axialTilt: 26.7, rings: true });
  sat.planet!.ringInner = 1.24; sat.planet!.ringOuter = 2.27;
  const ura = P('Uranus', 14.5, 19.19, 0.047, 0.8, { gasGiant: true, rotationHours: 17.2, axialTilt: 97.8, composition: { hydrogen: 0.3, ice: 0.6, rock: 0.1 }, rings: true });
  ura.planet!.ringInner = 1.6; ura.planet!.ringOuter = 2.0;
  P('Neptune', 17.1, 30.07, 0.009, 1.8, { gasGiant: true, rotationHours: 16.1, axialTilt: 28.3, composition: { hydrogen: 0.3, ice: 0.6, rock: 0.1 } });
  const galileans: [string, number, number][] = [['Io', 0.015, 0.00282], ['Europe', 0.008, 0.00449], ['Ganymède', 0.025, 0.00716], ['Callisto', 0.018, 0.0126]];
  for (const [n, me, a] of galileans) {
    const m = makePlanet({ massEarth: me, kind: 'moon', name: n, seed: rng.nextU32(), pressure: 0, waterFraction: n === 'Io' ? 0 : 0.9, volcanism: n === 'Io' ? 1 : 0, composition: n === 'Io' ? { rock: 0.8, metal: 0.2 } : { ice: 0.5, rock: 0.4, metal: 0.1 } });
    m.createdBy = 'gen';
    orbitAround(m, jup, a, 0.004, 0.01, rng);
    world.add(m, true);
  }
  const titan = makePlanet({ massEarth: 0.0225, kind: 'moon', name: 'Titan', seed: rng.nextU32(), pressure: 1.45, waterFraction: 0.5, composition: { ice: 0.5, rock: 0.45, organic: 0.05 }, greenhouse: 12 });
  titan.createdBy = 'gen';
  orbitAround(titan, sat, 0.00817, 0.029, 0.005, rng);
  world.add(titan, true);
  // ceinture principale + quelques comètes
  for (let i = 0; i < 3000; i++) {
    const r = rng.range(2.1, 3.3);
    const th = rng.range(0, Math.PI * 2);
    const v = Math.sqrt(G_SIM / r) * rng.range(0.98, 1.02);
    world.particles.add(Math.cos(th) * r, rng.gauss(0, 0.05) * r, Math.sin(th) * r, -Math.sin(th) * v, 0, Math.cos(th) * v, 1e-12, 0, 200, Infinity);
  }
  const halley = makePlanet({ massEarth: 3.7e-11 * 1e3, kind: 'comet', name: 'Comète de Halley', seed: 99, composition: { ice: 0.7, rock: 0.3 } });
  halley.createdBy = 'gen';
  orbitAround(halley, sun, 17.8, 0.967, (162 * Math.PI) / 180, rng);
  world.add(halley, true);
  world.events = [];
  return sun;
}
