# Slither Local

A local, offline clone of Slither.io. No server, no build step, no dependencies — the
bots play the game exactly the way people do: they hunt pellets, dodge bodies, chase
smaller snakes, cut things off, and die to the ring.

Open `index.html` in a browser and you are playing.

## Published

**https://endirdev.github.io/slither/** — GitHub Pages, served from the root of `main`.
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
slither-local/
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
  test/smoke.mjs    headless simulation + rule tests
```

## Play

| Input | Action |
| --- | --- |
| Mouse | steer toward the cursor |
| Space **or** Shift | boost (burns your own length, drops it as food behind you) |
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

## How it works

**Bodies** are a chain of points. The head moves, then every point behind it is pulled
to an exact spacing from the one in front, which is what makes the snake bend smoothly.
Mass decides how many points exist (`12 + 0.9 × mass`, capped at 900), how fat the tube
is, how fast it goes, and how sharply it can turn — so a fat snake is slow to steer.

**Rendering** draws each snake as three strokes of one path: a dark outline, the body
colour, then the second colour through a dash pattern, which gives the ringed Slither
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
