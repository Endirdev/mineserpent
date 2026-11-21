/* Headless performance benchmark for the Mineserpent simulation.
 *
 * Two fixed scenarios with a seeded PRNG, so runs are comparable across
 * commits:
 *   match   — a normal 90s Ruthless match with an active player
 *   stress  — a late-game board: everyone force-fed past 600 mass (bodies
 *             hit the segment cap), the worst case world.step ever sees
 *
 * Reports per-step wall time (mean / p50 / p95 / max) plus the load the
 * numbers were earned under. Run with --baseline to append the result to
 * test/bench-baseline.json for later comparison.
 *   node test/bench.mjs [--baseline] [--reps N]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'js', 'core.js'), 'utf8');
const BASELINE_FILE = join(here, 'bench-baseline.json');

// mulberry32: a small seeded PRNG, swapped in for Math.random so every run
// of a scenario plays the same match and timings can be compared honestly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import vm from 'node:vm';

function loadWorld(seed, difficulty) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // Math is a context intrinsic, not a sandbox property: swap the PRNG inside the context
  vm.runInContext('Math.random = (' + mulberry32.toString() + ')(' + seed + ')', sandbox);
  const world = new sandbox.Mineserpent.World({ difficulty });
  world.spawnSnake({ name: 'Bench', skin: sandbox.Mineserpent.SKINS[0], player: true, bot: false, mass: 12 });
  return world;
}

const DT = 1 / 60;

// the same crude human the smoke test drives: head for the nearest pellet,
// boost in bursts, respawn when dead
function playFrame(world, i) {
  const me = world.player;
  if (me && !me.dead) {
    let best = null, bd = 1e9;
    const probe = world.foodGrid.query(me.x(), me.y(), 600);
    for (let f = 0; f < probe.length; f++) {
      const fd = Math.hypot(probe[f].x - me.x(), probe[f].y - me.y());
      if (fd < bd) { bd = fd; best = probe[f]; }
    }
    if (best) me.aim = Math.atan2(best.y - me.y(), best.x - me.x());
    me.boost = (i % 150) < 45 && me.mass > 40;
  } else if (world.snakes.some((s) => s.player && s.dead) && i % 300 === 0) {
    world.snakes = world.snakes.filter((s) => !s.dead);
    world.spawnSnake({ name: 'Bench', player: true, bot: false, mass: 12 });
  }
}

function runScenario(name, seed, difficulty, steps, per) {
  const world = loadWorld(seed, difficulty);
  const times = new Float64Array(steps);
  let segTotal = 0, foodTotal = 0;
  for (let i = 0; i < steps; i++) {
    if (per) per(world, i);
    playFrame(world, i);
    const t = performance.now();
    world.step(DT);
    times[i] = performance.now() - t;
    for (const s of world.snakes) if (!s.dead) segTotal += s.pts.length;
    foodTotal += world.food.length;
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const alive = world.snakes.filter((s) => !s.dead);
  return {
    scenario: name,
    steps,
    meanMs: mean,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    maxMs: sorted[sorted.length - 1],
    meanSegs: segTotal / steps,
    meanFood: foodTotal / steps,
    aliveEnd: alive.length,
  };
}

// warm up the JIT the same way for every run, then measure
for (let w = 0; w < 3; w++) runScenario('warmup', 999 + w, 'classic', 600, null);

const scenarios = [
  ['match', () => runScenario('match', 12345, 'ruthless', 60 * 90, null)],
  ['stress', () => runScenario('stress', 24680, 'ruthless', 60 * 60, (world, i) => {
    // after 10s of normal play, force everyone huge: max-length bodies,
    // fat radii, and the collision/steer cost that comes with them
    if (i === 600) for (const s of world.snakes) if (!s.dead) { s.mass = 900; s.score = 900; }
    if (i > 600 && i % 300 === 0) for (const s of world.snakes) if (!s.dead) { s.mass = 900; }
  })],
];

const REPS = Number(process.argv.find((a) => a.startsWith('--reps='))?.slice(7) || 5);
const wanted = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results = [];
for (const [name, make] of scenarios) {
  if (wanted && name !== wanted) continue;
  const reps = [];
  for (let r = 0; r < REPS; r++) reps.push(make());
  const med = (key) => {
    const v = reps.map((x) => x[key]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const first = reps[0];
  results.push({
    scenario: first.scenario,
    steps: first.steps,
    meanMs: med('meanMs'),
    p50Ms: med('p50Ms'),
    p95Ms: med('p95Ms'),
    maxMs: med('maxMs'),
    meanSegs: med('meanSegs'),
    meanFood: med('meanFood'),
  });
}

console.log('--- Mineserpent benchmark --------------------------');
console.log(`reps per scenario: ${REPS} (median reported)`);
for (const r of results) {
  console.log(`${r.scenario.padEnd(8)} mean ${r.meanMs.toFixed(3)}ms  p50 ${r.p50Ms.toFixed(3)}ms  p95 ${r.p95Ms.toFixed(3)}ms  max ${r.maxMs.toFixed(3)}ms   [~${r.meanSegs.toFixed(0)} body pts, ${r.meanFood.toFixed(0)} pellets]`);
}

const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : null;
if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ stamp: new Date().toISOString(), results }, null, 2));
  console.log('saved as the baseline -> test/bench-baseline.json');
} else if (baseline) {
  console.log('--- vs baseline ------------------------------------------------');
  for (const r of results) {
    const b = baseline.results.find((x) => x.scenario === r.scenario);
    if (!b) { console.log(`${r.scenario}: no baseline entry`); continue; }
    const d = ((r.meanMs - b.meanMs) / b.meanMs) * 100;
    console.log(`${r.scenario.padEnd(8)} baseline ${b.meanMs.toFixed(3)}ms -> now ${r.meanMs.toFixed(3)}ms  (${d >= 0 ? '+' : ''}${d.toFixed(1)}%)`);
  }
}
console.log('----------------------------------------------------------------');
