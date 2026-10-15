import { describe, it, expect } from 'vitest';
import { MicroLab } from '../src/sim/micro';
import { World } from '../src/sim/world';
import { History } from '../src/sim/history';
import { generateSolarSystem } from '../src/procgen/starsystem';
import { makeStar, makeBlackHole } from '../src/sim/factory';
import { SaveStore, MemoryBackend } from '../src/save/storage';
import { emptyUniverse, snapshotWorld, restoreWorld, validateUniverse, validateBody } from '../src/save/serialize';

function runLab(lab: MicroLab, seconds: number) {
  for (let t = 0; t < seconds; t += 0.05) lab.step(0.05);
}

describe('Laboratoire atomique', () => {
  it('proton + neutron → deutérium (capture sans barrière)', () => {
    const lab = new MicroLab(1);
    const p = lab.spawnParticle('p', [0, 0, 0]);
    const n = lab.spawnParticle('n', [3, 0, 0]);
    p.vx = p.vy = p.vz = 0; n.vx = n.vy = n.vz = 0;
    lab.temperature = 10;
    lab.step(0.01);
    const d = lab.entities.find((e) => e.kind === 'cluster');
    expect(d).toBeDefined();
    expect(MicroLab.describe(d!)).toContain('Deutérium');
  });
  it('p + p ne fusionnent qu\'au-delà de ~10⁷ K', () => {
    const cold = new MicroLab(2);
    const a = cold.spawnParticle('p', [0, 0, 0]), b = cold.spawnParticle('p', [2, 0, 0]);
    a.vx = b.vx = 0;
    cold.temperature = 1e4;
    cold.step(0.01);
    expect(cold.entities.filter((e) => e.kind === 'cluster').length).toBe(0);
    expect(MicroLab.fusionThreshold(1, 1)).toBe(1e7);
    expect(MicroLab.fusionThreshold(2, 2)).toBeGreaterThan(MicroLab.fusionThreshold(1, 1));
  });
  it('recombinaison : noyau d\'hydrogène + électron → atome neutre à basse température', () => {
    const lab = new MicroLab(3);
    lab.temperature = 300;
    const h = lab.spawnAtom(1, true, [0, 0, 0])!;
    const e = lab.spawnParticle('e', [5, 0, 0]);
    h.vx = h.vy = h.vz = 0; e.vx = e.vy = e.vz = 0;
    lab.step(0.01);
    expect(MicroLab.charge(h)).toBe(0);
    expect(lab.discoveries.has('Atome : Hydrogène')).toBe(true);
  });
  it('ionisation à haute température', () => {
    const lab = new MicroLab(4);
    lab.temperature = 1e6;
    lab.spawnAtom(1, false, [0, 0, 0]);
    runLab(lab, 3);
    expect(lab.entities.some((e) => e.kind === 'e')).toBe(true);
  });
  it('chimie : formation d\'eau (H₂O) à partir de O et 2 H', () => {
    let formed = false;
    for (let seed = 1; seed <= 5 && !formed; seed++) {
      const lab = new MicroLab(seed);
      lab.temperature = 300;
      for (let i = 0; i < 6; i++) lab.spawnAtom(8, false, [i * 40 - 100, 0, 0]);
      for (let i = 0; i < 14; i++) lab.spawnAtom(1, false, [i * 15 - 100, 10, 0]);
      runLab(lab, 30);
      formed = [...lab.census().keys()].some((k) => k.includes('H2O'));
    }
    expect(formed).toBe(true);
  });
  it('liaison multiple : O₂ est une double liaison', () => {
    const lab = new MicroLab(5);
    lab.temperature = 300;
    const a = lab.spawnAtom(8, false, [0, 0, 0])!, b = lab.spawnAtom(8, false, [10, 0, 0])!;
    a.vx = a.vy = a.vz = 0; b.vx = b.vy = b.vz = 0;
    for (let i = 0; i < 20 && lab.entities.filter((e) => e.kind === 'cluster').length > 1; i++) lab.step(0.01);
    const mol = lab.entities.find((e) => e.atoms && e.atoms.length === 2)!;
    expect(mol).toBeDefined();
    expect(mol.bonds![0][2]).toBe(2);
    expect(MicroLab.describe(mol)).toContain('Dioxygène');
  });
  it('neutron libre : désintégration β⁻', () => {
    const lab = new MicroLab(6);
    lab.spawnParticle('n', [0, 0, 0]).decay = 0.01;
    lab.temperature = 1e6; // assez chaud pour que p et e⁻ ne se recombinent pas aussitôt
    lab.step(0.05);
    expect(lab.events.some((e) => e.kind === 'decay')).toBe(true);
    expect(lab.entities.some((e) => e.kind === 'p')).toBe(true);
    expect(lab.entities.some((e) => e.kind === 'e')).toBe(true);
    expect(lab.entities.some((e) => e.kind === 'n')).toBe(false);
  });
});

describe('Historique (annuler/rétablir)', () => {
  it('annule une supernova et la rétablit', () => {
    const w = new World();
    const h = new History(w);
    const s = w.add(makeStar({ mass: 15 }), true);
    h.record('Supernova');
    w.forceSupernova(s.id);
    expect(w.get(s.id)!.kind).toBe('neutronstar');
    expect(h.undo()).toBe('Supernova');
    expect(w.get(s.id)!.kind).toBe('star');
    expect(h.redo()).toBe('Supernova');
    expect(w.get(s.id)!.kind).toBe('neutronstar');
  });
});

describe('Sauvegardes', () => {
  it('aller-retour complet avec conservation des corps', () => {
    const store = new SaveStore(new MemoryBackend());
    const w = new World();
    generateSolarSystem(w);
    w.add(makeBlackHole({ mass: 12, spin: 0.9, pos: { x: 50, y: 0, z: 0 } }), true);
    for (let i = 0; i < 10; i++) w.step(0.1);
    const u = emptyUniverse('Test', 42, w);
    store.save(u, 'v1');
    const loaded = store.load(u.id);
    const w2 = new World();
    restoreWorld(w2, loaded.current);
    expect(w2.bodies.length).toBe(w.bodies.length);
    expect(w2.time).toBeCloseTo(w.time, 9);
    const bh = w2.bodies.find((b) => b.kind === 'blackhole')!;
    expect(bh.bh!.spin).toBeCloseTo(0.9, 6);
    const earth = w2.bodies.find((b) => b.name === 'Terre')!;
    const e0 = w.bodies.find((b) => b.name === 'Terre')!;
    expect(earth.pos.x).toBeCloseTo(e0.pos.x, 9);
    expect(earth.planet!.life).toBe(3);
    // la simulation reprend identiquement
    w.step(0.5); w2.step(0.5);
    expect(earth.pos.x).toBeCloseTo(w.bodies.find((b) => b.name === 'Terre')!.pos.x, 6);
  });
  it('versions, duplication, suppression', () => {
    const store = new SaveStore(new MemoryBackend());
    const w = new World();
    generateSolarSystem(w);
    const u = emptyUniverse('Alpha', 1, w);
    store.save(u, 'v1');
    w.step(1);
    u.current = snapshotWorld(w);
    store.save(u, 'v2');
    expect(store.versions(u.id).length).toBe(2);
    expect(store.load(u.id, 0).current.time).toBe(0);
    expect(store.load(u.id).current.time).toBeGreaterThan(0);
    const copy = store.duplicate(u.id, 'Alpha bis');
    expect(store.list().length).toBe(2);
    expect(copy.id).not.toBe(u.id);
    store.delete(u.id);
    expect(store.list().map((e) => e.name)).toEqual(['Alpha bis']);
  });
  it('rejette ou corrige les données invalides', () => {
    const store = new SaveStore(new MemoryBackend());
    expect(() => store.importJSON('pas du json')).toThrow();
    expect(() => store.importJSON('{"format":"autre"}')).toThrow();
    expect(validateBody({ kind: 'planet', mass: NaN })).toBeNull();
    expect(validateBody({ kind: 'licorne', mass: 1 })).toBeNull();
    const w = new World();
    const u = emptyUniverse('X', 1, w);
    const raw = JSON.parse(JSON.stringify(u));
    raw.current.bodies = [
      { kind: 'blackhole', mass: 5, pos: { x: 'a', y: 1, z: 2 }, vel: {}, bh: { spin: 99 } },
      { kind: 'star', mass: 1 }, // sans état stellaire : rejetée
      null,
    ];
    raw.cosmology.H0 = -5;
    const v = validateUniverse(raw);
    expect(v.current.bodies.length).toBe(1);
    expect(v.current.bodies[0].pos.x).toBe(0);
    expect(v.current.bodies[0].bh!.spin).toBeLessThanOrEqual(0.998);
    expect(v.cosmology.H0).toBeGreaterThanOrEqual(10);
    const imported = store.importJSON(JSON.stringify(raw));
    expect(store.load(imported.id).name).toBe('X');
  });
});
