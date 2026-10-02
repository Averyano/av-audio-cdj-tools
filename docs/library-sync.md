# Library sync (scan, plan, state)

## Scope & files

This subsystem works out *what* has to happen: which files exist, which changed, where each output goes and what is already done. It does not touch audio.

| File | Role |
|---|---|
| `src/engine/walk.js` → `walk()` | Recursive listing of audio files, with `stat` |
| `src/engine/names.js` | `toKey`, `keyToNative`, `sanitizeSegment`, `outputRelFor`, `isInside` |
| `src/engine/plan.js` → `buildPlan()`, `folderDepth()`, `estimateBytes()` | Action per file, output names, collisions, size estimate |
| `src/engine/manifest.js` → `Manifest` | Per-library JSON state |
| `src/engine/engine.js` → `#validate`, `#scan`, `#summarize` | Orchestrates the steps below; builds the summary and warnings |
| `src/engine/constants.js` | `AUDIO_EXTS`, `SKIP_DIRS`, `CDJ_PROFILE` limits, `defaultDataDir()` |

## Behaviour

### 1. Folder validation (`engine.js#validate`)
- **Input** must exist and be a directory. It is resolved with `fs.realpath`.
- **Output** may not exist yet. It is resolved with `realpathLoose()`: realpath of the nearest existing ancestor, plus the remaining segments. This matters because on macOS `/var` is `/private/var`, and plain `path.resolve` would miss nesting.
- **Nesting:** input and output must not be the same folder, and neither may be inside the other (`isInside` both ways).
- **Formats:** at least one ticked; every id must exist in `SOURCE_FORMATS`.

### 2. Walk (`walk.js`)
- Iterative depth-first walk with `fs.readdir(..., {withFileTypes})`.
- **Skipped entirely:**
  - names starting with `.`, which covers macOS AppleDouble `._track.flac` junk and hidden folders
  - folders in `SKIP_DIRS`: `$RECYCLE.BIN`, `System Volume Information`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`, `@eaDir`, `PIONEER`
  - symlinks and other non-file/non-dir entries (avoids loops)
  - anything inside the output folder (`exclude`)
- **Collected:** only files whose lower-cased extension is in `AUDIO_EXTS`, which is the ticked-able formats plus `OTHER_AUDIO_EXTS`. Everything else (images, `.cue`, `.log`…) is ignored.
- **Stat:** files are `stat`-ed per directory in one `Promise.all` batch. `mtimeMs` is floored to whole ms.
- **Errors:** unreadable dirs/files are collected in `errors[]`, not thrown. They surface as the `walkErrors` warning.
- **Output:** files sorted by key; `folders[]` = every walked directory, including ones without audio.
- **Options** (the library scan uses the defaults; the playlist folder search uses the rest):
  - `recursive` (default `true`; `false` = only the root's own files)
  - `maxDirs` (throws `code: 'TOO_MANY_DIRS'` once exceeded)
  - `skipNames` (extra folder names to skip)
  - `onProgress` also reports `folders`

### 3. Change detection & probe cache (`engine.js#scan`)
- Each walked file gets a record (`records[key] ??= {}`).
- **Probed** when size or `mtimeMs` differs from the record, when neither `probe` nor `probeError` is cached, or when a cached ALAC probe has no rate (`staleProbe`: probes from before the hi-res ALAC fix, D37).
- **Not probed:** `.mp3`. It is always CDJ-compatible, so only size/mtime are stored.
- **Probing:** `probe.js#probeFile` reads headers only (see audio-pipeline.md for the fields). It runs 8 at a time (`PROBE_CONCURRENCY`).
- **On failure:** the error is stored as `probeError` with `probe = null`, and the file becomes `unreadable` (or `unsupported` if its format isn't ticked).

### 4. Missing sources
Records whose key was not walked this time:
- **Had a conversion (`done`):** keep the record, set `missingSince` once, and count it in `counts.missing`. The output file is never touched (decision D3).
- **No conversion:** delete the record.

### 5. Planning (`plan.js#buildPlan`)
The format is `formatIdFor(ext, probe)`: the extension, plus the codec where an extension is shared (an `.m4a` is `alac` only if its codec is ALAC). The action is decided in this order:
1. The record has `probeError` → `unreadable` if its format is ticked, else `unsupported`.
2. Its format is ticked → `convert` if the probe has a `sampleRate`, else `unreadable`.
3. Otherwise → `compatible` if `isCompatible(ext, probe)`, else `unsupported`. See audio-pipeline.md → *Compatibility rules*.

`convert` entries also get `target = targetSpec(probe)` (audio-pipeline.md) and an `outRel`.

### 6. Output names (`names.js`, `plan.js#buildPlan`)
- **Base name:** `outputRelFor(key, '.aiff', safeNames, suffix)` sanitises every folder segment and the base name, then appends `.aiff`.
- **Sanitising** (`sanitizeSegment`, when `safeNames` is on, the default):
  - NFC-normalise
  - replace `< > : " / \ | ? *` and control characters with `_`
  - strip trailing dots and spaces
  - an empty name becomes `_`
  - reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, matched on the part before the first dot) get `_` appended to that part
- With `safeNames` off, only NFC normalisation happens.
- **Collisions** are claimed **case-insensitively**, because APFS, NTFS and FAT32 are case-insensitive by default. There are two passes:
  1. Entries whose record already owns an output (`done.outRel` equals the natural name, or the natural name plus ` (…)`) keep it. This keeps names stable when a new clashing file appears later.
  2. The rest are ordered by the format's position in `SOURCE_FORMATS` (FLAC before WAV), then by key. Each gets its natural name, else ` (wav)`, ` (wav 2)`, … using the source extension.
- `entry.renamed = true` when the final name isn't the natural one. This drives the `renamed` warning.

### 7. Up-to-date check (`engine.js#scan`)
For each `convert` entry, the output file is `stat`-ed (16 at a time):

| Condition | Status |
|---|---|
| Output exists **and** `record.done` matches `outRel`, `srcSize` and `srcMtimeMs` | `done` |
| Output exists, size > 0, **no** `record.done`, output mtime ≥ source mtime | `done` via **self-heal**: `record.done` is written with `adopted: true` |
| Anything else (no output, source changed, name changed) | `pending` |

`failedBefore` is true when `record.error` refers to the same size and mtime. The track is still retried, and flagged in warnings.

### 8. Manifest (`manifest.js`)
- **Location:** `<dataDir>/libraries/<id>.json`, where `id = sha1(path.resolve(input) + '|' + path.resolve(output)).slice(0,16)`.
- **Data dir** (`constants.js#defaultDataDir`):
  - macOS: `~/Library/Application Support/AudioConverter`
  - Windows: `%APPDATA%\AudioConverter`
  - Linux: `$XDG_CONFIG_HOME/AudioConverter`
  - `AUDIOCONVERTER_DATA_DIR` overrides all of these.
  - The CLI and the app share it.
- **Versioning:** `version: 1`. A file with another version, or one that doesn't parse, is discarded and rebuilt. Self-heal then recovers the finished work from the output folder.
- **Writes are atomic:** write `<file>.<pid>.tmp`, then rename. Calls are serialised through a promise chain, so parallel jobs can't interleave. A failed write doesn't break later saves.
- **Save points:**
  - at the end of every scan
  - during a convert via `maybeSave()` (at most every 5 s, when dirty)
  - at the end of a run
- The manifest is **only an optimisation**. The output folder is the source of truth for "is it converted", which is why self-heal exists.

### 9. Summary & warnings (`engine.js#summarize`)
Every warning message is a complete sentence with the count and correct plural. The UI and CLI print it verbatim.

| code | Raised when | UI style |
|---|---|---|
| `unreadable` | Ticked-format files with no readable stream info | error |
| `failedBefore` | Pending files that failed last run with the same size/mtime | warn |
| `longPath` | `outRel.length > CDJ_PROFILE.maxPathLength` (240) | warn |
| `deepFolder` | `folderDepth(outRel) + 1 > 8` (the output folder itself counts as a level on the USB) | warn |
| `renamed` | Collision suffix applied | warn |
| `winPath` | Windows only: absolute output path > 259 characters | warn |
| `diskSpace` | Estimated bytes > free bytes on the output volume | error |
| `walkErrors` | Unreadable files or folders during the walk | warn |
| `unsupported` | Audio that is neither ticked nor playable, grouped by extension in the message | warn |

- **Size estimate** (`estimateBytes`): `duration × rate × channels × bits/8 + 64 KB` per pending entry.
- **Free space:** `fs.statfs` on the nearest existing ancestor of the output.

## Data shapes

```js
// walk() → { files, folders, errors }
file   = { abs, key, ext /* lower-case */, size, mtimeMs /* int */ }
errors = [{ path, message }]

// manifest file
{ version: 1, inputRoot, outputRoot, createdAt, lastScanAt, lastRun, folders: [key], files: { [key]: record } }

// record
{
  size, mtimeMs,                       // last seen source stat
  probe: { container, codec, sampleRate, bits, channels, duration, lossless } | null,
  probeError?: string,
  missingSince?: ISOString,
  done?:  { outRel, srcSize, srcMtimeMs, at, adopted? },  // last successful conversion
  error?: { message, srcSize, srcMtimeMs, at },           // last failure
}

// plan entry (buildPlan → engine adds status/failedBefore)
{ ...file, formatId, probe, action, target, outRel, renamed?, status?, failedBefore? }
```

`lastRun` and the summary shape are in engine.md.

## Extending

- **Skip another folder name:** add it to `SKIP_DIRS` in `constants.js`.
- **Recognise another audio extension** (so it's counted as compatible or unsupported): add it to `OTHER_AUDIO_EXTS`. To make it *convertible*, see audio-pipeline.md → *Adding a source format*.
- **New warning:** call `warn(code, list, (n, pl) => \`${n} ${pl('file')} …\`, toText)` in `#summarize`. `pl(one, many)` handles plurals. Add a colour rule in `ui.md` (`renderStats`, which picks error vs warn by code) if it should look like an error.
- **Stronger change detection** (e.g. a content hash): extend the `changed` test in `#scan` and store the hash on the record. Keep the walk cheap by only hashing when size/mtime changed.
- **Detect moved/renamed tracks instead of re-converting:** FLAC STREAMINFO has an audio MD5 (`format.audioMD5` in music-metadata). Store it in `probe`, match new keys against `missing` records, and move the old output instead of converting. The move must stay opt-in (decision D3).
- **Create all input folders, including empty ones:** change the per-job `mkdir` in `engine.js#convertOne`, or mkdir `manifest.data.folders` before the pool.
- **Bump the manifest format:** increase `VERSION` in `manifest.js`. Old files are discarded, and self-heal recovers finished outputs.

## Gotchas & limitations

- **Change detection is size + mtime only.** A tag editor that preserves mtime *and* keeps the size identical goes unnoticed.
- **A tag-only change re-converts the whole track.** There is no retag-only path.
- **Moving or renaming in the library re-converts** the track under its new name. The old output stays as an untracked file.
- **Toggling "safe names" changes `outRel` for affected files.** They are converted again under the new names, and the old outputs stay.
- **The manifest id uses `path.resolve`, not realpath.** The same library reached through a different mount point or drive letter gets a new manifest, and self-heal adopts its outputs.
- **The walk is always full.** It's cheap locally, but noticeable on a slow NAS.
- **`unreadable` files are not attempted** with ffmpeg, even if ffmpeg could decode them.
- **Differently-cased folders** (`Techno/` and `techno/`) on a case-sensitive source merge into one folder on a case-insensitive output. Clashing file names inside them are suffixed.

## Tests

- **`test/unit.test.js`:**
  - `sanitizeSegment…` (two tests)
  - `outputRelFor…`
  - `isInside…`
  - `buildPlan: actions, collisions, stable names`
  - `buildPlan: name clashes are case-insensitive`
- **`test/e2e.test.js`:**
  - `scan counts the library…`
  - `second run converts nothing`
  - `changed source is reconverted, deleted source leaves output alone`
  - `lost manifest self-heals…`
  - `rejects nested or missing folders`
