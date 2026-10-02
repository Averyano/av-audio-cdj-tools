import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, SpectrogramBuilder, findCutoff, hiresVerdict as verdict, losslessVerdict, likelyBitrate, usedBitsFromOr, FFT_SIZE } from '../src/engine/spectrum.js';

// Deterministic "music": a comb of tones every `step` Hz up to `top`, random phases,
// amplitude falling with frequency when `rolloff` is set.
function comb({ sampleRate, seconds = 1, top, step = 100, amp = 0.004, rolloff = false }) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const tones = [];
  for (let f = step; f <= top; f += step) tones.push([f, rand() * 2 * Math.PI, rolloff ? (amp * 1000) / f : amp]);
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (const [f, ph, a] of tones) {
    const w = (2 * Math.PI * f) / sampleRate;
    for (let i = 0; i < out.length; i++) out[i] += a * Math.sin(w * i + ph);
  }
  return out;
}

function analyse(samples, sampleRate) {
  const b = new SpectrogramBuilder({ sampleRate, totalSamples: samples.length, columns: 64, rows: 128 });
  for (let i = 0; i < samples.length; i += 10000) b.push(samples.subarray(i, i + 10000)); // in chunks, like a stream
  const res = b.finish();
  return { ...res, edge: findCutoff(res.spectrum, res.binHz) };
}

test('spectrum: fft puts a sine in its bin', () => {
  const n = 1024;
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 37 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.equal(mags.indexOf(Math.max(...mags.slice(0, n / 2))), 37);
  assert.ok(Math.abs(mags[37] - n / 2) < 1e-6);
});

test('spectrum: a full-scale sine reads 0 dB in its bin, and streaming gives the asked-for columns', () => {
  const sr = 44100;
  const sine = Float32Array.from({ length: sr * 2 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
  const { spectrum, binHz, columns, rows, image } = analyse(sine, sr);
  const peak = Math.max(...spectrum);
  assert.ok(Math.abs(peak) < 0.5, `peak ${peak} dB`);
  assert.ok(Math.abs(spectrum.indexOf(peak) * binHz - 1000) < binHz * 1.5);
  assert.ok(columns >= 64 && columns <= 66, `columns ${columns}`);
  assert.equal(image.length, columns * rows);
  assert.equal(image[0], 0, 'top row (Nyquist) is silent');
});

test('spectrum: lossy-style brick wall at 16 kHz is found', () => {
  const { edge } = analyse(comb({ sampleRate: 44100, top: 16000 }), 44100);
  assert.ok(Math.abs(edge.cutoff - 16000) < 300, `cutoff ${edge.cutoff}`);
});

test('spectrum: natural roll-off to Nyquist has no cliff', () => {
  const { edge } = analyse(comb({ sampleRate: 44100, top: 22000, rolloff: true }), 44100);
  assert.equal(edge.cutoff, null);
  assert.ok(edge.bandwidth > 20000, `bandwidth ${edge.bandwidth}`);
  assert.equal(edge.ultrasonic, null, 'not asked below 48 kHz');
});

test('spectrum: hi-res content that fades to Nyquist with no wall still counts as ultrasonic', () => {
  const { edge } = analyse(comb({ sampleRate: 96000, top: 47800, step: 200, rolloff: true }), 96000);
  assert.equal(edge.cutoff, null);
  assert.equal(edge.ultrasonic, 'present');
  assert.equal(verdict({ lossless: true, sampleRate: 96000, bits: 24 }, 24, edge).title, 'Genuine hi-res');
});

test('spectrum: upsampled vs genuine 96 kHz', () => {
  const fake = analyse(comb({ sampleRate: 96000, top: 21000 }), 96000).edge;
  assert.ok(Math.abs(fake.cutoff - 21000) < 300, `fake cutoff ${fake.cutoff}`);
  assert.equal(fake.ultrasonic, 'absent');
  const real = analyse(comb({ sampleRate: 96000, top: 40000, step: 200 }), 96000).edge;
  assert.ok(real.cutoff > 39000, `real cutoff ${real.cutoff}`);
});

test('spectrum: verdicts', () => {
  const v = (format, usedBits, edge) => verdict({ lossless: true, ...format }, usedBits, { bandwidth: 0, ...edge });
  assert.deepEqual(
    [v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: 45000 }).tone, v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: 45000 }).title],
    ['ok', 'Genuine hi-res']);
  assert.equal(v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: 21500 }).title, 'Upsampled, not real hi-res');
  assert.equal(v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: 25500 }).title, 'Upsampled, not real hi-res', 'slow skirt past 24 kHz');
  assert.equal(v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: null, bandwidth: 22000, ultrasonic: 'absent' }).tone, 'bad');
  assert.equal(v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: null, bandwidth: 30000, ultrasonic: 'weak' }).title, 'Little sound above 24 kHz');
  assert.equal(v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: null, bandwidth: 48000, ultrasonic: 'present' }).title, 'Genuine hi-res');
  assert.equal(v({ sampleRate: 44100, bits: 16 }, 16, { cutoff: 16000 }).title, 'Made from an MP3, not real lossless');
  assert.equal(v({ sampleRate: 44100, bits: 24 }, 24, { cutoff: 19500 }).title, 'Possibly made from a high-bitrate MP3', 'lossy evidence outranks "real 24-bit"');
  assert.equal(v({ sampleRate: 44100, bits: 16 }, 16, { cutoff: 19800 }).tone, 'warn');
  assert.deepEqual([v({ sampleRate: 44100, bits: 16 }, 16, { cutoff: 21000 }).tone, v({ sampleRate: 44100, bits: 16 }, 16, { cutoff: 21000 }).title],
    ['info', 'CD quality, not hi-res']);
  const padded = v({ sampleRate: 96000, bits: 24 }, 16, { cutoff: 45000 });
  assert.equal(padded.tone, 'warn');
  assert.match(padded.notes.join(' '), /only 16 bits carry sound/);
  assert.equal(v({ sampleRate: 48000, bits: 24 }, 24, { cutoff: null, bandwidth: 23000 }).title, 'Real 24-bit at 48 kHz');
  const mp3 = verdict({ lossless: false, codec: 'MPEG 1 Layer 3', sampleRate: 44100 }, null, { cutoff: 16000, bandwidth: 16000 });
  assert.equal(mp3.title, 'Lossy file (MP3), not lossless, so not hi-res');
});

test('spectrum: lossless verdicts (the default)', () => {
  const v = (format, usedBits, edge) => losslessVerdict({ lossless: true, sampleRate: 44100, bits: 16, ...format }, usedBits, { bandwidth: 22050, ...edge });
  const fake = v({}, 16, { cutoff: 16600 });
  assert.deepEqual([fake.tone, fake.title], ['bad', 'Made from an MP3, not real lossless']);
  assert.match(fake.notes[0], /about 128 kbps/);
  assert.match(v({}, 16, { cutoff: 18650 }).notes[0], /about 192 kbps/);
  const maybe = v({}, 16, { cutoff: 20050 });
  assert.deepEqual([maybe.tone, maybe.title], ['warn', 'Possibly made from a high-bitrate MP3']);
  assert.match(maybe.notes[0], /256–320 kbps/);
  assert.deepEqual([v({}, 16, { cutoff: null }).tone, v({}, 16, { cutoff: null }).title], ['ok', 'Real lossless']);
  assert.match(v({}, 16, { cutoff: null, bandwidth: 14000 }).notes[0], /fades out gradually/);
  const up = v({ sampleRate: 96000, bits: 24 }, 24, { cutoff: 21500 });
  assert.deepEqual([up.tone, up.title], ['ok', 'Real lossless'], 'upsampled CD audio is still lossless');
  assert.match(up.notes.join(' '), /upsampled from CD quality/);
  assert.equal(up.notes[0], 'No sign of MP3/AAC.', 'no "without a hard cutoff" when a wall is drawn');
  assert.match(v({}, 16, { cutoff: 21300 }).notes[0], /above where MP3s cut off/);
  const padded = v({ sampleRate: 44100, bits: 24 }, 16, { cutoff: null });
  assert.equal(padded.tone, 'ok');
  assert.match(padded.notes.join(' '), /only 16 bits carry sound/);
  const mp3 = losslessVerdict({ lossless: false, codec: 'MPEG 1 Layer 3', sampleRate: 44100 }, null, { cutoff: 16600, bandwidth: 16600 });
  assert.deepEqual([mp3.tone, mp3.title], ['info', 'Lossy file (MP3), not lossless']);
});

test('spectrum: MP3 bitrate from the cutoff (LAME low-pass table)', () => {
  assert.equal(likelyBitrate(16600), '128 kbps');
  assert.equal(likelyBitrate(18670), '192 kbps');
  assert.equal(likelyBitrate(20050), '256–320 kbps');
  assert.equal(likelyBitrate(15224), '96–112 kbps');
  assert.equal(likelyBitrate(11000), 'under 96 kbps');
  assert.equal(likelyBitrate(21800), null);
});

test('spectrum: used bits from the OR of all samples', () => {
  assert.equal(usedBitsFromOr(0), 0);
  assert.equal(usedBitsFromOr(1 << 16), 16);
  assert.equal(usedBitsFromOr(-65536), 16);
  assert.equal(usedBitsFromOr(0x7fffff00), 24);
  assert.equal(usedBitsFromOr(3), 32);
  assert.equal(FFT_SIZE, 4096);
});

// Regression (2026-10-01): tracks longer than 1024 × 16384 samples (6:20 at 44.1 kHz, 2:55 at
// 96 kHz) crashed push() with "offset is out of bounds": the next column started beyond the
// buffered audio and the buffer length went negative. Depended on chunk sizes, so try two.
function streamSine(builder, total, sr, chunk) {
  const w = (2 * Math.PI * 1000) / sr;
  for (let at = 0; at < total; at += chunk) {
    const n = Math.min(chunk, total - at);
    builder.push(Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(w * (at + i))));
  }
  return builder.finish();
}

test('spectrum: columns wider than 4 FFTs stream without crashing, whatever the chunk size', () => {
  // Same column width as "Na Nich - Code" (6:45 at 44.1 kHz → 17456 samples per column), with
  // 64 columns instead of 1024 to keep it fast. test/analyzer.test.js runs a real 6:40 file.
  const sr = 44100, total = 64 * 17456 + 1;
  for (const chunk of [65536, 8191]) {
    const b = new SpectrogramBuilder({ sampleRate: sr, totalSamples: total, columns: 64 });
    assert.equal(b.windows, 5, 'windows grow to cover each column end to end');
    const r = streamSine(b, total, sr, chunk);
    assert.ok(r.columns >= 64 && r.columns <= 65, `columns ${r.columns}`);
    assert.ok(Math.abs(r.spectrum.indexOf(Math.max(...r.spectrum)) * r.binHz - 1000) < r.binHz * 1.5);
  }
});

test('spectrum: columns wider than 32 FFTs skip the gaps between windows', () => {
  const sr = 44100, total = 16 * 200000;
  const b = new SpectrogramBuilder({ sampleRate: sr, totalSamples: total, columns: 16, rows: 64 });
  assert.equal(b.windows, 32);
  const r = streamSine(b, total, sr, 65536);
  assert.equal(r.columns, 16);
  assert.equal(r.totalSamples, total);
});
