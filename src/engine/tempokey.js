// Tempo, key and tuning from mono audio: a short clip for the Camelot page's Listen button
// (camelot.md → Listen), or a whole track for the analyzer (analyzeTrack). Pure: samples in,
// numbers out. Reuses the analyzer's FFT.

import { fft, hann } from './spectrum.js';
import { keyFromPitch, keyId, longName } from './camelot.js';

// Key profiles, tonic first (C major / C minor at index 0): Faraldo et al. 2016, "Key estimation
// in electronic dance music" (edma: from a corpus of EDM). On 770 tracks of the user's techno
// library they matched rekordbox more often than Krumhansl–Kessler (40 vs 37 % exact, and 54 vs
// 50 % with the lean below; camelot.md → Library check).
export const PROFILES = {
  B: [1.0, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39],
  A: [1.0, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
};
// Added to every minor correlation: dance music is mostly minor, and the commonest error left was
// the right tonic in the wrong mode. 0.08 took exact matches from 40 to 50 % while a major track
// still reads major a quarter of the time (0.15: 54 %, but almost never major).
export const MINOR_LEAN = 0.08;
// Key confidence from the margin over the runner-up: "likely", "possible", or none (show the key
// as a guess only). Even confident keys disagreed with rekordbox ~25 % of the time.
export const KEY_LIKELY = 0.1;
export const KEY_POSSIBLE = 0.04;

export const TEMPO_RANGE = { min: 70, max: 180 }; // DJ range: hip-hop to drum & bass
// Octave tie-break: a log-normal preference centred on dance tempos. A breakbeat at 174 and a
// hip-hop beat at 87 have the same periodicity; this picks 174, and the UI offers ½× / 2×.
const PRIOR = { centre: 130, octaves: 0.5 };

const dbfs = (v) => (v > 1e-10 ? 20 * Math.log10(v) : -200);

/** RMS and peak of the clip in dBFS, to tell "silence" from "music". */
export function level(x) {
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    peak = Math.max(peak, Math.abs(x[i]));
  }
  return { rms: dbfs(Math.sqrt(sum / Math.max(1, x.length))), peak: dbfs(peak) };
}

// ---------- tempo ----------

// Runs of exact digital zeros at least this long are holes (missing audio), not music: line
// inputs drop whole device buffers and the capture fills them with silence (camelot.md →
// Line inputs). Live audio never holds exact zeros for this long, not even its noise floor.
const HOLE_MIN = 32;

/** Prefix count of hole samples: holes in [a, b) = h[b] - h[a]. */
function holeCounts(x) {
  const h = new Uint32Array(x.length + 1);
  for (let i = 0; i < x.length;) {
    let j = i;
    while (j < x.length && x[j] === 0) j++;
    const hole = j - i >= HOLE_MIN;
    for (let k = i; k < j; k++) h[k + 1] = h[k] + (hole ? 1 : 0);
    if (j < x.length) h[j + 1] = h[j];
    i = j + 1;
  }
  return h;
}

/**
 * Onset strength: positive spectral flux of a log-compressed magnitude spectrum (≤ 8 kHz),
 * one value per hop, with the slow trend (0.5 s moving average) removed.
 * valid[f] is 0 where frame f or the one before it touches a hole: the jump back from silence
 * would read as a loud onset at a random time (on a line take, ~11 per second). Those frames
 * are left out of the trend and the autocorrelation instead.
 */
export function onsetEnvelope(x, sr, opts) {
  return finish(onsetSteps(x, sr, opts));
}

// onsetEnvelope as steps, so a whole track can be worked through without blocking (analyzeTrack).
function* onsetSteps(x, sr, { n = 1024, hop = 256 } = {}) {
  const w = hann(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const bins = Math.min(n / 2, Math.round(8000 / (sr / n)));
  const holes = holeCounts(x);
  let prev = null, prevClean = false;
  const frames = Math.max(0, Math.floor((x.length - n) / hop) + 1);
  const raw = new Float64Array(frames);
  const valid = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const clean = holes[f * hop + n] === holes[f * hop];
    for (let i = 0; i < n; i++) {
      re[i] = x[f * hop + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p((1000 * Math.hypot(re[k], im[k]) * 4) / n);
      if (prev && mag[k] > prev[k]) flux += mag[k] - prev[k];
    }
    valid[f] = clean && prevClean ? 1 : 0;
    raw[f] = valid[f] ? flux : 0;
    prev = mag;
    prevClean = clean;
    if ((f & 255) === 255) yield;
  }
  const fps = sr / hop;
  const half = Math.round(fps * 0.25);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!valid[f]) continue;
    let s = 0, c = 0;
    for (let k = Math.max(0, f - half); k <= Math.min(frames - 1, f + half); k++) {
      if (valid[k]) {
        s += raw[k];
        c++;
      }
    }
    env[f] = Math.max(0, raw[f] - s / c);
  }
  return { env, fps, valid };
}

// Unbiased autocorrelation (each lag divided by the number of pairs it sums) of a mean-removed
// signal, over valid frames only. Lags with too few pairs to trust count as 0.
function autocorr(env, maxLag, valid, minPairs) {
  const n = env.length;
  let mean = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      mean += env[i];
      count++;
    }
  }
  mean /= count;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0, pairs = 0;
    for (let i = 0; i + lag < n; i++) {
      if (valid[i] && valid[i + lag]) {
        s += (env[i] - mean) * (env[i + lag] - mean);
        pairs++;
      }
    }
    r[lag] = pairs >= minPairs ? s / pairs : 0;
  }
  return r;
}

/**
 * BPM from a clip. Each candidate scores the onset autocorrelation at 1–6 beats (a comb;
 * 4 was fooled by off-beat hats at 4:3, 8 gained nothing on the sweep in tempokey.test.js),
 * normalised by its zero lag, so a tempo whose bars line up beats its double (whose odd beats
 * fall on off-beats). Searched on a 0.05 BPM grid in TEMPO_RANGE; PRIOR then picks between the
 * winner and its half/double.
 * clarity: the winner's mean normalised autocorrelation, ~0 for noise, 0.6–0.9 for a steady beat.
 */
export function estimateTempo(x, sr, range = TEMPO_RANGE, beats = 6) {
  return tempoFromEnvelope(onsetEnvelope(x, sr), range, beats);
}

/** estimateTempo's search on an onset envelope computed earlier: { env, fps, valid }. */
export function tempoFromEnvelope({ env, fps, valid }, range = TEMPO_RANGE, beats = 6) {
  if (valid.reduce((a, v) => a + v, 0) < fps * 3) return null; // under 3 s of audio: not enough bars
  const maxLag = Math.min(env.length - 2, Math.ceil(((60 * fps) / range.min) * beats) + 1);
  const r = autocorr(env, maxLag, valid, fps);
  if (r[0] <= 0) return null;
  const at = (lag) => {
    const i = Math.floor(lag), t = lag - i;
    return i + 1 > maxLag ? 0 : (r[i] * (1 - t) + r[i + 1] * t) / r[0];
  };
  const score = (bpm) => {
    const beat = (60 * fps) / bpm;
    let s = 0;
    for (let m = 1; m <= beats; m++) s += at(m * beat);
    return s;
  };
  let best = { bpm: range.min, s: -Infinity };
  for (let bpm = range.min; bpm <= range.max + 1e-9; bpm += 0.05) {
    const s = score(bpm);
    if (s > best.s) best = { bpm, s };
  }
  if (best.s <= 0) return null;
  // The prior only chooses between the winner and its own half/double, never across the
  // search (that would pull a 174 break to 116, its 2:3 neighbour).
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / PRIOR.centre) / PRIOR.octaves) ** 2);
  const pick = [best.bpm / 2, best.bpm, best.bpm * 2]
    .filter((bpm) => bpm >= range.min && bpm <= range.max)
    .map((bpm) => ({ bpm, s: score(bpm) }))
    .reduce((a, c) => (c.s * prior(c.bpm) > a.s * prior(a.bpm) ? c : a));
  return { bpm: Math.round(pick.bpm * 10) / 10, clarity: Math.max(0, Math.min(1, pick.s / beats)) };
}

// ---------- key ----------

const C1 = 32.7032; // Hz

// FFT length giving ~1.35 Hz bins: 16384 at 22.05 kHz, 32768 at 44.1 and 48 kHz.
const frameFor = (sr) => 2 ** Math.round(Math.log2(sr / 1.35));

/**
 * Pitch content of a clip. The strongest spectral peaks (parabolic-interpolated) from C1 to C6 are
 * binned at 10-cent resolution relative to A440; their circular mean gives the tuning offset
 * (a CDJ at +1.3 % with Master Tempo off sounds about +23 cents sharp). The fine bins are then
 * folded into 12 pitch classes (C = 0) around that offset.
 */
export function chromagram(x, sr, opts) {
  return chromaFromHistogram(pitchHistogram(x, sr, opts).fine);
}

/**
 * chromagram's first half: the 10-cent histogram of spectral peaks (120 bins; 0 = A).
 * - Range: whole octaves, C1–C6 (32.7 Hz–1047 Hz). In techno the bass carries the key; a range
 *   starting at 60 Hz dropped it, and its ends (both B) gave B an extra octave. On 770 tracks of
 *   the user's library this read B/B♭ tonics 3–6× too often (camelot.md → Library check).
 * - Peaks: the `maxPeaks` strongest per frame, so hats and noise don't fill every bin.
 * - Frame: ~1.35 Hz bins at any rate (16384 at 22.05 kHz, 32768 at 44.1/48 kHz), to tell bass
 *   notes 2 Hz apart.
 * windowSeconds > 0 also returns one histogram per window of that length (by frame start), so a
 * whole track can be looked at section by section; they sum to `fine`.
 */
export function pitchHistogram(x, sr, opts) {
  return finish(pitchSteps(x, sr, opts));
}

function* pitchSteps(x, sr, { n = frameFor(sr), hop = n / 4, fmin = C1, fmax = C1 * 32, maxPeaks = 40, windowSeconds = 0 } = {}) {
  const w = hann(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const binHz = sr / n;
  const fine = new Float64Array(120); // 10-cent bins; 0 = A
  const windows = [];
  const lo = Math.max(2, Math.floor(fmin / binHz)), hi = Math.min(n / 2 - 2, Math.ceil(fmax / binHz));
  const mag = new Float64Array(hi + 2);
  for (let start = 0; start + n <= x.length; start += hop) {
    let win = null;
    if (windowSeconds > 0) {
      const at = Math.floor(start / (windowSeconds * sr));
      while (windows.length <= at) windows.push(new Float64Array(120));
      win = windows[at];
    }
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    let max = 0;
    for (let k = lo - 1; k <= hi + 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      if (mag[k] > max) max = mag[k];
    }
    const floor = max * 1e-3; // peaks within 60 dB of the frame's loudest
    const peaks = [];
    for (let k = lo; k <= hi; k++) {
      const m = mag[k];
      if (m < floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-12);
      const d = a - 2 * b + c;
      const f = (k + (d < 0 ? (0.5 * (a - c)) / d : 0)) * binHz;
      if (f >= fmin && f < fmax) peaks.push({ f, m });
    }
    if (peaks.length > maxPeaks) peaks.sort((p, q) => q.m - p.m).length = maxPeaks;
    for (const { f, m } of peaks) {
      const cents = 1200 * Math.log2(f / 440);
      const pos = (((cents % 1200) + 1200) % 1200) / 10;
      const i0 = Math.floor(pos), t = pos - i0;
      const weight = Math.sqrt(m); // compress, so one loud bass note doesn't decide the key
      fine[i0 % 120] += weight * (1 - t);
      fine[(i0 + 1) % 120] += weight * t;
      if (win) {
        win[i0 % 120] += weight * (1 - t);
        win[(i0 + 1) % 120] += weight * t;
      }
    }
    yield;
  }
  return { fine, windows };
}

/** chromagram's second half: tuning (circular mean, −50…+50 cents) and 12 pitch classes from a histogram. */
export function chromaFromHistogram(fine) {
  let sx = 0, sy = 0;
  fine.forEach((v, i) => {
    const ang = (2 * Math.PI * ((i * 10) % 100)) / 100;
    sx += v * Math.cos(ang);
    sy += v * Math.sin(ang);
  });
  const tuning = sx || sy ? (Math.atan2(sy, sx) * 100) / (2 * Math.PI) : 0; // −50 … +50 cents
  const chroma = new Float64Array(12);
  fine.forEach((v, i) => {
    const semis = Math.round((i * 10 - tuning) / 100);
    chroma[(((9 + semis) % 12) + 12) % 12] += v; // A = 9
  });
  const top = Math.max(...chroma);
  return { chroma: Array.from(chroma, (v) => (top > 0 ? v / top : 0)), tuning };
}

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Best of the 24 keys by correlating the chroma with each rotated profile ({ A: minor, B: major },
 * tonic first; PROFILES unless given), minor correlations raised by `lean`.
 * confidence: 'likely' | 'possible' | 'none' from the margin (KEY_LIKELY, KEY_POSSIBLE).
 * margin: best − runner-up correlation. Relative major/minor (8A/8B) share every note, so a
 * small margin between them still means "Camelot 8, compatible either way".
 */
export function estimateKey(chroma, profiles = PROFILES, lean = MINOR_LEAN) {
  if (!chroma.some((v) => v > 0)) return null;
  const ranked = [];
  for (const mode of ['A', 'B']) {
    for (let pc = 0; pc < 12; pc++) {
      const rotated = chroma.map((_, i) => profiles[mode][(i - pc + 12) % 12]);
      ranked.push({ pc, mode, r: correlation(chroma, rotated) + (mode === 'A' ? lean : 0) });
    }
  }
  ranked.sort((a, b) => b.r - a.r);
  const named = ({ pc, mode, r }) => {
    const key = keyFromPitch(pc, mode);
    return { ...key, camelot: keyId(key), name: longName(key), r };
  };
  const margin = ranked[0].r - ranked[1].r;
  const confidence = margin >= KEY_LIKELY ? 'likely' : margin >= KEY_POSSIBLE ? 'possible' : 'none';
  return { ...named(ranked[0]), margin, confidence, runnerUp: named(ranked[1]) };
}

/** Everything the Listen card shows, from one clip. */
export function analyzeClip(x, sr) {
  const lvl = level(x);
  const { chroma, tuning } = chromagram(x, sr);
  return {
    seconds: x.length / sr,
    level: lvl,
    tempo: estimateTempo(x, sr),
    key: estimateKey(chroma),
    chroma,
    tuning: Math.round(tuning * 10) / 10,
  };
}

/**
 * Tempo, key and tuning of a whole track (the analyzer). Like analyzeClip, plus:
 * - the BPM is refined to ±0.01 with a 32-beat comb (refineTempo);
 * - the work runs in steps and yields to the event loop every ~12 ms, so main stays responsive
 *   for a few seconds of maths; aborting `signal` rejects with "Cancelled".
 */
export async function analyzeTrack(x, sr, { signal } = {}) {
  const envelope = await finishAsync(onsetSteps(x, sr), signal);
  const tempo = tempoFromEnvelope(envelope);
  if (tempo) tempo.bpm = refineTempo(envelope, tempo.bpm);
  const { fine } = await finishAsync(pitchSteps(x, sr), signal);
  const { chroma, tuning } = chromaFromHistogram(fine);
  return { seconds: x.length / sr, level: level(x), tempo, key: estimateKey(chroma), chroma, tuning: Math.round(tuning * 10) / 10 };
}

/**
 * A whole track's BPM to ±0.01: `bpm` re-searched within ±1 % with a 32-beat comb on the
 * envelope's autocorrelation. Long lags pin the beat length far tighter than 6 beats can: on 770
 * tracks, 82 % landed within 0.1 of rekordbox's BPM, against 64 % before. Clips shorter than
 * 64 beats keep `bpm`.
 */
export function refineTempo({ env, fps, valid }, bpm, { beats = 32, span = 0.01 } = {}) {
  const maxLag = Math.ceil(((60 * fps) / (bpm * (1 - span))) * beats) + 2;
  if (maxLag >= env.length / 2) return bpm;
  const r = maskedAutocorr(env, valid, maxLag, fps);
  if (!(r[0] > 0)) return bpm;
  const at = (lag) => {
    const i = Math.floor(lag), t = lag - i;
    return (r[i] * (1 - t) + r[i + 1] * t) / r[0];
  };
  let best = { bpm, s: -Infinity };
  for (let b = bpm * (1 - span); b <= bpm * (1 + span); b += 0.005) {
    const beat = (60 * fps) / b;
    let s = 0;
    for (let m = 1; m <= beats; m++) s += at(m * beat);
    if (s > best.s) best = { bpm: b, s };
  }
  return Math.round(best.bpm * 100) / 100;
}

// autocorr() through the FFT, for long lags: sums and pair counts of valid frames.
function maskedAutocorr(env, valid, maxLag, minPairs) {
  let n = 1;
  while (n < env.length + maxLag + 1) n <<= 1;
  let mean = 0, count = 0;
  for (let i = 0; i < env.length; i++) {
    if (valid[i]) {
      mean += env[i];
      count++;
    }
  }
  mean /= count || 1;
  const er = new Float64Array(n), ei = new Float64Array(n), mr = new Float64Array(n), mi = new Float64Array(n);
  for (let i = 0; i < env.length; i++) {
    if (valid[i]) {
      er[i] = env[i] - mean;
      mr[i] = 1;
    }
  }
  const auto = (re, im) => {
    fft(re, im);
    for (let k = 0; k < n; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    fft(re, im); // a real, even power spectrum: the forward FFT is the inverse times n
    return re;
  };
  const sums = auto(er, ei), pairs = auto(mr, mi);
  const r = new Float64Array(maxLag + 2);
  for (let lag = 0; lag < r.length; lag++) {
    const p = Math.round(pairs[lag] / n);
    r[lag] = p >= minPairs ? sums[lag] / n / p : 0;
  }
  return r;
}

// Run a step generator to its return value, at once or yielding to the event loop.
function finish(steps) {
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
  }
}

async function finishAsync(steps, signal) {
  let since = performance.now();
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
    if (performance.now() - since > 12) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw new Error('Cancelled');
      since = performance.now();
    }
  }
}
