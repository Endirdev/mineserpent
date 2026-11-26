/* Deterministic painter benchmark: builds the SAME scene (seeded PRNG, fixed
 * camera) and times MineserpentRender.draw() calls, so canvas raster noise can't
 * mask JS-side paint costs. Run before/after a render change by stashing the
 * working tree — the scene is bit-identical across core versions because the PRNG
 * consumption order is unchanged.
 *
 * The batch mean is the headline number. The p50/p95/max come from per-frame
 * samples that force a flush after each frame, because Chromium defers 2D canvas
 * raster until the next flush and an unforced sample only times the recording of
 * a frame.
 *
 * Requires google-chrome (or CHROME_PATH) and puppeteer-core:
 *   npm install --no-save puppeteer-core
 *
 *   node tools/bench-draw.mjs
 *   node tools/bench-draw.mjs --baseline    # re-record test/bench-draw-baseline.json
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = 'file://' + join(here, '..', 'index.html');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const BASELINE_FILE = join(here, '..', 'test', 'bench-draw-baseline.json');

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--window-size=1280,720', '--disable-gpu', '--force-device-scale-factor=1'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1280, height: 720 });
await tab.goto(page, { waitUntil: 'load' });

const out = await tab.evaluate(`
  (() => {
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    Math.random = mulberry32(424242);
    const w = new Mineserpent.World({ difficulty: 'ruthless' });
    // Grow everyone to a fixed size, then pin the scene so both code versions
    // paint the same workload: the same number of alive snakes, the same
    // segment counts, a fixed pellet count, and a fixed revealed/flag count.
    // (The bots' own positions inevitably differ a little between versions;
    // what must match is the amount of work the painter does.)
    for (let i = 0; i < 480; i++) {
      for (const s of w.snakes) { s.dead = false; s.mass = 500; }
      w.step(1 / 60);
    }
    // collisions killed a few mid-step and the repopulate rule spawned extras;
    // keep exactly the 44 originals so both versions draw the same cast
    w.snakes.length = 44;
    for (const s of w.snakes) { s.dead = false; s.grace = 0; s.boost = false; }
    w.food.length = 1500;
    for (const f of w.food) f.eaten = false;
    w.effects.length = 0;
    const sw = w.sweeper;
    sw.revealed = 0; sw.flags = 0;
    for (let i = 0; i < sw.w * sw.h; i++) {
      if (!sw.inside[i]) continue;
      if (sw.mine[i]) { if (i % 7 === 0) { sw.state[i] = 2; sw.flags++; } continue; }
      if (i % 3 === 0) { sw.state[i] = 1; sw.revealed++; }
      else if (i % 11 === 0) { sw.state[i] = 2; sw.flags++; }
    }

    let big = w.snakes[0];
    for (const s of w.snakes) if (!s.dead && (!big || s.mass > big.mass)) big = s;
    // the shipped look paints the halo and the veil "on your snake only", and the
    // cast above was truncated so it may not contain the player: without a player
    // such a look paints no halo and no veil at all, which would read as a much
    // cheaper workload than the game plays. Marking a survivor changes its colours
    // and nameplate ink, not the work, so the shares stay comparable
    const LOOK0 = MineserpentRender.LOOK;
    let wantsPlayer = false;
    for (const wk in LOOK0) if (/PlayerOnly/.test(wk) && LOOK0[wk]) wantsPlayer = true;
    if (wantsPlayer && w.snakes.every(function (s) { return !s.player; })) big.player = true;
    const view = { x: big.x(), y: big.y(), zoom: 0.7, shakeX: 0, shakeY: 0 };

    const N = 300;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) MineserpentRender.draw(w, view);
    const drawMs = (performance.now() - t0) / N;

    // per-frame samples: the readback forces Chromium to run the raster inside the
    // sample, otherwise a frame is only timed as far as recording its display list
    function flush() { MineserpentRender.ctx.getImageData(0, 0, 1, 1); }
    function statOf(a) {
      const s = [...a].sort((x, y) => x - y);
      const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: s.length, mean: s.reduce((x, y) => x + y, 0) / Math.max(1, s.length), p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
    }
    for (let i = 0; i < 10; i++) { MineserpentRender.draw(w, view); flush(); }
    const samples = [];
    for (let i = 0; i < 120; i++) {
      const a = performance.now();
      MineserpentRender.draw(w, view);
      flush();
      samples.push(performance.now() - a);
    }
    const frame = statOf(samples);

    const mini = document.getElementById('minimap');
    const t1 = performance.now();
    for (let i = 0; i < N; i++) MineserpentRender.drawMinimap(w, mini, big);
    const miniMs = (performance.now() - t1) / N;

    let segs = 0, alive = 0;
    for (const s of w.snakes) if (!s.dead) { segs += s.pts.length; alive++; }
    return { drawMs, frame, miniMs, segs, alive, food: w.food.length, revealed: sw.revealed, flags: sw.flags };
  })()
`);
await browser.close();

const scene = `[${out.alive} snakes, ${out.segs} body pts, ${out.food} pellets, ${out.revealed} revealed, ${out.flags} flags]`;
console.log(`draw ${out.drawMs.toFixed(3)}ms/frame  frame p50 ${out.frame.p50.toFixed(2)} p95 ${out.frame.p95.toFixed(2)} max ${out.frame.max.toFixed(2)}ms  minimap ${out.miniMs.toFixed(3)}ms  ${scene}`);

const rec = {
  label: 'draw',
  meanMs: out.drawMs,
  p50Ms: out.frame.p50,
  p95Ms: out.frame.p95,
  maxMs: out.frame.max,
  miniMs: out.miniMs,
  scene: { alive: out.alive, segs: out.segs, food: out.food, revealed: out.revealed, flags: out.flags },
};
if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ stamp: new Date().toISOString(), results: [rec] }, null, 2));
  console.log('saved as the baseline -> test/bench-draw-baseline.json');
} else if (existsSync(BASELINE_FILE)) {
  const base = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).results.find((x) => x.label === 'draw');
  if (base) {
    const dm = ((out.drawMs - base.meanMs) / base.meanMs) * 100;
    const dp = ((out.frame.p95 - base.p95Ms) / base.p95Ms) * 100;
    console.log(`baseline mean ${base.meanMs.toFixed(3)} -> ${out.drawMs.toFixed(3)}ms (${dm >= 0 ? '+' : ''}${dm.toFixed(1)}%)  p95 ${base.p95Ms.toFixed(2)} -> ${out.frame.p95.toFixed(2)}ms (${dp >= 0 ? '+' : ''}${dp.toFixed(1)}%)  minimap ${base.miniMs.toFixed(3)} -> ${out.miniMs.toFixed(3)}ms`);
  }
}
