import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const SAVE_EVERY_MS = 5000;

/**
 * Per (input, output) pair state, stored outside the output folder so the
 * USB stays clean. It is only an optimisation: if it is lost, existing outputs
 * newer than their source are adopted again (self-heal in engine.js).
 *
 * files[key] = { size, mtimeMs, probe, probeError?, missingSince?,
 *                done?: { outRel, srcSize, srcMtimeMs, at },
 *                error?: { message, srcSize, srcMtimeMs, at } }
 */
export class Manifest {
  constructor(file, data) {
    this.file = file;
    this.data = data;
    this.dirty = false;
    this.lastSave = Date.now();
  }

  static pathFor(dataDir, inputRoot, outputRoot) {
    const id = crypto.createHash('sha1').update(`${path.resolve(inputRoot)}|${path.resolve(outputRoot)}`).digest('hex').slice(0, 16);
    return path.join(dataDir, 'libraries', `${id}.json`);
  }

  static async load(dataDir, inputRoot, outputRoot) {
    const file = Manifest.pathFor(dataDir, inputRoot, outputRoot);
    let data = null;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version !== VERSION) data = null;
    } catch {
      data = null;
    }
    data ??= {
      version: VERSION,
      inputRoot: path.resolve(inputRoot),
      outputRoot: path.resolve(outputRoot),
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      lastRun: null,
      folders: [],
      files: {},
    };
    return new Manifest(file, data);
  }

  get files() {
    return this.data.files;
  }

  touch() {
    this.dirty = true;
  }

  /** Saves if dirty and the last save is older than SAVE_EVERY_MS. */
  maybeSave() {
    if (!this.dirty || Date.now() - this.lastSave < SAVE_EVERY_MS) return Promise.resolve();
    return this.save();
  }

  /** Atomic write (tmp + rename); calls are serialised so jobs can't interleave. */
  save() {
    this.lastSave = Date.now();
    this.dirty = false;
    this.chain = (this.chain ?? Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data));
      await fs.rename(tmp, this.file);
    });
    return this.chain;
  }
}
