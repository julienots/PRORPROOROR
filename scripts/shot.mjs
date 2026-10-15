// Capture rapide : node scripts/shot.mjs <url> <fichier> [attente ms] [js à évaluer]
import { chromium } from 'playwright-core';
const [url, out, wait = '4000', js] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (js) { const r = await page.evaluate(js); if (r !== undefined) console.log('eval:', JSON.stringify(r)); await page.waitForTimeout(Number(wait)); }
await page.screenshot({ path: out });
console.log(logs.slice(0, 30).join('\n') || 'no errors');
await browser.close();
