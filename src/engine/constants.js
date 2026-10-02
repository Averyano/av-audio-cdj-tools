import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'AudioConverter';
// GitHub owner/repo: releases, the update check and the download page (desktop-app.md → Updates).
export const REPO = 'Averyano/av-audio-cdj-tools';

// Source formats the user can tick, matched by extension. `codec` narrows an extension another
// codec shares: an .m4a is ALAC (converted) or AAC (the CDJ plays it as it is). Adding a format =
// new entry here plus a rule in plan.js#isCompatible for when it is *not* ticked.
export const SOURCE_FORMATS = {
  flac: { id: 'flac', label: 'FLAC', exts: ['.flac'], defaultOn: true },
  wav: { id: 'wav', label: 'WAV', exts: ['.wav', '.wave'], defaultOn: true },
  alac: { id: 'alac', label: 'ALAC', exts: ['.m4a', '.mp4', '.alac'], codec: /alac/i, defaultOn: true },
};

// Other audio we recognise so it can be counted as "compatible" or "unsupported".
export const OTHER_AUDIO_EXTS = [
  '.mp3', '.m4a', '.aac', '.mp4', '.aif', '.aiff', '.aifc',
  '.ogg', '.oga', '.opus', '.wma', '.ape', '.wv', '.dsf', '.dff',
];

export const AUDIO_EXTS = new Set([
  ...Object.values(SOURCE_FORMATS).flatMap((f) => f.exts),
  ...OTHER_AUDIO_EXTS,
]);

// Pioneer CDJ-2000NXS (NXS1): WAV/AIFF only at these rates/depths, no AIFF-C,
// no WAVE_FORMAT_EXTENSIBLE, USB paths < 256 chars, max 8 folder levels.
export const CDJ_PROFILE = {
  name: 'CDJ-2000NXS',
  sampleRates: [44100, 48000],
  bitDepths: [16, 24],
  maxPathLength: 240, // leave headroom below 256 for the USB mount prefix
  maxFolderDepth: 8,
};

export const OUTPUT_EXT = '.aiff';
export const PART_SUFFIX = '.part';

// Folder names never descended into.
export const SKIP_DIRS = new Set([
  '$RECYCLE.BIN', 'System Volume Information', '.Trashes', '.Spotlight-V100',
  '.fseventsd', '.TemporaryItems', '@eaDir', 'PIONEER',
]);

export function defaultWorkers() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(cpus - 1, 6));
}

// Same folder for CLI and GUI so both share manifests and settings.
// AUDIOCONVERTER_DATA_DIR overrides it (dev/smoke tests).
export function defaultDataDir() {
  if (process.env.AUDIOCONVERTER_DATA_DIR) return process.env.AUDIOCONVERTER_DATA_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}
