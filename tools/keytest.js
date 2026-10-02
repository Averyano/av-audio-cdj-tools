#!/usr/bin/env node
// Library check: how well tempokey.js agrees with rekordbox on whole tracks (camelot.md →
// Library check). Reads the library, never writes to it. Developer tool; not part of the app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { parseFile } from 'music-metadata';
import { locateFfmpeg } from '../src/engine/ffmpeg.js';
import { chromaFromHistogram, estimateKey, refineTempo, PROFILES, MINOR_LEAN } from '../src/engine/tempokey.js';
import { parseKeyId, rootPc } from '../src/engine/camelot.js';
import {
  PROFILE_SETS, parseRekordboxText, matchTracks, keyScore, bpmKind, encodeFeatures, decodeFeatures, sumHistograms,
} from './keytest-lib.js';

const VERSION = 2; // bump when the cached features change meaning (2: key range C1–C6, 40 strongest peaks)
const RATE = 22050; // keep in step with keytest-worker.js
const WINDOW_SECONDS = 10;
const AUDIO = new Set(['.aiff', '.aif', '.flac', '.wav', '.mp3', '.m4a', '.alac', '.ogg']);

const USAGE = `Usage:
  node tools/keytest.js scan   --list <rekordbox.txt> --library <folder> --out <folder> [options]
  node tools/keytest.js report --out <folder>

scan   decodes every listed track once and saves what the report needs (~160 KB per track)
       in --out. Your library is only read.
  --workers N     tracks in parallel (default ${defaultWorkers()} of ${os.cpus().length} cores)
  --gentle        1 track at a time at low priority, for using the laptop meanwhile
  --limit N       stop after N new tracks (a trial run)
  --retry-failed  try tracks that failed before again

  Ctrl+C stops after the tracks in progress (press it twice to quit at once). Nothing is lost:
  run the same command again and it continues where it stopped. The Mac is kept awake while
  scanning; closing the lid still sleeps it.

report reads the saved data and prints how often BPM and key agree with rekordbox: BPM as scanned
       and refined, key for each profile set (whole tracks and 10 s pieces), a minor-lean sweep,
       confidence cut-offs, and the worst disagreements. Also writes report.txt and results.csv.

rekordbox list: select the tracks (or a playlist) → right-click → Export a playlist to a file
→ Text (.txt).
`;

function defaultWorkers() {
  return Math.max(1, Math.min(6, Math.floor(os.cpus().length / 2)));
}

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'string' },
    library: { type: 'string' },
    out: { type: 'string' },
    workers: { type: 'string' },
    gentle: { type: 'boolean', default: false },
    limit: { type: 'string' },
    'retry-failed': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
if (opt.help || !['scan', 'report'].includes(command) || !opt.out) {
  process.stdout.write(USAGE);
  process.exit(opt.help ? 0 : 1);
}
const out = path.resolve(opt.out.replace(/^~(?=$|\/)/, os.homedir()));
const files = {
  meta: path.join(out, 'meta.json'),
  tags: path.join(out, 'tags.json'),
  done: path.join(out, 'tracks.ndjson'),
  failed: path.join(out, 'failed.ndjson'),
  unmatched: path.join(out, 'unmatched.txt'),
  features: path.join(out, 'features'),
  report: path.join(out, 'report.txt'),
  csv: path.join(out, 'results.csv'),
};
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  if (command === 'scan') await scan();
  else report();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}

// ---------- scan ----------

async function scan() {
  if (!opt.list || !opt.library) throw new Error('scan needs --list and --library.');
  const library = path.resolve(opt.library);
  if (!fs.existsSync(library)) throw new Error(`Library not found: ${library} (is the drive plugged in?)`);
  fs.mkdirSync(files.features, { recursive: true });
  const meta = { version: VERSION, rate: RATE, windowSeconds: WINDOW_SECONDS, list: path.resolve(opt.list), library };
  if (fs.existsSync(files.meta)) {
    const old = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
    if (old.version !== VERSION || old.rate !== RATE || old.windowSeconds !== WINDOW_SECONDS) {
      throw new Error(`${out} holds data from another version of this tool. Use a new --out folder.`);
    }
  }
  fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2));

  const rows = parseRekordboxText(fs.readFileSync(opt.list));
  console.log(`rekordbox list: ${rows.length} tracks (${rows.filter((r) => r.key).length} with a key, ${rows.filter((r) => r.bpm).length} with a BPM)`);
  const audio = listAudio(library);
  const tagged = await readTags(library, audio);
  const { matched, unmatchedRows, unmatchedFiles } = matchTracks(rows, tagged);
  fs.writeFileSync(files.unmatched, [
    `List rows without a file (${unmatchedRows.length}):`, ...unmatchedRows.map((r) => `  ${r.artist} – ${r.title} (${r.seconds ?? '?'} s)`),
    '', `Files without a list row (${unmatchedFiles.length}):`, ...unmatchedFiles.map((f) => `  ${f.path}`), '',
  ].join('\n'));
  console.log(`Matched ${matched.length} tracks to files; ${unmatchedRows.length} list rows and ${unmatchedFiles.length} files unmatched (see unmatched.txt).`);

  const idOf = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
  const done = new Set(readLines(files.done).map((t) => t.id));
  const failed = new Set(opt['retry-failed'] ? [] : readLines(files.failed).map((t) => t.id));
  const todo = matched
    .map(({ row, file }) => ({ id: idOf(file.path), row, file }))
    .filter((t) => !done.has(t.id) && !failed.has(t.id) && t.row.key && t.row.bpm);
  const limit = opt.limit ? Number(opt.limit) : Infinity;
  const queue = todo.slice(0, limit);
  console.log(`${done.size} done before, ${failed.size} failed before (skipped${failed.size ? '; --retry-failed tries them again' : ''}), ${queue.length} to scan now.`);
  if (!queue.length) return console.log(`Nothing left to scan. Next: node tools/keytest.js report --out "${opt.out}"`);

  const workers = opt.gentle ? 1 : Math.max(1, Number(opt.workers) || defaultWorkers());
  if (opt.gentle) os.setPriority(19); // lowest priority; ffmpeg inherits it
  if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
  const { path: ffmpegPath } = await locateFfmpeg();
  console.log(`Scanning with ${workers} worker${workers > 1 ? 's' : ''}${opt.gentle ? ' (gentle)' : ''}. Ctrl+C stops safely; run the same command to continue.\n`);

  const total = done.size + queue.length;
  let finished = 0, stopping = false, nextJob = 0;
  const started = Date.now();
  const inFlight = new Map();
  const pool = Array.from({ length: Math.min(workers, queue.length) }, () => new Worker(new URL('./keytest-worker.js', import.meta.url), { workerData: { ffmpegPath } }));

  process.on('SIGINT', () => {
    if (stopping) {
      console.log('\nQuit. Saved tracks are kept; run the same command to continue.');
      process.exit(130);
    }
    stopping = true;
    console.log(`\nStopping after the ${inFlight.size} track(s) in progress… (Ctrl+C again to quit now)`);
  });

  await new Promise((resolve) => {
    let alive = pool.length;
    const retire = (w) => {
      w.terminate();
      if (--alive === 0) resolve();
    };
    const feed = (w) => {
      if (stopping || nextJob >= queue.length) return retire(w);
      if (!fs.existsSync(library)) {
        stopping = true;
        console.log('\nThe library disappeared (drive unplugged or asleep?). Stopping; run the same command to continue.');
        return retire(w);
      }
      const job = queue[nextJob++];
      inFlight.set(job.id, job);
      w.postMessage({ id: job.id, file: path.join(library, job.file.path) });
    };
    for (const w of pool) {
      w.on('message', (msg) => {
        const job = inFlight.get(msg.id);
        inFlight.delete(msg.id);
        finished++;
        if (msg.ok) save(job, msg);
        else if (!stopping) fs.appendFileSync(files.failed, `${JSON.stringify({ id: job.id, path: job.file.path, error: msg.error })}\n`); // while stopping, try it next run
        progress(job, msg);
        feed(w);
      });
      w.on('error', (err) => {
        console.error(`Worker failed: ${err.message}`);
        retire(w);
      });
      feed(w);
    }
  });

  const left = todo.length - finished;
  console.log(`\n${stopping ? 'Stopped' : 'Done'}: ${done.size + finished} of ${done.size + todo.length} tracks scanned${left > 0 ? `, ${left} left (run the same command to continue)` : ''}.`);
  console.log(`Next: node tools/keytest.js report --out "${opt.out}"`);

  function save(job, msg) {
    const bin = path.join(files.features, `${job.id}.bin`);
    fs.writeFileSync(`${bin}.tmp`, encodeFeatures({ ...msg.envelope, windows: msg.windows }));
    fs.renameSync(`${bin}.tmp`, bin); // a line in tracks.ndjson always has its complete .bin
    const line = {
      id: job.id, path: job.file.path, artist: job.row.artist, title: job.row.title,
      truth: { bpm: job.row.bpm, key: job.row.key },
      seconds: Math.round(msg.seconds * 10) / 10, fps: msg.fps, envLength: msg.envelope.env.length, windows: msg.windows.length,
      result: msg.result, ms: msg.ms,
    };
    fs.appendFileSync(files.done, `${JSON.stringify(line)}\n`);
  }

  function progress(job, msg) {
    const n = done.size + finished;
    const perTrack = (Date.now() - started) / finished;
    const eta = Math.round((perTrack * (queue.length - finished)) / 60000);
    const head = `[${String(n).padStart(String(total).length)}/${total}] ${String(Math.round((n / total) * 100)).padStart(3)}%  ETA ${eta} min  `;
    const name = `${job.row.artist} – ${job.row.title}`.slice(0, 48).padEnd(48);
    if (!msg.ok) return console.log(`${head}${name}  FAILED: ${msg.error}`);
    const r = msg.result;
    const bpmOk = ['exact', 'close'].includes(bpmKind(r.bpm, job.row.bpm)) ? '✓' : '✗';
    const keyOk = r.key === job.row.key ? '✓' : '✗';
    console.log(`${head}${name}  ${String(r.bpm ?? '—').padStart(5)} ${bpmOk} (${job.row.bpm.toFixed(2)})  ${String(r.key ?? '—').padStart(3)} ${keyOk} (${job.row.key})`);
  }
}

function listAudio(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('._') && AUDIO.has(path.extname(d.name).toLowerCase()))
    .map((d) => path.relative(root, path.join(d.parentPath ?? d.path, d.name)));
}

// Tags of every audio file, cached in tags.json by size + modification time.
async function readTags(root, rels) {
  const cache = fs.existsSync(files.tags) ? JSON.parse(fs.readFileSync(files.tags, 'utf8')) : {};
  const out = [];
  let read = 0;
  for (const [i, rel] of rels.entries()) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    let t = cache[rel];
    if (!t || t.size !== st.size || t.mtimeMs !== st.mtimeMs) {
      try {
        const { common, format } = await parseFile(abs, { skipCovers: true });
        t = { size: st.size, mtimeMs: st.mtimeMs, artist: common.artist ?? '', title: common.title ?? path.parse(rel).name, seconds: format.duration ?? null };
      } catch {
        t = { size: st.size, mtimeMs: st.mtimeMs, artist: '', title: path.parse(rel).name, seconds: null };
      }
      cache[rel] = t;
      read++;
      if (read % 50 === 0) process.stdout.write(`\rReading tags… ${i + 1}/${rels.length}`);
    }
    out.push({ path: rel, artist: t.artist, title: t.title, seconds: t.seconds });
  }
  if (read) {
    process.stdout.write(`\rRead tags of ${read} files.            \n`);
    fs.writeFileSync(files.tags, JSON.stringify(cache));
  }
  return out;
}

// ---------- report ----------

function report() {
  const tracks = readLines(files.done);
  if (!tracks.length) throw new Error(`No scanned tracks in ${out}. Run scan first.`);
  const lines = [];
  const say = (s = '') => lines.push(s);
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

  // Load features once.
  const data = tracks.map((t) => {
    const f = decodeFeatures(fs.readFileSync(path.join(files.features, `${t.id}.bin`)), t.envLength);
    const { chroma } = chromaFromHistogram(sumHistograms(f.windows));
    return { t, f, chroma };
  });

  // BPM
  say(`Library check — ${tracks.length} tracks, whole tracks decoded at ${RATE} Hz (${new Date().toISOString().slice(0, 10)})`);
  say();
  say('BPM vs rekordbox');
  const bpmRows = [['as scanned (6-beat comb)', (d) => d.t.result.bpm], ['refined (32-beat comb, ±1 %)', (d) => (d.refined ??= d.t.result.bpm && refineTempo({ ...d.f, fps: d.t.fps }, d.t.result.bpm))]];
  for (const [label, get] of bpmRows) {
    const kinds = {};
    for (const d of data) {
      const k = bpmKind(get(d), d.t.truth.bpm);
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const n = tracks.length;
    say(`  ${label.padEnd(30)} ±0.1: ${pct(kinds.exact ?? 0, n).padStart(6)}  ±0.5: ${pct((kinds.exact ?? 0) + (kinds.close ?? 0), n).padStart(6)}  half/double: ${pct((kinds.half ?? 0) + (kinds.double ?? 0), n).padStart(5)}  2:3/3:2: ${pct((kinds['2:3'] ?? 0) + (kinds['3:2'] ?? 0), n).padStart(5)}  4:3/3:4: ${pct((kinds['4:3'] ?? 0) + (kinds['3:4'] ?? 0), n).padStart(5)}  wrong: ${pct(kinds.wrong ?? 0, n).padStart(5)}  none: ${kinds.none ?? 0}`);
  }
  say();

  // Key, whole track and 10 s pieces, for every profile set (+ one learned from this library).
  const sets = { ...PROFILE_SETS };
  const own = learnProfiles(data);
  const minorCount = data.filter((d) => d.t.truth.key.endsWith('A')).length;
  say(`Key vs rekordbox (${minorCount} minor, ${tracks.length - minorCount} major). MIREX score: exact 1, fifth 0.5, relative 0.3, parallel 0.2.`);
  say(`Profile sets without a minor lean; "shipped" = tempokey.js as it is (edma, lean ${MINOR_LEAN}).`);
  say(`  ${'profiles'.padEnd(18)} ${'exact'.padStart(6)} ${'MIREX'.padStart(6)} ${'minor'.padStart(6)} ${'major'.padStart(6)}  fifth relat paral other | 10 s pieces: exact MIREX`);
  const keyOf = (chroma, profiles) => (profiles === 'shipped' ? estimateKey(chroma) : estimateKey(chroma, profiles, 0));
  const results = {};
  for (const [name, profiles] of [...Object.entries(sets), ['own (2-fold)', null], ['shipped', 'shipped']]) {
    const whole = data.map((d, i) => keyOf(d.chroma, profiles ?? own[i % 2 ? 0 : 1]));
    results[name] = whole;
    const sc = whole.map((k, i) => keyScore(k?.camelot, data[i].t.truth.key));
    const count = (kind) => sc.filter((s) => s.kind === kind).length;
    const exactIn = (mode) => {
      const idx = data.map((d, i) => (d.t.truth.key.endsWith(mode) ? i : -1)).filter((i) => i >= 0);
      return pct(idx.filter((i) => sc[i].kind === 'exact').length, idx.length);
    };
    const pieces = data.flatMap((d, i) => pieceIndexes(d.f.windows.length).map((w) => keyScore(keyOf(chromaFromHistogram(d.f.windows[w]).chroma, profiles ?? own[i % 2 ? 0 : 1])?.camelot, d.t.truth.key)));
    say(`  ${name.padEnd(18)} ${pct(count('exact'), sc.length).padStart(6)} ${(sc.reduce((a, s) => a + s.score, 0) / sc.length).toFixed(3).padStart(6)} ${exactIn('A').padStart(6)} ${exactIn('B').padStart(6)}  ${String(count('fifth')).padStart(5)} ${String(count('relative')).padStart(5)} ${String(count('parallel')).padStart(5)} ${String(count('other')).padStart(5)} |  ${pct(pieces.filter((s) => s.kind === 'exact').length, pieces.length).padStart(6)} ${(pieces.reduce((a, s) => a + s.score, 0) / pieces.length).toFixed(3)}`);
  }
  say('  own = profiles averaged from half of this library (rotated to C by rekordbox key), tested on the other half, both ways.');
  say();

  // How strongly to lean to minor (MINOR_LEAN): exact matches overall, per mode, and on 10 s pieces.
  say(`Minor lean on the shipped profiles (tempokey.js PROFILES; ships with ${MINOR_LEAN}):`);
  say(`  ${'lean'.padEnd(6)} ${'exact'.padStart(6)} ${'minor'.padStart(6)} ${'major'.padStart(6)} | 10 s exact`);
  for (const lean of [0, 0.04, 0.08, 0.12, 0.15, 0.2]) {
    const ok = data.map((d) => estimateKey(d.chroma, PROFILES, lean)?.camelot === d.t.truth.key);
    const inMode = (m) => {
      const idx = data.map((d, i) => (d.t.truth.key.endsWith(m) ? i : -1)).filter((i) => i >= 0);
      return pct(idx.filter((i) => ok[i]).length, idx.length);
    };
    const pieces = data.flatMap((d) => pieceIndexes(d.f.windows.length).map((w) => estimateKey(chromaFromHistogram(d.f.windows[w]).chroma, PROFILES, lean)?.camelot === d.t.truth.key));
    say(`  ${String(lean).padEnd(6)} ${pct(ok.filter(Boolean).length, ok.length).padStart(6)} ${inMode('A').padStart(6)} ${inMode('B').padStart(6)} | ${pct(pieces.filter(Boolean).length, pieces.length).padStart(6)}`);
  }
  say();

  // Confidence: hiding low-margin keys trades coverage for accuracy.
  say('Hiding unsure keys (whole track): keys shown → exact among shown');
  for (const name of Object.keys(results)) {
    const pairs = results[name].map((k, i) => ({ m: k?.margin ?? 0, ok: k?.camelot === data[i].t.truth.key }));
    const cells = [0, 0.02, 0.05, 0.1, 0.15].map((th) => {
      const shown = pairs.filter((p) => p.m >= th);
      return `≥${th.toFixed(2)}: ${pct(shown.length, pairs.length)} → ${pct(shown.filter((p) => p.ok).length, shown.length)}`;
    });
    say(`  ${name.padEnd(18)} ${cells.join('  ')}`);
  }
  say();

  // Worst disagreements, to check by ear.
  const best = Object.keys(results).reduce((a, n) => (score(results[n]) > score(results[a]) ? n : a), 'krumhansl');
  say(`Confident key disagreements (${best}, margin ≥ 0.1, not a fifth/relative):`);
  data.map((d, i) => ({ d, k: results[best][i] }))
    .filter(({ d, k }) => k && k.margin >= 0.1 && keyScore(k.camelot, d.t.truth.key).kind === 'other')
    .sort((a, b) => b.k.margin - a.k.margin).slice(0, 15)
    .forEach(({ d, k }) => say(`  ${d.t.artist} – ${d.t.title}: rekordbox ${d.t.truth.key}, ours ${k.camelot} (margin ${k.margin.toFixed(2)})`));
  say();
  say('BPM disagreements beyond ±0.5 (refined):');
  data.filter((d) => !['exact', 'close', 'half', 'double'].includes(bpmKind(d.refined, d.t.truth.bpm))).slice(0, 15)
    .forEach((d) => say(`  ${d.t.artist} – ${d.t.title}: rekordbox ${d.t.truth.bpm}, ours ${d.refined} (${bpmKind(d.refined, d.t.truth.bpm)}, clarity ${d.t.result.clarity})`));

  fs.writeFileSync(files.report, `${lines.join('\n')}\n`);
  const names = Object.keys(results);
  const csv = [['artist', 'title', 'rekordbox_bpm', 'rekordbox_key', 'bpm', 'bpm_refined', 'clarity', 'tuning', ...names.map((n) => `key_${n.split(' ')[0]}`), 'margin_krumhansl']];
  data.forEach((d, i) => csv.push([d.t.artist, d.t.title, d.t.truth.bpm, d.t.truth.key, d.t.result.bpm, d.refined, d.t.result.clarity, d.t.result.tuning, ...names.map((n) => results[n][i]?.camelot ?? ''), results.krumhansl[i]?.margin?.toFixed(3) ?? '']));
  fs.writeFileSync(files.csv, csv.map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nSaved ${files.report} and ${files.csv}`);

  function score(list) {
    return list.reduce((a, k, i) => a + keyScore(k?.camelot, data[i].t.truth.key).score, 0);
  }
}

// 10 s pieces like a Listen take: at 25 %, 50 % and 75 % of the track.
function pieceIndexes(count) {
  return count < 4 ? [] : [0.25, 0.5, 0.75].map((f) => Math.min(count - 1, Math.floor(count * f)));
}

// Profiles averaged from this library: each track's chroma rotated so its rekordbox tonic is C.
// Two halves (even/odd rows); own[0] is learned from the even rows and used on the odd ones.
function learnProfiles(data) {
  return [0, 1].map((half) => {
    const sum = { A: new Array(12).fill(0), B: new Array(12).fill(0) };
    data.forEach((d, i) => {
      if (i % 2 !== half) return;
      const key = parseKeyId(d.t.truth.key);
      const pc = rootPc(key);
      const total = d.chroma.reduce((a, v) => a + v, 0) || 1;
      for (let k = 0; k < 12; k++) sum[key.mode][k] += d.chroma[(k + pc) % 12] / total;
    });
    return { A: sum.A.some((v) => v > 0) ? sum.A : PROFILES.A, B: sum.B.some((v) => v > 0) ? sum.B : PROFILES.B };
  });
}
