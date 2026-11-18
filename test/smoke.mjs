/* Headless smoke test for the Slither Local simulation.
 * Loads js/core.js into a sandbox (no DOM), runs a long match, and asserts the
 * world behaves: nothing NaNs, snakes eat, snakes die, food stays stocked.
 *   node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'js', 'core.js'), 'utf8');

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const S = sandbox.Slither;

if (!S) throw new Error('core.js did not expose Slither');

const STEPS = 60 * 90;               // 90 seconds of play
const DT = 1 / 60;

const world = new S.World({ difficulty: 'ruthless' });
world.spawnSnake({ name: 'Tester', skin: S.SKINS[0], player: true, bot: false, mass: 12 });

let deaths = 0, respawns = 0, foodPeak = 0, segPeak = 0, topMass = 0;
let wallDeaths = 0, cuts = 0, mutual = 0;
let stepMs = 0;

for (let i = 0; i < STEPS; i++) {
  // a crude stand-in for a human: head for the nearest food, boost in bursts.
  // always read world.player — respawns replace it.
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
    world.spawnSnake({ name: 'Tester', skin: S.SKINS[1], player: true, bot: false, mass: 12 });
    respawns++;
  }

  const t = performance.now();
  world.step(DT);
  stepMs += performance.now() - t;

  for (const s of world.snakes) {
    if (!Number.isFinite(s.x()) || !Number.isFinite(s.y()) || !Number.isFinite(s.mass) || !Number.isFinite(s.r)) {
      throw new Error(`non-finite state on step ${i}: ${s.name} ${s.x()} ${s.y()} ${s.mass} ${s.r}`);
    }
    for (const p of s.pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`NaN body point on step ${i}`);
    }
    segPeak = Math.max(segPeak, s.pts.length);
    topMass = Math.max(topMass, s.mass);
  }
  for (const e of world.events) { if (e.killer) cuts++; else wallDeaths++; }
  deaths += world.events.length;
  foodPeak = Math.max(foodPeak, world.food.length);
  world.events.length = 0;
}

const alive = world.snakes.filter((s) => !s.dead);
const board = world.leaderboard(10);
const player = world.snakes.filter((s) => s.player).pop();

console.log('--- Slither Local smoke test -------------------------------');
console.log(`simulated      : ${(STEPS * DT).toFixed(0)}s of game time`);
console.log(`world.step()   : ${stepMs.toFixed(0)}ms total, ${(stepMs / STEPS).toFixed(3)}ms per step (16.6ms = 1 frame)`);
console.log(`snakes alive   : ${alive.length} (cap ${world.diffCfg.bots})`);
console.log(`deaths         : ${deaths}  (cut off by a snake: ${cuts}, hit the ring: ${wallDeaths}, player respawns: ${respawns})`);
console.log(`food on field  : ${world.food.length} (peak ${foodPeak})`);
console.log(`longest body   : ${segPeak} segments, fattest snake ${Math.round(topMass)}`);
if (player) console.log(`player         : mass ${Math.round(player.mass)} score ${Math.round(player.score)} kills ${player.kills} rank ${world.rank(player)}`);
console.log('leaderboard    :');
board.forEach((b, i) => console.log(`   ${String(i + 1).padStart(2)}. ${b.name} — ${b.mass}`));

// ------------------------------------------------------------- rule tests
// Deterministic one-rule-at-a-time checks, with only the snakes under test alive.
const assert = (cond, label) => {
  if (!cond) throw new Error('FAILED: ' + label);
  console.log('ok  : ' + label);
};

function arena() {
  const w = new S.World({ difficulty: 'chill' });
  w.snakes.length = 0;
  w.player = null;
  w.food.length = 0;
  return w;
}
const make = (w, x, y, angle, opts = {}) => {
  const s = new S.Snake({ x, y, angle, bot: false, mass: 12, skin: S.SKINS[0], ...opts });
  s.grace = 0;
  w.snakes.push(s);
  return s;
};
const run = (w, steps, per) => {
  for (let i = 0; i < steps; i++) { if (per) per(i, w); w.step(DT); }
};

function testCutOff() {
  const w = arena();
  // A trails a straight body along y = 0; B charges in from behind, boosted, at y = 14.
  const a = make(w, 0, 0, 0, { player: true, mass: 40 });
  const b = make(w, -260, 14, 0, { mass: 60 });
  run(w, 200, () => { a.aim = 0; b.aim = 0; b.boost = true; });
  assert(b.dead, 'running into another snake body kills the runner');
  assert(!a.dead, 'the snake whose body was hit survives');
  assert(a.kills === 1, 'the cut-off counts as a kill for the body owner');
}

function testHeadOn() {
  const w = arena();
  const a = make(w, -300, 0, 0);
  const b = make(w, 300, 0, Math.PI);
  run(w, 200, () => { a.aim = 0; b.aim = Math.PI; });
  assert(a.dead && b.dead, 'head-to-head is mutual destruction');
}

function testWall() {
  const w = arena();
  const s = make(w, w.radius - 200, 0, 0);
  run(w, 200, () => { s.aim = 0; });
  assert(s.dead, 'touching the red ring kills you');
  assert(w.events.every((e) => !e.killer), 'a wall death is credited to nobody');
}

function testGrowth() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const before = s.mass, segsBefore = s.pts.length;
  w.spawnFood(24, 0, 40, 7);                               // a fat pellet right at the mouth
  run(w, 40, () => { s.aim = 0; });
  assert(s.mass > before + 30, 'eating pellets adds length');
  assert(s.pts.length > segsBefore, 'the body grows to match the new length');
  assert(s.r > 10, 'the body gets fatter as it grows');
}

function testBoost() {
  const w = arena();
  const s = make(w, 0, 0, 0, { mass: 120 });
  const massBefore = s.mass, foodBefore = w.food.length;
  // keep the field empty so the only food that appears is the length burned by boosting
  run(w, 180, () => { w.food.length = 0; s.aim = 0; s.boost = true; });
  assert(s.mass < massBefore - 10, 'boosting burns your own length');
  assert(w.food.length > foodBefore + 5, 'the burned length is paid out as food behind you');
  const thin = make(w, 0, 900, 0, { mass: 8 });
  const thinBefore = thin.mass;
  run(w, 30, () => { w.food.length = 0; thin.aim = 0; thin.boost = true; });
  assert(Math.abs(thin.mass - thinBefore) < 0.5, 'too thin to boost — a starving snake burns nothing');
}

console.log('--- rule tests ----------------------------------------------');
testCutOff();
testHeadOn();
testWall();
testGrowth();
testBoost();

assert(alive.length >= world.diffCfg.bots - 2, 'arena stays stocked with snakes');
assert(deaths > 0, 'snakes die (collisions and the wall are firing)');
assert(board[0].mass > 20, 'snakes grow well past spawn size');
assert(alive.every((s) => s.pts.length >= 2), 'every snake has a body');
assert(alive.every((s) => Math.hypot(s.x(), s.y()) < world.radius + 60), 'nobody lives outside the arena');
assert(world.food.length > 400, 'food stays on the field');
assert(cuts > wallDeaths, 'the bots mostly die to each other, not to the ring');
assert(segPeak > 60, 'bodies get long enough to be a real threat');
assert(stepMs / STEPS < 8.0, 'world.step fits comfortably in a 16.6ms frame');
console.log('----------------------------------------------------------------');
console.log('PASS');
