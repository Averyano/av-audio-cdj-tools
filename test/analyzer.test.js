import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { analyzeFile, analyzeTempoKey } from '../src/engine/analyze.js';
import { SpectrogramBuilder } from '../src/engine/spectrum.js';

// Real encoder and resampler output, not synthetic spectra: pink noise through each path.
// Stereo matters for the MP3: LAME's low-pass follows bits per channel, so mono 128k cuts
// at ~20 kHz like 256k stereo would.
let dir;
const file = (name) => path.join(dir, name);
const ff = (...args) => execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const pink = (rate, extra = '') => ['-f', 'lavfi', '-i', `anoisesrc=r=${rate}:color=pink:amplitude=0.3:d=4${extra}`];
const flac24 = ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'];

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-analyzer-'));
  ff(...pink(96000), ...flac24, file('genuine.flac'));
  ff(...pink(44100, ',aresample=96000'), ...flac24, file('upsampled.flac'));
  ff(...pink(44100), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', file('lossy.mp3'));
  ff('-i', file('lossy.mp3'), '-c:a', 'flac', '-sample_fmt', 's16', file('from-mp3.flac'));
  ff(...pink(96000, ',aformat=sample_fmts=s16'), ...flac24, file('padded.flac'));
  ff(...pink(44100), '-c:a', 'flac', '-sample_fmt', 's16', file('cd.flac'));
  ff(...pink(44100), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '320k', file('hq.mp3'));
  ff('-i', file('hq.mp3'), '-c:a', 'flac', file('from-320.flac')); // ffmpeg makes this 24-bit: the decoder outputs float
  // Longer than 6:20 at 44.1 kHz: the length that crashed the analyzer (spectrum.test.js).
  ff('-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=400', '-ac', '2', '-c:a', 'flac', file('long.flac'));
  // 40 s at 126.5 BPM: a kick on every beat under an A minor bass + chord (A1, A2, C3, E3).
  const chord = [55, 110, 130.81, 164.81].map((f) => `0.12*sin(2*PI*${f}*t)`).join('+');
  ff('-f', 'lavfi', '-i', `aevalsrc=${chord}+0.8*exp(-30*mod(t\\,60/126.5))*sin(2*PI*50*t)+0.002*sin(2*PI*997*t):s=44100:d=40`,
    '-c:a', 'flac', file('beat.flac'));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

const run = (name, opts) => analyzeFile(file(name), { ffmpegPath, ...opts });

test('analyzer: genuine 96/24 is real lossless and hi-res', async () => {
  const r = await run('genuine.flac');
  assert.equal(r.verdicts.lossless.title, 'Real lossless');
  assert.equal(r.verdicts.hires.title, 'Genuine hi-res', JSON.stringify(r.edge));
  assert.equal(r.format.sampleRate, 96000);
  assert.equal(r.format.usedBits, 24);
  assert.equal(r.spectrogram.rows, 512);
  assert.ok(r.spectrogram.columns >= 1000, `columns ${r.spectrogram.columns}`);
  assert.equal(r.spectrogram.image.length, r.spectrogram.rows * r.spectrogram.columns);
  assert.equal(r.spectrum.length, 512);
  assert.ok(Math.abs(r.format.duration - 4) < 0.05);
});

test('analyzer: 44.1 kHz upsampled to 96 kHz: lossless, but not hi-res', async () => {
  const r = await run('upsampled.flac');
  assert.equal(r.verdicts.lossless.title, 'Real lossless');
  assert.match(r.verdicts.lossless.notes.join(' '), /upsampled from CD quality/);
  assert.equal(r.verdicts.hires.title, 'Upsampled, not real hi-res', JSON.stringify(r.edge));
  // ffmpeg's default resampler fades over ~4 kHz, so the measured edge lands anywhere up to
  // ~25.5 kHz; the verdict treats any wall ≤ 26 kHz as a 44.1/48 kHz origin.
  assert.ok(r.edge.cutoff > 19000 && r.edge.cutoff <= 26000, `cutoff ${r.edge.cutoff}`);
});

test('analyzer: a FLAC made from a 128k MP3 is caught, with its bitrate', async () => {
  const r = await run('from-mp3.flac');
  assert.equal(r.verdicts.lossless.title, 'Made from an MP3, not real lossless', JSON.stringify(r.edge));
  assert.match(r.verdicts.lossless.notes[0], /about 128 kbps/);
  assert.equal(r.verdicts.hires.title, r.verdicts.lossless.title);
  assert.ok(r.edge.cutoff > 15000 && r.edge.cutoff < 18000, `cutoff ${r.edge.cutoff}`);
});

test('analyzer: 16-bit audio padded into a 24-bit file', async () => {
  const r = await run('padded.flac');
  assert.equal(r.format.bits, 24);
  assert.equal(r.format.usedBits, 16);
  assert.equal(r.verdicts.hires.tone, 'warn');
  assert.equal(r.verdicts.lossless.title, 'Real lossless');
  assert.match(r.verdicts.lossless.notes.join(' '), /only 16 bits carry sound/);
});

test('analyzer: plain CD quality and a lossy file', async () => {
  const cd = await run('cd.flac');
  assert.equal(cd.verdicts.lossless.title, 'Real lossless', JSON.stringify(cd.edge));
  assert.equal(cd.verdicts.hires.title, 'CD quality, not hi-res');
  const mp3 = await run('lossy.mp3');
  assert.equal(mp3.format.lossless, false);
  assert.equal(mp3.format.usedBits, null);
  assert.equal(mp3.verdicts.lossless.title, 'Lossy file (MP3), not lossless');
});

test('analyzer: a 24-bit FLAC made from a 320k MP3 is flagged, not called "real 24-bit"', async () => {
  const r = await run('from-320.flac');
  assert.equal(r.format.bits, 24);
  assert.equal(r.verdicts.lossless.title, 'Possibly made from a high-bitrate MP3', JSON.stringify(r.edge));
  assert.equal(r.verdicts.hires.title, 'Possibly made from a high-bitrate MP3');
});

test('analyzer: progress and cancel', async () => {
  const fracs = [];
  await run('genuine.flac', { onProgress: (f) => fracs.push(f) });
  assert.equal(fracs.at(-1), 1);
  const ac = new AbortController();
  const p = run('genuine.flac', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /Cancelled/);
});

test('analyzer: a 6:40 track decodes and analyses (the crash of 2026-10-01)', async () => {
  const r = await run('long.flac');
  assert.ok(Math.abs(r.format.duration - 400) < 0.1);
  assert.ok(r.spectrogram.columns >= 1024);
});

test('analyzer: an error while processing rejects this analysis instead of escaping', async () => {
  const push = SpectrogramBuilder.prototype.push;
  let calls = 0;
  SpectrogramBuilder.prototype.push = function (samples) {
    if (++calls === 3) throw new RangeError('offset is out of bounds');
    return push.call(this, samples);
  };
  try {
    await assert.rejects(run('cd.flac'), /Couldn’t analyse this file \(offset is out of bounds\)/);
  } finally {
    SpectrogramBuilder.prototype.push = push;
  }
  assert.equal((await run('cd.flac')).verdicts.lossless.title, 'Real lossless', 'the next analysis works');
});

test('analyzer: tempo and key of a whole file; cancel', async () => {
  const r = await analyzeTempoKey(file('beat.flac'), { ffmpegPath });
  assert.ok(Math.abs(r.bpm - 126.5) <= 0.05, `bpm ${r.bpm}`);
  assert.ok(r.clarity >= 0.5, `clarity ${r.clarity}`);
  assert.equal(r.key.camelot, '8A');
  assert.ok(['likely', 'possible'].includes(r.key.confidence), r.key.confidence);
  assert.equal(r.truncated, false);
  assert.ok(Math.abs(r.seconds - 40) < 0.5);
  const ac = new AbortController();
  const pending = analyzeTempoKey(file('beat.flac'), { ffmpegPath, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(pending, /Cancelled/);
});
