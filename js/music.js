/* Slither Local — background music.
 * Plain HTMLAudioElement on purpose: file:// pages can play local media, but they
 * cannot fetch it into WebAudio, so the graph-based route would break "just open
 * index.html". Volume ramps are done in JS.
 */
(function (global) {
  'use strict';

  var FILES = ['audio/neon-drift.ogg', 'audio/neon-drift.mp3'];
  // The file is mastered with 4.4 dB of true-peak headroom (see tools/make_track.py), so
  // this number is higher than the peak amplitude suggests: 0.70 * 0.605 peaks at 0.42,
  // which leaves the gameplay sounds sitting on top of the music instead of fighting it.
  var LEVEL = 0.70;                       // music sits under the gameplay sounds
  var DUCK = 0.35;                        // ...and drops out of the way when you die

  var el = null;
  var fileIndex = 0;
  var enabled = true;
  var ducked = false;
  var want = 0;
  var ramp = 0;
  var pending = false;
  var from = 0;
  var t0 = 0;
  var dur = 2000;

  function goal() {
    return enabled ? LEVEL * (ducked ? DUCK : 1) : 0;
  }

  function setGoal() {
    var g = goal();
    if (g === ramp) return;
    from = ramp;
    t0 = performance.now();
    // fade in slowly from silence, duck fast, fade out in between
    dur = g === 0 ? 900 : (from <= 0.001 ? 2000 : 500);
  }

  function step() {
    if (!el) return;
    var g = goal();
    if (g !== want) { want = g; setGoal(); }
    var p = dur > 0 ? Math.min(1, (performance.now() - t0) / dur) : 1;
    ramp = from + (want - from) * p;
    el.volume = Math.max(0, Math.min(1, ramp));
  }

  function build(src) {
    var a = new Audio();
    a.src = src;
    a.loop = true;
    a.preload = 'auto';
    a.volume = 0;
    a.addEventListener('error', function () {
      fileIndex++;
      if (fileIndex < FILES.length) {
        el = build(FILES[fileIndex]);
        if (pending) start();
      }
    });
    return a;
  }

  function start() {
    if (!el) el = build(FILES[fileIndex]);
    pending = true;
    if (el.readyState < 2) el.load();      // only fetch when there is nothing buffered:
    var p = el.play();                     // load() would restart the song from bar 1
    if (p && p.catch) {
      p.catch(function () {
        // autoplay policy: resume on the first real gesture
        global.addEventListener('pointerdown', resumeOnce, { once: true });
        global.addEventListener('keydown', resumeOnce, { once: true });
      });
    }
    if (!window.__slitherMusicRamp) {
      window.__slitherMusicRamp = global.setInterval(step, 60);
    }
  }

  function resumeOnce() {
    if (el && el.paused) el.play().catch(function () {});
  }

  function duck(on) {
    ducked = !!on;
  }

  function setEnabled(on) {
    enabled = !!on;
    try {
      global.localStorage.setItem('slither.music', enabled ? 'on' : 'off');
    } catch (e) { /* private mode: the toggle still works for this session */ }
  }

  function isEnabled() { return enabled; }

  function loadPreference() {
    try {
      enabled = global.localStorage.getItem('slither.music') !== 'off';
    } catch (e) { enabled = true; }
  }

  global.SlitherMusic = {
    start: start,
    duck: duck,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    loadPreference: loadPreference,
    // test/QA view of the real element state
    probe: function () {
      return el ? {
        volume: +el.volume.toFixed(3), paused: el.paused, time: +el.currentTime.toFixed(2),
        ready: el.readyState, src: el.src.split('/').pop(), ramp: +ramp.toFixed(3),
        ducked: ducked, enabled: enabled
      } : null;
    },
    title: 'Neon Drift',
    by: 'Slither Local (synthesized in tools/make_track.py)'
  };
})(typeof window !== 'undefined' ? window : globalThis);
