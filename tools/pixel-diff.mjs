/* Pixel diff for the painter: renders the same pinned scene twice in ONE page,
 * once with js/render.js from each of two git refs, and says how the canvases
 * differ. One page matters: cross-run screenshots are not comparable because the
 * scene is not bit-identical between runs, so a difference would be noise.
 *
 * Only js/render.js is swapped; core/main stay as the working tree has them.
 *
 * It also reports two traps that would otherwise be silent:
 *   - the purity guard. The same variant is rendered twice and the pixels compared
 *     first. If that diff is not empty, the scene is not reproducible and every
 *     number below it is meaningless.
 *   - the canvas state probe. The painter leaks what it leaves in the 2D context
 *     (alignment and baseline in particular), and later passes read it, so two
 *     painters can be pixel-identical a frame and still disagree once another
 *     pass inherits that state. Each pass's exit state is snapshotted and compared.
 *
 * Requires google-chrome (or CHROME_PATH) and puppeteer-core:
 *   npm install --no-save puppeteer-core
 *
 *   node tools/pixel-diff.mjs                       # working tree vs HEAD
 *   node tools/pixel-diff.mjs . 9e21ae7             # working tree vs a commit
 *   node tools/pixel-diff.mjs --view worst          # 2560x1440 zoom 0.40, all open
 *   exit status 1 means a pixel moved by more than 8/255
 */
import { SCENE, REVEAL_ALL, VIEW, VIEWS, openPage } from './bench-common.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'js/render.js';

let view = 'normal';
const refs = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--view') view = process.argv[++i];
  else refs.push(a);
}
const refA = refs[0] || 'work';
const refB = refs[1] || 'HEAD';

function source(ref) {
  if (ref === 'work' || ref === '.') return readFileSync(FILE, 'utf8');
  return execFileSync('git', ['show', ref + ':' + FILE, '--'], { encoding: 'utf8' });
}

const srcA = source(refA);
const srcB = source(refB);
const preset = VIEWS[view];

const { browser, tab } = await openPage(preset.w, preset.h);

const out = await tab.evaluate(`
  (() => {
    ${SCENE}
    ${preset.reveal === 'full' ? REVEAL_ALL : ''}
    const view = { x: ${preset.camera === 'center' ? '0' : 'big.x()'},
                   y: ${preset.camera === 'center' ? '0' : 'big.y()'},
                   zoom: ${preset.zoom}, shakeX: 0, shakeY: 0, lerp: 1 };
    const live = window.MineserpentRender;
    const canvas = live.canvas;

    // one renderer per source: evaluating js/render.js binds its own Render to
    // window.MineserpentRender, which is what the page's copy also did at boot
    ${srcA}
    const A = window.MineserpentRender;
    window.MineserpentRender = live;
    ${srcB}
    const B = window.MineserpentRender;
    window.MineserpentRender = live;
    A.init(canvas);
    B.init(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });

    // what a pass leaves in the context, for the state probe
    function stateOf(c) {
      return [
        'fill=' + c.fillStyle, 'stroke=' + c.strokeStyle, 'lw=' + c.lineWidth,
        'cap=' + c.lineCap, 'join=' + c.lineJoin, 'miter=' + c.miterLimit,
        'offset=' + c.lineDashOffset, 'dash=' + c.getLineDash().join(','),
        'alpha=' + c.globalAlpha, 'op=' + c.globalCompositeOperation,
        'font=' + c.font, 'align=' + c.textAlign, 'baseline=' + c.textBaseline,
        'filter=' + c.filter, 'smooth=' + c.imageSmoothingEnabled,
        'tf=' + c.getTransform().toString(),
      ].join('|');
    }
    const probed = ['drawGrid', 'drawSweeper', 'drawMarks', 'drawBoundary', 'drawFood', 'drawSnakes', 'drawSweeperOverlay', 'drawEffects'];
    // each renderer gets wrapped once: wrapping per shot would nest the wrapper
    // and double-count the inner pass
    function installProbe(R, holder) {
      for (const name of probed) {
        const orig = R[name];
        if (!orig) continue;
        R[name] = function (...args) {
          const out2 = orig.apply(R, args);
          const arr = holder.cur[name] || (holder.cur[name] = []);
          arr.push(stateOf(R.ctx));
          return out2;
        };
      }
    }
    const sinkA = { cur: {} };
    const sinkB = { cur: {} };
    installProbe(A, sinkA);
    installProbe(B, sinkB);

    // a frame, drawn to the shared canvas, pixels and exit state captured
    function shoot(R, holder) {
      holder.cur = {};
      R.draw(w, view);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { pixels: img.data, state: holder.cur };
    }

    // the guard first: the same painter twice must land on the same pixels
    const a1 = shoot(A, sinkA);
    const a2 = shoot(A, sinkA);
    let selfDiff = 0, selfMax = 0;
    for (let i = 0; i < a1.pixels.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(a1.pixels[i + k] - a2.pixels[i + k]);
        if (d) { selfMax = Math.max(selfMax, d); if (d > 8) selfDiff++; }
      }
    }

    const b1 = shoot(B, sinkB);
    let max = 0, over0 = 0, over8 = 0, over40 = 0, same = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    let worstAt = -1;
    for (let y = 0, i = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++, i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a2.pixels[i + k] - b1.pixels[i + k]));
        if (d === 0) same++;
        else {
          over0++;
          if (d > 8) over8++;
          if (d > 40) over40++;
          if (d > max) { max = d; worstAt = i / 4; }
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const total = canvas.width * canvas.height;
    function fieldDiff(ea, eb) {
      const A = ea.split('|'), B = eb.split('|');
      const parts = [];
      for (let k = 0; k < Math.max(A.length, B.length); k++) if (A[k] !== B[k]) parts.push(A[k] + ' -> ' + B[k]);
      return parts.join('; ');
    }
    const stateDiff = [];
    const counts = [];
    for (const name of probed) {
      const ea = a2.state[name] || [], eb = b1.state[name] || [];
      counts.push(name + ':' + ea.length + '/' + eb.length);
      if (ea.length !== eb.length) { stateDiff.push(name + ' is called ' + ea.length + 'x by A but ' + eb.length + 'x by B'); continue; }
      for (let k = 0; k < ea.length; k++) if (ea[k] !== eb[k]) stateDiff.push(name + ' exit #' + (k + 1) + ': ' + fieldDiff(ea[k], eb[k]));
    }
    return { selfDiff, selfMax, total, same, over0, over8, over40, max,
      bbox: over0 ? [minX, minY, maxX, maxY] : null,
      worst: worstAt < 0 ? null : [worstAt % canvas.width, Math.floor(worstAt / canvas.width)],
      stateDiff, counts,
      segs: w.snakes.reduce(function (acc, s) { return acc + (s.dead ? 0 : s.pts.length); }, 0),
      alive: w.snakes.filter(function (s) { return !s.dead; }).length,
      revealed: w.sweeper.revealed, flags: w.sweeper.flags };
  })()
`);

await browser.close();

console.log(`== ${view} — ${preset.w}x${preset.h} zoom ${preset.zoom} camera ${preset.camera} reveal ${preset.reveal} | A=${refA} B=${refB} (${FILE}) ==`);
console.log(`scene: ${out.alive} snakes / ${out.segs} body pts, ${out.revealed} revealed / ${out.flags} flags`);
if (out.selfDiff) {
  console.log(`purity guard FAILED: the same painter differs by ${out.selfDiff} px above 8 (max ${out.selfMax}) — the scene is not reproducible, so the numbers below are noise`);
} else {
  console.log(`purity guard ok: the same painter twice matched to within 8/255 everywhere`);
}
const pct = (n) => (n / out.total * 100).toFixed(2);
console.log(`pixels: ${(pct(out.same))}% identical | max channel delta ${out.max} | differs ${out.over0} (${pct(out.over0)}%) | above 8 ${out.over8} (${pct(out.over8)}%) | above 40 ${out.over40}`);
if (out.bbox) console.log(`difference box: x ${out.bbox[0]}..${out.bbox[2]}  y ${out.bbox[1]}..${out.bbox[3]}   worst pixel at ${out.worst.join(', ')}`);
console.log('probed passes (calls by A / by B): ' + out.counts.join(' '));
if (out.stateDiff.length) {
  console.log('pass shape / state differences (a helper one version lacks shows up as a call count):');
  for (const s of out.stateDiff) console.log('  ' + s.slice(0, 300));
} else {
  console.log('canvas state: every probed pass leaves the same context');
}
const exact = out.over8 === 0;
console.log(exact ? `verdict: pixel-exact within antialiasing noise (nothing above 8/255)` : `verdict: ${out.over8} pixels moved by more than 8/255 — not a safe swap`);
process.exitCode = exact ? 0 : 1;
