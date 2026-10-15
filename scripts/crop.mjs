import { chromium } from 'playwright-core';
const [url, out, js, wait = '5000', clip] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(3000);
if (js) { const r = await page.evaluate(js); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
await page.waitForTimeout(Number(wait));
const opt = { path: out };
if (clip) { const [x, y, w, h] = clip.split(',').map(Number); opt.clip = { x, y, width: w, height: h }; }
await page.screenshot(opt);
console.log(logs.slice(0, 30).join('\n') || 'no errors');
await browser.close();
