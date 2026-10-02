import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest } from './manifest.js';
import { walk } from './walk.js';
import { probeFile } from './probe.js';
import { formatIdFor, isCompatible } from './plan.js';
import { OUTPUT_EXT } from './constants.js';
import { toKey, keyToNative, outputRelFor, sanitizeSegment, isInside } from './names.js';

// Playlist relinking: map every entry of an .m3u/.m3u8 to its converted AIFF
// (or keep it when the CDJ already plays it) and write a new playlist.

const CONVERTED_EXTS = new Set(['.aiff', '.aif']);

/** Splits a playlist into header lines and entries (a location + the directives above it). */
export function parseM3u(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const header = [];
  const entries = [];
  let directives = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // #EXTM3U / #PLAYLIST before the first track describe the whole playlist.
      if (!entries.length && !directives.length && /^#(EXTM3U|PLAYLIST)\b/i.test(line)) header.push(line);
      else directives.push(line);
      continue;
    }
    entries.push({ directives, location: line });
    directives = [];
  }
  return { header, entries, newline };
}

/** Rebuilds a playlist from matched entries; entries without a target are left out. */
export function buildM3u(parsed, entries) {
  const lines = ['#EXTM3U', ...parsed.header.filter((l) => !/^#EXTM3U\b/i.test(l))];
  for (const e of entries) {
    if (!e.target) continue;
    lines.push(...e.directives, e.target);
  }
  return lines.join(parsed.newline) + parsed.newline;
}

export async function readPlaylist(file) {
  const buf = await fs.readFile(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1'); // legacy .m3u in a single-byte encoding
  }
  return parseM3u(text);
}

export async function writePlaylist(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** "av-" + "Friday Set.m3u" → "av-Friday Set.m3u8" */
export function playlistFileName(playlistPath, prefix = '') {
  const stem = path.basename(playlistPath, path.extname(playlistPath));
  return `${cleanPrefix(prefix)}${stem}.m3u8`;
}

export function cleanPrefix(prefix) {
  return String(prefix ?? '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').slice(0, 40);
}

// file:// URLs, absolute paths and paths relative to the playlist file.
// Returns null for things that are not local files (http://…).
export function resolveLocation(location, baseDir) {
  if (/^file:\/\//i.test(location)) {
    try {
      return fileURLToPath(location);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(location)) return null;
  return path.isAbsolute(location) ? path.normalize(location) : path.resolve(baseDir, location);
}

// Path segments of a location, whatever OS wrote it ("C:\DJ\x.flac" or "/Users/…").
function segmentsOf(location, resolved) {
  const s = /^file:\/\//i.test(location) && resolved ? resolved : location;
  return s.split(/[\\/]+/).filter(Boolean).map((p) => p.normalize('NFC'));
}

const stemOf = (name) => name.slice(0, name.length - path.extname(name).length);
const lower = (s) => s.normalize('NFC').toLowerCase();

/**
 * Index of candidate files by lower-cased stem, matched by the longest run of
 * equal trailing path segments. Lets a playlist written on another machine
 * (other drive letter, moved library, Windows vs macOS) still find its tracks.
 */
function buildIndex(items) {
  const byStem = new Map();
  for (const item of items) {
    const stem = lower(stemOf(item.segs[item.segs.length - 1]));
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(item);
  }
  return byStem;
}

function bestMatch(index, segs) {
  const candidates = index.get(lower(stemOf(segs[segs.length - 1]))) ?? [];
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates) {
    let score = 1;
    while (score < c.segs.length && score < segs.length
      && lower(c.segs[c.segs.length - 1 - score]) === lower(segs[segs.length - 1 - score])) score++;
    if (score > bestScore) {
      best = c;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) tie = true;
  }
  if (!best) return { match: null };
  return tie ? { ambiguous: true } : { match: best };
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// What a file is to a playlist: 'source' (a format the converter handles, so it wants its AIFF),
// 'playable' (the CDJ plays it as it is) or 'unsupported'. An .m4a needs its codec for that:
// ALAC is a source, AAC plays.
async function kindOf(abs, ext, probe) {
  if (ext === '.mp3') return 'playable';
  if (formatIdFor(ext, probe)) return 'source';
  try {
    probe ??= await probeFile(abs);
  } catch {
    return 'unsupported';
  }
  if (formatIdFor(ext, probe)) return 'source';
  return isCompatible(ext, probe) ? 'playable' : 'unsupported';
}
const playableAsIs = async (abs, ext, probe) => (await kindOf(abs, ext, probe)) === 'playable';

/**
 * Matches every playlist entry to a converted file.
 *   status 'found'    → target is the converted AIFF
 *   status 'original' → the source is already CDJ-playable (never converted), target = source
 *   status 'missing'  → reason: 'not-converted' | 'unreadable' | 'not-found' | 'ambiguous' | 'unsupported'
 * inputRoot/outputRoot identify the manifest; convertedRoot is where outputs are looked up
 * (normally the same as outputRoot).
 */
export async function matchPlaylist({ playlistPath, inputRoot, outputRoot, convertedRoot, safeNames = true, dataDir }) {
  const parsed = await readPlaylist(playlistPath);
  const baseDir = path.dirname(playlistPath);
  const records = inputRoot && outputRoot ? (await Manifest.load(dataDir, inputRoot, outputRoot)).files : {};
  const inputRoots = inputRoot ? [...new Set([path.resolve(inputRoot), await fs.realpath(inputRoot).catch(() => path.resolve(inputRoot))])] : [];

  const sourceIndex = buildIndex(Object.keys(records).map((key) => ({ key, segs: key.split('/') })));
  const walked = convertedRoot ? await walk(convertedRoot).catch(() => ({ files: [] })) : { files: [] };
  const convertedIndex = buildIndex(walked.files
    .filter((f) => CONVERTED_EXTS.has(f.ext))
    .map((f) => ({ abs: f.abs, segs: f.key.split('/') })));

  // Kept on the match so manual picks and folder searches apply the same rules.
  const context = { records, inputRoots, sourceIndex, convertedIndex, convertedRoot, safeNames };
  const entries = [];
  for (const [index, e] of parsed.entries.entries()) {
    const resolved = resolveLocation(e.location, baseDir);
    const segs = segmentsOf(e.location, resolved);
    const base = { index, directives: e.directives, location: e.location, segs, sourcePath: resolved, sourceName: segs[segs.length - 1] ?? e.location };
    entries.push({ ...base, ...(await matchEntry({ resolved, segs, ...context })) });
  }
  return { playlistPath, convertedRoot, parsed, context, entries, counts: countEntries(entries) };
}

/**
 * What a file the user picked should become in the playlist:
 *   - the file itself when the CDJ can play it (AIFF/MP3/…), so an explicit pick is honoured;
 *   - otherwise its converted AIFF (e.g. picking the original FLAC);
 *   - otherwise null (e.g. a FLAC that was never converted).
 */
export async function resolveFile(match, file) {
  const ext = path.extname(file).toLowerCase();
  if (await playableAsIs(file, ext)) return file;
  const r = await matchEntry({ resolved: file, segs: segmentsOf(file, file), ...match.context });
  return r.target ?? null;
}

// Recursive search guard: the whole disk, the home folder (or anything above it)
// and system folders would mean walking hundreds of thousands of folders.
const SYSTEM_DIRS = process.platform === 'win32'
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
  : ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin'];
export const SEARCH_MAX_DIRS = 20000;

export function isTooBroadForRecursive(dir) {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs) return true;
  if (isInside(abs, os.homedir())) return true; // home itself or one of its parents
  if (process.platform === 'darwin' && abs === '/Volumes') return true;
  return SYSTEM_DIRS.some((d) => isInside(d, abs));
}

// Prefer files that need no further work when several formats of one track sit together.
const FORMAT_RANK = { '.aiff': 0, '.aif': 0, '.mp3': 1, '.m4a': 1, '.aac': 1, '.wav': 2 };
const rankOf = (ext) => FORMAT_RANK[ext] ?? 3;

/**
 * Looks for the playlist's missing tracks in `dir` (optionally in every subfolder),
 * matching by file name (raw or sanitised) and path tail. Found tracks become
 * status 'manual' with via 'folder'. Ties are left missing rather than guessed.
 */
export async function findMissingInFolder(match, dir, { recursive = false, signal, onProgress } = {}) {
  if (recursive && isTooBroadForRecursive(dir)) {
    throw new Error('That folder is too broad to search inside every subfolder. Choose a folder closer to your music.');
  }
  let walked;
  try {
    walked = await walk(dir, {
      recursive,
      maxDirs: SEARCH_MAX_DIRS,
      skipNames: ['node_modules'],
      signal,
      onProgress: ({ found, folders }) => onProgress?.({ found, folders }),
    });
  } catch (err) {
    if (err.code === 'TOO_MANY_DIRS') {
      throw new Error(`Stopped after ${SEARCH_MAX_DIRS.toLocaleString('en')} folders. Choose a smaller folder.`);
    }
    throw err;
  }

  const index = buildIndex(walked.files.map((f) => ({ abs: f.abs, ext: f.ext, segs: f.key.split('/') })));
  let resolved = 0;
  for (const e of match.entries) {
    if (e.status !== 'missing') continue;
    const stem = stemOf(e.sourceName);
    const stems = new Set([lower(stem), lower(sanitizeSegment(stem, true))]);
    const candidates = [...stems].flatMap((st) => index.get(st) ?? []);
    const pick = choose(candidates, e.segs);
    if (!pick) continue;
    const target = await resolveFile(match, pick.abs);
    if (!target) continue;
    Object.assign(e, { status: 'manual', via: 'folder', reason: undefined, target, targetName: path.basename(target) });
    resolved++;
  }
  match.counts = countEntries(match.entries);
  return { folder: dir, recursive, filesSearched: walked.files.length, foldersSearched: walked.folders.length + 1, resolved, remaining: match.counts.missing };
}

// Best candidate: longest path-tail match, then the most CDJ-ready format; a tie → none.
function choose(candidates, segs) {
  const scored = [...new Set(candidates)].map((c) => {
    let score = 1;
    while (score < c.segs.length && score < segs.length
      && lower(c.segs[c.segs.length - 1 - score]) === lower(segs[segs.length - 1 - score])) score++;
    return { c, score, rank: rankOf(c.ext) };
  });
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const [best, next] = scored;
  if (next && next.score === best.score && next.rank === best.rank) return null;
  return best.c;
}

async function matchEntry({ resolved, segs, records, inputRoots, sourceIndex, convertedIndex, convertedRoot, safeNames }) {
  const found = (target, status = 'found') => ({ status, target, targetName: path.basename(target) });
  const missing = (reason) => ({ status: 'missing', reason, target: null, targetName: null });
  // A library track without output: unreadable files never convert, the rest just haven't yet.
  const unreadable = (r) => !!r && (!!r.probeError || (!!r.probe && !r.probe.sampleRate));
  const notConverted = (k) => missing(k && unreadable(records[k]) ? 'unreadable' : 'not-converted');
  if (!segs.length) return missing('not-found');

  // 1) Library key: the entry lives inside the input folder, or matches a known track by path tail.
  let key = null;
  let ambiguous = false;
  const root = resolved && inputRoots.find((r) => isInside(r, resolved));
  if (root) key = toKey(path.relative(root, resolved));
  else {
    const m = bestMatch(sourceIndex, segs);
    key = m.match?.key ?? null;
    ambiguous = !!m.ambiguous;
  }

  // 2) Known track → its converted file, from the manifest or the naming rules.
  if (key && convertedRoot) {
    const ext = path.extname(key).toLowerCase();
    const candidates = [
      records[key]?.done?.outRel,
      outputRelFor(key, OUTPUT_EXT, safeNames),
      outputRelFor(key, OUTPUT_EXT, !safeNames),
      outputRelFor(key, OUTPUT_EXT, safeNames, ` (${ext.slice(1)})`),
    ].filter(Boolean);
    for (const rel of new Set(candidates)) {
      const target = path.join(convertedRoot, keyToNative(rel));
      if (await isFile(target)) return found(target);
    }
    const src = inputRoots.length ? path.join(inputRoots[0], keyToNative(key)) : resolved;
    const probe = records[key]?.probe;
    if (!formatIdFor(ext, probe) && src && await isFile(src)) {
      const kind = await kindOf(src, ext, probe);
      if (kind !== 'source') return kind === 'playable' ? found(src, 'original') : missing('unsupported');
    }
  }

  // 3) Fall back to the converted folder itself, compared by sanitised path tail.
  const safeSegs = segs.map((s, i) => (i === segs.length - 1 ? sanitizeSegment(stemOf(s), safeNames) + OUTPUT_EXT : sanitizeSegment(s, safeNames)));
  const c = bestMatch(convertedIndex, safeSegs);
  if (c.match) return found(c.match.abs);
  if (c.ambiguous || ambiguous) return missing('ambiguous');

  // 4) A file outside the library that the CDJ can already play stays as it is.
  if (resolved && await isFile(resolved)) {
    const ext = path.extname(resolved).toLowerCase();
    if (convertedRoot && isInside(convertedRoot, resolved)) return found(resolved);
    const kind = await kindOf(resolved, ext);
    if (kind === 'playable') return found(resolved, 'original');
    return kind === 'source' ? notConverted(key) : missing('unsupported');
  }
  return key ? notConverted(key) : missing('not-found');
}

export function countEntries(entries) {
  const counts = { total: entries.length, found: 0, original: 0, manual: 0, missing: 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return counts;
}
