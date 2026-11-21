/* Slither Local — glue: input, camera, UI, sound.
 * Talks to the simulation (Slither.World) and the painter (SlitherRender).
 */
(function () {
  'use strict';

  var S = window.Slither;
  var R = window.SlitherRender;
  var CFG = S.CFG;

  // ------------------------------------------------------------- dom
  function el(id) { return document.getElementById(id); }
  var canvas = el('game');
  var dom = {
    menu: el('menu'), hud: el('hud'), dead: el('dead'), board: el('board'),
    minimap: el('minimap'), feed: el('feed'), flash: el('flash'),
    name: el('name'), skins: el('skins'), difficulty: el('difficulty'),
    play: el('play'), again: el('again'), mute: el('mute'), music: el('music'), menuMusic: el('menu-music'),
    length: el('stat-length'), kills: el('stat-kills'), rank: el('stat-rank'),
    boost: el('boost-meter'), topbar: el('top-bar'), topfill: el('top-fill'),
    toplen: el('top-len'), yours: el('yours'),
    deadTitle: el('dead-title'), deadBy: el('dead-by'),
    deadLength: el('dead-length'), deadKills: el('dead-kills'),
    deadRank: el('dead-rank'), deadTime: el('dead-time'),
    swept: el('stat-swept'), mines: el('stat-mines'), deadSwept: el('dead-swept')
  };

  // ------------------------------------------------------------- sound
  function Sfx() {
    this.ctx = null;
    this.master = null;
    this.boostGain = null;
    this.muted = false;
    this.lastEat = 0;
  }
  Sfx.prototype.start = function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);

    // continuous boost hum
    var osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 62;
    this.boostGain = this.ctx.createGain();
    this.boostGain.gain.value = 0;
    osc.connect(this.boostGain);
    this.boostGain.connect(this.master);
    osc.start();
  };
  Sfx.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  };
  Sfx.prototype.blip = function (freq, dur, gain, type) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.55), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  };
  Sfx.prototype.eat = function () {
    if (!this.ctx) return;
    var now = this.ctx.currentTime;
    if (now - this.lastEat < 0.075) return;
    this.lastEat = now;
    this.blip(880, 0.07, 0.10, 'triangle');
  };
  Sfx.prototype.kill = function () { this.blip(1320, 0.22, 0.16, 'square'); };
  Sfx.prototype.death = function () { this.blip(180, 0.55, 0.35, 'sawtooth'); };
  Sfx.prototype.spawn = function () { this.blip(520, 0.16, 0.12, 'sine'); };
  Sfx.prototype.boost = function (on) {
    if (!this.boostGain) return;
    this.boostGain.gain.setTargetAtTime(on ? 0.05 : 0, this.ctx.currentTime, 0.08);
  };
  var sfx = new Sfx();

  // ------------------------------------------------------------- state
  var state = 'menu';
  var world = null;
  var me = null;
  var ghost = null;              // who killed us, for the camera
  var selectedSkin = 0;
  var cam = { x: 0, y: 0, zoom: 1 };
  var shake = 0, flash = 0;
  var lastKills = 0, started = 0;
  var pendingDeathKiller = null, pendingKillerId = null;
  var pendingDeathCause = null;
  var feedTimers = [];

  var input = { mx: 0, my: 0, boost: false, keyBoost: false, midBoost: false, keys: {} };
  var touchSeen = false;   // once a finger is about, taps steer only — they must not dig squares

  var NAMES = ['Slinky', 'Noodle', 'Rattlesnake', 'Anaconda', 'Boop', 'Zigzag', 'Mamba',
    'Wiggles', 'Coil', 'Hydra', 'Pythona', 'Slurp', 'Kobra', 'Twisty', 'Biscuit'];

  // ------------------------------------------------------------- start
  function newRun() {
    var diff = dom.difficulty.value;
    if (!world) world = new S.World({ difficulty: diff });
    var name = (dom.name.value || '').trim().slice(0, 14) || NAMES[Math.floor(Math.random() * NAMES.length)];
    dom.name.value = name;
    me = world.spawnSnake({ name: name, skin: S.SKINS[selectedSkin], player: true, bot: false, mass: CFG.snake.startMass });
    me.score = CFG.snake.startMass;
    state = 'playing';
    started = world.time;
    lastKills = 0;
    ghost = null;
    pendingDeathKiller = null;
    pendingKillerId = null;
    shake = 0;
    flash = 0;
    dom.feed.innerHTML = '';
    feedTimers.length = 0;
    cam.x = me.x(); cam.y = me.y(); cam.zoom = targetZoom();
    dom.menu.classList.add('hidden');
    dom.dead.classList.add('hidden');
    dom.hud.classList.remove('hidden');
    sfx.start();
    sfx.spawn();
    if (window.SlitherMusic) { window.SlitherMusic.duck(false); window.SlitherMusic.start(); }
  }

  function targetZoom() {
    if (!me || me.dead) return 0.62;
    var z = 1.08 * Math.pow(26 / Math.max(12, me.mass), 0.24);
    return Math.max(0.40, Math.min(1.12, z));
  }

  // ------------------------------------------------------------- input
  // world point under a pointer event — a click names a square on the board
  function pointerWorld(e) {
    var r = canvas.getBoundingClientRect();
    var z = cam.zoom || 1;
    return {
      x: cam.x + (e.clientX - r.left - R.w / 2) / z,
      y: cam.y + (e.clientY - r.top - R.h / 2) / z
    };
  }

  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect();
    input.mx = e.clientX - r.left;
    input.my = e.clientY - r.top;
    // the square under the pointer is where a click would dig: mark it
    if (world && state === 'playing' && me && !me.dead) world.hover = pointerWorld(e);
  });
  canvas.addEventListener('mousedown', function (e) {
    if (touchSeen) return;               // taps steer only: they must not dig squares
    if (e.button === 1) { input.midBoost = true; return; }   // middle click holds boost
    if (e.button !== 0) return;          // right click flags, on contextmenu
    // left click digs the square you aimed at
    var p = pointerWorld(e);
    trySweeper(false, p.x, p.y);
  });
  canvas.addEventListener('contextmenu', function (e) {
    if (touchSeen) return;
    var p2 = pointerWorld(e);
    trySweeper(true, p2.x, p2.y);
  });
  // boost holds per button: letting go of a dig or a flag must not cancel a
  // boost you are still holding on the middle button
  window.addEventListener('mouseup', function (e) {
    if (e.button === 1) input.midBoost = false;
    else input.boost = false;
  });
  window.addEventListener('blur', function () { input.boost = false; input.midBoost = false; input.keys = {}; });

  // ------------------------------------------------------------- sweeper
  // Digging is mine to aim: a left click names any square on the board, while the
  // keys and the touch buttons dig where the snake's head is. Bots never dig.
  function trySweeper(flag, x, y) {
    if (!(world && state === 'playing' && me && !me.dead)) return;
    if (x === undefined) { x = me.x(); y = me.y(); }   // keys / buttons: where you are
    if (flag) {
      var f = world.flagCell(me, x, y);
      if (f === 'flag') sfx.blip(360, 0.07, 0.06, 'square');
      else if (f === 'unflag') sfx.blip(300, 0.05, 0.05, 'square');
    } else {
      var r = world.digCell(me, x, y);
      if (r === 'boom') sfx.blip(90, 0.5, 0.4, 'sawtooth');
      else if (r === 'chord') sfx.blip(980, 0.09, 0.07, 'triangle');
      else if (r) sfx.blip(720, 0.06, 0.06, 'sine');
    }
  }

  window.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;   // let the menu fields type
    if (e.code === 'Space' || e.code === 'ShiftLeft') { input.keyBoost = true; e.preventDefault(); }
    if (e.key === 'Escape' && state !== 'menu') toMenu();
    if (e.key === 'm' || e.key === 'M') toggleMute();
    // digging on key-hold auto-repeat would fire every frame: only take fresh presses
    if ((e.key === 's' || e.key === 'S' || e.key === '.') && !input.keys[e.key]) trySweeper(false);
    if ((e.key === 'f' || e.key === 'F') && !input.keys[e.key]) trySweeper(true);
    input.keys[e.key] = true;
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.code === 'ShiftLeft') input.keyBoost = false;
    delete input.keys[e.key];
  });

  // touch: drag to steer, the on-screen button to boost
  canvas.addEventListener('touchstart', handleTouch, { passive: false });
  canvas.addEventListener('touchmove', handleTouch, { passive: false });
  function handleTouch(e) {
    e.preventDefault();
    touchSeen = true;
    var t = e.touches[0];
    var r = canvas.getBoundingClientRect();
    input.mx = t.clientX - r.left;
    input.my = t.clientY - r.top;
    // touch has no pointer parked on a square: the cursor goes back to the head
    if (world) world.hover = null;
  }
  el('boostbtn').addEventListener('touchstart', function (e) { e.preventDefault(); input.boost = true; }, { passive: false });
  el('boostbtn').addEventListener('touchend', function (e) { e.preventDefault(); input.boost = false; }, { passive: false });
  el('boostbtn').addEventListener('mousedown', function () { input.boost = true; });
  el('boostbtn').addEventListener('mouseup', function () { input.boost = false; });

  // touch dig/flag buttons (desktop uses the S / F keys)
  el('digbtn').addEventListener('touchstart', function (e) { e.preventDefault(); trySweeper(false); }, { passive: false });
  el('flagbtn').addEventListener('touchstart', function (e) { e.preventDefault(); trySweeper(true); }, { passive: false });
  el('digbtn').addEventListener('mousedown', function () { trySweeper(false); });
  el('flagbtn').addEventListener('mousedown', function () { trySweeper(true); });

  function toMenu() {
    state = 'menu';
    dom.menu.classList.remove('hidden');
    dom.hud.classList.add('hidden');
    dom.dead.classList.add('hidden');
  }

  function toggleMute() {
    sfx.setMuted(!sfx.muted);
    dom.mute.textContent = sfx.muted ? 'Sound: off' : 'Sound: on';
    dom.mute.classList.toggle('off', sfx.muted);
  }

  // ------------------------------------------------------------- skin picker
  function buildSkins() {
    S.SKINS.forEach(function (sk, i) {
      var b = document.createElement('button');
      b.className = 'skin';
      b.title = sk.name;
      b.style.background = 'linear-gradient(135deg,' + sk.a + ' 0 50%,' + sk.b + ' 50% 100%)';
      b.addEventListener('click', function () {
        selectedSkin = i;
        var all = dom.skins.querySelectorAll('.skin');
        for (var k = 0; k < all.length; k++) all[k].classList.remove('sel');
        b.classList.add('sel');
      });
      dom.skins.appendChild(b);
      if (i === 0) b.classList.add('sel');
    });
  }

  // ------------------------------------------------------------- kill feed
  function pushFeed(html, strong) {
    var row = document.createElement('div');
    row.className = 'feed-row' + (strong ? ' strong' : '');
    row.innerHTML = html;
    dom.feed.appendChild(row);
    feedTimers.push({ node: row, t: 5 });
    while (dom.feed.children.length > 5) dom.feed.removeChild(dom.feed.firstChild);
  }
  function tickFeed(dt) {
    for (var i = feedTimers.length - 1; i >= 0; i--) {
      feedTimers[i].t -= dt;
      if (feedTimers[i].t < 1.2) feedTimers[i].node.style.opacity = (feedTimers[i].t / 1.2).toFixed(2);
      if (feedTimers[i].t <= 0) {
        if (feedTimers[i].node.parentNode) feedTimers[i].node.parentNode.removeChild(feedTimers[i].node);
        feedTimers.splice(i, 1);
      }
    }
  }
  function drainEvents() {
    for (var i = 0; i < world.events.length; i++) {
      var e = world.events[i];
      if (e.type === 'sweeper') {
        pushFeed('<b class="me">You</b> cleared the whole minefield <b class="me">+60</b>', true);
        if (me && !me.dead) {
          me.mass += 60;
          me.score += 60;   // keep the length stat on the real body
          sfx.kill();
        }
        continue;
      }
      var involved = e.playerKill || e.playerVictim;
      var big = false;
      if (e.killerId) {
        for (var k = 0; k < world.snakes.length; k++) {
          if (world.snakes[k].id === e.killerId && world.snakes[k].mass > 260) big = true;
        }
      }
      if (!involved && !big) continue;
      if (e.playerVictim) {
        if (e.cause === 'mine') {
          pushFeed('<b class="me">You</b> dug a mine', true);
          pendingDeathCause = 'mine';
        } else {
          pushFeed('<b class="me">You</b> were eaten by <b>' + (e.killer ? e.killer : 'the wall') + '</b>', true);
          pendingDeathKiller = e.killer;
          pendingKillerId = e.killerId;
        }
      } else if (e.playerKill) {
        pushFeed('<b class="me">You</b> ate <b>' + e.victim + '</b>', true);
      } else {
        pushFeed('<b>' + e.killer + '</b> ate ' + e.victim);
      }
    }
    world.events.length = 0;
  }

  // ------------------------------------------------------------- hud
  var hudTick = 0;
  function updateHud() {
    hudTick++;
    if (hudTick % 12 !== 0) return;
    var board = world.leaderboard(10);
    var html = '';
    for (var i = 0; i < board.length; i++) {
      var b = board[i];
      html += '<div class="row' + (b.player ? ' you' : '') + '"><span class="rk">' + (i + 1) +
        '</span><span class="nm">' + escapeHtml(b.name) + '</span><span class="len">' + b.mass + '</span></div>';
    }
    if (me && !me.dead && world.rank(me) > 10) {
      html += '<div class="row you"><span class="rk">' + world.rank(me) + '</span><span class="nm">' +
        escapeHtml(me.name) + '</span><span class="len">' + Math.round(me.score) + '</span></div>';
    }
    dom.board.innerHTML = html;

    var topMass = board.length ? board[0].mass : 1;
    dom.topfill.style.width = Math.min(100, (me && !me.dead ? me.mass / topMass : 0) * 100).toFixed(1) + '%';
    dom.toplen.textContent = Math.round(topMass);

    if (me) {
      dom.length.textContent = Math.round(me.score);
      dom.kills.textContent = me.kills;
      dom.rank.textContent = world.rank(me);
      var canBoost = me.mass > CFG.snake.boostMinMass;
      var fuel = (me.mass - CFG.snake.boostMinMass) / (CFG.snake.boostMinMass * 2);
      dom.boost.style.width = Math.max(3, Math.min(100, fuel * 100)).toFixed(0) + '%';
      dom.boost.parentNode.classList.toggle('ready', canBoost);
      var sw = world.sweeper;
      dom.swept.textContent = sw.revealed + '/' + sw.safeTotal;
      dom.mines.textContent = Math.max(0, sw.minesTotal - sw.flags);
    }
    R.drawMinimap(world, dom.minimap, me);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showDeath(killerName, cause) {
    state = 'dead';
    if (window.SlitherMusic) window.SlitherMusic.duck(true);
    dom.hud.classList.add('hidden');
    dom.dead.classList.remove('hidden');
    if (cause === 'mine') {
      dom.deadTitle.textContent = 'You dug a mine';
      dom.deadBy.textContent = 'The minefield hides under the grid — mines only go off when you dig on them.';
      el('spec').textContent = 'the board, not a snake';
    } else if (killerName) {
      dom.deadTitle.textContent = 'Eaten by ' + killerName;
      dom.deadBy.textContent = '';
      el('spec').textContent = killerName;
    } else {
      dom.deadTitle.textContent = 'You hit the wall';
      dom.deadBy.textContent = 'The red ring is not a fence.';
      el('spec').textContent = 'the snake that got you';
    }
    dom.deadLength.textContent = Math.round(me.score);
    dom.deadKills.textContent = me.kills;
    dom.deadRank.textContent = world.rank(me);
    dom.deadTime.textContent = Math.max(0, Math.round(world.time - started)) + 's';
    var swd = world.sweeper;
    dom.deadSwept.textContent = swd.revealed + '/' + swd.safeTotal + (swd.won ? ' cleared' : '');
  }

  // ------------------------------------------------------------- loop
  var STEP = 1 / 60;
  var acc = 0;
  var last = performance.now();
  var fps = 60;

  function frame(now) {
    var dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;
    acc += dt;

    if (world && state !== 'menu') {
      var steps = 0;
      while (acc >= STEP && steps < 4) { world.step(STEP); acc -= STEP; steps++; }
      if (steps === 4) acc = 0;
      drainEvents();
      tickFeed(dt);
      updateHud();
    }

    // ---- player control
    if (world && state === 'playing' && me && !me.dead) {
      var z = cam.zoom;
      var wx = cam.x + (input.mx - R.w / 2) / z;
      var wy = cam.y + (input.my - R.h / 2) / z;
      var dx = wx - me.x(), dy = wy - me.y();
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) me.aim = Math.atan2(dy, dx);

      // arrow keys steer too, for people without a mouse
      if (input.keys['ArrowLeft'] || input.keys['a']) me.aim = me.angle - 1.4;
      if (input.keys['ArrowRight'] || input.keys['d']) me.aim = me.angle + 1.4;

      var boosting = (input.boost || input.keyBoost || input.midBoost) && me.mass > CFG.snake.boostMinMass;
      me.boost = boosting;
      sfx.boost(boosting);
      if (boosting) sfx.eat();           // the hum is the "eating your own length" sound
    } else if (sfx.ctx) {
      sfx.boost(false);
    }

    // the pointer target only exists during a run
    if (world && !(state === 'playing' && me && !me.dead)) world.hover = null;

    // ---- camera
    var focus = (state === 'playing' && me && !me.dead) ? me : (ghost && !ghost.dead ? ghost : me);
    if (focus) {
      cam.zoom += (targetZoom() - cam.zoom) * Math.min(1, dt * 3.2);
      var lead = 0.16;
      var tx = focus.x() + Math.cos(focus.angle) * focus.r * lead * 4;
      var ty = focus.y() + Math.sin(focus.angle) * focus.r * lead * 4;
      cam.x += (tx - cam.x) * Math.min(1, dt * 6.5);
      cam.y += (ty - cam.y) * Math.min(1, dt * 6.5);
    }
    shake *= Math.pow(0.0015, dt);
    flash *= Math.pow(0.02, dt);
    dom.flash.style.opacity = flash.toFixed(3);

    // ---- death check (events are drained above, so use what drainEvents captured)
    if (state === 'playing' && me && me.dead) {
      ghost = null;
      if (pendingKillerId) {
        for (var j = 0; j < world.snakes.length; j++) {
          if (world.snakes[j].id === pendingKillerId) ghost = world.snakes[j];
        }
      }
      shake = 14;
      flash = 0.9;
      sfx.death();
      showDeath(pendingDeathKiller, pendingDeathCause);
      pendingDeathKiller = null;
      pendingKillerId = null;
      pendingDeathCause = null;
      sfx.boost(false);
    }

    // ---- kill chime
    if (me && me.kills > lastKills) { sfx.kill(); }
    lastKills = me ? me.kills : 0;

    if (world) R.draw(world, {
      x: cam.x, y: cam.y, zoom: cam.zoom,
      shakeX: (Math.random() - 0.5) * shake,
      shakeY: (Math.random() - 0.5) * shake
    });

    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- boot
  buildSkins();
  dom.name.value = NAMES[Math.floor(Math.random() * NAMES.length)];

  var M = window.SlitherMusic;
  function paintMusicButtons() {
    var on = M.isEnabled();
    dom.music.textContent = 'Music: ' + (on ? 'on' : 'off');
    dom.music.classList.toggle('off', !on);
    dom.menuMusic.checked = on;
  }
  M.loadPreference();
  paintMusicButtons();
  dom.menuMusic.addEventListener('change', function () {
    M.setEnabled(dom.menuMusic.checked);
    paintMusicButtons();
    if (dom.menuMusic.checked) M.start();
  });
  dom.music.addEventListener('click', function () {
    M.setEnabled(!M.isEnabled());
    paintMusicButtons();
    if (M.isEnabled()) M.start();
  });

  dom.play.addEventListener('click', function () { sfx.start(); newRun(); });
  dom.again.addEventListener('click', function () {
    // clear the corpse list so respawn is cheap
    if (world) world.snakes = world.snakes.filter(function (s) { return !s.dead; });
    newRun();
  });
  dom.mute.addEventListener('click', toggleMute);
  el('quit').addEventListener('click', toMenu);
  dom.difficulty.addEventListener('change', function () {
    if (world) {
      world.diff = dom.difficulty.value;
      world.diffCfg = S.DIFFICULTY[world.diff];
    }
  });
  R.init(canvas);
  requestAnimationFrame(frame);

  // dev/QA hook: index.html?autostart=1&secs=6 jumps straight into a run
  var qs = new URLSearchParams(location.search);
  if (qs.get('autostart') === '1') {
    dom.difficulty.value = qs.get('difficulty') || 'classic';
    newRun();
    var ms = (parseInt(qs.get('secs') || '0', 10)) * 1000;
    if (ms > 0) setTimeout(function () {
      // park the camera on the biggest snake so screenshots show a full arena
      var board = world.leaderboard(1);
      if (board.length) {
        for (var i = 0; i < world.snakes.length; i++) {
          if (world.snakes[i].id === board[0].id) { cam.x = world.snakes[i].x(); cam.y = world.snakes[i].y(); }
        }
      }
    }, ms);
  }

  // test/QA handle: lets a headless browser drive and inspect a live game
  window.SlitherGame = {    world: function () { return world; },
    me: function () { return me; },
    state: function () { return state; },
    fps: function () { return fps; },
    cam: function () { return { x: cam.x, y: cam.y, zoom: cam.zoom }; },
    kill: function () { if (world && me && !me.dead) world.killSnake(me, world.leaderboard(1)[0]); },
    setMouse: function (x, y) { input.mx = x; input.my = y; },
    setBoost: function (on) { input.boost = on; },
    dig: function (x, y) {
      if (world && me && !me.dead) return world.digCell(me, x === undefined ? me.x() : x, y === undefined ? me.y() : y);
    },
    flag: function (x, y) {
      if (world && me && !me.dead) return world.flagCell(me, x === undefined ? me.x() : x, y === undefined ? me.y() : y);
    }
  };
})();
