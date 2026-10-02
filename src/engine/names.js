import path from 'node:path';

// Manifest keys: NFC-normalised, '/'-separated, relative to the input root.
// macOS can hand back NFD names; normalising keeps keys identical across OSes.
export function toKey(relNative) {
  return relNative.split(path.sep).join('/').normalize('NFC');
}

export function keyToNative(key) {
  return key.split('/').join(path.sep);
}

// Characters FAT32/exFAT/NTFS reject. macOS allows ':' and '?' in names, which
// then break when the output is copied to a CDJ USB stick or a Windows machine.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED_BASE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export function sanitizeSegment(name, safe = true) {
  let s = name.normalize('NFC');
  if (!safe) return s;
  s = s.replace(ILLEGAL, '_').replace(/[. ]+$/, '');
  if (!s) s = '_';
  const dot = s.indexOf('.');
  const base = dot === -1 ? s : s.slice(0, dot);
  if (RESERVED_BASE.test(base)) s = `${base}_${s.slice(base.length)}`;
  return s;
}

// "Techno/2024/Artist - Track.flac" → "Techno/2024/Artist - Track.aiff"
export function outputRelFor(key, outExt, safe = true, suffix = '') {
  const parts = key.split('/');
  const file = parts.pop();
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  const dirs = parts.map((p) => sanitizeSegment(p, safe));
  const name = sanitizeSegment(base + suffix, safe) + outExt;
  return [...dirs, name].join('/');
}

// True if `child` is `parent` or lives inside it.
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
