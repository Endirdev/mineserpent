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
      this.drawBoundary(ctx, world, zoom);
      this.drawFood(ctx, world, left, top, right, bottom);
      this.drawSnakes(ctx, world, left, top, right, bottom, zoom);
      this.drawEffects(ctx, world, zoom);

      // ---- vignette (screen space)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, w, h);
    },

    drawGrid: function (ctx, world, left, top, right, bottom, zoom) {
      var step = 120;
      var R = world.radius;
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = 'rgba(90,140,220,0.13)';
      ctx.beginPath();
      var x0 = Math.max(-R, Math.floor(left / step) * step);
      var x1 = Math.min(R, right);
      for (var x = x0; x <= x1; x += step) {
        var chord = Math.sqrt(Math.max(0, R * R - x * x));
        if (chord <= 0) continue;
        var lo = Math.max(-chord, top), hi = Math.min(chord, bottom);
        if (lo >= hi) continue;
        ctx.moveTo(x, lo); ctx.lineTo(x, hi);
      }
      var y0 = Math.max(-R, Math.floor(top / step) * step);
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

        ctx.lineWidth = 2 * r + 5;
        ctx.strokeStyle = s2.player ? shade(skin.a, 0.8) : shade(skin.a, -0.5);
        ctx.stroke();

        ctx.lineWidth = 2 * r;
        ctx.strokeStyle = skin.a;
        ctx.stroke();

        // alternating rings of the second skin colour, the Slither stripe.
        // butt caps: round caps would stretch every dash by half the tube width and
        // fuse the rings into a solid line.
        var band = Math.max(9, r * 1.35);
        ctx.save();
        ctx.lineCap = 'butt';
        ctx.setLineDash([band, band]);
        ctx.lineWidth = 2 * r;
        ctx.strokeStyle = skin.b;
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
