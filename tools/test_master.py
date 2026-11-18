#!/usr/bin/env python3
"""Unit checks for the master-chain blocks in make_track.py.

    python3 tools/test_master.py

These exist because the previous master was a tanh on the bus: it distorted more in the
louder sections, and nothing in the render log said so. Each block here is checked
against the property it is supposed to have, on signals where the answer is known.
"""

import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('mk', os.path.join(HERE, 'make_track.py'))
mk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mk)

SR = mk.SR
fails = []


def check(name, cond, detail=''):
    print(f'{"ok  " if cond else "FAIL"}  {name}{("  — " + detail) if detail else ""}')
    if not cond:
        fails.append(name)


def burst(f0, amp, start_s, ramp_s, n_s=2.0, decay=0.08):
    """A transient with a real lead-in: silence, a ramp, then an exponential decay."""
    n = int(n_s * SR)
    t = np.arange(n) / SR
    ramp = np.clip(t / ramp_s, 0, 1)
    tone = np.sin(2 * np.pi * f0 * t) * np.exp(-np.maximum(t - start_s, 0) / decay)
    return amp * ramp * tone * (t >= start_s - ramp_s)


# ---------------------------------------------------------------- window filters
x = np.zeros(4000)
x[2000] = 1.0
env = mk._max_window(x, 100, causal=False)
nz = np.flatnonzero(env > 0)
check('lookahead window sees the peak before it arrives', nz.min() < 2000 and nz.max() >= 2000,
      f'visible {nz.min()}..{nz.max()} of the peak at 2000')
past = mk._max_window(x, 100, causal=True)
nz2 = np.flatnonzero(past > 0)
check('causal window sees the peak only after it', nz2.min() >= 2000 and nz2.max() <= 2100,
      f'visible {nz2.min()}..{nz2.max()}')
low = np.ones(2000)
low[1500:1600] = 0.4
mf = mk._min_window(low, 100)
check('forward minimum anticipates the drop (gain starts falling early)', mf[1450] < 0.41,
      f'{mf[1450]:.3f} 50 samples before the dip')
check('forward minimum releases the moment the dip is behind it', mf[1601] > 0.99,
      f'{mf[1601]:.3f}')

# a warm-started one-pole must not fade in from silence
step1 = np.concatenate([np.full(3000, 0.9), np.full(3000, 0.2)])
op = mk._one_pole(step1, 0.05)
check('one-pole starts at the signal level (no fade-in from zero)', op[0] > 0.85,
      f'first sample {op[0]:.3f}')
check('one-pole settles toward the new level', op[3000 + int(0.05 * SR)] < 0.55,
      f'{op[3000]:.3f} -> {op[3000 + int(0.05 * SR)]:.3f} one tau later')

# ---------------------------------------------------------------- true peak
# A 15 kHz sine sampled at 44.1 kHz has its real maxima *between* the samples:
# a checker that only looks at samples calls this clean when a DAC will clip it.
t = np.arange(20000) / SR
hot = 0.98 * np.sin(2 * np.pi * 15000 * t + 0.31)
sp = float(np.max(np.abs(hot)))
tp = mk.true_peak(hot)
check('true peak finds inter-sample maxima', tp > sp + 0.01,
      f'sample peak {sp:.3f} vs true peak {tp:.3f}')

# ---------------------------------------------------------------- limiter
kick = burst(60, 0.95, 0.6, 0.003)                      # a 3 ms lead-in, like a real kick
L = kick.copy()
R = 0.6 * kick
oL, oR, g = mk.limiter(L, R, ceiling=mk.LIMIT_CEIL)
in_tp = max(mk.true_peak(L), mk.true_peak(R))
sp = float(np.max(np.abs(oL)))
check('limiter holds the ceiling it detects on (sample peak)', sp <= mk.LIMIT_CEIL * 1.02,
      f'in {float(np.max(np.abs(L))):.3f} -> out {sp:.3f}, ceiling {mk.LIMIT_CEIL}')
check('limiter keeps the transient (output peak well below input)',
      sp < float(np.max(np.abs(L))) * 0.72, f'{float(np.max(np.abs(L))):.3f} -> {sp:.3f}')
sL, sR, sg, ss = mk.master_safety(L, R)
stp = max(mk.true_peak(sL), mk.true_peak(sR))
check('master_safety holds the true-peak target (inter-sample peaks included)',
      stp <= mk.TP_TARGET * 1.01, f'in true peak {in_tp:.3f} -> {stp:.3f}, target {mk.TP_TARGET}')
check('master_safety keeps headroom for the encoders', stp < 0.75, f'{stp:.3f}')
check('limiter actually works (gain reduction happened)', float(g.min()) < 0.8,
      f'gain floor {g.min():.3f}')
check('limiter is stereo linked (same gain both channels)',
      np.allclose(oL / np.where(L == 0, 1, L), oR / np.where(R == 0, 1, R), rtol=1e-6))
tail_start = int((0.6 + 0.5) * SR)
check('limiter releases within a bar', float(np.min(g[tail_start:])) > 0.95,
      f'gain {np.min(g[tail_start:]):.3f} 450ms after the hit')
check('limiter does not add discontinuities',
      np.max(np.abs(np.diff(oL))) <= np.max(np.abs(np.diff(L))) * 1.05,
      f'slew in {np.max(np.abs(np.diff(L))):.4f} out {np.max(np.abs(np.diff(oL))):.4f}')

# a limiter that only reacts to the RMS of a quiet pad should leave it alone
pad = 0.12 * np.sin(2 * np.pi * 110 * np.arange(int(2 * SR)) / SR)
oL2, oR2, g2 = mk.limiter(pad, pad, ceiling=mk.LIMIT_CEIL)
check('limiter leaves quiet material untouched', float(g2.min()) > 0.999,
      f'gain floor {g2.min():.4f}')
check('limiter gain starts at unity (no fade-in from zero gain)', float(g2[0]) > 0.999,
      f'first gain {g2[0]:.4f}')

# ---------------------------------------------------------------- glue
L3 = np.concatenate([0.05 * np.sin(2 * np.pi * 200 * np.arange(int(1 * SR)) / SR),
                     0.70 * np.sin(2 * np.pi * 200 * np.arange(int(1 * SR)) / SR)])
gL, gR, gg = mk.glue(L3, L3)
check('glue compresses loud material', float(np.min(gg)) < 0.9, f'gain floor {np.min(gg):.3f}')
check('glue leaves quiet material alone', float(np.max(gg[:int(0.5 * SR)])) <= 1.001,
      f'gain {np.max(gg[:int(0.5 * SR)]):.3f}')
check('glue works on a short buffer (no hidden global length)', len(gg) == len(L3),
      f'{len(gg)} gains for {len(L3)} samples')

# ---------------------------------------------------------------- box_smooth
edge = np.concatenate([np.ones(1000), np.zeros(1000)])
s = mk.box_smooth(edge, 101)
check('box_smooth keeps the edges (no zero-padding mute)',
      abs(s[0] - 1.0) < 1e-9 and abs(s[-1] - 0.0) < 1e-9, f'ends {s[0]:.3f} / {s[-1]:.3f}')
check('box_smooth is centred', abs(float(s[1000]) - 0.5) < 0.02, f'at the step {s[1000]:.3f}')
check('box_smooth preserves length', len(s) == len(edge), f'{len(s)} for {len(edge)}')
step_up = np.concatenate([np.full(1500, 0.4), np.full(1500, 1.0)])
cs = mk.box_smooth(step_up, 101, causal=True)
check('causal smoothing never anticipates a rise (that overshoots the ceiling)',
      cs[1500] < 0.42, f'{cs[1500]:.3f} at the step')
check('causal smoothing reaches the new level across its window', cs[1500 + 101] > 0.99,
      f'{cs[1500 + 101]:.3f}')

# ---------------------------------------------------------------- section_balance
N = int(40 * mk.BAR * SR)
sbars = {'main': (0, 20), 'climax': (20, 20)}
loud_L = np.concatenate([np.full(int(20 * mk.BAR * SR), 0.10), np.full(int(20 * mk.BAR * SR), 0.40)])
oL4, oR4, trims, loud = mk.section_balance(loud_L, loud_L, sbars)
check('section_balance trims the loud section down', trims['climax'] < 0.9,
      f'trim {trims["climax"]:.3f} (loud {loud["climax"]:.3f} vs {loud["main"]:.3f})')
check('section_balance never boosts a section above unity',
      all(v <= 1.0 + 1e-9 for v in trims.values()),
      ' '.join(f'{k}={v:.3f}' for k, v in trims.items()))
check('section_balance stays inside -3.5 dB of cut',
      all(v >= 10 ** (-3.5 / 20) - 1e-9 for v in trims.values()),
      ' '.join(f'{k}={v:.3f}' for k, v in trims.items()))
quiet_L = np.concatenate([np.full(int(20 * mk.BAR * SR), 0.06), np.full(int(20 * mk.BAR * SR), 0.40)])
qL, qR, qtrims, qloud = mk.section_balance(quiet_L, quiet_L, sbars)
check('section_balance leaves a quiet section alone (keeps the dynamic arc)',
      abs(qtrims['main'] - 1.0) < 1e-6, f'intro/main trim {qtrims["main"]:.3f}')
tail = oL4[int(38 * mk.BAR * SR):]
check('section_balance does not mute the tail after the last bar',
      float(np.max(np.abs(tail))) > 0.05, f'tail peak {np.max(np.abs(tail)):.3f}')

print('-----------------------------------')
print('ALL MASTER CHECKS PASSED' if not fails else f'{len(fails)} FAILED: ' + ', '.join(fails))
sys.exit(1 if fails else 0)
