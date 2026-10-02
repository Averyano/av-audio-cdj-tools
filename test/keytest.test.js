import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import {
  toCamelot, toSeconds, parseRekordboxText, matchTracks, keyScore, bpmKind, encodeFeatures, decodeFeatures, norm,
} from '../tools/keytest-lib.js';

const run = promisify(execFile);
const TOOL = path.resolve('tools/keytest.js');

// rekordbox's text export: UTF-16 LE with a BOM, tab-separated (header as exported 2026-10-01).
const HEAD = '#\tArtwork\tTrack Title\tBPM\tArtist\tAlbum\tGenre\tMy Tag\tRating\tTime\tKey\tDate Added';
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

test('keytest: keys in Camelot or note names; times', () => {
  assert.equal(toCamelot('9A'), '9A');
  assert.equal(toCamelot('12b'), '12B');
  assert.equal(toCamelot('Am'), '8A');
  assert.equal(toCamelot('F#m'), '11A');
  assert.equal(toCamelot('Dbm'), '12A');
  assert.equal(toCamelot('A♭m'), '1A');
  assert.equal(toCamelot('C'), '8B');
  assert.equal(toCamelot('Bb'), '6B');
  assert.equal(toCamelot(''), null);
  assert.equal(toSeconds('09:15'), 555);
  assert.equal(toSeconds('1:02:03'), 3723);
});

test('keytest: parse a rekordbox text export', () => {
  const rows = parseRekordboxText(utf16(`${HEAD}\r\n1\t\tCalipso\t125.00\tLuigi Tozzi\tCalipso\tTechno\t\t     \t09:15\t9A\t2026-09-27\r\n2\t\tNo Key\t\tSomeone\t\t\t\t\t04:00\t\t\r\n`));
  assert.deepEqual(rows[0], { title: 'Calipso', artist: 'Luigi Tozzi', album: 'Calipso', bpm: 125, key: '9A', seconds: 555 });
  assert.equal(rows[1].bpm, null);
  assert.equal(rows[1].key, null);
  assert.throws(() => parseRekordboxText(Buffer.from('a\tb\n1\t2')), /Track Title/);
});

test('keytest: match rows to files by tags, then title; length breaks ties', () => {
  const rows = [
    { artist: 'Modern Heads', title: 'Beginning', seconds: 305 },
    { artist: 'Modern Heads', title: 'Beginning (Donato Dozzy Remix)', seconds: 400 },
    { artist: 'Other Name', title: 'Ícore', seconds: 448 },
    { artist: 'Nobody', title: 'Missing', seconds: 100 },
  ];
  const files = [
    { path: 'a/01 Beginning.aiff', artist: 'Modern Heads', title: 'Beginning', seconds: 305.4 },
    { path: 'b/03 Beginning (Donato Dozzy Remix).aiff', artist: 'Modern Heads', title: 'Beginning (Donato Dozzy Remix)', seconds: 400.2 },
    { path: 'c/Icore.aiff', artist: 'Claudio PRC & Ness', title: 'Icore', seconds: 448.9 },
    { path: 'd/extra.aiff', artist: 'X', title: 'Beginning', seconds: 120 },
  ];
  const { matched, unmatchedRows, unmatchedFiles } = matchTracks(rows, files);
  assert.deepEqual(matched.map((m) => [m.row.title, m.file.path]), [
    ['Beginning', 'a/01 Beginning.aiff'],
    ['Beginning (Donato Dozzy Remix)', 'b/03 Beginning (Donato Dozzy Remix).aiff'],
    ['Ícore', 'c/Icore.aiff'], // by title alone; accents and case ignored
  ]);
  assert.deepEqual(unmatchedRows.map((r) => r.title), ['Missing']);
  assert.deepEqual(unmatchedFiles.map((f) => f.path), ['d/extra.aiff']);
  assert.equal(norm('Claudio Prc & Ness (Tgp)'), 'claudioprcnesstgp');
});

test('keytest: MIREX key score and BPM kinds', () => {
  assert.deepEqual(keyScore('8A', '8A'), { kind: 'exact', score: 1 });
  assert.equal(keyScore('9A', '8A').kind, 'fifth');
  assert.equal(keyScore('7A', '8A').kind, 'fifth');
  assert.equal(keyScore('8B', '8A').kind, 'relative');
  assert.equal(keyScore('11B', '8A').kind, 'parallel'); // A major for A minor
  assert.equal(keyScore('8A', '11B').kind, 'parallel');
  assert.equal(keyScore('2A', '8A').kind, 'other');
  assert.equal(keyScore(null, '8A').kind, 'none');
  assert.equal(bpmKind(120.05, 120), 'exact');
  assert.equal(bpmKind(120.3, 120), 'close');
  assert.equal(bpmKind(240, 120), 'double');
  assert.equal(bpmKind(60.1, 120), 'half');
  assert.equal(bpmKind(80, 120), '2:3');
  assert.equal(bpmKind(166.7, 125), '4:3'); // dense 16th hats outvoting the kick
  assert.equal(bpmKind(149, 130), 'wrong');
});

test('keytest: features round-trip, holes as NaN', () => {
  const env = Float64Array.from([0.5, 0, 1.25, 2]);
  const valid = Uint8Array.from([1, 0, 1, 1]);
  const windows = [Float64Array.from({ length: 120 }, (_, i) => i), Float64Array.from({ length: 120 }, (_, i) => 120 - i)];
  const back = decodeFeatures(encodeFeatures({ env, valid, windows }), env.length);
  assert.deepEqual([...back.env], [0.5, 0, 1.25, 2]);
  assert.deepEqual([...back.valid], [1, 0, 1, 1]);
  assert.equal(back.windows.length, 2);
  assert.equal(back.windows[1][0], 120);
});

test('keytest: scan, resume and report on a small library', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audioconverter-keytest-'));
  try {
    const lib = path.join(dir, 'Contents');
    await fs.mkdir(path.join(lib, 'Artist'), { recursive: true });
    // 24 s each: a 125 BPM kick under an A minor (8A) or C major (8B) chord, tagged like rekordbox exports.
    const tracks = [['One', 'A minor', '220|261.63|329.63', '8A'], ['Two', 'C major', '261.63|329.63|392', '8B']];
    for (const [title, , freqs] of tracks) {
      const tone = freqs.split('|').map((f) => `0.15*sin(2*PI*${f}*t)`).join('+');
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `aevalsrc=${tone}+0.8*exp(-30*mod(t\\,0.48))*sin(2*PI*50*t)+0.002*sin(2*PI*997*t):s=44100:d=24`,
        '-metadata', 'artist=Artist', '-metadata', `title=${title}`, path.join(lib, 'Artist', `${title}.flac`)]);
    }
    const list = path.join(dir, 'list.txt');
    await fs.writeFile(list, utf16(`${HEAD}\r\n${tracks.map(([title, , , key], i) => `${i + 1}\t\t${title}\t125.00\tArtist\t\tTechno\t\t\t00:24\t${key}\t`).join('\r\n')}\r\n`));
    const out = path.join(dir, 'eval');
    const scan = (...extra) => run(process.execPath, [TOOL, 'scan', '--list', list, '--library', lib, '--out', out, '--workers', '2', ...extra]);

    const first = await scan('--limit', '1');
    assert.match(first.stdout, /Matched 2 tracks/);
    assert.match(first.stdout, /1 to scan now/);
    const second = await scan();
    assert.match(second.stdout, /1 done before.*1 to scan now/s, 'continues where it stopped');
    const done = (await fs.readFile(path.join(out, 'tracks.ndjson'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(done.length, 2);
    for (const t of done) {
      assert.ok(Math.abs(t.result.bpm - 125) <= 0.5, `bpm ${t.result.bpm}`);
      assert.equal(t.windows, 3); // 24 s in 10 s windows
      assert.ok((await fs.stat(path.join(out, 'features', `${t.id}.bin`))).size > 0);
    }
    assert.match((await scan()).stdout, /Nothing left to scan/);

    const rep = await run(process.execPath, [TOOL, 'report', '--out', out]);
    assert.match(rep.stdout, /Library check — 2 tracks/);
    assert.match(rep.stdout, /krumhansl/);
    assert.ok((await fs.readFile(path.join(out, 'results.csv'), 'utf8')).split('\n').length === 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
