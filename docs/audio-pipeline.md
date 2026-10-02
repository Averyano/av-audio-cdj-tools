# Audio pipeline

## Scope & files

This subsystem covers what the player accepts, which spec each output gets, and how ffmpeg produces it and how the result is verified.

| File | Role |
|---|---|
| `src/engine/constants.js` | `SOURCE_FORMATS` (tickable formats), `OTHER_AUDIO_EXTS`, `CDJ_PROFILE`, `OUTPUT_EXT` (`.aiff`), `PART_SUFFIX` (`.part`) |
| `src/engine/plan.js` | `formatIdFor`, `isCompatible`, `targetSpec` |
| `src/engine/probe.js` | `probeFile` (source stream info), `alacCookie` (hi-res ALAC rate), `inspectOutput` (verification read) |
| `src/engine/ffmpeg.js` | `locateFfmpeg`, `buildArgs`, `runFfmpeg`, `stderrTail` |
| `src/engine/engine.js` → `#convertOne` | Runs ffmpeg, appends tags (metadata.md), verifies, renames |

## Behaviour

### CDJ profile (`CDJ_PROFILE`)
The target player is the Pioneer CDJ-2000NXS (NXS1).

| Limit | Value | Enforced by |
|---|---|---|
| Formats | MP3, AAC, WAV, AIFF. **No FLAC, no ALAC.** | `isCompatible`; FLAC, WAV and ALAC are source formats (converted) |
| WAV/AIFF sample rate | 44.1 or 48 kHz only | `targetSpec`, `isCompatible` |
| WAV/AIFF bit depth | 16 or 24 | `targetSpec`, `isCompatible` |
| AIFF-C | not supported | encoder choice (below), `isCompatible` |
| WAVE_FORMAT_EXTENSIBLE | not supported | `isCompatible` (music-metadata reports it as codec `non-PCM (65534)`) |
| USB filesystem | FAT16/FAT32/HFS+ (no exFAT/NTFS) | documented and shown in the UI only |
| Folder depth / path length | 8 levels / < 256 chars | warnings (`maxFolderDepth: 8`, `maxPathLength: 240` for headroom) |

### Source formats (`SOURCE_FORMATS`)
| id | Extensions | Ticked by default |
|---|---|---|
| `flac` | `.flac` | yes |
| `wav` | `.wav`, `.wave` | yes |
| `alac` | `.m4a`, `.mp4`, `.alac`, **codec `/alac/i` only** | yes |

`formatIdFor(ext, probe)` decides the format: by extension, plus the probe's codec for a format with a `codec` rule. `.m4a` is shared: ALAC converts, AAC stays `compatible` (and is never matched as `alac`, ticked or not). The registry order sets collision priority (library-sync.md → *Output names*): `Same.flac` and `Same.m4a` give `Same.aiff` and `Same (m4a).aiff`.

A settings file from before ALAC keeps its stored format list, so ALAC starts unticked there (D37).

### Probe (`probe.js#probeFile`)
`music-metadata` `parseFile` is called with `{skipCovers: true, duration: false, skipPostHeaders: true}`. It reads headers only. FLAC STREAMINFO and WAV/AIFF chunk sizes give an exact duration without decoding.

It returns `{container, codec, sampleRate, bits, channels, duration, lossless}`, taken from `format.*`. A rate of 0 becomes `null`.

**Hi-res ALAC:** an MP4 sample entry keeps the rate in 16 bits, so music-metadata reports 0 for ALAC above 65535 Hz (88.2k, 96k, 192k). `alacCookie` walks the top-level boxes to `moov` (either end of the file, ≤ 64 MB), finds the 36-byte `alac` magic-cookie box and reads its 32-bit `sampleRate`. The engine re-probes cached ALAC probes that have no rate (`staleProbe` in `engine.js`).

### Compatibility rules (`plan.js#isCompatible`)
These apply only to files whose format is **not** ticked.

| Extension | Compatible when |
|---|---|
| `.mp3` | always (never probed) |
| `.m4a` `.aac` `.mp4` | codec matches `/aac/i` and not `/alac/i` |
| `.aif` `.aiff` | container `AIFF` (not `AIFF-C`), rate ∈ {44100, 48000}, bits ∈ {16, 24} |
| `.wav` `.wave` | codec `PCM` (so no float and no extensible), rate and bits as above |
| anything else | never, so it's `unsupported` |

### Target spec (`plan.js#targetSpec`)
| Source | Output | Why |
|---|---|---|
| 44100 / 48000 Hz | unchanged | already supported |
| rate divisible by 11025 (22.05k, 88.2k, 176.4k, 352.8k) | 44100 | integer ratio within the 44.1k family |
| any other rate (32k, 96k, 192k, 384k) | 48000 | integer ratio within the 48k family (32k is upsampled) |
| bits ≤ 16 (incl. 8-bit) | 16 | |
| bits > 16 (24, 32-int, 32-float) | 24 | the CDJ max; no audible loss |
| channels > 2 | 2 (`downmix: true`) | ffmpeg default downmix matrix |
| mono | stays mono | |

The result is `{sampleRate, bits, channels, resample, downmix}`.

### Locating ffmpeg (`ffmpeg.js#locateFfmpeg`)
- **Order:**
  1. explicit override (`new Engine({ffmpegPath})` / `engine.setFfmpegPath`, CLI `--ffmpeg`, the app's *Settings → ffmpeg → Choose…*)
  2. `ffmpeg-static`: **source checkouts and tests only**. It's a dev dependency, so installers don't contain it (D41). `require` fails there and the step is skipped.
  3. `ffmpeg` on PATH
  4. `knownLocations()`: where package managers put it, because an app opened from Finder, the Dock or the Start menu doesn't get the shell's PATH:
     - macOS: `/opt/homebrew/bin` (Homebrew, Apple Silicon), `/usr/local/bin` (Homebrew Intel, manual), `/opt/local/bin` (MacPorts)
     - Windows: winget's `%LOCALAPPDATA%\Microsoft\WinGet\Links`, Scoop's `%USERPROFILE%\scoop\shims`, Chocolatey's `%ProgramData%\chocolatey\bin`, `C:\ffmpeg\bin`
     - Linux: `/usr/bin`, `/usr/local/bin`, `/snap/bin`
  - Absolute candidates that don't exist are skipped without spawning. Nothing found → `ffmpeg not found. Install it (https://ffmpeg.org/download.html) or put it on PATH.` The app then shows *ffmpeg is needed* (ui.md → *Settings*).
- **Validation** (`checkFfmpeg(bin)`): a candidate counts only if `-hide_banner -buildconf` exits 0 and `-version` starts with `ffmpeg version`. A broken override falls through to the next candidate silently; `source` says which one won.
- **Info captured:** `{path, version, soxr, source}`: `version` from the first line of `-version`; `soxr = buildconf includes "--enable-libsoxr"`; `source` `'custom'` (the override), `'bundled'` (ffmpeg-static) or `'system'` (PATH or a known location).
- **Versions:** the tests run ffmpeg-static's 6.0. A conversion with Homebrew's 8.1 passed the same verification (plain AIFF, rate/bits, tags, cover) on 2026-10-02. Users bring their own version now, so verification (below) is what guarantees the output.
- **Caching:** the result is cached per `Engine` (`engine.ffmpeg()`). A failure clears the cache so the next call retries, and `setFfmpegPath` drops it.
- **ffmpeg-static** (dev): 5.3 ships ffmpeg 6.x (6.0 on macOS arm64) **without soxr**. Homebrew's build has soxr, so installed apps often take the soxr path below. There's no ffprobe dependency; nothing here needs it.

### ffmpeg invocation (`ffmpeg.js#buildArgs`)
```
-hide_banner -nostdin -loglevel error -y -i <src>
-map 0:a:0 -map_metadata -1 -map_chapters -1 -fflags +bitexact
-c:a pcm_s16be | pcm_s24be
[-af aresample=<rate>:<quality>[:dither_method=triangular],aformat=sample_fmts=s16|s32]   # only if resample
[-ac 2]                                                                                   # only if downmix
-f aiff <dst>.aiff.part
```

| Flag | Reason |
|---|---|
| `-map 0:a:0` | first audio stream only; embedded cover streams are dropped (artwork is re-added by id3.js) |
| `-map_metadata -1 -map_chapters -1` | ffmpeg writes no tags; metadata.md owns tags |
| `-fflags +bitexact` | no encoder-identification metadata |
| `pcm_s16be` / `pcm_s24be` | big-endian PCM with codec tag `NONE`, so ffmpeg's aiffenc writes **plain AIFF**, never AIFF-C |
| `-f aiff` | needed because the output extension is `.part` |
| quality with soxr | `resampler=soxr:precision=28` |
| quality with swr (default) | `filter_size=64:cutoff=0.97` |
| `dither_method=triangular` | only when the target is 16-bit *and* resampling |
| `aformat=sample_fmts=…` | pins the output sample format so `aresample` itself does the conversion (and the dither) |

`runFfmpeg` spawns without a shell (`windowsHide`, stdin ignored) and collects at most 64 KB of stderr. It supports an `AbortSignal`: abort kills the child. Failures report `stderrTail()`, the last 6 non-empty lines.

### Verification (in `engine.js#convertOne`, after the ID3 chunk is appended)
`inspectOutput(part)` must report:
- container `AIFF`
- `sampleRate === target.sampleRate`
- `bits === target.bits`
- duration within **±0.5 s** of the source, when both are known

Any mismatch throws. The `.part` file is deleted and the track is recorded as failed. Only a verified `.part` is renamed to `.aiff`.

## Data shapes

```js
probe  = { container, codec, sampleRate, bits, channels, duration, lossless }
target = { sampleRate, bits, channels, resample: bool, downmix: bool }
ff     = { path, version, soxr: bool }                 // locateFfmpeg()
run    = { code, signal?, stderr, error? }             // runFfmpeg()
```

## Extending

- **Adding a source format** (ALAC is the worked example, D37):
  1. Add an entry to `SOURCE_FORMATS` (`id`, `label`, `exts`, `defaultOn`). The UI toggle appears automatically.
  2. If the extension is shared with a playable codec, give the entry a `codec` regex; `formatIdFor` then needs the probe. Every non-MP3 file is probed already.
  3. Check that ffmpeg decodes it. `buildArgs` doesn't change.
  4. Add a fixture in `test/fixtures.js` and assertions in `test/e2e.test.js`.
- **Convert only the non-compatible files of a playable format** (e.g. hi-res AIFF): add a format id whose plan rule is "extension matches **and** `!isCompatible`".
- **A different player profile** (other CDJ/XDJ models): `CDJ_PROFILE` is a single constant today. Make it selectable: store the profile id in settings, pass the profile into `targetSpec`/`isCompatible`/`#summarize`, and show it in the UI header.
- **A different output container:**
  - Change `OUTPUT_EXT`, the codec and `-f` in `buildArgs`, the tag container writer (`id3.js#appendAiffChunk` is AIFF-specific) and the verification `container` check.
  - ⚠ For WAV output, ffmpeg writes WAVE_FORMAT_EXTENSIBLE for PCM deeper than 16 bits (riffenc). The NXS1 rejects that, so 24-bit WAV output would need a header fix.
- **Better resampling:** point the engine at an ffmpeg built with `--enable-libsoxr`; detection is automatic. In the app: *Settings → ffmpeg → Choose…* (desktop-app.md → *Settings*). The swr parameters live in `buildArgs`.
- **A "force 16-bit" option:** a setting that makes `targetSpec` return `bits: 16`. Dither is already applied only when resampling, so it would also need dither on the plain 24→16 path.

## Gotchas & limitations

- **Mono sources stay mono.** Mono AIFF playback hasn't been confirmed on real NXS1 hardware.
- **Rates below 44.1k are upsampled** (22.05k → 44.1k, 32k → 48k).
- **The ±0.5 s duration tolerance** assumes the source duration from headers is right. A FLAC with a wrong total-samples value in STREAMINFO would fail verification.
- **No ffprobe dependency by design.** music-metadata covers probing and verification.
- **Windows paths over 260 characters** only produce a warning. ffmpeg 6.0 may fail on them.
- **ffmpeg version is pinned** by `ffmpeg-static`'s release tag. Upgrading the package can change resampler availability and flags. Re-run `npm test` after upgrading.

## Tests

- **`test/unit.test.js`:**
  - `targetSpec: family-aware resampling and bit depth`
  - `isCompatible follows CDJ-2000NXS limits`
- **`test/e2e.test.js`:** `convert writes CDJ-safe AIFF…`. It checks the container is `AIFF`, and rate/bits/channels for the 96k and 88.2k FLACs, the 24-bit WAV, the 32-bit float WAV and the 6-channel FLAC.
