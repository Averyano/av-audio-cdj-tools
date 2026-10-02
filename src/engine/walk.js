import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTS, SKIP_DIRS } from './constants.js';
import { toKey, isInside } from './names.js';

/**
 * Recursively lists audio files under `root`.
 * Skips dotfiles (incl. macOS AppleDouble "._x.flac"), system folders and symlinks.
 * Options: recursive (false = only `root` itself), maxDirs (throws code 'TOO_MANY_DIRS'
 * once more folders than this were found), skipNames (extra folder names to skip).
 * Returns { files: [{abs, key, ext, size, mtimeMs}], folders: [key], errors: [{path, message}] }.
 */
export async function walk(root, { exclude = [], signal, onProgress, recursive = true, maxDirs = Infinity, skipNames = [] } = {}) {
  const files = [];
  const folders = [];
  const errors = [];
  const stack = [root];

  while (stack.length) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: dir, message: err.message });
      continue;
    }

    const candidates = [];
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        if (!recursive || SKIP_DIRS.has(name) || skipNames.includes(name)) continue;
        if (exclude.some((ex) => isInside(ex, abs))) continue;
        folders.push(toKey(path.relative(root, abs)));
        if (folders.length > maxDirs) {
          throw Object.assign(new Error(`More than ${maxDirs} folders`), { code: 'TOO_MANY_DIRS' });
        }
        stack.push(abs);
      } else if (ent.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (AUDIO_EXTS.has(ext)) candidates.push({ abs, ext });
      }
      // Symlinks and other entry types are ignored on purpose (loops, dead links).
    }

    const stats = await Promise.all(candidates.map((c) => fs.stat(c.abs).then(
      (st) => ({ ok: true, st }),
      (err) => ({ ok: false, err }),
    )));
    stats.forEach((res, i) => {
      const c = candidates[i];
      if (!res.ok) {
        errors.push({ path: c.abs, message: res.err.message });
        return;
      }
      files.push({
        abs: c.abs,
        key: toKey(path.relative(root, c.abs)),
        ext: c.ext,
        size: res.st.size,
        mtimeMs: Math.floor(res.st.mtimeMs),
      });
    });
    onProgress?.({ phase: 'walk', found: files.length, folders: folders.length, dir });
  }

  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  folders.sort();
  return { files, folders, errors };
}
