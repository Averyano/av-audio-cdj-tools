# Testing

## Scope & files

| File | Role |
|---|---|
| `test/unit.test.js` | Pure functions: names, planning, target spec, compatibility, tag mapping, ID3 encoding |
| `test/e2e.test.js` | Real `Engine` runs against a generated library in a temp dir |
| `test/playlist.test.js` | Playlist conversion: M3U parse/write, matching, manual picks (`resolveFile`), Find in folder, recursive guard, walk folder cap |
| `test/camelot.test.js` | Camelot pitch-shift maths: the handoff's test vectors (camelot.md → *Tests*) |
| `test/spectrum.test.js` | Analyzer maths on synthetic signals: FFT, calibration, wall/ultrasonic detection, verdicts (analyzer.md → *Tests*) |
| `test/analyzer.test.js` | Analyzer: a 6:40 file (long-track crash), an injected mid-decode error; on real ffmpeg output: genuine, upsampled, from-MP3 (128k, and 320k as a 24-bit FLAC), padded, CD, MP3, cancel. Both verdicts. Tempo + key of a whole file, and its cancel. |
| `test/tempokey.test.js` | Listen maths on synthetic tracks: tempo (incl. 174 vs 87, a 90–174 sweep), key, detuning, silence/noise, dropout holes; whole tracks (`analyzeTrack`, `refineTempo`), key confidence and the minor lean (camelot.md → *Tests*) |
| `test/linein.test.js` | Line inputs: parsing Core Audio / AVFoundation output (real samples from a Scarlett), channel pairs, recording a pair from a 4-channel `lavfi` source with sound only on 3/4, early stop, refused channels, dropped buffers filled back to length (tempo still 130), retrying a failed AVFoundation start (a shell-script fake ffmpeg; skipped on Windows) |
| `test/keytest.test.js` | Library check tool (`tools/keytest*.js`): Camelot/note-name keys, the rekordbox UTF-16 text export, tag matching, MIREX scoring, BPM ratio kinds, the cache format; an end-to-end scan → `--limit` stop → resume → report on two generated tracks (camelot.md → *Library check*) |
| `test/prefs.test.js` | Settings schema: defaults, sanitizing (bad types, unknown keys, `__proto__`) |
| `test/release.test.js` | Update check maths (`engine/release.js`): semver order incl. pre-releases, release notes to plain text (bullets, markdown, GitHub's generated lines, the `---` cut, the 12-item cap, no HTML), reading GitHub's answer (drafts and unknown tags refused, no URL kept), *Released … ago* across minutes to years |
| `test/synth.js` | `synthTrack({bpm, pattern, progression, cents})`: drums + chords for the tempo/key tests; `noise(seed)` (mulberry32). Side-effect free. |
| `test/fixtures.js` | `makeLibrary(root, ffmpegPath)` + the `FIXTURES` path map |

## Running

```bash
npm test                                   # node --test (auto-discovers files)
node --test test/unit.test.js              # one file
node --test --test-name-pattern="cancel"   # by test name
```

- **Requirements:** a working ffmpeg (`npm install` provides `ffmpeg-static`). The fixtures use the `lavfi` sine/color sources, `libmp3lame`, `alac` and `aac`, which the ffmpeg-static build includes.
- **Duration:** about 1–2 s; each e2e track is 2 s of audio.
- **Count:** `npm test` reports 93: 11 unit + 8 e2e + 9 playlist + 12 camelot + 12 spectrum + 10 analyzer + 11 tempokey + 6 linein + 6 keytest + 2 prefs + 4 release, plus `fixtures.js` and `synth.js`, which is discovered as a file (see the quirk below).
- **Files run in parallel**, and the analyzer/tempo suites are CPU-heavy. Don't write tests that depend on throttled progress timing. The e2e cancel test cancels once on the first convert event, because waiting for "converted ≥ 1" raced `PROGRESS_EVERY_MS` under load.
- **Discovery quirk:** `node --test` also *executes* `test/fixtures.js`, because files under `test/` match the default patterns. It shows as a passing entry. That's harmless because importing it has no side effects. Keep helpers side-effect free.

## What's covered

### Unit (`test/unit.test.js`)
| Test | Guards |
|---|---|
| `sanitizeSegment makes FAT32/Windows-safe names` | illegal characters, trailing dots, reserved names, `safe=false` |
| `sanitizeSegment and toKey normalise to NFC` | macOS NFD names → stable keys |
| `outputRelFor mirrors folders and swaps extension` | folder mirroring, suffixes |
| `isInside detects nesting both ways` | input/output nesting validation |
| `targetSpec: family-aware resampling and bit depth` | every rate family, bit depth mapping, downmix, mono |
| `isCompatible follows CDJ-2000NXS limits` | each extension rule incl. AIFF-C, float/extensible WAV, ALAC |
| `buildPlan: actions, collisions, stable names` | action order, `(wav)` suffix, unticked WAV → compatible, owned names kept |
| `buildPlan: .m4a converts as ALAC and plays as AAC` | codec-picked `alac` format, hi-res ALAC target, `(m4a)` suffix, unticked ALAC → unsupported |
| `buildPlan: name clashes are case-insensitive` | `track.flac` vs `Track.flac` |
| `buildTagPairs maps DJ-relevant tags to real ID3 frames` | the full mapping incl. INITIALKEY/MIXARTIST fallbacks, the iTunes freeform key (.m4a), BPM rounding |
| `encodeId3v23 writes a valid v2.3 header and frames` | header, synchsafe size, frame ids incl. TXXX/APIC |

### End-to-end (`test/e2e.test.js`)
The tests run **in order and share state** (one library, one output, one data dir). Keep that in mind when inserting tests.

| Test | Guards |
|---|---|
| `scan counts the library without writing output` | counts (audio 13, pending 10, compatible 2, unreadable 1, hi-res 3), `renamed` warning, output not created |
| `convert writes CDJ-safe AIFF with tags and artwork` | plain AIFF, spec per fixture (incl. 96k/24 ALAC → 48k/24, its tags and cover), AAC .m4a left alone, clash + sanitised names, no empty folders, no `.part` |
| `second run converts nothing` | incremental behaviour |
| `changed source is reconverted, deleted source leaves output alone` | mtime change detection, `missing` count, orphan kept |
| `lost manifest self-heals from existing outputs` | deletes the data dir, rescans, expects 0 pending |
| `ffmpeg: a chosen binary is checked, and a broken one falls back to the bundled copy` (bundled = ffmpeg-static, present in source checkouts) | `locateFfmpeg` `source` (bundled/custom), broken override → bundled, `checkFfmpeg` refuses node and a missing file, `setFfmpegPath` drops the cache |
| `rejects nested or missing folders` | validation messages |
| `cancel stops a run and leaves no partial files` | own library/data dir; cancels after the first conversion, then resumes exactly the rest |

### Playlists (`test/playlist.test.js`)
It converts its own fixture library in `before`, so it doesn't depend on `e2e.test.js` order. Test list: playlists.md → *Tests*.

### Fixtures (`FIXTURES`)
| Key | File | Exercises |
|---|---|---|
| `tagged` | `Techno/2024/Artist - Track One.flac` | 16/44.1 mono; full tags (BPM, INITIALKEY, LABEL, COMMENT, DATE…) and PNG cover |
| `hires96` | `Techno/2024/HiRes 96k.flac` | 24/96 → 48k |
| `hires88` | `House/Deep/Track 88k.flac` | 24/88.2 → 44.1k |
| `wav24` | `House/Deep/Wave 24.wav` | 24/48 PCM WAV |
| `wavFloat` | `House/Float 32.wav` | 32-bit float → 24 |
| `weird` | `Ünïcödé Földer/Tëst: What?.flac` | unicode + illegal characters (Windows: `Tëst What.flac`, since `:`/`?` can't be created there) |
| `clashFlac` / `clashWav` | `Clash/Same.flac` / `.wav` | output name clash |
| `surround` | `Multi/Six Channel.flac` | 6 ch → stereo |
| `mp3` | `Other/song.mp3` | compatible, skipped |
| `junk` | `Other/._junk.flac` | AppleDouble file must be ignored |
| `broken` | `Other/broken.flac` | `fLaC` magic + garbage → unreadable |
| `image` | `Other/cover.jpg` | non-audio ignored |

## Adding tests

- **Pure logic** (names, plan, tags, id3) → `unit.test.js`. No filesystem needed. Camelot maths → `camelot.test.js`.
- **Anything touching ffmpeg or the filesystem** → `e2e.test.js`:
  - Add a fixture to `FIXTURES` and generate it in `makeLibrary` with a short `lavfi` source.
  - Update the counts in the first e2e test.
  - Assert on outputs with `music-metadata`'s `parseFile`.
- **A bug fix** should come with a test that fails before the fix. The triage table in README.md tells you which suite.

## UI smoke (CDP)

The app has no DOM tests. Instead, drive the real Electron window through the Chrome DevTools Protocol and take screenshots:

1. **Sandbox data dir:** create one with a `settings.json` pointing at a fixture library and a temp output:
   ```json
   {"inputRoot":"/tmp/x/lib","outputRoot":"/tmp/x/out","formats":["flac","wav"],"safeNames":true,"workers":2}
   ```
   Generate the library with `makeLibrary`, e.g. `node -e "import('./test/fixtures.js').then(m => m.makeLibrary('/tmp/x/lib', 'node_modules/ffmpeg-static/ffmpeg'))"`.
2. **Launch:** `AUDIOCONVERTER_DATA_DIR=/tmp/x/data npx electron . --remote-debugging-port=9333 &`
   - The app auto-scans on boot because both folders are set.
3. **Connect:** fetch `http://127.0.0.1:9333/json` and open the page's `webSocketDebuggerUrl` with the global `WebSocket` (Node ≥ 22). Then:
   - `Runtime.evaluate` (`awaitPromise`, `returnByValue`) to read `#status` or click buttons, e.g. `document.querySelector('#convert-btn').click()`
   - poll a condition such as `/Done|Stopped|⚠/.test(document.querySelector('#status').textContent)`
   - `Page.captureScreenshot` → base64 PNG, then write it to disk and inspect it
4. **Check:**
   - status copy
   - tiles before, during and after a run
   - a mid-run screenshot (progress bar, active file, live tiles)
   - cancel → `Stopped. Converted X of Y.` and no `*.part` in the output
5. **Update dialog without a release:** add `AUDIOCONVERTER_RELEASE_FILE=/tmp/x/release.json` to the launch. Main reads that instead of GitHub. A minimal file: `{"tag_name": "v0.2.0", "published_at": "<ISO date>", "body": "- One change\n- Another"}`. The dialog opens about 3 s after launch. **Download later** writes `skippedVersion` to the sandbox `settings.json`; relaunch to check that it stays quiet while the dot remains.
6. **Without ffmpeg:** the *ffmpeg is needed* dialog can't be triggered while `ffmpeg-static` or Homebrew's ffmpeg exists. Check its layout with `document.querySelector('#ffmpeg-dialog').showModal()`.
7. **Reload after renderer edits:** send `Page.reload` over CDP. `location.reload()` from `Runtime.evaluate` does nothing, because `will-navigate` is prevented.
8. **Clean up:** `pkill -f "remote-debugging-port=9333"`.

**Drag and drop** works through CDP with real files: `Input.dispatchDragEvent` with `type` `dragEnter` → `dragOver` → `drop` and `data: {items: [], files: ['/abs/path'], dragOperationsMask: 1}`. The page gets disk-backed `File`s, so the preload's `webUtils.getPathForFile` is exercised (analyzer.md).

**Audio input** (Listen) works with a fake device. Launch with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=/abs/clip.wav --disable-features=AudioServiceSandbox`; without the last flag the sandboxed audio service can't read the WAV and the input is silent. Stub `systemPreferences.getMediaAccessStatus = () => 'granted'` in the `NODE_OPTIONS --require` stub, so no real macOS consent prompt appears. A WAV from `synthTrack` gives known answers.

**Main-process errors:** a `NODE_OPTIONS --require` stub that throws in a timer (`setTimeout(() => { throw new Error('…') }, 4000)`) should show the `#app-error` banner once, with no modal. Check `[main] unexpected error` in the log.

**Line inputs** need a real multichannel interface (there's no fake for ffmpeg's AVFoundation). Pick its pair in the Input select via CDP and keep the mic stub, so Electron's own consent isn't requested. The ffmpeg child uses the terminal's permission.

**Native dialogs** (playlist picker, manual track pick, save) can't be clicked through CDP. Stub them in the main process with a throwaway preload:

```js
// dialog-stub.cjs — test only, never committed into src/
setTimeout(() => {             // 'electron' isn't resolvable until startup finishes
  const { dialog } = require('electron');
  dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: [/playlist/i.test(o.title) ? '/tmp/x/Set.m3u8' : '/tmp/x/out/a.aiff'] });
  dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: o.defaultPath });
}, 0);
```

Route by `o.title` when a flow opens several dialogs (playlist, *Choose a folder to search*, *Choose the file…*). A counter lets successive calls return different files, e.g. first an unconverted FLAC (expect the refusal), then a library FLAC (expect its AIFF).

Launch the **Electron binary directly** so `NODE_OPTIONS` doesn't also hit `npx`'s Node:

```bash
NODE_OPTIONS="--require /tmp/x/dialog-stub.cjs" AUDIOCONVERTER_DATA_DIR=/tmp/x/data \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9333 &
```

For a bigger library that makes progress visible, generate one 90 s pink-noise 24/96 FLAC (`anoisesrc`) and copy it ~40 times into a few folders.

**Packaged app:** `npx electron-builder --mac --arm64 --publish never`, then run `env -i HOME="$HOME" PATH=/usr/bin:/bin AUDIOCONVERTER_DATA_DIR=… dist/mac-arm64/AudioConverter.app/Contents/MacOS/AudioConverter --remote-debugging-port=9333`. That's Finder's PATH, without Homebrew. With Homebrew's ffmpeg installed, Settings → ffmpeg must show it (`/opt/homebrew/bin/ffmpeg`), which proves `knownLocations` works and that no ffmpeg-static is packed (D41). `codesign --verify --deep --strict` on the `.app` must pass (ad-hoc).

## Real-world checklist (manual, before trusting a release)

1. **CLI on a copy of one real library folder:** `node src/cli.js convert --in <sub> --out /tmp/cdj-test`. Then re-run it: it should finish in seconds with 0 conversions.
2. **`ffprobe -show_streams -show_format <file>.aiff`:**
   - codec `pcm_s16be` or `pcm_s24be`
   - format `aiff`
   - 44100 or 48000 Hz
   - tags present
3. **rekordbox import:** title, artist, key, BPM, label, comment and artwork visible.
4. **Export to a FAT32 USB and play on the CDJ-2000NXS,** including tracks from 24/96, 88.2k, float-WAV and mono sources.
5. **Windows:** `npm install && npm test && npm start`; check unicode paths and the long-path warning.

## Debugging tips

- **Isolate state:** `AUDIOCONVERTER_DATA_DIR=/tmp/somewhere` keeps experiments away from real settings and manifests.
- **Raw output:** `node src/cli.js scan … --json` prints the exact summary the UI renders.
- **The manifest is plain JSON:** `<dataDir>/libraries/<id>.json`. Look at `files[key].done`, `.error` and `.probe` for one track.
- **Tag chunk position:** `xxd file.aiff | head` shows `FORM…AIFF`. Python `data.find(b'ID3')` locates the tag chunk at the end of the file.
