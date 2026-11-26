/* Per-pass cost of a frame: what each pass of MineserpentRender.draw() is worth,
 * and how the big ones split up. The scene is the pinned one, so the numbers
 * mean the same workload every run.
 *
 * A pass measured on its own never pays its own raster: Chromium keeps 2D canvas
 * work in a display list and runs it at the next flush. Every pass therefore gets
 * a forced flush (a 1x1 readback) and the readback cost is calibrated out by
 * timing an empty pass the same way. The consequence is that the passes do not sum
 * to the frame: forcing a flush per pass also forces Chromium to resolve each one
 * alone, which the real frame batches. The draw() line is the authoritative cost,
 * and note that its per-frame samples sit a little above tools/bench-draw.mjs's
 * batch mean, which is throughput with Chromium allowed to coalesce across frames.
 *
 * Requires google-chrome (or CHROME_PATH) and puppeteer-core:
 *   npm install --no-save puppeteer-core
 *
 *   node tools/bench-pass.mjs                       # both camera presets
 *   node tools/bench-pass.mjs --view worst          # one preset
 *   node tools/bench-pass.mjs --frames 20           # whole-frame samples to take
 *   node tools/bench-pass.mjs --look glass=false,veilAlpha=0,rimGrow=0
 *      # price a look the shape lab dials in: same pinned scene and same sitting,
 *      # so its shares are comparable with the shipped one. Only LOOK keys apply,
 *      # and the header prints what was applied.
 *   node tools/bench-pass.mjs --fidelity low
 *      # price a shipped graphics level: the table lives in js/main.js (FIDELITY,
 *      # published as window.MineserpentFidelity) and is applied after --look, so
 *      # a level is the last word, exactly as the page does it. With neither flag
 *      # the run is pinned to the shipped LOOK table, not to what the page boots at
 */
import { SCENE, REVEAL_ALL, VIEW, VIEWS, openPage, lookLiteral } from './bench-common.mjs';

let want = 'both';
let frames = 40;
let look = '';
let fidelity = '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--view') want = process.argv[++i];
  else if (process.argv[i] === '--frames') frames = Number(process.argv[++i]);
  else if (process.argv[i] === '--look') look = process.argv[++i];
  else if (process.argv[i] === '--fidelity') fidelity = process.argv[++i];
}
const names = Object.keys(VIEWS);
const pick = want === 'both' ? names : [want];

// LOOK overrides as an object literal for the page; values stay JS literals
const lookBody = lookLiteral(look);

for (const key of pick) {
  const preset = VIEWS[key];
  const { browser, tab } = await openPage(preset.w, preset.h);
  // the pinned scene truncates the cast, which can drop the player snake; a
  // player-only knob needs one, and marking a survivor changes its colours and
  // nameplate ink, not the workload, so the shares stay comparable
  const out = await tab.evaluate(`
    (() => {
      ${SCENE}
      ${preset.reveal === 'full' ? REVEAL_ALL : ''}
      const view = { x: ${preset.camera === 'center' ? '0' : 'big.x()'},
                     y: ${preset.camera === 'center' ? '0' : 'big.y()'},
                     zoom: ${preset.zoom}, shakeX: 0, shakeY: 0, lerp: 1 };
      ${VIEW}

      // the page boots at a fidelity level (High by default); a bench run wants a
      // known baseline, so pin the shipped table first, then --look, then --fidelity
      if (window.MineserpentLook0) {
        for (const rk in window.MineserpentLook0) {
          if (rk in R.LOOK) R.LOOK[rk] = window.MineserpentLook0[rk];
        }
        if (R.refreshPaints) R.refreshPaints();
      }

      // LOOK overrides, so a look dialled in the shape lab can be priced here
      const LOOK_SET = { ${lookBody} };
      const lookApplied = [];
      for (const lk in LOOK_SET) {
        if (!(lk in R.LOOK)) continue;
        R.LOOK[lk] = LOOK_SET[lk];
        lookApplied.push(lk + '=' + LOOK_SET[lk]);
      }
      if (lookApplied.length) R.refreshPaints();

      // the shipped ladder, from js/main.js, applied after --look so a level has
      // the last word, exactly as the page does it
      ${fidelity ? `
      const FID = (window.MineserpentFidelity || {})['${fidelity}'] || {};
      for (const fk in FID) {
        if (!(fk in R.LOOK)) continue;
        R.LOOK[fk] = FID[fk];
        lookApplied.push(fk + '=' + FID[fk]);
      }
      if (R.refreshPaints) R.refreshPaints();   // the level moved wash/cursor knobs? re-derive` : ''}

      // a look that says "on your snake only" needs a player in the scene: the
      // pinned cast truncates the real one, and with no player such a look paints
      // no halo and no veil at all, so the workload would read as the cheapest one
      let wantsPlayer = false;
      for (const wk in R.LOOK) if (/PlayerOnly/.test(wk) && R.LOOK[wk]) wantsPlayer = true;
      const playerPinned = wantsPlayer && w.snakes.every(function (s) { return !s.player; });
      if (playerPinned) big.player = true;

      function statOf(a) {
        const s = [...a].sort((x, y) => x - y);
        const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
        return { n: s.length, mean: s.reduce((x, y) => x + y, 0) / Math.max(1, s.length), p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
      }
      const seq = ['background', 'grid', 'sweeper', 'boundary', 'food', 'snakes', 'overlay', 'effects', 'vignette'];
      function passes() {
        return {
          background: function () { screenSpace(); ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, WW, HH); },
          grid: function () { worldSpace(); R.drawGrid(ctx, w, left, top, right, bottom, zoom); },
          sweeper: function () { worldSpace(); R.drawSweeper(ctx, w, left, top, right, bottom, zoom); },
          boundary: function () { worldSpace(); R.drawBoundary(ctx, w, zoom); },
          food: function () { worldSpace(); R.drawFood(ctx, w, left, top, right, bottom); },
          snakes: function () { worldSpace(); R.drawSnakes(ctx, w, left, top, right, bottom, zoom, 1); },
          overlay: function () { worldSpace(); R.drawSweeperOverlay(ctx, w, left, top, right, bottom, zoom); },
          effects: function () { worldSpace(); R.drawEffects(ctx, w, zoom); },
          vignette: function () { screenSpace(); ctx.fillStyle = R.vignette; ctx.fillRect(0, 0, WW, HH); },
        };
      }
      const P = passes();
      function frame() { for (const n of seq) P[n](); }

      function flush() { ctx.getImageData(0, 0, 1, 1); }
      // paint for a fixed budget per round, in growing batches so a cheap pass
      // still gets thousands of calls and an expensive one still gets a dozen
      function timeIt(fn) {
        for (let i = 0; i < 6; i++) { fn(); flush(); }
        let best = Infinity;
        for (let round = 0; round < 3; round++) {
          const t = performance.now();
          let done = 0;
          let batch = 1;
          while (performance.now() - t < 40) {
            for (let k = 0; k < batch; k++) { fn(); flush(); }
            done += batch;
            batch = done >= 300 ? 256 : (done >= 4 ? 8 : 1);
          }
          const ms = (performance.now() - t) / done;
          if (ms < best) best = ms;
        }
        return best;
      }
      const floor = timeIt(function () { });
      const cost = {};
      for (const n of seq) cost[n] = timeIt(P[n]) - floor;

      // whole frames, no flush between passes inside a frame; the flush after each
      // one puts the deferred raster inside the sample, so p50/p95/max are honest
      function frameOnce() {
        for (let i = 0; i < 5; i++) frame();
        const samples = [];
        for (let i = 0; i < ${frames}; i++) {
          const a = performance.now();
          frame();
          flush();
          samples.push(performance.now() - a);
        }
        return statOf(samples);
      }
      function drawOnce() {
        for (let i = 0; i < 5; i++) R.draw(w, view);
        const samples = [];
        for (let i = 0; i < ${frames}; i++) {
          const a = performance.now();
          R.draw(w, view);
          flush();
          samples.push(performance.now() - a);
        }
        return statOf(samples);
      }
      const frameStats = frameOnce();
      const drawStats = drawOnce();

      // the snake slice dominates a busy frame; split it by stubbing each part.
      // The stubs change the look: this measures shape, it is not a proposal.
      const keepStroke = ctx.stroke;
      const keepFace = R.drawFace;
      const keepText = ctx.fillText;
      ctx.stroke = function () { };
      const noStroke = timeIt(P.snakes) - floor;
      ctx.stroke = keepStroke;
      R.drawFace = function () { };
      const noFace = timeIt(P.snakes) - floor;
      R.drawFace = keepFace;
      ctx.fillText = function () { };
      const noText = timeIt(P.snakes) - floor;
      ctx.fillText = keepText;
      R.LOOK.headDisc = false;
      const noHead = timeIt(P.snakes) - floor;
      R.LOOK.headDisc = true;
      for (const s of w.snakes) s.boost = true;
      const allBoost = timeIt(P.snakes) - floor;
      for (const s of w.snakes) s.boost = false;

      // the sweeper layer splits by what kind of thing it paints: washes are whole
      // cell rects, the mark glyphs are strokes and shared-path fills, and the
      // numbers are one fillText per revealed cell. Stubs change the look: this
      // measures shape, it is not a proposal.
      const keepRect = ctx.fillRect, keepFill = ctx.fill;
      ctx.fillRect = function () { };
      const sweNoRect = timeIt(P.sweeper) - floor;
      ctx.fillRect = keepRect;
      ctx.stroke = function () { };
      const sweNoStroke = timeIt(P.sweeper) - floor;
      ctx.stroke = keepStroke;
      ctx.fill = function () { };
      const sweNoFill = timeIt(P.sweeper) - floor;
      ctx.fill = keepFill;
      ctx.fillText = function () { };
      const sweNoText = timeIt(P.sweeper) - floor;
      ctx.fillText = keepText;

      // how much of each pass's paint actually reaches the canvas
      const devW = WW * dpr, devH = HH * dpr;
      let cellsOn = 0, washPx = 0, pelletsOn = 0, glowPx = 0, corePx = 0, culled = 0;
      let flagsOn = 0, minesOn = 0, numsOn = 0;
      const c = sw.cell * dpr * zoom;
      for (let i = 0; i < sw.w * sw.h; i++) {
        if (sw.state[i] === 0) continue;
        const dx = dpr * (WW / 2 - camX * zoom) + dpr * zoom * (sw.ix0 + (i % sw.w)) * sw.cell;
        const dy = dpr * (HH / 2 - camY * zoom) + dpr * zoom * (sw.iy0 + Math.floor(i / sw.w)) * sw.cell;
        if (dx + c < 0 || dx > devW || dy + c < 0 || dy > devH) continue;
        cellsOn++;
        if (sw.state[i] === 2) flagsOn++;
        else if (sw.mine[i]) minesOn++;
        if (!sw.mine[i] && sw.adj[i] > 0) numsOn++;
        washPx += c * c;
      }
      for (const f of w.food) {
        if (f.eaten) continue;
        if (f.x < left || f.x > right || f.y < top || f.y > bottom) { culled++; continue; }
        pelletsOn++;
        glowPx += Math.PI * Math.pow(f.r * 2.1, 2);
        corePx += Math.PI * f.r * f.r;
      }

      let sum = 0;
      for (const n of seq) sum += cost[n];
      return { cost, sum, floor, frame: frameStats, draw: drawStats,
        snakes: { total: cost.snakes, body: cost.snakes - noStroke, face: cost.snakes - noFace,
                  label: cost.snakes - noText, head: cost.snakes - noHead, boost: allBoost - cost.snakes },
        sweeperSplit: { total: cost.sweeper, wash: cost.sweeper - sweNoRect,
                  strokes: cost.sweeper - sweNoStroke, sheets: cost.sweeper - sweNoFill,
                  numbers: cost.sweeper - sweNoText },
        cellsOn, washPx, flagsOn, minesOn, numsOn, pelletsOn, culled, glowPx, corePx, devW, devH, dpr, WW, HH, zoom,
        look: lookApplied,
        veilMask: (() => { let nq = 0; const gq = R._veilGrid; if (gq) for (let qc = 0; qc < gq.length; qc++) if (gq[qc]) nq++; return nq; })(),
        veilCells: (() => { const gq = R._veilGrid; return gq ? gq.length : 0; })(),
        playerPinned };
    })()
  `);

  const px = out.devW * out.devH;
  const f = out.draw.mean;
  console.log(`== ${key} — ${out.WW}x${out.HH} dpr ${out.dpr} zoom ${out.zoom} camera ${VIEWS[key].camera} reveal ${VIEWS[key].reveal} | look ${out.look.length ? out.look.join(' ') : 'shipped'}${fidelity ? ' | fidelity ' + fidelity : ''}${out.playerPinned ? ' (scene pins the fattest snake as the player)' : ''} ==`);
  console.log(`draw()            mean ${out.draw.mean.toFixed(3)}  p50 ${out.draw.p50.toFixed(2)}  p95 ${out.draw.p95.toFixed(2)}  max ${out.draw.max.toFixed(2)} ms`);
  console.log(`this frame        mean ${out.frame.mean.toFixed(3)}  p50 ${out.frame.p50.toFixed(2)}  p95 ${out.frame.p95.toFixed(2)}  max ${out.frame.max.toFixed(2)} ms   (the pass order replicated here)`);
  for (const n of ['snakes', 'sweeper', 'overlay', 'food', 'vignette', 'boundary', 'grid', 'background', 'effects']) {
    const v = out.cost[n];
    console.log(`  ${n.padEnd(10)} ${v.toFixed(3)} ms  ${(v / f * 100).toFixed(1)}% of frame`);
  }
  const s = out.snakes;
  console.log(`drawSnakes split: body strokes ${s.body.toFixed(3)} (${(s.body / s.total * 100).toFixed(0)}%) | head discs ${s.head.toFixed(3)} | face ${s.face.toFixed(3)} | nameplate ${s.label.toFixed(3)} | adding a boost glow to every snake +${s.boost.toFixed(2)}   (sub-splits under ~0.1 ms are at the instrument floor)`);
  const sws = out.sweeperSplit;
  console.log(`drawSweeper split: wash rects ${sws.wash.toFixed(3)} (${(sws.wash / sws.total * 100).toFixed(0)}%) | mark strokes ${sws.strokes.toFixed(3)} | glyph sheets ${sws.sheets.toFixed(3)} | numbers ${sws.numbers.toFixed(3)}   (the four overlap: a stubbed op retires what used it)`);
  console.log(`passes sum ${out.sum.toFixed(3)} ms (forced flush per pass, so this is not the frame)  |  readback floor ${out.floor.toFixed(3)} ms`);
  console.log(`workload: ${out.cellsOn} revealed cells on canvas = ${(out.washPx / px).toFixed(2)} canvas of wash | ${out.flagsOn} flags, ${out.minesOn} exposed mines, ${out.numsOn} number glyphs | ${out.pelletsOn} pellets painted, ${out.culled} culled = ${(out.glowPx / px).toFixed(2)} canvas of glow` +
    (out.veilCells ? ` | veil mask covers ${out.veilMask} of ${out.veilCells} cells, so only the marks under your own body are ghosted` : ''));
  await browser.close();
  console.log('');
}
