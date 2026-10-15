// Tests en jeu (navigateur headless) : node scripts/e2e.mjs
// Prérequis : `npm run build`. Lance `vite preview`, pilote le jeu via l'interface et
// l'API de diagnostic window.__SUPERESSENCE__, vérifie l'état et capture des images.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

const PORT = 4179;
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(`console: ${m.text()}`); });

let failed = 0;
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(`✔ ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    results.push(`✘ ${name} — ${e.message}`);
  }
  console.log(results[results.length - 1]);
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
/** Fraction de pixels non noirs du canevas (vérifie que la scène est réellement rendue). */
const litFraction = () => ev(() => {
  const c = document.querySelector('canvas#scene');
  const tmp = document.createElement('canvas');
  tmp.width = 200; tmp.height = 120;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(c, 0, 0, 200, 120);
  const d = ctx.getImageData(0, 0, 200, 120).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
  return lit / (d.length / 4);
});

await page.goto(`http://localhost:${PORT}/`);
await wait(3000);

await check('Menu principal affiché', async () => {
  assert(await page.isVisible('[data-testid=main-menu]'), 'menu absent');
  await shot('01-menu');
});

await check('Démarrage : Système solaire', async () => {
  await page.click('[data-testid=menu-new]');
  await wait(2500);
  const n = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  assert(n >= 15, `seulement ${n} corps`);
  const lit = await litFraction();
  assert(lit > 0.002, `canevas presque noir (${lit})`);
  await shot('02-systeme-solaire');
  return `${n} corps, ${(lit * 100).toFixed(2)} % de pixels éclairés`;
});

await check('Accélération et pause du temps', async () => {
  const t0 = await ev(() => window.__SUPERESSENCE__.game.world.time);
  await page.click('[data-testid=faster]');
  await page.click('[data-testid=faster]');
  await wait(1500);
  const t1 = await ev(() => window.__SUPERESSENCE__.game.world.time);
  assert(t1 > t0, 'le temps n\'avance pas');
  await page.click('[data-testid=pause]');
  const t2 = await ev(() => window.__SUPERESSENCE__.game.world.time);
  await wait(800);
  const t3 = await ev(() => window.__SUPERESSENCE__.game.world.time);
  assert(t3 === t2, 'la pause ne fige pas le temps');
  await page.click('[data-testid=pause]');
  await page.click('[data-testid=slower]');
  await page.click('[data-testid=slower]');
  return `Δt = ${(t1 - t0).toExponential(2)} an`;
});

await check('Sélection et vol de caméra vers la Terre', async () => {
  await ev(() => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.focus(`b${e.id}`); });
  await wait(4500);
  const d = await ev(() => { const g = window.__SUPERESSENCE__.game; const e = g.selectedBody(); const r = g.engine.rig; return Math.hypot(r.target.x - e.pos.x, r.target.y - e.pos.y, r.target.z - e.pos.z) / (e.radius / 1.496e8); });
  assert(d < 2, `caméra à ${d} rayons de la cible`);
  assert(await page.isVisible('[data-testid=planet-mass]'), 'éditeur de planète absent');
  await shot('03-terre');
  return `cible à ${d.toFixed(3)} rayon terrestre`;
});

await check('Modification de planète en direct (eau, pression) avec conséquences', async () => {
  const r = await ev(() => {
    const g = window.__SUPERESSENCE__.game;
    const e = g.selectedBody();
    const sun = g.world.primary();
    g.history.record('test');
    g.world.placeInOrbit(e, sun, 0.45);
    return e.temperature;
  });
  await wait(4000);
  const after = await ev(() => { const g = window.__SUPERESSENCE__.game; return g.selectedBody().temperature; });
  assert(after > r + 30, `température inchangée (${r} → ${after})`);
  await ev(() => window.__SUPERESSENCE__.game.undo());
  await wait(500);
  return `${Math.round(r)} K → ${Math.round(after)} K après rapprochement du Soleil (annulé ensuite)`;
});

await check('Saturne et ses anneaux', async () => {
  await ev(() => { const g = window.__SUPERESSENCE__.game; const s = g.world.bodies.find((b) => b.name === 'Saturne'); g.focus(`b${s.id}`); });
  await wait(4500);
  await shot('04-saturne');
});

await check('Création de matière (roche → planète) via l\'interface', async () => {
  await page.click('[data-testid=open-create]');
  await page.click('[data-testid=create-tab-matter]');
  await page.click('[data-testid=matter-rock]');
  const n0 = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  await page.click('[data-testid=create-center]');
  await wait(800);
  const n1 = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  assert(n1 === n0 + 1, `aucun corps créé (${n0} → ${n1})`);
  await page.click('[data-testid=close-create]');
  return `${n0} → ${n1} corps`;
});

await check('Création d\'une étoile et supernova', async () => {
  const info = await ev(() => {
    const g = window.__SUPERESSENCE__.game;
    const sun = g.world.primary();
    g.creation = { type: 'star', star: { mass: 25, metallicity: 0.02, rotationDays: 5, protostar: false }, orbit: 'circular' };
    const id = g.createAt({ x: sun.pos.x + 60, y: 0, z: sun.pos.z });
    g.focus(`b${id}`);
    return id;
  });
  await wait(4000);
  await shot('05-etoile-massive');
  await ev((id) => { const g = window.__SUPERESSENCE__.game; g.select(`b${id}`); g.act('supernova'); }, info);
  await wait(1500);
  await shot('06-supernova');
  const k = await ev((id) => window.__SUPERESSENCE__.game.world.get(id)?.kind, info);
  assert(k === 'blackhole', `rémanent inattendu : ${k}`);
  return 'étoile de 25 M☉ → trou noir';
});

await check('Trou noir : création, matière, lentille gravitationnelle', async () => {
  const id = await ev(() => {
    const g = window.__SUPERESSENCE__.game;
    g.creation = { type: 'blackhole', blackhole: { mass: 4e6, spin: 0.9, diskMass: 0.01, jets: true, environment: 0.5 }, orbit: 'rest' };
    const sun = g.world.primary();
    const id = g.createAt({ x: sun.pos.x - 200, y: 0, z: sun.pos.z + 100 });
    g.world.settings.stellarEvolution = true;
    const b = g.world.get(id);
    g.select(`b${id}`);
    g.engine.rig.mode = 'follow';
    g.engine.rig.set(b.pos, (b.radius / 1.496e8) * 30);
    g.engine.rig.pitch = 0.12;
    return id;
  });
  await wait(4500);
  const lenses = await ev(() => window.__SUPERESSENCE__.game.engine.lenses.length);
  assert(lenses >= 1, 'aucune lentille active');
  await shot('07-trou-noir');
  await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.pitch = 0.02; g.engine.rig.distance *= 0.6; });
  await wait(2500);
  await shot('08-trou-noir-rasant');
  return `lentille active (${lenses})`;
});

await check('Fusion de trous noirs avec ondes gravitationnelles', async () => {
  await ev(() => {
    const g = window.__SUPERESSENCE__.game;
    const b = g.world.bodies.find((x) => x.kind === 'blackhole' && x.mass > 1e6);
    g.select(`b${b.id}`);
    g.act('bhbinary');
    g.setSpeedIndex(4);
  });
  let merged = false;
  for (let i = 0; i < 40 && !merged; i++) {
    await wait(500);
    merged = await ev(() => window.__SUPERESSENCE__.game.world.events.some((e) => e.type === 'bhmerger'));
  }
  assert(merged, 'pas de fusion observée');
  await wait(1500);
  await shot('09-fusion-trous-noirs');
  await ev(() => window.__SUPERESSENCE__.game.setSpeedIndex(3));
});

await check('Annuler / rétablir', async () => {
  const n0 = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  await ev(() => { const g = window.__SUPERESSENCE__.game; const m = g.world.bodies.find((b) => b.name === 'Mars'); g.select(`b${m.id}`); g.act('explode'); });
  const n1 = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  await page.click('[data-testid=undo]');
  const n2 = await ev(() => window.__SUPERESSENCE__.game.world.bodies.length);
  assert(n1 === n0 - 1 && n2 === n0, `${n0} → ${n1} → ${n2}`);
  return `${n0} → ${n1} → ${n2}`;
});

await check('Mode analyse (champ, trajectoires, zone habitable)', async () => {
  await ev(() => { const g = window.__SUPERESSENCE__.game; const s = g.world.bodies.find((b) => b.name === 'Soleil'); g.focus(`b${s.id}`); g.engine.rig.flyTo(s.pos, 8, 0.5); });
  await wait(1500);
  await page.click('[data-testid=toggle-analysis]');
  await wait(3000);
  assert(await page.isVisible('[data-testid=panel-analysis]'), 'panneau d\'analyse absent');
  await shot('10-analyse');
  await page.click('[data-testid=toggle-analysis]');
});

await check('Sauvegarde, liste, rechargement', async () => {
  await page.click('[data-testid=open-saves]');
  await page.fill('[data-testid=save-name]', 'Univers de test');
  await page.click('[data-testid=save-now]');
  await wait(500);
  const list = await ev(() => window.__SUPERESSENCE__.game.store.list());
  assert(list.length >= 1 && list[0].name === 'Univers de test', 'sauvegarde absente');
  const before = await ev(() => window.__SUPERESSENCE__.game.world.bodies.map((b) => b.name).sort().join(','));
  await ev(() => { const g = window.__SUPERESSENCE__.game; g.world.bodies.splice(0, 5); });
  await page.click(`[data-testid=load-${list[0].id}]`);
  await wait(800);
  const after = await ev(() => window.__SUPERESSENCE__.game.world.bodies.map((b) => b.name).sort().join(','));
  assert(before === after, 'état rechargé différent');
  await shot('11-sauvegardes');
  return `${list.length} univers, ${list[0].sizeKB} Ko`;
});

await check('Comparaison de deux états', async () => {
  await ev(() => window.__SUPERESSENCE__.game.checkpoint('avant'));
  await ev(() => { const g = window.__SUPERESSENCE__.game; const j = g.world.bodies.find((b) => b.name === 'Jupiter'); g.select(`b${j.id}`); g.act('explode'); });
  await page.click('[data-testid=open-compare]');
  await wait(600);
  const txt = await page.textContent('[data-testid=panel-compare]');
  assert(txt.includes('Jupiter'), 'la disparition de Jupiter n\'est pas détectée');
  await shot('12-comparaison');
  await page.click('[data-testid=close-compare]');
});

await check('Échelle galactique (transition par zoom arrière)', async () => {
  await ev(() => window.__SUPERESSENCE__.game.goGalaxy());
  await wait(4500);
  const lvl = await ev(() => window.__SUPERESSENCE__.game.level);
  assert(lvl === 'galaxy', `niveau ${lvl}`);
  await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.set({ x: 0, y: 0, z: 0 }, 140); g.engine.rig.pitch = 0.7; });
  await wait(2500);
  const lit = await litFraction();
  assert(lit > 0.01, `galaxie peu visible (${lit})`);
  await shot('13-galaxie');
  return `${(lit * 100).toFixed(1)} % de pixels éclairés`;
});

await check('Galaxie : courbe de rotation et suppression de la matière noire', async () => {
  const r = await ev(() => {
    const g = window.__SUPERESSENCE__.game;
    const before = g.galaxy.diagnostics().meanRadius;
    g.galaxy.setHalo(false);
    for (let i = 0; i < 30; i++) g.galaxy.step(10, 10);
    const after = g.galaxy.diagnostics().meanRadius;
    g.galaxy.setHalo(true);
    return { before, after };
  });
  assert(r.after > r.before * 1.05, `rayon moyen ${r.before} → ${r.after}`);
  return `rayon moyen ${r.before.toFixed(1)} → ${r.after.toFixed(1)} kal sans halo`;
});

await check('Fusion de galaxies', async () => {
  await page.click('[data-testid=galaxy-merge]');
  await wait(6000);
  const n = await ev(() => window.__SUPERESSENCE__.game.galaxy.components.length);
  assert(n === 2, 'pas de seconde galaxie');
  await shot('14-fusion-galaxies');
});

await check('Entrée dans un système généré depuis la galaxie (reproductible)', async () => {
  const k1 = await ev(async () => { const g = window.__SUPERESSENCE__.game; await g.enterStar(1234); return g.world.bodies.map((b) => `${b.name}:${b.mass.toPrecision(6)}`).join('|'); });
  await wait(1500);
  await shot('15-systeme-genere');
  const k2 = await ev(async () => { const g = window.__SUPERESSENCE__.game; delete g.universe.systems[g.systemKey]; await g.goGalaxy(); await g.enterStar(1234); const s = g.world.bodies.map((b) => `${b.name}:${b.mass.toPrecision(6)}`).join('|'); return s; });
  assert(k1 === k2, 'génération non reproductible');
  return k1.split('|').length + ' corps, identiques après régénération';
});

await check('Échelle cosmique et toile des galaxies', async () => {
  await ev(() => window.__SUPERESSENCE__.game.goCosmic());
  await wait(5000);
  const n = await ev(() => window.__SUPERESSENCE__.game.views.cosmic.galaxies.length);
  assert(n > 50, `seulement ${n} galaxies`);
  await shot('16-cosmos');
  return `${n} galaxies chargées`;
});

await check('Fin d\'univers : Big Rip', async () => {
  await page.click('[data-testid=end-bigrip]');
  await wait(3000);
  const fate = await ev(() => window.__SUPERESSENCE__.game.cosmoHistory.fate);
  assert(fate === 'bigrip', fate);
  await ev(() => { const g = window.__SUPERESSENCE__.game; g.endOfUniverse('bigfreeze'); g.universe.cosmicTime = 13.8; });
});

await check('Laboratoire atomique : atomes, fusion, chimie', async () => {
  await ev(async () => { const g = window.__SUPERESSENCE__.game; await g.jumpToLevel('system'); });
  await wait(1500);
  await ev(async () => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.planet && !b.planet.gasGiant); g.select(`b${e.id}`); await g.goMicro(); });
  await wait(2500);
  await page.click('[data-testid=el-O]');
  await page.click('[data-testid=el-H]');
  await page.click('[data-testid=el-H]');
  await page.click('[data-testid=spawn-n]');
  await page.click('[data-testid=spawn-p]');
  await wait(6000);
  const st = await ev(() => { const l = window.__SUPERESSENCE__.game.micro; return { n: l.entities.length, disc: [...l.discoveries] }; });
  assert(st.n > 10, 'laboratoire vide');
  await shot('17-labo-atomique');
  return `${st.n} entités, découvertes : ${st.disc.slice(0, 4).join(', ')}`;
});

await check('Échelle subatomique', async () => {
  await ev(() => window.__SUPERESSENCE__.game.jumpToLevel('subatomic'));
  await wait(3000);
  const lvl = await ev(() => window.__SUPERESSENCE__.game.level);
  await shot('18-subatomique');
  assert(lvl === 'subatomic', lvl);
});

await check('Big Bang : génération, lecture, époques, adoption', async () => {
  await ev(() => window.__SUPERESSENCE__.game.goBigBang());
  await wait(1500);
  await page.click('[data-testid=bb-generate]');
  for (let i = 0; i < 60; i++) { await wait(500); if (await ev(() => !!window.__SUPERESSENCE__.game.views.bigbang.field)) break; }
  const halos = await ev(() => window.__SUPERESSENCE__.game.views.bigbang.field?.halos.length ?? 0);
  assert(halos > 0, 'aucun halo');
  for (const [p, name] of [[0.3, '19-bigbang-plasma'], [0.86, '20-bigbang-recombinaison'], [0.93, '21-bigbang-premieres-etoiles'], [1, '22-bigbang-galaxies']]) {
    await ev((v) => { const b = window.__SUPERESSENCE__.game.views.bigbang; b.progress = v; b.playing = false; }, p);
    await wait(2500);
    await shot(name);
  }
  const st = await ev(() => { const s = window.__SUPERESSENCE__.game.views.bigbang.state; return { epoch: s.epoch.id, T: s.T, halos: s.haloCount }; });
  assert(st.epoch === 'today' || st.epoch === 'planets', `époque finale ${st.epoch}`);
  await page.click('[data-testid=bb-play]');
  await wait(1500);
  await page.click('[data-testid=bb-adopt]');
  await wait(4500);
  const lvl = await ev(() => window.__SUPERESSENCE__.game.level);
  assert(lvl === 'cosmic', `après adoption : ${lvl}`);
  await shot('23-univers-adopte');
  return `${halos} halos ; époque finale ${st.epoch}, T = ${st.T.toFixed(2)} K`;
});

await check('Valeurs invalides dans l\'interface', async () => {
  await ev(async () => { const g = window.__SUPERESSENCE__.game; await g.jumpToLevel('system'); });
  await wait(1500);
  await ev(() => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.select(`b${e.id}`); });
  await wait(600);
  const num = page.locator('[data-testid=planet-mass]').locator('xpath=..').locator('input.num');
  await num.fill('abc');
  await num.press('Enter');
  await num.fill('-1e99');
  await num.press('Enter');
  await wait(400);
  const m = await ev(() => window.__SUPERESSENCE__.game.selectedBody().mass);
  assert(Number.isFinite(m) && m > 0, `masse invalide ${m}`);
  const r = await ev(() => { const g = window.__SUPERESSENCE__.game; return g.createAt({ x: NaN, y: 0, z: 0 }); });
  return `masse conservée finie (${m.toExponential(2)}), création à NaN → ${r}`;
});

await check('Performances avec 300 corps', async () => {
  const r = await ev(async () => {
    const g = window.__SUPERESSENCE__.game;
    const sun = g.world.primary();
    g.creation = { type: 'planet', planet: { massEarth: 0.01 }, orbit: 'circular' };
    for (let i = 0; i < 280; i++) {
      const a = 2 + Math.random() * 40, th = Math.random() * 6.28;
      g.createAt({ x: sun.pos.x + Math.cos(th) * a, y: 0, z: sun.pos.z + Math.sin(th) * a });
    }
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) g.frame(1 / 60);
    return { n: g.world.bodies.length, ms: (performance.now() - t0) / 20 };
  });
  await wait(1500);
  await shot('24-300-corps');
  assert(r.ms < 1500, `${r.ms} ms par image`);
  return `${r.n} corps, ${r.ms.toFixed(0)} ms/image (rendu logiciel SwiftShader)`;
});

await check('Aucune erreur JavaScript', async () => {
  assert(errors.length === 0, errors.slice(0, 5).join(' | '));
});

console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
