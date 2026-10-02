// Settings view: one card per section of engine/prefs.js, one row per preference. Values come
// from settings.prefs and are saved on every change (ui.md → Settings). The ffmpeg card is static
// markup in index.html, filled by initFfmpeg: its path only changes through a native dialog (D18).
// The About card is filled by settings/updates.js.

import { $, el, showDialog } from '../shared/js/dom.js';
import { PREF_SECTIONS } from '../../engine/prefs.js';

// One control per pref type.
const CONTROLS = {
  toggle: (value, onChange) => {
    const input = el('input', { type: 'checkbox', className: 'switch-control', checked: value });
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  },
  // A radio group drawn as pills; the picked one is solid onyx, like the tempo range buttons.
  choice: (value, onChange, pref, name) => el('span', { className: 'segmented', role: 'radiogroup', ariaLabel: pref.label },
    ...pref.options.map((o) => {
      const input = el('input', { type: 'radio', name, value: o.value, checked: o.value === value });
      input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
      return el('label', {}, input, el('span', { textContent: o.label }));
    })),
};

/** get() → current prefs (sanitized); save(sectionId, key, value) persists one change. */
export function initSettings({ get, save }) {
  const prefs = get();
  document.querySelector('#settings-sections').replaceChildren(...PREF_SECTIONS.map((section) => el('section',
    { className: 'card settings-section', ariaLabel: section.title },
    el('h2', { textContent: section.title }),
    ...section.prefs.map((p) => el(p.type === 'choice' ? 'div' : 'label', { className: 'setting' },
      el('span', { className: 'setting-text' },
        el('span', { className: 'setting-label', textContent: p.label }),
        p.hint ? el('span', { className: 'setting-hint', textContent: p.hint }) : null),
      CONTROLS[p.type](prefs[section.id][p.key], (value) => save(section.id, p.key, value), p, `pref-${section.id}-${p.key}`))))));
}

// How to get ffmpeg, per OS: the "ffmpeg is needed" dialog and the Download row.
const GET_FFMPEG = {
  darwin: ['Easiest: with Homebrew, run ', el('code', { textContent: 'brew install ffmpeg' }), ' in Terminal, then click Check again. Or download a Mac build from ffmpeg.org and choose its ffmpeg program.'],
  win32: ['Download a Windows build from ffmpeg.org, unzip it, then choose the ffmpeg.exe in its bin folder.'],
  linux: ['Install it with your package manager, e.g. ', el('code', { textContent: 'sudo apt install ffmpeg' }), ', then click Check again.'],
};

// ff: app:info's ffmpeg, {version, soxr, source, path, customPath} or {error, customPath}.
function renderFfmpeg(ff) {
  const chip = $('#ffmpeg-chip');
  chip.classList.toggle('bad', !!ff.error);
  chip.textContent = ff.error ? 'ffmpeg missing' : `ffmpeg ${ff.version}${ff.soxr ? ' · soxr' : ''}`;
  chip.title = ff.error ?? ff.path;
  // A chosen binary that stopped working (moved, deleted, blocked): say what runs instead.
  const lost = ff.customPath && ff.source !== 'custom' ? `The ffmpeg you chose (${ff.customPath}) doesn't run. ` : '';
  $('#ffmpeg-hint').textContent = lost + (ff.error
    ? 'No ffmpeg was found, so nothing can be converted or analysed. Install it (see below), then click Check again, or choose it.'
    : ff.source === 'bundled' ? 'Using the copy that npm installed with the source code (ffmpeg-static).'
      : `Using ${ff.source === 'custom' ? 'the one you chose' : 'the one on this computer'}: ${ff.path}.`);
  $('#ffmpeg-reset').hidden = !ff.customPath;
}

/**
 * info: app:info's ffmpeg; platform: process.platform; onChange(ff) after any change. Fills the
 * Settings card and, when no ffmpeg is found at launch, opens the "ffmpeg is needed" dialog.
 */
export function initFfmpeg({ api, call, info, platform, onChange }) {
  const dialog = $('#ffmpeg-dialog');
  const tip = GET_FFMPEG[platform] ?? GET_FFMPEG.linux;
  $('#ffmpeg-dialog-tip').append(...tip);
  $('#ffmpeg-download-hint').append('Only needed when ffmpeg is missing above. Opens ffmpeg.org in your browser. ', ...tip.map((n) => (typeof n === 'string' ? n : n.cloneNode(true))));
  const errors = [$('#ffmpeg-error'), $('#ffmpeg-dialog-error')];
  const fail = (err) => errors.forEach((e) => { e.textContent = err.message; e.hidden = false; });
  const update = (ff) => {
    renderFfmpeg(ff);
    onChange(ff);
    if (!ff.error) dialog.close();
  };
  const change = (fn) => {
    errors.forEach((e) => { e.hidden = true; });
    call(fn).then(update, fail);
  };
  const download = () => {
    errors.forEach((e) => { e.hidden = true; });
    call(api.openLink, 'ffmpeg').catch(fail);
  };
  $('#ffmpeg-pick').addEventListener('click', () => change(api.pickFfmpeg));
  $('#ffmpeg-dialog-pick').addEventListener('click', () => change(api.pickFfmpeg));
  $('#ffmpeg-reset').addEventListener('click', () => change(api.resetFfmpeg));
  $('#ffmpeg-recheck').addEventListener('click', () => change(api.recheckFfmpeg));
  $('#ffmpeg-dialog-recheck').addEventListener('click', () => change(api.recheckFfmpeg));
  $('#ffmpeg-download').addEventListener('click', download);
  $('#ffmpeg-dialog-download').addEventListener('click', download);
  $('#ffmpeg-dialog-close').addEventListener('click', () => dialog.close());
  renderFfmpeg(info);
  if (info.error) showDialog(dialog);
}
