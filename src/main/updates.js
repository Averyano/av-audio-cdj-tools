// Update check (desktop-app.md → Updates): asks GitHub for the latest published release once at
// launch (and on "Check now"), and tells the window what it found. It never downloads or
// installs anything; "Download now" opens the release page in the browser.

import fs from 'node:fs/promises';
import { net } from 'electron';
import { REPO } from '../engine/constants.js';
import { readRelease, compareVersions } from '../engine/release.js';

const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const LAUNCH_CHECK_MS = 3000; // after launch, so the window is up first
const TIMEOUT_MS = 15000;

// Latest published release as GitHub returns it, or null when there is none (404: nothing
// published yet, or the repo is private). AUDIOCONVERTER_RELEASE_FILE points at a JSON file
// instead, for testing the dialog without a real release (testing.md → UI smoke).
async function fetchLatest() {
  const file = process.env.AUDIOCONVERTER_RELEASE_FILE;
  if (file) return JSON.parse(await fs.readFile(file, 'utf8'));
  const res = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub is limiting requests; try again later' : `GitHub answered ${res.status}`);
  return res.json();
}

/**
 * version: this app's; skipped(): the version "Download later" put off; onState(state): every
 * change, for the window.
 * State: { current, status: 'idle'|'checking'|'ok'|'none'|'error', auto, checkedAt, error,
 *          latest: readRelease() | null, newer, skipped }
 */
export function createUpdates({ version, skipped, onState }) {
  let state = { current: version, status: 'idle', auto: false, checkedAt: null, error: null, latest: null, newer: false, skipped: false };
  let running = null;
  const set = (patch) => {
    state = { ...state, ...patch };
    state.skipped = !!state.latest && state.latest.version === skipped();
    onState(state);
    return state;
  };

  // auto: the launch check (the window may show the dialog) rather than "Check now".
  function check({ auto = false } = {}) {
    running ??= (async () => {
      set({ status: 'checking', auto, error: null });
      try {
        const latest = readRelease(await fetchLatest());
        return set({ status: latest ? 'ok' : 'none', latest, newer: !!latest && compareVersions(latest.version, version) > 0, checkedAt: new Date().toISOString() });
      } catch (err) {
        return set({ status: 'error', error: err.name === 'TimeoutError' ? 'No answer from GitHub' : err.message, checkedAt: new Date().toISOString() });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  setTimeout(() => check({ auto: true }), LAUNCH_CHECK_MS);

  return {
    get: () => state,
    check,
    refresh: () => set({}), // re-derive `skipped` after the setting changed
  };
}
