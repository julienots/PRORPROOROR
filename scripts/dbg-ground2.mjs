import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
await page.goto('http://localhost:4173/?autostart&quality=performance');
await page.waitForTimeout(3000);
await page.evaluate(() => { const g = window.__SUPERESSENCE__.game; g.paused = true; const e = g.world.bodies.find((b) => b.name === 'Terre'); g.select('b' + e.id); g.engine.rig.set(e.pos, e.radius / 1.496e8 * 3); g.ow.land(e.id); g.engine.rig.distance = 3 / 1.496e8; g.engine.rig.pitch = 0.35; });
await page.waitForTimeout(8000);
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__SUPERESSENCE__.game; const v = g.views.system.visuals.get(g.surface.bodyId);
  const p = v.patch; p.updateMatrixWorld(true);
  const pos = p.geometry.attributes.position; const n = Math.round(Math.sqrt(pos.count)) - 1; const c = (n / 2) * (n + 1) + n / 2;
  const THREE_V = p.position.constructor; const w = new THREE_V(pos.getX(c), pos.getY(c), pos.getZ(c)).applyMatrix4(p.matrixWorld);
  const cam = g.engine.rig.camera; const fwd = new THREE_V(0, 0, -1).applyQuaternion(cam.quaternion);
  return { centerWorld: w.toArray(), dist_km: w.length() * 1000, camNear: cam.near, camFar: cam.far, fwd: fwd.toArray(), groupPos: v.group.position.toArray(), spinRot: v.spin.rotation.y, surfDir: g.surface.dir, alt: g.surface.altKm, extEye: g.engine.rig.external?.eye, eye: g.engine.rig.eye, body: g.world.get(g.surface.bodyId).pos };
})));
await browser.close();
