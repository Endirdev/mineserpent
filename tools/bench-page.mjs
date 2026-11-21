/* Browser render benchmark: drives the real page in headless Chrome and
 * times the two hot calls of a frame — world.step() and MineserpentRender.draw().
 *
 * Requires google-chrome (or CHROME_PATH) and puppeteer-core:
 *   npm install --no-save puppeteer-core
 *
 *   node tools/bench-page.mjs [--secs 15] [--baseline]
 *
 * The run has two phases: a normal ruthless match, then everyone force-fed
 * to mass 900 so the painter draws long, fat bodies on screen — the render
 * worst case. Absolute ms depend on the machine and on SwiftShader software
 * raster in headless; what matters is before/after on the same machine.
 */
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = 'file://' + join(here, '..', 'index.html');
const BASELINE_FILE = join(here, '..', 'test', 'bench-page-baseline.json');
const secs = Number(process.argv.find((a) => a.startsWith('--secs='))?.slice(7) || 15);
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--window-size=1280,720', '--disable-gpu', '--force-device-scale-factor=1'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1280, height: 720 });
await tab.goto(page + '?autostart=1&difficulty=ruthless', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2000));

await tab.evaluate(`
  window.__bench = { step: [], draw: [] };
  const W = window.Mineserpent.World, R = window.MineserpentRender;
  const oStep = W.prototype.step;
  W.prototype.step = function (dt) {
    const t = performance.now(); oStep.call(this, dt);
    window.__bench.step.push(performance.now() - t);
  };
  const oDraw = R.draw.bind(R);
  R.draw = function (w, v) {
    const t = performance.now(); oDraw(w, v);
    window.__bench.draw.push(performance.now() - t);
  };
`);

async function phase(label, seconds, pre) {
  if (pre) await tab.evaluate(pre);
  await tab.evaluate('window.__bench = { step: [], draw: [] };');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const out = await tab.evaluate(`
    (() => {
      const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      const stat = (a) => a.length ? { n: a.length, mean: mean(a), p50: pct(a, 0.5), p95: pct(a, 0.95), max: Math.max(...a) } : null;
      const g = window.MineserpentGame;
      const w = g.world();
      let segs = 0, onScreen = 0;
      for (const s of w.snakes) if (!s.dead) segs += s.pts.length;
      return { step: stat(window.__bench.step), draw: stat(window.__bench.draw), fps: g.fps(), segs, food: w.food.length };
    })()
  `);
  console.log(`${label}  step mean ${out.step.mean.toFixed(2)}ms p95 ${out.step.p95.toFixed(2)}ms  |  draw mean ${out.draw.mean.toFixed(2)}ms p95 ${out.draw.p95.toFixed(2)}ms max ${out.draw.max.toFixed(2)}ms  |  fps ~${out.fps.toFixed(0)}, ${out.segs} body pts, ${out.food} pellets`);
  return { label, step: out.step, draw: out.draw, fps: out.fps };
}

const calm = await phase('game   ', secs, null);
const huge = await phase('stressed', secs, `
  for (const s of window.MineserpentGame.world().snakes) if (!s.dead) { s.mass = 900; s.score = 900; }
`);
const results = [calm, huge];
await browser.close();

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ stamp: new Date().toISOString(), results }, null, 2));
  console.log('saved as the baseline -> test/bench-page-baseline.json');
} else if (existsSync(BASELINE_FILE)) {
  const base = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  console.log('--- vs baseline ------------------------------------------------');
  for (const r of results) {
    const b = base.results.find((x) => x.label === r.label);
    if (!b) continue;
    const ds = ((r.step.mean - b.step.mean) / b.step.mean) * 100;
    const dd = ((r.draw.mean - b.draw.mean) / b.draw.mean) * 100;
    console.log(`${r.label.trim().padEnd(8)} step ${b.step.mean.toFixed(2)} -> ${r.step.mean.toFixed(2)}ms (${ds >= 0 ? '+' : ''}${ds.toFixed(1)}%), draw ${b.draw.mean.toFixed(2)} -> ${r.draw.mean.toFixed(2)}ms (${dd >= 0 ? '+' : ''}${dd.toFixed(1)}%)`);
  }
}
