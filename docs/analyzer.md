# Audio analyzer

Drop a track to see its spectrogram, its **tempo and key estimate** (a few seconds later), and a plain answer to **"is this really lossless, or was it made from an MP3?"** (a *transcode*, or *fake FLAC*). That's the default. *Settings → Audio Analyzer → Also check hi-res claims* switches to the stricter verdict, which also tests whether an 88.2 kHz+ file is genuine studio hi-res. Drop two tracks to compare them on one frequency scale. Read-only: nothing is written anywhere.

The old Python project `../audio-analyzer` turned out to hold only a progress helper (`analyzer/progress.py`, 2026-10-01); every other folder was empty. Its stage list shaped this design: decode → spectrum + cutoff → bit depth/LSB → ultrasonic band, plus align/null test for comparing, which isn't built (see *Extending*). Everything here is new JavaScript.

## Scope & files

| File | Role |
|---|---|
| `src/engine/spectrum.js` | **Pure maths**: `fft`, `SpectrogramBuilder` (streaming), `findCutoff`, `verdict`, `usedBitsFromOr`. No I/O. |
| `src/engine/analyze.js` | `analyzeFile(path, {ffmpegPath, signal, onProgress})`: probes with music-metadata, stream-decodes through ffmpeg, feeds `spectrum.js`. `analyzeTempoKey(path, {ffmpegPath, signal})`: a second decode to mono 22.05 kHz → `tempokey.js` → `analyzeTrack` |
| `src/main/main.js` → `analyze()`, `analyzer:*` handlers | One decode per slot (`a`, `b`); a new file for a slot cancels the old decode; all decodes are aborted when the window closes |
| `src/main/preload.cjs` → `analyzerDrop` | Turns a dropped `File` into its path with `webUtils.getPathForFile`. The page never sees or sends the path (D23). |
| `src/renderer/analyzer/view.js` | `initAnalyzer({api, call})`: slots, drop/pick, spectrogram canvas, axes, overlays, hover readouts, average-spectrum chart |
| `src/renderer/analyzer/analyzer.css` | Styles; every class is prefixed `an-` |
| `src/renderer/index.html` → `[data-view="analyzer"]`, `#an-slot-tpl` | View skeleton; the slot `<template>` is cloned into cards A and B |

## Behaviour

### Flow
1. **Drop** a file on a card, or use **Choose…** (native dialog). Dropping **two files** at once turns on compare and fills A and B.
2. **Main** checks the drop: an absolute path, an audio extension (`AUDIO_EXTS`), and a regular file. It then runs `analyzeFile`, and progress arrives as `analyzer:progress` (about 10/s).
3. **The card shows** the facts, the verdict, the spectrogram (with cutoff and file-limit lines) and the dB scale. Below the cards, the **average spectrum** chart shows one line per track.
4. **Tempo and key follow.** Main starts `analyzeTempoKey` once `analyzeFile` resolves, under the same AbortController (a new file or **Remove** cancels it).
   - The result has a `tempoKey` token. The values arrive as an `analyzer:tempoKey` event `{slot, token, ok, data | error}`, and the page drops one whose token isn't the card's.
   - Meanwhile the card says *Working out tempo and key…*.
   - The row shows BPM (1 decimal) with the beat note, the **key estimate** chip and note (shared with Listen: `camelot/keys.js` → `keyEstimate`), and tuning.
   - **Use 11A · 120.0 BPM on Camelot wheel** calls `setTrack` (fader at 0 %) and opens the wheel. The key is left out when there's no clear key.

### Tempo and key (`analyzeTempoKey`)
- **Decode:** `-map 0:a:0 -t 1200 -ac 1 -ar 22050 -f f32le`, the rate the Library check measured at (camelot.md → *Tests → Library check*).
  - About 0.5 s for a track. Mixes are cut to their first 20 minutes (`truncated`; the note says *first 20 min*), ~100 MB of samples.
- **Maths:** `tempokey.js` → `analyzeTrack`. It's Listen's maths plus:
  - **BPM:** `refineTempo` re-searches ±1 % with a 32-beat comb on an FFT autocorrelation. On 770 tracks, 82 % landed within ±0.1 of rekordbox (83 % within ±0.5; most misses are 4:3, e.g. 166.7 for 125).
  - **Key:** whole-track pitch histogram, same estimate and confidence as Listen (50 % exact vs rekordbox on that library).
- **Not a worker thread:** the onset and pitch loops are generators. `analyzeTrack` runs them in steps and yields to the event loop every ~12 ms (`setImmediate`), so main stays responsive for the 2–7 s of maths.
  - A test checks the event loop keeps ticking.
  - This avoids loading worker scripts from the packaged asar.
- **Beat note thresholds** are Listen's. On whole tracks, clarity ≥ 0.5 was right 77–90 % of the time and < 0.4 about 40 %.

### Decoding (`analyze.js`)
- **ffmpeg command:** `-map 0:a:0 -f s32le -acodec pcm_s32le pipe:1`, at the file's own rate and channel count. Neither `-ar` nor `-ac` is set: the native rate is the whole point, and an ffmpeg downmix would destroy the low bits.
- **Mono mix and used bits:** JS averages the channels into mono for the FFT, and ORs every integer sample to find the bits that carry signal (`usedBitsFromOr`). 24-bit audio arrives `<< 8`, so a padded 16-bit file shows 16.
- **Timing:** music-metadata is called with `duration: true`, so MP3s without a length header still get a correct time axis. The total length only sets the column width; the real decoded length decides the column count.
- **DSD (`.dsf`/`.dff`) is refused.** ffmpeg decodes it at a different rate than the file reports.

### Spectrogram (`SpectrogramBuilder`)
- **Size:** 1024 columns × 512 rows; FFT 4096 with a Hann window.
- **Each column** averages FFTs spread across its slice of the track: at least 4, and `ceil(slice / 4096)` (up to 32) for long tracks, so every sample is measured. Past 32 (over ~50 min at 44.1 kHz), `push()` skips the samples between windows (`skip`).
- **Each row** keeps the loudest bin in its band, so narrow tones survive.
- **Scale:** a full-scale sine is 0 dB in its bin. Bytes run from 0 = −150 dB (`DB_FLOOR`) to 255 = 0 dB; digital silence is clamped to −200 dB.
- **Average spectrum:** the long-term average of all columns. It is power-averaged down to 512 points for the chart.
- **Streaming:** the builder keeps one column plus one FFT of samples. Memory doesn't grow with track length.

### Detection (`findCutoff`)
The spectrum is first smoothed ±100 Hz **in power, not dB**. Averaging dB would let the gaps between harmonics drag the level down.

| Output | Rule |
|---|---|
| `cutoff` | The highest **brick wall**: the level drops ≥ 20 dB from the 800 Hz just below to the 800 Hz just above (with a 400 Hz gap either side), and the whole rest of the band up to Nyquist stays ≥ 15 dB down. The edge is the last bin within 6 dB of the music level, measured one window below the wall (the first window that trips the test straddles it). `null` when there's no wall. |
| `bandwidth` | Highest frequency within 45 dB of the 10–16 kHz music level |
| `ultrasonic` | Rates above 60 kHz only (Nyquist > 30 kHz): the power mean of 26 kHz … 0.9×Nyquist relative to that level. `present` ≥ −40 dB, `weak` −40…−60, `absent` below. |

**Calibrated on real encoder and resampler output** (`test/analyzer.test.js`), not just synthetic signals:
- LAME 128k stereo cuts at ~16.6 kHz. Mono 128k cuts at ~20 kHz, because LAME's low-pass follows bits per channel.
- ffmpeg's default resampler fades over ~4 kHz (−61 dB at 21 k → −101 dB at 25 k) with only ~50 dB of stopband. The measured edge of a 44.1 → 96 kHz upsample therefore lands anywhere from 24.0 to 25.5 kHz. That's why the hi-res rule uses ≤ 26 kHz, not 24 kHz.

### Verdicts (`verdicts` → `{ lossless, hires }`)
Both are computed per file in main. The page shows the one Settings asks for (`prefs.analyzer.checkHiRes`) and re-renders on `prefs:change`, so flipping the setting needs no new decode.

**Lossless (default, `losslessVerdict`):**

| Case | tone | Title |
|---|---|---|
| Lossy codec (`lossless === false`) | info | *Lossy file (MP3), not lossless* |
| Wall below 19 kHz (`LOSSY_BELOW`) | bad | *Made from an MP3, not real lossless*, with the estimated bitrate |
| Wall at 19–20.6 kHz (`MAYBE_BELOW`) | warn | *Possibly made from a high-bitrate MP3*: 224–320 kbps MP3s cut here, but so do some CD masters |
| Otherwise | ok | *Real lossless*. If it fades out below 16 kHz with no wall, a note says "like an old or lo-fi recording". |

A hi-res file upsampled from CD audio, or 16-bit audio padded to 24 bits, is still *Real lossless*; a note says so.

**Hi-res (optional, `hiresVerdict`):** checked in this order:

| Case | tone | Title |
|---|---|---|
| Lossy codec | info | *Lossy file (MP3), not lossless, so not hi-res* |
| Wall below 19 kHz | bad | *Made from an MP3, not real lossless* |
| Rate > 48 kHz and (wall ≤ 26 kHz, or no wall and ultrasonic `absent`) | bad | *Upsampled, not real hi-res* |
| Wall at 19–20.6 kHz | warn | *Possibly made from a high-bitrate MP3*. This outranks bit depth, because an MP3 converted by ffmpeg comes out as a "24-bit" FLAC. |
| Rate > 48 kHz, no wall, ultrasonic `weak` | warn | *Little sound above 24 kHz* |
| Rate > 48 kHz otherwise | ok / warn | *Genuine hi-res*, or *Hi-res sample rate, CD bit depth* when ≤ 16 bits are used |
| Real > 16-bit at ≤ 48 kHz | ok | *Real 24-bit at 48 kHz* |
| Otherwise | info | *CD quality, not hi-res* |

**Bitrate estimate (`likelyBitrate`):** MP3 bitrates whose LAME default low-pass (`LAME_LOWPASS`, from `lame.c` → `optimum_bandwidth` → `freq_map`: 96 → 15.1 k, 112 → 15.6 k, 128 → 17.0 k, 160 → 17.5 k, 192 → 18.6 k, 224 → 19.4 k, 256 → 19.7 k, 320 → 20.5 kHz) lie within 600 Hz of the wall. The result reads "128 kbps", "256–320 kbps" or "under 96 kbps".

**Calibration on real LAME / ffmpeg-AAC output, stereo, 2026-10-01:**

| Source → FLAC | Measured wall, pink noise / drums + chords | Lossless verdict |
|---|---|---|
| MP3 96k · 128k · 160k | 15.2 · 16.6 · 17.3 kHz | made from an MP3 (96–112 · 128 · 128–160 kbps) |
| MP3 192k | 19.5 / 18.7 kHz | possibly / made from an MP3 (192 kbps) |
| MP3 224k · 256k · 320k | 20.2 · 20.2 · 20.0 kHz | possibly made from a high-bitrate MP3 |
| MP3 V0 (VBR), AAC 256k | no wall | *Real lossless*: **missed** |
| Real 44.1/16 | no wall | Real lossless |

### UI
- **Card states:** `empty` (drop area) → `busy` (progress bar in the drop area) → `done` (result) / `error`.
  - A failed file shows its error **above the previous result**, which stays.
  - `pending` guards against late progress events from a cancelled decode.
- **Facts row:** codec, rate, bits (`· 16 used` when padded), channels, length, bitrate.
- **Spectrogram:**
  - Drawn on a canvas from the byte matrix through a 256-step lookup table. The contrast window is −140…−20 dB, and the `.an-scale` bar shows it with the same gradient.
  - **Colour scale from *Settings → Audio Analyzer → Spectrogram colours*** (`shared/js/colormap.js`, also used by Listen):
    - `color` (default): the classic spectral scale audio tools use, black → navy → blue → cyan → green → yellow → red → magenta → white. These are fixed data colours, the same in every theme.
    - `grayscale`: `--spectro-low` → `--spectro-high`, which follows the theme.
    - Switching redraws at once; cached bitmaps are dropped on `prefs:change`.
  - The verdict callout has 12px above and 20px below, so it reads as the headline.
  - The bitmap is cached per result and redrawn on resize (`ResizeObserver`).
- **Overlays:**
  - **Cutoff:** a dashed `--primary` line with a primary pill label.
  - **File limit:** a solid line for the file's own Nyquist. It appears only when comparing against a higher rate; above it, the canvas is **hatched**, so "can't hold sound" doesn't read as "silent".
- **Shared axis:** with compare on, both spectrograms and the chart run to the higher Nyquist.
- **Hover:** time · frequency · level under the pointer (spectrogram); a crosshair with each track's level (chart).
- **Average spectrum chart (SVG):**
  - 2px lines in `--series-a` (blue-600) / `--series-b` (red-600), a pair validated with the dataviz palette checker.
  - The cutoffs are dashed verticals in the series colour.
  - With one track, the title names the file. With two, a legend shows name and cutoff, so identity is never colour alone.

## Data shapes

```js
// analyzeFile() → IPC → renderer (typed arrays survive structured clone)
{
  name: 'Track.flac',
  format: { container, codec, lossless /* true | false | null */, sampleRate, bits, usedBits /* null for lossy */, channels, duration /* s, decoded */, bitrate /* kbps */ },
  spectrogram: { columns, rows: 512, image: Uint8Array /* rows×columns, row 0 = Nyquist */, nyquist, dbFloor: -150 },
  spectrum: Float32Array(512),      // dB, 0 … Nyquist
  edge: { cutoff /* Hz | null */, bandwidth, ultrasonic /* 'present' | 'weak' | 'absent' | null */ },
  verdicts: { lossless: Verdict, hires: Verdict }, // Verdict = { tone: 'ok' | 'warn' | 'bad' | 'info', title, notes: string[] }
}
```

The result also carries `tempoKey`: a token for the `analyzer:tempoKey` event that follows.

```js
// analyzeTempoKey → analyzer:tempoKey { slot, token, ok: true, data } | { slot, token, ok: false, error }
{
  bpm: 120,                       // refined, 2 decimals; null if no beat
  clarity: 0.609,                 // beat note: ≥ 0.5 steady, ≥ 0.25 some doubt
  key: { n, mode, camelot: '11A', name: 'F♯ minor', margin: 0.17, confidence: 'likely' | 'possible' | 'none', runnerUp: { camelot, name } } | null,
  tuning: 9,                      // cents from A440
  seconds: 358.1, truncated: false,
}
```

IPC (desktop-app.md → *IPC contract*): `analyzer:pick(slot)` → result or `null` (cancelled) · `analyzer:file(slot, path)` (preload only) · `analyzer:cancel(slot)` (also stops tempo/key) · `analyzer:progress` `{slot, frac}` · `analyzer:tempoKey` (above).

## Extending

- **Null test / alignment for compare** (the Python plan's GCC-PHAT + null test): align B to A by cross-correlation and subtract, to show whether two files hold the same audio. Put the maths in `spectrum.js`; it needs both decodes at once, so add a `compare(a, b)` in `analyze.js`.
- **Catch V0/AAC transcodes** (the main gap in the lossless check): look at frame-to-frame dropouts of the band above ~16 kHz (MP3 sfb21) and AAC's spectral holes, using `SpectrogramBuilder` columns. The first attempt (16–19 kHz vs 8–14 kHz per column) didn't separate them on synthetic material. Collect a few real V0/AAC-sourced FLACs and real CD rips, and only ship once it separates them.
- **Analyse the whole library:** cache results per key in the manifest (`record.analysis`, invalidated like `probe`), run it as its own phase and never in the convert path. The verdict is cheap; the decode is the cost.
- **Log-frequency view:** map rows logarithmically in `SpectrogramBuilder` (keep linear as the default; cutoffs read best linear).
- **DSD:** pass `-ar` explicitly and report the PCM rate ffmpeg actually produced.

## Gotchas & limitations

- **Fixed 2026-10-01: long tracks crashed the analyzer.** Above 1024 × 16384 samples (6:20 at 44.1 kHz, 5:50 at 48, 2:55 at 96 kHz), a column was wider than its 4 windows.
  - So the next column started beyond the buffered audio, `push()` dropped more than it held, `bufLen` went negative, and `Float32Array.set` threw `RangeError: offset is out of bounds`.
  - It depended on ffmpeg's chunk sizes, so it was intermittent.
  - The throw happened in the stdout `data` handler, so it escaped as an uncaught exception once per chunk, which is the endless dialog. Fixed by adaptive windows plus the `skip` path, and the handler now catches.
  - Regression tests: `spectrum.test.js` (wide columns, two chunk sizes, the skip path) and `analyzer.test.js` (a real 6:40 FLAC; an injected error must reject the analysis). All fail on the old code with the original error.
- **Errors while decoding** reject that one analysis (`Couldn’t analyse this file (…). Please report it.`), stop ffmpeg, and show in the card. The next file works normally.

- **High-bitrate VBR MP3 (V0) and AAC can pass as real lossless.** They leave no wall in the average spectrum. The known extra fingerprint, the top band (sfb21, above ~16 kHz) dropping in and out from frame to frame, was tried: the high band's level relative to 8–14 kHz, per column. On synthetic noise and drum+chord material it didn't separate V0/AAC from real files, so it isn't shipped. Validate it on real music first (*Extending*).
- **"Real 24-bit" can't be trusted on its own.** A decoded MP3 is float, so ffmpeg writes a 24-bit FLAC whose low bits are full of rounding noise. That's why lossy evidence outranks bit depth in both verdicts.

- **Heuristics, not proof.** A genuine hi-res recording of a source with no ultrasonic content (old tape, some mastering chains) reads *Little sound above 24 kHz* or *Upsampled*. A high-bitrate MP3 and some CD masters both cut near 20 kHz, so that range is only ever *possibly lossy*. The copy says so.
- **The measured edge of a slow resampler** sits at the bottom of its skirt (~25 kHz for ffmpeg's default), not where the sound starts fading (~21 kHz). The 26 kHz rule absorbs this; don't tighten it to 24 kHz.
- **The mono mix hides stereo-only content.** Out-of-phase material cancels in the FFT, but the used-bits check runs on every channel.
- **The main process does the FFTs**, interleaved with decoding chunk by chunk. A 10-minute 192 kHz file takes a few seconds; the window stays responsive. If it ever doesn't, move `SpectrogramBuilder` into a `worker_threads` worker.
- **Drag and drop relies on `webUtils.getPathForFile`.** A `File` the page built itself returns `''`, and main refuses it, so the page can't make main read arbitrary paths (D23).
- **The SVG chart is rebuilt on every render**, which is cheap at 512 points × 2 series. Spectrogram bitmaps are cached per result and only re-scaled on resize.

## Tests

| File | Covers |
|---|---|
| `test/spectrum.test.js` | FFT bin placement; 0 dB calibration and column count; walls at 16 kHz and 21 kHz found within ~100 Hz; no false wall on a 1/f spectrum running to Nyquist; ultrasonic present/absent; every verdict branch; `usedBitsFromOr` |
| `test/analyzer.test.js` | A 6:40 file (the long-track crash); an error injected mid-decode must reject, not escape. Real ffmpeg output: genuine 96/24 pink noise, 44.1 → 96 kHz upsample, FLAC from a 128k stereo MP3, 16-bit padded into 24, CD quality, a raw MP3, progress and cancel. Tempo and key of a 40 s 126.5 BPM A-minor file (±0.05 BPM, 8A) and its cancel |
| `test/tempokey.test.js` | `analyzeTrack` (refined BPM, key, the event loop keeps running, cancel), `refineTempo`, key confidence and the minor lean (camelot.md → *Tests*) |

UI smoke: open the rail's wave item and drop files with CDP `Input.dispatchDragEvent` (`data: {items: [], files: [absPath], dragOperationsMask: 1}`). That's real disk files, so the `webUtils` path is exercised. Stub `dialog.showOpenDialog` for **Choose…** (testing.md → *UI smoke*).
