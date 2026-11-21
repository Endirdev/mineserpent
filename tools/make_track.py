#!/usr/bin/env python3
"""Neon Drift — a synthwave track for Mineserpent, synthesized from scratch.

No samples, no instruments: oscillators, filters, envelopes, sidechain, delay and a
comb reverb, arranged into a real song structure (intro / main / hook / break / climax
/ outro) and written to audio/neon-drift.wav, then encoded to .ogg and .mp3.

    python3 tools/make_track.py            # writes audio/neon-drift.{wav,ogg,mp3}
    python3 tools/make_track.py --no-lead --out neon-drift-leadless
        # strips the horn-like lead voice (the hook melody) and writes a variant
    python3 tools/make_track.py --no-lead --drums 0.8 --hats 0.62 --out neon-drift-leadless
        # also pulls the kit (kick/snare/clap/crash) ~2 dB and the hats/tamb ~4 dB
    python3 tools/make_track.py --no-lead --soft-kit --drums 0.8 --hats 0.62 --out neon-drift-leadless
        # plus the electronic kit: 808-style kick, tonal snap, ticked hats, swish crash

--no-lead drops the melody's brass-sounding voice; the master is then re-normalized
*up* to TP_TARGET as well (not just capped down), so the variant plays at the same
level as the original through the fixed in-game LEVEL.

Needs numpy + scipy, and ffmpeg for the lossy encodes.
"""

import os
import subprocess
import sys

import numpy as np
from scipy import ndimage, signal
from scipy.io import wavfile

SR = 44100
BPM = 92.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
SIX = BEAT / 4.0
RNG = np.random.default_rng(20260118)

# True-peak ceiling for the finished master, as a linear amplitude. -5.2 dBTP: the lossy
# encoders add a few dB of transient overshoot when they reconstruct the drums, so a
# master that peaks right at full scale decodes as clipping.
TP_TARGET = 0.55
# The limiter works 1.4 dB above that. It clamps only the top of the waveform and the
# master is then scaled down to TP_TARGET, so the transients keep their shape instead of
# being flattened against the ceiling - a limiter set at the target is what turns "louder"
# into "distorted".
LIMIT_CEIL = 0.62

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUDIO = os.path.join(ROOT, 'audio')

# CLI: --no-lead strips the horn-like lead voice; --out NAME writes NAME.{wav,ogg,mp3}
def _num_flag(name, default):
    a = sys.argv[1:]
    return float(a[a.index(name) + 1]) if name in a else default
DRUM_MUL = _num_flag('--drums', 1.0)   # scales kick/snare/clap/crash
HAT_MUL = _num_flag('--hats', 1.0)     # scales hi-hats and tambourine
# --soft-kit rebuilds the kit as an electronic sample (round 808-style kick without
# the cymbal click, tighter tonal snap, ticked hats, darker crash): the acoustic kit
# reads as harsh and "on top"; the soft kit sits back into the track's bed.
SOFT_KIT = '--soft-kit' in sys.argv[1:]
DROP_LEAD = '--no-lead' in sys.argv[1:]
OUT = 'neon-drift'
if '--out' in sys.argv[1:]:
    OUT = sys.argv[sys.argv.index('--out') + 1]

# ------------------------------------------------------------------ tuning
SECTIONS = [('intro', 8), ('main', 16), ('hook', 16), ('break', 8), ('climax', 16), ('outro', 8)]
TOTAL_BARS = sum(b for _, b in SECTIONS)
TAIL = 6.0                                     # seconds of reverb tail after the last bar
DUR = TOTAL_BARS * BAR + TAIL
N = int(DUR * SR)


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# A minor: i - VI - III - VII
CHORDS = [
    dict(root=45, notes=[57, 60, 64], name='Am'),   # A  C  E
    dict(root=41, notes=[53, 57, 60], name='F'),    # F  A  C
    dict(root=48, notes=[60, 64, 67], name='C'),    # C  E  G
    dict(root=43, notes=[55, 59, 62], name='G'),    # G  B  D
]

# ------------------------------------------------------------------ buffer
class Stem:
    def __init__(self):
        self.L = np.zeros(N)
        self.R = np.zeros(N)

    def add(self, t0, sig, gain=1.0, pan=0.0):
        """Place sig at t0 seconds. pan -1 = hard left, +1 = hard right."""
        i0 = int(round(t0 * SR))
        if i0 < 0:
            sig = sig[-i0:]
            i0 = 0
        i1 = min(N, i0 + len(sig))
        if i1 <= i0:
            return
        s = sig[:i1 - i0] * gain
        theta = (pan + 1) * np.pi / 4          # equal-power pan law
        self.L[i0:i1] += s * np.cos(theta)
        self.R[i0:i1] += s * np.sin(theta)

    def mono(self):
        return 0.5 * (self.L + self.R)


stems = {k: Stem() for k in ('drums', 'bass', 'pad', 'arp', 'lead', 'fx')}

# ------------------------------------------------------------------ tools
_fcache = {}


def _sos(kind, fc, order):
    key = (kind, round(fc), order)
    if key not in _fcache:
        _fcache[key] = signal.butter(order, min(fc, SR * 0.49) / (SR / 2), kind, output='sos')
    return _fcache[key]


def lp(x, fc, order=2):
    return signal.sosfilt(_sos('low', fc, order), x)


def hp(x, fc, order=2):
    return signal.sosfilt(_sos('high', fc, order), x)


def bp(x, f0, f1, order=2):
    sos = signal.butter(order, [f0 / (SR / 2), f1 / (SR / 2)], 'band', output='sos')
    return signal.sosfilt(sos, x)


def sat(x, drive=2.0):
    return np.tanh(x * drive) / np.tanh(drive)


def osc(freq, n, harmonics=12, odd=False, vib=0.0, vib_hz=5.0, vib_delay=0.18):
    """Additive band-limited oscillator. `freq` is a per-sample instantaneous frequency."""
    t = np.arange(n) / SR
    f = np.asarray(freq, dtype=float) * np.ones(n) if np.isscalar(freq) else np.asarray(freq, dtype=float)
    if vib:
        depth = vib * np.clip((t - vib_delay) / 0.35, 0, 1)
        f = f * (1 + depth * np.sin(2 * np.pi * vib_hz * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    out = np.zeros(n)
    f0 = max(float(np.mean(f)), 20.0)
    nh = int(min(harmonics, (SR / 2 - 400) // f0))
    if nh < 1:
        return out
    ks = range(1, nh + 1) if not odd else range(1, nh + 1, 2)
    norm = 0.0
    for k in ks:
        out += np.sin(k * ph) / k
        norm += 1.0 / k
    return out / norm


def amp_env(n, attack, decay, sustain, release, curve=0.35):
    """ADSR over n samples. sustain = level after decay; release = seconds."""
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    r = max(1, int(release * SR))
    env = np.zeros(n)
    a = min(a, n)
    env[:a] = np.linspace(0, 1, a) ** curve
    d = min(d, max(0, n - a))
    if d:
        env[a:a + d] = np.linspace(1, sustain, d) ** curve
    tail = n - a - d
    if tail > 0:
        env[a + d:n] = sustain
    r = min(r, max(0, n - a - d))
    if r:
        env[n - r:] = sustain * np.linspace(1, 0, r) ** curve
    return env


def notes_at(bar, n_bars=1):
    return CHORDS[bar % 4]


def bar_of(slot):
    """(bar, slot) pairs for a global 16th grid."""
    return slot // 16, slot % 16


# ------------------------------------------------------------------ voices
def play_bass(t0, midi, dur, gain=1.0, cut=520, drive=1.35):
    n = int(dur * SR) + 40
    f = midi_hz(midi)
    x = osc(f, n, 10)
    x += 0.28 * osc(f / 2, n, 4)                       # sub octave
    x = lp(x, cut)
    x = x * amp_env(n, 0.004, 0.05, 0.72, 0.03, curve=0.8)
    stems['bass'].add(t0, sat(x, drive), 0.55 * gain, 0.0)


def play_arp(t0, midi, dur, gain=1.0, pan=0.0, cut=2600):
    n = int(dur * SR) + 30
    f = midi_hz(midi)
    x = osc(f, n, 14, vib=0.0)
    x += 0.35 * osc(f * 1.005, n, 8)
    x = lp(x, cut)
    x = x * amp_env(n, 0.002, 0.06, 0.55, 0.05, curve=1.2)
    stems['arp'].add(t0, x, 0.40 * gain, pan)


def play_pad(t0, chord, dur, gain=1.0, cut=850, detune=0.16):
    n = int(dur * SR) + int(1.1 * SR)
    for i, note in enumerate(chord['notes']):
        for det in (-detune, +detune):
            f = midi_hz(note + det)
            x = osc(f, n, 9, vib=0.006, vib_hz=0.28, vib_delay=0.0)
            x = lp(x, cut)
            env = amp_env(n, 0.42, 0.5, 0.85, 1.05, curve=0.7)
            pan = -0.55 + 0.5 * i + (0.25 if det > 0 else -0.25)
            stems['pad'].add(t0, x * env, 0.20 * gain, pan)
    # octave-down body, centred
    f = midi_hz(chord['root'] - 12)
    x = lp(osc(f, n, 6), cut * 0.7) * amp_env(n, 0.5, 0.6, 0.8, 1.1, curve=0.8)
    stems['pad'].add(t0, x, 0.26 * gain, 0.0)


def play_lead(t0, midi, dur, gain=1.0, cut=3400, vib=0.013, sub=True):
    n = int(dur * SR) + int(0.35 * SR)
    f = midi_hz(midi)
    glide = int(0.035 * SR)
    fs = np.full(n, f)
    fs[:glide] = np.linspace(f * 0.94, f, glide)      # pick-in from below
    x = osc(fs, n, 18, vib=vib, vib_hz=5.4)
    if sub:
        x += 0.4 * osc(fs / 2, n, 5)
    x = lp(x, cut)
    x = x * amp_env(n, 0.012, 0.10, 0.8, 0.30, curve=0.6)
    stems['lead'].add(t0, sat(x, 1.15), 0.42 * gain, 0.0)


# ------------------------------------------------------------------ drums
# Every drum below keeps its saturation drive low and its top end under ~14 kHz.
# Hard-saturated noise transients are the loudest thing in the mix and the hardest
# thing for a lossy codec: that combination is what reads as "clipping" when the
# arrangement gets dense.
def play_kick(t0, gain=1.0):
    n = int(0.55 * SR) if SOFT_KIT else int(0.5 * SR)
    t = np.arange(n) / SR
    if SOFT_KIT:
        # 808-style: round glide, octave layer underneath, no cymbal click on top
        f = 106 * np.exp(-t / 0.060) + 43
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.23)
        body += 0.42 * np.sin(np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.20)
        x = sat(1.5 * body, 1.4)
    else:
        f = 118 * np.exp(-t / 0.048) + 41
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.17)
        click = lp(hp(RNG.standard_normal(n), 900), 9000) * np.exp(-t / 0.005)
        x = sat(1.55 * body + 0.45 * click, 1.5)
    stems['drums'].add(t0, x, 0.90 * DRUM_MUL * gain, 0.0)


def play_snare(t0, gain=1.0):
    n = int(0.38 * SR)
    t = np.arange(n) / SR
    if SOFT_KIT:
        # tonal snap: tight and dark, more body than noise, nothing above 2.4k
        noise = bp(RNG.standard_normal(n), 620, 3600) * np.exp(-t / 0.075)
        body = np.sin(2 * np.pi * 168 * t) * np.exp(-t / 0.06)
        tone = bp(RNG.standard_normal(n), 1000, 2400) * np.exp(-t / 0.028)
        x = sat(noise * 0.9 + body * 0.85 + tone * 0.45, 1.3)
    else:
        noise = bp(RNG.standard_normal(n), 380, 7600) * np.exp(-t / 0.12)
        body = np.sin(2 * np.pi * 186 * t) * np.exp(-t / 0.10)
        tone = bp(RNG.standard_normal(n), 1100, 3200) * np.exp(-t / 0.045)
        air = bp(RNG.standard_normal(n), 6500, 12500) * np.exp(-t / 0.055)
        x = sat(noise * 1.0 + body * 0.8 + tone * 0.55 + air * 0.40, 1.45)
    stems['drums'].add(t0, x, 0.70 * DRUM_MUL * gain, 0.0)


def play_hat(t0, gain=1.0, open_=False, pan=0.22):
    d = 0.34 if open_ else 0.085
    n = int(d * SR)
    t = np.arange(n) / SR
    if SOFT_KIT:
        # tick, not cymbal: shorter, narrower, above the sizzle band
        decay = 0.11 if open_ else 0.020
        x = bp(RNG.standard_normal(n), 5800, 11200) * np.exp(-t / decay)
        x += 0.22 * bp(RNG.standard_normal(n), 6500, 10000) * np.exp(-t / (decay * 1.6))
    else:
        decay = 0.15 if open_ else 0.028
        x = bp(RNG.standard_normal(n), 4200, 12500) * np.exp(-t / decay)
        x += 0.35 * bp(RNG.standard_normal(n), 5200, 11500) * np.exp(-t / (decay * 1.6))
    stems['drums'].add(t0, x, (0.34 if open_ else 0.26) * HAT_MUL * gain, pan)


def play_clap(t0, gain=1.0):
    n = int(0.42 * SR)
    x = np.zeros(n)
    hi = 6800 if not SOFT_KIT else 4200
    for k, off in enumerate((0.0, 0.012, 0.024, 0.038)):
        i = int(off * SR)
        stack = (0.05 + 0.012 * k) if not SOFT_KIT else (0.04 + 0.009 * k)
        seg = bp(RNG.standard_normal(n - i), 900, hi) * np.exp(-np.arange(n - i) / SR / stack)
        x[i:] += seg * (1.0 - 0.13 * k)
    stems['drums'].add(t0, sat(x, 1.35), 0.36 * DRUM_MUL * gain, -0.12)


def play_tamb(t0, gain=1.0):
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    lo, hi = (5000, 9500) if SOFT_KIT else (6000, 12500)
    x = bp(RNG.standard_normal(n), lo, hi) * np.exp(-t / 0.05)
    stems['drums'].add(t0, x, 0.15 * HAT_MUL * gain, -0.45)


def play_crash(t0, gain=1.0):
    if SOFT_KIT:
        # swish, not cymbal: darker, shorter, no low rumble layer
        n = int(1.3 * SR)
        t = np.arange(n) / SR
        x = bp(RNG.standard_normal(n), 1400, 9000) * np.exp(-t / 0.45)
        x += 0.22 * bp(RNG.standard_normal(n), 2200, 8000) * np.exp(-t / 0.8)
    else:
        n = int(1.9 * SR)
        t = np.arange(n) / SR
        x = bp(RNG.standard_normal(n), 1800, 13000) * np.exp(-t / 0.55)
        x += 0.30 * bp(RNG.standard_normal(n), 6500, 13000) * np.exp(-t / 1.1)
        x += 0.4 * bp(RNG.standard_normal(n), 300, 2000) * np.exp(-t / 0.9)
    stems['drums'].add(t0, x, 0.34 * DRUM_MUL * gain, 0.25)


def sweep_bp(x, f_from, f_to, bands=9, q=2.2):
    """Bandpass whose cutoff rises across the clip: crossfaded static bands (butter
    takes a fixed cutoff, so a real sweep is built by blending)."""
    n = len(x)
    out = np.zeros(n)
    centers = np.geomspace(f_from, f_to, bands)
    pos = np.arange(n) / n
    total = np.zeros(n)
    for i, fc in enumerate(centers):
        c = i / (bands - 1)
        w = np.clip(1 - np.abs(pos - c) * (bands - 1) * 1.15, 0, 1)
        y = bp(x, max(60, fc / q), min(SR * 0.48, fc * q))
        out += w * y
        total += w
    total[total < 1e-6] = 1
    return out / total


def play_riser(t0, dur, gain=1.0):
    """Noise + tone sweep that lifts into a section."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    prog = t / dur
    noise = sweep_bp(prog ** 2 * RNG.standard_normal(n), 260, 9000)
    f = midi_hz(69) * (1 + 1.0 * prog ** 2)
    tone = osc(f, n, 6) * prog ** 1.5
    x = lp(noise * 0.8 + tone * 0.35, 9000)
    stems['fx'].add(t0, x * np.linspace(0.15, 1, n), 0.30 * gain, 0.15)


def play_impact(t0, gain=1.0):
    n = int(1.8 * SR)
    t = np.arange(n) / SR
    f = 72 * np.exp(-t / 0.12) + 32
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.35)
    air = bp(RNG.standard_normal(n), 60, 2600) * np.exp(-t / 0.18)
    # Low drive: this is a saturated boom on top of a kick on the same beat, and a
    # hard-clipped low sine is exactly the kind of low-end distortion you hear as clipping
    x = sat(boom * 1.35 + air * 0.75, 1.5)
    stems['fx'].add(t0, x, 0.42 * gain, 0.0)


def play_sub_drop(t0, gain=1.0):
    n = int(2.4 * SR)
    t = np.arange(n) / SR
    f = midi_hz(31) * (1 + 0.9 * (1 - t / 2.4))
    x = osc(f, n, 4) * np.exp(-t / 1.1)
    stems['fx'].add(t0, lp(x, 220), 0.5 * gain, 0.0)

# ------------------------------------------------------------------ arrange
MELody_HOOK = [
    # (bar offset in phrase, 16th slot, midi, length in 16ths)
    (0, 0, 69, 2), (0, 2, 72, 2), (0, 4, 76, 6), (0, 12, 74, 2), (0, 14, 72, 2),
    (1, 0, 72, 4), (1, 4, 69, 2), (1, 6, 65, 6),
    (2, 0, 67, 4), (2, 4, 64, 2), (2, 6, 67, 2), (2, 8, 72, 6),
    (3, 0, 71, 4), (3, 6, 74, 4), (3, 12, 69, 4),
]
MELody_HOOK_B = [
    (4, 0, 81, 2), (4, 2, 76, 2), (4, 4, 72, 8), (4, 14, 74, 2),
    (5, 0, 77, 4), (5, 4, 72, 2), (5, 6, 69, 6),
    (6, 0, 76, 4), (6, 6, 79, 2), (6, 8, 72, 6),
    (7, 0, 71, 4), (7, 6, 74, 2), (7, 8, 79, 4), (7, 12, 76, 4),
]

BASS_MAIN = [0, 0, 12, 0, 0, 0, 12, 0, 0, 12, 0, 12, 0, 0, 12, 12]     # semitone offsets
BASS_DRIVE = [0, 0, 12, 12, 0, 0, 12, 0, 0, 12, 12, 0, 0, 0, 12, 12]


def bass_bar(bar, pattern, gain=1.0, cut=520):
    ch = CHORDS[bar % 4]
    for s, off in enumerate(pattern):
        play_bass(bar * BAR + s * SIX, ch['root'] - 12 + off, SIX * 0.92, gain, cut)


def arp_bar(bar, gain=1.0, slots=16, cut=2600, span=2):
    ch = CHORDS[bar % 4]
    seq = ch['notes'] + [n + 12 for n in ch['notes']]
    step = 16 // slots
    for i in range(0, 16, step):
        note = seq[i % len(seq)] + (12 if (i // len(seq)) % span else 0)
        play_arp(bar * BAR + i * SIX, note, SIX * 1.5, gain, pan=-0.35 + 0.7 * ((i // 4) % 2), cut=cut)


def melody(bar0, bars, phrase, gain=1.0, shift=0, cut=3400):
    if DROP_LEAD:      # variant: the horn-like voice stays out of every section
        return
    for off, slot, note, length in phrase:
        if off >= bars:
            continue
        play_lead((bar0 + off) * BAR + slot * SIX, note + shift, length * SIX * 1.02, gain, cut)


def drums(bar, section):
    t = bar * BAR
    six = lambda s: t + s * SIX
    if section in ('main', 'hook', 'climax'):
        kicks = {0: 1.0, 8: 1.0}
        if section in ('hook', 'climax'):
            kicks[6] = 0.85
        if section == 'climax':
            kicks[14] = 0.8
        if bar % 4 == 2:
            kicks[11] = 0.7
        for s, g in kicks.items():
            play_kick(six(s), g)
        play_snare(six(4))
        play_snare(six(12))
        if section in ('hook', 'climax'):
            play_clap(six(12), 0.9)
        hat_slots = range(0, 16, 2)
        for s in hat_slots:
            play_hat(six(s), 0.85 if s % 4 == 0 else 0.6)
        if section == 'climax':
            # 16th-note hats plus tambourine was the densest, brightest thing in the
            # track: it pushed the master hardest in exactly the section that sounded worst
            for s in (2, 10):
                play_tamb(six(s))
            play_hat(six(7), 0.45)
        if s_last_open(bar):
            play_hat(six(14), 0.9, open_=True)
    elif section == 'intro' and bar >= 6:
        # hi-hat build in the last two intro bars
        for s in range(0, 16, 2):
            play_hat(six(s), 0.25 + 0.55 * (bar - 6 + s / 16) / 2)


def s_last_open(bar):
    return bar % 2 == 1


def pad_bar(bar, gain=1.0, cut=850):
    play_pad(bar * BAR, CHORDS[bar % 4], BAR, gain, cut)


def arrange():
    bar = 0
    section_bars = {}
    for name, bars in SECTIONS:
        section_bars[name] = (bar, bars)
        bar += bars

    for name, (b0, bars) in section_bars.items():
        for k in range(bars):
            b = b0 + k
            pad_bar(b, gain=0.85 if name in ('break', 'outro') else 1.0,
                    cut=700 if name in ('break', 'outro') else 880)

            if name == 'intro':
                arp_bar(b, gain=0.35 + 0.35 * k / bars, slots=8 if k < 4 else 16,
                        cut=1400 + 900 * k / bars, span=1)
                if k >= 4:
                    bass_bar(b, BASS_MAIN, gain=0.35 + 0.3 * (k - 4) / 4, cut=380)

            elif name == 'main':
                bass_bar(b, BASS_MAIN, gain=1.0)
                arp_bar(b, gain=0.95, slots=16, cut=2800, span=2)
                drums(b, 'main')
                if k >= 8:
                    melody(b0, bars, MELody_HOOK, gain=0.42, shift=0, cut=2500)

            elif name == 'hook':
                bass_bar(b, BASS_DRIVE, gain=1.0, cut=540)
                arp_bar(b, gain=0.72, slots=16, cut=3000, span=2)
                drums(b, 'hook')
                melody(b0, bars, MELody_HOOK if k < 8 else MELody_HOOK_B, gain=1.0)

            elif name == 'break':
                # strip back to pad, one sustained bass note per bar, sparse arp
                ch = CHORDS[b % 4]
                play_bass(b * BAR, ch['root'] - 12, BAR * 1.6, 0.75, cut=320)
                arp_bar(b, gain=0.45, slots=8, cut=1700, span=1)
                if k == 0:
                    play_sub_drop(b * BAR)
                if k == 6:
                    play_riser(b * BAR, 2 * BAR, 1.0)
                melody(b0, bars, [(o, s, n, l) for o, s, n, l in MELody_HOOK], gain=0.55,
                       shift=0, cut=1900) if k >= 3 else None

            elif name == 'climax':
                # The climax should feel bigger through arrangement density, not through
                # level: everything here was a touch hotter than the mix could carry, and
                # the master was doing the difference in distortion
                bass_bar(b, BASS_DRIVE, gain=0.98, cut=540)
                arp_bar(b, gain=0.74, slots=16, cut=2900, span=2)
                drums(b, 'climax')
                melody(b0, bars, MELody_HOOK_B, gain=0.88, shift=12, cut=3400)
                melody(b0, bars, MELody_HOOK, gain=0.42, shift=0, cut=2300)

            elif name == 'outro':
                bass_bar(b, BASS_MAIN, gain=max(0.0, 1.0 - 0.35 * k), cut=460)
                arp_bar(b, gain=max(0.2, 0.75 - 0.11 * k), slots=8, cut=1500 - 120 * k, span=1)
                if k < 2:
                    drums(b, 'main')

    # section transitions: crash, boom and a lift into every loud section. These land on
    # the same beat as the first kick, so they are kept modest and the boom is nudged off
    # the beat — a crash + impact + kick + bass coherent peak is the loudest sample in the
    # track, and it is what a limiter has to smash
    for name, (b0, bars) in section_bars.items():
        if name in ('main', 'hook', 'climax'):
            play_crash(b0 * BAR, 0.8)
            play_impact(b0 * BAR + 0.03, 0.75)
            play_riser(b0 * BAR - 2 * BAR, 2 * BAR, 0.8)
    for name, (b0, bars) in section_bars.items():
        if name == 'break':
            play_riser(b0 * BAR + 6 * BAR, 2 * BAR, 0.9)

    return section_bars


# ------------------------------------------------------------------ effects
def echoes(x, d_sec, fb, taps):
    out = np.zeros_like(x)
    for k in range(1, taps + 1):
        sh = int(k * d_sec * SR)
        if sh >= N:
            break
        out[sh:] += (fb ** k) * x[:N - sh]
    return out


def chorus(L, R, rate=0.86, depth_ms=8.5, mix=0.42, phase=0.0):
    def one(sig, ph):
        mod = (1 + np.sin(2 * np.pi * rate * np.arange(N) / SR + ph)) * 0.5 * depth_ms / 1000
        idx = np.clip(np.arange(N) - (mod * SR).astype(int), 0, N - 1)
        return np.take(sig, idx, mode='clip')
    return L + mix * one(L, phase), R + mix * one(R, phase + 1.7)


def sidechain(stem, kick_slots, depth=0.55, tau=0.19):
    """Pump the stem down on every kick, like a real sidechain."""
    n = len(stem.L)
    env = np.ones(n)
    for t in kick_slots:
        i0 = int(t * SR)
        i1 = min(n, i0 + int(0.62 * SR))
        seg = np.arange(i1 - i0) / SR
        env[i0:i1] *= 1 - depth * np.exp(-seg / tau)
    stem.L *= env
    stem.R *= env


def reverb_send(mono, predelay, times, fbs, taps, lp_fc=9500):
    wet = np.zeros(N)
    for d, fb in zip(times, fbs):
        wet += lp(echoes(mono, d, fb, taps), lp_fc)
    pre = int(predelay * SR)
    return np.concatenate([np.zeros(pre), wet[:N - pre]])


# ------------------------------------------------------------------ master dynamics
# A tanh on the bus is a distortion unit: drive it harder and it adds harmonics and
# shaves transients. The mix needs gain control that does neither, so the master is a
# lookahead limiter (peak-based, stereo linked) fed by a gentle RMS glue stage.
def box_smooth(x, k, causal=False):
    """Moving average, O(n), edge-replicated so the first and last samples keep their own
    value. np.convolve is O(n*k): with a two-bar kernel that is hours of work.
    causal=True averages [i-k+1, i]: a gain smoothed this way is never pulled up by the
    quieter samples that follow a peak, which is what makes a limiter overshoot."""
    k = max(1, int(k))
    xp = np.concatenate([np.full(k, x[0], dtype=float), x, np.full(k, x[-1], dtype=float)])
    cp = np.concatenate([[0.0], np.cumsum(xp)])
    if causal:
        # window x[i-k+1 .. i]  ==  xp[i+1 .. i+k]  (x index j lives at xp index j + k)
        return (cp[k + 1:k + 1 + len(x)] - cp[1:1 + len(x)]) / k
    start = k - k // 2
    return (cp[start + k:start + k + len(x)] - cp[start:start + len(x)]) / k


def _one_pole(x, tau):
    """One-pole lowpass, DC gain 1, warm-started from the first sample's value (a filter
    that starts from zero mutes the first few time constants of the track)."""
    a = 1.0 - np.exp(-1.0 / (max(tau, 1e-5) * SR))
    b, A = [a], [1.0, -1.0 + a]
    zi = signal.lfilter_zi(b, A) * float(x[0])
    return signal.lfilter(b, A, x, zi=zi)[0]        # lfilter returns (output, final state)


def true_peak(x, oversample=4):
    """Peak including the inter-sample maxima a DAC reconstructs between the samples.
    A file whose *sample* peak fits can still clip in the player."""
    if len(x) < 4 * oversample:
        return float(np.max(np.abs(x))) if len(x) else 0.0
    return float(np.max(np.abs(signal.resample_poly(x, oversample, 1))))


def _max_window(x, k, causal):
    """Sliding maximum. causal=False looks at [i, i+k] (lookahead: the peak is visible
    before it arrives); causal=True looks at [i-k, i] (what has already happened)."""
    k = max(1, int(k))
    half = (k + 1) // 2
    return ndimage.maximum_filter1d(x, size=k + 1, mode='nearest',
                                    origin=half if causal else -half)


def _min_window(x, k):
    """Sliding *forward* minimum over [i, i+k]: gain is allowed to fall only as fast as
    this window allows, and it anticipates the fall, which is what a lookahead limiter
    needs. (A causal minimum would hold the gain down long after the peak passed.)"""
    k = max(1, int(k))
    return ndimage.minimum_filter1d(x, size=k + 1, mode='nearest', origin=-((k + 1) // 2))


def _rms_follower(x, atk, rel):
    """Smoothed level in the log domain. Note this is slow in *both* directions (a
    one-pole has one time constant), which is right for a glue stage and wrong for a
    limiter - the limiter shapes its gain with min/max windows instead."""
    la = np.log(np.maximum(x, 1e-7))
    return np.exp(_one_pole(_one_pole(la, atk), rel))


def glue(L, R, thr=0.15, ratio=2.0, atk=0.012, rel=0.28, makeup=1.0):
    """Slow RMS bus compression: glue, no transient damage (that is the limiter's job)."""
    n = len(L)
    mid = 0.5 * (L + R)
    env = _rms_follower(box_smooth(np.abs(mid), 0.004 * SR), atk, rel)
    over = env / thr
    g = np.ones(n)
    m = over > 1.0
    g[m] = (1.0 / over[m]) ** (1.0 - 1.0 / ratio)
    g = _one_pole(g, 0.30) * makeup
    return L * g, R * g, g


def limiter(L, R, ceiling=LIMIT_CEIL, look=0.008, atk=0.003, rel=0.20, soft=1.0, strength=1.0):
    """Stereo-linked lookahead limiter. `soft` < 1 is a soft knee (peaks end up above the
    ceiling), `strength` < 1 leaves some of the reduction out.

    Gain has to fall fast and rise slowly, and one filter cannot do both: the target
    comes from the peak over the lookahead window (so reduction starts *before* the
    transient), the fall is bounded by a forward minimum over the attack window, the
    release is a one-pole, and taking the minimum of the last two makes the shape
    asymmetric. A limiter that starts late overshoots, and overshoot is what a lossy
    encoder turns into clipping.
    """
    det = np.maximum(np.abs(L), np.abs(R))
    env = _max_window(det, look * SR, causal=False)
    g = np.minimum(1.0, ceiling / np.maximum(env, 1e-9)) ** soft
    g = 1.0 + (g - 1.0) * strength
    g = box_smooth(g, atk * SR, causal=True)       # ramps, never steps: steps are clicks
    g = _min_window(g, atk * SR)                   # hold the reduction through the peak
    g = np.minimum(g, _one_pole(g, rel))           # the release
    return L * g, R * g, g


def master_safety(L, R, ceiling=LIMIT_CEIL, target=TP_TARGET, allow_boost=False):
    """Limiter, then true-peak normalization: the pair that keeps the master out of
    clipping. The limiter's detector is sample-based, so the inter-sample maxima a DAC
    reconstructs are handled by the final scale - that is the guarantee, and the ceiling
    sits 1.4 dB above the target so the limiter only touches the top of the waveform
    instead of flattening every transient.

    allow_boost=True lets the final scale exceed 1: a sparser variant (say --no-lead)
    peaks below the target, and capping only would ship it several dB quieter than the
    original - the in-game LEVEL assumes the file lands on TP_TARGET either way.
    """
    L, R, gr = limiter(L, R, ceiling=ceiling)
    tp = max(true_peak(L), true_peak(R))
    scale = target / max(tp, 1e-9)
    if not allow_boost:
        scale = min(1.0, scale)
    return L * scale, R * scale, gr, scale


def section_balance(L, R, section_bars, max_db=3.5):
    """Level-match the dense sections so "louder" means denser, not hotter at the ceiling.

    The reference is the loudest grooving section, and trims only ever cut: a version
    that also boosted the intro, break and outro would have levelled the whole
    arrangement flat, and the quiet-then-loud shape is the point of the arrangement.
    """
    n = len(L)
    mid = 0.5 * (L + R)
    loud = {}
    for name, (b0, bars) in section_bars.items():
        i0 = min(n, int((b0 + 0.7) * BAR * SR))
        i1 = min(n, int((b0 + bars - 0.3) * BAR * SR))
        seg = mid[i0:i1]
        loud[name] = np.sqrt(np.mean(seg ** 2)) if len(seg) > SR else 1e-6
    anchors = [loud[k] for k in ('main', 'hook', 'climax') if k in loud] or list(loud.values())
    ref = float(np.median(anchors))
    lo = 10 ** (-max_db / 20)
    gains = {k: float(np.clip(min(1.0, ref / v), lo, 1.0)) for k, v in loud.items()}

    # gain per sample, edge-padded before smoothing so the first bar keeps its own gain
    # and the reverb tail after the last bar keeps the last section's (a zero-padded
    # average would silently mute both)
    curve = np.full(n, list(gains.values())[-1])
    for name, (b0, bars) in section_bars.items():
        curve[min(n, int(b0 * BAR * SR)):min(n, int((b0 + bars) * BAR * SR))] = gains[name]
    curve = box_smooth(curve, 2 * BAR * SR)
    return L * curve, R * curve, gains, loud

# ------------------------------------------------------------------ mix
def build():
    section_bars = arrange()

    kick_slots = []
    for name, (b0, bars) in section_bars.items():
        if name in ('main', 'hook', 'climax'):
            for k in range(bars):
                slots = [0, 8]
                if name in ('hook', 'climax'):
                    slots.append(6)
                if name == 'climax':
                    slots.append(14)                 # drums() plays this kick; the pump
                if k % 4 == 2:                       # has to follow it, not guess at it
                    slots.append(11)
                for s in slots:
                    kick_slots.append((b0 + k) * BAR + s * SIX)

    sidechain(stems['pad'], kick_slots, depth=0.38, tau=0.24)
    sidechain(stems['arp'], kick_slots, depth=0.26, tau=0.24)
    sidechain(stems['bass'], kick_slots, depth=0.14, tau=0.24)

    # bass: glue and low-end weight
    bass = 0.5 * (stems['bass'].L + stems['bass'].R)
    stems['bass'].L = bass
    stems['bass'].R = bass
    stems['bass'].L = lp(stems['bass'].L, 2100)
    stems['bass'].R = lp(stems['bass'].R, 2100)

    # arp and pad get chorus width
    stems['arp'].L, stems['arp'].R = chorus(stems['arp'].L, stems['arp'].R, 0.9, 7.5, 0.36)
    stems['pad'].L, stems['pad'].R = chorus(stems['pad'].L, stems['pad'].R, 0.55, 12.0, 0.5, 2.1)

    # dotted echo on the lead, panned left/right
    lead_m = 0.5 * (stems['lead'].L + stems['lead'].R)
    d = echoes(lead_m, 0.75 * BEAT, 0.55, 4)
    stems['lead'].L += 0.30 * np.concatenate([np.zeros(300), d[:-300]])
    stems['lead'].R += 0.24 * np.concatenate([np.zeros(700), d[:-700]])

    GAIN = {'drums': 0.86, 'bass': 0.66, 'pad': 0.52, 'arp': 0.54, 'lead': 0.56, 'fx': 0.40}
    L = np.zeros(N)
    R = np.zeros(N)
    for k, st in stems.items():
        L += st.L * GAIN[k]
        R += st.R * GAIN[k]

    # one shared room: predelay + a handful of comb taps, decorrelated per ear
    send = 0.30 * stems['pad'].mono() + 0.26 * lead_m + 0.16 * stems['arp'].mono() + 0.22 * stems['drums'].L
    wetL = reverb_send(send, 0.018, (0.029, 0.0371, 0.0411, 0.0532, 0.0617), (0.72, 0.70, 0.68, 0.64, 0.6), 7)
    wetR = reverb_send(send, 0.026, (0.0313, 0.0353, 0.0433, 0.0571, 0.0589), (0.71, 0.69, 0.66, 0.63, 0.61), 7)
    L += 0.45 * wetL
    R += 0.45 * wetR

    # ---- master: tonal polish, width, level matching, glue, limiting.
    # Deliberately no saturation on the bus: tanh is a distortion unit, and driving it
    # harder in the loud sections is precisely the artifact that shows up as clipping.
    L = lp(hp(L, 30), 18000)
    R = lp(hp(R, 30), 18000)
    L -= 0.20 * hp(L, 7200)          # de-harsh the 7-12k bite (hats, crash, lead edges)
    R -= 0.20 * hp(R, 7200)
    L += 0.12 * hp(L, 8500)          # air, above the harsh band
    R += 0.12 * hp(R, 8500)
    mid = 0.5 * (L + R)
    side = 0.5 * (L - R)
    L = mid + 1.15 * side            # 1.22 was pushing peaks straight into the limiter
    R = mid - 1.15 * side

    L, R, trims, loud = section_balance(L, R, section_bars)
    L, R, glue_g = glue(L, R)
    L, R, gr, scale = master_safety(L, R, allow_boost=DROP_LEAD)
    tp = max(true_peak(L), true_peak(R))

    fade_in = int(1.6 * SR)
    ramp = np.linspace(0, 1, fade_in) ** 0.6
    L[:fade_in] *= ramp
    R[:fade_in] *= ramp
    tail = int(3.2 * SR)
    ramp = np.linspace(1, 0, tail) ** 1.6
    L[-tail:] *= ramp
    R[-tail:] *= ramp

    info = dict(trims=trims, loud=loud, tp=tp * scale, scale=scale, section_bars=section_bars,
                gr_min=float(np.min(gr)), gr_p05=float(np.percentile(gr, 5)))
    return (np.stack([L, R], axis=1) * 32767).astype(np.int16), info


def diagnose(L, R, info):
    print('\n--- mix diagnostics -------------------------------------------')
    for name, sig in (('left', L), ('right', R)):
        peak = np.max(np.abs(sig))
        rms = np.sqrt(np.mean(sig ** 2))
        print(f'{name:6s} peak {peak:6.4f}  true peak {true_peak(sig):.4f}  '
              f'rms {rms:6.4f}  crest {peak / max(rms, 1e-9):4.2f}')

    print('section loudness / transient headroom (crest = peak / rms):')
    for name, (b0, bars) in info['section_bars'].items():
        i0 = int((b0 + 0.7) * BAR * SR)
        i1 = int((b0 + bars - 0.3) * BAR * SR)
        seg = (0.5 * (L + R))[i0:i1]
        if len(seg) < SR:
            continue
        r = np.sqrt(np.mean(seg ** 2))
        f, P = signal.welch(seg, SR, nperseg=4096)
        hf = P[(f > 6000) & (f < 12000)].sum() / P.sum()
        print(f'         {name:7s} rms {r:.4f}  crest {np.max(np.abs(seg)) / max(r, 1e-9):5.2f}  '
              f'true peak {true_peak(seg):.4f}  hf 6-12k {hf:.4f}  trim {info["trims"][name]:.3f}')

    print(f'limiter: gain floor {info["gr_min"]:.3f} (p05 {info["gr_p05"]:.3f}), '
          f'true peak {info["tp"]:.4f}, output scale {info["scale"]:.3f}')

    f, P = signal.welch(L, SR, nperseg=4096)
    low = P[(f > 30) & (f < 120)].sum() / P.sum()
    mid = P[(f > 200) & (f < 5000)].sum() / P.sum()
    high = P[(f > 5000) & (f < 16000)].sum() / P.sum()
    nyq = P[f > 21000].sum() / P.sum()
    print(f'energy: low {low:.3f}  mid {mid:.3f}  high {high:.3f}  above 21k {nyq:.5f}')
    print(f'stereo correlation {(np.corrcoef(L, R)[0, 1]):.3f}')
    print(f'length {(N / SR):.2f}s')


def decode(path):
    """Decode a finished file into float samples: what the browser actually plays."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(float)
    return x[:, 0], x[:, 1]


def main():
    os.makedirs(AUDIO, exist_ok=True)
    print(f'transport: {BPM} BPM, {TOTAL_BARS} bars, {DUR:.1f}s, {N} samples')
    pcm, info = build()
    wav = os.path.join(AUDIO, OUT + '.wav')
    wavfile.write(wav, SR, pcm)
    print(f'wrote {wav} ({os.path.getsize(wav) / 1e6:.1f} MB)')
    diagnose(pcm[:, 0].astype(float) / 32767, pcm[:, 1].astype(float) / 32767, info)

    # The lossy encoders reconstruct transients with overshoot, so the finished files are
    # measured on their own terms: the true peak that matters is the browser's.
    ogg = os.path.join(AUDIO, OUT + '.ogg')
    mp3 = os.path.join(AUDIO, OUT + '.mp3')
    for target, args in ((ogg, ['-c:a', 'libvorbis', '-q:a', '6']),
                         (mp3, ['-c:a', 'libmp3lame', '-b:a', '224k'])):
        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', wav] + args + [target]
        subprocess.run(cmd, check=True)
        l, r = decode(target)
        m = 0.5 * (l + r)
        tp = max(true_peak(l), true_peak(r))
        rms = np.sqrt(np.mean(m ** 2))
        print(f'wrote {target} ({os.path.getsize(target) / 1e6:.2f} MB)  '
              f'decoded true peak {tp:.3f} ({20 * np.log10(max(tp, 1e-9)):+.2f} dBTP)  '
              f'rms {rms:.4f}  crest {np.max(np.abs(m)) / max(rms, 1e-9):.2f}')
        if tp > 0.90:
            print(f'  WARNING: {os.path.basename(target)} decodes above 0.90 true peak — '
                  f'the encoder is overshooting toward clipping')
    os.remove(wav)
    print('removed the uncompressed .wav')


if __name__ == '__main__':
    sys.exit(main())
