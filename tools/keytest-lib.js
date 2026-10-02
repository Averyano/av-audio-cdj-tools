// Pure helpers for tools/keytest.js: reading a rekordbox track list, matching it to files,
// scoring keys, other key-profile sets, and the cache format (camelot.md → Library check).

import { parseKeyId, keyFromPitch, keyId, rootPc } from '../src/engine/camelot.js';

/**
 * Key profiles to compare, { A: minor, B: major }, tonic first (C = 0). Values as published in
 * the papers below, copied from Essentia's key.cpp for this offline check only:
 * - krumhansl: Krumhansl & Kessler 1982 (tempokey.js until 2026-10-02)
 * - temperley: Temperley 1999, "What's key for key?"
 * - shaath: Sha'ath 2011, KeyFinder
 * - edma / edmm: Faraldo et al. 2016, "Key estimation in electronic dance music" (tempokey.js
 *   ships edma, with a minor lean; edmm has no
 *   major profile: it reports every track as minor, so its score leans on how minor a library is)
 * - braw: Faraldo et al. 2017, median profiles of Beatport tracks
 */
export const PROFILE_SETS = {
  krumhansl: {
    B: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    A: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    B: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    A: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  shaath: {
    B: [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    A: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  },
  edma: {
    B: [1.0, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39],
    A: [1.0, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
  },
  edmm: {
    B: new Array(12).fill(0.083),
    A: [0.17235348, 0.04, 0.0761009, 0.12, 0.05621498, 0.08527853, 0.0497915, 0.13451001, 0.07458916, 0.05003023, 0.09187879, 0.05545106],
  },
  braw: {
    B: [1.0, 0.1573, 0.42, 0.157, 0.5296, 0.3669, 0.1632, 0.7711, 0.1676, 0.3827, 0.2113, 0.2965],
    A: [1.0, 0.233, 0.3615, 0.3905, 0.2925, 0.3777, 0.1961, 0.7425, 0.2701, 0.2161, 0.4228, 0.2272],
  },
};

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "9A", "12b", "Fm", "F#m", "Dbm", "C", "Bb", "A♭m" → "9A" … or null. */
export function toCamelot(text) {
  const s = String(text ?? '').trim();
  const id = parseKeyId(s.toUpperCase());
  if (id) return keyId(id);
  const m = /^([A-G])([#♯b♭]?)\s*(m|min|minor|maj|major)?$/i.exec(s);
  if (!m) return null;
  const pc = (PITCH[m[1].toUpperCase()] + ({ '#': 1, '♯': 1, b: -1, '♭': -1 }[m[2]] ?? 0) + 12) % 12;
  const minor = /^m(in(or)?)?$/i.test(m[3] ?? '');
  return keyId(keyFromPitch(pc, minor ? 'A' : 'B'));
}

/** "09:15" or "1:02:03" → seconds. */
export function toSeconds(time) {
  const parts = String(time ?? '').trim().split(':').map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((s, p) => s * 60 + p, 0);
}

/**
 * rekordbox's "Export a playlist to a file" text (tab-separated; UTF-16 with a BOM, or UTF-8)
 * → [{ title, artist, album, bpm, key, seconds }]. Columns are found by their header names, so
 * the column set and order may vary. Rows without a usable key or BPM keep null there.
 */
export function parseRekordboxText(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()?.split('\t').map((h) => h.trim()) ?? [];
  const col = (name) => head.indexOf(name);
  const c = { title: col('Track Title'), artist: col('Artist'), album: col('Album'), bpm: col('BPM'), key: col('Key'), time: col('Time') };
  if (c.title < 0 || c.bpm < 0 || c.key < 0) throw new Error('Not a rekordbox track list: needs the Track Title, BPM and Key columns.');
  return lines.map((line) => {
    const f = line.split('\t');
    const bpm = Number.parseFloat(f[c.bpm]);
    return {
      title: f[c.title]?.trim() ?? '',
      artist: c.artist >= 0 ? f[c.artist]?.trim() ?? '' : '',
      album: c.album >= 0 ? f[c.album]?.trim() ?? '' : '',
      bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
      key: toCamelot(f[c.key]),
      seconds: c.time >= 0 ? toSeconds(f[c.time]) : null,
    };
  });
}

/** Case-, accent- and punctuation-free text for matching titles and artists. */
export const norm = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Pairs list rows with files ({ path, artist, title, seconds }) by artist + title, then by title
 * alone; the length (±3 s) breaks ties and must agree. Each file is used once.
 * → { matched: [{ row, file }], unmatchedRows, unmatchedFiles }
 */
export function matchTracks(rows, files, tolerance = 3) {
  const used = new Set();
  const close = (row, f) => row.seconds == null || f.seconds == null || Math.abs(row.seconds - f.seconds) <= tolerance;
  const pick = (row, candidates) => candidates
    .filter((f) => !used.has(f) && close(row, f))
    .sort((a, b) => Math.abs((a.seconds ?? 0) - (row.seconds ?? 0)) - Math.abs((b.seconds ?? 0) - (row.seconds ?? 0)))[0];
  const byBoth = new Map(), byTitle = new Map();
  for (const f of files) {
    const both = `${norm(f.artist)}|${norm(f.title)}`;
    if (!byBoth.has(both)) byBoth.set(both, []);
    byBoth.get(both).push(f);
    if (!byTitle.has(norm(f.title))) byTitle.set(norm(f.title), []);
    byTitle.get(norm(f.title)).push(f);
  }
  const matched = [], unmatchedRows = [];
  const pending = [];
  for (const row of rows) {
    const f = pick(row, byBoth.get(`${norm(row.artist)}|${norm(row.title)}`) ?? []);
    if (f) {
      used.add(f);
      matched.push({ row, file: f });
    } else pending.push(row);
  }
  for (const row of pending) {
    const f = pick(row, byTitle.get(norm(row.title)) ?? []);
    if (f) {
      used.add(f);
      matched.push({ row, file: f });
    } else unmatchedRows.push(row);
  }
  return { matched, unmatchedRows, unmatchedFiles: files.filter((f) => !used.has(f)) };
}

/**
 * MIREX key score of `got` against `want` (Camelot ids): exact 1, fifth 0.5 (same letter, ±1),
 * relative 0.3 (same number, other letter), parallel 0.2 (same tonic, other mode: 8A ↔ 11B).
 */
export function keyScore(got, want) {
  if (!got || !want) return { kind: 'none', score: 0 };
  if (got === want) return { kind: 'exact', score: 1 };
  const g = parseKeyId(got), w = parseKeyId(want);
  const d = (g.n - w.n + 12) % 12;
  if (g.mode === w.mode && (d === 1 || d === 11)) return { kind: 'fifth', score: 0.5 };
  if (g.mode !== w.mode && d === 0) return { kind: 'relative', score: 0.3 };
  if (g.mode !== w.mode && rootPc(g) === rootPc(w)) return { kind: 'parallel', score: 0.2 };
  return { kind: 'other', score: 0 };
}

const RATIOS = [[2, 'double'], [0.5, 'half'], [1.5, '3:2'], [2 / 3, '2:3'], [4 / 3, '4:3'], [3 / 4, '3:4']];

/** BPM against the truth: within 0.1 / 0.5, a simple ratio off (half, double, 3:2, 4:3…), or wrong. */
export function bpmKind(got, want) {
  if (got == null || want == null) return 'none';
  if (Math.abs(got - want) <= 0.1) return 'exact';
  if (Math.abs(got - want) <= 0.5) return 'close';
  return RATIOS.find(([k]) => Math.abs(got / want - k) < 0.01)?.[1] ?? 'wrong';
}

// ---------- cache: features/<id>.bin = onset envelope (float32, NaN = hole) + 10 s pitch histograms (float32 × 120) ----------

export function encodeFeatures({ env, valid, windows }) {
  const e = Float32Array.from(env, (v, i) => (valid[i] ? v : NaN));
  const w = new Float32Array(windows.length * 120);
  windows.forEach((h, i) => w.set(h, i * 120));
  return Buffer.concat([Buffer.from(e.buffer, e.byteOffset, e.byteLength), Buffer.from(w.buffer, w.byteOffset, w.byteLength)]);
}

export function decodeFeatures(buf, envLength) {
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const e = all.subarray(0, envLength);
  const env = Float64Array.from(e, (v) => (Number.isNaN(v) ? 0 : v));
  const valid = Uint8Array.from(e, (v) => (Number.isNaN(v) ? 0 : 1));
  const windows = [];
  for (let at = envLength; at + 120 <= all.length; at += 120) windows.push(Float64Array.from(all.subarray(at, at + 120)));
  return { env, valid, windows };
}

/** Sum of pitch histograms. */
export function sumHistograms(list) {
  const out = new Float64Array(120);
  for (const h of list) for (let i = 0; i < 120; i++) out[i] += h[i];
  return out;
}
