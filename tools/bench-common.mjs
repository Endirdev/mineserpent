/* Shared by the painter benches: the pinned scene and the headless Chrome launch.
 *
 * The scene is seeded so every run — and every code version — paints the same
 * workload. What must match across versions is the amount of work the painter
 * does, not the bots' exact positions, so the counts are pinned after the fact.
 *
 * Everything here is measured with software rasterisation (--disable-gpu): the
 * absolute ms describe this machine, the ratios and the ranking transfer.
 */
import puppeteer from 'puppeteer-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const page = 'file://' + join(here, '..', 'index.html');
export const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// in-page snippet: builds the pinned scene. Defines w (the world), big (the
// fattest alive snake) and sw (its sweeper layer).
export const SCENE = `
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
  for (let i = 0; i < 480; i++) {
    for (const s of w.snakes) { s.dead = false; s.mass = 500; }
    w.step(1 / 60);
  }
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
  for (const s of w.snakes) if (!s.dead && s.mass > big.mass) big = s;
`;

// the view maths draw() does: the window it culls against, plus the world
// transform it installs before every world-space pass.
export const VIEW = `
  const R = MineserpentRender;
  const ctx = R.ctx;
  const dpr = R.dpr, WW = R.w, HH = R.h, zoom = view.zoom;
  const camX = view.x, camY = view.y;
  const vw = WW / zoom, vh = HH / zoom;
  let left = camX - vw / 2, top = camY - vh / 2, right = camX + vw / 2, bottom = camY + vh / 2;
  left -= 90; top -= 90; right += 90; bottom += 90;
  function worldSpace() {
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (WW / 2 - camX * zoom), dpr * (HH / 2 - camY * zoom));
  }
  function screenSpace() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
`;

// what camera/reveal presets mean: normal is mid-play, worst is the opened
// board under the widest camera, which is where the board's paint cost peaks
export const VIEWS = {
  normal: { w: 1280, h: 720, zoom: 0.7, camera: 'snake', reveal: 'bench' },
  worst: { w: 2560, h: 1440, zoom: 0.4, camera: 'center', reveal: 'full' },
};

export async function openPage(vw, vh, scale) {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--window-size=' + vw + ',' + vh, '--disable-gpu', '--force-device-scale-factor=' + (scale || 1)],
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: vw, height: vh });
  await tab.goto(page, { waitUntil: 'load' });
  return { browser, tab, vw, vh };
}

export const SCENE_STATS = `
  let segs = 0, alive = 0;
  for (const s of w.snakes) if (!s.dead) { segs += s.pts.length; alive++; }
  ({ alive, segs, food: w.food.length, revealed: sw.revealed, flags: sw.flags })
`;

// opening the whole board: the worst the sweeper layer ever paints
export const REVEAL_ALL = `
  sw.flags = 0;
  for (let i = 0; i < sw.w * sw.h; i++) if (sw.inside[i]) sw.state[i] = 1;
  let opened = 0;
  for (let i = 0; i < sw.w * sw.h; i++) if (sw.inside[i]) opened++;
  sw.revealed = opened;
`;

export function statOf(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
  };
}
