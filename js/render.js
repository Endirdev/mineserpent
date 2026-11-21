/* Slither Local — canvas renderer. Reads the world, draws it. Mutates nothing. */
(function (global) {
  'use strict';

  var S = global.Slither;

  // ------------------------------------------------------------- colour
  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  // amt > 0 lightens, amt < 0 darkens
  function shade(hex, amt) {
    var c = hexToRgb(hex);
    var f = amt < 0 ? 0 : 255;
    var p = Math.abs(amt);
    return 'rgb(' + Math.round(c.r + (f - c.r) * p) + ',' +
      Math.round(c.g + (f - c.g) * p) + ',' +
      Math.round(c.b + (f - c.b) * p) + ')';
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  // lighten/darken AND set alpha, in one step (rgba() only accepts hex input)
  function shadeAlpha(hex, amt, a) {
    var c = hexToRgb(hex);
    var f = amt < 0 ? 0 : 255;
    var p = Math.abs(amt);
    return 'rgba(' + Math.round(c.r + (f - c.r) * p) + ',' +
      Math.round(c.g + (f - c.g) * p) + ',' +
      Math.round(c.b + (f - c.b) * p) + ',' + a + ')';
  }

  var FOOD_TINT = ['#8ef7ff', '#ffe27a', '#b6ff7a', '#ff9bd0'];

  // minesweeper number colours, indexed by the adjacent-mine count
  var NUM_TINT = ['', '#3fa7ff', '#7bffb0', '#ff5d6d', '#8b7bff', '#ffd166', '#c47bff', '#9fe8ff', '#ff8a4c'];

  // ------------------------------------------------------------- renderer
  var Render = {
    canvas: null,
    ctx: null,
    dpr: 1,
    w: 0,
    h: 0,
    vignette: null,

    init: function (canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.resize();
      var self = this;
      global.addEventListener('resize', function () { self.resize(); });
    },

    resize: function () {
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      var w = this.canvas.clientWidth || global.innerWidth;
      var h = this.canvas.clientHeight || global.innerHeight;
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      // vignette is screen-space, so rebuild it whenever the canvas changes
      var g = this.ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(2,4,12,0.62)');
      this.vignette = g;
    },

    // view: { x, y, zoom, shakeX, shakeY, alpha (world fade for fades in/out) }
    draw: function (world, view) {
      var ctx = this.ctx, w = this.w, h = this.h, dpr = this.dpr;
      var zoom = view.zoom;
      var camX = view.x + (view.shakeX || 0);
      var camY = view.y + (view.shakeY || 0);

      // ---- background (screen space)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#050a18';
      ctx.fillRect(0, 0, w, h);

      // ---- world space
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (w / 2 - camX * zoom), dpr * (h / 2 - camY * zoom));

      var vw = w / zoom, vh = h / zoom;
      var left = camX - vw / 2, top = camY - vh / 2, right = camX + vw / 2, bottom = camY + vh / 2;
      var margin = 90;
      left -= margin; top -= margin; right += margin; bottom += margin;

      this.drawGrid(ctx, world, left, top, right, bottom, zoom);
      this.drawSweeper(ctx, world, left, top, right, bottom, zoom);
      this.drawBoundary(ctx, world, zoom);
      this.drawFood(ctx, world, left, top, right, bottom);
      this.drawSnakes(ctx, world, left, top, right, bottom, zoom);
      this.drawSweeperOverlay(ctx, world, left, top, right, bottom, zoom);
      this.drawEffects(ctx, world, zoom);

      // ---- vignette (screen space)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, w, h);
    },

    drawGrid: function (ctx, world, left, top, right, bottom, zoom) {
      var step = world.cell || 120;
      var R = world.radius;
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = 'rgba(90,140,220,0.13)';
      ctx.beginPath();
      // the minefield cells live on exact multiples of step, so the drawn lines must
      // too: clamp the start to the arena, then snap it back onto the lattice — a raw
      // -R start (2600 is not a multiple of 120) would shift the whole grid by 40 px
      // near the west/north edge
      var x0 = Math.max(-R, Math.floor(left / step) * step);
      x0 = Math.ceil(x0 / step) * step;
      var x1 = Math.min(R, right);
      for (var x = x0; x <= x1; x += step) {
        var chord = Math.sqrt(Math.max(0, R * R - x * x));
        if (chord <= 0) continue;
        var lo = Math.max(-chord, top), hi = Math.min(chord, bottom);
        if (lo >= hi) continue;
        ctx.moveTo(x, lo); ctx.lineTo(x, hi);
      }
      var y0 = Math.max(-R, Math.floor(top / step) * step);
      y0 = Math.ceil(y0 / step) * step;
      var y1 = Math.min(R, bottom);
      for (var y = y0; y <= y1; y += step) {
        var chord2 = Math.sqrt(Math.max(0, R * R - y * y));
        if (chord2 <= 0) continue;
        var lo2 = Math.max(-chord2, left), hi2 = Math.min(chord2, right);
        if (lo2 >= hi2) continue;
        ctx.moveTo(lo2, y); ctx.lineTo(hi2, y);
      }
      ctx.stroke();
    },

    // the minesweeper layer: cleared cells, their numbers, exposed mines, flags, and
    // the green cursor marking the cell the player's head is in (where a dig lands)
    drawSweeper: function (ctx, world, left, top, right, bottom, zoom) {
      var sw = world.sweeper;
      if (!sw) return;
      var c = sw.cell;
      var lx0 = Math.max(0, Math.floor(left / c) - sw.ix0);
      var lx1 = Math.min(sw.w - 1, Math.floor(right / c) - sw.ix0);
      var ly0 = Math.max(0, Math.floor(top / c) - sw.iy0);
      var ly1 = Math.min(sw.h - 1, Math.floor(bottom / c) - sw.iy0);
      var fs = Math.round(c * 0.42);
      var numFont = '700 ' + fs + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // paint strictly inside the arena circle: edge cells are playable (their centre
      // is in), but their squares must be cut by the ring, like the grid lines do
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, world.radius, 0, Math.PI * 2);
      ctx.clip();
      for (var ly = ly0; ly <= ly1; ly++) {
        var wy = (sw.iy0 + ly) * c;
        for (var lx = lx0; lx <= lx1; lx++) {
          var i = ly * sw.w + lx;
          if (!sw.inside[i]) continue;
          var wx = (sw.ix0 + lx) * c;
          var st = sw.state[i];
          if (st === 2) {
            ctx.fillStyle = 'rgba(255,74,90,0.06)';
            ctx.fillRect(wx, wy, c, c);
            this.drawFlag(ctx, wx, wy, c);
          } else if (st === 0) {
            continue;   // hidden cells are just the grid
          } else if (sw.mine[i]) {
            ctx.fillStyle = 'rgba(255,64,88,0.16)';
            ctx.fillRect(wx, wy, c, c);
            this.drawMine(ctx, wx, wy, c);
          } else {
            ctx.fillStyle = 'rgba(104,158,240,0.09)';
            ctx.fillRect(wx, wy, c, c);
            var n = sw.adj[i];
            if (n > 0) {
              ctx.font = numFont;
              ctx.fillStyle = NUM_TINT[n];
              ctx.fillText(String(n), wx + c / 2, wy + c / 2 + 1);
            }
          }
        }
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      if (world.player && !world.player.dead) {
        var hx = Math.floor(world.player.x() / c) - sw.ix0;
        var hy = Math.floor(world.player.y() / c) - sw.iy0;
        if (hx >= 0 && hy >= 0 && hx < sw.w && hy < sw.h && sw.inside[hy * sw.w + hx]) {
          var px = (sw.ix0 + hx) * c, py = (sw.iy0 + hy) * c;
          var pad = c * 0.06;
          ctx.strokeStyle = 'rgba(123,255,176,0.55)';
          ctx.lineWidth = Math.max(1.2, c * 0.02);
          ctx.strokeRect(px + pad, py + pad, c - 2 * pad, c - 2 * pad);
        }
      }
      ctx.restore();
    },

    // the veil pass, painted over the snakes: the very same glyphs again at half alpha.
    // Where nothing covers them this is invisible under the full-contrast copies below;
    // where a body crosses them the glyph reads through it like it is behind the snake,
    // instead of being hidden or punched out hard
    drawSweeperOverlay: function (ctx, world, left, top, right, bottom, zoom) {
      var sw = world.sweeper;
      if (!sw) return;
      var c = sw.cell;
      var lx0 = Math.max(0, Math.floor(left / c) - sw.ix0);
      var lx1 = Math.min(sw.w - 1, Math.floor(right / c) - sw.ix0);
      var ly0 = Math.max(0, Math.floor(top / c) - sw.iy0);
      var ly1 = Math.min(sw.h - 1, Math.floor(bottom / c) - sw.iy0);
      var fs = Math.round(c * 0.42);
      var numFont = '700 ' + fs + 'px system-ui, sans-serif';
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, world.radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = 0.5;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = numFont;
      for (var ly = ly0; ly <= ly1; ly++) {
        var wy = (sw.iy0 + ly) * c;
        for (var lx = lx0; lx <= lx1; lx++) {
          var i = ly * sw.w + lx;
          if (!sw.inside[i]) continue;
          var st = sw.state[i];
          if (st === 2) {
            this.drawFlag(ctx, (sw.ix0 + lx) * c, wy, c);
          } else if (st === 0) {
            continue;
          } else if (sw.mine[i]) {
            this.drawMine(ctx, (sw.ix0 + lx) * c, wy, c);
          } else if (sw.adj[i] > 0) {
            ctx.fillStyle = NUM_TINT[sw.adj[i]];
            ctx.fillText(String(sw.adj[i]), (sw.ix0 + lx + 0.5) * c, wy + c / 2 + 1);
          }
        }
      }
      ctx.restore();
    },

    drawFlag: function (ctx, x, y, c) {
      var fx = x + c * 0.32, base = y + c * 0.74, top = y + c * 0.24;
      ctx.strokeStyle = 'rgba(234,252,255,0.85)';
      ctx.lineWidth = Math.max(1.2, c * 0.03);
      ctx.beginPath();
      ctx.moveTo(fx, base);
      ctx.lineTo(fx, top);
      ctx.stroke();
      ctx.fillStyle = '#ff4a5a';
      ctx.beginPath();
      ctx.moveTo(fx, top);
      ctx.lineTo(fx + c * 0.3, top + c * 0.09);
      ctx.lineTo(fx, top + c * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(fx - c * 0.13, base);
      ctx.lineTo(fx + c * 0.13, base);
      ctx.stroke();
    },

    drawMine: function (ctx, x, y, c) {
      var mx = x + c / 2, my = y + c / 2, rr = c * 0.16;
      ctx.strokeStyle = '#ff3f5f';
      ctx.fillStyle = 'rgba(255,63,95,0.4)';
      ctx.lineWidth = Math.max(1.4, c * 0.025);
      ctx.beginPath();
      ctx.arc(mx, my, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      for (var k2 = 0; k2 < 8; k2++) {
        var a = k2 * Math.PI / 4;
        ctx.moveTo(mx + Math.cos(a) * rr * 1.2, my + Math.sin(a) * rr * 1.2);
        ctx.lineTo(mx + Math.cos(a) * rr * 1.85, my + Math.sin(a) * rr * 1.85);
      }
      ctx.stroke();
    },

    drawBoundary: function (ctx, world, zoom) {
      var R = world.radius;
      ctx.beginPath();
      ctx.arc(0, 0, R + 45, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,40,85,0.07)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.lineWidth = 26;
      ctx.strokeStyle = 'rgba(255,42,92,0.16)';
      ctx.stroke();
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#ff2b5e';
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255,200,215,0.75)';
      ctx.setLineDash([26, 16]);
      ctx.stroke();
      ctx.setLineDash([]);
    },

    drawFood: function (ctx, world, left, top, right, bottom) {
      var food = world.food;
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < food.length; i++) {
        var f = food[i];
        if (f.eaten) continue;
        if (f.x < left || f.x > right || f.y < top || f.y > bottom) continue;
        var col = FOOD_TINT[f.hue % FOOD_TINT.length];
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, 0.10);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },

    inView: function (pts, left, top, right, bottom) {
      for (var i = 0; i < pts.length; i += 6) {
        var p = pts[i];
        if (p.x > left && p.x < right && p.y > top && p.y < bottom) return true;
      }
      var l = pts[pts.length - 1];
      return l.x > left && l.x < right && l.y > top && l.y < bottom;
    },

    drawSnakes: function (ctx, world, left, top, right, bottom, zoom) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // draw small snakes last so the big ones sit behind them
      var list = [];
      for (var i = 0; i < world.snakes.length; i++) {
        var s = world.snakes[i];
        if (s.dead) continue;
        if (!this.inView(s.pts, left, top, right, bottom)) continue;
        list.push(s);
      }
      list.sort(function (a, b) { return b.mass - a.mass; });

      for (var k = 0; k < list.length; k++) {
        var s2 = list[k];
        var pts = s2.pts, r = s2.r, skin = s2.skin;
        var blinking = s2.grace > 0 && (Math.floor(s2.grace * 8) % 2 === 0);
        ctx.globalAlpha = blinking ? 0.45 : 1;

        // path from head to tail
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);

        if (s2.boost) {
          ctx.lineWidth = 2 * r + 18;
          ctx.strokeStyle = shadeAlpha(skin.a, 0.6, 0.3);
          ctx.stroke();
        }

        // two alternating dash phases instead of solid body + stripes over it: the
        // a segments (rim included) are opaque and hide the board, the b stripes are
        // translucent windows so minesweeper marks under the snake read through them,
        // dimmed by the stripe colour — genuinely "from behind"
        var band = Math.max(9, r * 1.35);
        ctx.save();
        ctx.lineCap = 'butt';
        ctx.setLineDash([band, band]);
        ctx.lineDashOffset = 0;
        ctx.lineWidth = 2 * r + 5;
        ctx.strokeStyle = s2.player ? shade(skin.a, 0.8) : shade(skin.a, -0.5);
        ctx.stroke();
        ctx.lineWidth = 2 * r;
        ctx.strokeStyle = skin.a;
        ctx.stroke();
        ctx.lineDashOffset = band;    // half a period over: fills exactly the gaps
        ctx.lineWidth = 2 * r;
        ctx.strokeStyle = rgba(skin.b, 0.6);
        ctx.stroke();
        ctx.restore();

        this.drawFace(ctx, s2, zoom);

        // nameplate
        var fs = Math.max(9, Math.round(13 / zoom));
        ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = s2.player ? '#ffffff' : 'rgba(226,236,255,0.72)';
        ctx.fillText(s2.name, pts[0].x, pts[0].y - r - fs * 0.9);
        ctx.globalAlpha = 1;
      }
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
    },

    drawFace: function (ctx, s, zoom) {
      var r = s.r;
      var hx = s.pts[0].x, hy = s.pts[0].y;
      var ca = Math.cos(s.angle), sa = Math.sin(s.angle);
      var px = -sa, py = ca;                 // perpendicular
      var eyeR = Math.max(1.4, r * 0.33);
      var pupilR = eyeR * 0.55;
      for (var side = -1; side <= 1; side += 2) {
        var ex = hx + ca * r * 0.32 + px * side * r * 0.55;
        var ey = hy + sa * r * 0.32 + py * side * r * 0.55;
        ctx.beginPath();
        ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
        ctx.fillStyle = '#fdffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex + ca * eyeR * 0.35, ey + sa * eyeR * 0.35, pupilR, 0, Math.PI * 2);
        ctx.fillStyle = '#0b1020';
        ctx.fill();
      }
    },

    drawEffects: function (ctx, world, zoom) {
      for (var i = 0; i < world.effects.length; i++) {
        var e = world.effects[i];
        if (e.type !== 'shock') continue;
        var t = e.t / 0.7;
        var r = e.r + (e.max - e.r) * t;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, (1 - t) * 9);
        ctx.strokeStyle = 'rgba(255,235,180,' + (0.5 * (1 - t)).toFixed(3) + ')';
        ctx.stroke();
      }
    },

    // small overhead map of the whole arena
    drawMinimap: function (world, canvas, me) {
      var ctx = canvas.getContext('2d');
      var w = canvas.width, h = canvas.height;
      var cx = w / 2, cy = h / 2, scale = (Math.min(w, h) / 2 - 3) / world.radius;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(cx, cy, world.radius * scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8,14,30,0.65)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,43,94,0.8)';
      ctx.stroke();

      // cleared minefield area, so routes across the board are visible
      var sw = world.sweeper;
      if (sw) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, world.radius * scale, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(123,255,176,0.14)';
        var s1 = Math.max(1.4, sw.cell * scale);
        for (var i2 = 0; i2 < sw.w * sw.h; i2++) {
          if (!sw.inside[i2] || sw.state[i2] !== 1 || sw.mine[i2]) continue;
          var lxx = i2 % sw.w, lyy = (i2 - lxx) / sw.w;
          ctx.fillRect(cx + (sw.ix0 + lxx + 0.5) * sw.cell * scale - s1 / 2,
                       cy + (sw.iy0 + lyy + 0.5) * sw.cell * scale - s1 / 2, s1, s1);
        }
        ctx.restore();
      }

      for (var i = 0; i < world.snakes.length; i++) {
        var s = world.snakes[i];
        if (s.dead) continue;
        ctx.beginPath();
        ctx.arc(cx + s.x() * scale, cy + s.y() * scale, s.player ? 3 : 2, 0, Math.PI * 2);
        ctx.fillStyle = s.player ? '#7bffb0' : (s.mass > (me ? me.mass * 1.3 : 120) ? '#ff6060' : 'rgba(255,210,120,0.85)');
        ctx.fill();
      }
    }
  };

  global.SlitherRender = Render;
})(typeof window !== 'undefined' ? window : globalThis);
