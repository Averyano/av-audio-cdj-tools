import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { Engine } from '../src/engine/engine.js';
import { locateFfmpeg, checkFfmpeg } from '../src/engine/ffmpeg.js';
import { makeLibrary, FIXTURES } from './fixtures.js';

let tmp;
let lib;
let out;
let engine;
const opts = () => ({ inputRoot: lib, outputRoot: out, formats: ['flac', 'wav', 'alac'], safeNames: true, workers: 4 });
const outPath = (rel) => path.join(out, ...rel.split('/'));
const exists = (p) => fs.stat(p).then(() => true, () => false);

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audioconverter-test-'));
  lib = path.join(tmp, 'library');
  out = path.join(tmp, 'output');
  await fs.mkdir(lib);
  const ff = await locateFfmpeg();
  await makeLibrary(lib, ff.path);
  engine = new Engine({ dataDir: path.join(tmp, 'data') });
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('scan counts the library without writing output', async () => {
  const s = await engine.scan(opts());
  assert.equal(s.counts.audio, 13); // junk "._" file and cover.jpg are not audio
  assert.equal(s.counts.pending, 10);
  assert.equal(s.counts.compatible, 2); // mp3, AAC .m4a
  assert.equal(s.counts.unreadable, 1); // broken.flac
  assert.equal(s.counts.hires, 3);
  assert.ok(s.warnings.some((w) => w.code === 'renamed'));
  assert.equal(await exists(out), false);
});

test('convert writes CDJ-safe AIFF with tags and artwork', async () => {
  const r = await engine.convert(opts());
  assert.equal(r.lastRun.converted, 10);
  assert.equal(r.lastRun.failed, 0);
  assert.deepEqual(r.failures, []);

  const tagged = await parseFile(outPath('Techno/2024/Artist - Track One.aiff'));
  assert.equal(tagged.format.container, 'AIFF'); // plain AIFF, not AIFF-C
  assert.equal(tagged.format.sampleRate, 44100);
  assert.equal(tagged.format.bitsPerSample, 16);
  assert.equal(tagged.common.title, 'Track One');
  assert.equal(tagged.common.artist, 'Àrtist Ñame');
  assert.equal(tagged.common.bpm, 128);
  assert.equal(tagged.common.key, '8A');
  assert.deepEqual(tagged.common.label, ['Test Label']);
  assert.equal(tagged.common.comment?.[0]?.text, 'Energy 7');
  assert.equal(tagged.common.year, 2024);
  assert.equal(tagged.common.picture?.[0]?.format, 'image/png');
  assert.ok(tagged.format.tagTypes.includes('ID3v2.3'));

  const spec = async (rel) => {
    const { format } = await parseFile(outPath(rel));
    return [format.sampleRate, format.bitsPerSample, format.numberOfChannels];
  };
  assert.deepEqual(await spec('Techno/2024/HiRes 96k.aiff'), [48000, 24, 2]);
  assert.deepEqual(await spec('House/Deep/Track 88k.aiff'), [44100, 24, 2]);
  assert.deepEqual(await spec('House/Deep/Wave 24.aiff'), [48000, 24, 2]);
  assert.deepEqual(await spec('House/Float 32.aiff'), [44100, 24, 2]);
  assert.deepEqual(await spec('Multi/Six Channel.aiff'), [48000, 16, 2]);
  assert.deepEqual(await spec('Apple/Hi-Res ALAC.aiff'), [48000, 24, 2]);
  const alac = await parseFile(outPath('Apple/Hi-Res ALAC.aiff'));
  assert.equal(alac.common.title, 'Apple Track');
  assert.equal(alac.common.artist, 'Àpple');
  assert.equal(alac.common.picture?.[0]?.format, 'image/png');
  assert.equal(await exists(outPath('Apple/Lossy.aiff')), false); // AAC plays as it is
  assert.ok(await exists(outPath('Clash/Same.aiff')));
  assert.ok(await exists(outPath('Clash/Same (wav).aiff')));
  const weird = process.platform === 'win32' ? 'Ünïcödé Földer/Tëst What.aiff' : 'Ünïcödé Földer/Tëst_ What_.aiff';
  assert.ok(await exists(outPath(weird)));

  // Only folders that received tracks are created; nothing but .aiff is written.
  assert.equal(await exists(outPath('Other')), false);
  const all = await fs.readdir(out, { recursive: true });
  assert.ok(all.every((f) => !f.endsWith('.part')));
});

test('second run converts nothing', async () => {
  const r = await engine.convert(opts());
  assert.equal(r.lastRun.pending, 0);
  assert.equal(r.counts.upToDate, 10);
});

test('changed source is reconverted, deleted source leaves output alone', async () => {
  // Any mtime change counts; use the past so the fresh output stays newer than its source.
  const earlier = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(lib, ...FIXTURES.hires96.split('/')), earlier, earlier);
  await fs.rm(path.join(lib, ...FIXTURES.wav24.split('/')));

  const r = await engine.convert(opts());
  assert.equal(r.lastRun.converted, 1);
  assert.equal(r.counts.missing, 1);
  assert.ok(await exists(outPath('House/Deep/Wave 24.aiff')));
});

test('lost manifest self-heals from existing outputs', async () => {
  await fs.rm(path.join(tmp, 'data'), { recursive: true, force: true });
  const s = await new Engine({ dataDir: path.join(tmp, 'data') }).scan(opts());
  assert.equal(s.counts.pending, 0);
});

test('ffmpeg: a chosen binary is checked, and a broken one falls back to the bundled copy', async () => {
  const bundled = await locateFfmpeg();
  assert.equal(bundled.source, 'bundled');
  assert.deepEqual(await locateFfmpeg(bundled.path), { ...bundled, source: 'custom' });
  assert.equal((await locateFfmpeg(path.join(tmp, 'gone', 'ffmpeg'))).source, 'bundled');
  assert.equal(await checkFfmpeg(process.execPath), null, 'node runs, but is not ffmpeg');
  assert.equal(await checkFfmpeg(path.join(tmp, 'gone', 'ffmpeg')), null);

  const e = new Engine({ dataDir: path.join(tmp, 'data-ff') });
  assert.equal((await e.ffmpeg()).source, 'bundled');
  e.setFfmpegPath(bundled.path); // drops the cached lookup
  assert.equal((await e.ffmpeg()).source, 'custom');
});

test('rejects nested or missing folders', async () => {
  await assert.rejects(engine.scan({ ...opts(), outputRoot: path.join(lib, 'converted') }), /separate folders/);
  await assert.rejects(engine.scan({ ...opts(), inputRoot: path.join(tmp, 'nope') }), /not found/);
  await assert.rejects(engine.scan({ ...opts(), formats: [] }), /at least one format/);
});

test('cancel stops a run and leaves no partial files', async () => {
  const lib2 = path.join(tmp, 'library2');
  const out2 = path.join(tmp, 'output2');
  await fs.mkdir(lib2);
  const ff = await locateFfmpeg();
  await makeLibrary(lib2, ff.path);
  const e = new Engine({ dataDir: path.join(tmp, 'data2') });
  // Cancel once, on the first convert event: mid-way through the first ffmpeg job. Waiting for
  // "converted >= 1" raced the progress throttle (under CPU load the run could finish first), and
  // a listener left attached would cancel the resume run below too.
  const cancelOnce = (p) => {
    if (p.phase !== 'convert') return;
    e.off('progress', cancelOnce);
    e.cancel();
  };
  e.on('progress', cancelOnce);
  const r = await e.convert({ inputRoot: lib2, outputRoot: out2, formats: ['flac', 'wav'], workers: 1 });
  assert.equal(r.lastRun.cancelled, true);
  assert.ok(r.lastRun.converted < 9);
  const all = await fs.readdir(out2, { recursive: true });
  assert.ok(all.every((f) => !f.endsWith('.part')));

  // Resuming picks up exactly where it stopped.
  const again = await e.convert({ inputRoot: lib2, outputRoot: out2, formats: ['flac', 'wav'], workers: 4 });
  assert.equal(again.lastRun.converted, 9 - r.lastRun.converted);
});
