import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSegment, outputRelFor, toKey, isInside } from '../src/engine/names.js';
import { targetSpec, isCompatible, buildPlan } from '../src/engine/plan.js';
import { buildTagPairs } from '../src/engine/tags.js';
import { encodeId3v23 } from '../src/engine/id3.js';

test('sanitizeSegment makes FAT32/Windows-safe names', () => {
  assert.equal(sanitizeSegment('AC:DC - What?'), 'AC_DC - What_');
  assert.equal(sanitizeSegment('a<b>c"d|e*f'), 'a_b_c_d_e_f');
  assert.equal(sanitizeSegment('Trailing dots...'), 'Trailing dots');
  assert.equal(sanitizeSegment('CON'), 'CON_');
  assert.equal(sanitizeSegment('nul.txt'), 'nul_.txt');
  assert.equal(sanitizeSegment('Console'), 'Console');
  assert.equal(sanitizeSegment('...'), '_');
  assert.equal(sanitizeSegment('AC:DC', false), 'AC:DC');
});

test('sanitizeSegment and toKey normalise to NFC', () => {
  const nfd = 'Beyoncé';
  assert.equal(sanitizeSegment(nfd), 'Beyoncé');
  assert.equal(toKey(nfd), 'Beyoncé');
});

test('outputRelFor mirrors folders and swaps extension', () => {
  assert.equal(outputRelFor('Techno/2024/A - B.flac', '.aiff'), 'Techno/2024/A - B.aiff');
  assert.equal(outputRelFor('X:Y/Track?.wav', '.aiff'), 'X_Y/Track_.aiff');
  assert.equal(outputRelFor('A/Same.wav', '.aiff', true, ' (wav)'), 'A/Same (wav).aiff');
});

test('isInside detects nesting both ways', () => {
  assert.ok(isInside('/music', '/music/out'));
  assert.ok(isInside('/music', '/music'));
  assert.ok(!isInside('/music', '/music2'));
  assert.ok(!isInside('/music/out', '/music'));
});

test('targetSpec: family-aware resampling and bit depth', () => {
  const t = (sampleRate, bits, channels = 2) => targetSpec({ sampleRate, bits, channels });
  assert.deepEqual(t(44100, 16), { sampleRate: 44100, bits: 16, channels: 2, resample: false, downmix: false });
  assert.equal(t(48000, 24).sampleRate, 48000);
  assert.equal(t(88200, 24).sampleRate, 44100);
  assert.equal(t(176400, 24).sampleRate, 44100);
  assert.equal(t(96000, 24).sampleRate, 48000);
  assert.equal(t(192000, 24).sampleRate, 48000);
  assert.equal(t(32000, 16).sampleRate, 48000);
  assert.equal(t(22050, 16).sampleRate, 44100);
  assert.equal(t(96000, 24).resample, true);
  assert.equal(t(44100, 32).bits, 24);
  assert.equal(t(44100, 8).bits, 16);
  assert.equal(t(48000, 16, 6).channels, 2);
  assert.equal(t(48000, 16, 6).downmix, true);
  assert.equal(t(44100, 16, 1).channels, 1);
});

test('isCompatible follows CDJ-2000NXS limits', () => {
  assert.ok(isCompatible('.mp3', null));
  assert.ok(isCompatible('.aiff', { container: 'AIFF', sampleRate: 44100, bits: 16 }));
  assert.ok(!isCompatible('.aiff', { container: 'AIFF', sampleRate: 96000, bits: 24 }));
  assert.ok(!isCompatible('.aif', { container: 'AIFF-C', sampleRate: 44100, bits: 16 }));
  assert.ok(isCompatible('.wav', { codec: 'PCM', sampleRate: 48000, bits: 24 }));
  assert.ok(!isCompatible('.wav', { codec: 'IEEE_FLOAT', sampleRate: 44100, bits: 32 }));
  assert.ok(!isCompatible('.wav', { codec: 'non-PCM (65534)', sampleRate: 44100, bits: 24 }));
  assert.ok(isCompatible('.m4a', { codec: 'MPEG-4/AAC' }));
  assert.ok(!isCompatible('.m4a', { codec: 'ALAC' }));
  assert.ok(!isCompatible('.flac', { sampleRate: 44100, bits: 16 }));
  assert.ok(!isCompatible('.ogg', {}));
});

const probe = { sampleRate: 44100, bits: 16, channels: 2, duration: 10 };
const file = (key) => ({ key, abs: `/lib/${key}`, ext: key.slice(key.lastIndexOf('.')).toLowerCase(), size: 1, mtimeMs: 1 });

test('buildPlan: actions, collisions, stable names', () => {
  const files = [file('A/Same.flac'), file('A/Same.wav'), file('A/song.mp3'), file('A/x.flac'), file('A/y.ogg')];
  const records = {
    'A/Same.flac': { probe }, 'A/Same.wav': { probe: { ...probe, codec: 'PCM' } },
    'A/song.mp3': {}, 'A/x.flac': { probeError: 'bad' }, 'A/y.ogg': { probe },
  };
  const plan = Object.fromEntries(buildPlan(files, { formats: ['flac', 'wav'], safeNames: true, records }).map((e) => [e.key, e]));
  assert.equal(plan['A/Same.flac'].outRel, 'A/Same.aiff');
  assert.equal(plan['A/Same.wav'].outRel, 'A/Same (wav).aiff');
  assert.equal(plan['A/Same.wav'].renamed, true);
  assert.equal(plan['A/song.mp3'].action, 'compatible');
  assert.equal(plan['A/x.flac'].action, 'unreadable');
  assert.equal(plan['A/y.ogg'].action, 'unsupported');

  // WAV unticked: the compatible 16/44.1 PCM WAV is skipped, not converted.
  const flacOnly = buildPlan(files, { formats: ['flac'], safeNames: true, records });
  assert.equal(flacOnly.find((e) => e.key === 'A/Same.wav').action, 'compatible');

  // A WAV that already owns "Same.aiff" keeps it when a FLAC of the same name shows up later.
  const owned = { ...records, 'A/Same.wav': { ...records['A/Same.wav'], done: { outRel: 'A/Same.aiff' } } };
  const stable = Object.fromEntries(buildPlan(files, { formats: ['flac', 'wav'], safeNames: true, records: owned }).map((e) => [e.key, e]));
  assert.equal(stable['A/Same.wav'].outRel, 'A/Same.aiff');
  assert.equal(stable['A/Same.flac'].outRel, 'A/Same (flac).aiff');
});

test('buildPlan: .m4a converts as ALAC and plays as AAC', () => {
  const files = [file('A/lossless.m4a'), file('A/lossy.m4a'), file('A/raw.alac'), file('A/Same.flac'), file('A/Same.m4a')];
  const alac = { ...probe, codec: 'ALAC', sampleRate: 96000, bits: 24 };
  const records = {
    'A/lossless.m4a': { probe: alac }, 'A/lossy.m4a': { probe: { ...probe, codec: 'MPEG-4/AAC' } },
    'A/raw.alac': { probe: alac }, 'A/Same.flac': { probe }, 'A/Same.m4a': { probe: alac },
  };
  const plan = Object.fromEntries(buildPlan(files, { formats: ['flac', 'alac'], safeNames: true, records }).map((e) => [e.key, e]));
  assert.equal(plan['A/lossless.m4a'].action, 'convert');
  assert.equal(plan['A/lossless.m4a'].formatId, 'alac');
  assert.deepEqual([plan['A/lossless.m4a'].target.sampleRate, plan['A/lossless.m4a'].target.bits], [48000, 24]);
  assert.equal(plan['A/lossy.m4a'].action, 'compatible');
  assert.equal(plan['A/lossy.m4a'].formatId, null);
  assert.equal(plan['A/raw.alac'].action, 'convert');
  assert.equal(plan['A/Same.m4a'].outRel, 'A/Same (m4a).aiff'); // FLAC comes first in the registry

  // ALAC unticked: the CDJ can't play it, so it's unsupported, not compatible.
  const flacOnly = Object.fromEntries(buildPlan(files, { formats: ['flac'], safeNames: true, records }).map((e) => [e.key, e]));
  assert.equal(flacOnly['A/lossless.m4a'].action, 'unsupported');
  assert.equal(flacOnly['A/lossy.m4a'].action, 'compatible');
});

test('buildPlan: name clashes are case-insensitive', () => {
  const files = [file('A/track.flac'), file('A/Track.flac')];
  const records = { 'A/track.flac': { probe }, 'A/Track.flac': { probe } };
  const outs = buildPlan(files, { formats: ['flac'], safeNames: true, records }).map((e) => e.outRel.toLowerCase());
  assert.equal(new Set(outs).size, 2);
});

test('buildTagPairs maps DJ-relevant tags to real ID3 frames', () => {
  const pairs = Object.fromEntries(buildTagPairs(
    {
      title: 'T', artist: 'A', album: 'Al', genre: ['Techno', 'Acid'], date: '2024-05-03', track: { no: 1, of: 9 },
      disk: { no: null }, bpm: 127.6, label: ['L'], comment: [{ text: 'Energy 7' }], isrc: ['X1'], catalognumber: ['CAT1'],
    },
    { vorbis: [{ id: 'INITIALKEY', value: '8A' }, { id: 'MIXARTIST', value: 'R' }] },
  ));
  assert.deepEqual(pairs, {
    TIT2: 'T', TPE1: 'A', TALB: 'Al', TCON: 'Techno, Acid', TYER: '2024', TRCK: '1/9', TBPM: '128',
    TKEY: '8A', TPUB: 'L', TSRC: 'X1', TPE4: 'R', COMM: 'Energy 7', CATALOGNUMBER: 'CAT1',
  });
  // ALAC/AAC: the key is an iTunes freeform atom (Mixed In Key, rekordbox)
  const m4a = Object.fromEntries(buildTagPairs({ bpm: 124 }, { iTunes: [{ id: '----:com.apple.iTunes:initialkey', value: '5A' }] }));
  assert.deepEqual(m4a, { TBPM: '124', TKEY: '5A' });
});

test('encodeId3v23 writes a valid v2.3 header and frames', () => {
  const buf = encodeId3v23([['TIT2', 'Hi'], ['TPE1', 'Ñandú 東京'], ['COMM', 'c'], ['CATALOGNUMBER', 'X']], { format: 'image/png', data: new Uint8Array([1, 2, 3]) });
  assert.equal(buf.toString('latin1', 0, 3), 'ID3');
  assert.equal(buf[3], 3);
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  assert.equal(size, buf.length - 10);
  const body = buf.toString('latin1');
  for (const id of ['TIT2', 'TPE1', 'COMM', 'TXXX', 'APIC']) assert.ok(body.includes(id), id);
});
