# UI (renderer & visual system)

## Scope & files

| File | Role |
|---|---|
| `src/renderer/index.html` | Static structure and element ids; CSP meta |
| `src/renderer/app.js` | State, rendering, event handlers, progress display (ES module, no framework, no build step). Boots the Camelot view with `initCamelot`. |
| `src/renderer/shared/js/dom.js` | `$` and `el()` helpers shared by every view |
| `src/renderer/shared/js/colormap.js` | Spectrogram colour scales (`lut`, `gradient`, `rgb`) for the analyzer and Listen |
| `src/renderer/camelot/` | Camelot wheel view: `view.js`, `listen.js`, `capture-worklet.js`, `keys.js`, `camelot.css` (camelot.md) |
| `src/renderer/analyzer/` | Audio analyzer view: `view.js`, `analyzer.css` (analyzer.md) |
| `src/renderer/settings/` | Settings view: `view.js` draws `engine/prefs.js`, `settings.css` |
| `src/renderer/shared/styles/index.css` | Visual system: tokens, components, responsive rules (plain CSS). Starts with `@import url('fonts.css')` |
| `src/renderer/shared/styles/fonts.css` | `@font-face` declarations only |
| `src/renderer/shared/fonts/` | Bundled font files: `Geist/` (Google Fonts download, OFL) |
| `src/renderer/shared/images/` | Imagery used by the page: logo, UI icons in `icons/` |

The renderer can only reach the system through `window.api` (desktop-app.md → *IPC contract*).

## Behaviour

### Page structure (ids used by `app.js`)
`<body>` is a row: the nav rail, then one `.view` per rail item. Only the active view is shown.

| Region | Elements |
|---|---|
| Nav rail | `nav.rail` → `.logo`; `.rail-item[data-nav="converter\|analyzer\|camelot\|settings\|contact"]` (Settings and Contact sit at the bottom: `.rail-end` on Settings pushes both down) |
| Views | `.view[data-view="…"]`, one per `data-nav` value. `converter` holds everything below; `analyzer` is the audio analyzer (analyzer.md); `camelot` is the Camelot wheel (camelot.md); `settings` is drawn from `engine/prefs.js` (*Settings* below); `contact` is one `.card.empty.contact`: the address (`.contact-email`, selectable), `#contact-email` (→ `api.openLink('email')`), and `#contact-note` shown if no mail app opened (D38). |
| Header | `.brand` → `h1` (*Audio converter*), subtitle: what the view does, then the target spec in a `.nowrap` span (*44.1/48 kHz · 16/24-bit*). `#ffmpeg-missing` below it: a `.callout.bad` with *Fix in Settings*, shown only when no ffmpeg works. The ffmpeg chip lives in Settings (D39). |
| Folders card | `#input-path`, `#output-path`, buttons `[data-pick="input\|output"]`, `[data-open="input\|output"]` |
| Convert from card (`.span-2`) | `#formats` (toggles generated from `info.formats`) |
| Options card (`.span-2`) | `#safe-names`, `#workers` |
| Library card | `#last-run`, tiles `#stat-total` + `#stat-total-label`, `#stat-done`, `#stat-pending`, `#stat-failed`; `#stat-detail`, `#warnings`, `#failures` |
| Playlist card | `#pl-summary`, `#pl-path` + `#pl-pick`/`#pl-open`, `#pl-root` + `#pl-root-pick`/`#pl-root-open`, `#pl-custom-root`, `#pl-match`, `#pl-status`, `#pl-find` → `#pl-find-btn` (`#pl-find-label`), `#pl-find-cancel`, `#pl-recursive`; `#pl-table` → `#pl-rows`, `#pl-save` → `#pl-prefix`, `#pl-save-name`, `#pl-save-btn` |
| Footer bar | `#progress` / `#progress-fill`, `#status`, `#status-sub`, `#scan-btn`, `#convert-btn`, `#cancel-btn` |

### State & rendering model
```js
state = { info, settings, summary, failures, busy /* 'scan' | 'convert' | null */,
          pl: { path, match, busy, saved, message, error, searching, searchFolders } }   // playlist card
```
- **`render()`** rebuilds every region from `state`: `renderFolders` → `renderOptions` → `renderStats` → `renderActions` → `renderPlaylist`. It's idempotent, so call it after any state change.
- **Outside `render()`:**
  - the footer status, via `setStatus(text, sub, progress)`, where `progress` is `null` (hidden), `'indeterminate'` or `0..1`
  - the live tile updates inside `onProgress` during conversion
- **IPC envelopes** are unwrapped by `call(fn, …args)`, which throws on `{ok:false}`. Errors surface as `⚠ message` in the status line (`showError`).
- **Safety:** all file-derived text goes through `textContent`, built with the `el()` helper. Never use `innerHTML` with paths or tags.

### Flows
| Trigger | What happens |
|---|---|
| Boot | Loads `info` + `settings` in parallel and sets the ffmpeg chip (or `ffmpeg missing` in red). Wires listeners, then `status()` shows the last run before any scan. Scans automatically if both folders are set and a format is ticked. |
| Choose folder | `pickFolder`. If the path changed → `refreshAfterChange()`: clear summary and failures, re-render, then rescan after 250 ms (debounced). |
| Toggle format / safe names | Save the setting → `refreshAfterChange()`, because the plan depends on it. |
| Change workers | Save only; applies to the next convert. |
| Scan / Convert | `run(kind)`: set `busy`, render (controls disabled, Cancel shown), show an indeterminate bar, await the result, store `summary` (plus `failures` for convert), clear `busy`, show the final status. |
| Cancel | Status `Stopping…` → `api.cancel()`. A cancelled scan shows `Scan cancelled.`; a cancelled convert shows `Stopped. Converted X of Y.` |
| Rail item click | `showView(name)`: unhides the matching `.view`, hides the others, moves `aria-current="page"`. Nothing is re-rendered or cancelled, so a running scan/convert carries on. The app always opens on `converter`. |

### UI states
| State | Status line | Scan | Convert |
|---|---|---|---|
| No folders | Choose a library and an output folder to begin. | off | off |
| No format ticked | Tick at least one format to convert. | off | off |
| Folders set, not scanned | Ready. Scan to see what needs converting. | on | on |
| Pending work | `N tracks to convert.` | on | on, label `Convert N tracks` |
| Up to date | Everything is up to date. | on | off |
| Busy | progress text (below) | off | off; Cancel visible |
| Finished | `Done. Converted N tracks in T.` (+ failed count in the sub-line) | on | per counts |

While busy, folder pickers, toggles, the switch and the stepper are disabled.

### Progress copy (`onProgress`)
| phase | Status | Sub-line | Bar |
|---|---|---|---|
| `walk` | Scanning folders… N audio files found | — | indeterminate |
| `probe` | Reading new tracks… d / t | — | d/t |
| `check` | Checking output… d / t | — | d/t |
| `convert` | Converting n / t · N failed · about T left | file names of active jobs | n/t |

During `convert`, the tiles tick live:
- **new/changed** = `total − converted`
- **up to date** = `selected − unreadable − total + converted`

The final numbers replace them when the result arrives.

### Library card
- **Tiles:**
  - *`<FLAC + WAV> tracks`*: `counts.selected`; the label is built from the ticked formats
  - *up to date*: `counts.upToDate`
  - *new / changed*: `counts.pending`; a solid amber (`--secondary`) tile while > 0
  - *failed last run*: `lastRun.failed`; a solid red (`.bad`) tile when > 0, `—` if never run
- **`#last-run`:** `Last converted <date> · N tracks` (plus `(stopped early)` when cancelled), otherwise `Never converted`.
- **Detail line:** audio files and folders · already CDJ-playable · hi-res resampled · removed from library · space needed vs free · scanned at.
- **Notes** (`renderNotes`, collapsible `<details>`):
  - one per summary warning; `diskSpace` and `unreadable` use the error style, others the warn style
  - a failures note that is open by default, with a **Show file** button per item (reveals the source)
  - lists end with `… and N more` when the examples are truncated

### Playlist card
Behaviour and matching rules are in playlists.md. This covers the UI side.

**Rows:**
- **Playlist:** path plus Choose… and ↗ (reveal the file).
- **Converted:** the effective converted folder (`plRoot()`, which mirrors `main.js#convertedRoot`).
  - While *Use a different converted folder* is unticked, it shows the Output folder, greyed out (`.path.locked`), with Choose… disabled.
  - Ticking the box enables Choose… and shows the custom folder, or *No folder chosen*.

**Buttons and states:**
- **Convert playlist** is enabled when a playlist and a converted folder are set. While matching, its label reads *Looking up tracks…*.
  - It is **primary while there is no result**, and plain after matching. At that point *Create playlist* becomes the primary next step.
  - Clearing the match (new playlist, folder or setting change) makes it primary again.
- **Visibility:**
  - Before the first Convert playlist, only the two folder rows, the checkbox and the button are shown.
  - The track table and the save row appear with a result.
  - The **Find in folder** block appears only while at least one track is missing (or a search is running), and disappears once everything is resolved.
- **After matching:**
  - `#pl-summary`: *N tracks · N found · N not found*
  - `#pl-status`: *All tracks found.* or *N tracks not found — use the folder button…*
  - the table: `#`, original file name, converted file name
  - Found / original / manual rows are green (`.pl-row.found`); missing rows are yellow (`.pl-row.missing`) with the reason in italics.
  - Tags: `original` (kept, already CDJ-playable), `chosen` (picked by hand) and `found in folder`.
  - The folder `.icon-btn` appears on missing and hand-resolved rows → `pickPlaylistTrack(index)`. A refused pick shows the reason in `#pl-status` (red); a successful one clears it.
- **Find in folder** block (above the table, only while tracks are missing):
  - `.btn.secondary.with-glyph` button, disabled when nothing is missing
  - While searching, its label becomes *Searching… N folders* (live from `onPlaylistProgress`) and **Cancel** appears. Picks, Convert playlist and Create playlist are disabled.
  - Below it: the **Recursive** checkbox (saved immediately) and a `.hint` line explaining it.
- **Save row:**
  - prefix input (saved 300 ms after typing stops)
  - a live preview: `→ av-Name.m3u8 · N tracks · N not found will be left out`
  - **Create playlist**, disabled when nothing was found
  - After saving, the status shows *Saved … · N tracks* plus **Show file**.

**Invalidation:** `clearPlaylistMatch()` drops the displayed match when a folder, safe names or the custom-folder setting changes. The main process drops its copy at the same time.

### Formatting
`fmtNum` uses `Intl.NumberFormat` with the system locale. The helpers are:

| Helper | Output |
|---|---|
| `fmtNum` | locale number (see above) |
| `fmtDate` | medium date + short time |
| `fmtBytes` | MB below 1 GB, otherwise GB with 1 decimal |
| `fmtDuration` | `Ns`, `N min`, or `H h M min` |

UI copy is English only.

## Visual system

### Colour system (`shared/styles/index.css`)
**Mood:** raw concrete and onyx, like Swiss techno posters. Surfaces are warm grey, never white. Text is a soft black, never `#000`. One or two saturated accents are used as solid blocks. Decision D20 has the background.

Colour comes in three layers, each in its own `:root` block. **Components only use layer 2 and layer 3 tokens, never palette values.** That rule is what makes night mode a token-only change.

**1. Palette:** raw colours, no meaning attached.

| Ramp | Values | Notes |
|---|---|---|
| Concrete | `-50 #e6e6e3` · `-100 #dcdcd9` · `-200 #d4d4d1` · `-300 #c9c9c6` · `-400 #bdbdba` · `-500 #a6a6a3` · `-600 #8a8a87` | Day surfaces and lines; night text |
| Onyx | `-500 #4b4d4f` · `-700 #2c2e30` · `-800 #222324` · `-900 #1a1b1c` · `-950 #111213` | Day text; night surfaces (`-700/-800/-950` reserved for night) |
| Red | `-500 #ed2540` (brand) · `-600 #d01c36` · `-700 #a3112a` | `-600` = hover and AA-safe fill, `-700` = red text on concrete |
| Amber | `-500 #faa819` (brand) · `-600 #e3940f` | |
| Blue | `-500 #3a83c4` (brand) · `-600 #2f6fa9` | alternate scheme |
| Teal | `-500 #3ec1c8` (brand) · `-600 #2ea8af` | alternate scheme |
| Green / white | `--green-500 #2fb36b` · `--white #ffffff` | status base / label on red and blue |

**2. Theme:** semantic tokens. Day is the only theme for now.

| Token | Day | Use |
|---|---|---|
| `--bg` | concrete-300 | window background (= `main.js` `backgroundColor`) |
| `--card` | concrete-200 | cards, footer bar (one step lighter than the window) |
| `--card-2` | concrete-400 | inset: paths, tiles, notes, inputs, neutral buttons, progress track |
| `--line` / `--line-strong` | concrete-500 / -600 | borders and dividers / hover borders |
| `--text` / `--muted` | onyx-900 / onyx-500 | primary / secondary text (muted ≥ 4.5:1 even on `--card-2`) |
| `--inverse` / `--on-inverse` | onyx-900 / concrete-100 | solid dark fill (checked format toggle) / text on it |
| `--focus` | onyx-900 | focus rings |
| `--logo` | onyx-900 | logo fill |
| `--danger` / `--on-danger` | red-600 / white | error fills, stripes, borders, failed tile / text on them |
| `--danger-text` | red-700 | red text on concrete (chip, Cancel, playlist error) |
| `--warn` | amber-500 | warning stripe; base of `--missing-bg` |
| `--ok` | green-500 | base of `--found-bg` |
| `--found-bg` / `--missing-bg` | `color-mix` 18% / 22% | playlist row found / not found; Camelot verdict ok / warn |
| `--lcd-bg` / `--lcd-ink` | onyx-950 / `--secondary` | CDJ-style display in the Camelot deck; stays dark in every theme |
| `--key-ink` | onyx-900 | text on key-coloured fills (Camelot); the same in every theme |
| `--piano-white` / `--piano-black` | concrete-50 / onyx-800 | pitch ruler keys: physical colours, the same in every theme |
| `--spectro-low` / `--spectro-high` | onyx-950 / concrete-50 | the *grayscale* spectrogram ramp, silence → loud (analyzer, Listen). The default *color* scale is fixed data colours in `shared/js/colormap.js`. |
| `--series-a` / `--series-b` | blue-600 / red-600 | chart series for track A / B. Fixed per entity, not per accent scheme; the pair passes the dataviz palette checks (lightness, chroma, colour-blind ΔE 18, contrast) on `--card`. |

**3. Accent scheme:** which pair drives the calls to action.

| Token | Default (red/amber) | `data-accent="blue"` | Use |
|---|---|---|---|
| `--primary` / `--primary-hover` | red-500 / red-600 | blue-500 / blue-600 | `.btn.primary`, progress fill, LED dot on checked toggles |
| `--on-primary` | white | white | label on primary |
| `--secondary` / `--secondary-hover` | amber-500 / amber-600 | teal-500 / teal-600 | `.btn.secondary` (Find in folder), pending tile, text selection |
| `--on-secondary` | onyx-900 | onyx-900 | label on secondary |

- **Accents are fills, not text.** On concrete, the brand colours reach only 2–2.6:1 as text. Anything coloured is therefore a solid block with onyx or white on it: buttons, highlighted tiles, the progress bar. Links are underlined onyx.
- **Secondary means "needs you".** Amber marks work waiting (the pending tile) and the fix for amber "not found" rows (Find in folder).

**Non-colour tokens:**

| Token | Value | Use |
|---|---|---|
| `--radius` | `12px` | cards (tiles 10px, controls 8–9px, pills 999px) |
| `--font-sans` | `'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif` | all UI text, buttons |
| `--font-mono` | `ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace` | paths, numbers, chip, sub-status |

**Type:** `var(--font-sans)` 14px/1.45 base.

| Element | Style |
|---|---|
| `h1` | 22px, tight tracking |
| `h2` (section labels) | 11px uppercase, `0.08em` tracking, muted |
| Stat numbers | mono 26px, tabular numerals |
| Small text | 12px |

### Fonts
The UI font is **Geist**, loaded from `shared/fonts/Geist/static/` by `shared/styles/fonts.css`:

| Weight | File | Used by |
|---|---|---|
| 300 | `Geist-Light.ttf` | nothing yet (available) |
| 400 | `Geist-Regular.ttf` | body text |
| 600 | `Geist-SemiBold.ttf` | buttons, format toggles, section labels (`h2`) |
| 700 | `Geist-Bold.ttf` | `h1` |

- **Mono text** (paths, numbers, chip, sub-status) stays on the system mono stack (`--font-mono`). Geist Mono is a separate family that isn't bundled.
- **Always local:** fonts are bundled, never loaded from a CDN. The CSP blocks remote content, and the app has to work offline. `default-src 'self'` covers `font-src`, and everything under `src/` ships in the packaged app.
- **Add a weight or italic:** add an `@font-face` block in `fonts.css` pointing at `../fonts/Geist/static/Geist-<Weight>.ttf`. Keep `font-family: 'Geist'` and set `font-weight`/`font-style`. If a weight isn't declared, the browser picks the nearest declared one (e.g. a missing 600 renders as 700).
- **Switch the family:** drop the files into `shared/fonts/<Family>/`, declare them in `fonts.css`, and put the family first in `--font-sans` (or `--font-mono`). Components use only these two tokens. Prefer `.woff2`; `.ttf`/`.otf` work too.
- **Licence:** keep the licence file next to the font. OFL requires it to ship with the font, and `Geist/OFL.txt` does.

### Images
- **Where:** `src/renderer/shared/images/`; UI glyphs in `shared/images/icons/`: 24×24, stroke-width 2, round caps and joins. Current set: `folder.svg` (converter, Find in folder), `wave.svg` (analyzer: half sine, half saw), `wheel.svg` (Camelot: 12 key dots around a ring), `cog.svg` (settings: 8-tooth gear), `mail.svg` (contact), `mic.svg` (Listen). Reference files from CSS as `url('../images/<file>')`, and from `index.html` as `shared/images/<file>`.
- **CSP:** `img-src 'self' data:` allows local files and data URIs, but not remote URLs.
- **Logo:** prefer **SVG**. An SVG in `<img>` can't follow the theme colours. For a single-colour logo that must switch with day/night, either inline the SVG in `index.html` with `fill="currentColor"`, or use it as a CSS `mask-image` on an element with `background: var(--text)`. For a multi-colour logo, use one file, or day/night variants swapped under `:root[data-theme="night"]`.
- **Current logo:** `av-logo-2026.svg`, drawn by `.logo` at the top of the nav rail. The file is left untouched: CSS uses it as a `mask-image` filled with `--logo`, so its own colour (`#0e0d0c`) doesn't matter.
  - The artwork fills only part of its 20×20 viewBox (x 6.36, y 8.53, w 7.32, h 2.94), so the mask is scaled and offset to crop to the artwork. `--logo-w` (40px) sets the size. Its margins centre the mark in an invisible rail-wide square (96×96): equal space above and below, derived from `--rail-w`, `--rail-pad` and `--rail-gap`, so it stays centred if those change.
  - **Replacing the logo** with a different SVG means updating those four bounds in `.logo`. Measure them with `getBBox()` on the artwork in DevTools, or export the SVG with a tight viewBox and use `0 0 <w> <h>`.
- **Not the app icon:** the Dock/taskbar/installer icon is a packaging resource. It goes in the project-root `build/` folder (desktop-app.md → *Extending → App icon*), not here.

### Components (CSS classes)
| Class | Description |
|---|---|
| `.rail` | Nav rail: `--rail-w` (96px) wide, `--rail-pad` 24px padding (so items are 47px squares), `--rail-gap` 4px between items, `--rail-icon` (18px) icon size, `--card` background with a `--line` right border |
| `.rail-item` | Square nav button: width 100% of the rail's content box, `aspect-ratio: 1`, glyph centred at `--rail-icon`. Idle = `--muted` icon; hover = `--card-2`; current (`aria-current="page"`) = solid `--inverse` tile, like a checked toggle. `.busy` adds a pulsing `--primary` LED in the corner. `.rail-end` pushes an item to the bottom. |
| `.view` | Column holding one screen (`.shell` + optional footer bar) |
| `.shell` | Scrolling content area and **bento grid**: 4 equal columns, 14px gap. Children span all 4 columns; `.span-2` spans 2 (Convert from + Options share a row, equal height); `.row-2` spans 2 rows (a tall card beside two stacked ones, used by the Camelot view). |
| `.card` | Section container: `--card` background, 1px `--line` border, 16/18px padding |
| `.card.empty` | Placeholder for an unbuilt view: centred 48px glyph and one muted line |
| `.switch-control` | On/off switch: `<input type="checkbox" role="switch">` with `appearance: none`. Off = `--card-2` track and a muted knob; on = `--inverse` track and a `--primary` knob, like a lit toggle LED. |
| `.segmented` | A choice as pills inside an inset track: radio inputs (visually hidden, focusable), the picked one solid `--inverse`. Used by the `choice` pref type. |
| `.setting` | Settings row: label + hint on the left, control on the right; rows separated by `--line` |
| `.app-error` | App-wide error banner (`#app-error`): an opaque `.callout.bad` pinned bottom-right with a × button. Shown by `showAppError` for unexpected errors only (desktop-app.md → *Error handling*). |
| `.callout` | Verdict/status line with a 3px stripe, tones `.ok` `.warn` `.bad` `.info` (same language as `details.note`). Used by the Camelot verdict and the analyzer verdict and errors. |
| `.folder-row` | Grid `80px 1fr auto auto`: label, path, Choose…, open ↗ (used by the Folders and Playlist cards) |
| `.path` | Mono inset box. It truncates at the **start** (`direction: rtl`) so the end of long paths stays visible. The inner `<span>` restores LTR so leading `/` doesn't jump. `.placeholder` = muted text; `.locked` = 50% opacity for a read-only value (e.g. converted folder = Output). |
| `.toggle` | Pill checkbox with a dot. Checked (via `:has(input:checked)`) turns it into a solid `--inverse` pill with the dot lit in `--primary`, like a hardware LED. The real `<input>` is visually hidden but focusable (focus ring via `:has(:focus-visible)`). |
| `.switch` / `.stepper` | Labelled checkbox / number input rows |
| `.stats` / `.stat` | 4-column tile grid. `.stat.accent` = solid `--secondary` tile (set by `renderStats` while pending > 0); `.stat.bad` = solid `--danger` tile |
| `details.note` | Collapsible note with a 3px left stripe (`--warn`, or `--danger` with `.error`); mono example list, max 180px scroll |
| `.link` | Underlined text button in `--text` (e.g. Show file); the underline thickens on hover |
| `.bar` | Fixed footer: progress, status, sub-status (mono), actions |
| `.progress` | 6px track; `.fill` width transition; `.indeterminate` slides a 30% segment |
| `.btn` | Base button (`--card-2` fill); `.primary` (`--primary` fill), `.secondary` (`--secondary` fill), `.danger` (red outline), `.ghost` (transparent), `.icon` (square padding); `:disabled` at 40% opacity |
| `.chip` | Mono pill in the header; `.bad` = red (`--danger-text`) |
| `.card-head` | Card title row: `h2` left, muted summary right (same as `.stats-head`) |
| `.pl-row` | Playlist table row: grid `2.25rem 1fr 1fr 2rem` (#, original, converted, action); `.found` / `.missing` tint; `.pl-head` = column labels |
| `.tag` | Small outlined pill after a name (`original`, `chosen`) |
| `.icon-btn` | 28px square button holding a glyph |
| `.btn.with-glyph` | Button with a leading glyph (inline-flex, 8px gap) |
| `.hint` | 12px muted helper text, indented 26px to line up under a checkbox label |
| `.glyph` + `.glyph-<name>` | Single-colour SVG from `shared/images/icons/` as a mask, so it takes `currentColor`. Not `.icon`, which is the `.btn.icon` modifier. |

- **Disabled controls:** `.toggle`, `.switch` and `.stepper` drop to 45% opacity via `:has(input:disabled)`.
- **Wide (≥ 1440px window):** views can opt into a wider grid. The Camelot page (`.cam-shell`) switches to named areas, 3 columns + a pinned wheel, up to 1600px (camelot.md → *UI*). Other views keep the 980px bento.
- **Responsive (≤ 856px window = 760px of content + the 96px rail):** `.span-2` cards go full width, tiles go to 2 columns, and the folder row hides the ↗ button. The rail never collapses.
- **Motion:** only the progress width transition, the indeterminate slide and the rail's busy LED pulse. `prefers-reduced-motion` replaces the slide with a static 40% bar and stops the pulse.

### Settings
- **Data:** `settings.prefs`, `{ <section id>: { <key>: value } }`, defined by `PREF_SECTIONS` in `engine/prefs.js` (no imports; main and the renderer both use it). `sanitizePrefs` keeps valid values, fills defaults, and drops unknown sections and keys.
- **Page:** `settings/view.js` → `initSettings({get, save})` renders one `.card.settings-section` per section (`h2` = the section title, e.g. *Camelot Wheel*) and one `.setting` row per pref. Each change saves at once via `saveSettings({prefs})`. A section whose id matches a static `[data-pref-section]` card is drawn into that card instead (`updates` → About).
- **Current prefs:**

| Section | Key | Default | Effect |
|---|---|---|---|
| Audio Analyzer | `spectrogramColors` | `'color'` | `'color'` (classic spectral scale) or `'grayscale'`, for the analyzer and Listen (`shared/js/colormap.js`) |
| Audio Analyzer | `checkHiRes` | `false` | Off: the analyzer's verdict is "real lossless or made from an MP3?". On: the stricter hi-res verdict (analyzer.md → *Verdicts*). Results already on screen switch at once. |
| Camelot Wheel | `autoApplyListen` | `false` | *Automatically apply analyzed BPM*: Listen puts the BPM on the deck straight away and hides "Use … BPM". The key estimate always waits for "Use key …" (camelot.md → *Listen*, D34) |


- **ffmpeg card** (static markup in `index.html`, filled by `settings/view.js` → `initFfmpeg`): not a pref, because its value is a path that only a native dialog may set (D18, D39).
  - *Converter and decoder*: `#ffmpeg-chip` (`ffmpeg 8.1.1`, `· soxr`, or red *ffmpeg missing*), `#ffmpeg-hint` (the source checkout's copy / the one you chose / the one on this computer, with the path; or that the chosen one doesn't run), **Find automatically** (only with a chosen path; clears it), **Check again** and **Choose…**. Errors (not an ffmpeg, quarantined, busy) show in `#ffmpeg-error`.
  - *Download ffmpeg*: **Download…** → `api.openLink('ffmpeg')`, with the per-OS tip (`GET_FFMPEG`: Homebrew / apt / unzip and choose).
  - A change calls `onChange(ff)`, which shows or hides the converter's `#ffmpeg-missing`.
- **"ffmpeg is needed" dialog** (`#ffmpeg-dialog`): opens at launch when no ffmpeg is found. The same per-OS tip; **Not now**, **Check again**, **Choose…**, **Download ffmpeg**. It closes by itself once a working ffmpeg is found.
- **About card** (last; `settings/updates.js` → `initUpdates`): *AudioConverter 1.0.0*, a green `.update-dot` when a newer release exists, the status (*Up to date. Checked 5 minutes ago.* / *Version 0.2.0 is available, released 3 days 21 hours ago.* / *No release has been published yet.* / *Couldn't check …*), **Check now**, **Update to x.y.z**. There's no update setting: the app checks once per launch (D40).
- **"Update available" dialog** (`#update-dialog`): see desktop-app.md → *Updates*.

### Dialogs
- Native `<dialog>` with `showModal()` (focus trap, Esc closes, `::backdrop`), styled by `.dialog` / `.dialog-title` / `.dialog-sub` / `.dialog-meta` / `.dialog-notes` / `.dialog-tip` / `.dialog-actions` in `index.css`. Markup lives at the end of `index.html`, outside the views.
- Open them with `dom.js` → `showDialog(d)`: if another dialog is open, it waits until that one closes, so the ffmpeg and update dialogs never stack.
- Rail: `.rail-item.has-update` puts a static green dot on Settings (the converter's pulsing red LED is `.busy`).

## Extending

- **New stat tile:** add `.stat` markup with ids in `index.html`, fill it in `renderStats`, and extend the 4-column grid (or accept wrapping).
- **Style a new warning code as an error:** extend the `kind:` condition in `renderStats`.
- **New setting control:** add markup in the Options card. Set its value and disabled state in `renderOptions`, and add a listener in `boot` that calls `saveSettings(...)` (+ `refreshAfterChange()` if it affects the plan).
- **Re-theme:** change tokens only. Components use semantic tokens exclusively, apart from a few radii. Retune a colour in the palette; change what a role maps to in the theme block. For fonts, see *Fonts* above.
- **Switch accent scheme:** add `data-accent="blue"` to `<html>` in `index.html` for blue/teal. Remove it to return to red/amber. Another pair means adding its ramps to the palette and a `:root[data-accent="<name>"]` block setting the six `--primary*`/`--secondary*` tokens.
- **Add night mode:** the commented sketch under the theme block in `index.css` is the starting point.
  1. Add `:root[data-theme="night"]` remapping every layer-2 token to the onyx/concrete ramps, with `color-scheme: dark`.
  2. Pick a lighter `--danger-text` and check that `--on-secondary` and `--found-bg`/`--missing-bg` still read on dark.
  3. Set `data-theme` from a setting or `nativeTheme` (desktop-app.md), and make `main.js` `backgroundColor` follow it so the window doesn't flash concrete.
  4. Check contrast: text ≥ 4.5:1 on `--bg`, `--card` and `--card-2`.
- **New coloured element:** reach for a fill (`--primary`, `--secondary`, `--danger`, `--inverse`) with its `--on-*` text, not a coloured text colour. Only `--danger-text` is safe as text on concrete.
- **Where new UI files go:** anything used by more than one view goes in `src/renderer/shared/`: `styles/`, `fonts/`, `images/`, and later e.g. `js/` helpers. It must stay under `src/`, which is the only tree packaged. A second view or window would get its own HTML/JS next to `index.html` (or in `src/renderer/<view>/`) and link `shared/styles/index.css`.
- **New view** (library visualisation, …):
  1. Add a `.rail-item[data-nav="<name>"]` in `index.html` (top group: before the `.rail-end` item; bottom group: after it), with `title` + `aria-label` and a `.glyph-<icon>`.
  2. Add a 24×24 stroke icon to `shared/images/icons/` and a `.glyph-<icon>` rule.
  3. Add `<div class="view" data-view="<name>" hidden>` holding a `main.shell` (a footer bar too if the view has actions).
  `showView` picks it up by attribute; no JS list to update.
- **New preference:** add an entry to `PREF_SECTIONS` in `engine/prefs.js` (section `id` + `title`; pref `key`, `type`, `default`, `label`, `hint`). Main stores and sanitizes it, and the Settings page draws it, with no other changes. Read it in the renderer as `sanitizePrefs(state.settings.prefs).<section>.<key>`. Types so far: `toggle` (switch) and `choice` (`options: [{value, label}]`, drawn as `.segmented`). A new `type` needs a cleaner in `CLEAN` (prefs.js) and a control in `CONTROLS` (settings/view.js).
- **Build out a placeholder** (camelot.md and analyzer.md show finished views): replace its `.card.empty` with real cards and keep the same `render*` functions pattern.
- **New bento layout:** inside `.shell`, give cards `.span-2` (or add `.span-1`/`.span-3` with `grid-column: span N`) and extend the ≤ 856px rule to make them full width.
- **Framework:** If the UI outgrows vanilla JS, adopting a framework and bundler is a decision to log in decisions.md.

## Gotchas & limitations

- **Live tile numbers are computed from the last scan's counts.** They're approximate until the result lands.
- **Before the first scan, `state.summary` is `{lastRun}` only.** Tiles show `—` except *failed last run*.
- **The failures note lists only the latest run.** Older failures appear as the `failedBefore` warning.
- **Auto-scan on boot** can take a while on the very first run of a huge library, since every file is probed. It is cancellable.
- **`hidden` always wins.** A global `[hidden] { display: none !important; }` is needed because components like `.pl-find`/`.pl-save` set `display: flex`, which would otherwise override the attribute (that was a real bug). Toggle visibility with `el.hidden`, never inline `display`.
- **`:has()` and RTL truncation** rely on Chromium (fine in Electron). Don't reuse this CSS in old browsers.
- **Everything in `shared/fonts/` ships.** The Geist download also includes italics, other static weights and two variable fonts (~2.6 MB total), although only 4 files are used. It's harmless; prune unused files if app size matters, but keep `OFL.txt`.

## Tests

No DOM unit tests. Use the CDP smoke run (testing.md → *UI smoke*) and check its screenshots.
