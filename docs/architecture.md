# Architecture

## Layers

```
┌──────────────────────────── Electron app ────────────────────────────┐
│  renderer (src/renderer)         sandboxed page, vanilla HTML/CSS/JS │
│        │ window.api.*  (promise → {ok,data}|{ok:false,error})        │
│        │ onProgress(cb) ◄──────────────────────────────┐             │
│  preload (src/main/preload.cjs)  contextBridge only    │             │
│        │ ipcRenderer.invoke('channel')                 │ 'engine:progress'
│  main (src/main/main.js)  settings · dialogs · shell · window ·       │
│                           playlist session (path, match, search)      │
└────────┼───────────────────────────────────────────────┼─────────────┘
         │ new Engine({dataDir})                         │ engine.on('progress')
┌────────▼──────────────── engine (src/engine) ───────────┴────────────┐
│  engine.js      orchestration: scan() · convert() · cancel() · status()│
│   ├ walk.js      list audio files (library-sync)                     │
│   ├ probe.js     read stream info / tags via music-metadata          │
│   ├ plan.js      action · target spec · output names                 │
│   ├ names.js     keys, sanitising, path helpers                      │
│   ├ manifest.js  per-library JSON state (atomic writes)              │
│   ├ ffmpeg.js    locate binary, build args, run process              │
│   ├ tags.js      tag → ID3 frame mapping, cover pick                 │
│   ├ id3.js       ID3v2.3 encoder, AIFF chunk append                  │
│   ├ playlists.js M3U parse, match to converted files, write          │
│   ├ pool.js      bounded concurrency                                 │
│   ├ constants.js formats registry, CDJ profile, dirs, defaults       │
│   ├ analyze.js   analyzer: ffmpeg decode → spectrum.js, tempokey     │
│   ├ spectrum.js  FFT, spectrogram, cutoff/hi-res verdict (pure)      │
│   ├ tempokey.js  tempo, key estimate, tuning: clip or track          │
│   ├ prefs.js     Settings schema + sanitizer (no imports)            │
│   ├ release.js   versions, release notes, "… ago" (no imports)       │
│   ├ linein.js    Listen line inputs: list + record via ffmpeg        │
│   └ camelot.js   Camelot pitch-shift maths (no imports; the renderer │
│                  imports it too, see camelot.md)                     │
└──────────────────────────────▲───────────────────────────────────────┘
                               │ same Engine class
                     src/cli.js (terminal)  ·  test/*.test.js
```

The engine is **pure Node**, with no Electron imports. `camelot.js`, `prefs.js` and `release.js` go further and import nothing at all, because the renderer loads them directly as well as main and the tests. They're the only engine modules the page may import (decisions D22, D25, D40). That is what lets the CLI, the tests and the app all run it unchanged. Keep it that way. Anything Electron-specific (dialogs, shell, windows) belongs in `src/main`.

External dependencies:
- **ffmpeg**: a subprocess; comes from a binary chosen in *Settings → ffmpeg*, `ffmpeg-static` (source checkouts only), PATH, or a known install folder. Installers don't contain it (D41).
- **GitHub**: the update check reads the latest published release (desktop-app.md → *Updates*).
- **music-metadata**: pure JS parser for headers and tags.
- **filesystem**: input library read-only; output folder add/overwrite only; data dir for state.

## End-to-end flow

1. **Scan** (`Engine.scan`):
   - validate the folders
   - load the manifest
   - **walk** the input
   - **probe** new or changed files
   - mark missing sources
   - **plan** every file
   - **check** outputs
   - save the manifest
   - return a **summary**
2. **Convert** (`Engine.convert`): always runs a fresh scan first. Then, for each `pending` entry, it runs a **job** through the pool: `mkdir` → read tags → ffmpeg to `.part` → append ID3 chunk → verify → rename. Each result is recorded in the manifest. Finally it writes `lastRun` and returns the summary plus `failures`.
3. **UI/CLI**: listen to `progress` events while a run is in flight, then render the returned summary.
4. **Playlist** (`Engine.matchPlaylist`, independent of scan/convert):
   - parse the `.m3u8`
   - map each entry to its converted file (manifest → naming rules → path tail in the converted folder)
   - main keeps the match; the user fixes misses by hand (per-row pick → `resolveFile`) or with **Find in folder** (`findMissingInFolder`, optionally recursive)
   - `buildM3u` writes the new playlist (playlists.md)

## Module → doc

| Module | Doc |
|---|---|
| `walk.js`, `names.js`, `manifest.js`, `plan.js#buildPlan`, `engine.js#scan/#summarize` | library-sync.md |
| `constants.js` (formats, CDJ profile), `plan.js#targetSpec/#isCompatible`, `ffmpeg.js`, `engine.js#convertOne` verification | audio-pipeline.md |
| `probe.js#readTags`, `tags.js`, `id3.js` | metadata.md |
| `playlists.js`, `engine.js#matchPlaylist`, `main.js` `playlist:*` | playlists.md |
| `engine.js` (API, events, pool, cancel), `pool.js` | engine.md |
| `src/main/*` (incl. `updates.js`), `engine/release.js`, `src/renderer/settings/updates.js`, `package.json#build`, `.github/*` | desktop-app.md |
| `engine/camelot.js`, `engine/tempokey.js`, `engine/linein.js`, `main.js` `listen:*`, `src/renderer/camelot/*` | camelot.md |
| `engine/analyze.js`, `engine/spectrum.js`, `main.js` `analyzer:*`, `src/renderer/analyzer/*` | analyzer.md |
| `engine/prefs.js`, `src/renderer/settings/*` | ui.md → *Settings* |
| `src/renderer/*` | ui.md |
| `src/cli.js` | cli.md |
| `test/*` | testing.md |
| `tools/keytest*.js` (developer tool, not packaged) | camelot.md → *Library check* |

## Glossary

| Term | Meaning |
|---|---|
| **key** | A file's path relative to the input root, with `/` separators and NFC-normalised. Keys are the IDs in the manifest and events. Built by `names.js#toKey`. |
| **Camelot key** | Not a library key: a musical key `{n: 1..12, mode: 'A'\|'B'}` in the Camelot view (camelot.md). |
| **outRel** | The output path relative to the output root, also with `/` separators. Sanitised and ending in `.aiff`. |
| **walked file** | `{abs, key, ext, size, mtimeMs}` from `walk.js`. |
| **record** | The manifest entry for a key: probe cache, conversion result, errors. |
| **entry** | A plan row: a walked file plus `action`, `probe`, `target`, `outRel`, `status`. |
| **action** | `convert` (a ticked format), `compatible` (the CDJ already plays it, so it's skipped), `unsupported` (neither), or `unreadable` (a ticked format whose headers couldn't be read). |
| **status** | For `convert` entries only: `done` (output up to date) or `pending`. |
| **target spec** | `{sampleRate, bits, channels, resample, downmix}` for one output. |
| **missing** | A source that is gone from the library but has a recorded conversion. Its output is kept. |
| **self-heal** | Adopting an existing output that is newer than its source when the manifest has no record. |
| **.part** | A temporary output name while a job runs. It is renamed to `.aiff` only after verification. |
| **match** | Result of `matchPlaylist`: one entry per playlist line, with `status` `found`/`original`/`manual`/`missing` and a `target` path. |
| **via** | How a `manual` playlist entry was resolved: `pick` (row folder button) or `folder` (Find in folder). |
| **converted folder** | Where playlist targets are looked up: the output folder, unless the user chose another one (e.g. a copy on USB). |
| **data dir** | Where settings and manifests live. See library-sync.md → *Manifest*. |
