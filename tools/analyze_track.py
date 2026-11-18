#!/usr/bin/env python3
"""Objective checks on the rendered track: is it actually on-beat, in tune, and intact?

    python3 tools/analyze_track.py [path/to/neon-drift.ogg]

Decodes with ffmpeg into numpy, then measures the beat grid, the bass fundamentals
against the chord plan, band energy per section, and dropouts.
"""

import os
import subprocess
import sys

import numpy as np
from scipy import signal

SR = 44100
BPM = 92.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
SECTIONS = [('intro', 8), ('main', 16), ('hook', 16), ('break', 8), ('climax', 16), ('outro', 8)]
CHORDS = [(45, 'Am'), (41, 'F'), (48, 'C'), (43, 'G')]


def load(path):
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
        capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)
    return x[:, 0].astype(float), x[:, 1].astype(float)


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def true_peak(x, oversample=4):
    """Inter-sample peak: reconstruct between the samples and take the real maximum."""
    if len(x) < oversample * 4:
        return float(np.max(np.abs(x))) if len(x) else 0.0
    return float(np.max(np.abs(signal.resample_poly(x, oversample, 1))))


def flat_tops(x, level, run):
    """Runs of `run`+ consecutive samples pinned near full scale: a clipping signature."""
    hot = np.abs(x) >= level
    if not hot.any():
        return 0
    idx = np.flatnonzero(np.diff(np.concatenate([[0], hot.view(np.int8), [0]])))
    starts, ends = idx[::2], idx[1::2]
    return int(np.sum(ends - starts >= run))


def band_energy(x, f0, f1):
    f, P = signal.welch(x, SR, nperseg=4096)
    m = (f >= f0) & (f <= f1)
    return P[m].sum() / P.sum()


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'audio', 'neon-drift.ogg')
    L, R = load(path)
    M = 0.5 * (L + R)
    dur = len(L) / SR
    print(f'file   : {path}')
    print(f'decoded: {dur:.2f}s, peak {np.max(np.abs(M)):.3f}, rms {np.sqrt(np.mean(M**2)):.4f}')

    # ---- beat grid: autocorrelate the onset envelope, expect the 92 BPM lag
    env = np.abs(signal.hilbert(M))
    hop = 512
    d = env[::hop]
    d = np.abs(np.diff(d))
    d = d - d.mean()
    ac = np.correlate(d, d, 'full')[len(d) - 1:]
    ac = ac / ac[0]
    lag_beat = int(round(BEAT * SR / hop))
    lo, hi = int(0.7 * lag_beat), int(1.35 * lag_beat)
    best = lo + int(np.argmax(ac[lo:hi]))
    detected = 60.0 / (best * hop / SR)
    print(f'tempo  : detected {detected:.1f} BPM from onset autocorrelation (wrote {BPM})')
    print(f'         onset autocorr at beat lag {ac[best]:.3f}, half-bar {ac[2*lag_beat]:.3f}, bar {ac[4*lag_beat]:.3f}')

    # ---- tuning: measure the bass octave band, above the kick, against the chord plan
    print('bass   : bar-by-bar peak in 70-150 Hz vs the planned root an octave up')
    ok = 0
    checked = 0
    for bar in range(8, 24):
        t0 = int((bar * BAR + 0.15) * SR)          # skip the kick transient
        seg = M[t0:t0 + int(1.6 * SR)]
        if len(seg) < 16384:
            continue
        f, P = signal.welch(seg, SR, nperseg=16384)
        m = (f > 70) & (f < 150)
        hz = f[m][np.argmax(P[m])] if m.any() else 0
        want = midi_hz(CHORDS[bar % 4][0])          # root at the octave the bass jumps to
        cents = 1200 * np.log2(hz / want) if hz > 0 else 999
        good = abs(cents) < 60
        ok += good
        checked += 1
        if bar < 14:
            print(f'         bar {bar:3d} ({CHORDS[bar % 4][1]:2s}) {hz:6.2f} Hz vs {want:6.2f} Hz  {cents:+6.1f} cents {"ok" if good else "OFF"}')
    print(f'         {ok}/{checked} bars within 60 cents of the planned root')

    # ---- arrangement: band energy per section
    print('bands  : low 30-120  mid 200-2k  hi 2k-6k  air 6k-15k  (share of energy)')
    for name, bars in SECTIONS:
        start = sum(b for _, b in SECTIONS[:SECTIONS.index((name, bars))])
        i0 = int((start + 1) * BAR * SR)
        i1 = int((start + bars - 0.5) * BAR * SR)
        seg = M[i0:i1]
        print(f'         {name:7s} {band_energy(seg,30,120):.3f} {band_energy(seg,200,2000):.3f} '
              f'{band_energy(seg,2000,6000):.3f} {band_energy(seg,6000,15000):.3f}')

    # ---- integrity: no dead air in the grooving sections
    win = int(0.25 * SR)
    sq = M ** 2
    c = np.concatenate([[0.0], np.cumsum(sq)])
    edges = np.arange(0, len(sq) - win, win)
    block_rms = np.sqrt(np.maximum(c[edges + win] - c[edges], 0) / win)
    dead = edges[np.where(block_rms < 0.004)[0]] * win / SR
    print(f'integrity: {len(dead)} quiet 250ms blocks (of {len(block_rms)}); loudest block {np.max(block_rms):.3f}')
    print(f'first 3s rms {np.sqrt(np.mean(M[:int(3*SR)]**2)):.4f}  '
          f'last 3s rms {np.sqrt(np.mean(M[-int(3*SR):]**2)):.4f}')

    # ---- clipping / saturation: the artifacts you hear when a master rides the ceiling
    # True peak is measured on a 4x upsampled signal: a sample peak inside the range can
    # still clip between samples once the DAC reconstructs it.
    print('clipping: true peak (4x oversampled), flat-topped runs, transient headroom')
    tp = {'left': true_peak(L), 'right': true_peak(R), 'mid': true_peak(M)}
    for k, v in tp.items():
        print(f'         {k:6s} true peak {v:.3f} ({20 * np.log10(max(v, 1e-9)):+.2f} dBTP)')
    tops = flat_tops(M, 0.97, 4)
    hot = float(np.mean(np.abs(M) > 0.85))
    print(f'         flat-topped runs >=4 samples: {tops}   |M|>0.85: {hot * 100:.2f}% of samples')
    print(f'         slew p99.99 {np.percentile(np.abs(np.diff(M)), 99.99):.4f} per sample '
          f'(max {np.max(np.abs(np.diff(M))):.4f})')

    # per-section: loudness going up while crest factor goes down = the transients are
    # being shaved off, which is exactly what saturation sounds like
    print('stress : per section  rms  crest  TP  HF 6-12k  slew p99.99')
    stress = {}
    for name, bars in SECTIONS:
        start = sum(b for _, b in SECTIONS[:SECTIONS.index((name, bars))])
        i0 = int((start + 1) * BAR * SR)
        i1 = int((start + bars - 0.5) * BAR * SR)
        seg = M[i0:i1]
        if len(seg) < SR:
            continue
        r = np.sqrt(np.mean(seg ** 2))
        stress[name] = dict(
            rms=r,
            crest=np.max(np.abs(seg)) / max(r, 1e-9),
            tp=true_peak(seg),
            hf=band_energy(seg, 6000, 12000),
            slew=np.percentile(np.abs(np.diff(seg)), 99.99),
        )
        s = stress[name]
        print(f'         {name:7s} {s["rms"]:.3f} {s["crest"]:5.2f} {s["tp"]:.3f} '
              f'{s["hf"]:.4f} {s["slew"]:.4f}')

    problems = []
    if 'climax' in stress and 'main' in stress:
        if stress['climax']['crest'] < 0.75 * stress['main']['crest']:
            problems.append(
                f'climax transients are being shaved (crest {stress["climax"]["crest"]:.2f} '
                f'vs main {stress["main"]["crest"]:.2f}) — master saturation')
        if stress['climax']['hf'] > 1.7 * max(stress['main']['hf'], 1e-6):
            problems.append(
                f'climax is harsher than the main section in 6-12k ({stress["climax"]["hf"]:.4f} '
                f'vs {stress["main"]["hf"]:.4f})')
    if max(tp.values()) > 1.0:
        problems.append(f'true peak over full scale ({max(tp.values()):.3f}) — clipping')
    if tops > 20:
        problems.append(f'{tops} flat-topped runs — hard clipping')
    if hot > 0.01:
        problems.append(f'{hot * 100:.1f}% of samples above 0.85 — riding the ceiling')

    if abs(detected - BPM) > 3:
        problems.append(f'tempo grid off ({detected:.1f} vs {BPM})')
    if ok < checked * 0.9:
        problems.append('bass fundamentals drift from the chord plan')
    if len(dead) > 40:
        problems.append(f'{len(dead)} quiet blocks — suspected dropouts')
    print('verdict:', 'PASS' if not problems else 'ISSUES: ' + '; '.join(problems))
    return 0 if not problems else 1


if __name__ == '__main__':
    sys.exit(main())
