/* Frame pacing bench: drives the real page and records what the rAF loop
 * actually does frame by frame — render interval, how many world.step()s ran
 * inside each frame, and how often a rendered frame shows a world that has
 * not moved since the last one (the stutter signature of 60Hz physics under
 * a faster display).
 *
 *   node tools/bench-pacing.mjs [--simhz=144] [--secs=12]
 *
 * --simhz replaces requestAnimationFrame with a synthetic clock that pumps
 * the loop at that rate (headless Chrome pins rAF to its own 60Hz scheduler,
 * so this is how a 120/144/165Hz screen is emulated). Without --simhz the
 * measurement is plain headless 60Hz.
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = 'file://' + join(here, '..', 'index.html');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const arg = (name, dflt) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? dflt;
const simhz = Number(arg('simhz', 0));
const secs = Number(arg('secs', 12));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--window-size=1280,720', '--disable-gpu', '--force-device-scale-factor=1'],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1280, height: 720 });

await tab.evaluateOnNewDocument(`
  window.__pace = { t: [], steps: [], head: [], lerpSum: 0, lerpMax: 0 };
  if (${simhz ? simhz : 0}) {
    const stepMs = 1000 / ${simhz || 0};
    let vnow = 1000;
    window.requestAnimationFrame = (cb) => setTimeout(() => { vnow += stepMs; cb(vnow); }, stepMs);
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    const i = window.__pace.t.length;
    window.__pace.t.push(ts); window.__pace.steps.push(0); window.__pace.head.push(NaN);
    const r = cb(ts);
    const w = window.MineserpentGame ? window.MineserpentGame.world() : null;
    if (w && w.player && !w.player.dead) {
      const p = w.player.pts[0], lp = window.__pace.lastLerp === undefined ? 1 : window.__pace.lastLerp;
      window.__pace.head[i] = (p.px === undefined ? p.x : p.px + (p.x - p.px) * lp);
    }
    return r;
  });
`);
await tab.goto(page + '?autostart=1&difficulty=ruthless', { waitUntil: 'load' });
await tab.evaluate(`
  const W = window.Mineserpent.World, R = window.MineserpentRender;
  const oStep = W.prototype.step;
  W.prototype.step = function (dt) { window.__pace.steps[window.__pace.steps.length - 1]++; return oStep.call(this, dt); };
  const oDraw = R.draw.bind(R);
  R.draw = function (w, v) {
    const lp = v.lerp === undefined ? 1 : v.lerp;
    window.__pace.lastLerp = lp; window.__pace.lerpSum += lp; window.__pace.lerpMax = Math.max(window.__pace.lerpMax, lp);
    return oDraw(w, v);
  };
`);
await new Promise((r) => setTimeout(r, secs * 1000));

const out = await tab.evaluate(`
  (() => {
    const t = window.__pace.t, steps = window.__pace.steps, head = window.__pace.head;
    const n = t.length;
    const ivs = []; for (let i = 1; i < n; i++) ivs.push(t[i] - t[i - 1]);
    const sorted = [...ivs].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const hist = {}; steps.forEach((s) => hist[s] = (hist[s] || 0) + 1);
    let stalled = 0, compared = 0;
    for (let i = 1; i < n; i++) {
      if (Number.isNaN(head[i]) || Number.isNaN(head[i - 1])) continue;
      compared++;
      if (head[i] === head[i - 1]) stalled++;
    }
    const half = Math.floor(n / 2);
    const simSteps = steps.slice(half).reduce((a, b) => a + b, 0);
    const longGaps = sorted.filter((v) => v > 40).length;
    return { n, p50: pct(0.5), p95: pct(0.95), max: sorted[sorted.length - 1], longGaps,
             hist, stepsPerFrame: simSteps / (n - half), stalled, compared,
             lerpMean: window.__pace.lerpSum / n, lerpMax: window.__pace.lerpMax };
  })()
`);
await browser.close();

console.log(`rAF ${simhz ? 'synthetic ' + simhz + 'Hz' : 'native headless'} | ${out.n} frames over ~${secs}s`);
console.log(`frame interval   p50 ${out.p50.toFixed(2)}ms  p95 ${out.p95.toFixed(2)}ms  max ${out.max.toFixed(2)}ms  (>40ms: ${out.longGaps})`);
console.log(`world.step/frame ${JSON.stringify(out.hist)}  (${out.stepsPerFrame.toFixed(2)} steps/frame)`);
console.log(`stalled frames   ${out.stalled}/${out.compared} rendered the same head position as the previous frame (${(100 * out.stalled / Math.max(1, out.compared)).toFixed(0)}%)`);
console.log(`render lerp      mean ${out.lerpMean.toFixed(2)} max ${out.lerpMax.toFixed(2)}`);
