// Dev helper: screenshot the built game. usage: node scripts/shot.mjs "<query>" out.png [waitMs] [width] [height]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
const [query = '', out = 'shot.png', wait = '4000', w = '1280', h = '800'] = process.argv.slice(2);
const srv = spawn('npx', ['vite', 'preview', '--port', '4319', '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log(m.type() + ':', m.text()); });
await page.goto('http://localhost:4319/' + query);
await new Promise((r) => setTimeout(r, +wait));
if (process.env.EVAL) console.log(JSON.stringify(await page.evaluate(process.env.EVAL)));
await page.screenshot({ path: out });
await browser.close(); srv.kill();
