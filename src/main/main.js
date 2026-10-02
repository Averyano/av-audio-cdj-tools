import { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../engine/engine.js';
import { checkFfmpeg } from '../engine/ffmpeg.js';
import { createUpdates } from './updates.js';
import { buildM3u, writePlaylist, playlistFileName, cleanPrefix, countEntries, resolveFile, findMissingInFolder } from '../engine/playlists.js';
import { SOURCE_FORMATS, AUDIO_EXTS, REPO, defaultDataDir, defaultWorkers } from '../engine/constants.js';
import { isInside } from '../engine/names.js';
import { DECK_DEFAULTS, sanitizeDeck } from '../engine/camelot.js';
import { PREF_DEFAULTS, sanitizePrefs } from '../engine/prefs.js';
import { analyzeFile, analyzeTempoKey } from '../engine/analyze.js';
import { analyzeClip } from '../engine/tempokey.js';
import { listLineInputs, captureLine, channelChoices } from '../engine/linein.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = defaultDataDir();
const settingsFile = path.join(dataDir, 'settings.json');

const DEFAULTS = {
  inputRoot: '',
  outputRoot: '',
  formats: Object.values(SOURCE_FORMATS).filter((f) => f.defaultOn).map((f) => f.id),
  safeNames: true,
  workers: defaultWorkers(),
  playlistPrefix: 'av-',
  playlistUseCustomRoot: false,
  playlistConvertedRoot: '',
  playlistSearchRecursive: false,
  camelot: DECK_DEFAULTS,
  prefs: PREF_DEFAULTS, // Settings page (engine/prefs.js)
  listenInput: '', // Listen's chosen input, as the Input select stores it ('' = default input)
  ffmpegPath: '', // Settings → ffmpeg: a binary the user chose ('' = look for one); dialog only
  skippedVersion: '', // the release "Download later" put off: no dialog for it again (updates.js)
};

// The only links the app opens, fixed here: the renderer names one, never sends a URL (D18, D38).
const LINKS = {
  email: 'mailto:hello@averyano.com',
  ffmpeg: 'https://ffmpeg.org/download.html',
  releases: `https://github.com/${REPO}/releases/latest`,
};

let settings = { ...DEFAULTS };
let win = null;
let running = null; // promise of the current scan/convert
let quitting = false;
const engine = new Engine({ dataDir });
let updates = null; // createUpdates(), once settings are loaded

// Playlist state lives here, not in the renderer, so every path the app reads or
// writes comes from a native dialog. Reset when the app quits.
const playlist = { path: null, match: null, savedPath: null, searchDir: null, searchAbort: null };

// Audio analyzer: one decode per slot ('a', and 'b' when comparing). A new file for a slot
// cancels the decode already running there. Read-only: nothing is written (analyzer.md).
const ANALYZER_SLOTS = new Set(['a', 'b']);
const analyses = { a: null, b: null };
let lineCapture = null; // Listen on a line input (engine/linein.js): its AbortController

let tempoKeyToken = 0;

async function analyze(slot, file) {
  analyses[slot]?.abort();
  const ac = new AbortController();
  analyses[slot] = ac;
  const release = () => { if (analyses[slot] === ac) analyses[slot] = null; };
  try {
    const ff = await engine.ffmpeg();
    const result = await analyzeFile(file, {
      ffmpegPath: ff.path,
      signal: ac.signal,
      onProgress: (frac) => win?.webContents.send('analyzer:progress', { slot, frac }),
    });
    // Tempo and key take a few seconds more, so the spectrogram shows first and they follow as
    // an analyzer:tempoKey event carrying this token. Same AbortController: a new file or
    // Remove cancels both. Errors go to the page, never out of main (D28).
    const token = ++tempoKeyToken;
    analyzeTempoKey(file, { ffmpegPath: ff.path, signal: ac.signal })
      .then((data) => win?.webContents.send('analyzer:tempoKey', { slot, token, ok: true, data }))
      .catch((err) => {
        if (!ac.signal.aborted) win?.webContents.send('analyzer:tempoKey', { slot, token, ok: false, error: err.message });
      })
      .finally(release);
    return { ...result, tempoKey: token };
  } catch (err) {
    release();
    throw err;
  }
}

engine.on('progress', (p) => win?.webContents.send('engine:progress', p));

async function loadSettings() {
  try {
    settings = sanitize({ ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) });
  } catch {
    settings = { ...DEFAULTS };
  }
}

async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${settingsFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, settingsFile);
}

function sanitize(s) {
  return {
    inputRoot: typeof s.inputRoot === 'string' ? s.inputRoot : '',
    outputRoot: typeof s.outputRoot === 'string' ? s.outputRoot : '',
    formats: Array.isArray(s.formats) ? s.formats.filter((f) => SOURCE_FORMATS[f]) : DEFAULTS.formats,
    safeNames: s.safeNames !== false,
    workers: Math.min(16, Math.max(1, Math.round(Number(s.workers)) || DEFAULTS.workers)),
    playlistPrefix: typeof s.playlistPrefix === 'string' ? cleanPrefix(s.playlistPrefix) : DEFAULTS.playlistPrefix,
    playlistUseCustomRoot: s.playlistUseCustomRoot === true,
    playlistConvertedRoot: typeof s.playlistConvertedRoot === 'string' ? s.playlistConvertedRoot : '',
    playlistSearchRecursive: s.playlistSearchRecursive === true,
    camelot: sanitizeDeck(s.camelot),
    prefs: sanitizePrefs(s.prefs),
    listenInput: typeof s.listenInput === 'string' ? s.listenInput.slice(0, 300) : '',
    ffmpegPath: typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '',
    skippedVersion: typeof s.skippedVersion === 'string' ? s.skippedVersion.slice(0, 50) : '',
  };
}

// Where converted files are looked up for playlists: the output folder unless overridden.
// Ticked but not chosen yet → '' so matching asks for a folder instead of guessing.
function convertedRoot() {
  return settings.playlistUseCustomRoot ? settings.playlistConvertedRoot : settings.outputRoot;
}

// Match results go stale when anything they depend on changes.
function updateSettings(next) {
  const before = settings;
  settings = sanitize(next);
  const keys = ['inputRoot', 'outputRoot', 'safeNames', 'playlistUseCustomRoot', 'playlistConvertedRoot'];
  if (keys.some((k) => before[k] !== settings[k])) playlist.match = null;
}

// What the renderer sees of a match: no parsed file, no directives.
function publicMatch(m) {
  if (!m) return null;
  return {
    playlistPath: m.playlistPath,
    convertedRoot: m.convertedRoot,
    counts: m.counts,
    entries: m.entries.map(({ index, sourceName, sourcePath, location, status, reason, via, target, targetName }) => (
      { index, sourceName, sourcePath, location, status, reason, via, target, targetName })),
  };
}

const engineOpts = () => ({ ...settings });

// Every handler resolves to {ok, data} | {ok:false, error} so the renderer
// gets clean messages instead of Electron's "Error invoking remote method…".
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

function exclusive(fn) {
  if (engine.busy) throw new Error('A scan or conversion is already running.');
  running = fn().finally(() => {
    running = null;
  });
  return running;
}

// Shell access is limited to the chosen folders and files picked in a dialog.
function allowedPath(p) {
  if (typeof p !== 'string') return false;
  if ([playlist.path, playlist.savedPath].includes(p)) return true;
  return [settings.inputRoot, settings.outputRoot, convertedRoot()].some((root) => root && isInside(root, p));
}

// Which ffmpeg runs, for Settings → ffmpeg. `customPath` is the user's pick even when it no
// longer works (then `source` says what's used instead).
async function ffmpegInfo() {
  const ff = await engine.ffmpeg().catch((err) => ({ error: err.message }));
  const customPath = settings.ffmpegPath || null;
  return ff.error ? { error: ff.error, customPath } : { version: ff.version, soxr: ff.soxr, source: ff.source, path: ff.path, customPath };
}

// A downloaded file macOS hasn't let run yet: Gatekeeper kills it, so checkFfmpeg fails.
const quarantined = (file) => new Promise((resolve) => {
  if (process.platform !== 'darwin') return resolve(false);
  execFile('xattr', ['-p', 'com.apple.quarantine', file], (err) => resolve(!err));
});

const notWhileBusy = () => { if (engine.busy) throw new Error('Wait for the scan or conversion to finish first.'); };

async function setFfmpegPath(p) {
  notWhileBusy();
  updateSettings({ ...settings, ffmpegPath: p });
  await saveSettings();
  engine.setFfmpegPath(p);
  return ffmpegInfo();
}

function registerIpc() {
  handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    formats: Object.values(SOURCE_FORMATS).map(({ id, label }) => ({ id, label })),
    defaultWorkers: defaultWorkers(),
    ffmpeg: await ffmpegInfo(),
  }));

  handle('ffmpeg:pick', async () => {
    notWhileBusy();
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the ffmpeg program',
      buttonLabel: 'Use this ffmpeg',
      defaultPath: settings.ffmpegPath || app.getPath('downloads'),
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return ffmpegInfo();
    const file = res.filePaths[0];
    if (!await checkFfmpeg(file)) {
      throw new Error(await quarantined(file)
        ? `macOS blocked ${path.basename(file)} because it was downloaded. Allow it in System Settings → Privacy & Security (Allow Anyway), or run xattr -d com.apple.quarantine "${file}" in Terminal, then choose it again.`
        : `${path.basename(file)} isn't a working ffmpeg. Choose the program named ffmpeg${process.platform === 'win32' ? '.exe' : ''}.`);
    }
    return setFfmpegPath(file);
  });
  handle('ffmpeg:reset', async () => setFfmpegPath(''));
  // After installing ffmpeg (e.g. brew install ffmpeg): look again without a restart.
  handle('ffmpeg:recheck', async () => {
    engine.setFfmpegPath(settings.ffmpegPath);
    return ffmpegInfo();
  });

  handle('update:get', async () => updates.get());
  handle('update:check', async () => updates.check());
  // "Download later": no dialog for this version again; Settings still shows it.
  handle('update:skip', async () => {
    const v = updates.get().latest?.version;
    if (v) {
      updateSettings({ ...settings, skippedVersion: v });
      await saveSettings();
    }
    return updates.refresh();
  });

  handle('settings:get', async () => settings);

  handle('settings:set', async (patch = {}) => {
    // Folder paths and the ffmpeg binary only change through the native dialog.
    const { inputRoot, outputRoot, playlistConvertedRoot, ffmpegPath, ...rest } = patch;
    updateSettings({ ...settings, ...rest });
    await saveSettings();
    return settings;
  });

  const FOLDERS = {
    input: { key: 'inputRoot', title: 'Choose your music library' },
    output: { key: 'outputRoot', title: 'Choose where converted AIFF files go' },
    converted: { key: 'playlistConvertedRoot', title: 'Choose the folder with converted files' },
  };
  handle('dialog:pickFolder', async (kind) => {
    const folder = FOLDERS[kind];
    if (!folder) throw new Error('Unknown folder kind');
    const res = await dialog.showOpenDialog(win, {
      title: folder.title,
      defaultPath: settings[folder.key] || (kind === 'converted' && settings.outputRoot) || app.getPath('music'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return settings;
    updateSettings({ ...settings, [folder.key]: res.filePaths[0] });
    await saveSettings();
    return settings;
  });

  handle('engine:status', async () => engine.status(settings));
  handle('engine:scan', async () => exclusive(() => engine.scan(engineOpts())));
  handle('engine:convert', async () => exclusive(() => engine.convert(engineOpts())));
  handle('engine:cancel', async () => engine.cancel());

  handle('playlist:state', async () => ({ playlistPath: playlist.path, convertedRoot: convertedRoot(), match: publicMatch(playlist.match) }));

  handle('playlist:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a playlist',
      defaultPath: playlist.path ? path.dirname(playlist.path) : app.getPath('music'),
      properties: ['openFile'],
      filters: [{ name: 'Playlists', extensions: ['m3u8', 'm3u'] }],
    });
    if (!res.canceled && res.filePaths[0]) {
      playlist.path = res.filePaths[0];
      playlist.match = null;
      playlist.savedPath = null;
    }
    return { playlistPath: playlist.path, convertedRoot: convertedRoot(), match: publicMatch(playlist.match) };
  });

  handle('playlist:match', async () => {
    playlist.match = await engine.matchPlaylist({
      playlistPath: playlist.path,
      inputRoot: settings.inputRoot,
      outputRoot: settings.outputRoot,
      convertedRoot: convertedRoot(),
      safeNames: settings.safeNames,
    });
    playlist.savedPath = null;
    return publicMatch(playlist.match);
  });

  // Manually choose the file for one entry. Any audio file can be picked: a playable one
  // is used as-is, an original (e.g. FLAC) is swapped for its converted AIFF.
  handle('playlist:pickTrack', async (index) => {
    const entry = playlist.match?.entries[index];
    if (!Number.isInteger(index) || !entry) throw new Error('Match the playlist first.');
    const res = await dialog.showOpenDialog(win, {
      title: `Choose the file for “${entry.sourceName}”`,
      defaultPath: entry.target ? path.dirname(entry.target) : playlist.match.convertedRoot,
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: [...AUDIO_EXTS].map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return publicMatch(playlist.match);
    const picked = res.filePaths[0];
    const target = await resolveFile(playlist.match, picked);
    if (!target) {
      throw new Error(`“${path.basename(picked)}” can't play on the CDJ and has no converted copy yet. Run Convert first, or choose an AIFF/MP3.`);
    }
    Object.assign(entry, { status: 'manual', via: 'pick', reason: undefined, target, targetName: path.basename(target) });
    playlist.match.counts = countEntries(playlist.match.entries);
    return publicMatch(playlist.match);
  });

  // Look for all missing tracks in one folder (and its subfolders when recursive is on).
  handle('playlist:searchFolder', async () => {
    const m = playlist.match;
    if (!m) throw new Error('Match the playlist first.');
    if (!m.entries.some((e) => e.status === 'missing')) throw new Error('No missing tracks to look for.');
    if (playlist.searchAbort) throw new Error('A search is already running.');
    const res = await dialog.showOpenDialog(win, {
      title: settings.playlistSearchRecursive ? 'Choose a folder to search (including subfolders)' : 'Choose a folder to search',
      defaultPath: playlist.searchDir || m.convertedRoot || app.getPath('music'),
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    playlist.searchDir = res.filePaths[0];
    playlist.searchAbort = new AbortController();
    let last = 0;
    try {
      const search = await findMissingInFolder(m, playlist.searchDir, {
        recursive: settings.playlistSearchRecursive,
        signal: playlist.searchAbort.signal,
        onProgress: (p) => {
          if (Date.now() - last < 100) return;
          last = Date.now();
          win?.webContents.send('playlist:progress', p);
        },
      });
      return { match: publicMatch(m), search };
    } finally {
      playlist.searchAbort = null;
    }
  });
  handle('playlist:cancelSearch', async () => playlist.searchAbort?.abort(new Error('Search cancelled.')));

  handle('analyzer:pick', async (slot) => {
    if (!ANALYZER_SLOTS.has(slot)) throw new Error('Unknown analyzer slot.');
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a track to analyse',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTS].map((e) => e.slice(1)) }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return analyze(slot, res.filePaths[0]);
  });

  // Drag and drop: the preload turns the dropped File into its path (webUtils.getPathForFile),
  // so the page itself never sends a path (D23). Still checked: an absolute path to an audio file.
  handle('analyzer:file', async (slot, file) => {
    if (!ANALYZER_SLOTS.has(slot)) throw new Error('Unknown analyzer slot.');
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Drop a file from your disk.');
    if (!AUDIO_EXTS.has(path.extname(file).toLowerCase())) throw new Error('That isn’t an audio file.');
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error('Drop one audio file, not a folder.');
    return analyze(slot, file);
  });

  handle('analyzer:cancel', async (slot) => analyses[slot]?.abort());

  // Listen (Camelot page). macOS asks the user once; Windows has one global switch for desktop
  // apps. After a "no", only System Settings (and an app restart) can change it.
  handle('listen:access', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined' && process.platform === 'darwin') {
      return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    }
    return status;
  });

  // Line inputs (inputs 3/4 of an audio interface…): Chromium only gives a device's first two
  // channels, so these are recorded here through ffmpeg. macOS only; [] elsewhere.
  handle('listen:lineInputs', async () => {
    const ff = await engine.ffmpeg();
    return (await listLineInputs(ff.path)).map(({ name, channels }) => ({ name, channels, choices: channelChoices(channels) }));
  });

  // Records up to `seconds` from the chosen inputs, streams live columns as 'listen:column', then
  // analyses in memory (nothing is written). Resolves null when discarded (Listen closed).
  handle('listen:captureLine', async ({ device, channels, seconds = 10 } = {}) => {
    if (typeof device !== 'string' || !Array.isArray(channels)) throw new Error('Pick an input first.');
    if (lineCapture) throw new Error('Already listening.');
    const ff = await engine.ffmpeg();
    const input = (await listLineInputs(ff.path)).find((d) => d.name === device);
    if (!input) throw new Error(`${device} isn't connected.`);
    const ac = new AbortController();
    lineCapture = ac;
    try {
      const { samples, sampleRate } = await captureLine({
        ffmpegPath: ff.path,
        input: { format: 'avfoundation', device: `:${input.index}` }, // the index, looked up just now
        channels,
        inputChannels: input.channels,
        seconds: Math.min(30, Math.max(4, Number(seconds) || 10)),
        signal: ac.signal,
        onColumn: (rows, level) => win?.webContents.send('listen:column', { rows, level }),
      });
      if (ac.discard) return null;
      if (samples.length < 4 * sampleRate) throw new Error(`Only ${(samples.length / sampleRate).toFixed(1)} s came in. Listen for at least 4 s.`);
      return analyzeClip(samples, sampleRate);
    } finally {
      if (lineCapture === ac) lineCapture = null;
    }
  });

  // Stop early: analyse what came in, or drop it (discard) when Listen is closed.
  handle('listen:stopLine', async (discard = false) => {
    if (!lineCapture) return;
    lineCapture.discard = discard === true;
    lineCapture.abort();
  });

  // The captured clip arrives as samples; it's analysed in memory and never written anywhere.
  handle('listen:analyze', async (samples, sampleRate) => {
    if (!(samples instanceof Float32Array) || !(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error('That isn’t an audio clip.');
    if (samples.length > sampleRate * 30) throw new Error('The clip is too long (30 s at most).');
    return analyzeClip(samples, sampleRate);
  });

  handle('playlist:save', async () => {
    const m = playlist.match;
    if (!m) throw new Error('Match the playlist first.');
    const written = m.entries.filter((e) => e.target).length;
    if (!written) throw new Error('No tracks were found, so there is nothing to save.');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save the converted playlist',
      defaultPath: path.join(path.dirname(m.playlistPath), playlistFileName(m.playlistPath, settings.playlistPrefix)),
      filters: [{ name: 'Playlist', extensions: ['m3u8'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await writePlaylist(res.filePath, buildM3u(m.parsed, m.entries));
    playlist.savedPath = res.filePath;
    return { path: res.filePath, written, skipped: m.entries.length - written };
  });

  handle('shell:openPath', async (p) => {
    if (!allowedPath(p)) throw new Error('Path is outside the chosen folders');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  handle('shell:reveal', async (p) => {
    if (!allowedPath(p)) throw new Error('Path is outside the chosen folders');
    shell.showItemInFolder(p);
  });
  handle('shell:openLink', async (name) => {
    if (!Object.hasOwn(LINKS, name)) throw new Error('Unknown link');
    await shell.openExternal(LINKS[name]);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1056, // 960 of content + the 96px nav rail
    height: 820,
    minWidth: 776,
    minHeight: 600,
    title: 'AudioConverter',
    backgroundColor: '#c9c9c6', // = --bg in shared/styles/index.css
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!engine.busy || quitting) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep converting', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A conversion is still running.',
      detail: 'Everything converted so far is kept. The rest will be picked up next time.',
    });
    if (choice === 1) {
      quitting = true;
      engine.cancel();
      (running ?? Promise.resolve()).catch(() => {}).finally(() => win?.close());
    }
  });
  win.on('closed', () => {
    win = null;
    for (const ac of Object.values(analyses)) ac?.abort(); // don't leave ffmpeg decoding
    lineCapture?.abort(); // …or recording
  });

  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
}

// Last line of defence. Electron's default for an uncaught error in main is a modal dialog, and
// an error that repeats (e.g. once per decoded chunk) traps the user in a loop of them. Instead:
// log it, show it once in the window (same message at most every 10 s), keep the app running.
// Errors should still be handled where they happen; this only catches what slips through.
let lastCrash = { message: '', at: 0 };
function reportCrash(err) {
  const message = err?.message || String(err);
  console.error('[main] unexpected error:', err?.stack || message);
  const now = Date.now();
  if (message === lastCrash.message && now - lastCrash.at < 10_000) return;
  lastCrash = { message, at: now };
  win?.webContents.send('app:error', { message });
}
process.on('uncaughtException', reportCrash);
process.on('unhandledRejection', reportCrash);

// The page may open an audio input for Listen, from our own window, and nothing else: no
// camera, no screen capture, no other permission. Without a handler Electron grants everything.
function lockPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    callback(audioOnly && wc === win?.webContents && String(details.requestingUrl).startsWith('file:'));
  });
}

app.whenReady().then(async () => {
  lockPermissions();
  await loadSettings();
  engine.setFfmpegPath(settings.ffmpegPath);
  updates = createUpdates({
    version: app.getVersion(),
    skipped: () => settings.skippedVersion,
    onState: (s) => win?.webContents.send('update:state', s),
  });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
