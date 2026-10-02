// Updates in the window (desktop-app.md → Updates): the About card in Settings, the green dot on
// the Settings rail item, and the "Update available" dialog. The check itself runs in main
// (src/main/updates.js), which pushes its state here.

import { $, el, showDialog } from '../shared/js/dom.js';
import { timeAgo } from '../../engine/release.js';

let state = null; // main's update state (updates.js → createUpdates)
let shownFor = null; // the version the dialog was opened for in this session

function renderAbout() {
  const s = state;
  const latest = s.latest;
  $('#about-version').textContent = s.current;
  $('#about-dot').hidden = !s.newer;
  $('#about-update').hidden = !s.newer;
  if (s.newer) $('#about-update').textContent = `Update to ${latest.version}`;
  $('#about-check').disabled = s.status === 'checking';
  const checked = s.checkedAt ? ` Checked ${timeAgo(s.checkedAt)}.` : '';
  $('#about-status').textContent = {
    idle: 'Checking for updates shortly…',
    checking: 'Checking for updates…',
    ok: s.newer
      ? `Version ${latest.version} is available${latest.publishedAt ? `, released ${timeAgo(latest.publishedAt)}` : ''}.`
      : `Up to date.${checked}`,
    none: `No release has been published yet.${checked}`,
    error: `Couldn't check for updates: ${s.error}.${checked}`,
  }[s.status];
  document.querySelector('[data-nav="settings"]').classList.toggle('has-update', !!s.newer);
}

function fillDialog() {
  const { current, latest } = state;
  $('#update-sub').textContent = `A new version (v${latest.version}) is available. You're on v${current}.`;
  $('#update-ago').textContent = latest.publishedAt ? `Released ${timeAgo(latest.publishedAt)}` : '';
  $('#update-notes').replaceChildren(...latest.notes.items.map((text) => el('li', { textContent: text })));
  $('#update-notes').hidden = !latest.notes.items.length;
  $('#update-more').textContent = `… and ${latest.notes.more} more on the release page.`;
  $('#update-more').hidden = !latest.notes.more;
}

export function initUpdates({ api, call }) {
  const dialog = $('#update-dialog');
  const apply = (s) => {
    state = s;
    renderAbout();
    if (dialog.open) fillDialog();
    // Only the launch check opens the dialog: after "Check now" the About card already shows it.
    if (s.auto && s.newer && !s.skipped && shownFor !== s.latest.version) {
      shownFor = s.latest.version;
      fillDialog();
      showDialog(dialog);
    }
  };
  const openReleases = () => call(api.openLink, 'releases').catch((err) => { $('#about-status').textContent = err.message; });

  $('#about-check').addEventListener('click', () => call(api.checkUpdate).then(apply, () => {}));
  $('#about-update').addEventListener('click', openReleases);
  $('#update-now').addEventListener('click', () => {
    dialog.close();
    openReleases();
  });
  // "Download later": main remembers the version, so this release doesn't ask again.
  $('#update-later').addEventListener('click', () => {
    dialog.close();
    call(api.skipUpdate).then(apply, () => {});
  });
  // "Released 3 days 21 hours ago" keeps counting while the window is open.
  setInterval(() => {
    if (!state) return;
    renderAbout();
    if (dialog.open) fillDialog();
  }, 60_000);

  api.onUpdate(apply);
  call(api.getUpdate).then(apply, () => {});
}
