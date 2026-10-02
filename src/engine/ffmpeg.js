import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function bundledPath() {
  try {
    const p = require('ffmpeg-static');
    // Inside a packaged Electron app the binary lives outside the asar archive.
    return p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : null;
  } catch {
    return null;
  }
}

function run(bin, args, { signal, maxStderr = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    } catch (err) {
      resolve({ code: -1, stderr: err.message, error: err });
      return;
    }
    child.stderr.on('data', (d) => {
      if (stderr.length < maxStderr) stderr += d.toString();
    });
    child.on('error', (err) => resolve({ code: -1, stderr: stderr || err.message, error: err }));
    child.on('close', (code, sig) => resolve({ code, signal: sig, stderr }));
  });
}

function runCapture(bin, args) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/** { path, version, soxr } if `bin` runs and says it's ffmpeg, else null. */
export async function checkFfmpeg(bin) {
  const out = await runCapture(bin, ['-hide_banner', '-buildconf']);
  if (out === null) return null;
  const ver = await runCapture(bin, ['-hide_banner', '-version']);
  if (!ver?.startsWith('ffmpeg version')) return null;
  return {
    path: bin,
    version: ver.split('\n')[0].replace(/^ffmpeg version\s*/, '').split(' ')[0] || 'unknown',
    soxr: out.includes('--enable-libsoxr'),
  };
}

// Where package managers and the usual manual installs put ffmpeg. An app opened from Finder,
// the Dock or the Start menu doesn't get the shell's PATH (on a Mac that misses Homebrew's
// /opt/homebrew/bin), so these are tried after PATH.
export function knownLocations(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'];
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'), // winget
      env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'),
      path.win32.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe', // the usual spot for an unzipped download
    ].filter(Boolean);
  }
  return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
}

/**
 * Finds a working ffmpeg: explicit override → ffmpeg-static (source checkouts only; installers
 * don't ship it, D41) → PATH → knownLocations(). Returns
 * { path, version, soxr, source: 'custom' | 'bundled' | 'system' } or throws with a readable message.
 */
export async function locateFfmpeg(override) {
  const candidates = [[override, 'custom'], [bundledPath(), 'bundled'], ['ffmpeg', 'system'], ...knownLocations().map((p) => [p, 'system'])];
  for (const [bin, source] of candidates) {
    if (!bin || (path.isAbsolute(bin) && !existsSync(bin))) continue;
    const ff = await checkFfmpeg(bin);
    if (ff) return { ...ff, source };
  }
  throw new Error('ffmpeg not found. Install it (https://ffmpeg.org/download.html) or put it on PATH.');
}

/**
 * Builds the ffmpeg argument list for one conversion: audio only, no tags
 * (id3.js appends the ID3 chunk afterwards). pcm_s16be/pcm_s24be makes ffmpeg
 * write plain AIFF, never AIFF-C, which the NXS1 can't read.
 */
export function buildArgs({ src, dst, target, soxr = false }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src];
  args.push('-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact');

  const pcm = target.bits === 16 ? 's16' : 's32';
  args.push('-c:a', target.bits === 16 ? 'pcm_s16be' : 'pcm_s24be');

  if (target.resample) {
    const quality = soxr ? 'resampler=soxr:precision=28' : 'filter_size=64:cutoff=0.97';
    const dither = target.bits === 16 ? ':dither_method=triangular' : '';
    // aformat pins the sample format so aresample does the conversion (and dither) itself.
    args.push('-af', `aresample=${target.sampleRate}:${quality}${dither},aformat=sample_fmts=${pcm}`);
  }
  if (target.downmix) args.push('-ac', '2');

  args.push('-f', 'aiff', dst);
  return args;
}

export function runFfmpeg(bin, args, opts) {
  return run(bin, args, opts);
}

/** Last few meaningful lines of ffmpeg's stderr for error reports. */
export function stderrTail(stderr, lines = 6) {
  return stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-lines).join('\n');
}
