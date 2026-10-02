# Camelot wheel (pitch shift)

For DJs who mix by Camelot key on a CDJ. Pick a track's key and BPM, choose a tempo range and move the fader. With **Master Tempo off**, a tempo change also changes the pitch. The view shows which Camelot key the track lands in, how many cents it is off that key, and what it mixes with.

Ported from a standalone prototype (`camelot-pitch-shift.html` + `HANDOFF.md`, 2026-10-01). The prototype's look was redone in the app's design system; its behaviour is kept.

## Scope & files

| File | Role |
|---|---|
| `src/engine/camelot.js` | **All the maths**: key model, names, tempo → pitch, landings, compatible keys, the maintainer's mixing chart, tuning verdict, `sanitizeDeck`. No imports at all. |
| `src/renderer/camelot/view.js` | `initCamelot(saved, save)`: builds the wheel, fader scales and ruler once, then `render()` redraws everything from `deck` on each change. DOM only. |
| `src/renderer/camelot/camelot.css` | Styles; every class is prefixed `cam-` |
| `src/renderer/index.html` → `[data-view="camelot"]` | Static skeleton (cards, controls, ids `cam-*`) |
| `src/renderer/app.js` → `boot` | Calls `initCamelot(state.settings.camelot, save)` and debounces the save (300 ms) |
| `src/main/main.js` → `sanitize` | Stores the deck as `settings.camelot` via `sanitizeDeck` |
| `src/engine/tempokey.js` | **Listen maths**: onset envelope, tempo, chromagram + tuning, key (main only; imports `spectrum.js` and `camelot.js`) |
| `src/renderer/camelot/listen.js` | `initListen({api, call, apply})`: input capture, live spectrogram, result card |
| `src/renderer/camelot/capture-worklet.js` | AudioWorklet: mixes the input to mono, posts 4096-frame chunks |
| `tools/keytest.js`, `keytest-lib.js`, `keytest-worker.js` | **Library check** (developer tool, not packaged): scores `tempokey.js` against rekordbox's BPM/key on whole tracks of a real library. See *Tests → Library check* |
| `src/engine/linein.js` | **Line inputs**: lists multichannel interfaces (Core Audio channel counts + ffmpeg's AVFoundation list), records a chosen pair through ffmpeg, computes the live columns |
| `src/renderer/camelot/keys.js` | `keyColor()`, shared by the deck and Listen |
| `src/main/main.js` → `listen:*`, `lockPermissions` | Mic consent (macOS), clip analysis, the permission lockdown |

**Why the maths is in `src/engine/`:** it's pure domain logic used by three callers: the renderer (imports the file directly), main (settings sanitizing) and the tests. It's the only engine module the renderer imports. That's safe because it imports nothing and touches no system API (decision D22).

## Behaviour

### Key model
A key is `{ n: 1..12, mode: 'A' | 'B' }`; A = minor, B = major (rekordbox "alphanumeric").

| Function | Rule |
|---|---|
| `rootPc(key)` | minor `(8 + 7·(n−1)) mod 12`, major `(11 + 7·(n−1)) mod 12`; 1A = A♭m, 8A = Am, 1B = B, 8B = C |
| `step(n, d)` | move `d` positions on the wheel, wrapping to 1..12 |
| `shiftSemitones(n, s)` | `+1` semitone = 7 positions clockwise. The letter never changes when pitching. |

### Tempo → pitch (`pitchShift`)
```
ratio = 1 + pct/100        semitones = 12·log2(ratio)       nearest = round(semitones)
cents = (semitones − nearest)·100  ∈ [−50, +50]              result = shiftSemitones(n, nearest)
```
- **Master Tempo on:** `semitones = 0`, the key stays, the BPM still changes.
- **`ratio ≤ 0`** (−100 % on WIDE): `stopped`, and `semitones`/`nearest`/`cents`/`result` are `null`. Never render `NaN`.
- **Exact landings** (`semitoneLandings`): `pct = (2^(k/12) − 1)·100` for every integer `k` in −12…12 within the range.

### Tempo ranges (`RANGES`)
Values from the **CDJ-2000NXS operating instructions** (*Adjusting the playing speed*), checked 2026-10-01:

| Range | Max | Step |
|---|---|---|
| ±6 | 6 % | 0.02 % |
| ±10 | 10 % | 0.05 % |
| ±16 | 16 % | 0.05 % |
| WIDE | 100 % | 0.5 % |

- Switching range clamps and re-snaps the value (`snapPct`, which also rounds to 2 decimals against float noise).
- The real deck powers on at ±10, so that's the default.

### Tuning verdict (`tuning`)
| \|cents\| | tone | Copy (example) |
|---|---|---|
| ≤ 10 | `ok` | *Lands in 8A, 1 cent sharp.* / *Still in 1A. No pitch change.* |
| 10–25 | `warn` | *Closest to 1A, but 17 cents flat. Slightly out of tune.* |
| > 25 | `bad` | *Between 8A and 3A. 33 cents off, so it will clash with both.* The second key is the neighbour in the direction of the detune. |
| Master Tempo on | `info` | *Master Tempo is on, so the key stays …* |
| stopped | `bad` | *At −100% the track stops.* |

Sharp if cents > 0, flat if < 0; "1 cent" is singular.

### Mixing suggestions
- **Mixes harmonically with** (`compatibleKeys`): standard Camelot. Same key, ±1 on the wheel, and the other letter.
- **Mixing chart** (`mixingChart`): **the maintainer's own chart, authoritative.** It deliberately differs from standard Camelot; e.g. its "perfect match" is the diagonal (1A ↔ 12B). Don't "correct" it.
  - Entries with `semitones` (±1, ±2) change the key. They get a dashed border and a `+2 st` label.
  - Rows for a minor key: perfect `nA, (n−1)B` · boost+ `nB, (n+1)A` · boost++ `(n+2)A, (n+7)A` · drop− `(n−1)A` · drop−− `(n−2)A, (n−7)A` · mood `(n+3)B`.
  - Rows for a major key: perfect `nB, (n+1)A` · boost+ `(n+1)B` · boost++ `(n+2)B, (n+7)B` · drop− `nA, (n−1)B` · drop−− `(n−2)B, (n−7)B` · mood `(n−3)A`.
- Clicking a suggested key or chart chip sets it as the **target** (*Target* below). Clicking a **wheel segment** makes it the track key and clears the target (D35).

### UI layouts
- **≥ 1440px window (laptop, maximized):** `.cam-shell` switches to named grid areas, up to 1600px wide. The pinned wheel is `position: sticky` inside the scrolling `.shell`, so it stays in view while the rest scrolls.
  ```
  head    head    head    head
  listen  listen  listen  wheel     (row dropped while Listen is hidden, via :has())
  deck    mix     result  wheel
  deck    mix     land    wheel
  ruler   ruler   ruler   wheel
  notes   notes   notes   wheel
  ```
  - **Columns** are `repeat(3, minmax(0, 1fr)) minmax(300px, 360px)`.
  - **Tighter content to fit ~290px columns:** chart labels narrow to 104px, table cells to 8px padding and 12px text, and the landings key cell drops its "· Am" (still in the tooltip).
  - **Measured:** no overflow at 1440, 1512 and 1920 with every range.
- **857–1439px:** the 4-column bento below.
- **≤ 856px:** a single column.

### UI (bento layout inside `.shell`, 857–1439px)
| Card | Contents |
|---|---|
| Deck (`.span-2.row-2`, left) | LCD (tempo %, range, MT, `1A → 8A`, new BPM); key select (24 options `1A · A♭m`); BPM input; range buttons; Master Tempo (`.toggle`); vertical fader with scale (left) and semitone marks (right; on WIDE only every 3rd); −/+/Tempo reset; exact % input |
| Wheel (`.span-2`) | SVG, 12 at the top, B outside, A inside. Original = dashed outline, result = solid outline, the result's standard neighbours half-lit, the rest dimmed. A curved arrow original → result runs behind the hub; the hub shows `+1 SEMITONE` / `KEY LOCKED` / `STOPPED` and the result key. Clicking a segment (or Enter/Space on it) sets the track key; a hint under the legend says so. |
| Result (`.span-2`) | from → to chips, key names, verdict (shared `.callout`), stats, cents meter (zones per the verdict) |
| Pitch ruler (full width) | 25 chromatic cells, root −12 … +12. Dashed line = original root; red marker = continuous pitch, clamped to ±12.5. No cell is filled: the root outline plus the marker are enough. Scrolls inside its own box. |
| Mixing (`.span-2.row-2`) | standard compatible keys + the mixing chart |
| Exact landings (`.span-2`) | one row per landing in range; the current one is highlighted when \|cents\| ≤ 10; clicking a row turns MT **off** and jumps the fader |
| How the maths works (`.span-2`) | explainer copy from the prototype |

**Fader:**
- Minus at the **top**, plus at the bottom, like a CDJ.
- Drag with pointer capture; double-click resets.
- Keys: ↑/← = −step, ↓/→ = +step, PgUp/PgDn = ×10, Home or 0 = reset. `role="slider"` with ARIA values.
- The fader grows to fill the deck card (`flex: 1`, min 300 px of travel).

**Colours:**
- Everything uses theme tokens. The LCD is `--lcd-bg`/`--lcd-ink` (onyx with the secondary colour, amber by default). The fill and cap line use `--primary`. Text on key colours uses `--key-ink`; the piano uses `--piano-white`/`--piano-black`.
- **Per-key colours** are the one exception. `keyColor()` in `view.js` follows the classic Camelot wheel hues (1 = green … 8 = red) in OKLCH at a fixed lightness (A 0.75, B 0.84), so onyx text reads on every key.

### Target
Clicking a suggested key ("Mixes harmonically with" chip, mixing-chart chip) makes it the **target**: the key you're heading for, such as the next track. Clicking it again clears it. The track key stays; it changes through the Track key select, a wheel segment, Listen, or **Make … the track key**.

A **wheel segment** click is a new track (`setKey`, like the select): it becomes the track key and the target is cleared. The fader stays where it is, as on the hardware (D35).

- **Result card with a target:**
  - **Chips:** *where the track sounds now* (the pitched key, or the track key with Master Tempo on or at 0 %) → the target, e.g. **2B → 1B**, *F♯ major becomes B major*.
  - **Relation** (`mixRelation(here, target)`): the chart's row if it lists the target, e.g. *Energy drop − (gentle drop). Mixes harmonically.*; else the standard Camelot rule; else a warn callout, *Not a harmonic match … will probably clash*.
  - **Pitch the track there** (`pitchTo(track, target, range)`): the fader settings that land the **track key** exactly on the target. There are two candidates, k and k − 12 semitones, nearest first. Only those within **±16 %** (`PITCH_TO_MAX`) are offered, i.e. at most ±2 semitones (±12.2 %); 3 semitones is already ±18.9 % (D36).
    - Each is a button that turns Master Tempo off, switches to the smallest range that reaches it (labelled, e.g. *· ±16*), and sets the fader. *· now* marks the one the fader is at.
    - Same letter but too far (e.g. 2B → 3B: −5 st / −25 %, +7 st / +50 %): no button, a hint instead: *3B is 5 semitones away, so the fader would need −25.08%: too far to pitch. Mix them as they are.* (`away` is the nearer candidate.)
    - A different letter can't be reached by pitching (the letter never changes). For the relative key (same number), the card says the track has the same notes at 0 % and offers *0.00 % · back to 2B*.
  - **Make … the track key:** the target becomes the track, fader at 0 %, target cleared. **Clear target** removes it.
  - The tuning callout is hidden while a target is shown; the stats and meter still describe the deck's pitch.
- **Wheel:** the target segment gets a `--primary` outline (`.cam-seg.target`) and is drawn on top; the legend gains *Target*. Chips that are the target get a `--primary` ring (`.cam-key.target`, `aria-pressed`).
- **Stored** in `deck.target` (settings), so it survives a restart. Changing the track key by any route clears it.

### Listen
The **Listen** button in the page header listens to an audio input (mic, audio interface or mixer REC out) for 10 s, then shows tempo, a **key estimate** and tuning.
- **Use … BPM** puts the BPM on the deck with the fader at 0 %, since what was heard is the track as played.
- **Use key 8A** does the same for the key. It only shows when the estimate is at least *possible*.
- The key is an estimate: it matched rekordbox on about half of the test library (*Tests → Library check*), so it never goes on the deck by itself (D34).

**Settings → Camelot Wheel → Automatically apply analyzed BPM** (`prefs.camelot.autoApplyListen`, default off) hides the BPM button. The BPM is applied as soon as it arrives, and again after ½× / 2×, with the note *BPM applied to the deck automatically · … · change this in Settings*. The key still waits for its button.

**Flow** (`listen.js`):
1. `listen:access`: on macOS, main asks for mic consent once (`askForMediaAccess`). `denied`/`restricted` → the copy points to System Settings, and an app restart is needed after changing it.
2. `getUserMedia` with **echoCancellation, noiseSuppression and autoGainControl off**: they're made for voice and wreck music.
3. The graph is source → `capture` worklet → gain 0 → destination (the graph only runs if it reaches the output; nothing is played), plus source → `AnalyserNode` for the live picture.
4. **Live spectrogram:** fills left to right over the 10 s on a log frequency axis (40 Hz–12 kHz), in the colour scale from *Settings → Audio Analyzer → Spectrogram colours*. An LCD-style overlay shows the countdown, a level meter, and *Hardly any sound is coming in* after 2 s below −45 dBFS.
5. **Auto-stop at 10 s**, or **Stop** (≥ 4 s, otherwise an error). The chunks are joined into one `Float32Array` and sent to main (`listen:analyze`, ≤ 30 s). The audio is never written to disk and is dropped after analysis.

**Line inputs (inputs 3/4 of an audio interface):**
- **Why:** Chromium's `getUserMedia` only delivers a device's **first two channels** ([Chromium 40403559](https://issues.chromium.org/issues/40403559); Firefox has the same limit). A Scarlett 6i6 with the CDJs on inputs 3/4 can't be heard that way.
- **How (macOS):** `listen:lineInputs` → `listLineInputs` (main).
  - It takes Core Audio input counts from `system_profiler SPAudioDataType -json` (no permission needed, ~0.2 s) and keeps the devices ffmpeg's AVFoundation list also has with **more than 2 inputs**. Each one is offered as pairs (`channelChoices`: 1/2, 3/4, 5/6, plus an odd last single).
  - The Input select shows them under a `<optgroup>` (*Scarlett 6i6 USB · inputs 3/4*). The device's own Chromium entry is hidden: it could only give 1/2. Chromium labels carry a suffix like ` (1235:8203)`, which is stripped before matching.
- **Recording:** `listen:captureLine` → `captureLine`.
  - ffmpeg runs `-f avfoundation -i :<index>` (the index is looked up fresh each time; names are matched), with `-af aresample=async=1:min_hard_comp=0.001:first_pts=0,pan=mono|c0=0.5*c2+0.5*c3`, `-ar 48000` and f32le to stdout.
  - Channels are checked against the device's count first, because ffmpeg's pan quietly gives silence for a missing channel.
  - **Dropped buffers:** ffmpeg 6's AVFoundation input keeps only the newest device buffer and is polled every ~10 ms, so it loses **~12 %** of them (512 samples each on the Scarlett). Missing audio squeezes the take: a 130 BPM track read **149**, and the clicks at each join hid the beat (*no clear beat*). The packets keep their capture timestamps, so `aresample=async=1` puts each hole back as silence (pad/trim only; stretching would shift the pitch). `min_hard_comp` defaults to 0.1 s, far coarser than a 10 ms hole. `tempokey.js` then skips the holes (*Detection*). A higher timer-latency QoS (`taskpolicy -l 0`) didn't reduce the drops.
  - **Failed starts:** AVFoundation sometimes rejects the device's first buffer (`audio format is not supported`, then `:2: Input/output error`; 4 starts in 10 on the Scarlett). A start that fails that way before any audio is retried, up to 6 times, 150 ms apart. Other failures aren't retried.
  - The length is counted in samples, not with `-t`: `-t` counts timestamps, so with the drops `-t 10` gave ~8.8 s of audio.
  - Main sends a 160-row log-frequency column (40 Hz–12 kHz, −100…−10 dB) about 20× per second as `listen:column`, then runs `analyzeClip` itself. Nothing is written.
- **Timing:** opening the interface takes ~1–2.5 s. The take (countdown, picture, Stop) starts with the **first column**; until then the card reads *Opening the input…*.
- **Stopping:** **Stop** (`listen:stopLine`) analyses what came in, as long as it's ≥ 4 s. Closing the card discards it (`listen:stopLine(true)`). Closing the window aborts it.
- **Saved:** the choice is remembered as `settings.listenInput`: `''`, `mic:<deviceId>` or `line:<device>|<channels>`.
- **Not on Windows yet:** Focusrite's Windows driver usually exposes each pair as its own device ("Analogue 3 + 4"), which the Chromium path already lists. ffmpeg's `dshow` route is untested and not wired.
- **Verified 2026-10-01** on a Scarlett 6i6 (6 inputs, CDJs on 3/4) with a looping 130 BPM track (the phone mic read 130, 3A):
  - Before the hole fix: 10.04 s of wall clock gave 8.70 s of audio; 149 BPM, clarity 0.06.
  - After: five back-to-back takes through `captureLine` gave 10.00 s each; **130 BPM every time**, clarity 0.67–0.86 (*steady beat*); key 3A four times, 1A once.

**Detection** (`engine/tempokey.js` → `analyzeClip`):

| Part | How |
|---|---|
| Stages | Exported for whole-track use (Library check, later the analyzer): `onsetEnvelope` → `tempoFromEnvelope`; `pitchHistogram` (optionally per window) → `chromaFromHistogram` → `estimateKey(chroma, profiles)`. `estimateTempo`, `chromagram` and `analyzeClip` are those stages chained, unchanged. |
| Tempo | Onset strength = positive spectral flux of a log-magnitude spectrum ≤ 8 kHz (FFT 1024, hop 256 ≈ 5 ms), slow trend removed. **Holes** (runs of ≥ 32 exact zeros, e.g. a line input's dropped buffers) are missing data: frames touching one, and the frame after, are left out of the trend and the autocorrelation (which divides by the valid pairs per lag). Counted as onsets, the jumps back from silence halved the clarity of real tracks (0.6–0.8 → 0.2–0.4). With no holes the maths is unchanged. Each candidate on a 0.05 BPM grid in **70–180** is scored by the normalised autocorrelation at **1–6 beats** (a comb). 4 beats was fooled 4:3 by off-beat hats; 8 gained nothing. A log-normal **prior centred at 130 BPM** (σ ½ octave) then chooses only between the winner and its half/double, so a 174 break reads 174, not 87. `clarity` = mean normalised autocorrelation of the winner (≈ 0 for noise, 0.6–0.9 for a steady beat). |
| Tuning | The **40 strongest** spectral peaks per frame from **C1 to C6** (32.7 Hz–1047 Hz, whole octaves; parabolic interpolation) binned at 10 cents around A440. The FFT gives ~1.35 Hz bins at any rate (16384 at 22.05 kHz, 32768 at 44.1/48 kHz), fine enough for bass notes 2 Hz apart. Why: see *Library check*; the circular mean of their position within a semitone is the offset. A deck at +1.34 % with Master Tempo off sounds ≈ +23 ¢. |
| Key | The fine bins are folded into 12 pitch classes around that offset, then correlated with the 24 rotated **edma** profiles (Faraldo et al. 2016, built from EDM; Krumhansl–Kessler until 2026-10-02). Minor correlations get `MINOR_LEAN` 0.08 added: dance music is mostly minor, and the commonest error was the right tonic in the wrong mode. `confidence`: *likely* / *possible* / *none* from the margin. Pitch class → Camelot via `keyFromPitch` (the inverse of `rootPc`). `margin` = best − runner-up correlation; relative major/minor (8A/8B) are often close, and are compatible either way. |

**UI copy:**
- **Tempo:** *steady beat* (clarity ≥ 0.5), *beat found, some doubt* (≥ 0.25), or *no clear beat*. **½× / 2×** fix octave errors, e.g. hip-hop at 87 that reads 174.
- **Key estimate** (`keyEstimate` in `keys.js`, shared with the analyzer), from the engine's `confidence`:
  - *likely* (margin ≥ `KEY_LIKELY` 0.10);
  - *possible · or 8B C major* (≥ `KEY_POSSIBLE` 0.04);
  - otherwise *no clear key*, with a grey "?" chip and *best guess 8A A minor, or 8B C major*. No "Use key" button; the chroma bars don't colour a tonic.
- **Tuning:** shown as *≈ +1.34 % pitch, if the original is tuned to A440*.
- **Warnings:** a quiet input, no clear beat, or no clear key each get a warn callout with what to try.
- **Chroma bars:** one per pitch class, with the tonic in its key colour.

## Data shapes

```js
// settings.camelot (desktop-app.md → Settings), sanitized by sanitizeDeck
deck = { n: 1..12, mode: 'A' | 'B', range: 6 | 10 | 16 | 100, pct: number /* snapped */, bpm: 20..300, masterTempo: boolean, target: { n, mode } | null }
// default: { n: 1, mode: 'A', range: 10, pct: 6, bpm: 124, masterTempo: false, target: null }

mixRelation(from, to) → { name, sym, hint, semitones? } | null   // chart row, else standard Camelot, else null
pitchTo(from, to, range) → { sameLetter, away, options: [{ semitones, pct, inRange }] }  // nearest first, |pct| ≤ 16; away: nearer candidate's semitones (same letter only)

pitchShift({ n, mode, pct, masterTempo }) → {
  ratio, stopped,
  raw,         // semitones ignoring Master Tempo (null when stopped)
  semitones,   // effective: 0 with MT on
  nearest, cents, result /* key | null */, wheelSteps /* 0..11 clockwise */ }

mixingChart(key) → [{ name, sym: '' | '+' | '++' | '−' | '−−', hint, keys: [{ key, semitones? }] }]
tuning(key, shift, masterTempo) → { tone: 'ok' | 'warn' | 'bad' | 'info', text }

// engine/tempokey.js: analyzeClip(x, sr) (Listen) and analyzeTrack(x, sr, {signal}) (analyzer, async)
{ seconds, level: { rms, peak } /* dBFS */,
  tempo: { bpm, clarity /* 0..1 */ } | null,      // analyzeTrack: bpm refined to 2 decimals
  key: { n, mode, camelot, name, r, margin, confidence: 'likely' | 'possible' | 'none',
         runnerUp: { n, mode, camelot, name, r } } | null,
  chroma: number[12] /* C first, max 1 */, tuning /* cents, −50..50 */ }
```

## Extending

**Measure first.** Anything that changes `tempokey.js` goes through the *Library check* before and after.
- Rescan only when the cached features change. Bump `VERSION` in `tools/keytest.js` and use a new `--out` folder, about 35 min for 770 tracks.
- Otherwise `report` re-scores from the cache in seconds.

- **Tempo, next: the 4:3 errors** (6.9 % of the library, e.g. 166.7 for 125; 2:3/3:2 another 2.7 %).
  - Dense 16th hats outvote the kick in the onset envelope: 3 sixteenths (166.7) score almost as well as 4 (125).
  - Ideas:
    - a second onset envelope from the low band (< 150 Hz, the kick), combined with the full one;
    - or allow the 3:4 candidate only when the low band agrees.
  - Don't widen `PRIOR` to 3:4 by itself: a 172 drum & bass track would turn into 129.
  - Check: the report's `4:3/3:4` column, and that the tempo sweep in `tempokey.test.js` stays exact.
- **Key, next: the mode.** The commonest error left is the right tonic in the wrong mode ("parallel" column).
  - Ideas: weigh the third (minor vs major third above the tonic) in the bass octaves, or vote per 10 s window.
  - `MINOR_LEAN` is the blunt version.
- **Per-octave cache** (tool `VERSION` 3): store the 10-cent histograms per octave (C1–C8) instead of folded, ~7× the key data (~130 KB per track). Octave ranges and band weights could then be scored from the cache like the profile sets.
- **Better profiles:** `estimateKey(chroma, profiles, lean)` takes any set. `PROFILE_SETS` in `tools/keytest-lib.js` has Krumhansl, Temperley, Sha'ath and Faraldo's `edma`/`edmm`/`braw`; `own (2-fold)` learns one from the library. Cite the paper of whichever set ships.
- **Listen: longer takes:** `SECONDS` in `listen.js`. Main accepts up to 30 s, and tempo precision grows with length.

- **Two-deck mode, rekordbox XML import of keys/BPMs:** the handoff's other suggested next steps (target mode shipped). **Ask the maintainer first.** Put new maths in `camelot.js` with tests, and the UI in `view.js` + new cards.
- **Another player's ranges:** add to `RANGES` from that model's manual. `sanitizeDeck` accepts only `RANGES` keys.
- **New key colours:** change `HUES` / the OKLCH lightness in `view.js` → `keyColor`. Keep the lightness fixed so `--key-ink` text stays readable.
- **Night mode:** the `--lcd-*`, `--key-ink` and `--piano-*` tokens are meant to stay as they are. The wheel stroke uses `--card` and the hub `--card`/`--line`, so they follow the theme.

## Gotchas & limitations

- **Listen permissions:**
  - `lockPermissions` (main) grants only `media` requests that are **audio-only** and come from our own window's `file:` page, and denies everything else. Without a handler, Electron grants every permission.
  - In dev, macOS attributes the mic to the app that launched Electron (your terminal or VS Code), so that's the entry to switch on in System Settings.
  - Packaged builds carry `NSMicrophoneUsageDescription` through `build.mac.extendInfo`. A signed, hardened-runtime build will also need Apple's audio-input entitlement (desktop-app.md → *Packaging*).
- **Listen tempo needs a section with a beat.** Takes from breakdowns or sparse sections give low clarity and a wandering BPM. The card warns *No clear beat*.
- **A line input that reads fast with "no clear beat" is losing audio, not mistiming.** The 148–168 BPM on the first Scarlett test was AVFoundation dropping ~12 % of buffers (*Line inputs*). Check: count samples against wall-clock time. 10 s of audio must take 10 s.
- **Exact digital zeros mean "missing" to the tempo code.** Fine for live inputs, whose noise floor is never exactly 0. Synthetic test signals need a quiet tone or noise under them, or most frames get skipped.
- **Listen octave errors are inherent:** a 174 break and an 87 hip-hop beat are equally periodic. The 130 BPM prior favours dance tempos; ½×/2× is the fix.
- **The key is an estimate.** On a 770-track techno test library it matched rekordbox exactly for 50 % of whole tracks and 44 % of 10 s pieces. About 30 % were unrelated keys, even among "likely" ones.
  - Drums-only passages have no key, and the mode (minor/major) is the weakest part.
  - A phone or laptop mic hardly picks up the bass octave (C1–C2) that carries much of it.
  - On synthetic progressions all 24 keys still come out right with ±20 ¢ detune.

- **Class names are all `cam-*`.** The prototype had a real bug where `.keys` was used for both a label and the 650 px ruler grid, which blew out the column. Don't introduce unprefixed classes here.
- **Grid/flex children with text need `min-width: 0`**, and columns use `minmax(0, 1fr)`. The ruler has `min-width: 650px` on purpose and scrolls in `.cam-ruler-scroll`; nothing else may overflow its card.
- **SVG elements have no `.hidden` property.** The arrow is hidden with `toggleAttribute('hidden', …)`; the global `[hidden]` rule still applies.
- **Original and result segments are moved to the end of the SVG** on each render so their outlines aren't painted over by neighbours. Moving a node drops its focus, so `render()` restores it.
- **Rebuilt lists keep keyboard focus** through `refill()` (landing rows by `data-pct`, key chips by `data-key`).
- **Locale:** number inputs are parsed with `parseNum`, which accepts `6,00`.
- **Persistence needs the main process.** A running app started before this feature drops `camelot` on save until it's restarted (its `sanitize` doesn't know the field).

## Tests

`test/tempokey.test.js`, on synthetic tracks from `test/synth.js` (drum patterns + chord progressions, optionally detuned):
- house 128 / A minor
- a 174 break (not 87)
- 95 / C major
- ±30 / −20 ¢ detune keeps the key
- 44.1 kHz and a 6 s take
- silence and noise
- a 90–174 sweep: exact or an octave, never wrong
- dropout holes (12 % of 512-sample buffers zeroed) keep the BPM and clarity

`test/linein.test.js` records from `lavfi` sources: a pair from 4 channels, early stop, refused channels, a 130 BPM beat with 12 % of its buffers dropped (must come back 8 s long and read 130 with clarity ≥ 0.5), and the start retry, via a shell script that fails twice like AVFoundation and then runs ffmpeg.

`camelot.test.js` also checks `keyFromPitch` round-trips for all 24 keys. Its target test pins `pitchTo`: options only within ±16 % (2B → 4B at +12.25 % offered, 2B → 3B and 2B → 1B none, with `away`), and the octave down for the same key dropped.

### Library check (`tools/keytest.js`)

How well the Listen maths agrees with rekordbox on **whole tracks** of a real library. A developer tool: it isn't packaged (`build.files` is `src/**`), reads the library only, and stores no audio.

```bash
node tools/keytest.js scan --list <rekordbox.txt> --library <folder> --out <folder> [--workers N | --gentle] [--limit N]
node tools/keytest.js report --out <folder>
```

- **Truth:** rekordbox → select tracks → right-click → *Export a playlist to a file* → Text. Tab-separated UTF-16 with `Track Title`, `Artist`, `BPM`, `Key` (Camelot or note names), `Time`, but **no file paths**. Rows are matched to files by their tags: artist + title, then title alone, with the length within ±3 s.
- **Scan:** each track is decoded once (ffmpeg-static, mono 22.05 kHz) in worker threads, and the engine's own stages are saved:
  - `features/<id>.bin` (float32): the onset envelope (`onsetEnvelope`, NaN = hole) + one 10-cent pitch histogram per 10 s (`pitchHistogram`). About 160 KB for a 7-minute track, ~125 MB for 770.
  - `tracks.ndjson`: one line per finished track (truth, the engine's own answer, timing). The `.bin` is renamed into place before its line is written, so a line always has its data.
  - `tags.json` caches file tags by size + mtime. `unmatched.txt` lists rows and files that didn't pair. `failed.ndjson` lists decode failures (`--retry-failed`).
- **Stop / resume:** Ctrl+C finishes the tracks in progress (twice quits at once; nothing is half-written). Running the same command continues. If the library disappears (drive unplugged), it stops the same way. On macOS it runs `caffeinate -i` so the Mac doesn't idle-sleep. `--gentle` = 1 worker at the lowest priority.
- **Report** (seconds, from the cache):
  - BPM: ±0.1, ±0.5, and ratio errors (half/double, 2:3, 4:3), both as scanned and **refined** (a 32-beat comb within ±1 %, FFT autocorrelation over valid frames).
  - Key, for every profile set (without a lean) + one learned from the library itself (2-fold) + `shipped` (`estimateKey` as it ships): exact, MIREX score, minor/major, error kinds. Also on 10 s pieces at 25/50/75 %, like a Listen take.
  - **Minor lean** sweep (0–0.2) on the shipped profiles: exact overall, per mode, and on 10 s pieces.
  - Coverage → accuracy when keys under a margin are hidden; the worst confident disagreements to check by ear.
  - Writes `report.txt` and `results.csv`.
- **Speed:** ~2.5 s per track with 4 workers on an 8-core Mac, reading AIFF from a USB drive.
- **Where the data lives:** outside the repo (it's a private music library), on the maintainer's machine. Keep one folder per cache version; delete old ones once compared.
- **Run 1, 2026-10-01**: 770 tracks from a rekordbox USB (deep/hypnotic techno; 669 minor, 101 major). Old key settings: 60 Hz–2 kHz, every peak within 60 dB.
  - **BPM:** 83.4 % within ±0.5. Refined: **82.2 % within ±0.1** (64 % as scanned). Misses: 4:3 6.9 %, 2:3/3:2 2.7 %, half/double 0.9 %, other 6.1 %.
  - **Key:** 12–26 % exact for every profile set (MIREX 0.23–0.37). Even profiles learned from the library itself reached 25 %, so the measurement was at fault, not the profiles.
  - **The bias:** the answers piled on B, B♭ and A♭ tonics (Krumhansl: B 146, B♭ 109, A♭ 148 vs rekordbox's 35, 32, 82). The 60 Hz–2 kHz range has a B at both ends (B1 61.7 Hz, B6 1976 Hz), so B got an extra octave. It also cut the bass just above the kick zone, and in techno the bass carries the key.
- **Fix, tested on 150 random tracks.** These were one-off experiments, not kept: each track decoded once, with its 10-cent histograms kept **per octave C1–C8** for several peak-picking rules, so any octave range could be scored. The tool's cache holds only the shipped range, so repeating this needs a per-octave cache (*Extending*). Results:
  - Whole octaves from **C1** with the **strongest 40 peaks**: Krumhansl 20 → 42 % exact, `braw` 23 → 49 %, library-learned (2-fold) 25 → 54 %, `edmm` 29 → 61 % (it calls everything minor; 87 % of this library is).
  - Upper end C6–C8 barely matters. 10 or 20 peaks are slightly worse than 40, and 60 is worse.
  - Peak-to-background ratio ("whitening") and a 32768-point FFT at 22.05 kHz were both worse.
  - Shipped in `pitchHistogram` (cache version 2).
- **Run 2, 2026-10-02** (same 770 tracks, new settings; BPM unchanged):
  - **Key, whole track, exact:** Krumhansl 19 → 37 %, `edma` 18 → 40 %, `braw` 20 → 44 %, library-learned 25 → 46 %, `edmm` 26 → 54 %.
  - **10 s pieces** are 4–8 points lower.
  - **Tonics** now follow rekordbox's spread (B 37 vs 35, G 116 vs 125). The tonic agrees for **56–59 %** with every set. The biggest error left is the **mode**: "parallel", same tonic, other mode, 147 tracks with Krumhansl.
  - **Leaning to minor** (a bias added to the minor correlations, chosen on one half of the library and tested on the other): `edma` → **54 % exact**, MIREX 0.60; `braw` → 51 %; 10 s pieces ≈ 47 %. The report's *Minor lean* table shows this sweep.
  - **Shipped** (edma, lean 0.08; the report's `shipped` row): **50.4 % exact** (minor 54 %, major 25 %), 10 s pieces 43.9 %.
    - Hiding keys under a margin of 0.04 shows 80 % of them at 58 % exact.
    - Leans of 0.15+ reach 54 %, but almost never say major.
  - **The truth is rekordbox's own estimate**, not ground truth. Two ~70 %-accurate detectors agree only ~50–60 % of the time, so these numbers are agreement with what the CDJ shows, not accuracy.

Listen UI smoke: launch the test instance with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav> --disable-features=AudioServiceSandbox`. The audio service sandbox can't read the file otherwise and the input is silent. Stub `systemPreferences.getMediaAccessStatus` → `'granted'` so no real macOS prompt appears (testing.md → *UI smoke*).


`test/camelot.test.js`: every vector from the handoff:
- semitones / nearest / cents for ±6, +3, +8, +16, +2, +100, −50
- exact landings
- resulting keys and BPM
- root pitch classes
- the mixing chart for 8A, 1A, 1B and 12B
- verdict copy and tones, snapping, `sanitizeDeck`

UI: CDP smoke (testing.md → *UI smoke*). Open the rail's Camelot item, drive the fader with `Input.dispatchMouseEvent` / key events, and check there's no horizontal overflow at 1056 and 776 px.
