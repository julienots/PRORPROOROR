import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
await page.goto('http://localhost:4173/?autostart&quality=performance');
await page.waitForTimeout(3000);
// atterrir sur Mars (pas d'océan) puis sur la Terre au-dessus d'un continent
await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; g.paused = true; document.body.classList.add('hide-ui'); const e = g.world.bodies.find((b) => b.name === 'Mars'); g.select('b' + e.id); g.engine.rig.set(e.pos, e.radius / 1.496e8 * 3); g.ow.land(e.id); g.engine.rig.distance = 0.4 / 1.496e8; g.engine.rig.pitch = 0.12; });
await page.waitForTimeout(9000);
await page.screenshot({ path: 'test-results/ow-mars-sol.png' });
await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.ow.leaveSurface(); g.select('b' + e.id); g.engine.rig.set(e.pos, e.radius / 1.496e8 * 3); g.ow.land(e.id); g.engine.rig.distance = 1.5 / 1.496e8; g.engine.rig.pitch = 0.1; });
await page.waitForTimeout(9000);
await page.screenshot({ path: 'test-results/ow-terre-sol.png' });
await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; g.engine.rig.distance = 120 / 1.496e8; g.engine.rig.pitch = 0.3; });
await page.waitForTimeout(9000);
await page.screenshot({ path: 'test-results/ow-terre-120km.png' });
await browser.close();
