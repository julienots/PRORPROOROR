import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 780 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:4173/?autostart&quality=performance');
await page.waitForTimeout(3000);
const ev = (f) => page.evaluate(f);
await ev(() => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.select('b' + e.id); g.engine.rig.set(e.pos, e.radius / 1.496e8 * 3); g.ow.land(e.id); g.engine.rig.distance = 3 / 1.496e8; g.engine.rig.pitch = 0.12; });
await page.waitForTimeout(10000);
await page.screenshot({ path: 'test-results/ow-01-sol.png' });
await ev(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.distance = 40 / 1.496e8; g.engine.rig.pitch = 0.35; g.engine.rig.yaw = 1.2; });
await page.waitForTimeout(8000);
await page.screenshot({ path: 'test-results/ow-02-altitude.png' });
// pilote automatique complet depuis le système
await ev(() => { const g = window.__SUPERESSENCE__.game; g.ow.leaveSurface(); const sv = g.views.system; const nb = sv.galSky.neighbors[0]; window.__nb = nb.idx; g.focus('n' + nb.idx); });
let s;
for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); s = await ev(() => { const g = window.__SUPERESSENCE__.game; return { level: g.level, key: g.systemKey }; }); if (s.level === 'system' && s.key !== 'sol') break; }
console.log('arrivée', JSON.stringify(s), await ev(() => window.__nb));
await page.waitForTimeout(6000);
await page.screenshot({ path: 'test-results/ow-04-nouveau-systeme.png' });
console.log('erreurs', errs);
await browser.close();
