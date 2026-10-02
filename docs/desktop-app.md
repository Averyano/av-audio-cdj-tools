# Desktop app (Electron shell, IPC, settings, packaging)

## Scope & files

| File | Role |
|---|---|
| `src/main/main.js` | App lifecycle, window, settings file, native dialogs, shell access, IPC handlers, one `Engine` instance |
| `src/main/preload.cjs` | The only bridge to the page: `window.api` via `contextBridge` |
| `src/main/updates.js` | The update check (*Updates*): `createUpdates({version, skipped, onState})` |
| `.github/workflows/release.yml`, `.github/release-notes.md` | Release builds and the notes template (*Releases*) |
| `package.json` → `scripts`, `build`, `allowScripts` | Run and packaging config (electron-builder) |

Rendering and visuals live in ui.md. The engine is in engine.md.

## Behaviour

### Development workflow
- **No dev server, port, bundler or HMR:**
  - `npm start` → `electron .` runs `src/main/main.js`.
  - The window loads `src/renderer/index.html` straight from disk (`file://`) with `loadFile`.
  - The page reaches Node only through `window.api` (IPC), never over the network.
- **Applying changes:**

| Changed | Do |
|---|---|
| `src/renderer/**` (HTML, CSS, `app.js`, fonts, images) | Reload the window: **Cmd/Ctrl+R** or View → Reload. State resets and the auto-scan runs again. |
| `src/main/**`, `src/engine/**`, `package.json` | Quit the app and run `npm start` again |

- **DevTools:** **Alt+Cmd+I** / View → Toggle Developer Tools (console, elements, live CSS). The default Electron menu is kept on purpose.
- **Remote debugging** (automation and screenshots): `npx electron . --remote-debugging-port=9333`, then `chrome://inspect` or CDP (testing.md → *UI smoke*). It isn't enabled in normal runs.
- **Sandbox state:** `AUDIOCONVERTER_DATA_DIR=<tmp>` points settings and manifests elsewhere.
- **Auto-reload:** if wanted later, add a small watcher (e.g. `node --watch`-style restart for main, `webContents.reload()` for renderer files). Nothing is installed for it now.

### Lifecycle
1. On `app.whenReady`: `loadSettings()` → `registerIpc()` → `createWindow()`.
2. macOS `activate` re-creates the window if none exists.
3. `window-all-closed` quits on every platform; it's a single-window utility.

### Window & security
- **Size:** 1056×820, minimum 776×600 (960/680 of content plus the 96px nav rail), background `#c9c9c6` (matches `--bg`, day theme). Shown on `ready-to-show` to avoid a white flash.
- **`webPreferences`:**
  - `contextIsolation: true`
  - `sandbox: true`
  - `nodeIntegration: false`
  - preload `preload.cjs`. It must be CommonJS: sandboxed preloads can't be ESM.
- **Navigation locked:** `setWindowOpenHandler` denies new windows, and `will-navigate` is prevented. A file dropped outside the analyzer cards is swallowed by the page (`dragover`/`drop` handlers in `analyzer/view.js`).
- **Permissions:** `lockPermissions` grants only audio-only `media` requests from our own window (Listen) and denies all others: camera, screen capture, notifications and so on. Electron grants everything when no handler is set.
- **Paths from the page:** only through native dialogs, or (analyzer only, read-only) a drop that the **preload** resolves with `webUtils.getPathForFile`. That returns `''` for any `File` the page built itself (D18, D23).
- **CSP** (in `index.html`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`. No inline scripts or styles, no remote content. Fonts (`default-src 'self'`) and images (`img-src 'self' data:`) load from local files under `src/renderer/shared/`; remote URLs are blocked.
- **Shell access:** `shell:openPath` and `shell:reveal` only accept these (`allowedPath`):
  - paths inside the input, output or converted folder
  - the chosen playlist file
  - the last saved playlist file
- **External links:** `shell:openLink(name)` opens one of `LINKS` in main: `email` (`mailto:hello@averyano.com`), `ffmpeg` (`https://ffmpeg.org/download.html`) or `releases` (`https://github.com/{REPO}/releases/latest`). The renderer names a link; it can't pass a URL (D38, D39, D40).

### Closing during a run
- If `engine.busy`, `close` is intercepted with a native dialog: **Keep converting** / **Stop and quit**.
- **Stop and quit:** `engine.cancel()`, wait for the running promise, then close. Finished tracks are kept, and the rest resume next launch.

### Settings
- **File:** `<dataDir>/settings.json` (data dir: library-sync.md → *Manifest*). Written atomically (`.tmp` + rename). Loaded once at startup; a parse error means defaults.
- **Shape** and **sanitize rules:**

| Field | Default | Rule |
|---|---|---|
| `inputRoot`, `outputRoot` | `''` | **only changed through the native folder dialog**; `settings:set` ignores them |
| `formats` | `SOURCE_FORMATS` with `defaultOn` | filtered to known ids |
| `safeNames` | `true` | anything except `false` → `true` |
| `workers` | `defaultWorkers()` | rounded, clamped to 1–16 |
| `playlistPrefix` | `'av-'` | `cleanPrefix`: filename-illegal chars removed, max 40 |
| `playlistUseCustomRoot` | `false` | only `true` counts |
| `playlistConvertedRoot` | `''` | **dialog only** (`pickFolder('converted')`); ignored by `settings:set` |
| `playlistSearchRecursive` | `false` | only `true` counts |
| `listenInput` | `''` | string ≤ 300 chars: Listen's Input select value (`mic:<deviceId>`, `line:<device>\|<channels>`, or `''`) |
| `ffmpegPath` | `''` | string: a binary chosen in *Settings → ffmpeg* (`''` = look for one, audio-pipeline.md → *Locating ffmpeg*). Only `ffmpeg:pick` / `ffmpeg:reset` change it; `settings:set` ignores it, like the folder paths (D18). Main calls `engine.setFfmpegPath` on load and on change. |
| `skippedVersion` | `''` | string ≤ 50: the release *Download later* put off (*Updates*); only `update:skip` sets it |
| `prefs` | `PREF_DEFAULTS` | `sanitizePrefs` (engine/prefs.js): `{analyzer: {checkHiRes}, camelot: {autoApplyListen}}`; the Settings page writes the whole object (ui.md → *Settings*) |
| `camelot` | `DECK_DEFAULTS` | `sanitizeDeck` (engine/camelot.js): `{n, mode, range, pct, bpm, masterTempo, target}`, each field validated, `pct` snapped to its range. Saved 300 ms after the last change (camelot.md). |

Every engine call receives the current settings (`engineOpts()`).

`updateSettings()` applies every change. If the input, output, safe names or converted folder changed, it also clears the in-memory playlist match. `convertedRoot()` is `playlistConvertedRoot` when the custom box is ticked (possibly `''` → "choose a folder"), otherwise `outputRoot`.

### Playlist session
See playlists.md. `const playlist = {path, match, savedPath, searchDir, searchAbort}` lives in memory only. `searchAbort` guards against two searches at once and backs cancellation. The renderer receives `publicMatch()`, which has no parsed file or directives, and refers to rows by index.

### IPC contract
Each channel returns an **envelope**: `{ok: true, data}` or `{ok: false, error: string}` (`handle()` wraps it). This avoids Electron's `Error invoking remote method…` prefix. The renderer unwraps it with `call()` (ui.md).

| `window.api` method | Channel | Args | `data` |
|---|---|---|---|
| `info()` | `app:info` | — | `{version, platform, formats: [{id,label}], defaultWorkers, ffmpeg}`; `ffmpeg` = `{version, soxr, source, path, customPath}` \| `{error, customPath}` (`main.js#ffmpegInfo`; `customPath` is the user's pick even when it no longer runs) |
| `getSettings()` | `settings:get` | — | settings |
| `saveSettings(patch)` | `settings:set` | partial settings (roots ignored) | settings |
| `pickFolder(kind)` | `dialog:pickFolder` | `'input' \| 'output' \| 'converted'` | settings (unchanged if cancelled) |
| `status()` | `engine:status` | — | `{lastRun, lastScanAt} \| null` |
| `scan()` | `engine:scan` | — | summary (engine.md) |
| `convert()` | `engine:convert` | — | convert result (engine.md) |
| `cancel()` | `engine:cancel` | — | — |
| `playlistState()` | `playlist:state` | — | `{playlistPath, convertedRoot, match}` |
| `pickPlaylist()` | `playlist:pick` | — (dialog) | `{playlistPath, convertedRoot, match}`; a new file clears the match |
| `matchPlaylist()` | `playlist:match` | — | match (playlists.md) |
| `pickPlaylistTrack(i)` | `playlist:pickTrack` | entry index (dialog: all audio + All files) | updated match; error if the pick isn't playable and has no converted copy |
| `searchPlaylistFolder()` | `playlist:searchFolder` | — (folder dialog) | `{match, search}` \| `null` if cancelled |
| `cancelPlaylistSearch()` | `playlist:cancelSearch` | — | — |
| `onPlaylistProgress(cb)` | `playlist:progress` (main → renderer) | — | `{found, folders}`, ≤ 10/s; returns an unsubscribe function |
| `analyzerPick(slot)` | `analyzer:pick` | `'a' \| 'b'` | analysis (analyzer.md → *Data shapes*), or `null` if cancelled |
| `analyzerDrop(slot, file)` | `analyzer:file` | slot + a dropped `File`; **the preload** resolves the path with `webUtils.getPathForFile` | analysis. Main requires an absolute path to a regular file with an audio extension. |
| `analyzerCancel(slot)` | `analyzer:cancel` | slot | — |
| `onAnalyzerProgress(cb)` | `analyzer:progress` (main → renderer) | — | `{slot, frac}`, ≤ 10/s; returns an unsubscribe function |
| `onAnalyzerTempoKey(cb)` | `analyzer:tempoKey` (main → renderer) | — | `{slot, token, ok, data \| error}` after an analysis, matching its result's `tempoKey` token (analyzer.md → *Data shapes*); not sent when cancelled; returns an unsubscribe function |
| `listenAccess()` | `listen:access` | — | mic consent: `'granted' \| 'denied' \| 'restricted' \| 'not-determined' \| 'unknown'`. On macOS it asks once if not determined; non-mac/win always `'granted'`. |
| `listenLineInputs()` | `listen:lineInputs` | — | `[{name, channels, choices: [{label, channels}]}]` for macOS interfaces with > 2 inputs; `[]` elsewhere (camelot.md → *Line inputs*) |
| `listenCaptureLine({device, channels, seconds})` | `listen:captureLine` | device name (checked against the current list), 1–2 channel indexes (checked against its count), 4–30 s | `analyzeClip` result, or `null` if discarded |
| `listenStopLine(discard)` | `listen:stopLine` | `true` = drop the take | — |
| `onListenColumn(cb)` | `listen:column` (main → renderer) | — | `{rows: Uint8Array(160), level}` ~20/s during a line take |
| `listenAnalyze(samples, sampleRate)` | `listen:analyze` | `Float32Array` (≤ 30 s), 8–192 kHz | `analyzeClip` result (camelot.md → *Listen*); nothing is stored |
| `savePlaylist()` | `playlist:save` | — (save dialog) | `{path, written, skipped}` \| `null` if cancelled |
| `openPath(p)` | `shell:openPath` | path inside a root | — |
| `reveal(p)` | `shell:reveal` | path inside a root | — |
| `openLink(name)` | `shell:openLink` | `'email'` \| `'ffmpeg'` \| `'releases'` (a key of `LINKS`) | opens the fixed URL in the default app (D38–D40) |
| `pickFfmpeg()` | `ffmpeg:pick` | — (open dialog) | the new `info.ffmpeg`; throws if the file isn't a working ffmpeg, or during a scan/convert |
| `resetFfmpeg()` | `ffmpeg:reset` | — | forget the chosen binary and look for one again; the new `info.ffmpeg` |
| `recheckFfmpeg()` | `ffmpeg:recheck` | — | look again (after installing ffmpeg) without a restart; the new `info.ffmpeg` |
| `getUpdate()` | `update:get` | — | the update state (*Updates*) |
| `checkUpdate()` | `update:check` | — | checks now (`auto: false`, so no dialog); the new state |
| `skipUpdate()` | `update:skip` | — | *Download later*: stores `skippedVersion`; the new state |
| `onUpdate(cb)` | `update:state` (main → renderer) | — | every state change; returns an unsubscribe function |
| `onProgress(cb)` | `engine:progress` (main → renderer) | — | returns an unsubscribe function |
| `onAppError(cb)` | `app:error` (main → renderer) | — | `{message}` of an unexpected main-process error (*Error handling*); returns an unsubscribe function |

`scan`/`convert` go through `exclusive()`: if the engine is busy they fail with `A scan or conversion is already running.`, and the current run's promise stays in `running`.

### Packaging (electron-builder, `package.json#build`)
| Key | Value | Why |
|---|---|---|
| `appId` / `productName` | `app.audioconverter.cdj` / `AudioConverter` | |
| `files` | `src/**/*`, `package.json` | tests and docs are not shipped; renderer assets (styles, fonts) must live under `src/` |
| `artifactName` | `${productName}-${version}-${os}-${arch}.${ext}` | e.g. `AudioConverter-1.0.0-mac-arm64.dmg`; the release notes' download table relies on the pattern |
| `publish` | GitHub, `releaseType: draft` | owner/repo come from `repository`; CI uploads into the draft (*Releases*) |
| `mac.target` | `dmg`, `arm64` + `x64`, category music | both from one Mac: no native modules and no bundled ffmpeg, so cross-arch builds work |
| `mac.identity` / `hardenedRuntime` | `"-"` / `false` | ad-hoc signature (D41). Unsigned, a downloaded app is reported as *damaged* with no way to open it; ad-hoc, macOS offers *Open Anyway*. Hardened runtime only matters for notarisation and would need extra entitlements with ad-hoc signing. |
| `win.target` | `nsis`, `x64`, `oneClick: false`, choosable install dir | |
| `linux.target` | `AppImage`, `x64`, category Audio | one file, runs on most distros |
| `directories.output` | `dist/` (gitignored) | |

```bash
npm run dist:mac                                             # both .dmg files (on macOS)
npm run dist:win                                             # installer (on Windows)
npm run dist:linux                                           # .AppImage (on Linux)
npx electron-builder --mac --arm64 --publish never           # one arch, nothing uploaded
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir   # fast unpacked build
```

- **ffmpeg isn't in the installers** (D41). `ffmpeg-static` is a dev dependency: a source checkout and the tests use it; the packaged app finds the user's own ffmpeg (audio-pipeline.md → *Locating ffmpeg*) or shows *ffmpeg is needed* with a download link. So the installers redistribute no ffmpeg at all, and its licence (the macOS `ffmpeg-static` build is GPL + *nonfree*) never applies to them.
- **Build each OS on that OS** (the CI matrix does). NSIS needs Windows (or Wine) and the AppImage tools Linux.
- **npm ≥ 11** blocks install scripts unless they are listed in `allowScripts`. `electron` (downloads Electron) and `ffmpeg-static` (downloads ffmpeg) are listed. After a version bump, re-approve with `npm approve-scripts <pkg>`. CI uses Node 22's npm 10, which runs them anyway.
- **Unsigned builds:** the first launch needs a manual step. The release notes template (`.github/release-notes.md`) explains it:
  - macOS: *System Settings → Privacy & Security → Open Anyway* (the old right-click → Open shortcut is gone in recent macOS).
  - Windows: SmartScreen → *More info* → *Run anyway*.
  - Linux: `chmod +x` the AppImage.
- **Microphone (Listen):**
  - `build.mac.extendInfo.NSMicrophoneUsageDescription` supplies the macOS prompt text. Without it, macOS denies the mic outright.
  - Windows needs nothing: the user's global *Let desktop apps access your microphone* switch applies.
  - Line inputs are recorded by the ffmpeg **child process**, which runs under the app's own microphone permission (the responsible process). In dev that's the terminal that ran `npm start`.
  - If builds are ever **signed with the hardened runtime** (Developer ID + notarisation), add an entitlements file with Apple's audio-input entitlement (`com.apple.security.device.audio-input`; electron-builder's docs list the App Sandbox key `device.microphone` instead, so check Apple's docs). Keep `com.apple.security.cs.allow-jit`, because a custom entitlements file replaces the defaults.
- **Icon:** none is set yet, so the default Electron icon is used.
- **Licence:** the app's own code is **MIT** (`LICENSE`, `package.json` → `license`).

### Updates (`src/main/updates.js`, `src/engine/release.js`, `src/renderer/settings/updates.js`)
- **What it does:** asks GitHub for the latest **published** release, `GET api.github.com/repos/{REPO}/releases/latest` (`REPO` in `engine/constants.js`), **once, 3 s after launch**, and again on **Check now** in Settings → About. No timer, no setting (D40). It never downloads or installs anything.
- **Request:** Electron's `net.fetch` (follows the system proxy), 15 s timeout. Nothing is sent but the request itself. Unauthenticated, GitHub allows 60 requests an hour per IP; one per launch is far below that.
- **Answers:** `404` → `status: 'none'` (nothing published yet, *or the repo is private*: GitHub hides private releases). Drafts and pre-releases never count: `/releases/latest` skips them. `403`/`429` → *GitHub is limiting requests*.
- **Parsing** (`release.js`, no imports so the page can load it too): `readRelease` keeps the version (tag without `v`), name, `published_at` and the notes. It never keeps a URL. `parseNotes` takes the bullets above the first `---` line, as plain text, at most 12 (+ "… and N more"). `compareVersions` is semver order.
- **State** pushed on `update:state`: `{current, status: 'idle'|'checking'|'ok'|'none'|'error', auto, checkedAt, error, latest, newer, skipped}`.
- **Window:**
  - **Dialog** *Update available* (screenshot-style: version line, *Released 3 days 21 hours ago*, notes, **Download later** / **Download now**). Opens only after the **launch** check found a newer version that wasn't put off, once per session.
  - **Download now** opens `https://github.com/{REPO}/releases/latest` (a fixed `LINKS` entry, never a URL from the API).
  - **Download later** stores `settings.skippedVersion`: no dialog for that version again. A newer one asks again.
  - **About card:** version, status line, **Check now**, **Update to x.y.z** + green dot when newer. The rail's Settings item gets a green dot (`.rail-item.has-update`) whenever a newer version exists, skipped or not.
  - *Released … ago* (`timeAgo`): the largest unit plus the next one (*3 days 21 hours*, *1 month 2 weeks*, *just now*), redrawn every minute.
- **Testing without a release:** `AUDIOCONVERTER_RELEASE_FILE=/path/release.json` makes main read that file instead of GitHub (testing.md → *UI smoke*).

### Releases (versioning, CI, publishing)
- **Version:** `package.json` `version` is the only source; `app.getVersion()` reads it. Tags are `vX.Y.Z`. The first release is 1.0.0 (D40).
- **Cutting a release:**
  1. `npm version patch|minor|major`: bumps `package.json` and the lockfile, commits, and tags.
  2. `git push --follow-tags`.
  3. `.github/workflows/release.yml` runs on the tag:
     - `draft`: fails unless the tag equals `v` + `package.json` version, then creates a **draft** release (*AudioConverter vX.Y.Z*) from `.github/release-notes.md`.
     - `build` (macOS, Windows, Ubuntu): `npm ci`, `npm test` (non-blocking on Windows until it's verified there), then `electron-builder --publish always`, which uploads into that draft. electron-builder also uploads `latest*.yml` and `.blockmap` files; they're for a future auto-updater and harmless now.
  4. On GitHub, edit the draft: replace the placeholder bullet with the changes (one bullet each; the app shows them), keep the part after `---`, and **Publish**. Only then do apps see it.
- **Source code:** GitHub attaches zip/tar.gz of the tag to every release.
- **Private repo:** everything above works, but Actions minutes count against the account's quota (macOS minutes at a multiplier), and apps can't see the release until the repo is public.
- **Not done:** signing and notarisation (Apple Developer ID, a Windows certificate), and true auto-update (`electron-updater`, which on macOS needs a signed app). See *Extending*.

## Extending

- **New IPC call:**
  1. `handle('area:name', fn)` in `registerIpc`
  2. expose it in `preload.cjs`
  3. call it through `call(api.x)` in the renderer
  4. add a row to the table above
- **New setting:**
  1. add it to `DEFAULTS` and `sanitize()`
  2. render and save it in ui.md (`renderOptions`, and a listener in `boot`)
  3. the engine receives it through `engineOpts()`
  4. if it changes the plan (like `safeNames`), trigger `refreshAfterChange()` in the renderer
- **App icon** (Dock, taskbar, installer): put a 1024×1024 `build/icon.png` in the project root. electron-builder's default resources folder is `build/`, and it generates `.icns`/`.ico` from that PNG. Alternatively set `build.mac.icon` / `build.win.icon`. This is separate from in-app imagery in `src/renderer/shared/images/` (ui.md → *Images*).
- **Signing and notarisation:** with an Apple Developer ID, set `mac.identity` to it (or `CSC_LINK`/`CSC_KEY_PASSWORD` secrets in CI), turn `hardenedRuntime` back on with the mic entitlement (*Packaging*), and add `notarize`. Windows: `win.certificateFile` or a signing service.
- **True auto-update:** `electron-updater` reads the `latest*.yml` files the releases already carry. It needs a signed macOS app; `updates.js` would then hand over to it instead of opening the release page.
- **Another platform/arch** (e.g. Linux arm64, Windows arm64): add it to the target's `arch` list and check the CI runner can build it.
- **Release notes boilerplate:** `.github/release-notes.md`. Keep the changes above the `---` line; `parseNotes` ignores everything below it.

## Error handling
- **Expected failures stay where they happen.** IPC handlers return `{ok:false, error}` envelopes, and the page shows them in context: the status line, a card or a callout.
- **Unexpected errors in main** (`reportCrash`) come from `process.on('uncaughtException' | 'unhandledRejection')`. They're logged (`[main] unexpected error`) and sent once to the window as `app:error`; the same message is sent at most every 10 s.
  - The app keeps running. This replaces Electron's default modal, which loops when an error repeats.
- **Unexpected errors in the page** (`window` `error` / `unhandledrejection`) use the same banner: `app.js` → `showAppError` shows `#app-error`, a dismissible `.app-error` callout pinned bottom-right.
- **The safety net isn't a fix.** Each reported error should still be handled at its source, as the analyzer's stream handler now is.

## Gotchas & limitations

- **Shared folder with Chromium:** Electron's own `userData` (named from `productName`) resolves to the same folder as the data dir on macOS and Windows. Chromium profile files (caches, local storage) therefore sit next to `settings.json` and `libraries/`. It's harmless; just don't treat that folder as ours alone.
- **No player-profile selector in the UI yet.**
- **A downloaded ffmpeg on macOS** is quarantined, and Gatekeeper kills it when the app runs it. `ffmpeg:pick` detects the `com.apple.quarantine` attribute and says so: allow it in *System Settings → Privacy & Security*, or `xattr -d com.apple.quarantine <path>`. The app doesn't remove the attribute itself. Homebrew's ffmpeg isn't quarantined, which is why the dialog suggests `brew install ffmpeg` first.
- **The update check needs a public repo** (or at least public releases). While the repo is private, every check ends as *No release has been published yet*.
- **Changing `workers` doesn't trigger a rescan.** It only affects the next convert.
- **Quit dialog wording:** `Stop and quit` waits for running ffmpeg processes to die, which is quick. `Keep converting` just dismisses the close.

## Tests

- **No automated tests for main/preload.** Verify with the CDP smoke run (testing.md → *UI smoke*).
- **Packaged app check:** build (`npx electron-builder --mac --arm64 --publish never`) and launch `dist/mac-arm64/AudioConverter.app/Contents/MacOS/AudioConverter` with a Finder-like environment (`env -i HOME="$HOME" PATH=/usr/bin:/bin …`) and `--remote-debugging-port=9333`. With Homebrew's ffmpeg installed, the chip must show it (found through `knownLocations`, not PATH); `codesign --verify --deep --strict` must pass on the `.app`.
- **Update dialog:** `AUDIOCONVERTER_RELEASE_FILE` (testing.md → *UI smoke*). `release.test.js` covers the version, notes and *ago* maths.
