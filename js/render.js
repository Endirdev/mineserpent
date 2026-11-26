/* Mineserpent — canvas renderer. Reads the world, draws it. Mutates nothing. */
(function (global) {
  'use strict';

  var S = global.Mineserpent;

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
  // the glow colour of each pellet hue, built once — the painter used to
  // assemble these strings (and the sweeper washes below) per pellet per frame
  var FOOD_GLOW = FOOD_TINT.map(function (c) { return rgba(c, 0.10); });

  // minesweeper number colours and their text, indexed by the adjacent-mine count:
  // the strings are interned once so the painter never assembles them per cell
  var NUM_TINT = ['', '#3fa7ff', '#7bffb0', '#ff5d6d', '#8b7bff', '#ffd166', '#c47bff', '#9fe8ff', '#ff8a4c'];
  var NUM_STR = ['', '1', '2', '3', '4', '5', '6', '7', '8'];

  // the marks pass walks the visible cells once a frame and drops what it finds
  // into these lists, which every sub-shape then paints: walking the whole window
  // once per sub-shape costed more than the painting itself. The lists are reused,
  // so a frame that finds nothing marks does not allocate.
  var MARK_FLAG = [], MARK_MINE = [];
  var MARK_WASH_F = [], MARK_WASH_M = [], MARK_WASH_R = [];
  var MARK_NUM = [[], [], [], [], [], [], [], [], [], []];

  // paint strings shared by every cell/frame; built from LOOK at boot. LOOK is a
  // frozen settings table, so deriving these once is safe.
  function buildPaints(LK) {
    return {
      washFlag: rgba('#ff4a5a', LK.washFlag),
      washMine: rgba('#ff4058', LK.washMine),
      washRevealed: rgba('#689ef0', LK.washRevealed),
      cursor: rgba('#7bffb0', LK.cursorAlpha),
    };
  }

  // per-skin paint: the rim/stripe/head/boost colours only depend on the skin,
  // so shade() runs once per skin for the whole session instead of per snake
  // per frame — ~150 string allocations a frame retired. The two number guards
  // are for the shape lab: it moves stripeAlpha/rimAlpha at runtime, so a skin
  // shaded under the old pair gets re-shaded once (two compares, no allocation).
  function skinPaint(skin, LK) {
    if (!skin.paint || skin.paintSA !== LK.stripeAlpha || skin.paintRA !== LK.rimAlpha) {
      skin.paintSA = LK.stripeAlpha;
      skin.paintRA = LK.rimAlpha;
      skin.paint = {
        rimPlayer: shadeAlpha(skin.a, 0.8, LK.rimAlpha),
        rimBot: shadeAlpha(skin.a, -0.5, LK.rimAlpha),
        stripe: rgba(skin.b, LK.stripeAlpha),
        headPlayer: shade(skin.a, 0.8),
        headBot: shade(skin.a, -0.5),
        glow: shadeAlpha(skin.a, 0.6, 0.3),
      };
    }
    return skin.paint;
  }

  // ------------------------------------------------------------- renderer
  var Render = {
    // the look: one table of paint settings, so the draw code reads them by name
    // instead of scattering magic numbers through the strokes. The values below are
    // the shipped look — the High graphics level, which keeps the halo, the glass
    // stripes and the mark veil on the snake you steer and drops them on the bots;
    // the fidelity table in js/main.js turns knobs off against this table at Medium
    // and Low. The shape lab (press K in the page) mutates this table live, and the
    // two that shade colours (stripeAlpha, rimAlpha) make skinPaint re-shade the
    // skins that were cached under the old values.
    LOOK: {
      stripeAlpha: 0.86,  // glass: opacity of the b-stripe windows (1 = solid stripes,
                          //       0 = board shows fully through the windows)
      bandMul: 1.35,      // stripe length: max(9, radius * bandMul); bigger = more glass,
                          //       and fewer antialiased dash edges per painted pixel
      rimAlpha: 0.79,     // dark rim around the opaque a segments
      rimGrow: 5,         // halo width outside the body. 0 skips the rim stroke: the halo
                          //       is 37% of the body-stroke cost at this width
      rimPlayerOnly: true, // halo on your own snake only: this is the shipped look,
                          //       and 43 of the 44 snakes on a worst-case screen are
                          //       bots, so it is nearly the whole saving. false puts
                          //       the halo back on every bot (the old default)
      glass: true,        // the b-stripe windows; false paints one solid tube (2 strokes,
                          //       no dash, no translucent pass) and covered marks stop
                          //       reading through the body
      glassPlayerOnly: false, // bots go solid, you keep the glass: retires 60% of the
                          //       snake layer at the worst camera
      veilAlpha: 0.1,     // ghost of covered marks drawn over the snakes; 0 = stripes only
      veilPlayerOnly: true, // veil only the cells your own body covers: this is the
                          //       shipped look, and the mask walk costs a couple of
                          //       thousand array writes against ~5 ms of paint. false
                          //       ghosts the marks under every bot body as well
      washRevealed: 0.09, // revealed-cell tint
      washFlag: 0.06,     // flagged-cell tint
      washMine: 0.16,     // exposed-mine tint
      cursorAlpha: 0.1,   // green cell cursor under the head
      numScale: 0.42,     // board numbers as a fraction of the cell
      numMinPx: 0,        // skip the numbers when a cell is smaller than this many
                          //       device px: 0 always draws them, and the cost they
                          //       hold is 746 fillText glyphs at the wide-open camera
      spokes: 8,          // spokes on an exposed mine, 0 keeps the disc and its rim:
                          //       8 is the shipped asterisk, and every spoke is one
                          //       antialiased subpath in the group's stroke
      glowMul: 2.1,       // a pellet's halo as a multiple of its own radius: 2.1 is
                          //       the shipped disc, 1 leaves no glow outside the core
                          //       and 0 paints no halo — the halo is the bigger half
                          //       of the food layer (2.6 of 4.7 ms at the wide-open
                          //       camera), because every one of them is an additive
                          //       antialiased blend
      glowMinPx: 0,       // skip a halo when the whole glow is under this many device
                          //       px: 0 never skips. The pellets are 1.3–2.8 px across
                          //       at the wide-open camera and 2.3–4.9 mid-play, so a
                          //       floor of 8 cuts 18% of the layer where you are zoomed
                          //       out and moves no pixel at all mid-play
      headDisc: true,     // opaque head exception to the lattice (false = all stripes)
    },

    canvas: null,
    ctx: null,
    dpr: 1,
    w: 0,
    h: 0,
    vignette: null,
    vignetteBitmap: null,
    paints: null,
    // reused byte grid marking the cells the player's body covers, for the
    // veilPlayerOnly pass: allocated once per board, cleared with one fill a frame
    _veilGrid: null,

    // the wash/cursor strings are built from LOOK at boot; the shape lab moves LOOK
    // at runtime, so it re-derives them here. Four strings per slider move, never
    // per frame. (stripeAlpha/rimAlpha are the per-skin paints' job, guarded in
    // skinPaint, and the rest of LOOK is read live by the draw code.)
    refreshPaints: function () {
      this.paints = buildPaints(this.LOOK);
    },

    init: function (canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.paints = buildPaints(this.LOOK);
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
      // vignette is screen-space, so rebuild it whenever the canvas changes. It
      // also never changes between frames, so it is baked once into a bitmap
      // instead of being rasterised as a gradient over the whole canvas every
      // frame: a radial-gradient fill costs several times a blit of the same
      // pixels. The bake uses the same transform and the same shape as the
      // painted fillRect, so the bitmap holds the pixels the fill used to
      // produce and the blit below is a 1:1 copy of them: the sheets differ
      // only by the 8-bit alpha the bitmap has to carry, max 2/255 per channel.
      // It costs one more full-canvas buffer — the canvas memory doubles, 133 MB
      // at a 4K HiDPI desktop — paid per resize.
      this.vignetteBitmap = this.bakeVignette(w, h);
      this.vignette = null;
    },

    bakeVignette: function (w, h) {
      if (!global.document || w <= 0 || h <= 0) return null;
      var sheet = global.document.createElement('canvas');
      sheet.width = this.canvas.width;
      sheet.height = this.canvas.height;
      var c = sheet.getContext('2d');
      var dpr = this.dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      var g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(2,4,12,0.62)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      return sheet;
    },

    // view: { x, y, zoom, shakeX, shakeY, alpha (world fade for fades in/out),
    //         lerp (0..1 fraction between the last two physics steps) }
    draw: function (world, view) {
      var ctx = this.ctx, w = this.w, h = this.h, dpr = this.dpr;
      var zoom = view.zoom;
      var lp = view.lerp === undefined ? 1 : view.lerp;
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
      this.drawFood(ctx, world, left, top, right, bottom, zoom);
      this.drawSnakes(ctx, world, left, top, right, bottom, zoom, lp);
      this.drawSweeperOverlay(ctx, world, left, top, right, bottom, zoom);
      this.drawEffects(ctx, world, zoom);

      // ---- vignette (screen space): one blit of the baked sheet, at the
      // identity transform so it is a 1:1 copy of the pixels the fill made
      if (this.vignetteBitmap) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.vignetteBitmap, 0, 0);
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = this.vignette;
        ctx.fillRect(0, 0, w, h);
      }
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

    // one batched pass over the visible marks: cleared cells show their number,
    // exposed mines and flags keep their glyph. Painting a mark cell by cell means
    // every flag and mine costs six separate stroke/fill calls, and each of those
    // re-resolves the paint and re-applies the arena clip — so the marks a dig or a
    // flag leaves behind made every later frame cost more to paint. The visible
    // marks are now gathered in one walk of the cells and the fills share a path,
    // while the thin strokes keep their own call: the software raster antialiases a
    // stroke batched with other cells' strokes on a wider edge than a lone one.
    drawMarks: function (ctx, sw, lx0, lx1, ly0, ly1, c, wash, mask, scalePx) {
      var lx, ly, i, wx, wy, fx, base, top2, mx, my, rr, a, k, n, run = 64;
      var len, k2, j;
      // one walk of the visible cells feeds every pass below: the window is wide
      // and a mark is rare, so re-walking it per sub-shape costed more than the
      // painting did. The veil pass can hand a byte grid of the cells it wants,
      // which keeps every list below down to that region
      MARK_FLAG.length = 0;
      MARK_MINE.length = 0;
      MARK_WASH_F.length = 0;
      MARK_WASH_M.length = 0;
      MARK_WASH_R.length = 0;
      for (k = 1; k <= 8; k++) MARK_NUM[k].length = 0;
      for (ly = ly0; ly <= ly1; ly++) {
        for (lx = lx0; lx <= lx1; lx++) {
          i = ly * sw.w + lx;
          var st = sw.state[i];
          if (st === 0) continue;
          if (mask && !mask[i]) continue;
          if (st === 2) { MARK_WASH_F.push(i); MARK_FLAG.push(i); }
          else if (sw.mine[i]) { MARK_WASH_M.push(i); MARK_MINE.push(i); }
          else {
            MARK_WASH_R.push(i);
            if (sw.adj[i] > 0) MARK_NUM[sw.adj[i]].push(i);
          }
        }
      }
      // a revealed mark always sits on a playable cell, so the state test alone is
      // enough: hidden cells are the only ones whose state stays 0
      // the washes are painted from the same walk, grouped by tint: the squares are
      // disjoint so the order between them cannot matter, and this leaves the
      // canvas resolving three paints a frame instead of one per cell.
      // Runs are merged along the row: the wash is a per-op cost, not a blend cost
      // (making the same rects opaque retired 3% of it), so issuing fewer rects is
      // what pays. An open board's 1248 washes become ~327, and the run covers the
      // exact same device pixels because it stays inside one row of revealed cells
      // of one tint: the list is walked row-major, so a run ends where the next
      // index is not the adjacent cell of the same row
      if (wash) {
        for (n = 0; n < 3; n++) {
          var list = n === 0 ? MARK_WASH_F : (n === 1 ? MARK_WASH_M : MARK_WASH_R);
          if (!list.length) continue;
          ctx.fillStyle = n === 0 ? this.paints.washFlag : (n === 1 ? this.paints.washMine : this.paints.washRevealed);
          len = list.length;
          k = 0;
          while (k < len) {
            i = list[k];
            lx = i % sw.w;
            ly = (i - lx) / sw.w;
            k2 = k + 1;
            while (k2 < len) {
              j = list[k2];
              if (j !== i + (k2 - k)) break;   // row-major: a gap means another row
              if (j % sw.w !== lx + (k2 - k)) break;
              k2++;
            }
            ctx.fillRect((sw.ix0 + lx) * c, (sw.iy0 + ly) * c, c * (k2 - k), c);
            k = k2;
          }
        }
      }
      // flag poles and bases keep their own stroke per mark: a thin stroke batched
      // with other cells' strokes gets a wider antialiased edge from the software
      // raster, and the two also blend over each other where they meet. The sheet
      // is a fill, so every sheet shares one path.
      ctx.strokeStyle = 'rgba(234,252,255,0.85)';
      ctx.lineWidth = Math.max(1.2, c * 0.03);
      for (k = 0; k < MARK_FLAG.length; k++) {
        i = MARK_FLAG[k];
        lx = i % sw.w;
        wy = (sw.iy0 + (i - lx) / sw.w) * c;
        fx = (sw.ix0 + lx) * c + c * 0.32; top2 = wy + c * 0.24;
        ctx.beginPath();
        ctx.moveTo(fx, wy + c * 0.74); ctx.lineTo(fx, top2);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff4a5a';
      ctx.beginPath();
      n = 0;
      for (k = 0; k < MARK_FLAG.length; k++) {
        i = MARK_FLAG[k];
        lx = i % sw.w;
        wy = (sw.iy0 + (i - lx) / sw.w) * c;
        fx = (sw.ix0 + lx) * c + c * 0.32; top2 = wy + c * 0.24;
        ctx.moveTo(fx, top2);
        ctx.lineTo(fx + c * 0.3, top2 + c * 0.09);
        ctx.lineTo(fx, top2 + c * 0.2);
        ctx.closePath();
        if (++n === run) { ctx.fill(); ctx.beginPath(); n = 0; }
      }
      ctx.fill();
      for (k = 0; k < MARK_FLAG.length; k++) {
        i = MARK_FLAG[k];
        lx = i % sw.w;
        wy = (sw.iy0 + (i - lx) / sw.w) * c;
        fx = (sw.ix0 + lx) * c + c * 0.32; base = wy + c * 0.74;
        ctx.beginPath();
        ctx.moveTo(fx - c * 0.13, base); ctx.lineTo(fx + c * 0.13, base);
        ctx.stroke();
      }
      // exposed mines: the disc is a fill, the rim and the spokes are strokes, and
      // a disc needs its own moveTo or the previous subpath joins on with a line
      ctx.fillStyle = 'rgba(255,63,95,0.4)';
      ctx.beginPath();
      n = 0;
      for (k = 0; k < MARK_MINE.length; k++) {
        i = MARK_MINE[k];
        lx = i % sw.w;
        mx = (sw.ix0 + lx + 0.5) * c;
        my = (sw.iy0 + (i - lx) / sw.w) * c + c / 2;
        rr = c * 0.16;
        ctx.moveTo(mx + rr, my);
        ctx.arc(mx, my, rr, 0, Math.PI * 2);
        if (++n === run) { ctx.fill(); ctx.beginPath(); n = 0; }
      }
      ctx.fill();
      ctx.strokeStyle = '#ff3f5f';
      ctx.lineWidth = Math.max(1.4, c * 0.025);
      ctx.beginPath();
      n = 0;
      for (k = 0; k < MARK_MINE.length; k++) {
        i = MARK_MINE[k];
        lx = i % sw.w;
        mx = (sw.ix0 + lx + 0.5) * c;
        my = (sw.iy0 + (i - lx) / sw.w) * c + c / 2;
        rr = c * 0.16;
        ctx.moveTo(mx + rr, my);
        ctx.arc(mx, my, rr, 0, Math.PI * 2);
        if (++n === run) { ctx.stroke(); ctx.beginPath(); n = 0; }
      }
      ctx.stroke();
      ctx.beginPath();
      n = 0;
      var spokeN = this.LOOK.spokes;
      if (spokeN > 0) {
        for (k = 0; k < MARK_MINE.length; k++) {
          i = MARK_MINE[k];
          lx = i % sw.w;
          mx = (sw.ix0 + lx + 0.5) * c;
          my = (sw.iy0 + (i - lx) / sw.w) * c + c / 2;
          rr = c * 0.16;
          for (a = 0; a < spokeN; a++) {
            var ang = a * Math.PI * 2 / spokeN;
            ctx.moveTo(mx + Math.cos(ang) * rr * 1.2, my + Math.sin(ang) * rr * 1.2);
            ctx.lineTo(mx + Math.cos(ang) * rr * 1.85, my + Math.sin(ang) * rr * 1.85);
          }
          if (++n === run) { ctx.stroke(); ctx.beginPath(); n = 0; }
        }
        ctx.stroke();
      }
      // the numbers: the font is set once and the colour once per value, so the
      // canvas resolves its paint eight times a frame instead of once per cell.
      // numMinPx skips them below a legibility floor: 746 glyphs at ~5.6 us an
      // op is most of the layer's cost at the wide-open camera, and at a cell
      // under that floor the digits read as smudges anyway
      var numOn = true;
      if (this.LOOK.numMinPx > 0 && scalePx && c * scalePx < this.LOOK.numMinPx) numOn = false;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.round(c * this.LOOK.numScale) + 'px system-ui, sans-serif';
      for (var v = 1; numOn && v <= 8; v++) {
        var bucket = MARK_NUM[v];
        if (!bucket.length) continue;
        ctx.fillStyle = NUM_TINT[v];
        for (k = 0; k < bucket.length; k++) {
          i = bucket[k];
          lx = i % sw.w;
          wy = (sw.iy0 + (i - lx) / sw.w) * c + c / 2 + 1;
          ctx.fillText(NUM_STR[v], (sw.ix0 + lx + 0.5) * c, wy);
        }
      }
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
      // the passes painted after this one inherit the text cursor, and the snake
      // nameplates set only their alignment: leave the same alignment and baseline
      // the per-cell pass left behind, or the labels sit a font ascent off
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // paint strictly inside the arena circle: edge cells are playable (their centre
      // is in), but their squares must be cut by the ring, like the grid lines do
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, world.radius, 0, Math.PI * 2);
      ctx.clip();
      this.drawMarks(ctx, sw, lx0, lx1, ly0, ly1, c, true, null, zoom * this.dpr);

      // the cursor marks where a dig lands: the square under the pointer when one is
      // about, otherwise the head's square (keys and touch buttons dig where you are)
      var tx = null, ty = null;
      if (world.hover) {
        tx = world.hover.x;
        ty = world.hover.y;
      } else if (world.player && !world.player.dead) {
        tx = world.player.x();
        ty = world.player.y();
      }
      if (tx !== null) {
        var hx = Math.floor(tx / c) - sw.ix0;
        var hy = Math.floor(ty / c) - sw.iy0;
        if (hx >= 0 && hy >= 0 && hx < sw.w && hy < sw.h && sw.inside[hy * sw.w + hx]) {
          var px = (sw.ix0 + hx) * c, py = (sw.iy0 + hy) * c;
          var pad = c * 0.06;
          ctx.strokeStyle = this.paints.cursor;
          ctx.lineWidth = Math.max(1.2, c * 0.02);
          ctx.strokeRect(px + pad, py + pad, c - 2 * pad, c - 2 * pad);
        }
      }
      ctx.restore();
    },

    // the veil pass, painted after the snakes: the same glyphs at veilAlpha. 0 turns
    // it off and leaves visibility entirely to the body's stripe windows. veilPlayerOnly
    // restricts it to the cells the player's own body covers: the pass goes from every
    // mark in the arena (1248 at the worst camera) to the few hundred the body touches,
    // and the mask walk is a couple thousand array writes against ~6 ms of paint.
    drawSweeperOverlay: function (ctx, world, left, top, right, bottom, zoom) {
      var sw = world.sweeper;
      if (!sw || this.LOOK.veilAlpha <= 0) return;
      var c = sw.cell;
      var lx0 = Math.max(0, Math.floor(left / c) - sw.ix0);
      var lx1 = Math.min(sw.w - 1, Math.floor(right / c) - sw.ix0);
      var ly0 = Math.max(0, Math.floor(top / c) - sw.iy0);
      var ly1 = Math.min(sw.h - 1, Math.floor(bottom / c) - sw.iy0);
      var mask = null;
      if (this.LOOK.veilPlayerOnly) {
        var n = sw.w * sw.h;
        if (!this._veilGrid || this._veilGrid.length !== n) this._veilGrid = new Uint8Array(n);
        mask = this._veilGrid;
        mask.fill(0);
        var ps = null;
        for (var q = 0; q < world.snakes.length; q++) {
          var sn = world.snakes[q];
          if (sn.player && !sn.dead) { ps = sn; break; }
        }
        if (!ps) return;   // nothing of yours is on the board to ghost under
        // the tube the body pass just painted, plus slack: the body is painted
        // interpolated between the last two steps while these points are the
        // post-step ones, and the mask is cell-granular (120 world px) anyway
        var rr = ps.r + this.LOOK.rimGrow * 0.5 + 6;
        var pts = ps.pts;
        for (var q2 = 0; q2 < pts.length; q2++) {
          var p = pts[q2];
          var cx0 = Math.floor((p.x - rr) / c) - sw.ix0, cx1 = Math.floor((p.x + rr) / c) - sw.ix0;
          var cy0 = Math.floor((p.y - rr) / c) - sw.iy0, cy1 = Math.floor((p.y + rr) / c) - sw.iy0;
          for (var yy = cy0; yy <= cy1; yy++) {
            if (yy < 0 || yy >= sw.h) continue;
            for (var xx = cx0; xx <= cx1; xx++) {
              if (xx < 0 || xx >= sw.w) continue;
              mask[yy * sw.w + xx] = 1;
            }
          }
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, world.radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = this.LOOK.veilAlpha;
      this.drawMarks(ctx, sw, lx0, lx1, ly0, ly1, c, false, mask, zoom * this.dpr);
      ctx.restore();
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

    drawFood: function (ctx, world, left, top, right, bottom, zoom) {
      var food = world.food;
      // the halo is the bigger half of this layer and it is pure additive blend: a
      // 5.9 px disc at alpha 0.1 costs the same per-op raster as the 2.8 px core
      // under it, so glowMul shrinks it and glowMinPx drops it below a legibility
      // floor, both in device px so the floor only fires where a halo is a smear.
      // mul > 0 and lod = 0 keep the shipped shape and the shipped pixels exactly
      var mul = this.LOOK.glowMul;
      var lod = zoom ? this.LOOK.glowMinPx : 0;
      var scale = this.dpr * zoom;
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < food.length; i++) {
        var f = food[i];
        if (f.eaten) continue;
        if (f.x < left || f.x > right || f.y < top || f.y > bottom) continue;
        var idx = f.hue % FOOD_TINT.length;
        if (mul > 0 && f.r * mul * 2 * scale >= lod) {
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * mul, 0, Math.PI * 2);
          ctx.fillStyle = FOOD_GLOW[idx];
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = FOOD_TINT[idx];
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

    // dash patterns reused between frames: rounding the band to 0.1px means one
    // cached array covers every snake whose tube width lands in the same tenth
    _dashCache: Object.create(null),
    dashFor: function (band) {
      var k = band.toFixed(1);
      var a = this._dashCache[k];
      if (!a) a = this._dashCache[k] = [band, band];
      return a;
    },

    drawSnakes: function (ctx, world, left, top, right, bottom, zoom, lp) {
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

      var LK = this.LOOK;
      // nameplate font is the same for every snake in a frame — build it once
      var fs = Math.max(9, Math.round(13 / zoom));
      var nameFont = '600 ' + fs + 'px system-ui, sans-serif';

      for (var k = 0; k < list.length; k++) {
        var s2 = list[k];
        var pts = s2.pts, r = s2.r, paint = skinPaint(s2.skin, LK);
        var blinking = s2.grace > 0 && (Math.floor(s2.grace * 8) % 2 === 0);
        ctx.globalAlpha = blinking ? 0.45 : 1;

        // path from head to tail, drawn between the last two physics states so
        // motion stays smooth on displays faster than the 60Hz simulation step
        var h0 = pts[0];
        var hx = h0.px + (h0.x - h0.px) * lp;
        var hy = h0.py + (h0.y - h0.py) * lp;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        for (var j = 1; j < pts.length; j++) {
          var p = pts[j];
          ctx.lineTo(p.px + (p.x - p.px) * lp, p.py + (p.y - p.py) * lp);
        }

        if (s2.boost) {
          ctx.lineWidth = 2 * r + 18;
          ctx.strokeStyle = paint.glow;
          ctx.stroke();
        }

        // two alternating dash phases instead of solid body + stripes over it: the
        // a segments (rim included) are opaque and hide the board, the b stripes are
        // translucent windows so minesweeper marks under the snake read through them,
        // dimmed by the stripe colour — genuinely "from behind".
        // The body is where the frame cost lives (46% of the worst one, 71% of a
        // normal one) and the cost tracks painted area, so the shape is a knob the
        // player can move: rimGrow 0 skips the halo stroke, glass false paints one
        // solid tube. Both defaults, 5 px and true, keep the shipped strokes.
        var band = Math.round(Math.max(9, r * LK.bandMul) * 10) / 10;   // 0.1px step: matches the dash cache
        // the shape knobs are per snake: the player-only variants keep your own tube
        // exactly as the shipped look and move only the bots, whose share of a
        // crowded screen is what makes the saving worth taking
        var mine = s2.player;
        var windows = LK.glass && (mine || !LK.glassPlayerOnly);
        var halo = (LK.rimGrow > 0 && (mine || !LK.rimPlayerOnly)) ? LK.rimGrow : 0;
        ctx.save();
        ctx.lineCap = 'butt';
        if (windows) ctx.setLineDash(this.dashFor(band));
        else ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        if (halo > 0) {
          ctx.lineWidth = 2 * r + halo;
          ctx.strokeStyle = s2.player ? paint.rimPlayer : paint.rimBot;
          ctx.stroke();
        }
        ctx.lineWidth = 2 * r;
        ctx.strokeStyle = s2.skin.a;
        ctx.stroke();
        if (windows) {
          ctx.lineDashOffset = band;    // half a period over: fills exactly the gaps
          ctx.lineWidth = 2 * r;
          ctx.strokeStyle = paint.stripe;
          ctx.stroke();
        }
        ctx.restore();

        // the head is the exception to the lattice, unless the knob turns it off
        if (LK.headDisc) {
          ctx.beginPath();
          ctx.arc(hx, hy, r + 2.5, 0, Math.PI * 2);
          ctx.fillStyle = s2.player ? paint.headPlayer : paint.headBot;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(hx, hy, r, 0, Math.PI * 2);
          ctx.fillStyle = s2.skin.a;
          ctx.fill();
        }

        this.drawFace(ctx, s2, zoom, hx, hy);

        // nameplate
        ctx.font = nameFont;
        ctx.textAlign = 'center';
        ctx.fillStyle = s2.player ? '#ffffff' : 'rgba(226,236,255,0.72)';
        ctx.fillText(s2.name, hx, hy - r - fs * 0.9);
        ctx.globalAlpha = 1;
      }
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
    },

    drawFace: function (ctx, s, zoom, hx, hy) {
      var r = s.r;
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

  global.MineserpentRender = Render;
})(typeof window !== 'undefined' ? window : globalThis);
