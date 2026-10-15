// Vérification visuelle rapide du monde ouvert : node scripts/ow-check.mjs <port>
import { chromium } from 'playwright-core';
const port = process.argv[2] ?? '4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 780 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load')) errs.push(m.text()); });
await page.goto(`http://localhost:${port}/?autostart&quality=performance`);
await page.waitForTimeout(3000);
const ev = (f, a) => page.evaluate(f, a);
const st = () => ev(() => { const g = window.__SUPERESSENCE__.game; return { level: g.level, key: g.systemKey, mode: g.engine.rig.mode, surf: !!g.surface, hud: g.ow.hud }; });
// 1. atterrissage sur la Terre
await ev(() => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.select('b' + e.id); g.engine.rig.set(e.pos, e.radius / 1.496e8 * 3); g.ow.land(e.id); g.engine.rig.distance = 2 / 1.496e8; g.engine.rig.pitch = -0.05; });
await page.waitForTimeout(9000);
console.log('sol', JSON.stringify(await st()));
await page.screenshot({ path: 'test-results/ow-01-sol.png' });
await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.distance = 300 / 1.496e8; g.engine.rig.pitch = 0.5; });
await page.waitForTimeout(7000);
await page.screenshot({ path: 'test-results/ow-02-altitude.png' });
// 2. décoller, vol libre hors du système
await ev(() => { const g = window.__SUPERESSENCE__.game; g.ow.leaveSurface(); const s = g.world.primary(); g.engine.rig.mode = 'free'; g.engine.rig.setForward({ x: 1, y: -0.05, z: 0.2 }); g.engine.rig.setEye({ x: s.pos.x - 3.3e5, y: s.pos.y + 2e4, z: s.pos.z }); });
await page.waitForTimeout(2500);
console.log('sortie', JSON.stringify(await st()));
await page.screenshot({ path: 'test-results/ow-03-sortie-systeme.png' });
// 3. pilote automatique vers une étoile voisine
await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.mode = 'orbit'; const gv = g.views.galaxy; const sol = gv.starPosition(g.solIndex); let best = -1, bd = 1e9; for (let i = 0; i < gv.sim.n; i++) { if (i === g.solIndex) continue; const d = Math.hypot(gv.sim.pos[i*3]-sol.x, gv.sim.pos[i*3+1]-sol.y, gv.sim.pos[i*3+2]-sol.z); if (d < bd) { bd = d; best = i; } } window.__target = best; g.ow.travelToStar(best); });
for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); const s = await st(); if (s.level === 'system') break; }
console.log('arrivee', JSON.stringify(await st()), await ev(() => window.__target));
await page.waitForTimeout(5000);
await page.screenshot({ path: 'test-results/ow-04-nouveau-systeme.png' });
// 4. vol libre vers le cosmos
await ev(() => { const g = window.__SUPERESSENCE__.game; void g.goGalaxy(); });
await page.waitForTimeout(3000);
await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.mode = 'free'; g.engine.rig.setEye({ x: 0, y: 900, z: 0 }); g.engine.rig.setForward({ x: 0, y: -1, z: 0.01 }); });
await page.waitForTimeout(2500);
console.log('cosmos', JSON.stringify(await st()));
await page.screenshot({ path: 'test-results/ow-05-cosmos.png' });
// 5. retour dans la galaxie en volant vers elle
await ev(() => { const g = window.__SUPERESSENCE__.game; const r = g.engine.rig; r.mode = 'orbit'; g.ow.travelToGalaxy('home'); });
for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); const s = await st(); if (s.level === 'galaxy') break; }
await page.waitForTimeout(4000);
console.log('retour', JSON.stringify(await st()));
await page.screenshot({ path: 'test-results/ow-06-retour-galaxie.png' });
console.log('erreurs:', errs.slice(0, 5));
await browser.close();
