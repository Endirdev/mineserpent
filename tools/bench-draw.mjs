/* Deterministic painter benchmark: builds the SAME scene (seeded PRNG, fixed
 * camera) and times 300 SlitherRender.draw() calls as one batch, so canvas
 * raster noise can't mask JS-side paint costs. Run before/after a render
 * change by stashing the working tree — the scene is bit-identical across
 * core versions because the PRNG consumption order is unchanged.
 *   node tools/bench-draw.mjs
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = 'file://' + join(here, '..', 'index.html');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

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
    const w = new Slither.World({ difficulty: 'ruthless' });
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
    const view = { x: big.x(), y: big.y(), zoom: 0.7, shakeX: 0, shakeY: 0 };

    const N = 300;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) SlitherRender.draw(w, view);
    const drawMs = (performance.now() - t0) / N;

    const mini = document.getElementById('minimap');
    const t1 = performance.now();
    for (let i = 0; i < N; i++) SlitherRender.drawMinimap(w, mini, big);
    const miniMs = (performance.now() - t1) / N;

    let segs = 0, alive = 0;
    for (const s of w.snakes) if (!s.dead) { segs += s.pts.length; alive++; }
    return { drawMs, miniMs, segs, alive, food: w.food.length, revealed: sw.revealed, flags: sw.flags };
  })()
`);
await browser.close();
console.log(`draw ${out.drawMs.toFixed(3)}ms/frame  minimap ${out.miniMs.toFixed(3)}ms  [${out.alive} snakes, ${out.segs} body pts, ${out.food} pellets, ${out.revealed} revealed, ${out.flags} flags]`);
