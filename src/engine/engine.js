import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CDJ_PROFILE, PART_SUFFIX, SOURCE_FORMATS, defaultDataDir, defaultWorkers } from './constants.js';
import { walk } from './walk.js';
import { probeFile, readTags, inspectOutput } from './probe.js';
import { buildPlan, folderDepth, estimateBytes } from './plan.js';
import { buildTagPairs, pickCover } from './tags.js';
import { encodeId3v23, appendAiffChunk } from './id3.js';
import { locateFfmpeg, buildArgs, runFfmpeg, stderrTail } from './ffmpeg.js';
import { Manifest } from './manifest.js';
import { runPool } from './pool.js';
import { keyToNative, isInside } from './names.js';
import { matchPlaylist } from './playlists.js';

const PROBE_CONCURRENCY = 8;
const STAT_CONCURRENCY = 16;
const PROGRESS_EVERY_MS = 100;
const MAX_EXAMPLES = 20;

// Cached probes from before probe.js read the ALAC cookie have no rate for hi-res ALAC.
const staleProbe = (p) => p?.codec === 'ALAC' && !p.sampleRate;

/**
 * Scan → plan → convert, reporting through events:
 *   'progress' { phase: 'walk'|'probe'|'check'|'convert', … }
 * Pure Node (no Electron) so the CLI, the app and the tests share it.
 */
export class Engine extends EventEmitter {
  constructor({ dataDir = defaultDataDir(), ffmpegPath = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.ffmpegPath = ffmpegPath;
    this.abort = null;
    this.lastEmit = 0;
  }

  get busy() {
    return !!this.abort;
  }

  /** A different ffmpeg binary (null = bundled, then PATH). Jobs already running keep theirs. */
  setFfmpegPath(p) {
    this.ffmpegPath = p || null;
    this.ffPromise = null;
  }

  ffmpeg() {
    this.ffPromise ??= locateFfmpeg(this.ffmpegPath).catch((err) => {
      this.ffPromise = null;
      throw err;
    });
    return this.ffPromise;
  }

  cancel() {
    this.abort?.abort(new Error('Cancelled'));
  }

  async scan(opts) {
    return this.#exclusive(async (signal) => (await this.#scan(opts, signal)).summary);
  }

  async convert(opts) {
    return this.#exclusive((signal) => this.#convert(opts, signal));
  }

  /**
   * Maps a playlist's entries to converted files (see playlists.js). Read-only, so it
   * is allowed while a scan/convert runs.
   */
  async matchPlaylist({ playlistPath, inputRoot, outputRoot, convertedRoot, safeNames = true }) {
    if (!playlistPath) throw new Error('Choose a playlist file.');
    if (!convertedRoot) throw new Error('Choose the folder with converted files.');
    const st = await fs.stat(convertedRoot).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Converted folder not found: ${convertedRoot}`);
    return matchPlaylist({ playlistPath, inputRoot, outputRoot, convertedRoot, safeNames, dataDir: this.dataDir });
  }

  /** Previous run info for a folder pair without scanning (for the UI on startup). */
  async status({ inputRoot, outputRoot }) {
    if (!inputRoot || !outputRoot) return null;
    const m = await Manifest.load(this.dataDir, inputRoot, outputRoot);
    return { lastRun: m.data.lastRun, lastScanAt: m.data.lastScanAt };
  }

  async #exclusive(fn) {
    if (this.abort) throw new Error('A scan or conversion is already running.');
    this.abort = new AbortController();
    try {
      return await fn(this.abort.signal);
    } finally {
      this.abort = null;
    }
  }

  #emit(payload, force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_EVERY_MS) return;
    this.lastEmit = now;
    this.emit('progress', payload);
  }

  async #validate({ inputRoot, outputRoot, formats }) {
    if (!inputRoot) throw new Error('Choose an input folder.');
    if (!outputRoot) throw new Error('Choose an output folder.');
    if (!formats?.length) throw new Error('Tick at least one format to convert.');
    const unknown = formats.filter((f) => !SOURCE_FORMATS[f]);
    if (unknown.length) throw new Error(`Unknown format: ${unknown.join(', ')}`);

    let input;
    try {
      input = await fs.realpath(inputRoot);
      if (!(await fs.stat(input)).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Input folder not found: ${inputRoot}`);
    }
    const output = await realpathLoose(outputRoot);
    const outStat = await fs.stat(output).catch(() => null);
    if (outStat && !outStat.isDirectory()) throw new Error(`Output path is not a folder: ${outputRoot}`);
    if (isInside(input, output) || isInside(output, input)) {
      throw new Error('Input and output must be separate folders (neither inside the other).');
    }
    return { input, output };
  }

  async #scan(opts, signal) {
    const { inputRoot, outputRoot, formats, safeNames = true } = opts;
    const t0 = Date.now();
    const { input, output } = await this.#validate(opts);
    const manifest = await Manifest.load(this.dataDir, inputRoot, outputRoot);
    const records = manifest.files;

    // 1) Walk: cheap, always done in full so new files are found.
    const walked = await walk(input, {
      exclude: [output],
      signal,
      onProgress: ({ found }) => this.#emit({ phase: 'walk', found }),
    });
    this.#emit({ phase: 'walk', found: walked.files.length }, true);

    // 2) Probe only new or changed files.
    const seen = new Set();
    const toProbe = [];
    for (const f of walked.files) {
      seen.add(f.key);
      const rec = (records[f.key] ??= {});
      delete rec.missingSince;
      const changed = rec.size !== f.size || rec.mtimeMs !== f.mtimeMs;
      if (f.ext === '.mp3') {
        rec.size = f.size;
        rec.mtimeMs = f.mtimeMs;
      } else if (changed || (!rec.probe && !rec.probeError) || staleProbe(rec.probe)) {
        toProbe.push(f);
      }
    }
    let probed = 0;
    await runPool(toProbe, PROBE_CONCURRENCY, async (f) => {
      const rec = records[f.key];
      try {
        rec.probe = await probeFile(f.abs);
        delete rec.probeError;
      } catch (err) {
        rec.probe = null;
        rec.probeError = err.message;
      }
      rec.size = f.size;
      rec.mtimeMs = f.mtimeMs;
      probed++;
      this.#emit({ phase: 'probe', done: probed, total: toProbe.length });
    }, signal);
    if (signal.aborted) throw signal.reason;
    if (toProbe.length) this.#emit({ phase: 'probe', done: probed, total: toProbe.length }, true);

    // Sources that disappeared: outputs are never touched, we only count them.
    const now = new Date().toISOString();
    let missing = 0;
    for (const [key, rec] of Object.entries(records)) {
      if (seen.has(key)) continue;
      rec.missingSince ??= now;
      if (rec.done) missing++;
      else delete records[key];
    }
    manifest.data.folders = walked.folders;

    // 3) Plan + up-to-date check against the output folder.
    const entries = buildPlan(walked.files, { formats, safeNames, records });
    const convertable = entries.filter((e) => e.action === 'convert');
    let checked = 0;
    await runPool(convertable, STAT_CONCURRENCY, async (e) => {
      const rec = records[e.key];
      const st = await fs.stat(path.join(output, keyToNative(e.outRel))).catch(() => null);
      const d = rec.done;
      if (st && d && d.outRel === e.outRel && d.srcSize === e.size && d.srcMtimeMs === e.mtimeMs) {
        e.status = 'done';
      } else if (st && !d && st.size > 0 && st.mtimeMs >= e.mtimeMs) {
        // Self-heal: output exists and is newer than its source → adopt it.
        rec.done = { outRel: e.outRel, srcSize: e.size, srcMtimeMs: e.mtimeMs, at: st.mtime.toISOString(), adopted: true };
        e.status = 'done';
      } else {
        e.status = 'pending';
      }
      e.failedBefore = !!rec.error && rec.error.srcSize === e.size && rec.error.srcMtimeMs === e.mtimeMs;
      checked++;
      this.#emit({ phase: 'check', done: checked, total: convertable.length });
    }, signal);
    if (signal.aborted) throw signal.reason;

    manifest.data.lastScanAt = now;
    manifest.touch();
    await manifest.save();

    const summary = await this.#summarize({ entries, walked, missing, input, output, opts, manifest, ms: Date.now() - t0 });
    return { summary, entries, manifest, input, output };
  }

  async #summarize({ entries, walked, missing, input, output, opts, manifest, ms }) {
    const by = (pred) => entries.filter(pred);
    const convert = by((e) => e.action === 'convert');
    const pending = convert.filter((e) => e.status === 'pending');
    const unsupported = by((e) => e.action === 'unsupported');
    const unreadable = by((e) => e.action === 'unreadable');
    const unsupportedByExt = {};
    for (const e of unsupported) unsupportedByExt[e.ext] = (unsupportedByExt[e.ext] ?? 0) + 1;

    const bytes = pending.reduce((sum, e) => sum + estimateBytes(e), 0);
    const freeBytes = await freeSpace(output);

    // Each message is a complete sentence including the count, ready to show as-is.
    const warnings = [];
    const warn = (code, list, message, toText = (e) => e.outRel ?? e.key) => {
      const n = list.length;
      if (n) warnings.push({ code, count: n, message: message(n, (one, many = `${one}s`) => (n === 1 ? one : many)), examples: list.slice(0, MAX_EXAMPLES).map(toText) });
    };
    warn('unreadable', unreadable, (n, pl) => `${n} ${pl('file')} could not be read (corrupt or unusual metadata) and will be skipped`,
      (e) => `${e.key} — ${manifest.files[e.key]?.probeError ?? 'no stream info'}`);
    warn('failedBefore', pending.filter((e) => e.failedBefore), (n, pl) => `${n} ${pl('file')} failed last time and will be retried`,
      (e) => `${e.key} — ${manifest.files[e.key]?.error?.message ?? ''}`);
    warn('longPath', convert.filter((e) => e.outRel.length > CDJ_PROFILE.maxPathLength),
      (n, pl) => `${n} output ${pl('path')} longer than ${CDJ_PROFILE.maxPathLength} characters (CDJ limit is 256 incl. the USB folder)`);
    warn('deepFolder', convert.filter((e) => folderDepth(e.outRel) + 1 > CDJ_PROFILE.maxFolderDepth),
      (n, pl) => `${n} ${pl('track')} nested deeper than ${CDJ_PROFILE.maxFolderDepth} folders (CDJ browse limit)`);
    warn('renamed', convert.filter((e) => e.renamed), (n, pl) => `${n} ${pl('track')} got a suffix to avoid a name clash (e.g. same name as .flac and .wav)`,
      (e) => `${e.key} → ${e.outRel}`);
    if (process.platform === 'win32') {
      warn('winPath', convert.filter((e) => path.join(output, e.outRel).length > 259),
        (n, pl) => `${n} output ${pl('path')} exceed Windows' 260-character limit`);
    }
    if (freeBytes !== null && bytes > freeBytes) {
      warnings.push({ code: 'diskSpace', count: 1, message: `Not enough free space: need ~${gb(bytes)}, have ${gb(freeBytes)}`, examples: [] });
    }
    warn('walkErrors', walked.errors, (n, pl) => `${n} ${pl('file or folder', 'files or folders')} could not be read`, (e) => `${e.path} — ${e.message}`);
    const byExt = Object.entries(unsupportedByExt).map(([ext, n]) => `${ext}: ${n}`).join(', ');
    warn('unsupported', unsupported, (n, pl) => `${n} ${pl('file')} neither selected nor CDJ-playable (${byExt})`, (e) => e.key);

    const ff = await this.ffmpeg().catch((err) => ({ error: err.message }));
    return {
      inputRoot: input,
      outputRoot: output,
      formats: opts.formats,
      safeNames: opts.safeNames ?? true,
      scannedAt: manifest.data.lastScanAt,
      durationMs: ms,
      counts: {
        audio: entries.length,
        folders: walked.folders.length,
        selected: convert.length + unreadable.length,
        upToDate: convert.length - pending.length,
        pending: pending.length,
        resample: pending.filter((e) => e.target.resample).length,
        hires: convert.filter((e) => e.probe.sampleRate > 48000).length,
        compatible: by((e) => e.action === 'compatible').length,
        unsupported: unsupported.length,
        unreadable: unreadable.length,
        missing,
      },
      estimate: { bytes, freeBytes },
      warnings,
      lastRun: manifest.data.lastRun,
      ffmpeg: ff.error ? { error: ff.error } : { version: ff.version, soxr: ff.soxr, path: ff.path },
    };
  }

  async #convert(opts, signal) {
    const ff = await this.ffmpeg();
    const { summary, entries, manifest, output } = await this.#scan(opts, signal);
    const pending = entries.filter((e) => e.action === 'convert' && e.status === 'pending');
    const workers = Math.max(1, Number(opts.workers) || defaultWorkers());
    const startedAt = new Date();

    await fs.mkdir(output, { recursive: true });

    const totalSec = pending.reduce((s, e) => s + (e.probe.duration || 0), 0) || pending.length;
    let doneSec = 0;
    let converted = 0;
    let failed = 0;
    const doneKeys = new Set();
    const active = new Set();
    const failures = [];
    const progress = (force) => {
      const elapsed = Date.now() - startedAt.getTime();
      const frac = doneSec / totalSec;
      this.#emit({
        phase: 'convert',
        total: pending.length,
        converted,
        failed,
        active: [...active],
        elapsedMs: elapsed,
        etaMs: frac > 0 ? Math.round(elapsed * (1 - frac) / frac) : null,
      }, force);
    };
    progress(true);

    await runPool(pending, workers, async (e) => {
      active.add(e.key);
      progress();
      const res = await this.#convertOne(e, output, ff, signal);
      active.delete(e.key);
      const rec = manifest.files[e.key];
      if (res.ok) {
        rec.done = { outRel: e.outRel, srcSize: e.size, srcMtimeMs: e.mtimeMs, at: new Date().toISOString() };
        delete rec.error;
        doneKeys.add(e.key);
        converted++;
      } else if (!signal.aborted) {
        rec.error = { message: res.message, srcSize: e.size, srcMtimeMs: e.mtimeMs, at: new Date().toISOString() };
        failures.push({ key: e.key, abs: e.abs, message: res.message });
        failed++;
      }
      doneSec += e.probe.duration || 1;
      manifest.touch();
      await manifest.maybeSave().catch(() => {});
      progress();
    }, signal);

    const finishedAt = new Date();
    manifest.data.lastRun = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      pending: pending.length,
      converted,
      failed,
      cancelled: signal.aborted,
    };
    manifest.touch();
    await manifest.save();
    progress(true);

    const remaining = pending.filter((e) => !doneKeys.has(e.key));
    return {
      ...summary,
      counts: {
        ...summary.counts,
        upToDate: summary.counts.upToDate + converted,
        pending: remaining.length,
        resample: remaining.filter((e) => e.target.resample).length,
      },
      estimate: { ...summary.estimate, bytes: remaining.reduce((sum, e) => sum + estimateBytes(e), 0) },
      lastRun: manifest.data.lastRun,
      failures,
    };
  }

  /** One file: ffmpeg → .part → append ID3 → verify → rename into place. */
  async #convertOne(e, output, ff, signal) {
    const outAbs = path.join(output, keyToNative(e.outRel));
    const part = outAbs + PART_SUFFIX;
    try {
      // Folders are created per track, so only folders that receive tracks exist.
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      let id3 = null;
      try {
        const { common, native } = await readTags(e.abs);
        id3 = encodeId3v23(buildTagPairs(common, native), pickCover(common));
      } catch {
        id3 = null; // untaggable source still converts; audio matters most
      }

      const r = await runFfmpeg(ff.path, buildArgs({ src: e.abs, dst: part, target: e.target, soxr: ff.soxr }), { signal });
      if (signal.aborted) throw new Error('Cancelled');
      if (r.code !== 0) throw new Error(stderrTail(r.stderr) || `ffmpeg exited with code ${r.code}`);
      if (id3) await appendAiffChunk(part, 'ID3 ', id3);

      const out = await inspectOutput(part);
      const t = e.target;
      if (out.container !== 'AIFF' || out.sampleRate !== t.sampleRate || out.bits !== t.bits) {
        throw new Error(`Verification failed: got ${out.container} ${out.sampleRate} Hz ${out.bits}-bit`);
      }
      if (e.probe.duration && out.duration && Math.abs(out.duration - e.probe.duration) > 0.5) {
        throw new Error(`Verification failed: duration ${out.duration.toFixed(2)}s vs source ${e.probe.duration.toFixed(2)}s`);
      }
      await fs.rename(part, outAbs);
      return { ok: true };
    } catch (err) {
      // Windows may hold the file briefly after killing ffmpeg.
      await fs.rm(part, { force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
      return { ok: false, message: err.message };
    }
  }
}

// realpath for a path that may not exist yet: resolve the nearest existing
// ancestor (e.g. macOS /var → /private/var) and re-append the rest.
async function realpathLoose(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function freeSpace(dir) {
  let d = dir;
  for (;;) {
    try {
      const s = await fs.statfs(d);
      return s.bavail * s.bsize;
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
}

function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
