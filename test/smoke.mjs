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
let scoreDrift = 0, stepMs = 0;

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
    scoreDrift = Math.max(scoreDrift, Math.abs(s.score - s.mass));
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
console.log(`length stat drift: ${scoreDrift.toFixed(2)} (score vs mass, all snakes, whole match)`);
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

// helpers for the minefield tests: cell index <-> world centre of that cell
const sweeperCell = (w, i) => {
  const sw = w.sweeper;
  const lx = i % sw.w, ly = (i - lx) / sw.w;
  return [(sw.ix0 + lx + 0.5) * sw.cell, (sw.iy0 + ly + 0.5) * sw.cell];
};
const findCell = (w, pred) => {
  const sw = w.sweeper;
  for (let i = 0; i < sw.w * sw.h; i++) if (pred(w, i)) return i;
  return -1;
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

function testMutualKillCredit() {
  const w = arena();
  // Bot created first, as in a real game: its death resolves before the player's,
  // so at the player's resolution its killer is already dead. The player's death
  // must still name the snake — the death screen must not say "You hit the wall".
  const b = make(w, 0, -7, Math.PI, { mass: 40 });
  const a = make(w, 0, 7, 0, { player: true, mass: 40 });
  run(w, 40, () => { a.aim = 0; b.aim = Math.PI; });
  assert(a.dead && b.dead, 'a mutual crash kills both snakes');
  const mine = w.events.filter((e) => e.playerVictim);
  assert(mine.length === 1 && mine[0].killer === b.name && mine[0].killerId === b.id,
    'a snake kill is credited to the snake, not the wall');
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
  const massBefore = s.mass, scoreBefore = s.score, foodBefore = w.food.length;
  // keep the field empty so the only food that appears is the length burned by boosting
  run(w, 180, () => { w.food.length = 0; s.aim = 0; s.boost = true; });
  assert(s.mass < massBefore - 10, 'boosting burns your own length');
  assert(s.score < scoreBefore - 10, 'the length stat falls while boosting, not just the mass');
  assert(Math.abs(s.score - s.mass) < 0.5, 'the length stat tracks the real body, never floats above it');
  assert(w.food.length > foodBefore + 5, 'the burned length is paid out as food behind you');
  const thin = make(w, 0, 900, 0, { mass: 8 });
  const thinBefore = thin.mass;
  run(w, 30, () => { w.food.length = 0; thin.aim = 0; thin.boost = true; });
  assert(Math.abs(thin.mass - thinBefore) < 0.5, 'too thin to boost — a starving snake burns nothing');
}

function testMinefield() {
  const w = arena();
  const sw = w.sweeper;
  const total = sw.minesTotal + sw.safeTotal;
  assert(total > 1200, 'the minefield covers the grid over the arena');
  assert(Math.abs(sw.minesTotal / total - w.diffCfg.mines) < 0.03, 'mine density lands on the difficulty setting');
  let wrong = 0;
  for (let i = 0; i < sw.w * sw.h; i++) {
    if (!sw.inside[i]) continue;
    let cnt = 0;
    const lx = i % sw.w, ly = (i - lx) / sw.w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = lx + dx, ny = ly + dy;
      if (nx < 0 || ny < 0 || nx >= sw.w || ny >= sw.h) continue;
      if (sw.mine[ny * sw.w + nx]) cnt++;
    }
    if (sw.adj[i] !== cnt) wrong++;
  }
  assert(wrong === 0, 'every cell number matches the adjacent-mine count');
}

function testDigSafe() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const i = findCell(w, (ww, ii) => ww.sweeper.inside[ii] && !ww.sweeper.mine[ii] && ww.sweeper.adj[ii] > 0);
  const [x, y] = sweeperCell(w, i);
  assert(w.digCell(s, x, y) === 'dig', 'digging a safe cell reveals it');
  assert(w.sweeper.revealed === 1, 'a numbered cell reveals only itself — no cascade');
  assert(!s.dead, 'digging a safe cell is safe');
}

function testBoom() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  // spend the free safe probe first, so digging a mine is allowed at all
  const probe = findCell(w, (ww, ii) => ww.sweeper.inside[ii] && !ww.sweeper.mine[ii] && ww.sweeper.adj[ii] > 0);
  const [px, py] = sweeperCell(w, probe);
  assert(w.digCell(s, px, py) === 'dig', 'the first dig opens a safe cell');
  const i = findCell(w, (ww, ii) => ww.sweeper.mine[ii]);
  const [x, y] = sweeperCell(w, i);
  w.effects.length = 0;
  assert(w.digCell(s, x, y) === 'boom', 'digging a mine detonates it');
  assert(s.dead, 'the digger dies from its own dig');
  assert(w.events.some((e) => e.cause === 'mine'), 'the death is credited to the mine, not the wall');
  assert(w.effects.length >= 2, 'the blast and the death both make visible effects');
  assert(w.sweeper.state[i] === 1, 'the mine that went off shows itself');
}

function testFirstDigSafe() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const sw = w.sweeper;
  const i = findCell(w, (ww, ii) => ww.sweeper.mine[ii]);
  const [x, y] = sweeperCell(w, i);
  const before = sw.minesTotal;
  assert(w.digCell(s, x, y) === 'dig', 'the first dig never detonates, even on a mine');
  assert(!s.dead, 'the snake survives its first dig');
  assert(sw.state[i] === 1, 'the probed cell opens as safe');
  assert(sw.minesTotal === before, 'the mine was moved aside, not deleted');
  const j = findCell(w, (ww, ii) => ww.sweeper.mine[ii] && ww.sweeper.state[ii] === 0);
  const [jx, jy] = sweeperCell(w, j);
  assert(w.digCell(s, jx, jy) === 'boom', 'protection is only the first dig — the second detonates');
  assert(s.dead, 'and the snake dies on it as usual');
}

function testFlagGuard() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const i = findCell(w, (ww, ii) => ww.sweeper.inside[ii] && !ww.sweeper.mine[ii]);
  const [x, y] = sweeperCell(w, i);
  assert(w.flagCell(s, x, y) === 'flag', 'flagging marks the cell');
  assert(w.digCell(s, x, y) === null, 'a flagged cell cannot be dug');
  assert(w.sweeper.state[i] === 2, 'the cell stays hidden-flagged, nothing secretly revealed');
  assert(w.flagCell(s, x, y) === 'unflag', 'flagging again lifts the flag');
}

function testChord() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const i = findCell(w, (ww, ii) => {
    const s2 = ww.sweeper;
    if (!s2.inside[ii] || s2.mine[ii] || s2.adj[ii] !== 1) return false;
    const lx = ii % s2.w, ly = (ii - lx) / s2.w;
    if (lx < 1 || ly < 1 || lx >= s2.w - 1 || ly >= s2.h - 1) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!s2.inside[(ly + dy) * s2.w + lx + dx]) return false;
    }
    return true;
  });
  assert(i >= 0, 'a clean single-mine cell exists to chord');
  const [x, y] = sweeperCell(w, i);
  assert(w.digCell(s, x, y) === 'dig', 'first dig opens the 1');
  const sw = w.sweeper;
  const lx = i % sw.w, ly = (i - lx) / sw.w;
  let mineN = -1;
  for (let dy = -1; dy <= 1 && mineN < 0; dy++) for (let dx = -1; dx <= 1 && mineN < 0; dx++) {
    if (!dx && !dy) continue;
    const j = (ly + dy) * sw.w + lx + dx;
    if (sw.mine[j]) mineN = j;
  }
  const [fx, fy] = sweeperCell(w, mineN);
  assert(w.flagCell(s, fx, fy) === 'flag', 'the mine next to it gets flagged');
  const before = sw.revealed;
  assert(w.digCell(s, x, y) === 'chord', 'digging on a satisfied number chords');
  assert(sw.revealed === before + 7, 'the chord opens the remaining seven safe cells');
  assert(!s.dead, 'chording with the right flags is safe');
}

function testClearBoard() {
  const w = arena();
  const s = make(w, 0, 0, 0);
  const sw = w.sweeper;
  let digs = 0;
  while (!sw.won) {
    const i = findCell(w, (ww, ii) => ww.sweeper.inside[ii] && !ww.sweeper.mine[ii] && ww.sweeper.state[ii] === 0);
    if (i < 0) break;
    const [x, y] = sweeperCell(w, i);
    w.digCell(s, x, y);
    digs++;
  }
  assert(sw.won, 'the board can be fully cleared with safe digging');
  assert(sw.revealed === sw.safeTotal, 'every safe cell ends up revealed');
  assert(w.events.some((e) => e.type === 'sweeper'), 'the clear broadcasts an event for the UI');
}

function testSpawnSafe() {
  const w = arena();
  const s = w.spawnSnake({ name: 'P', player: true, bot: false });
  const i = w.sweeper.at(s.x(), s.y());
  assert(i >= 0 && !w.sweeper.mine[i], 'a snake never spawns on a mine cell');
}

console.log('--- rule tests ----------------------------------------------');
testCutOff();
testHeadOn();
testMutualKillCredit();
testWall();
testGrowth();
testBoost();
testMinefield();
testDigSafe();
testBoom();
testFirstDigSafe();
testFlagGuard();
testChord();
testClearBoard();
testSpawnSafe();

assert(alive.length >= world.diffCfg.bots - 2, 'arena stays stocked with snakes');
assert(deaths > 0, 'snakes die (collisions and the wall are firing)');
assert(board[0].mass > 20, 'snakes grow well past spawn size');
assert(alive.every((s) => s.pts.length >= 2), 'every snake has a body');
assert(alive.every((s) => Math.hypot(s.x(), s.y()) < world.radius + 60), 'nobody lives outside the arena');
assert(world.food.length > 400, 'food stays on the field');
assert(scoreDrift < 0.01, 'the length stat never drifts from the real body (boosting included)');
assert(cuts > wallDeaths, 'the bots mostly die to each other, not to the ring');
assert(segPeak > 60, 'bodies get long enough to be a real threat');
assert(stepMs / STEPS < 8.0, 'world.step fits comfortably in a 16.6ms frame');
console.log('----------------------------------------------------------------');
console.log('PASS');
