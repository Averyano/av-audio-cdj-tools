// Audio analyzer I/O: probe a file, stream-decode it through ffmpeg as 32-bit integers and
// feed spectrum.js; then tempo and key (analyzeTempoKey). Read-only; nothing is written
// (analyzer.md).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { SpectrogramBuilder, findCutoff, verdicts, usedBitsFromOr, DB_FLOOR } from './spectrum.js';
import { analyzeTrack } from './tempokey.js';

// DSD decodes to PCM at a different rate than the file reports; not supported yet.
const UNSUPPORTED = new Set(['.dsf', '.dff']);
const TEMPO_RATE = 22050; // tempo needs ≤ 8 kHz, key ≤ 1 kHz; the Library check ran at this rate
const TEMPO_MAX_SECONDS = 20 * 60; // a DJ mix: its first 20 minutes (~100 MB of samples)

/**
 * Analyses one file. Resolves to the result shape in analyzer.md → Data shapes.
 * onProgress(frac) is throttled; `signal` aborts the decode (rejects with "Cancelled").
 */
export async function analyzeFile(abs, { ffmpegPath, signal, onProgress = () => {}, columns = 1024, rows = 512 } = {}) {
  if (UNSUPPORTED.has(path.extname(abs).toLowerCase())) throw new Error('DSD files (.dsf/.dff) aren’t supported by the analyzer yet.');
  // duration: true scans files without a length header (e.g. some MP3s) so the time axis is right.
  const { format } = await parseFile(abs, { skipCovers: true, duration: true });
  const sampleRate = format.sampleRate;
  const channels = format.numberOfChannels || 2;
  if (!sampleRate) throw new Error('Couldn’t read this file’s audio format.');
  const totalSamples = format.duration ? Math.round(format.duration * sampleRate) : null;
  const builder = new SpectrogramBuilder({ sampleRate, totalSamples, columns, rows });

  let or = 0; // OR of every integer sample → bits that carry signal
  let frames = 0;
  let lastEmit = 0;
  let carry = Buffer.alloc(0); // bytes of a frame split across chunks
  const frameBytes = 4 * channels;

  await new Promise((resolve, reject) => {
    // -ac/-ar are left alone: the native rate is the point, and mixing here would hide the LSBs.
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', abs, '-map', '0:a:0', '-f', 's32le', '-acodec', 'pcm_s32le', 'pipe:1'];
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let failed = null; // an error thrown while processing; it wins over ffmpeg's exit code
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (d) => { if (stderr.length < 16384) stderr += d; });
    // Anything thrown in here would otherwise escape as an uncaught exception in main, once per
    // chunk. Catch it, stop ffmpeg, and fail this analysis only.
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      try {
        onChunk(chunk);
      } catch (err) {
        failed = err;
        child.kill('SIGKILL');
      }
    });
    const onChunk = (chunk) => {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const n = Math.floor(bytes.length / frameBytes);
      carry = bytes.subarray(n * frameBytes);
      const mono = new Float32Array(n);
      for (let f = 0; f < n; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const v = bytes.readInt32LE((f * channels + c) * 4);
          or |= v;
          sum += v;
        }
        mono[f] = sum / channels / 2147483648;
      }
      builder.push(mono);
      frames += n;
      const now = Date.now();
      if (totalSamples && now - lastEmit > 100) {
        lastEmit = now;
        onProgress(Math.min(0.99, frames / totalSamples));
      }
    };
    child.on('error', (err) => reject(new Error(`Couldn’t start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (failed) reject(new Error(`Couldn’t analyse this file (${failed.message}). Please report it.`));
      else if (code !== 0) reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with code ${code}`));
      else resolve();
    });
  });

  const res = builder.finish();
  const edge = findCutoff(res.spectrum, res.binHz);
  const lossless = format.lossless ?? null;
  const usedBits = lossless === false ? null : usedBitsFromOr(or);
  const info = {
    container: format.container ?? null,
    codec: format.codec ?? null,
    lossless,
    sampleRate,
    bits: format.bitsPerSample ?? null,
    usedBits,
    channels,
    duration: frames / sampleRate,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
  };
  onProgress(1);
  return {
    name: path.basename(abs),
    format: info,
    spectrogram: { columns: res.columns, rows: res.rows, image: res.image, nyquist: sampleRate / 2, dbFloor: DB_FLOOR },
    spectrum: downsample(res.spectrum, rows),
    edge: { cutoff: edge.cutoff, bandwidth: edge.bandwidth, ultrasonic: edge.ultrasonic },
    verdicts: verdicts(info, usedBits, edge), // { lossless, hires }: the page shows one per Settings
  };
}

/**
 * Tempo, key and tuning of a whole file: a second decode, to mono at TEMPO_RATE (~0.5 s for a
 * track), then tempokey.js → analyzeTrack, which yields while it works (a few seconds).
 * Aborting `signal` rejects with "Cancelled". Shape: analyzer.md → Data shapes.
 */
export async function analyzeTempoKey(abs, { ffmpegPath, signal } = {}) {
  const x = await decodeMono(abs, { ffmpegPath, signal, rate: TEMPO_RATE, seconds: TEMPO_MAX_SECONDS });
  const r = await analyzeTrack(x, TEMPO_RATE, { signal });
  const key = r.key && {
    n: r.key.n, mode: r.key.mode, camelot: r.key.camelot, name: r.key.name,
    margin: Math.round(r.key.margin * 1000) / 1000, confidence: r.key.confidence,
    runnerUp: { camelot: r.key.runnerUp.camelot, name: r.key.runnerUp.name },
  };
  return {
    bpm: r.tempo?.bpm ?? null,
    clarity: r.tempo ? Math.round(r.tempo.clarity * 1000) / 1000 : null,
    key,
    tuning: r.tuning,
    seconds: Math.round(r.seconds * 10) / 10,
    truncated: r.seconds >= TEMPO_MAX_SECONDS - 1,
  };
}

function decodeMono(abs, { ffmpegPath, signal, rate, seconds }) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', abs, '-map', '0:a:0', '-t', String(seconds),
      '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'];
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (d) => { if (stderr.length < 16384) stderr += d; });
    child.on('error', (err) => reject(new Error(`Couldn’t start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with code ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

// Average spectrum for the chart: `points` values from 0 to Nyquist, power-averaged.
function downsample(db, points) {
  const per = db.length / points;
  return Float32Array.from({ length: points }, (_, p) => {
    let sum = 0, n = 0;
    for (let i = Math.floor(p * per); i < Math.floor((p + 1) * per); i++, n++) sum += 10 ** (db[i] / 10);
    return sum > 0 ? 10 * Math.log10(sum / n) : -200;
  });
}
