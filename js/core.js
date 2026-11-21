/* Mineserpent — core simulation.
 * Pure logic: no DOM, no canvas. Runs in the browser and in Node (see test/smoke.mjs).
 * Exposes a single global: Mineserpent
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- tuning
  var CFG = {
    world: { radius: 2600 },
    cell: 120,           // grid step: drawGrid lines and the minesweeper board share it

    food: {
      target: 1500,        // pellets kept on the field at all times
      minR: 3.2, maxR: 7.0,
      minValue: 0.8, maxValue: 2.6
    },

    snake: {
      baseMass: 12,        // mass when spawned
      startMass: 12,
      segSpacing: 6.5,     // distance between body points
      segBase: 12,         // body points at mass 0
      segPerMass: 0.9,     // body points per point of mass
      growEase: 90,        // body points the tail may gain per second — length eases in
      maxSegs: 900,        // hard cap for performance
      speed: 118,          // px/s at mass 20
      boostMul: 2.05,
      boostMinMass: 20,    // need this much mass to boost
      boostDrain: 4.0,     // mass burned per second while boosting
      graceTime: 1.2       // seconds of spawn invulnerability
    },

    bot: {
      count: 35,
      scanR: 430,          // how far a bot looks for enemies
      probeLen: 320,       // how far a bot projects its heading
      maxThreats: 34,      // enemy segments considered per steering decision
      foodScanR: 300,      // how far a bot hunts pellets
      headings: 17         // candidate headings per steering decision
    }
  };

  var DIFFICULTY = {
    chill:   { label: 'Chill',   bots: 26, lookMul: 0.75, turnMul: 0.90, boostAggro: 0.35, massMul: 0.85, mines: 0.09 },
    classic: { label: 'Classic', bots: 35, lookMul: 1.00, turnMul: 1.00, boostAggro: 0.60, massMul: 1.00, mines: 0.12 },
    ruthless:{ label: 'Ruthless',bots: 44, lookMul: 1.30, turnMul: 1.18, boostAggro: 0.85, massMul: 1.20, mines: 0.15 }
  };

  var SKINS = [
    { name: 'Ember',   a: '#ff5d5d', b: '#ffd166' },
    { name: 'Tide',    a: '#3ec6ff', b: '#eafcff' },
    { name: 'Venom',   a: '#7bff6b', b: '#0f8f4e' },
    { name: 'Amethyst',a: '#c47bff', b: '#ff7bd3' },
    { name: 'Solar',   a: '#ffb020', b: '#fff3b0' },
    { name: 'Void',    a: '#6c7bff', b: '#2a2f6b' },
    { name: 'Rose',    a: '#ff6bb5', b: '#ffd9ef' },
    { name: 'Frost',   a: '#9fe8ff', b: '#4a7ea8' },
    { name: 'Toxic',   a: '#c8ff3e', b: '#3f7a00' },
    { name: 'Copper',  a: '#ff8a4c', b: '#7a3300' }
  ];

  var BOT_NAMES = ['Slinky', 'Noodle', 'Mamba', 'Anaconda', 'Kobra', 'Coil', 'Twisty', 'Zigzag',
    'Rattlesnake', 'Hydra', 'Boop', 'Wiggles', 'Pythona', 'Slurp', 'Biscuit', 'Viperine',
    'Loopdeloop', 'Spaghetti', 'Garden', 'Cobra Kai', 'Wormwood', 'Longboi', 'Zigzag', 'Nagini',
    'Sidewinder', 'Bungee', 'Loopy', 'Slinky Malinky', 'Twister', 'Wormhole', 'Escula', 'Fang'];

  function botName() {
    var base = BOT_NAMES[randInt(0, BOT_NAMES.length - 1)];
    return base + ' ' + randInt(1, 99);
  }

  // ---------------------------------------------------------------- utils
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // Uniform spatial hash over the arena. Flat-array backed: a cell is addressed
  // by index instead of a Map key, and clear() empties only the buckets that
  // have been touched since the last clear — the rebuild-every-frame pattern
  // used to spend half the frame in Map bookkeeping.
  function Grid(cell, radius) {
    this.cell = cell;
    this.span = Math.ceil(2 * radius / cell) + 2;   // cells per axis, with padding
    this.half = this.span >> 1;
    this.bias = this.half * cell;                   // shifts world coords positive
    this.inv = 1 / cell;                            // one division, used as a multiply
    this.cells = new Array(this.span * this.span);  // buckets allocated lazily
    this.live = [];                                 // every bucket ever created
  }
  Grid.prototype.clear = function () {
    var live = this.live;
    for (var i = 0; i < live.length; i++) live[i].length = 0;
  };
  // Truncated offsets, not floor: insert and each use the identical formula, so
  // a cell-edge epsilon lands in the same bucket for both, and the clamps make
  // any negative or out-of-range result land on the edge bucket they would have.
  Grid.prototype.index = function (x, y) {
    var span = this.span, inv = this.inv, bias = this.bias;
    var ix = ((x + bias) * inv) | 0;
    var iy = ((y + bias) * inv) | 0;
    if (ix < 0) ix = 0; else if (ix >= span) ix = span - 1;
    if (iy < 0) iy = 0; else if (iy >= span) iy = span - 1;
    return iy * span + ix;
  };
  Grid.prototype.insert = function (x, y, item) {
    var i = this.index(x, y);
    var bucket = this.cells[i];
    if (bucket) bucket.push(item);
    else { bucket = [item]; this.cells[i] = bucket; this.live.push(bucket); }
    return item;
  };
  // Visit every item in cells overlapping a square around (x,y) without copying
  // buckets into an array first. Hot paths filter aggressively, so materializing
  // the full result was pure overhead.
  Grid.prototype.each = function (x, y, r, fn) {
    var inv = this.inv, bias = this.bias, span = this.span, cells = this.cells;
    var x0 = ((x - r + bias) * inv) | 0, x1 = ((x + r + bias) * inv) | 0;
    var y0 = ((y - r + bias) * inv) | 0, y1 = ((y + r + bias) * inv) | 0;
    if (x0 < 0) x0 = 0; if (x1 >= span) x1 = span - 1;
    if (y0 < 0) y0 = 0; if (y1 >= span) y1 = span - 1;
    for (var ix = x0; ix <= x1; ix++) {
      for (var iy = y0; iy <= y1; iy++) {
        var bucket = cells[iy * span + ix];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  };
  // Collect items in cells overlapping a square around (x,y). Returns a reused array.
  var _scratch = [];
  Grid.prototype.query = function (x, y, r) {
    _scratch.length = 0;
    this.each(x, y, r, function (it) { _scratch.push(it); });
    return _scratch;
  };

  // ---------------------------------------------------------------- snake
  // Continuous body plan: segsFor is the exact segment count a mass implies, and its
  // fraction is how far the tail tip reaches past the last joint. Length therefore
  // grows at the mass's own rate, instead of popping whole segments onto the tail.
  function segsFor(mass) {
    return Math.min(CFG.snake.maxSegs, CFG.snake.segBase + mass * CFG.snake.segPerMass);
  }
  function massToSegs(mass) {
    return Math.round(segsFor(mass));
  }
  function massToRadius(mass) {
    return 6 + Math.pow(mass, 0.34) * 1.9;
  }
  function massToSpeed(mass) {
    return clamp(CFG.snake.speed * Math.pow(20 / mass, 0.06), 96, CFG.snake.speed);
  }
  function massToTurn(mass, turnMul) {
    return clamp(3.7 * Math.pow(18 / mass, 0.22) * turnMul, 0.85, 4.6);
  }

  var nextId = 1;

  function Snake(opts) {
    var x = opts.x, y = opts.y;
    this.id = nextId++;
    this.name = opts.name || 'Snake';
    this.skin = opts.skin || SKINS[0];
    this.bot = opts.bot !== false;
    this.player = !!opts.player;

    this.angle = opts.angle !== undefined ? opts.angle : rand(-Math.PI, Math.PI);
    this.aim = this.angle;
    this.boost = false;
    this.mass = opts.mass || CFG.snake.startMass;
    this.score = this.mass;      // current length — rises with food, falls when boosting burns it
    this.r = massToRadius(this.mass);
    this.speed = massToSpeed(this.mass);
    this.kills = 0;
    this.eaten = 0;
    this.digsMade = 0;     // dig counter: the first dig of a run never hits a mine
    this.dead = false;
    this.grace = CFG.snake.graceTime;
    this.boostWish = false;
    this.think = 0;
    this.personality = rand(0, 1);   // 0 = skittish, 1 = aggressive

    // body points, head first. px/py hold the position at the start of the
    // last physics step; the painter interpolates between them so a 144Hz
    // screen sees smooth motion even though the simulation runs at 60Hz.
    this.pts = [];
    this.reach = 0;      // fractional growth: how far the tail tip reaches past its joint
    this.grown = segsFor(this.mass);   // eased body length, in segments
    var n = massToSegs(this.mass);
    for (var i = 0; i < n; i++) {
      var px = x - Math.cos(this.angle) * i * CFG.snake.segSpacing;
      var py = y - Math.sin(this.angle) * i * CFG.snake.segSpacing;
      this.pts.push({ x: px, y: py, px: px, py: py });
    }
  }

  Snake.prototype.lengthUnits = function () {
    return (this.pts.length - 1) * CFG.snake.segSpacing;
  };

  // ---------------------------------------------------------------- world
  function World(opts) {
    opts = opts || {};
    this.diff = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'classic';
    this.diffCfg = DIFFICULTY[this.diff];
    this.radius = CFG.world.radius;
    this.cell = CFG.cell;
    this.sweeper = this.buildSweeper();   // the grid doubles as a minefield

    this.snakes = [];
    this.food = [];
    this.effects = [];
    this.events = [];
    this.foodGrid = new Grid(140, CFG.world.radius);
    this.segGrid = new Grid(110, CFG.world.radius);
    this.segPool = [];
    this.player = null;
    this.time = 0;

    for (var i = 0; i < CFG.food.target; i++) this.spawnFood();
    for (var b = 0; b < this.diffCfg.bots; b++) this.spawnSnake({});
  }

  World.prototype.spawnFood = function (x, y, value, radius) {
    var f;
    if (x === undefined) {
      var a = rand(-Math.PI, Math.PI);
      var d = Math.sqrt(Math.random()) * (this.radius * 0.97);
      x = Math.cos(a) * d; y = Math.sin(a) * d;
      value = rand(CFG.food.minValue, CFG.food.maxValue);
      radius = CFG.food.minR + (value - CFG.food.minValue) / (CFG.food.maxValue - CFG.food.minValue) * (CFG.food.maxR - CFG.food.minR);
    }
    f = { x: x, y: y, v: value, r: radius, hue: randInt(0, 3) };
    this.food.push(f);
    return f;
  };

  // Find a roomy spot to appear in, then add a snake (a bot by default).
  World.prototype.spawnSnake = function (opts) {
    var best = null, bestScore = -Infinity;
    for (var tries = 0; tries < 24; tries++) {
      var a = rand(-Math.PI, Math.PI);
      var d = Math.sqrt(Math.random()) * (this.radius * 0.82);
      var x = Math.cos(a) * d, y = Math.sin(a) * d;
      var near = 0;
      for (var i = 0; i < this.snakes.length; i++) {
        var s = this.snakes[i];
        if (s.dead) continue;
        var sdx = s.x() - x, sdy = s.y() - y;
        var sd2 = sdx * sdx + sdy * sdy;
        if (sd2 < 270400) near += 520 - Math.sqrt(sd2);
      }
      var score = -near + Math.sqrt(x * x + y * y) * 0.05;
      if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
    }
    var mass = opts.mass || (CFG.snake.startMass * (0.7 + Math.random() * 0.9) * this.diffCfg.massMul);
    var s = new Snake({
      x: best.x, y: best.y,
      name: opts.name || botName(),
      skin: opts.skin || SKINS[randInt(0, SKINS.length - 1)],
      mass: Math.max(CFG.snake.startMass, mass),
      bot: opts.bot, player: opts.player
    });
    this.snakes.push(s);
    if (opts.player) this.player = s;
    if (opts.player) this.sweeperMakeSafe(best.x, best.y);   // never spawn on a mine
    return s;
  };

  Snake.prototype.x = function () { return this.pts[0].x; };
  Snake.prototype.y = function () { return this.pts[0].y; };

  // ---------------------------------------------------------------- steering
  // Pick the safest, most profitable heading by scoring candidate angles.
  // Everything a heading needs is precomputed once per decision — threat
  // vectors relative to the head, pellet weights, and unit aim vectors —
  // so the 17-heading loop is pure multiply-adds instead of recomputing
  // the same distances and normalizations seventeen times over.
  function steerBot(w, s, dt) {
    var cfg = CFG.bot, d = w.diffCfg;
    var scanR = cfg.scanR * d.lookMul * (0.8 + s.personality * 0.5);
    var probeLen = cfg.probeLen * d.lookMul;
    var sx = s.x(), sy = s.y();

    // 1. nearby enemy body segments (threats), as vectors relative to the head
    var threats = [];
    w.segGrid.each(sx, sy, scanR + 60, function (it) {
      if (it.owner === s) return;
      var tvx = it.x - sx, tvy = it.y - sy;
      var td2 = tvx * tvx + tvy * tvy;
      var lim = scanR + it.r;
      if (td2 > lim * lim) return;
      threats.push({ vx: tvx, vy: tvy, need: 0, d2: td2, r: it.r });
    });
    // keep only the closest ones — the body is dense, the near part is what kills you
    if (threats.length > cfg.maxThreats) {
      threats.sort(function (a, b) { return a.d2 - b.d2; });
      threats.length = cfg.maxThreats;
    }
    var safeRad = s.r + 26;
    for (var t0 = 0; t0 < threats.length; t0++) threats[t0].need = safeRad + threats[t0].r;

    // 2. food to eat (capped: a bot only weighs the handful of pellets it can reach soon).
    // each pellet collapses to a single weight times the heading dot product.
    var bites = [];
    var scanR2 = cfg.foodScanR * cfg.foodScanR;
    w.foodGrid.each(sx, sy, cfg.foodScanR, function (fd) {
      if (bites.length >= 22) return;
      var fx0 = fd.x - sx, fy0 = fd.y - sy;
      var d2f = fx0 * fx0 + fy0 * fy0;
      if (d2f < scanR2) {
        var fl = Math.sqrt(d2f) || 1;
        bites.push({ x: fx0, y: fy0, fl: fl, w: fd.v * 26 * (1 - fl / cfg.foodScanR) / fl });
      }
    });

    // 3. prey: a smaller snake worth hunting
    var prey = null, preyD2 = Infinity;
    for (var p = 0; p < w.snakes.length; p++) {
      var o = w.snakes[p];
      if (o === s || o.dead || o.grace > 0) continue;
      if (o.mass < s.mass * 0.8) {
        var pdx = o.x() - sx, pdy = o.y() - sy;
        var pd2 = pdx * pdx + pdy * pdy;
        if (pd2 < 810000 && pd2 < preyD2) { preyD2 = pd2; prey = o; }
      }
    }
    // ...and a hunter worth fleeing
    var hunter = null, hunterD2 = Infinity;
    for (var h = 0; h < w.snakes.length; h++) {
      var q = w.snakes[h];
      if (q === s || q.dead || q.grace > 0) continue;
      if (q.mass > s.mass * 1.25) {
        var hdx = q.x() - sx, hdy = q.y() - sy;
        var hd2 = hdx * hdx + hdy * hdy;
        if (hd2 < 490000 && hd2 < hunterD2) { hunterD2 = hd2; hunter = q; }
      }
    }
    var preyD = Math.sqrt(preyD2), hunterD = Math.sqrt(hunterD2);

    // unit aim vectors for the directional rewards: constant across headings
    var huntX = 0, huntY = 0, huntW = 0;
    if (prey) {
      var ipx = prey.x() + Math.cos(prey.angle) * preyD * 0.32 - sx;
      var ipy = prey.y() + Math.sin(prey.angle) * preyD * 0.32 - sy;
      var il = Math.sqrt(ipx * ipx + ipy * ipy) || 1;
      huntX = ipx / il; huntY = ipy / il;
      huntW = 26 + s.personality * 34;
    }
    var fleeX = 0, fleeY = 0, fleeW = 0;
    if (hunter) {
      var hx0 = sx - hunter.x(), hy0 = sy - hunter.y();
      var hl = Math.sqrt(hx0 * hx0 + hy0 * hy0) || 1;
      fleeX = hx0 / hl; fleeY = hy0 / hl;
      fleeW = 40 * (1 - hunterD / 700);
    }
    var centerPull = 0, toCX = 0, toCY = 0;
    var dc = Math.sqrt(sx * sx + sy * sy);
    if (dc > w.radius * 0.62) {
      centerPull = (dc - w.radius * 0.62) / (w.radius * 0.38);
      var cl = dc || 1;
      toCX = -sx / cl; toCY = -sy / cl;
    }

    var N = cfg.headings, span = 2.5;                 // candidate headings, radians
    var best = s.angle, bestScore = -Infinity;

    for (var k = 0; k < N; k++) {
      var a = s.angle + (k - (N - 1) / 2) * (span / (N - 1));
      var ca = Math.cos(a), sa = Math.sin(a);

      // danger: closest approach of a threat along this heading
      var danger = 0;
      for (var t = 0; t < threats.length; t++) {
        var th = threats[t];
        var along = th.vx * ca + th.vy * sa;
        if (along <= 0 || along > probeLen) continue;
        var perp = Math.abs(th.vx * sa - th.vy * ca);
        if (perp < th.need) danger += (probeLen - along) * (th.need - perp) * 0.06;
      }

      var score = -danger * 12;

      // food: reward headings that point at value
      for (var b2 = 0; b2 < bites.length; b2++) {
        var bite = bites[b2];
        var dot = bite.x * ca + bite.y * sa;
        if (dot > 0.2 * bite.fl) score += bite.w * dot;
      }

      // hunt: aim at where the prey is going, not where it is
      if (prey) score += (huntX * ca + huntY * sa) * huntW;

      // flee: point away from bigger snakes
      if (hunter) score += (fleeX * ca + fleeY * sa) * fleeW;

      // stay inside the ring
      if (centerPull > 0) score += (toCX * ca + toCY * sa) * 110 * centerPull;

      // prefer small course corrections (smooth, lifelike steering) — a candidate
      // sits within span/2 of s.angle, so the offset never needs wrapping
      var turn = a - s.angle;
      score -= turn * turn * 9;

      if (score > bestScore) { bestScore = score; best = a; }
    }

    s.aim = best;

    // boost: burn length to close a gap, to escape, or to reach a fat pile
    var wish = false;
    if (s.mass > CFG.snake.boostMinMass + 14) {
      if (prey && preyD < 520) wish = true;
      if (hunter && hunterD < 300) wish = true;
      if (danger > 30) wish = true;
      if (bites.length > 14) wish = true;
    }
    s.boostWish = wish && Math.random() < d.boostAggro;
    s.boost = s.boostWish;
  }

  // ---------------------------------------------------------------- bodies
  // Head advances, every other point keeps exact spacing behind the one in front.
  // The last link is the exception: it carries the growth reach, so the tail tip
  // slides out at the mass's own rate. A link with no direction of its own (two
  // points stacked) inherits the body's tangent rather than being skipped — that
  // skip is what left a new tail piece folded 180 degrees into the body.
  function moveBody(s, reach) {
    var pts = s.pts, spacing = CFG.snake.segSpacing;
    var n = pts.length;
    var ux = -Math.cos(s.angle), uy = -Math.sin(s.angle);   // tail-ward tangent
    // the head is already placed by the caller; one reciprocal per link replaces
    // the three divisions the stretch step used to need. px/py snapshot the
    // position this point had before the step, for the painter's interpolation.
    for (var i = 1; i < n; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var want = (i === n - 1) ? spacing + reach : spacing;
      b.px = b.x;
      b.py = b.y;
      if (d < 1e-6) {
        b.x = a.x + ux * want;
        b.y = a.y + uy * want;
      } else {
        var invd = 1 / d;
        var t = 1 - want * invd;
        b.x += dx * t;
        b.y += dy * t;
        ux = -dx * invd;
        uy = -dy * invd;
      }
    }
  }

  World.prototype.eatFood = function (s, dt) {
    var sx = s.x(), sy = s.y();
    var reach = s.r + 34, reach2 = reach * reach;
    var mouth = s.r + 4;
    var ate = false;
    this.foodGrid.each(sx, sy, reach + 20, function (f) {
      if (f.eaten) return;
      var fx = f.x - sx, fy = f.y - sy;
      var d2 = fx * fx + fy * fy;
      var need = mouth + f.r;
      if (d2 < need * need) {
        f.eaten = true;
        s.mass += f.v;
        s.score += f.v;
        s.eaten += 1;
        ate = true;
      } else if (d2 < reach2) {
        // gentle magnet so pellets drift into the mouth
        var d = Math.sqrt(d2) || 1;
        var pull = (1 - d / reach) * 90 * dt;
        f.x += (sx - f.x) / d * pull;
        f.y += (sy - f.y) / d * pull;
      }
    });
    return ate;
  };

  World.prototype.compactFood = function () {
    // swap-remove: eaten pellets are sparse, and splice() shuffles the whole
    // tail of the array for each one
    var food = this.food, j = food.length - 1;
    for (var i = j; i >= 0; i--) {
      if (food[i].eaten) { food[i] = food[j]; j--; }
    }
    food.length = j + 1;
  };

  World.prototype.growBody = function (s, dropFood, dt) {
    var spacing = CFG.snake.segSpacing;
    var cont = segsFor(s.mass);
    // the tail chases its mass at a fixed pace, so a fat pellet stretches the tip
    // out over a few frames instead of snapping the whole pellet on at once
    if (s.grown === undefined) s.grown = cont;
    var cap = CFG.snake.growEase * (dt === undefined ? 1 : dt);
    if (cont > s.grown) s.grown = Math.min(cont, s.grown + cap);
    else s.grown = Math.max(cont, s.grown - cap);

    var target = Math.min(CFG.snake.maxSegs + 1, Math.floor(s.grown) + 1);
    var pts = s.pts;
    while (pts.length < target) {
      // a new joint extends the tail along its own tangent, a full spacing past the
      // tip — stacking it on top of the tip is what made the piece pop in folded
      var n = pts.length;
      var tip = pts[n - 1];
      var tx, ty;
      if (n >= 2) {
        var prev = pts[n - 2];
        tx = tip.x - prev.x;
        ty = tip.y - prev.y;
      } else {
        tx = -Math.cos(s.angle);
        ty = -Math.sin(s.angle);
      }
      var tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) {
        tx = -Math.cos(s.angle);
        ty = -Math.sin(s.angle);
        tl = 1;
      }
      var tx2 = tip.x + tx / tl * spacing, ty2 = tip.y + ty / tl * spacing;
      pts.push({ x: tx2, y: ty2, px: tx2, py: ty2 });
    }
    while (pts.length > target) {
      var tail = pts.pop();
      // burning length pays out as pellets behind you
      if (dropFood && this.food.length < CFG.food.target * 1.6) this.spawnFood(tail.x, tail.y, 1.4, 4.2);
    }
    s.reach = (s.grown - Math.floor(s.grown)) * spacing;
    s.r = massToRadius(s.mass);
    s.speed = massToSpeed(s.mass);
  };

  // ---------------------------------------------------------------- sweeper
  // The world grid doubles as a minesweeper board: every grid cell is safe or mined,
  // and hidden mines are inert — a snake slithers over them without trouble. Only
  // digging detonates. The player digs at the cell under its own head (see main.js);
  // bots never dig. Clearing the board is a run goal that coexists with surviving.
  World.prototype.buildSweeper = function () {
    var c = CFG.cell, R = this.radius;
    var k = Math.floor(R / c) + 1;        // pad one ring so edge cells get tested
    var side = 2 * k + 1;
    var n = side * side;
    var sw = { cell: c, w: side, h: side, ix0: -k, iy0: -k };
    sw.inside = new Uint8Array(n);        // cell centre inside the arena: playable
    sw.mine = new Uint8Array(n);
    sw.adj = new Uint8Array(n);           // adjacent-mine count (the number you dig up)
    sw.state = new Uint8Array(n);         // 0 hidden, 1 revealed, 2 flagged
    var p = this.diffCfg.mines;
    for (var ly = 0; ly < side; ly++) {
      for (var lx = 0; lx < side; lx++) {
        var i = ly * side + lx;
        var mx = (-k + lx + 0.5) * c, my = (-k + ly + 0.5) * c;
        if (mx * mx + my * my > (R - 1) * (R - 1)) continue;
        sw.inside[i] = 1;
        if (Math.random() < p) sw.mine[i] = 1;
      }
    }
    // world position -> cell index (-1 if outside the board or outside the arena)
    sw.at = function (x, y) {
      var lx = Math.floor(x / c) + k, ly = Math.floor(y / c) + k;
      if (lx < 0 || ly < 0 || lx >= side || ly >= side) return -1;
      var j = ly * side + lx;
      return sw.inside[j] ? j : -1;
    };
    sw.cx = function (i) { return ((i % side) - k + 0.5) * c; };
    sw.cy = function (i) { return ((i - i % side) / side - k + 0.5) * c; };
    sw.neigh = function (i, fn) {
      var lx = i % side, ly = (i - lx) / side;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          var nx = lx + dx, ny = ly + dy;
          if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
          var j = ny * side + nx;
          if (sw.inside[j]) fn(j);
        }
      }
    };
    sw.recount = function (i) {
      var cnt = 0;
      sw.neigh(i, function (j) { if (sw.mine[j]) cnt++; });
      sw.adj[i] = cnt;
    };
    sw.safeTotal = 0;
    sw.minesTotal = 0;
    sw.revealed = 0;
    sw.flags = 0;
    sw.won = false;
    for (var i2 = 0; i2 < n; i2++) {
      if (!sw.inside[i2]) continue;
      if (sw.mine[i2]) sw.minesTotal++; else sw.safeTotal++;
      sw.recount(i2);
    }
    return sw;
  };

  World.prototype.fixAdj = function (i) {
    var sw = this.sweeper;
    sw.recount(i);
    sw.neigh(i, function (j) { sw.recount(j); });
  };

  // Move the mine under cell i to a random still-hidden cell, keeping the mine count
  // exact (numbers around both ends are re-counted). If avoid is given, the mine may
  // not land on that cell or its ring.
  World.prototype.relocateMine = function (i, avoid) {
    var sw = this.sweeper;
    if (i < 0 || !sw.mine[i]) return false;
    var near = function (j) {
      if (avoid === undefined || j === avoid) return j === avoid && avoid !== undefined;
      var ax = avoid % sw.w, ay = (avoid - ax) / sw.w;
      var jx = j % sw.w, jy = (j - jx) / sw.w;
      return Math.abs(ax - jx) <= 1 && Math.abs(ay - jy) <= 1;
    };
    for (var tries = 0; tries < 800; tries++) {
      var j = Math.floor(Math.random() * sw.w * sw.h);
      if (j === i || !sw.inside[j] || sw.mine[j] || sw.state[j] !== 0 || near(j)) continue;
      sw.mine[i] = 0;
      sw.mine[j] = 1;
      this.fixAdj(i);
      this.fixAdj(j);
      return true;
    }
    sw.mine[i] = 0;   // nowhere to move it — disarm in place
    return true;
  };

  World.prototype.sweeperMakeSafe = function (x, y) {
    var i = this.sweeper.at(x, y);
    if (i >= 0) this.relocateMine(i, i);
  };

  World.prototype.revealSafeCell = function (i) {
    var sw = this.sweeper;
    if (sw.state[i] !== 0 || sw.mine[i]) return false;   // never auto-reveal a mine or a flag
    sw.state[i] = 1;
    sw.revealed++;
    if (!sw.won && sw.revealed >= sw.safeTotal) {
      sw.won = true;
      this.events.push({ type: 'sweeper', won: true });
    }
    return true;
  };

  // Dig at world (x, y): 'dig' | 'chord' | 'boom' | null. Numbers with as many flags
  // around as they show get chored: every other neighbour opens at once. The very
  // first dig of a snake is protected: a mine under the probe moves aside first.
  World.prototype.digCell = function (s, x, y) {
    var sw = this.sweeper;
    var i = sw.at(x, y);
    if (i < 0 || sw.state[i] === 2) return null;
    var first = s.digsMade === 0;
    s.digsMade += 1;
    if (first && sw.mine[i] && sw.state[i] === 0) this.relocateMine(i);
    if (sw.mine[i]) return sw.state[i] === 1 ? null : this.explodeAt(s, i);
    if (sw.state[i] === 1) return this.chordAt(s, i);
    var self = this;
    this.revealSafeCell(i);
    var stack = sw.adj[i] === 0 ? [i] : [];
    while (stack.length) {
      var c2 = stack.pop();
      sw.neigh(c2, function (j) {
        if (self.revealSafeCell(j) && sw.adj[j] === 0) stack.push(j);
      });
    }
    return 'dig';
  };

  World.prototype.chordAt = function (s, i) {
    var sw = this.sweeper;
    var n = sw.adj[i];
    if (!n || sw.state[i] !== 1) return null;
    var flags = 0;
    sw.neigh(i, function (j) { if (sw.state[j] === 2) flags++; });
    if (flags !== n) return null;
    var boom = -1, got = 0;
    var self = this;
    sw.neigh(i, function (j) {
      if (sw.state[j] === 2) return;
      if (sw.mine[j]) { if (boom < 0 && sw.state[j] !== 1) boom = j; return; }
      if (self.revealSafeCell(j)) got++;
    });
    if (boom >= 0) {
      if (s.digsMade === 1) this.relocateMine(boom, i);   // first attempt: the chord stays safe
      else return this.explodeAt(s, boom);
    }
    return got > 0 ? 'chord' : null;
  };

  // Chain blast: the mine you hit goes off, neighbouring mines follow, and safe cells
  // around the blasts clear themselves. The digger dies — credited to the mine, not the wall.
  World.prototype.explodeAt = function (s, i) {
    var sw = this.sweeper;
    var queue = [i];
    var self = this;
    while (queue.length) {
      var c2 = queue.pop();
      if (!(sw.mine[c2] && sw.state[c2] !== 1)) continue;
      sw.state[c2] = 1;
      this.effects.push({ type: 'shock', x: sw.cx(c2), y: sw.cy(c2), r: sw.cell * 0.3, max: sw.cell * 3.4, t: 0 });
      sw.neigh(c2, function (j) {
        if (sw.mine[j]) queue.push(j);
        else self.revealSafeCell(j);
      });
    }
    this.killSnake(s, null, 'mine');
    return 'boom';
  };

  World.prototype.flagCell = function (s, x, y) {
    var sw = this.sweeper;
    var i = sw.at(x, y);
    if (i < 0) return null;
    if (sw.state[i] === 0) { sw.state[i] = 2; sw.flags++; return 'flag'; }
    if (sw.state[i] === 2) { sw.state[i] = 0; sw.flags--; return 'unflag'; }
    return null;
  };

  // ---------------------------------------------------------------- death
  World.prototype.killSnake = function (s, killer, cause) {
    if (s.dead) return;
    s.dead = true;

    // the body becomes food: every other point (every 4th when the field is already
    // crowded with pellets), keeping ~75% of the mass
    var pts = s.pts;
    var dense = this.food.length > CFG.food.target * 1.5;
    var stride = dense ? 4 : 2;
    var payout = s.mass * 0.75 / Math.max(1, Math.floor(pts.length / stride));
    for (var i = 0; i < pts.length; i += stride) {
      this.spawnFood(pts[i].x, pts[i].y, clamp(payout, 1.0, 6.0), 5.2);
    }
    this.effects.push({ type: 'shock', x: s.x(), y: s.y(), r: s.r, max: s.r * 6 + 90, t: 0 });

    // Credit the kill even if the killer died in the same frame (mutual crash):
    // killers are collected from live snakes, so a dead killer here means a
    // mutual kill — not a wall death.
    if (killer && killer !== s) {
      killer.kills += 1;
      this.events.push({ type: 'kill', killer: killer.name, victim: s.name, killerId: killer.id, victimId: s.id, playerKill: killer.player, playerVictim: s.player });
    } else {
      var ev = { type: 'kill', killer: null, victim: s.name, victimId: s.id, playerVictim: s.player };
      if (cause) ev.cause = cause;   // 'mine' for a dig blast; a plain wall death has none
      this.events.push(ev);
    }
  };

  // ---------------------------------------------------------------- step
  World.prototype.step = function (dt) {
    this.time += dt;
    var i, s;

    // --- refresh the food index (eaten pellets are flagged, not spliced mid-frame)
    this.compactFood();
    this.foodGrid.clear();
    for (i = 0; i < this.food.length; i++) this.foodGrid.insert(this.food[i].x, this.food[i].y, this.food[i]);

    // --- steering + movement
    for (i = 0; i < this.snakes.length; i++) {
      s = this.snakes[i];
      if (s.dead) continue;
      if (s.grace > 0) s.grace -= dt;

      if (s.bot) {
        s.think -= dt;
        if (s.think <= 0) { steerBot(this, s, dt); s.think = 0.05 + Math.random() * 0.05; }
      }

      // turning is limited, and big snakes turn slowly
      var maxTurn = massToTurn(s.mass, this.diffCfg.turnMul) * dt;
      var want = normAngle(s.aim - s.angle);
      s.angle = normAngle(s.angle + clamp(want, -maxTurn, maxTurn));

      var boosting = s.boost && s.mass > CFG.snake.boostMinMass;
      var v = s.speed * (boosting ? CFG.snake.boostMul : 1);
      var hp = s.pts[0];
      hp.px = hp.x;
      hp.py = hp.y;
      hp.x += Math.cos(s.angle) * v * dt;
      hp.y += Math.sin(s.angle) * v * dt;

      if (boosting) {
        var burn = CFG.snake.boostDrain * dt * (0.6 + s.r * 0.03);
        s.mass -= burn;
        s.score -= burn;   // boosting burns your length — the length stat must shrink too
        if (s.mass < CFG.snake.boostMinMass) s.boost = false;
      }

      moveBody(s, s.reach || 0);
      this.growBody(s, boosting, dt);
      this.eatFood(s, dt);
    }

    // --- index every body point (every 2nd point is dense enough)
    this.segGrid.clear();
    var pool = this.segPool, pn = 0;
    for (i = 0; i < this.snakes.length; i++) {
      s = this.snakes[i];
      if (s.dead) continue;
      var pts = s.pts;
      for (var j = 0; j < pts.length; j += 2) {
        var it = pool[pn] || (pool[pn] = { x: 0, y: 0, r: 0, owner: null, idx: 0 });
        it.x = pts[j].x; it.y = pts[j].y; it.r = s.r; it.owner = s; it.idx = j;
        this.segGrid.insert(it.x, it.y, it);
        pn++;
      }
    }
    pool.length = pn;      // release pooled items from dead snakes

    // --- collisions
    var doomed = [];
    for (i = 0; i < this.snakes.length; i++) {
      s = this.snakes[i];
      if (s.dead || s.grace > 0) continue;

      var hx = s.x(), hy = s.y();

      // the wall kills
      var wall = this.radius - s.r;
      if (hx * hx + hy * hy > wall * wall) { doomed.push([s, null]); continue; }

      // squared-distance touch test: forgiving, only a real touch counts, and
      // grazing a tail tip is safe — no sqrt anywhere in this scan
      var hit = null, hitD2 = Infinity;
      var soft = s.r * 0.55;
      this.segGrid.each(hx, hy, s.r + 40, function (it) {
        if (it.owner === s) return;
        var dx = it.x - hx, dy = it.y - hy;
        var d2 = dx * dx + dy * dy;
        var need = it.r + soft;
        if (d2 < need * need && d2 < hitD2) { hitD2 = d2; hit = it; }
      });
      if (hit) {
        doomed.push([s, hit.owner]);
        if (hit.idx === 0 && hit.owner.grace <= 0) doomed.push([hit.owner, s]);   // head-to-head: both lose
      }
    }

    // --- resolve
    for (i = 0; i < doomed.length; i++) this.killSnake(doomed[i][0], doomed[i][1]);

    // --- keep the field stocked
    var deficit = CFG.food.target - this.food.length;
    for (i = 0; i < Math.min(deficit, 26); i++) this.spawnFood();

    // --- effects
    for (i = this.effects.length - 1; i >= 0; i--) {
      var e = this.effects[i];
      e.t += dt;
      if (e.t > 0.7) this.effects.splice(i, 1);
    }

    // --- repopulate
    var alive = 0;
    for (i = 0; i < this.snakes.length; i++) if (!this.snakes[i].dead) alive++;
    if (alive < this.diffCfg.bots) {
      for (i = 0; i < 2 && alive + i < this.diffCfg.bots; i++) this.spawnSnake({});
    }
    // drop corpses from the list
    if (this.snakes.length > 140) {
      this.snakes = this.snakes.filter(function (x) { return !x.dead; });
    }
  };

  // ---------------------------------------------------------------- views
  World.prototype.rank = function (s) {
    if (!s || s.dead) return this.snakes.filter(function (x) { return !x.dead; }).length + 1;
    var n = 1;
    for (var i = 0; i < this.snakes.length; i++) {
      var o = this.snakes[i];
      if (o.dead || o === s) continue;
      if (o.mass > s.mass) n++;
    }
    return n;
  };

  World.prototype.leaderboard = function (n) {
    var alive = this.snakes.filter(function (x) { return !x.dead; });
    alive.sort(function (a, b) { return b.mass - a.mass; });
    return alive.slice(0, n || 10).map(function (x) {
      return { id: x.id, name: x.name, mass: Math.round(x.mass), player: x.player, skin: x.skin };
    });
  };

  global.Mineserpent = {
    CFG: CFG,
    SKINS: SKINS,
    DIFFICULTY: DIFFICULTY,
    World: World,
    Snake: Snake,
    massToSegs: massToSegs,
    massToRadius: massToRadius,
    massToSpeed: massToSpeed
  };
})(typeof window !== 'undefined' ? window : globalThis);
