import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClip, analyzeTrack, estimateTempo, estimateKey, refineTempo, onsetEnvelope, level } from '../src/engine/tempokey.js';
import { synthTrack, noise } from './synth.js';

const sr = 48000;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('tempokey: house at 128 BPM in A minor', () => {
  const r = analyzeClip(synthTrack({ bpm: 128, pattern: 'house', progression: 'A minor', sr }), sr);
  near(r.tempo.bpm, 128, 0.3, 'bpm');
  assert.ok(r.tempo.clarity > 0.5, `clarity ${r.tempo.clarity}`);
  assert.equal(r.key.camelot, '8A');
  assert.equal(r.key.name, 'A minor');
  near(r.tuning, 0, 4, 'tuning');
  assert.equal(r.chroma.length, 12);
});

test('tempokey: breakbeat at 174 is not read as 87', () => {
  const r = analyzeClip(synthTrack({ bpm: 174, pattern: 'breaks', progression: 'F# minor', sr }), sr);
  near(r.tempo.bpm, 174, 0.5, 'bpm');
  assert.equal(r.key.camelot, '11A');
});

test('tempokey: 95 BPM in C major', () => {
  const r = analyzeClip(synthTrack({ bpm: 95, pattern: 'breaks', progression: 'C major', sr }), sr);
  near(r.tempo.bpm, 95, 0.4, 'bpm');
  assert.equal(r.key.camelot, '8B');
});

test('tempokey: a pitched deck reads as detuned, same key', () => {
  const sharp = analyzeClip(synthTrack({ bpm: 126, pattern: 'house', progression: 'A minor', cents: 30, sr }), sr);
  near(sharp.tuning, 30, 4, 'tuning +30');
  assert.equal(sharp.key.camelot, '8A');
  const flat = analyzeClip(synthTrack({ bpm: 126, pattern: 'house', progression: 'C major', cents: -20, sr }), sr);
  near(flat.tuning, -20, 4, 'tuning −20');
  assert.equal(flat.key.camelot, '8B');
});

test('tempokey: 44.1 kHz input and a short 6 s take', () => {
  const r = analyzeClip(synthTrack({ bpm: 132, pattern: 'house', progression: 'A minor', seconds: 6, sr: 44100 }), 44100);
  near(r.tempo.bpm, 132, 0.5, 'bpm');
  assert.equal(r.key.camelot, '8A');
});

test('tempokey: silence and noise', () => {
  const silent = analyzeClip(new Float32Array(sr * 5), sr);
  assert.equal(silent.level.rms, -200);
  assert.equal(silent.tempo, null);
  assert.equal(silent.key, null);
  assert.equal(estimateTempo(new Float32Array(sr * 2), sr), null, 'under 3 s');
  const rand = noise(3);
  const hiss = Float32Array.from({ length: sr * 8 }, () => rand() * 0.1);
  const t = estimateTempo(hiss, sr);
  assert.ok(!t || t.clarity < 0.2, `noise clarity ${t?.clarity}`);
  near(level(hiss).rms, -24.8, 1, 'noise rms');
});

test('tempokey: sweep 90–174 BPM, two patterns: exact or an octave, never a wrong tempo', () => {
  const wrong = [];
  let exact = 0, total = 0;
  for (const pattern of ['house', 'breaks']) {
    for (let bpm = 90; bpm <= 174; bpm += 12) {
      const t = estimateTempo(synthTrack({ bpm, pattern, progression: 'A minor', seconds: 8, sr, seed: bpm }), sr);
      total++;
      if (Math.abs(t.bpm - bpm) <= 0.5) exact++;
      else if (![2, 0.5].some((k) => Math.abs(t.bpm / bpm - k) < 0.01)) wrong.push(`${pattern} ${bpm} → ${t.bpm}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(exact / total >= 0.85, `exact ${exact}/${total}`);
});

test('tempokey: dropout holes (exact-zero runs) are skipped, not heard as onsets', () => {
  // Like a line take: 12 % of 512-sample buffers missing, put back as silence (linein.js).
  const clean = synthTrack({ bpm: 128, pattern: 'house', progression: 'A minor', sr });
  const holed = Float32Array.from(clean);
  const rand = noise(11);
  for (let b = 0; b * 512 < holed.length; b++) if (rand() < -0.76) holed.fill(0, b * 512, (b + 1) * 512); // −1…1: 12 %
  const a = estimateTempo(clean, sr), h = estimateTempo(holed, sr);
  near(h.bpm, 128, 0.3, 'bpm');
  assert.ok(h.clarity > 0.5 && h.clarity > a.clarity - 0.1, `clarity ${h.clarity} vs clean ${a.clarity}`);
  const gappy = Float32Array.from(clean).fill(0, sr * 2); // music for 2 s, then digital silence
  assert.equal(estimateTempo(gappy, sr), null, 'under 3 s of audio between the holes');
});

test('tempokey: whole track — BPM to ±0.05, key, and main stays responsive', async () => {
  const sr2 = 22050;
  const x = synthTrack({ bpm: 125.37, pattern: 'house', progression: 'A minor', seconds: 60, sr: sr2 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const t0 = performance.now();
  const r = await analyzeTrack(x, sr2);
  clearInterval(timer);
  near(r.tempo.bpm, 125.37, 0.05, 'refined bpm');
  assert.equal(r.key.camelot, '8A');
  assert.ok(ticks >= (performance.now() - t0) / 5 / 4, `event loop ran ${ticks} times while analysing`);
  const ac = new AbortController();
  const pending = analyzeTrack(x, sr2, { signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, /Cancelled/);
});

test('tempokey: refineTempo pins a long take, keeps a short one', () => {
  const x = synthTrack({ bpm: 128.62, pattern: 'house', progression: 'A minor', seconds: 45, sr });
  const coarse = estimateTempo(x, sr);
  near(refineTempo(onsetEnvelope(x, sr), coarse.bpm), 128.62, 0.05, 'refined');
  const short = synthTrack({ bpm: 128.62, pattern: 'house', progression: 'A minor', seconds: 10, sr });
  assert.equal(refineTempo(onsetEnvelope(short, sr), 128.6), 128.6, 'under 64 beats: unchanged');
});

test('tempokey: key confidence and the minor lean', () => {
  const aMinor = [0.2, 0.1, 0.3, 0.1, 0.6, 0.2, 0.1, 0.3, 0.1, 1, 0.1, 0.2].map((v, i) => v + (i === 0 ? 0.5 : 0)); // A, C, E strong
  const k = estimateKey(aMinor);
  assert.equal(k.camelot, '8A');
  assert.ok(['likely', 'possible'].includes(k.confidence), k.confidence);
  assert.equal(estimateKey(new Array(12).fill(0.5).map((v, i) => v + (i % 2) * 0.01)).confidence, 'none', 'flat chroma: no clear key');
  const cMajor = [1, 0.1, 0.5, 0.1, 0.8, 0.5, 0.1, 0.9, 0.1, 0.4, 0.1, 0.3];
  assert.equal(estimateKey(cMajor).camelot, '8B', 'a clear major still reads major');
  assert.equal(estimateKey(cMajor, undefined, 1).mode, 'A', 'a big lean makes everything minor');
});
