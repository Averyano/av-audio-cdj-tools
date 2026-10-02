# Decision log

Each entry records what was decided, why, and when it's worth revisiting. Add new entries at the bottom and never renumber, because other docs reference these IDs. If a decision is reversed, mark it **Superseded by Dnn** instead of deleting it.

---

### D1 — Electron + Node, engine kept pure Node
- **Decided:** 2026-09-27, by the maintainer.
- **Why:**
  - All-JS stack the maintainer is comfortable with.
  - Native folder dialogs give real absolute paths.
  - Mature packaging for macOS and Windows.
  - Keeping the engine free of Electron lets the CLI and tests run it directly.
- **Alternatives:** Python + pywebview (would match `../audio-analyzer`), PySide6, Tauri.
- **Revisit if:** heavy DSP or analysis features arrive (see roadmap.md), or the app size (~200 MB) becomes a problem.

### D2 — Already-playable files are skipped, not copied
- **Decided:** 2026-09-27, by the maintainer.
- **Why:** the output holds converted tracks only, with no duplicated disk usage.
- **Consequence:** a library with MP3s needs both folders referenced in rekordbox.
- **Revisit if:** the maintainer wants the output to be a complete, self-contained USB library. That would be a "copy compatible files" option, with `action: 'copy'` in `buildPlan`.

### D3 — Never delete or modify orphaned outputs
- **Decided:** 2026-09-27, by the maintainer.
- **Why:** an unmounted drive or an accidental source deletion must never destroy converted files.
- **Consequence:** missing sources are only counted (`counts.missing`), and renames leave stale outputs behind.
- **Revisit if:** clean-up is wanted. It must be an explicit, confirmed action listing the files, never automatic.

### D4 — Family-aware resampling
- **Decided:** 2026-09-27, by the maintainer.
- **Rule:** 88.2/176.4k → 44.1k and 96/192k → 48k. These are integer ratios, and 44.1/48k are untouched.
- **Why:** the cleanest conversion, and the NXS1 accepts both 44.1k and 48k.

### D5 — Bit depth: ≤16 → 16, deeper → 24
- **Why:**
  - 24-bit is the NXS1 maximum.
  - 32-bit float and int sources are truncated to 24 with no audible loss.
  - Dither is applied only when resampling to a 16-bit target.

### D6 — Tags are written by our own ID3v2.3 encoder, not ffmpeg
- **Why:** ffmpeg's ID3 writer puts comments into `TXXX`, and its mapping sends BPM and key to `TXXX:BPM` / `TXXX:INITIALKEY`. rekordbox ignores all of these. Our encoder gives:
  - exact frames: TBPM, TKEY, TPUB, COMM, APIC
  - no temp cover files
  - no command-line length limits
- **How:** ffmpeg writes audio only (`-map_metadata -1`), then `appendAiffChunk` adds `ID3 `.
- **Revisit if:** a future ffmpeg writes COMM and a mapping layer is wanted; the custom encoder is still simpler.

### D7 — music-metadata for probing, no ffprobe
- **Why:**
  - Pure JS, header-only, so probing is fast (no process per file).
  - It also reads tags and pictures.
  - `ffmpeg-static` ships no ffprobe.
- **Revisit if:** some files are unreadable by music-metadata but decodable by ffmpeg. A fallback could then try `ffmpeg -i` for `unreadable` files.

### D8 — JSON manifest in the app data dir (not SQLite, not in the output)
- **Why:**
  - No native modules, so no Electron rebuilds.
  - The output folder/USB stays clean.
  - Human-readable.
  - Atomic writes are enough at 10–20k tracks.
- **Revisit if:** libraries of 100k+ tracks, or queries needed by visualisation features. SQLite (e.g. `node:sqlite` once Electron ships it stable) would fit then.

### D9 — The output folder is the source of truth; the manifest is an optimisation
- **Why:** losing or moving the manifest must never force a full reconversion. An output that is newer than its source is adopted (self-heal).
- **Consequence:** an output edited or replaced by hand but newer than its source is trusted.

### D10 — FAT32/Windows-safe names on by default
- **Why:** macOS allows `: ? *`, which break on CDJ USB sticks (FAT32) and on Windows.
- **Consequence:** names can differ from the source. The manifest keeps the src→out mapping, which playlist relinking uses (playlists.md).

### D11 — Only folders that receive tracks are created
- **Why:** no empty folders from artwork-only or MP3-only directories cluttering CDJ browsing.
- **Revisit if:** an exact tree mirror is wanted. `manifest.data.folders` has the full list.

### D12 — Write to `.part`, verify, then rename
- **Why:** a crash, cancel or bad encode can never leave a truncated `.aiff` that later looks up to date.

### D13 — swr resampler fallback when soxr is unavailable
- **Why:** the bundled `ffmpeg-static` (6.x) has no libsoxr. swr with `filter_size=64` is transparent for DJ use.
- **Consequence:** soxr is used automatically when a build with `--enable-libsoxr` is supplied.

### D14 — ID3v2.3 (Latin-1/UTF-16), not v2.4
- **Why:** v2.3 is the most widely read version by rekordbox and older CDJ firmware. v2.4's UTF-8 and synchsafe frame sizes are less safe.

### D15 — Unreadable files are skipped, not attempted
- **Why:** without trustworthy stream info the target spec (rate family, bit depth) can't be chosen safely. These files are surfaced as a warning for the user to fix.

### D16 — Playlist matching: exact path first, then path tail; never guess silently
- **Order:**
  1. library key from the path
  2. manifest output / naming rules
  3. longest trailing-path match in the manifest or the converted folder
- **Ties are `ambiguous`** and shown yellow for a manual pick, instead of picking one.
- **Why:** playlists come from other machines and old drive paths, so exact matching alone fails. But a wrong track in a DJ set is worse than a visible gap.

### D17 — New playlist: misses left out, playable originals kept, Save dialog prefilled with the prefix
- **Decided:** 2026-09-27; the maintainer specified the prefix `av-`, the rest were defaults accepted with the feature.
- **Rules:**
  - Unresolved entries are omitted, and the count is shown before saving.
  - Entries that were never converted because the CDJ already plays them (MP3/AAC/compatible AIFF, D2) keep their original path.
  - Targets are absolute paths. The file is UTF-8 `.m3u8`, and `#EXTINF` lines are preserved.
- **Colours:** green = found, yellow = not found. The maintainer mentioned both red and yellow for "not found"; yellow was chosen because the row is fixable.
- **Revisit if:** playlists must be portable (relative paths), or misses should stay in as the original path.

### D18 — Playlist state lives in the main process
- **Why:** keeps the rule "every path the app reads or writes comes from a native dialog". The renderer only sees display data and sends row indexes.
- **Consequence:** the chosen playlist and its match are session-only.

### D19 — Manual and folder picks must end up CDJ-playable; recursive folder search is guarded and opt-in
- **Picks:** any audio file can be chosen. A playable file is used as-is. An original is swapped for its converted AIFF. An unconverted, unplayable file is refused with a reason, rather than putting a FLAC into a CDJ playlist.
- **Recursive search is off by default,** because the maintainer worried about someone searching their whole drive. It refuses:
  - roots
  - the home folder and its parents
  - `/Volumes`
  - system folders
- It also stops after 20,000 folders and can be cancelled.
- **Revisit if:** users routinely need to search whole music drives. Then raise the cap, or add a hard time limit instead.


### D20 — Concrete/onyx day theme, layered colour tokens, red/amber CTAs
- **Decided:** 2026-10-01. The maintainer supplied the mood (raw, techno, concrete, Swiss posters) and all four accent hexes. The rest were defaults chosen while implementing.
- **What:**
  - Day theme only. The old dark default and the OS-following `prefers-color-scheme` switch were removed.
  - Surfaces are concrete greys (never white) and text is onyx (never `#000`).
  - Colours are three layers: palette → semantic theme tokens → accent scheme (ui.md → *Colour system*). Components only touch layers 2 and 3, so night mode later is one token block plus a `data-theme` switch.
- **Accents:**
  - Red `#ed2540` is the primary CTA and amber `#faa819` the secondary. The maintainer leaned towards this pair as the more contrasty one.
  - Blue `#3a83c4` / teal `#3ec1c8` are kept as `data-accent="blue"`, one attribute away.
- **Accents are fills, not text.** All four brand colours are too light to read as text on concrete (≈2–2.6:1), so anything coloured is a solid block. Red text uses a darker `--red-700`.
- **Known trade-off:** white labels on the exact brand red (4.25:1) and blue (4.02:1) fall just short of WCAG AA for 13px text. The brand hexes were kept because the maintainer specified them. `--red-600`/`--blue-600` (5.4:1/5.3:1) are the AA-safe drop-ins: point `--primary` at them.
- **Danger and primary share red** in the default scheme. Danger uses the darker `-600`/`-700` shades and outline styling. They separate fully under the blue scheme.
- **Revisit if:** night mode is built (pick a night `--danger-text`; decide whether the app follows the OS), or AA becomes a hard requirement (move `--primary` to `-600`).

### D21 — Icon-only nav rail; views are static sections toggled with `hidden`
- **Decided:** 2026-10-01. The maintainer specified the rail: about 96px wide, logo on top, square items with a centred icon, Contact at the bottom, and the folder / wave / Camelot / envelope icons. They also specified the bento row: Convert from + Options as two half-width cards. The rest were defaults.
- **What:**
  - Every view lives in `index.html` as `.view[data-view]`. `showView` only flips `hidden` and `aria-current`.
  - No router, no re-render, no state reset: a running convert keeps going while another view is open.
  - The app always opens on the converter. The view isn't saved in settings.
- **Look:**
  - The rail is light (`--card`, like the footer bar), so the converter keeps the attention.
  - The current item is a solid onyx tile, the same language as a checked format toggle.
  - A pulsing `--primary` LED on the converter item shows a scan/convert running while you're elsewhere.
  - Changing the look later is token-only.
- **Window widened by the rail's 96px** (1056 / min 776), so the converter content keeps its old 960/680 widths. The responsive breakpoint moved from 760px to 856px for the same reason.
- **Settings item (maintainer, same day):** a cog, placed by default in the bottom group above Contact because it's app-wide, not a tool.
- **Sizing (maintainer, same day):** rail padding 24px and 18px icons; the logo stays 40px. Items are therefore 47px squares, and the icon is about 38% of an item.
- **Upcoming views are placeholders**, not disabled buttons, so the navigation works end to end. Contact got its address later (D38).
- **Revisit if:** views need deep links or their own state in the main process, or the vanilla-JS view switching gets crowded (then consider a framework, ui.md → *Extending*).

### D22 — Camelot pitch shift: maths in `engine/camelot.js`, deck in settings, app look over the prototype's
- **Decided:** 2026-10-01, porting the maintainer's prototype (`camelot-pitch-shift.html` + `HANDOFF.md`). The maintainer asked to adapt it to the app's architecture, syntax and design. The choices below were made without stopping.
- **Where the logic lives:**
  - The pure maths is in `src/engine/camelot.js`, with no imports.
  - Main needs it (`sanitizeDeck` for settings), the tests need it, and the renderer imports the file directly. Duplicating the ranges in main, or having main import from `src/renderer/`, would both be worse.
  - The renderer may import only this engine module. CLAUDE.md and architecture.md say so.
- **Persistence:** `settings.camelot` through the existing `settings:set`, not the prototype's localStorage. One store, one sanitizer, and `AUDIOCONVERTER_DATA_DIR` sandboxes it. Saves are debounced 300 ms because the fader fires continuously.
- **CDJ ranges:** checked against the CDJ-2000NXS operating instructions: 0.02/0.05/0.05/0.5 % steps, WIDE ±100 %, −100 % stops. The default range is ±10 because the deck powers on there. The prototype used ±6.
- **Mixing chart:** the maintainer's own chart is kept verbatim, including where it differs from standard Camelot. Both sections are shown.
- **Look:**
  - Panels, buttons, the LCD, the fader, the verdict and the meter use the theme tokens. The LCD is onyx with the secondary colour, the fader fill and cap line are primary, and range buttons work like the format toggles.
  - The prototype's fonts (remote Google Fonts, blocked by CSP) were replaced with Geist and the mono stack.
  - **Kept:** the colour-per-key wheel, because it's the recognised Camelot convention and echoes the rainbow bars in the maintainer's moodboard. It moved to OKLCH at fixed lightness so onyx text is readable on every key; the prototype's dark text on hsl blues and violets was about 2:1.
- **Layout:** a bento grid in the standard 980px shell: the deck as a tall card beside the wheel and the result, then the ruler, then mixing beside the landings and the explainer. The fader stretches to fill the deck card.
- **Revisit if:** the maintainer wants a monochrome wheel, a wider Camelot view than 980px, or one of the handoff's next steps (camelot.md → *Extending*).

### D23 — Audio analyzer: JS + ffmpeg, dropped paths via the preload, walls over thresholds
- **Decided:** 2026-10-01. The maintainer asked for an easy way to drop a track, see its spectrogram, and optionally compare two. The choices below were made without stopping.
- **No Python:** `../audio-analyzer` held only `progress.py`; every other folder was empty. Analysis is plain JS in the engine (`spectrum.js` pure, `analyze.js` I/O) on the bundled ffmpeg. That keeps D1 (no runtime besides Node) and gives it unit and e2e tests.
- **Amends D18:**
  - Dropped files are a second path source, for the analyzer only, and read-only.
  - The preload resolves the path with `webUtils.getPathForFile`, so the page never handles path strings. A `File` the page constructs has no path (`''`) and main refuses it, so the page still can't make main read an arbitrary path.
  - Main also requires an absolute path to a regular file with an audio extension.
  - Writes still come only from native dialogs.
- **Decoding as s32le at the native rate and channel count** gives the real used-bit count (padded 24-bit) as well as the spectrum. No ffmpeg downmix or resample, which would hide both.
- **Detection prefers brick walls** (steep and staying down to Nyquist) over level thresholds, and was calibrated on real LAME and ffmpeg-resampler output.
  - A wall at ≤ 26 kHz in a > 48 kHz file means upsampled. ffmpeg's default resampler skirt puts the measured edge at 24–25.5 kHz; real hi-res walls sit at 40 kHz and up.
  - Without a wall, ultrasonic energy is graded present / weak / absent. A borderline file gets *warn* ("little sound above 24 kHz"), not an accusation.
  - 19–20.5 kHz walls are only ever *possibly lossy*: high-bitrate MP3 and some CD masters both cut there.
- **Look:**
  - The spectrogram is a single neutral ramp (`--spectro-low` → `--spectro-high`), with the cutoff in `--primary`.
  - Compare uses one shared frequency axis, and the area above a file's Nyquist is hatched rather than black, so "can't hold sound" doesn't read as "silent".
  - Chart series are blue-600 / red-600, validated with the dataviz palette checker.
  - The verdict uses the new shared `.callout`, which the Camelot verdict now uses too.
- **Revisit if:** users report genuine files flagged, analyses get slow in the main process (move to `worker_threads`), or library-wide analysis is wanted (cache in the manifest; analyzer.md → *Extending*).

### D24 — Listen: audio input → main → classic DSP; permissions locked to audio-only
- **Decided:** 2026-10-01. The maintainer asked for a Listen button on the Camelot page that listens 5–10 s, builds a little spectrogram and detects tempo and pitch. The choices below were made without stopping.
- **Input:**
  - The page reads an audio input with `getUserMedia`, with **echo cancellation, noise suppression and AGC off**. It can be a mic, an interface, or a mixer's REC out (the best source).
  - It doesn't capture system audio: the music plays on CDJs, not this computer.
  - Capture uses an AudioWorklet, and the take is 10 s with Stop allowed from 4 s.
- **Analysis runs in main** (`engine/tempokey.js`), not the page. The page stays thin and the renderer import rule from D22 stays as it was (only `camelot.js`). The clip crosses IPC once (~2 MB) and is never written.
- **Algorithms:**
  - **Tempo:** spectral-flux onsets with a 6-beat autocorrelation comb, plus a 130 BPM octave prior and ½×/2× in the UI.
  - **Key:** a peak-picked chromagram with tuning estimation, then Krumhansl–Kessler. Classic, dependency-free and explainable.
  - **Tuning is shown** because on a pitched CDJ (Master Tempo off) it's exactly what this page is about.
  - All of it was tested on synthetic tracks, plus an end-to-end run through Chromium's capture using a fake device.
- **Permissions:**
  - `setPermissionRequestHandler` now grants only audio-only `media` from our own window. Before this, the app had no handler, so Electron granted everything.
  - The macOS consent goes through `systemPreferences`.
  - Packaged builds get `NSMicrophoneUsageDescription`; a signed build will need the audio-input entitlement.
- **Use as track** sets key + BPM and the fader to 0 %, because the clip is the track as it sounded.
- **Revisit if:** keys on real EDM disappoint (use EDM-trained profiles), DJs want the chosen input remembered (add it to the deck settings), or longer/continuous listening is wanted.

### D25 — Settings from a schema; a wide Camelot layout
- **Decided:** 2026-10-01. The maintainer asked for the settings data structure, with a *Camelot Wheel* section whose first option auto-applies Listen results, and to use the empty side columns on laptops with the wheel top right.
- **Settings:**
  - `engine/prefs.js` declares sections and prefs (key, type, default, label, hint), and imports nothing. Main sanitizes `settings.prefs` with it; the renderer draws the Settings page from it and reads values through `sanitizePrefs`, so an old settings file or an older main process still yields defaults.
  - Prefs are namespaced per section (`prefs.camelot.autoApplyListen`) rather than flat keys. Sections map one-to-one onto the page's titled cards, and new features add their own section.
  - The renderer may now import two engine modules (`camelot.js`, `prefs.js`), both import-free (amends D22).
- **Auto-apply** also re-applies after ½×/2×, so the deck always matches what's shown. It's off by default because the deck changes without asking.
- **Wide layout** only for the Camelot page, from a 1440px window. Three equal columns (Deck · Mixes · Result, then landings under Result) plus a pinned wheel column. That keeps the wheel visible while the rest scrolls, as asked.
  - The converter and analyzer keep 980px, where wider would only stretch rows.
  - The landings table had to be made compact to fit ~290px columns: the *Shift* header, a shorter key cell and 12px text.
- **Revisit if:** more views want the wide grid (make `.shell.wide` a shared modifier), or prefs need types beyond toggles (add a `CLEAN` + `CONTROLS` pair).

### D26 — The analyzer's default question is "real lossless or made from an MP3?"; hi-res is opt-in
- **Decided:** 2026-10-01. The maintainer clarified that "high quality" meant real lossless FLACs rather than MP3s converted to FLAC, not studio hi-res. They asked to keep the hi-res check as a setting, off by default.
- **What:**
  - `verdicts()` computes both a lossless and a hi-res verdict per file, and the page shows the one *Settings → Audio Analyzer → Also check hi-res claims* asks for. The setting applies at once, with no re-decode.
  - The lossless verdict ignores upsampling and padding: still lossless, with a note.
  - Both verdicts put lossy evidence first. An MP3 run through ffmpeg becomes a 24-bit FLAC, so "real 24-bit" alone proves nothing.
- **Thresholds** come from LAME's own low-pass table (`lame.c` → `optimum_bandwidth`) plus measured walls of real LAME output:
  - a wall < 19 kHz means made from an MP3 (≤ 160 kbps reliably, 192 kbps on music)
  - 19–20.6 kHz means *possibly* (224–320 kbps; some CD masters cut there too)
  - The estimated bitrate is shown as a range when the table entries are close.
- **Known gap, stated in the UI help and docs:** V0 VBR MP3 and AAC 256k leave no wall and pass as real. A frame-flicker heuristic was tried and didn't separate them on synthetic material, so it wasn't shipped.
- **Revisit with real music:** a frame-flicker / spectral-hole check to catch V0/AAC.

### D27 — Spectrograms in colour by default, grayscale as a setting
- **Decided:** 2026-10-01. The maintainer asked for the colour spectrograms audio tools use, and asked why it was grayscale.
- **Why it was grayscale:** the dataviz rule for magnitude is one sequential hue, never a rainbow. Rainbow scales aren't perceptually even, and they're harder for colour-blind readers. Grayscale also suited the concrete/onyx look.
- **Why colour now:** for spectrograms, the spectral scale (black → blue → cyan → green → yellow → red → magenta → white) is the domain convention. It separates small level differences that grayscale flattens.
  - *Settings → Audio Analyzer → Spectrogram colours* (`'color'` default, `'grayscale'`) applies to the analyzer and Listen.
  - It's the first `choice` pref, drawn as a `.segmented` control.
  - The colours are fixed data colours in `shared/js/colormap.js`, like the Camelot key colours. Grayscale still follows the theme tokens.

### D28 — Errors are handled where they happen; a safety net replaces Electron's crash dialog
- **Decided:** 2026-10-01, after long tracks crashed the analyzer. An uncaught `RangeError`, thrown once per decoded chunk, showed Electron's modal again on every OK, so the maintainer had to force-quit.
- **What:**
  - The analyzer's stream handler catches its own errors, stops ffmpeg, and rejects that one analysis.
  - In main, `uncaughtException`/`unhandledRejection` are logged and sent once to the page as an in-app banner, with no modal. The page reports its own unexpected errors the same way.
  - The root cause is fixed separately (analyzer.md → *Gotchas*).
- **Why not just a global handler:** it would hide the problem and leave a half-finished operation (ffmpeg running, a card stuck "Analysing"). The safety net only makes sure that a future bug can't lock the app.
- **Revisit if:** errors need reporting from users' machines (add a "copy details" button or a log file in the data dir).

### D29 — Clicking a key sets a target; it no longer replaces the track key
- **Decided:** 2026-10-01. The maintainer clicked a suggested key after Listen and expected the Result to read "2B → 1B, F♯ major becomes B major", relative to the current track. Instead the prototype's behaviour (clicking makes it the track key) changed both sides.
- **What:**
  - Wheel segments and suggestion chips set `deck.target`. The Result shows *sounding key → target*, the maintainer's chart relation, and the exact fader settings to pitch the track there (`pitchTo`), as one-click buttons.
  - The track key changes only via the select, Listen, or *Make … the track key*, which resets the fader to 0 %.
  - This is the handoff's "target key mode", built because the maintainer's request implied it.
- **Revisit if:** a two-deck view arrives. The target is then naturally deck B's key.
- **Changed by D35:** wheel segments set the track key again; only suggestion chips set the target.

### D30 — Listen records an interface's other inputs through ffmpeg (macOS)
- **Decided:** 2026-10-01. In the maintainer's setup, the CDJs feed inputs 3/4 of a Scarlett 6i6. Chromium's `getUserMedia` gives only a device's first two channels, so those inputs were unreachable.
- **Options weighed:**
  - Chromium multichannel: blocked for years upstream.
  - A native audio library (PortAudio/RtAudio, Ableton-style): it breaks "no native modules" (D1) and needs per-OS builds.
  - Recording through the **bundled ffmpeg** (AVFoundation): no new dependencies. Proven first with the maintainer's own 5 s test (6 channels; signal on 3/4), so it was chosen.
- **What:**
  - Main lists interfaces with > 2 inputs (Core Audio counts + ffmpeg's list) and records the chosen pair, mixed to mono at 48 kHz.
  - It streams live columns to the page and analyses in memory. The page keeps the Chromium path for ordinary mics.
  - The choice is saved in `settings.listenInput`.
- **macOS only.** On Windows, Focusrite exposes pairs as separate devices already; `dshow` is untested.
- **Resolved (D31):** the tempo that wandered on the first live test (148–168 BPM) was ffmpeg dropping audio buffers, not the music.

### D31 — Line-input holes are filled from timestamps and skipped by the tempo code
- **Decided:** 2026-10-01. Inputs 3/4 read a 130 BPM track as 149, while the phone mic read 130.
- **Cause, measured:**
  - ffmpeg 6's AVFoundation input keeps only the newest device buffer and is polled every ~10 ms. 10.04 s of wall clock gave 8.70 s of audio: ~12 % of the 512-sample buffers were gone.
  - That squeezed the take (130 × 10/8.7 ≈ 149), and the joins hid the beat.
- **Options weighed:**
  - A native recorder or a newer ffmpeg: breaks D1 or isn't available in `ffmpeg-static`.
  - Process priority (`taskpolicy -l 0`): measured, no change.
  - Repeating the audio before each hole: measured, lower clarity (doubled transients).
  - **Silence at the right timestamps** (`aresample=async=1`) restores the timeline exactly. **Masking exact-zero runs** in the onset maths removes the false onsets at the joins. Chosen.
- **What:**
  - `captureLine` fills holes (`min_hard_comp=0.001`, so each 10 ms hole is padded).
  - `onsetEnvelope` marks frames touching ≥ 32 exact zeros invalid, and `autocorr` averages over valid pairs only.
  - Starts that fail with `audio format is not supported` (≈ 4 in 10) are retried up to 6 times.
- **Result:** five back-to-back takes read 130 BPM at clarity 0.67–0.86, and the key matched the mic (3A). Clean audio gives the same numbers as before.

### D32 — Key detection is judged against the maintainer's rekordbox library before it's changed or dropped
- **Decided:** 2026-10-01. Key from Listen looked unreliable on techno. The maintainer asked whether to keep developing it or drop it.
- **Reading:**
  - Template matching (what we and rekordbox do) and CNNs are close on EDM: Faraldo's `edmm` templates scored 72.0 (MIREX-weighted) on GiantSteps, Korzeniowski & Widmer's CNN 74.6.
  - OpenKeyScan's CNN needs PyTorch (a ~780 MB bundle), which breaks D1.
  - Classical pieces (Bach/Chopin preludes) would only re-derive classical profiles. One major + one minor profile, rotated, already covers all 24 keys.
- **What:** `tools/keytest.js` scans the maintainer's library (whole tracks) against a rekordbox text export. It caches the engine's intermediate stages (~160 KB per track, outside the repo), so profile sets, confidence cut-offs, tempo refinements and a library-learned profile can be compared in seconds without decoding again.
- **Engine change:** `tempokey.js` exposes its stages (`tempoFromEnvelope`, `pitchHistogram`, `chromaFromHistogram`, `estimateKey(chroma, profiles)`). Listen's results are unchanged.
- **Next:** pick the profile set and the "unsure" threshold from the full run, or hide key if nothing is good enough. BPM refinement (32-beat comb) and the 4:3 errors are next for tempo.

### D33 — Key from the bass up: whole octaves C1–C6, 40 strongest peaks
- **Decided:** 2026-10-02, from run 1 of the Library check (770 tracks): 12–26 % exact for every profile set, with B/B♭/A♭ tonics read 2–6× too often.
- **Cause:** the pitch range was 60 Hz–2 kHz. It started above the bass, which carries the key in techno, and both ends fell on a B, which gave B an extra octave. Every peak within 60 dB counted, so hats and noise filled every bin.
- **What:** `pitchHistogram` takes the 40 strongest peaks per frame from C1 to C6 (whole octaves) and sizes the FFT for ~1.35 Hz bins at any sample rate.
- **Measured** on 150 random tracks: exact matches roughly doubled for every profile set (e.g. Krumhansl 20 → 42 %, library-learned 25 → 54 %).
- **Run 2, all 770 tracks:** Krumhansl 19 → 37 %, `edma` 18 → 40 %. The tonic agrees for 56–59 %; the mode is the main error left.
- The synthetic Listen tests pass unchanged.
- **Caveat:** a phone or laptop mic hardly picks up C1–C2 (33–65 Hz). Listen by mic may gain less than line input or files.

### D34 — Key is shown as an estimate; the analyzer gets tempo and key
- **Decided:** 2026-10-02, with the maintainer, after Library check run 2. BPM is reliable (82 % within ±0.1 of rekordbox on whole tracks). The key matched rekordbox only ~50 % of the time.
- **Key estimate:**
  - Profiles `edma` (Faraldo 2016, published, has both modes) with `MINOR_LEAN` 0.08. That took exact matches from 40 % to 50 %, and majors still read major a quarter of the time. 0.15+ gains 4 more points but almost never says major.
  - `confidence` *likely* / *possible* / *none* (margin 0.10 / 0.04). It's a weak signal: about 25 % of even "likely" keys were unrelated to rekordbox's. So "none" shows *no clear key* plus a best guess rather than hiding everything.
  - Labelled *Key estimate*. It never goes on the deck by itself: Listen's auto-apply sets only the BPM; the key needs **Use key …**.
- **Analyzer:** tempo and key of the whole file follow the spectrogram (`analyzer:tempoKey`), with the 32-beat refinement. **Use … on Camelot wheel** applies both (key only when not *none*), because the user clicks it on purpose.
- **Main-thread steps, not a worker:** the maths is generator-based and yields every ~12 ms. That keeps main responsive with no worker script to load from the packaged asar.
- **Next:** the 4:3 tempo errors (7 % of tracks); better mode detection. A CNN is still out (D1).

### D35 — A wheel click picks the track; suggestion chips set the target
- **Decided:** 2026-10-02, by the maintainer: clicking the wheel itself should clear the target and pick a new track.
- **What:** a wheel segment calls `setKey`, the same path as the Track key select. It becomes the track key and `deck.target` is cleared. Chips under *Mixes harmonically with* and in the mixing chart still set the target (D29).
- **The fader stays put**, like the select and like loading a new track on a CDJ. Only *Make … the track key* and Listen's *Use as track* reset it to 0 %, because they mean "this exact track, as it is".
- **Revisit if:** the maintainer expects a wheel click to also reset the tempo.

### D36 — "Pitch the track there" stops at ±16 %
- **Decided:** 2026-10-02, by the maintainer: pitching a track −25 % or +49 % is too extreme for anyone to use.
- **What:** `pitchTo` drops candidates beyond `PITCH_TO_MAX` (16, the widest range below WIDE). That leaves at most ±2 semitones (+12.2 % / −10.9 %); 3 semitones already needs ±18.9 %. When neither candidate is left, Result says how far the target is and to mix the two as they are.
- **WIDE stays** as a range for the fader itself; it's only not suggested as a way to reach a key.
- **Revisit if:** a "show extreme options" setting is wanted.

### D37 — ALAC is a source format, picked by codec
- **Decided:** 2026-10-02, by the maintainer. The CDJ-2000NXS can't play ALAC.
- **What:** `SOURCE_FORMATS.alac` covers `.m4a`, `.mp4` and `.alac`, ticked by default. ALAC almost always sits in `.m4a`, which AAC shares and the CDJ plays, so the entry has a `codec` rule (`/alac/i`). `formatIdFor(ext, probe)` replaced the extension-only `formatIdForExt`; the plan and playlist matching both use it.
- **Hi-res ALAC rate:** an MP4 sample entry stores the rate in 16 bits, so music-metadata reads 88.2k/96k/192k ALAC as 0. `probe.js#alacCookie` reads the real rate from the ALAC magic cookie inside `moov`. Cached probes from before (ALAC, no rate) are re-probed once.
- **Tags:** key and mix-artist in an .m4a are iTunes freeform atoms (`----:com.apple.iTunes:initialkey`), which music-metadata doesn't map. `tags.js#nativeValue` strips that prefix and matches the same names as Vorbis.
- **Existing settings** keep their stored format list, so a user from before ALAC ticks it once in *Convert from*.
- **Revisit if:** another codec shares an extension (e.g. FLAC in .mp4); the `codec` rule covers that too.

### D38 — Contact shows the address and opens it through main
- **Decided:** 2026-10-02. The contact address is hello@averyano.com.
- **What:** the Contact card shows the address as selectable text and an *Open in your email app* button. `openLink('email')` → `shell:openLink` → `shell.openExternal('mailto:hello@averyano.com')` (one `LINKS` map in main since D39). The URL is fixed in main; the renderer sends nothing (D18). If no mail app opens, the card says to copy the address.

### D39 — ffmpeg lives in Settings, with a binary picker and a download link
- **Decided:** 2026-10-02, by the maintainer: move the ffmpeg tag to Settings, with a setting and a download link for when ffmpeg isn't installed.
- **What:**
  - The chip left the converter header for a *Settings → ffmpeg* card. The converter shows a red callout with *Fix in Settings* only when no ffmpeg works, so a missing ffmpeg isn't hidden on another page.
  - **Choose…** picks a binary in a native open dialog (D18) and `checkFfmpeg` must accept it (runs, `-version` says ffmpeg); **Use bundled** clears it. Stored as `settings.ffmpegPath`, applied with `engine.setFfmpegPath`. Refused during a scan or conversion.
  - **Download…** opens `https://ffmpeg.org/download.html`. A link alone wouldn't help: an app opened from Finder doesn't see the shell's PATH (e.g. Homebrew's), so the picker is what makes a download usable.
  - Links: `shell:email` became `shell:openLink(name)` over a fixed `LINKS` map; the renderer still can't send a URL.
- **A chosen ffmpeg that stops working** (moved, deleted, quarantined) falls back to the bundled copy, and the card says so.
- **Changed by D41:** installers no longer bundle ffmpeg. *Use bundled* became **Find automatically**, the card gained **Check again**, and a *ffmpeg is needed* dialog opens at launch when none is found.

### D40 — Versions, GitHub releases and an in-app update check
- **Decided:** 2026-10-02, with the maintainer, before the first public release. The first version is **1.0.0**, for people the maintainer invites personally. (A 0.1.0 "Beta" label was planned first and dropped the same day: no beta chip, note or release-title suffix.)
- **What:**
  - `package.json` `version` is the only source; `npm version` bumps and tags `vX.Y.Z`. GitHub's *pre-release* flag is **not** used, because `/releases/latest`, which the app asks, skips pre-releases.
  - A tag push builds macOS (arm64 + x64), Windows and Linux installers into a **draft** release; the maintainer writes the notes and publishes (desktop-app.md → *Releases*).
  - The app asks GitHub's `/releases/latest` **once at launch** (no timer, no setting: the maintainer chose launch-only), shows an *Update available* dialog with the release's bullets and *Released 3 days 21 hours ago*, and **Download now** opens the release page. **Download later** puts that version off. About shows the version, a green dot and **Update to x.y.z** (desktop-app.md → *Updates*).
- **Why not auto-update:** `electron-updater` needs a signed macOS app (an Apple Developer ID). Opening the release page works unsigned.
- **Safety:** the dialog shows release notes as plain text, and the buttons open fixed URLs (`LINKS`), never one from GitHub's answer (D18).
- **Privacy:** each check is one request to GitHub, which sees the IP address. The README says so. There's no opt-out; adding one is a single `PREF_SECTIONS` toggle read in `createUpdates`.
- **Revisit if:** the app gets signed (then auto-update), people leave it open for days (add a periodic check), or someone asks to turn checks off.

### D41 — Installers don't bundle ffmpeg; the app finds the user's own
- **Decided:** 2026-10-02, by the maintainer: the people invited are likely to have ffmpeg, and if not, the app prompts them to download it from ffmpeg.org.
- **Why it also helps:** the macOS `ffmpeg-static` binary is a GPL + *nonfree* build that may not be redistributed. Not shipping ffmpeg removes every licence obligation from the installers. The installers are also smaller, and the Mac x64 build no longer needs its own ffmpeg.
- **What:**
  - `ffmpeg-static` moved to **devDependencies**: source checkouts and the tests still get it; the installers don't.
  - `locateFfmpeg` also tries `knownLocations()` after PATH (Homebrew, MacPorts, winget, Scoop, Chocolatey, `C:\ffmpeg\bin`, `/usr/bin`, `/snap/bin`). Without that, a Mac app opened from Finder never sees Homebrew's ffmpeg. Verified on 2026-10-02: the packaged app with a Finder-like PATH found `/opt/homebrew/bin/ffmpeg` 8.1.1, and a conversion with it passed verification.
  - No ffmpeg → a *ffmpeg is needed* dialog at launch with a per-OS tip (`brew install ffmpeg`, `sudo apt install ffmpeg`, or unzip a Windows build and choose `bin\ffmpeg.exe`), **Download ffmpeg** (ffmpeg.org/download.html), **Choose…** and **Check again**.
  - A downloaded, quarantined ffmpeg on macOS gets a specific message (Privacy & Security, or `xattr -d`) instead of "not a working ffmpeg".
- **Caveat:** macOS and Windows don't ship ffmpeg, and many Linux desktops don't either. For anyone outside a technical circle, the dialog is the first thing they see.
- **Also decided here:** macOS builds are **ad-hoc signed** (`mac.identity: "-"`, `hardenedRuntime: false`). A downloaded unsigned app is reported as *damaged* with no way to open it; ad-hoc, macOS offers *Open Anyway*. Real signing stays out of scope (*unsigned is fine*, the maintainer).
- **Revisit if:** many users get stuck at the dialog. Then bundle an LGPL ffmpeg per OS in CI (with its licence text and a source link), which was the earlier plan.

### D42 — Developer docs are public, in `docs/`
- **Decided:** 2026-10-02, before making the repo public.
- **What:** the docs moved from `.claude/docs/` to `docs/`, where people look. `CLAUDE.md` and a one-line `AGENTS.md` point AI coding tools at them. Mentions of the person directing the work became "the maintainer", chat quotes became plain reasons, and the private library check is described as a "770-track test library". The numbers stay, because they're the evidence behind D32–D34.
- **Why keep them public:** they explain every subsystem, decision and test, which is most of what a new contributor needs. Stale docs mislead, but the "update the doc in the same change" rule covers that.
- **Revisit if:** something personal or sensitive needs to go in. That belongs outside the repo.

