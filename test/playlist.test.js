import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from '../src/engine/engine.js';
import { locateFfmpeg } from '../src/engine/ffmpeg.js';
import { parseM3u, buildM3u, playlistFileName, resolveLocation, resolveFile, findMissingInFolder } from '../src/engine/playlists.js';
import { walk } from '../src/engine/walk.js';
import { outputRelFor } from '../src/engine/names.js';
import { makeLibrary, FIXTURES } from './fixtures.js';

let tmp;
let lib;
let out;
let engine;
const src = (rel) => path.join(lib, ...rel.split('/'));
const conv = (rel) => path.join(out, ...rel.split('/'));

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audioconverter-playlist-'));
  lib = path.join(tmp, 'library');
  out = path.join(tmp, 'output');
  await fs.mkdir(lib);
  await makeLibrary(lib, (await locateFfmpeg()).path);
  engine = new Engine({ dataDir: path.join(tmp, 'data') });
  const r = await engine.convert({ inputRoot: lib, outputRoot: out, formats: ['flac', 'wav', 'alac'], workers: 4 });
  assert.equal(r.lastRun.failed, 0);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('parseM3u keeps header, per-track directives and newline style', () => {
  const p = parseM3u('\uFEFF#EXTM3U\r\n#PLAYLIST:Friday\r\n#EXTINF:120,A - B\r\n/x/a.flac\r\n\r\n# comment\r\nb.wav\r\n');
  assert.deepEqual(p.header, ['#EXTM3U', '#PLAYLIST:Friday']);
  assert.equal(p.newline, '\r\n');
  assert.deepEqual(p.entries, [
    { directives: ['#EXTINF:120,A - B'], location: '/x/a.flac' },
    { directives: ['# comment'], location: 'b.wav' },
  ]);
  const text = buildM3u(p, [{ ...p.entries[0], target: '/y/a.aiff' }, { ...p.entries[1], target: null }]);
  assert.equal(text, '#EXTM3U\r\n#PLAYLIST:Friday\r\n#EXTINF:120,A - B\r\n/y/a.aiff\r\n');
});

test('playlistFileName and resolveLocation', () => {
  assert.equal(playlistFileName('/p/Friday Set.m3u', 'av-'), 'av-Friday Set.m3u8');
  assert.equal(playlistFileName('/p/x.m3u8', 'a:b/'), 'abx.m3u8');
  assert.equal(resolveLocation('http://example.com/a.mp3', '/p'), null);
  assert.equal(resolveLocation('sub/a.flac', path.resolve('/p')), path.resolve('/p', 'sub/a.flac'));
});

test('matches entries to converted files and writes a relinked playlist', async () => {
  const lists = path.join(tmp, 'playlists');
  await fs.mkdir(lists);
  const playlist = path.join(lists, 'Friday Set.m3u8');
  const foreign = `C:\\DJ\\Music\\${FIXTURES.hires88.split('/').join('\\')}`; // written on another machine
  const lines = [
    '#EXTM3U',
    '#EXTINF:2,Artist Ñame - Track One', src(FIXTURES.tagged),             // absolute path in the library
    pathToFileURL(src(FIXTURES.hires96)).href,                             // file:// URL
    path.relative(lists, src(FIXTURES.wavFloat)),                          // relative to the playlist
    src(FIXTURES.weird),                                                   // sanitised output name
    src(FIXTURES.clashWav),                                                // collision suffix " (wav)"
    foreign,                                                               // foreign path → matched by path tail
    src(FIXTURES.mp3),                                                     // already playable → original kept
    src(FIXTURES.alac),                                                    // .m4a with ALAC → converted
    src(FIXTURES.aac),                                                     // .m4a with AAC → original kept
    src(FIXTURES.broken),                                                  // in library but unreadable
    path.join(tmp, 'nowhere', 'ghost.flac'),                               // doesn't exist
  ];
  await fs.writeFile(playlist, `${lines.join('\n')}\n`);

  const m = await engine.matchPlaylist({ playlistPath: playlist, inputRoot: lib, outputRoot: out, convertedRoot: out, safeNames: true });
  const by = m.entries.map((e) => [e.status, e.target, e.reason ?? null]);
  assert.deepEqual(by, [
    ['found', conv('Techno/2024/Artist - Track One.aiff'), null],
    ['found', conv('Techno/2024/HiRes 96k.aiff'), null],
    ['found', conv('House/Float 32.aiff'), null],
    ['found', conv(outputRelFor(FIXTURES.weird, '.aiff')), null],
    ['found', conv('Clash/Same (wav).aiff'), null],
    ['found', conv('House/Deep/Track 88k.aiff'), null],
    ['original', src(FIXTURES.mp3), null],
    ['found', conv('Apple/Hi-Res ALAC.aiff'), null],
    ['original', src(FIXTURES.aac), null],
    ['missing', null, 'unreadable'],
    ['missing', null, 'not-found'],
  ]);
  assert.deepEqual(m.counts, { total: 11, found: 7, original: 2, manual: 0, missing: 2 });
  assert.deepEqual(m.entries[0].directives, ['#EXTINF:2,Artist Ñame - Track One']);

  const text = buildM3u(m.parsed, m.entries);
  const written = text.trim().split('\n');
  assert.equal(written[0], '#EXTM3U');
  assert.equal(written[1], '#EXTINF:2,Artist Ñame - Track One');
  assert.equal(written[2], conv('Techno/2024/Artist - Track One.aiff'));
  assert.equal(written.length, 1 + 1 + 9); // header + EXTINF + 9 tracks (2 missing left out)
});

test('a different converted folder with the same structure is used', async () => {
  const copy = path.join(tmp, 'usb', 'DJ');
  await fs.cp(out, copy, { recursive: true });
  const playlist = path.join(tmp, 'one.m3u8');
  await fs.writeFile(playlist, `${src(FIXTURES.tagged)}\n`);
  const m = await engine.matchPlaylist({ playlistPath: playlist, inputRoot: lib, outputRoot: out, convertedRoot: copy });
  assert.equal(m.entries[0].target, path.join(copy, 'Techno', '2024', 'Artist - Track One.aiff'));
});

test('without a known library, the converted folder is matched by path tail', async () => {
  const playlist = path.join(tmp, 'old.m3u8');
  await fs.writeFile(playlist, [
    '/Volumes/Old Drive/Music/Techno/2024/Artist - Track One.flac',
    'D:\\Music\\Ünïcödé Földer\\Tëst What.flac',
  ].join('\n'));
  const m = await engine.matchPlaylist({ playlistPath: playlist, convertedRoot: out });
  assert.equal(m.entries[0].target, conv('Techno/2024/Artist - Track One.aiff'));
  if (process.platform !== 'win32') assert.equal(m.entries[1].status, 'missing'); // "Tëst_ What_" ≠ "Tëst What"
});

test('missing converted folder is rejected', async () => {
  await assert.rejects(
    engine.matchPlaylist({ playlistPath: path.join(tmp, 'one.m3u8'), inputRoot: lib, outputRoot: out, convertedRoot: path.join(tmp, 'nope') }),
    /Converted folder not found/,
  );
});

test('a picked file: playable as-is, original → its converted AIFF, unconverted → null', async () => {
  const playlist = path.join(tmp, 'pick.m3u8');
  await fs.writeFile(playlist, '/Volumes/Gone/x.flac\n');
  const m = await engine.matchPlaylist({ playlistPath: playlist, inputRoot: lib, outputRoot: out, convertedRoot: out });
  assert.equal(await resolveFile(m, src(FIXTURES.tagged)), conv('Techno/2024/Artist - Track One.aiff'));
  assert.equal(await resolveFile(m, src(FIXTURES.mp3)), src(FIXTURES.mp3));
  assert.equal(await resolveFile(m, conv('House/Float 32.aiff')), conv('House/Float 32.aiff'));
  const loose = path.join(tmp, 'elsewhere', 'Brand New.flac');
  await fs.mkdir(path.dirname(loose), { recursive: true });
  await fs.copyFile(src(FIXTURES.hires96), loose);
  assert.equal(await resolveFile(m, loose), null);
});

test('find in folder: top level only, or recursive; prefers ready-to-play formats', async () => {
  const crate = path.join(tmp, 'crate');
  await fs.mkdir(path.join(crate, 'deep'), { recursive: true });
  await fs.copyFile(conv('House/Float 32.aiff'), path.join(crate, 'Ghost Track.aiff'));
  await fs.copyFile(src(FIXTURES.hires96), path.join(crate, 'Ghost Track.flac')); // same track, worse format
  await fs.copyFile(src(FIXTURES.mp3), path.join(crate, 'deep', 'Other Tune.mp3'));
  const playlist = path.join(tmp, 'gone.m3u8');
  await fs.writeFile(playlist, '/Volumes/Gone/Ghost Track.flac\n/Volumes/Gone/Other Tune.flac\n/Volumes/Gone/Nope.flac\n');
  const opts = { playlistPath: playlist, inputRoot: lib, outputRoot: out, convertedRoot: out };

  const flat = await engine.matchPlaylist(opts);
  const r1 = await findMissingInFolder(flat, crate, { recursive: false });
  assert.equal(r1.resolved, 1);
  assert.deepEqual(flat.entries.map((e) => [e.status, e.via ?? null, e.targetName]), [
    ['manual', 'folder', 'Ghost Track.aiff'],
    ['missing', null, null],
    ['missing', null, null],
  ]);

  const deep = await engine.matchPlaylist(opts);
  const r2 = await findMissingInFolder(deep, crate, { recursive: true });
  assert.equal(r2.resolved, 2);
  assert.equal(r2.remaining, 1);
  assert.equal(deep.entries[1].target, path.join(crate, 'deep', 'Other Tune.mp3'));
  assert.deepEqual(deep.counts, { total: 3, found: 0, original: 0, manual: 2, missing: 1 });
});

test('recursive search refuses the whole disk and the home folder; walk stops at maxDirs', async () => {
  const playlist = path.join(tmp, 'gone.m3u8');
  const m = await engine.matchPlaylist({ playlistPath: playlist, inputRoot: lib, outputRoot: out, convertedRoot: out });
  await assert.rejects(findMissingInFolder(m, path.parse(tmp).root, { recursive: true }), /too broad/);
  await assert.rejects(findMissingInFolder(m, os.homedir(), { recursive: true }), /too broad/);
  await assert.rejects(walk(lib, { maxDirs: 1 }), (err) => err.code === 'TOO_MANY_DIRS');
});
