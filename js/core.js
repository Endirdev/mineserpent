/* Slither Local — core simulation.
 * Pure logic: no DOM, no canvas. Runs in the browser and in Node (see test/smoke.mjs).
 * Exposes a single global: Slither
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- tuning
  var CFG = {
    world: { radius: 2600 },

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
    chill:   { label: 'Chill',   bots: 26, lookMul: 0.75, turnMul: 0.90, boostAggro: 0.35, massMul: 0.85 },
    classic: { label: 'Classic', bots: 35, lookMul: 1.00, turnMul: 1.00, boostAggro: 0.60, massMul: 1.00 },
    ruthless:{ label: 'Ruthless',bots: 44, lookMul: 1.30, turnMul: 1.18, boostAggro: 0.85, massMul: 1.20 }
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
  function dist(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // Uniform spatial hash. Keys are integers (ix << 16 | iy) offset into positive range.
  // Buckets are reused between frames: clear() empties them in place, so a frame does
  // not allocate a new array per cell.
  function Grid(cell) {
    this.cell = cell;
    this.cells = new Map();
  }
  Grid.prototype.clear = function () {
    this.cells.forEach(function (bucket) { bucket.length = 0; });
  };
  Grid.prototype.insert = function (x, y, item) {
    var ix = Math.floor(x / this.cell), iy = Math.floor(y / this.cell);
    var key = (ix + 4096) * 8192 + (iy + 4096);
    var bucket = this.cells.get(key);
    if (bucket) bucket.push(item); else this.cells.set(key, [item]);
    return item;
  };
  // Collect items in cells overlapping a square around (x,y). Returns a reused array.
  var _scratch = [];
  Grid.prototype.query = function (x, y, r) {
    _scratch.length = 0;
    var c = this.cell;
    var x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    var y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (var ix = x0; ix <= x1; ix++) {
      for (var iy = y0; iy <= y1; iy++) {
        var bucket = this.cells.get((ix + 4096) * 8192 + (iy + 4096));
        if (bucket) for (var i = 0; i < bucket.length; i++) _scratch.push(bucket[i]);
      }
    }
    return _scratch;
  };

  // ---------------------------------------------------------------- snake
  function massToSegs(mass) {
    return Math.min(CFG.snake.maxSegs, Math.round(CFG.snake.segBase + mass * CFG.snake.segPerMass));
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
    this.dead = false;
    this.grace = CFG.snake.graceTime;
    this.boostWish = false;
    this.think = 0;
    this.personality = rand(0, 1);   // 0 = skittish, 1 = aggressive

    // body points, head first
    this.pts = [];
    var n = massToSegs(this.mass);
    for (var i = 0; i < n; i++) this.pts.push({ x: x - Math.cos(this.angle) * i * CFG.snake.segSpacing, y: y - Math.sin(this.angle) * i * CFG.snake.segSpacing });
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

    this.snakes = [];
    this.food = [];
    this.effects = [];
    this.events = [];
    this.foodGrid = new Grid(140);
    this.segGrid = new Grid(110);
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
        var dd = dist(x, y, s.x(), s.y());
        if (dd < 520) near += 520 - dd;
      }
      var score = -near + dist(x, y, 0, 0) * 0.05;
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
    return s;
  };

  Snake.prototype.x = function () { return this.pts[0].x; };
  Snake.prototype.y = function () { return this.pts[0].y; };

  // ---------------------------------------------------------------- steering
  // Pick the safest, most profitable heading by scoring candidate angles.
  function steerBot(w, s, dt) {
    var cfg = CFG.bot, d = w.diffCfg;
    var scanR = cfg.scanR * d.lookMul * (0.8 + s.personality * 0.5);
    var probeLen = cfg.probeLen * d.lookMul;

    // 1. nearby enemy body segments (threats)
    var raw = w.segGrid.query(s.x(), s.y(), scanR + 60);
    var threats = [];
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (it.owner === s) continue;
      var dd = dist(s.x(), s.y(), it.x, it.y);
      if (dd > scanR + it.r) continue;
      threats.push(it);
    }
    // keep only the closest ones — the body is dense, the near part is what kills you
    if (threats.length > cfg.maxThreats) {
      threats.sort(function (a, b) {
        return (dist(s.x(), s.y(), a.x, a.y) - dist(s.x(), s.y(), b.x, b.y));
      });
      threats.length = cfg.maxThreats;
    }

    // 2. food to eat (capped: a bot only weighs the handful of pellets it can reach soon)
    var bites = [];
    var foodRaw = w.foodGrid.query(s.x(), s.y(), cfg.foodScanR);
    for (var f = 0; f < foodRaw.length; f++) {
      var fd = dist(s.x(), s.y(), foodRaw[f].x, foodRaw[f].y);
      if (fd < cfg.foodScanR) bites.push(foodRaw[f]);
      if (bites.length >= 22) break;
    }

    // 3. prey: a smaller snake worth hunting
    var prey = null, preyD = Infinity;
    for (var p = 0; p < w.snakes.length; p++) {
      var o = w.snakes[p];
      if (o === s || o.dead || o.grace > 0) continue;
      if (o.mass < s.mass * 0.8) {
        var pd = dist(s.x(), s.y(), o.x(), o.y());
        if (pd < 900 && pd < preyD) { preyD = pd; prey = o; }
      }
    }
    // ...and a hunter worth fleeing
    var hunter = null, hunterD = Infinity;
    for (var h = 0; h < w.snakes.length; h++) {
      var q = w.snakes[h];
      if (q === s || q.dead || q.grace > 0) continue;
      if (q.mass > s.mass * 1.25) {
        var hd = dist(s.x(), s.y(), q.x(), q.y());
        if (hd < 700 && hd < hunterD) { hunterD = hd; hunter = q; }
      }
    }

    var centerPull = 0;
    var dc = dist(s.x(), s.y(), 0, 0);
    if (dc > w.radius * 0.62) centerPull = (dc - w.radius * 0.62) / (w.radius * 0.38);

    var safeRad = s.r + 26;
    var N = cfg.headings, span = 2.5;                 // candidate headings, radians
    var best = s.angle, bestScore = -Infinity;

    for (var k = 0; k < N; k++) {
      var a = s.angle + (k - (N - 1) / 2) * (span / (N - 1));
      var ca = Math.cos(a), sa = Math.sin(a);

      // danger: closest approach of a threat along this heading
      var danger = 0;
      for (var t = 0; t < threats.length; t++) {
        var th = threats[t];
        var vx = th.x - s.x(), vy = th.y - s.y();
        var along = vx * ca + vy * sa;
        if (along <= 0) continue;
        if (along > probeLen) continue;
        var perp = Math.abs(vx * sa - vy * ca);
        var need = safeRad + th.r;
        if (perp < need) danger += (probeLen - along) * (need - perp) * 0.06;
      }

      var score = -danger * 12;

      // food: reward headings that point at value
      for (var b2 = 0; b2 < bites.length; b2++) {
        var bite = bites[b2];
        var fx = bite.x - s.x(), fy = bite.y - s.y();
        var fl = Math.sqrt(fx * fx + fy * fy) || 1;
        var dot = (fx * ca + fy * sa) / fl;
        if (dot > 0.2) score += bite.v * dot * 26 * (1 - fl / cfg.foodScanR);
      }

      // hunt: aim at where the prey is going, not where it is
      if (prey) {
        var ipx = prey.x() + Math.cos(prey.angle) * preyD * 0.32 - s.x();
        var ipy = prey.y() + Math.sin(prey.angle) * preyD * 0.32 - s.y();
        var il = Math.sqrt(ipx * ipx + ipy * ipy) || 1;
        var hd2 = (ipx * ca + ipy * sa) / il;
        score += hd2 * (26 + s.personality * 34);
      }

      // flee: point away from bigger snakes
      if (hunter) {
        var hx = s.x() - hunter.x(), hy = s.y() - hunter.y();
        var hl = Math.sqrt(hx * hx + hy * hy) || 1;
        score += ((hx * ca + hy * sa) / hl) * 40 * (1 - hunterD / 700);
      }

      // stay inside the ring
      if (centerPull > 0) {
        var cx = -s.x(), cy = -s.y();
        var cl = Math.sqrt(cx * cx + cy * cy) || 1;
        score += ((cx * ca + cy * sa) / cl) * 110 * centerPull;
      }

      // prefer small course corrections (smooth, lifelike steering)
      var turn = Math.abs(normAngle(a - s.angle));
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
  function moveBody(s) {
    var pts = s.pts, spacing = CFG.snake.segSpacing;
    pts[0].x = s.x();
    pts[0].y = s.y();
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) continue;
      var t = (d - spacing) / d;
      b.x += dx * t;
      b.y += dy * t;
    }
  }

  World.prototype.eatFood = function (s, dt) {
    var reach = s.r + 34;
    var near = this.foodGrid.query(s.x(), s.y(), reach + 20);
    var ate = false;
    for (var i = 0; i < near.length; i++) {
      var f = near[i];
      if (f.eaten) continue;
      var d = dist(s.x(), s.y(), f.x, f.y) || 1;
      if (d < s.r + f.r + 4) {
        f.eaten = true;
        s.mass += f.v;
        s.score += f.v;
        s.eaten += 1;
        ate = true;
      } else if (d < reach) {
        // gentle magnet so pellets drift into the mouth
        var pull = (1 - d / reach) * 90 * dt;
        f.x += (s.x() - f.x) / d * pull;
        f.y += (s.y() - f.y) / d * pull;
      }
    }
    return ate;
  };

  World.prototype.compactFood = function () {
    for (var j = this.food.length - 1; j >= 0; j--) {
      if (this.food[j].eaten) this.food.splice(j, 1);
    }
  };

  World.prototype.growBody = function (s, dropFood) {
    var target = massToSegs(s.mass);
    var pts = s.pts;
    while (pts.length < target) {
      var last = pts[pts.length - 1];
      pts.push({ x: last.x, y: last.y });
    }
    while (pts.length > target) {
      var tail = pts.pop();
      // burning length pays out as pellets behind you
      if (dropFood && this.food.length < CFG.food.target * 1.6) this.spawnFood(tail.x, tail.y, 1.4, 4.2);
    }
    s.r = massToRadius(s.mass);
    s.speed = massToSpeed(s.mass);
  };

  // ---------------------------------------------------------------- death
  World.prototype.killSnake = function (s, killer) {
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
      this.events.push({ type: 'kill', killer: null, victim: s.name, victimId: s.id, playerVictim: s.player });
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
      s.pts[0].x += Math.cos(s.angle) * v * dt;
      s.pts[0].y += Math.sin(s.angle) * v * dt;

      if (boosting) {
        var burn = CFG.snake.boostDrain * dt * (0.6 + s.r * 0.03);
        s.mass -= burn;
        s.score -= burn;   // boosting burns your length — the length stat must shrink too
        if (s.mass < CFG.snake.boostMinMass) s.boost = false;
      }

      moveBody(s);
      this.growBody(s, boosting);
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
      if (dist(hx, hy, 0, 0) > this.radius - s.r) { doomed.push([s, null]); continue; }

      var near = this.segGrid.query(hx, hy, s.r + 40);
      var hitD = Infinity, hit = null;
      for (var n = 0; n < near.length; n++) {
        var it2 = near[n];
        if (it2.owner === s) continue;
        var d2 = dist(hx, hy, it2.x, it2.y);
        // forgiving: only a real touch counts, and grazing a tail tip is safe
        if (d2 < it2.r + s.r * 0.55 && d2 < hitD) { hitD = d2; hit = it2; }
      }
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

  global.Slither = {
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
