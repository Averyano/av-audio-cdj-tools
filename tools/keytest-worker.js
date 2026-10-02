// Worker thread for tools/keytest.js: decodes one track to mono at RATE and extracts what the
// report needs (onset envelope + 10 s pitch histograms), plus the engine's own answer.

import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { onsetEnvelope, tempoFromEnvelope, pitchHistogram, chromaFromHistogram, estimateKey } from '../src/engine/tempokey.js';

export const RATE = 22050; // tempo needs ≤ 8 kHz, key ≤ 2 kHz
export const WINDOW_SECONDS = 10;

function decode(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'],
      // detached: its own process group, so Ctrl+C in the terminal reaches only keytest.js, which
      // lets the tracks in progress finish instead of failing them.
      { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

parentPort.on('message', async ({ id, file }) => {
  const t0 = performance.now();
  try {
    const x = await decode(workerData.ffmpegPath, file);
    const envelope = onsetEnvelope(x, RATE);
    const { fine, windows } = pitchHistogram(x, RATE, { windowSeconds: WINDOW_SECONDS });
    const { chroma, tuning } = chromaFromHistogram(fine);
    const tempo = tempoFromEnvelope(envelope);
    const key = estimateKey(chroma);
    parentPort.postMessage({
      id,
      ok: true,
      seconds: x.length / RATE,
      fps: envelope.fps,
      envelope: { env: envelope.env, valid: envelope.valid },
      windows,
      result: {
        bpm: tempo?.bpm ?? null,
        clarity: tempo ? Math.round(tempo.clarity * 1000) / 1000 : null,
        key: key?.camelot ?? null,
        margin: key ? Math.round(key.margin * 1000) / 1000 : null,
        tuning: Math.round(tuning * 10) / 10,
      },
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
