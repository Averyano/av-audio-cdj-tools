// Renderer: talks to the main process only through window.api (preload.cjs).
// All file names are inserted with textContent — never as HTML.

import { $, el } from './shared/js/dom.js';
import { initCamelot, setTrack } from './camelot/view.js';
import { initListen } from './camelot/listen.js';
import { initSettings, initFfmpeg } from './settings/view.js';
import { initUpdates } from './settings/updates.js';
import { sanitizePrefs } from '../engine/prefs.js';
import { initAnalyzer } from './analyzer/view.js';

const api = window.api;

const state = {
  info: null,
  settings: null,
  summary: null,
  failures: [],
  busy: null, // 'scan' | 'convert' | null
  // Playlist card. The main process owns the real match; this is what we display.
  pl: { path: null, match: null, busy: false, saved: null, message: '', error: false, searching: false, searchFolders: 0 },
};

const nf = new Intl.NumberFormat();
const fmtNum = (n) => (n == null ? '—' : nf.format(n));
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtBytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, b / 1024 ** 2).toFixed(0)} MB`);
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ---------- rendering ----------

function setPath(box, value, placeholder = 'No folder chosen') {
  box.replaceChildren(el('span', { textContent: value || placeholder }));
  box.classList.toggle('placeholder', !value);
  box.title = value || '';
}

function renderFolders() {
  for (const kind of ['input', 'output']) {
    const value = state.settings[`${kind}Root`];
    setPath($(`#${kind}-path`), value);
    document.querySelector(`[data-open="${kind}"]`).disabled = !value || !!state.busy;
    document.querySelector(`[data-pick="${kind}"]`).disabled = !!state.busy;
  }
}

function renderOptions() {
  const box = $('#formats');
  if (!box.children.length) {
    for (const f of state.info.formats) {
      const input = el('input', { type: 'checkbox', value: f.id });
      input.addEventListener('change', onFormatsChange);
      box.append(el('label', { className: 'toggle' }, input, f.label));
    }
  }
  for (const input of box.querySelectorAll('input')) {
    input.checked = state.settings.formats.includes(input.value);
    input.disabled = !!state.busy;
  }
  $('#safe-names').checked = state.settings.safeNames;
  $('#safe-names').disabled = !!state.busy;
  $('#workers').value = state.settings.workers;
  $('#workers').disabled = !!state.busy;
}

function renderStats() {
  const s = state.summary;
  const c = s?.counts;
  $('#stat-total').textContent = fmtNum(c?.selected);
  const labels = state.info.formats.filter((f) => state.settings.formats.includes(f.id)).map((f) => f.label);
  $('#stat-total-label').textContent = labels.length ? `${labels.join(' + ')} tracks` : 'tracks';
  $('#stat-done').textContent = fmtNum(c?.upToDate);
  $('#stat-pending').textContent = fmtNum(c?.pending);
  $('#stat-pending').parentElement.classList.toggle('accent', c?.pending > 0);
  const lastFailed = s?.lastRun?.failed;
  $('#stat-failed').textContent = s?.lastRun ? fmtNum(lastFailed) : '—';
  $('#stat-failed').parentElement.classList.toggle('bad', lastFailed > 0);

  const lr = s?.lastRun;
  $('#last-run').textContent = lr
    ? `Last converted ${fmtDate(lr.finishedAt)} · ${fmtNum(lr.converted)} track${lr.converted === 1 ? '' : 's'}${lr.cancelled ? ' (stopped early)' : ''}`
    : 'Never converted';

  const bits = [];
  if (c) {
    bits.push(`${fmtNum(c.audio)} audio files in ${fmtNum(c.folders)} folders`);
    if (c.compatible) bits.push(`${fmtNum(c.compatible)} already CDJ-playable (skipped)`);
    if (c.hires) bits.push(`${fmtNum(c.hires)} hi-res → resampled`);
    if (c.missing) bits.push(`${fmtNum(c.missing)} removed from library (outputs kept)`);
    if (c.pending && s.estimate?.bytes) {
      const free = s.estimate.freeBytes != null ? `, ${fmtBytes(s.estimate.freeBytes)} free` : '';
      bits.push(`needs ~${fmtBytes(s.estimate.bytes)}${free}`);
    }
    bits.push(`scanned ${fmtDate(s.scannedAt)}`);
  }
  $('#stat-detail').textContent = bits.join(' · ');

  renderNotes($('#warnings'), (s?.warnings ?? []).map((w) => ({
    kind: w.code === 'diskSpace' || w.code === 'unreadable' ? 'error' : 'warn',
    title: w.message,
    items: w.examples.map((text) => ({ text })),
    more: w.count - w.examples.length,
  })));

  renderNotes($('#failures'), state.failures.length ? [{
    kind: 'error',
    open: true,
    title: `${fmtNum(state.failures.length)} track${state.failures.length === 1 ? '' : 's'} failed — they will be retried next time`,
    items: state.failures.map((f) => ({ text: `${f.key} — ${f.message}`, reveal: f.abs })),
  }] : []);
}

function renderNotes(container, notes) {
  container.replaceChildren(...notes.map((n) => {
    const list = el('ul', {}, ...n.items.map((item) => {
      const li = el('li', { textContent: item.text });
      if (item.reveal) {
        const b = el('button', { className: 'link', textContent: 'Show file' });
        b.addEventListener('click', () => call(api.reveal, item.reveal).catch(showError));
        li.append(b);
      }
      return li;
    }));
    if (n.more > 0) list.append(el('li', { textContent: `… and ${fmtNum(n.more)} more` }));
    return el('details', { className: `note ${n.kind}`, open: !!n.open }, el('summary', { textContent: n.title }), list);
  }));
}

function renderActions() {
  const ready = !!(state.settings.inputRoot && state.settings.outputRoot && state.settings.formats.length);
  const pending = state.summary?.counts?.pending;
  $('#scan-btn').disabled = !ready || !!state.busy;
  $('#convert-btn').disabled = !ready || !!state.busy || pending === 0;
  $('#convert-btn').textContent = pending ? `Convert ${fmtNum(pending)} track${pending === 1 ? '' : 's'}` : 'Convert';
  $('#cancel-btn').hidden = !state.busy;
  $('[data-nav="converter"]').classList.toggle('busy', !!state.busy);
}

// ---------- navigation ----------

// Views are static sections in index.html; switching only toggles visibility, so a
// running scan/convert keeps going (and its rail LED stays lit) on other views.
function showView(name) {
  document.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('[data-nav]').forEach((b) => {
    if (b.dataset.nav === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

// ---------- playlist card ----------

const PL_REASONS = {
  'not-converted': 'In your library but not converted yet — run Convert',
  unreadable: 'Source file could not be read',
  'not-found': 'Not found',
  ambiguous: 'Several possible matches — choose one',
  unsupported: 'Not playable on the CDJ and not converted',
};

// Mirrors main.js#convertedRoot.
const plRoot = () => (state.settings.playlistUseCustomRoot ? state.settings.playlistConvertedRoot : state.settings.outputRoot);
const cleanPrefix = (p) => String(p ?? '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').slice(0, 40);
function plFileName() {
  const name = (state.pl.path ?? '').split(/[\\/]/).pop();
  return `${cleanPrefix($('#pl-prefix').value)}${name.replace(/\.[^.]+$/, '')}.m3u8`;
}

function renderPlaylist() {
  const { pl, settings: s } = state;
  const root = plRoot();
  const custom = s.playlistUseCustomRoot;
  setPath($('#pl-path'), pl.path, 'No playlist chosen');
  setPath($('#pl-root'), root, custom ? 'No folder chosen' : 'Same as Output — choose an output folder above');
  $('#pl-root').classList.toggle('locked', !custom);
  $('#pl-custom-root').checked = custom;
  $('#pl-custom-root').disabled = pl.busy;
  $('#pl-pick').disabled = pl.busy;
  $('#pl-root-pick').disabled = !custom || pl.busy;
  $('#pl-open').disabled = !pl.path;
  $('#pl-root-open').disabled = !root;
  $('#pl-match').disabled = !pl.path || !root || pl.busy || pl.searching;
  $('#pl-match').textContent = pl.busy ? 'Looking up tracks…' : 'Convert playlist';
  // Primary until there's a result; then Create playlist is the next step.
  $('#pl-match').classList.toggle('primary', !pl.match);

  const status = $('#pl-status');
  status.hidden = !pl.message;
  status.classList.toggle('error', pl.error);
  status.replaceChildren(pl.message);
  if (pl.saved && !pl.error) {
    const b = el('button', { className: 'link', textContent: 'Show file' });
    b.addEventListener('click', () => call(api.reveal, pl.saved.path).catch(showPlError));
    status.append(' ', b);
  }

  const m = pl.match;
  const c = m?.counts;
  $('#pl-summary').textContent = c
    ? `${fmtNum(c.total)} tracks · ${fmtNum(c.found + c.original + c.manual)} found · ${fmtNum(c.missing)} not found`
    : '';
  // Track list and save row appear after Convert playlist; Find in folder only while tracks are missing.
  $('#pl-table').hidden = !m;
  $('#pl-save').hidden = !m;
  $('#pl-find').hidden = !m || (!c.missing && !pl.searching);
  if (!m) return;

  $('#pl-find-btn').disabled = !c.missing || pl.searching || pl.busy;
  $('#pl-find-label').textContent = pl.searching ? `Searching… ${fmtNum(pl.searchFolders)} folders` : 'Find in folder';
  $('#pl-find-cancel').hidden = !pl.searching;
  $('#pl-recursive').checked = s.playlistSearchRecursive;
  $('#pl-recursive').disabled = pl.searching;

  $('#pl-rows').replaceChildren(...m.entries.map((e, i) => {
    const ok = e.status !== 'missing';
    const right = el('span', { className: 'pl-cell' });
    if (e.target) {
      right.append(el('span', { className: 'pl-name', textContent: e.targetName, title: e.target }));
      if (e.status === 'original') right.append(el('span', { className: 'tag', textContent: 'original', title: 'Already CDJ-playable, kept as it is' }));
      if (e.status === 'manual') right.append(el('span', { className: 'tag', textContent: e.via === 'folder' ? 'found in folder' : 'chosen' }));
    } else {
      right.append(el('span', { className: 'pl-reason', textContent: PL_REASONS[e.reason] ?? 'Not found' }));
    }
    let action = el('span');
    if (!ok || e.status === 'manual') {
      action = el('button', { className: 'icon-btn', title: 'Choose the file manually', ariaLabel: `Choose a file for ${e.sourceName}` }, el('span', { className: 'glyph glyph-folder' }));
      action.disabled = pl.searching;
      action.addEventListener('click', () => pickPlaylistTrack(e.index));
    }
    return el('div', { className: `pl-row ${ok ? 'found' : 'missing'}` },
      el('span', { className: 'pl-num', textContent: String(i + 1) }),
      el('span', { className: 'pl-name', textContent: e.sourceName, title: e.sourcePath ?? e.location }),
      right,
      action);
  }));

  const written = c.total - c.missing;
  const left = c.missing ? ` · ${fmtNum(c.missing)} not found will be left out` : '';
  $('#pl-save-name').textContent = `→ ${plFileName()} · ${fmtNum(written)} tracks${left}`;
  $('#pl-save-btn').disabled = !written || pl.busy || pl.searching;
}

function showPlError(err) {
  Object.assign(state.pl, { message: `⚠ ${err.message}`, error: true, saved: null });
  renderPlaylist();
}

async function pickPlaylist() {
  try {
    const res = await call(api.pickPlaylist);
    if (res.playlistPath !== state.pl.path) Object.assign(state.pl, { path: res.playlistPath, match: null, saved: null, message: '', error: false });
    renderPlaylist();
  } catch (err) {
    showPlError(err);
  }
}

async function matchPlaylist() {
  Object.assign(state.pl, { busy: true, message: '', error: false, saved: null });
  renderPlaylist();
  try {
    state.pl.match = await call(api.matchPlaylist);
    const c = state.pl.match.counts;
    state.pl.message = c.missing
      ? `${fmtNum(c.missing)} track${c.missing === 1 ? '' : 's'} not found — use the folder button to choose them, or they'll be left out.`
      : 'All tracks found.';
  } catch (err) {
    Object.assign(state.pl, { match: null, message: `⚠ ${err.message}`, error: true });
  }
  state.pl.busy = false;
  renderPlaylist();
}

async function pickPlaylistTrack(index) {
  try {
    state.pl.match = await call(api.pickPlaylistTrack, index);
    Object.assign(state.pl, { saved: null, message: '', error: false });
    renderPlaylist();
  } catch (err) {
    showPlError(err);
  }
}

async function findInFolder() {
  const missingBefore = state.pl.match?.counts.missing ?? 0;
  Object.assign(state.pl, { searching: true, searchFolders: 0, message: '', error: false, saved: null });
  renderPlaylist();
  try {
    const res = await call(api.searchPlaylistFolder);
    if (res) {
      state.pl.match = res.match;
      const { resolved, filesSearched, folder } = res.search;
      const where = `“${folder.split(/[\\/]/).pop()}”`;
      const checked = `${fmtNum(filesSearched)} audio file${filesSearched === 1 ? '' : 's'} checked`;
      state.pl.message = resolved
        ? `Found ${fmtNum(resolved)} of ${fmtNum(missingBefore)} missing tracks in ${where} (${checked}).`
        : `None of the missing tracks were found in ${where} (${checked}).`;
    }
  } catch (err) {
    const cancelled = /cancel/i.test(err.message);
    Object.assign(state.pl, { message: cancelled ? 'Search cancelled.' : `⚠ ${err.message}`, error: !cancelled });
  }
  state.pl.searching = false;
  renderPlaylist();
}

async function savePlaylist() {
  try {
    const res = await call(api.savePlaylist);
    if (!res) return; // save dialog cancelled
    const skipped = res.skipped ? ` (${fmtNum(res.skipped)} not found left out)` : '';
    Object.assign(state.pl, { saved: res, error: false, message: `Saved ${res.path.split(/[\\/]/).pop()} · ${fmtNum(res.written)} tracks${skipped}.` });
    renderPlaylist();
  } catch (err) {
    showPlError(err);
  }
}

// Any change the match depends on invalidates it (main.js clears its copy too).
function clearPlaylistMatch() {
  Object.assign(state.pl, { match: null, saved: null, message: '', error: false });
}

function render() {
  renderFolders();
  renderOptions();
  renderStats();
  renderActions();
  renderPlaylist();
}

function setStatus(text, sub = '', progress = null) {
  $('#status').textContent = text;
  $('#status-sub').textContent = sub;
  const bar = $('#progress');
  bar.hidden = progress === null;
  bar.classList.toggle('indeterminate', progress === 'indeterminate');
  $('#progress-fill').style.width = typeof progress === 'number' ? `${Math.round(progress * 100)}%` : '';
}

function idleStatus() {
  const s = state.settings;
  if (!s.inputRoot || !s.outputRoot) return setStatus('Choose a library and an output folder to begin.');
  if (!s.formats.length) return setStatus('Tick at least one format to convert.');
  const c = state.summary?.counts;
  if (!c) return setStatus('Ready. Scan to see what needs converting.');
  if (c.pending === 0) return setStatus('Everything is up to date.', c.selected ? 'New or changed tracks will show up on the next scan.' : '');
  return setStatus(`${fmtNum(c.pending)} track${c.pending === 1 ? '' : 's'} to convert.`);
}

function showError(err) {
  setStatus(`⚠ ${err.message}`);
}

// ---------- actions ----------

async function run(kind) {
  if (state.busy) return;
  state.busy = kind;
  if (kind === 'convert') state.failures = [];
  render();
  setStatus(kind === 'scan' ? 'Scanning…' : 'Preparing…', '', 'indeterminate');
  try {
    const result = await call(kind === 'scan' ? api.scan : api.convert);
    state.summary = result;
    if (kind === 'convert') {
      state.failures = result.failures ?? [];
      const lr = result.lastRun;
      state.busy = null;
      render();
      const msg = lr.cancelled
        ? `Stopped. Converted ${fmtNum(lr.converted)} of ${fmtNum(lr.pending)}.`
        : `Done. Converted ${fmtNum(lr.converted)} track${lr.converted === 1 ? '' : 's'} in ${fmtDuration(lr.durationMs)}.`;
      setStatus(msg, lr.failed ? `${fmtNum(lr.failed)} failed — see the list above.` : '');
      return;
    }
    state.busy = null;
    render();
    idleStatus();
  } catch (err) {
    state.busy = null;
    render();
    if (/cancel/i.test(err.message)) setStatus('Scan cancelled.');
    else showError(err);
  }
}

function onProgress(p) {
  if (!state.busy) return;
  switch (p.phase) {
    case 'walk':
      setStatus(`Scanning folders… ${fmtNum(p.found)} audio files found`, '', 'indeterminate');
      break;
    case 'probe':
      setStatus(`Reading new tracks… ${fmtNum(p.done)} / ${fmtNum(p.total)}`, '', p.total ? p.done / p.total : 'indeterminate');
      break;
    case 'check':
      setStatus(`Checking output… ${fmtNum(p.done)} / ${fmtNum(p.total)}`, '', p.total ? p.done / p.total : 'indeterminate');
      break;
    case 'convert': {
      const n = p.converted + p.failed;
      const eta = p.etaMs != null && n > 0 ? ` · about ${fmtDuration(p.etaMs)} left` : '';
      const failed = p.failed ? ` · ${fmtNum(p.failed)} failed` : '';
      const current = p.active.length ? p.active.map((k) => k.split('/').pop()).join('  ·  ') : '';
      setStatus(`Converting ${fmtNum(n)} / ${fmtNum(p.total)}${failed}${eta}`, current, p.total ? n / p.total : 0);
      // Tick the tiles live; the final numbers arrive with the result.
      const c = state.summary?.counts;
      if (c) {
        $('#stat-pending').textContent = fmtNum(p.total - p.converted);
        $('#stat-done').textContent = fmtNum(Math.max(0, c.selected - c.unreadable - p.total) + p.converted);
      }
      break;
    }
    default:
  }
}

async function pick(kind) {
  try {
    const before = state.settings[`${kind}Root`];
    state.settings = await call(api.pickFolder, kind);
    if (state.settings[`${kind}Root`] !== before) await refreshAfterChange();
    else render();
  } catch (err) {
    showError(err);
  }
}

async function saveSettings(patch) {
  try {
    state.settings = await call(api.saveSettings, patch);
  } catch (err) {
    showError(err);
  }
}

let rescanTimer = null;
async function refreshAfterChange() {
  state.summary = null;
  state.failures = [];
  clearPlaylistMatch();
  render();
  idleStatus();
  clearTimeout(rescanTimer);
  if (state.settings.inputRoot && state.settings.outputRoot && state.settings.formats.length) {
    rescanTimer = setTimeout(() => run('scan'), 250);
  }
}

async function onFormatsChange() {
  const formats = [...$('#formats').querySelectorAll('input:checked')].map((i) => i.value);
  await saveSettings({ formats });
  await refreshAfterChange();
}

// ---------- boot ----------

// Unexpected errors (main's safety net, or this page's own) show in a dismissible banner instead
// of breaking the page. Expected failures are still shown where they happen (status, cards).
function showAppError(message) {
  const text = String(message || 'Unknown error').trim();
  $('#app-error-text').textContent = /[.!?]$/.test(text) ? text : `${text}.`;
  $('#app-error').hidden = false;
}

function wireAppErrors() {
  $('#app-error-close').addEventListener('click', () => { $('#app-error').hidden = true; });
  api.onAppError(({ message }) => showAppError(message));
  window.addEventListener('error', (e) => showAppError(e.message));
  window.addEventListener('unhandledrejection', (e) => showAppError(e.reason?.message || String(e.reason)));
}

async function boot() {
  wireAppErrors();
  try {
    [state.info, state.settings] = await Promise.all([call(api.info), call(api.getSettings)]);
  } catch (err) {
    showError(err);
    return;
  }
  // ffmpeg's status lives in Settings; the converter only warns when it's missing.
  const ffmpegChanged = (ff) => { $('#ffmpeg-missing').hidden = !ff.error; };
  ffmpegChanged(state.info.ffmpeg);
  initFfmpeg({ api, call, info: state.info.ffmpeg, platform: state.info.platform, onChange: ffmpegChanged });
  $('#ffmpeg-missing-open').addEventListener('click', () => showView('settings'));

  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.nav)));
  $('#contact-email').addEventListener('click', () => {
    $('#contact-note').hidden = true;
    call(api.openLink, 'email').catch(() => { $('#contact-note').hidden = false; });
  });
  // The fader can fire dozens of changes a second; save once it settles.
  let camelotTimer = null;
  // Preferences are read through sanitizePrefs, so a main process from before prefs existed
  // (or an old settings.json) still yields every default.
  const prefs = () => sanitizePrefs(state.settings.prefs);
  const colors = () => prefs().analyzer.spectrogramColors;
  initAnalyzer({
    api, call, mode: () => (prefs().analyzer.checkHiRes ? 'hires' : 'lossless'), colors,
    // "Use on Camelot wheel": the track goes onto the deck (fader at 0 %) and the wheel opens.
    useOnWheel: (track) => {
      setTrack(track);
      showView('camelot');
    },
  });
  initListen({
    api, call, apply: setTrack, autoApply: () => prefs().camelot.autoApplyListen, colors,
    savedInput: () => state.settings.listenInput,
    saveInput: (value) => saveSettings({ listenInput: value }),
  });
  initSettings({
    get: prefs,
    save: (section, key, value) => saveSettings({ prefs: { ...prefs(), [section]: { ...prefs()[section], [key]: value } } })
      .then(() => document.dispatchEvent(new Event('prefs:change'))),
  });
  initUpdates({ api, call });
  initCamelot(state.settings.camelot, (deck) => {
    clearTimeout(camelotTimer);
    camelotTimer = setTimeout(() => saveSettings({ camelot: deck }), 300);
  });
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.pick)));
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    call(api.openPath, state.settings[`${b.dataset.open}Root`]).catch(showError);
  }));
  $('#safe-names').addEventListener('change', async (e) => {
    await saveSettings({ safeNames: e.target.checked });
    await refreshAfterChange();
  });
  $('#workers').addEventListener('change', (e) => saveSettings({ workers: Number(e.target.value) }).then(render));
  $('#scan-btn').addEventListener('click', () => run('scan'));
  $('#convert-btn').addEventListener('click', () => run('convert'));
  $('#cancel-btn').addEventListener('click', () => {
    setStatus('Stopping…', '', 'indeterminate');
    call(api.cancel).catch(showError);
  });
  api.onProgress(onProgress);

  $('#pl-pick').addEventListener('click', pickPlaylist);
  $('#pl-open').addEventListener('click', () => call(api.reveal, state.pl.path).catch(showPlError));
  $('#pl-root-open').addEventListener('click', () => call(api.openPath, plRoot()).catch(showPlError));
  $('#pl-root-pick').addEventListener('click', async () => {
    try {
      const before = state.settings.playlistConvertedRoot;
      state.settings = await call(api.pickFolder, 'converted');
      if (state.settings.playlistConvertedRoot !== before) clearPlaylistMatch();
      renderPlaylist();
    } catch (err) {
      showPlError(err);
    }
  });
  $('#pl-custom-root').addEventListener('change', async (e) => {
    await saveSettings({ playlistUseCustomRoot: e.target.checked });
    clearPlaylistMatch();
    renderPlaylist();
  });
  $('#pl-match').addEventListener('click', matchPlaylist);
  $('#pl-save-btn').addEventListener('click', savePlaylist);
  $('#pl-find-btn').addEventListener('click', findInFolder);
  $('#pl-find-cancel').addEventListener('click', () => call(api.cancelPlaylistSearch).catch(showPlError));
  $('#pl-recursive').addEventListener('change', (e) => saveSettings({ playlistSearchRecursive: e.target.checked }));
  api.onPlaylistProgress((p) => {
    if (!state.pl.searching) return;
    state.pl.searchFolders = p.folders;
    $('#pl-find-label').textContent = `Searching… ${fmtNum(p.folders)} folders`;
  });
  $('#pl-prefix').value = state.settings.playlistPrefix;
  let prefixTimer = null;
  $('#pl-prefix').addEventListener('input', () => {
    renderPlaylist(); // live file-name preview
    clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => saveSettings({ playlistPrefix: $('#pl-prefix').value }), 300);
  });
  try {
    const pl = await call(api.playlistState);
    Object.assign(state.pl, { path: pl.playlistPath, match: pl.match });
  } catch { /* nothing chosen yet */ }

  // Show the last run straight away, then refresh counts with a scan.
  try {
    const status = await call(api.status);
    if (status?.lastRun) state.summary = { lastRun: status.lastRun };
  } catch { /* first launch */ }
  render();
  idleStatus();
  if (state.settings.inputRoot && state.settings.outputRoot && state.settings.formats.length) run('scan');
}

boot();
