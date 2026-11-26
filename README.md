# Mineserpent

A local, offline clone of Slither.io. No server, no build step, no dependencies — the
bots play the game exactly the way people do: they hunt pellets, dodge bodies, chase
smaller snakes, cut things off, and die to the ring.

Open `index.html` in a browser and you are playing.

## Published

**https://endirdev.github.io/mineserpent/** — GitHub Pages, served from the root of `main`.
No build step: Pages copies the files verbatim (`.nojekyll` opts out of Jekyll so nothing
is transformed), so the deployed page is byte-for-byte the one in this repo.

Redeploying is just pushing; Pages picks up a push to `main` in about a minute.

```
git add -A && git commit -m "what changed" && git push
```

The browser only ever fetches `index.html`, `styles.css`, the four `js/` files and
`audio/neon-drift.ogg`. `tools/` and `test/` are for regenerating and checking, and are
public alongside the rest.

```
mineserpent/
  index.html        the page: canvas + menu + HUD + death card
  styles.css        UI chrome
  js/core.js        the simulation (no DOM: runs in Node too)
  js/render.js      canvas painter (no logic)
  js/main.js        glue: input, camera, sound, UI
  js/music.js       background music: fade-in, ducking, on/off
  audio/            neon-drift.ogg (3.9 MB) + .mp3 fallback
  tools/make_track.py    synthesizes the soundtrack from scratch
  tools/test_master.py   unit checks for the master-chain blocks
  tools/analyze_track.py checks the rendered track (tempo, tuning, headroom, clipping)
  tools/bench-page.mjs   headless-Chrome frame bench: world.step and Render.draw on the real page
  tools/bench-draw.mjs   painter bench: one fixed scene, timed as a batch
  tools/bench-pacing.mjs frame pacing bench: what the rAF loop renders per frame at any refresh rate
  test/smoke.mjs    headless simulation + rule tests
  test/bench.mjs    seeded-PRNG simulation bench (match + stress scenarios)
```

## Play

| Input | Action |
| --- | --- |
| Mouse | steer toward the cursor |
| Space, Shift **or** middle click | boost (burns your own length, drops it as food behind you) |
| A / D, arrows | steer without a mouse |
| Left click | dig **any** grid square on the board |
| Right click | flag or unflag any grid square |
| S / F | dig / flag the grid cell your head is on |
| M | mute |
| Esc | back to the menu |
| Touch | drag to steer, the **Boost**, **Dig** and **Flag** buttons appear on small screens |

Rules, same as the real thing:

- Eat pellets to grow. Length is your score.
- Your head touching another snake's body kills **you**; their body bursts into food.
- Head to head kills **both**.
- The red ring kills you.
- Boost is paid for with length, so a boosted snake shrinks.

**The minefield** — this branch frankensteins a minesweeper onto the same grid: every
world grid square hides either a safe cell or a mine (~9/12/15% by difficulty). A left
click names any square and digs it, a right click flags or unflags it; `S` / `F` dig and
flag the square your **head** is on, for when you would rather dig where you are. Blanks
cascade, numbers with matching flags chord (dig again on a satisfied number and the rest
of the ring opens). Hidden mines are inert — a snake slithers over them without trouble;
only a dig detonates, and a blast chain-detonates neighbouring mines and kills the digger,
credited honestly on the death card ("You dug a mine", not "you hit the wall"). Clear all
~1300 safe cells and the feed awards +60 length. The cleared area paints onto the minimap
so you can plan routes across the board, and the death card reports how much you swept.
The two games never otherwise interact: bots never dig, and mines never touch movement.
The first dig of every run is a guaranteed safe probe — if a mine sat under it, the mine
just moves to a hidden cell somewhere else (spawn cells are mine-free for the same reason).

## Running the tests

Simulation and game rules, headless, no browser:

```
node test/smoke.mjs
```

It plays 90 simulated seconds of *Ruthless*, prints the match report, then runs
deterministic rule checks: cut-offs, head-to-head, ring deaths, growth, boost cost and
boost payout — plus the minefield: density, adjacent counts, dig/flag/chord behaviour,
full-clear and spawn safety. It also asserts `world.step` stays well inside a 16.6 ms frame.

If you have Chrome and puppeteer-core, a page-level QA run drives the real UI
(menu, real mouse and keyboard events, HUD, kill feed, death card, respawn, mute) and
writes screenshots to `/tmp/opencode/shots`.

## Performance

The simulation is benchmarked headless with a **seeded PRNG**, so a run before a change
and a run after it play the same match and the numbers mean something:

```
npm install --no-save puppeteer-core   # dev-only; the game itself has no deps
node test/bench.mjs                    # medians for two scenarios, vs the saved baseline
node test/bench.mjs --baseline         # re-record the baseline after a deliberate change
node tools/bench-page.mjs              # real page in headless Chrome: step + draw per frame
node tools/bench-draw.mjs              # painter-only: one fixed scene, 300 draws as a batch
node tools/bench-draw.mjs --baseline   # re-record; also prints frame p50/p95/max
node tools/bench-pass.mjs              # what each pass of a frame is worth, both cameras
node tools/pixel-diff.mjs . 9e21ae7    # two painters, one scene: how many pixels moved
node tools/bench-pacing.mjs --simhz=144  # frame pacing emulating a 144Hz display
node tools/bench-pass.mjs --look glass=false,veilAlpha=0  # price a dialled look
node tools/pixel-diff.mjs . . --view worst --look rimPlayerOnly=true  # what a look does to the picture
```

Reading the render benches needs three facts about how they run:

- **Software raster.** They pass `--disable-gpu`, and headless Chrome builds no GL
  context at all, so absolute ms describe this machine, not your GPU. Only same-machine
  before/after counts mean something; the same code measured in two sittings drifts ~10%
  (the fixed scene read 10.0–10.3 ms one session and 11.0–11.4 ms the next).
- **Chromium defers 2D canvas work.** A frame or a pass measured on its own only times
  the recording of its display list until a flush runs, so `bench-pass` forces a flush
  (a 1x1 readback) per pass and per frame and calibrates the readback out. That is also
  why `bench-pass`'s passes do not sum to its frame line, and why its frame line sits
  above `bench-draw`'s batch mean: forcing flushes stops Chromium coalescing across
  frames. The pass *shares* are the point; the absolute ms are not comparable across
  benches.
- **Camera matters.** `tools/bench-draw.mjs` is pinned to a mid-play camera, where only
  ~59 revealed cells land on the canvas, so a change whose cost grows with the opened
  board reads flat there; measure those with `tools/bench-pass.mjs --view worst` (1248
  revealed cells at zoom 0.40, which is also where the click hitch lives).

`tools/pixel-diff.mjs` is what makes a painter change safe: both painters render the
same pinned scene in one page, since a screenshot of two runs is not comparable — the
scene is only reproducible inside one page. It reports the purity guard, pixels above
8/255, and what each pass leaves in the 2D context, which later passes inherit.

`test/bench.mjs` measures a normal 90s Ruthless match and a *stress* board — everyone
force-fed past 600 mass, bodies at the segment cap, the worst `world.step` ever sees:

| scenario | mean step before | mean step after |
| --- | --- | --- |
| match  | 3.88 ms | **1.08 ms** (−72%) |
| stress | 12.44 ms | **2.96 ms** (−76%), p95 4.3 ms |

What bought that, in order of payoff:

- **Spatial hash, flat array.** The hash keyed buckets in a `Map` and computed
  `Math.floor(x / cell)` per item; profiling showed that indexing was ~47% of a
  stressed step. Cells are now addressed by index in a plain array, with one
  reciprocal multiply replacing each division, and `clear()` empties buckets in
  place.
- **Squared distances everywhere.** Steering, collisions, pellet pickup, and spawn
  placement all compared `d²` against a squared threshold; the old code ran
  `Math.sqrt` millions of times a second, including twice per comparison inside the
  threat sort.
- **Per-decision precomputation.** Bot steering recomputed threat vectors, pellet
  directions, and normalized hunt/flee/center vectors once *per candidate heading* —
  seventeen times over. Everything a heading needs is now computed once per decision,
  and the heading loop is pure multiply-adds.
- **Bucket-direct queries.** Hot paths iterate hash buckets through a callback
  instead of copying a search window's contents into a shared scratch array.
- **Body chain step.** `moveBody` used three divisions per link; it now uses one
  reciprocal. It is the remaining top item (~48% of a stressed step), and it is
  `sqrt`-bound by the exact-spacing constraint — that part is the algorithm, not overhead.
- **Painter allocations.** Colour strings (pellet glow, sweeper washes, per-skin rim
  and stripe shades), dash arrays, and the nameplate font were assembled per pellet,
  per snake, per frame; they are built once and reused. Headless Chrome cannot show
  the win — SwiftShader raster dominates the ~10 ms software frame — but it retires
  a few hundred string allocations per frame on real hardware, and the live-page bench
  measures step −14% game / −25% stressed with draw unregressed.
- **Sweeper marks pass.** Digging and flagging cells by hand reported a hitch that grew
  with the part of the board already open: the layer painted every cleared cell on its
  own, so a dig left behind another per-cell wash plus up to six stroke/fill calls per
  flag or mine — each of which re-resolved its paint and re-applied the arena clip —
  and that cost was paid again by every later frame. The visible cells are now walked
  once into reused lists, and the fills (washes by tint, flag sheets, mine discs, rims,
  spokes) share paths in runs. The flag's pole and base keep their own stroke: batched
  with other cells' strokes the software raster widens the antialiased edge of a thin
  line, which moved the base by ~8% of a channel. Output is otherwise pixel-for-pixel
  the old painter — max channel delta 4/255, no pixel above 8 — and the layer alone
  goes 0.059 → **0.049 ms** on the fixed scene, frame ~10.8 → ~10.1 ms.
- **Vignette bake.** The vignette is screen-space and static between resizes, but it
  was rasterised as a radial-gradient fill over the whole canvas every frame: **8.36 ms
  of a 81.7 ms worst-case frame** (2560×1440, zoom 0.40, whole board open) and 2.08 ms
  of the 14.25 ms normal one. `resize()` now bakes it once into an offscreen sheet at
  device resolution with the same transform and the same shape as the painted rect, and
  the frame pays one 1:1 `drawImage` instead: **0.48 ms and 0.12 ms**, i.e. 8.4 ms and
  2.1 ms of every frame retired. The sheets agree to max channel delta 2/255 everywhere
  — all of it from the 8-bit alpha a bitmap has to carry — with nothing above 8, at both
  dpr 1 and a forced dpr 2. It trades one more full-canvas buffer (the canvas memory
  doubles; 133 MB at a 4K HiDPI desktop), paid per resize. Fixed-scene draw 10.58 →
  **8.82 ms** in the same sitting.
- **Sweeper wash runs.** The washes are a per-op cost, not a blend cost: painting the
  same 1248 rects opaque retired 3% of their 13.1 ms, while merging each row's
  consecutive same-tint cells into one rect retired 70% of it (1248 rects → 327). An
  open board's wash went 13.1 → **3.97 ms** and the `drawSweeper` slice 18.3 → **9.9 ms**
  (29.2% → 15.7% of the flush-forced worst-case frame, p50 61.5 → 53.1 ms). Joining
  rects is coverage-exact by construction — axis-aligned `fillRect` coverage is whole
  pixels (0/1), so disjoint rects cover the same set of pixels however they are joined,
  measured at max channel delta 0 with nothing different at all, at both cameras and a
  forced dpr 2. Merging into a single path per tint keeps the last 0.8 ms but is not a
  candidate: one path cancels the shared edges of adjacent subpaths and drops coverage
  over whole regions. Note that `tools/bench-draw.mjs` reads this change as flat (8.4
  vs 8.4 ms) — its mid-play camera leaves only ~59 revealed cells on the canvas.

### Shapes that were measured and did not pay

Paint is either a per-op cost or a raster cost, and which one a layer pays is not
guessable: each candidate below was measured against the shipped shape on the pinned
scene, same sitting, and none of them beat it.

- **Board numbers as cached glyph tiles.** Offscreen tiles plus `drawImage` read
  **11.84 → ~14.4 ms** on the repo bench: a blit of a resampled bitmap costs more than
  `fillText` of a small glyph. Not retried.
- **Batching the food pass.** Fully batched is slower at both cameras, **6.39 vs 4.31 ms**
  worst and **1.22 vs 0.72 ms** normal. Its glow area is only **0.13 canvases** even at
  the widest camera, so there is no area to trade and Chromium's per-call setup is what
  the shipped 8-calls-per-pellet shape already keeps cheap.
- **The snake bodies, 46% of the worst-case frame and 71% of the normal one.** They are
  three thick dashed strokes per snake — rim at `2r + 5`, body at `2r`, the stripe at
  `2r` half a dash period over — so the question was whether the cost is per-stroke
  overhead, dash tiling, path geometry, translucent blend, or the raster. It is the
  raster, and every shape probe retired nothing at either camera:

  | shape probe (worst / normal) | retired |
  | --- | --- |
  | batch each pass across snakes, grouped by width + paint | **−6%** (28.9 vs 27.2 ms worst, 6.84 vs 6.42 ms normal) — fewer, fatter paths lose the coalescing, same verdict as the food pass |
  | dash pattern removed (solid strokes) | 1–2% (0.60 ms at worst, 0.11 at normal) |
  | stripe made opaque | 1–4% (0.35 ms at worst, 0.07 at normal) |
  | polyline points collapsed within a device pixel | 0–2% — and the workload has **zero** points closer than one device pixel, the body lattice is coarser than the raster |
  | `Path2D` built once and stroked three times | ±2%, i.e. noise |
  | marginal cost of each stroke | rim 10.1, body 9.3, stripe 9.0 ms worst — near-equal, so the cost tracks painted area |

  Painted area is what the look dictates: ~0.7 canvases of stroke on screen at the
  worst camera over ~2255 antialiased dash subpaths, and at ~40 ms per canvas that
  raster is where the time goes. The one retirable item is the rim's interior, which
  the body stroke paints over again (~33% of the slice), and it cannot be skipped here:
  the context is created with `{ alpha: false }`, so a composite-behind op like
  `destination-over` is a no-op against pixels that are already opaque. Clipping the
  polylines to the window is not a lever either — 60% of the walked centreline is
  offscreen at the normal camera yet costs nothing, because Skia discards offscreen
  raster before it costs anything.

  The look-coupled route is the veil: `LOOK.veilAlpha` at 0 turns the
  `drawSweeperOverlay` pass off, retiring ~10% of the worst frame, and covered marks
  then read only through the body's stripe windows — a look change, and
  not one this pass has taken.

  Cost per look, one sitting of `tools/bench-pass.mjs --look` (median frame at each
  camera; the snakes column is that slice's mean at the worst camera):

  | look | worst frame | normal frame | snakes, worst |
  | --- | --- | --- | --- |
  | shipped (`rimGrow 5`, `glass` on, `veilAlpha 0.1`) | 50.1 ms | 8.80 ms | 28.3 ms |
  | `rimGrow=0` — no halo stroke on anything | 41.3 ms | 6.80 ms | 19.2 ms |
  | `rimPlayerOnly=true` — halo on your snake only | 41.4 ms | 6.90 ms | 19.1 ms |
  | `glass=false` — one solid tube, halo still on | 42.7 ms | — | 20.5 ms |
  | `glassPlayerOnly=true` — bots solid, you keep the glass | 43.6 ms | 7.00 ms | 20.2 ms |
  | `veilAlpha=0` — no mark veil anywhere | 44.8 ms | — | 28.8 ms |
  | `veilPlayerOnly=true` — veil under your body only | 46.1 ms | 8.90 ms | 27.7 ms |
  | all three, everywhere (`rimGrow=0,glass=false,veilAlpha=0`) | 27.1 ms | 4.30 ms | 10.4 ms |
  | all three, player-only | 28.0 ms | 4.90 ms | 11.0 ms |

  Read as shares: the halo is a third of the snake slice, the stripe windows a
  further 27% of it, and the veil is 5.8 ms — 8% of a worst frame but 0.1 ms (1%)
  of a mid-play one. Each knob retires its shape whole: `rimGrow=0` takes 9.1 ms of
  the 28.3 ms slice, `glass=false` takes 7.8, `veilAlpha=0` takes all 5.8 of the
  overlay pass.

  The player-only question — can the shape changes be limited to the bots? —
  measures as nearly free, because 43 of the 44 snakes on a worst-case screen are
  bots. Retiring a shape on the bots only, and keeping your own snake exactly as
  shipped:

  | shape | retired everywhere | retired on bots only | share kept |
  | --- | --- | --- | --- |
  | halo | 9.1 ms | 9.2 ms | ~97%, the gap is measurement noise |
  | stripe windows | 7.8 ms | 8.1 ms | ~97% |
  | mark veil | 5.8 ms | 5.2 ms | 89% |
  | all three | 17.9 ms of slice + 5.8 ms of veil | 17.3 ms + 5.2 ms | 97% / 89% |

  At the normal camera the halo retires 2.17 ms everywhere and 1.90 player-only
  (88%), and the all-three combo 4.36 and 3.85 (88%) — but the veil retires 0.067 ms
  either way, so player-only or not is immaterial mid-play. The bench pins the
  **fattest** snake as the player when a player-only knob is in play, the
  pessimistic case for a real run: your own body is usually the longest thing on the
  screen, so yours is the one tube still paying the strokes you kept. `veilPlayerOnly`
  stamps the cells your body touches — 43 of the 2025 in that scene, printed by
  `bench-pass` — from the post-step body points with 6 world px of slack, so the
  veil edge sits on cell boundaries around the tube rather than hugging it, and the
  walk is a few thousand array writes against the 5.2 ms of paint it retires.

  The appearance half of the same trade, from `pixel-diff` with the look applied to
  one renderer and the code identical on both sides:

  | look | worst camera | normal camera |
  | --- | --- | --- |
  | `rimPlayerOnly=true` | 3.9% of pixels move, 2.4% by more than 8/255 | 4.7%, 3.1% |
  | `veilPlayerOnly=true` | 2.8% move, 0.35% by more than 8 (max delta 26) | 0.9%, 0.2% |
  | all three, player-only | 15.2% move, 12.5% by more than 8 | 20.2%, 18.9% |

  So the veil is the saving you cannot see past alpha 26/255 — marks under bot
  bodies stop ghosting — the halo is a visible thinning of every bot outline, and
  the solid-bot tube is the loud one.

### The shape lab

Whether any of those looks is acceptable is a judgement about the picture, not a
number, so the game page carries a dev panel for dialling it in: press **K** in a run
to show it (K again hides it). One slider per `LOOK` knob — the ten that shade or
shape the snakes first (`stripeAlpha`, `bandMul`, `rimAlpha`, `rimGrow`,
`rimPlayerOnly`, `glass`, `glassPlayerOnly`, `veilAlpha`, `veilPlayerOnly`,
`headDisc`), then the board's four — with the value shown beside each, a live
**`draw ms/frame`** readout so the cost of the look follows the appearance, and an
**Export look** button that writes the `LOOK` table back as typed (a `// was` comment
marks what moved) for pasting, plus a URL that replays the same look in the page.
The three `*PlayerOnly` knobs apply a shape change to the bots only, which keeps your
own snake exactly as shipped. `tools/pixel-diff.mjs` takes the same `--look` string
and applies it to its B renderer, so `node tools/pixel-diff.mjs . . --view worst --look
rimPlayerOnly=true,glassPlayerOnly=true,veilPlayerOnly=true` counts how many pixels a
dialled look moves with the code unchanged — the appearance half of the trade, next
to the cost table above.
`LOOK` starts at the shipped values, and the knobbed pass at those defaults is
pixel-identical to the previous painter — `pixel-diff` reads max channel delta 0 — so
the lab changes nothing until a slider moves. The panel is dev-only: the shape knobs,
`buildTune`/`toggleTune`, the `k` keydown line, the `tuneOn` lines in the frame loop
and the `.tune` CSS block are what to delete when the dialled look is shipped, as
`git log` shows was done once before (`4b6117c`).

### Frame pacing

Fast frames are useless if the motion they show stutters. The simulation ticks at a
fixed 1/60 s, so on a 120/144/165Hz screen the old loop drew the same world state for
over half the frames — `tools/bench-pacing.mjs` (which swaps in a synthetic rAF clock,
since headless Chrome pins rAF to its own scheduler) measured **58% of rendered frames
stalled at 144Hz and 64% at 165Hz**.

The fix is standard render interpolation: every body point keeps the position it had
at the start of the last step (`px`/`py`), and the painter draws each snake between
that history and the current state at `lerp = acc / STEP` — the leftover fraction of
the accumulator. The camera tracks the interpolated head, so screen motion matches
what is drawn. Stalled frames are now **0%** at every emulated refresh rate. At a true
60Hz display the accumulator drains fully each frame, so `lerp ≈ 0` and the painter
draws the exact physics state; with frame-time jitter it slides smoothly between the
last two steps instead of popping. The accumulator's overflow after the 4-step-per-
frame cap is clamped to one step instead of discarded, so the world clock no longer
silently drifts behind wall time after a load spike. The cost is two stores
per point per step and one lerp per point per drawn frame — the step benchmark shows
no regression, and draw picks up ~0.04 ms, invisible against raster.

## How it works

**Bodies** are a chain of points. The head moves, then every point behind it is pulled
to an exact spacing from the one in front, which is what makes the snake bend smoothly.
Mass decides how many points exist (`12 + 0.9 × mass`, capped at 900), how fat the tube
is, how fast it goes, and how sharply it can turn — so a fat snake is slow to steer.

**Rendering** draws each snake as three strokes of one path: a dark outline, the body
colour, then the second colour through a dash pattern, which gives the ringed Slither.io
skin. Bands use butt caps: round caps stretch every dash by half the tube width and
fuse the rings into a solid line. Everything is culled to the camera.

**Collisions** use a spatial hash rebuilt every frame from every other body point, and a
second hash for food. A head dies when it lands within `body radius + 0.55 × own radius`
of a foreign point; hitting point zero of a snake (its head) kills both.

**Bots** do not follow a script. Each steering decision scores 17 candidate headings:
penalty for any enemy body segment projected along that heading, reward for pellets in
that direction, reward for intercepting a smaller snake (aimed where it is *going*),
reward for running away from a bigger one, a strong pull toward the middle near the
ring, and a preference for small corrections so movement looks alive. They think 15-20
times per second and boost to close a gap, to escape, or to reach a rich patch.

Difficulty (`Chill / Classic / Ruthless`) changes bot count, how far they see, how
sharply they turn, how eager they are to boost, and how big they spawn.

## Music — *Neon Drift*

A 3:14 synthwave track, written and synthesized from scratch by `tools/make_track.py`:
no samples, no soundfont, no external instruments — additive band-limited oscillators,
butterworth filters, ADSR, sidechain pumping, chorus, a dotted delay on the lead and a
five-tap comb reverb, arranged as intro → main → hook → break → climax → outro.

```
92 BPM · A minor · i–VI–III–VII (Am – F – C – G)
drums: synthesized kick, snare, hats, clap, crash, tambourine — low saturation drive,
       top end kept under ~13 kHz (hard-saturated noise transients are what a lossy
       codec turns into audible clipping, and they are the loudest thing in the mix)
bass: 16th-note octave-jumping saw with a sub octave
pad:  detuned saws, chorus, slow filter, pumped on the kick
lead: pick-in saw with vibrato and delay; the hook melody, an octave up in the climax
master: mid/side width, section level matching, RMS glue, 8 ms lookahead limiter,
        true-peak normalization at -5.2 dBTP for lossy-encode headroom
```

The master chain has no saturation on the bus. It used to be a `tanh` on the summed mix,
which is a distortion unit: the loud sections drove it hardest, so the section that
*should* be the biggest was the one that sounded clipped (measured on the old render:
crest factor 3.55 in the main section collapsing to 2.41 in the climax — the transients
being shaved off). It is now gain control that adds no harmonics: a stereo-linked
lookahead limiter whose ceiling sits 1.4 dB above the target, and a final normalization
measured on the **true** peak (4× oversampled), because the inter-sample maxima are what
clips in a DAC and the lossy encoders add a few dB of transient overshoot on top.

Regenerate it (numpy + scipy, and ffmpeg for the encodes):

```
python3 tools/test_master.py           # ~1s, checks the limiter/glue/balance blocks
python3 tools/make_track.py            # ~2 min, writes audio/neon-drift.{ogg,mp3}
python3 tools/analyze_track.py         # checks what it produced
```

`test_master.py` checks each master block against the property it needs — the lookahead
window must see a peak *before* it arrives, gain must fall fast and rise slowly, filters
must warm-start (one that starts from zero mutes the intro), the limiter must hold its
ceiling, section trims must only ever cut. All of those were found by testing, not by
reading.

`analyze_track.py` decodes the finished file and measures the things that are easy to get
wrong: the beat grid (92.3 BPM detected against the 92.0 written), every bar's bass
fundamental against the chord plan (16/16 bars in tune), band energy per section,
dropouts, flat-topped runs, true peak after lossy encoding, and the per-section crest
factor — the objective signature of saturation, loudness rising while transient headroom
collapses. Current: PASS, true peak 0.605 (-4.4 dBTP), crest 3.54 main vs 3.23 climax,
zero flat-topped runs.

In game, the track fades in over 2s when you start, ducks to 35% while the death card is
up and comes back on respawn. The Music toggle is remembered between visits. It plays
through a plain audio element on purpose: WebAudio cannot read local files on a `file://`
page, so a graph-based player would break the "open index.html" workflow. The music is
generated here, so it is yours to use — nothing to license.

## Tuning

Everything lives in `CFG` at the top of `js/core.js` — world radius, food density, body
spacing, speed, boost drain, bot scan ranges. `DIFFICULTY` holds the three presets.
Camera zoom, colours and skins are in `js/render.js` and `js/core.js`.
