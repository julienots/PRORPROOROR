import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:4173/?autostart&quality=performance');
await page.waitForTimeout(3000);
await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; const nb = g.views.system.galSky.neighbors[0]; window.__nb = nb; g.focus('n' + nb.idx); });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2000);
  console.log(JSON.stringify(await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; const r = g.engine.rig; const gv = g.views.galaxy; const n = gv.nearestStar(r.eye); const t = gv.starPosition(window.__nb.idx); return { lvl: g.level, fly: r.isFlying(), ap: g.ow.autopilot, sup: g.ow['suppressEnter'], dist: r.distance, n, dT: Math.hypot(r.eye.x - t.x, r.eye.y - t.y, r.eye.z - t.z), nbLy: window.__nb.distLy, fps: g.engine.fps }; })));
}
await browser.close();
