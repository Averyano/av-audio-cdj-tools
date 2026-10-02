# Roadmap

These are planned features in the maintainer's order of priority. Each one notes where it plugs in, so a new feature starts from the right place. When one ships, move its essentials into the relevant component doc, log any decision in decisions.md, and delete it here.

## 1. Playlist conversion — M3U/M3U8 ✅ shipped (playlists.md); rekordbox XML still to do
Goal: the same playlists, pointing at the converted AIFF files, keeping cue points and beatgrids.

- **What exists:** M3U/M3U8 relinking with per-entry matching, manual picks and prefixed output (playlists.md). `matchEntry` is reusable for any playlist format.
- **Next, rekordbox XML** (preserves cues, grids and play counts):
  - For each `TRACK`, resolve `Location` (a `file://localhost/…` percent-encoded URL) and run `matchEntry`.
  - Rewrite `Location`, `Kind`, `Size`, `BitRate` and `SampleRate` for matched tracks.
  - Cue and beatgrid times survive, because they are in seconds and lossless conversion or resampling keeps the timing.
  - Prior art: `stith` gist, `b1scoito/rekordbox-playlist-converter`.
- **Where:**
  - `src/engine/playlists.js` (or a sibling `rekordbox-xml.js`)
  - a format switch in the Playlist card
  - a new section in playlists.md

## 2. FLAC analysis ✅ single-track analyzer shipped (analyzer.md)
- **Shipped:**
  - drop or pick a track → spectrogram, cutoff, ultrasonic check, used bits, plain-language verdict (real lossless by default, hi-res per Settings)
  - compare two tracks on one frequency scale with an average-spectrum chart
  - tempo (refined to ~0.01 BPM) and a key estimate per track, with "Use on Camelot wheel" (D34)
  - JS + ffmpeg; the Python project held no analysis code
- **Next** (recipes in analyzer.md → *Extending*):
  - null test / alignment for compare
  - lossy artefacts beyond the cutoff
  - whole-library analysis cached in the manifest (`record.analysis`), never in the convert path

## 2b. Camelot wheel ✅ pitch shift, target mode and Listen shipped (camelot.md)
- **Shipped:**
  - single-deck pitch shift, i.e. key, BPM, CDJ range and fader → landed key, cents, compatible keys and the maintainer's mixing chart
  - target mode: click a suggested key → "2B → 1B · F♯ major becomes B major" and the fader to get there
  - **Listen**: tempo, key estimate and tuning from 10 s of a mic or an interface's line inputs (macOS, any pair, e.g. Scarlett 3/4; D30, D31)
  - the **Library check** (`tools/keytest.js`) scores tempo/key against a rekordbox-analysed library (D32–D34)
- **Measured on a 770-track test library** (camelot.md → *Library check*): BPM 82 % within ±0.1 of rekordbox; key 50 % exact (44 % for 10 s takes).
- **Next:**
  - fix the 4:3 tempo errors (7 %);
  - better major/minor (mode) detection;
  - recipes for both in camelot.md → *Extending*.
- **Possible next** (from the prototype handoff; **ask the maintainer before building**):
  - two-deck mode: are A and B compatible after pitching, and what fader % on B matches A's BPM?
  - import keys/BPMs from a rekordbox XML export
- **Untested:** line inputs on Windows (Focusrite there usually lists each pair as its own device; ffmpeg `dshow` isn't wired).
- **Library keys:** filling the deck from the user's own tracks needs each track's key. Library visualisation (below) already plans to cache key/BPM at probe time.

## Settings ✅ page and data structure shipped (ui.md → *Settings*, D25)
- **First option:** *Camelot Wheel → Automatically apply analyzed BPM* (the key estimate is never auto-applied, D34).
- **Candidates for more prefs** (each is one `PREF_SECTIONS` entry):
  - the accent scheme (`data-accent`, D20)
  - night mode once it's built
  - Listen's input device and take length

## Releases ✅ versions, CI builds and the update check shipped (desktop-app.md → *Updates*, *Releases*; D40–D42)
- **Before the first public release:** make the repo public (the update check and downloads need it), push a `v1.0.0` tag, write the notes on the draft, publish.
- **Unverified until the first CI run:** the Windows and Linux builds, and the test suite on Windows (non-blocking there for now).
- **Later:** signing + notarisation, then true auto-update with `electron-updater` (desktop-app.md → *Extending*); an app icon; Linux `.deb`; arm64 Windows/Linux.

## 3. Library visualisation
Goal: see what's in the library.

- **Data:** the cached `probe` already holds format, rate, bits, channels and duration per track. Add genre, BPM and key by caching a small tag subset at probe time (music-metadata `common`, `skipCovers`).
- **Where:** a new renderer view (ui.md → *Extending*). Aggregate in the engine and return it through IPC, rather than shipping the raw manifest to the page. If the data grows large, see D8 (SQLite).

## Smaller extensions (recipes live in the component docs)
| Idea | Doc → section |
|---|---|
| Hi-res AIFF as a source format (ALAC is done, D37) | audio-pipeline.md → *Extending* |
| Other player profiles (CDJ-900, XDJ…) | audio-pipeline.md → *Extending* |
| Copy compatible files into the output (reverses D2) | decisions.md D2; library-sync.md → *Planning* |
| Confirmed clean-up of orphaned outputs (explicit only, D3) | decisions.md D3 |
| Detect moved tracks via FLAC audio MD5 | library-sync.md → *Extending* |
| ffmpeg path / soxr build selectable in the UI | desktop-app.md → *Extending* |
| Force 16-bit output | audio-pipeline.md → *Extending* |
| App icon, signing, auto-update | desktop-app.md → *Extending* |
