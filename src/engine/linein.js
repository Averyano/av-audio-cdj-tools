// Line inputs on multichannel audio interfaces for Listen, e.g. "Scarlett 6i6 USB · inputs 3/4".
// Chromium's getUserMedia only ever delivers a device's first two channels, so devices with more
// are recorded through the bundled ffmpeg (AVFoundation) instead (camelot.md → Line inputs).
// macOS only: on Windows, Focusrite-style drivers already expose each pair as its own device.

import { spawn, execFile } from 'node:child_process';
import { fft, hann } from './spectrum.js';

export const LINE_RATE = 48000; // ffmpeg resamples to this, so the analysis knows the rate
const COLUMN_EVERY = 2400; // samples between live columns: 20 per second
const FFT_N = 4096;
const VIEW = { lo: 40, hi: 12000, dbLo: -100, dbHi: -10 }; // live picture: log frequency, dB window (line level is hot)
// ffmpeg 6's AVFoundation input keeps only the newest device buffer and is polled every ~10 ms,
// so it drops ~12 % of them (512 samples each on a Scarlett 6i6). The packets keep their capture
// timestamps, so aresample puts each hole back as silence (async=1: pad/trim only, never stretch,
// which would shift the pitch). Without this a 130 BPM track read 149. tempokey.js skips the holes.
const FILL_HOLES = 'aresample=async=1:min_hard_comp=0.001:first_pts=0';
// AVFoundation sometimes rejects the device's first buffer and ffmpeg exits (4 starts in 10 on a
// Scarlett 6i6, 2026-10-01). Starting again works, so such a start is retried.
const START_TRIES = 6;
const START_FAILED = /audio format is not supported/i;

const exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

/** system_profiler SPAudioDataType -json → [{ name, channels }] for devices with inputs. */
export function parseCoreAudio(json) {
  const groups = JSON.parse(json).SPAudioDataType ?? [];
  return groups.flatMap((g) => g._items ?? [])
    .filter((d) => Number(d.coreaudio_device_input) > 0)
    .map((d) => ({ name: d._name, channels: Number(d.coreaudio_device_input) }));
}

/** ffmpeg -f avfoundation -list_devices true → [{ index, name }] of the audio devices. */
export function parseAvfoundationList(stderr) {
  const audio = stderr.split('AVFoundation audio devices:')[1] ?? '';
  return [...audio.matchAll(/\[(\d+)\] (.+)$/gm)].map((m) => ({ index: Number(m[1]), name: m[2].trim() }));
}

/** Pairs of inputs, 1/2, 3/4…, plus a single last input when the count is odd. 0-based channels. */
export function channelChoices(count) {
  const out = [];
  for (let c = 0; c < count; c += 2) {
    out.push(c + 1 < count ? { label: `${c + 1}/${c + 2}`, channels: [c, c + 1] } : { label: `${c + 1}`, channels: [c] });
  }
  return out;
}

async function avfoundationDevices(ffmpegPath) {
  // Listing exits with an "Input/output error" by design; the list is on stderr.
  const { stderr } = await exec(ffmpegPath, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  return parseAvfoundationList(stderr ?? '');
}

/**
 * Devices with more than two inputs that ffmpeg can record: [{ name, channels, index }].
 * Needs no microphone permission (it only lists). Empty on other platforms.
 */
export async function listLineInputs(ffmpegPath, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return [];
  const [profile, devices] = await Promise.all([exec('system_profiler', ['SPAudioDataType', '-json']), avfoundationDevices(ffmpegPath)]);
  let counts = [];
  try {
    counts = parseCoreAudio(profile.stdout);
  } catch {
    return []; // no Core Audio info: offer nothing rather than guess channel counts
  }
  return devices
    .map((d) => ({ ...d, channels: counts.find((c) => c.name === d.name)?.channels ?? 0 }))
    .filter((d) => d.channels > 2);
}

// Live picture: one column of `rows` bytes (row 0 = highest frequency) from the last FFT_N samples.
function makeColumn(rows) {
  const win = hann(FFT_N);
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const binHz = LINE_RATE / FFT_N;
  const scale = (FFT_N / 4) ** 2; // full-scale sine = 0 dB, as in spectrum.js
  const bins = Array.from({ length: rows }, (_, r) => {
    const f = VIEW.lo * (VIEW.hi / VIEW.lo) ** (1 - r / (rows - 1));
    return Math.max(1, Math.min(FFT_N / 2 - 1, Math.round(f / binHz)));
  });
  return (ring, end) => {
    for (let i = 0; i < FFT_N; i++) {
      re[i] = ring[(end + i) % FFT_N] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    return Uint8Array.from(bins, (k) => {
      const db = 10 * Math.log10((re[k] ** 2 + im[k] ** 2) / scale + 1e-20);
      return Math.round(255 * Math.min(1, Math.max(0, (db - VIEW.dbLo) / (VIEW.dbHi - VIEW.dbLo))));
    });
  };
}

/**
 * Records up to `seconds` from one or two channels of an input, mixed to mono at LINE_RATE.
 * input: { format: 'avfoundation', device: ':2' } (or 'lavfi' + a source, in tests).
 * onColumn(rows: Uint8Array, rmsDb) ~20× per second for the live picture.
 * inputChannels: the device's channel count. ffmpeg's pan quietly gives silence for a channel
 * that doesn't exist, so a wrong choice is refused here instead.
 * Aborting `signal` stops early and resolves with what came in; ffmpeg failing rejects.
 */
export async function captureLine({ ffmpegPath, input, channels, inputChannels, seconds = 10, signal, onColumn = () => {}, rows = 160 }) {
  if (!channels?.length || channels.length > 2 || channels.some((c) => !Number.isInteger(c) || c < 0 || (inputChannels && c >= inputChannels))) {
    throw new Error(`That input has ${inputChannels ?? 'fewer'} channels; pick another pair.`);
  }
  const pan = channels.length === 2
    ? `pan=mono|c0=0.5*c${channels[0]}+0.5*c${channels[1]}`
    : `pan=mono|c0=c${channels[0]}`;
  // No -t: it counts timestamps, so with dropped buffers "-t 10" gave ~8.8 s of audio (before
  // FILL_HOLES). Stop on our own sample count.
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', input.format, '-i', input.device,
    '-af', `${FILL_HOLES},${pan}`, '-ar', String(LINE_RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'];
  const target = Math.round(seconds * LINE_RATE);
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return { samples: new Float32Array(0), sampleRate: LINE_RATE };
    try {
      return await record({ ffmpegPath, args, target, signal, onColumn, rows });
    } catch (err) {
      if (!err.retry || attempt >= START_TRIES) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// One ffmpeg run. Rejects with err.retry set when ffmpeg failed to start the way a retry fixes.
function record({ ffmpegPath, args, target, signal, onColumn, rows }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let frames = 0, carry = Buffer.alloc(0), stderr = '', failed = null, full = false;
    const ring = new Float32Array(FFT_N);
    let ringAt = 0, sinceColumn = 0, sumSq = 0, sumN = 0;
    const column = makeColumn(rows);
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('data', (d) => { if (stderr.length < 16384) stderr += d; });
    child.stdout.on('data', (chunk) => {
      if (failed || full) return;
      try {
        const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const n = Math.min(Math.floor(bytes.length / 4), target - frames);
        carry = bytes.subarray(n * 4);
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const v = bytes.readFloatLE(i * 4);
          samples[i] = v;
          ring[ringAt] = v;
          ringAt = (ringAt + 1) % FFT_N;
          sumSq += v * v;
          sumN++;
          if (++sinceColumn >= COLUMN_EVERY) {
            onColumn(column(ring, ringAt), 10 * Math.log10(sumSq / sumN + 1e-20));
            sinceColumn = 0;
            sumSq = 0;
            sumN = 0;
          }
        }
        chunks.push(samples);
        frames += n;
        if (frames >= target) {
          full = true;
          child.kill('SIGKILL');
        }
      } catch (err) {
        failed = err; // never let it escape as an uncaught exception (decision D28)
        child.kill('SIGKILL');
      }
    });
    child.on('error', (err) => reject(new Error(`Couldn’t start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (failed) return reject(new Error(`Couldn’t record this input (${failed.message}).`));
      if (code !== 0 && !signal?.aborted && !full) {
        const err = new Error(stderr.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited with code ${code}`);
        err.retry = frames === 0 && START_FAILED.test(stderr);
        return reject(err);
      }
      const all = new Float32Array(frames);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      resolve({ samples: all, sampleRate: LINE_RATE });
    });
  });
}
