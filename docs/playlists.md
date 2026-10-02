# Playlists (relink .m3u/.m3u8 to converted files)

## Scope & files

This subsystem takes a playlist that points at library files (FLAC/WAV…). It finds each track's converted AIFF and writes a new playlist, so rekordbox can import a version that plays on the CDJ.

| File | Role |
|---|---|
| `src/engine/playlists.js` | Parse/serialise M3U, resolve entry locations, match entries to converted files, name and write the new playlist |
| `src/engine/engine.js` → `matchPlaylist` | Validates the converted folder; passes the data dir so the manifest can be used |
| `src/main/main.js` → `playlist` session, `playlist:*` IPC | Holds the playlist path and match in memory; dialogs for playlist, manual track and save |
| `src/renderer/app.js` → `renderPlaylist` and friends | The Playlist card (ui.md → *Playlist card*) |

## Behaviour

### Flow
1. **Choose a playlist** (`.m3u8` or `.m3u`) in a native dialog.
2. **Converted folder:** defaults to the **Output** folder and is shown greyed out. Ticking *Use a different converted folder* enables its Choose… button.
3. **Convert playlist:** runs `matchPlaylist`, which reads the playlist and works out a target for each entry.
4. **Review:** the UI shows original vs converted, per row. Green means found; yellow means not found, with a folder button to choose the file manually.
5. **Create playlist:** opens a Save dialog prefilled with `<prefix><name>.m3u8` (prefix defaults to `av-`) next to the original, and writes the file.

### Reading (`readPlaylist`, `parseM3u`)
- **Encoding:** UTF-8, falling back to Latin-1 for legacy `.m3u`. A BOM is stripped.
- **Line endings:** the original's newline style (CRLF/LF) is remembered and reused.
- **Header vs per-track lines:** `#EXTM3U` and `#PLAYLIST:` before the first track are **header** lines. Every other `#…` line (e.g. `#EXTINF:407,Artist - Title`) is attached to the next track as its **directives**, and written back unchanged.

### Resolving a location (`resolveLocation`)
- `file://` URLs → local paths.
- Other URL schemes → no local path.
- Absolute paths stay absolute; relative paths resolve against the playlist's folder.
- Paths written on another OS (e.g. `C:\DJ\x.flac` read on macOS) don't resolve locally. They are still split into segments on both `/` and `\` and matched by path tail (below).

### Matching (`matchPlaylist` → `matchEntry`), in order
1. **Find the library key.**
   - If the location is inside the input folder, the key comes straight from the path.
   - Otherwise it's the manifest key with the **longest matching path tail**: the file name, then as many parent folders as possible, compared case-insensitively and NFC. A tie means `ambiguous`.
2. **Known key → converted file.** Try, in order, and take the first that exists in the converted folder:
   - the manifest's `done.outRel`
   - the natural name with the current safe-names setting
   - the natural name with the opposite setting
   - the name with the ` (ext)` collision suffix

   If none exists and the source format isn't a convertible one (MP3/AAC/compatible AIFF), the source itself is kept as **`original`** when `isCompatible` says the CDJ plays it. `kindOf` (`source` / `playable` / `unsupported`) decides, with `formatIdFor`: an `.m4a` is probed if the manifest has no probe, and is a source when it's ALAC, playable when it's AAC (D37).
3. **Fallback: path tail inside the converted folder.** The converted folder is walked once, and `.aiff`/`.aif` files are matched by sanitised path tail. This covers a lost manifest, a library at another path, or a copy of the output on a USB stick.
4. **A file outside the library:**
   - inside the converted folder → `found`
   - playable as-is → `original`
   - otherwise `missing`
5. **Missing reasons:**

| reason | Meaning | UI text |
|---|---|---|
| `not-converted` | A library track in a convertible format without output yet | In your library but not converted yet — run Convert |
| `unreadable` | Library track whose headers can't be read (`probeError`, or no sample rate) | Source file could not be read |
| `not-found` | No library track and no converted file match | Not found |
| `ambiguous` | Several equally good matches | Several possible matches — choose one |
| `unsupported` | Exists, but is neither converted nor CDJ-playable (e.g. OGG) | Not playable on the CDJ and not converted |

### Manual pick (`playlist:pickTrack` → `resolveFile`)
- Available on `missing` rows and on rows already resolved by hand.
- The file dialog offers **every audio format** (`AUDIO_EXTS`, incl. FLAC) plus *All files*, starting in the converted folder.
  - Earlier the filter was AIFF/AIF/MP3/M4A/WAV only, which greyed out the FLAC originals people naturally go looking for.
- `resolveFile(match, file)` decides what the pick becomes:
  1. **The file itself**, if the CDJ can play it (`isCompatible`: MP3, AAC, plain 16/24-bit 44.1/48k AIFF/WAV). An explicit pick is honoured as-is.
  2. **Its converted AIFF**, found through the same rules as `matchEntry` (e.g. picking the original FLAC from the library).
  3. **Otherwise refused** with *"X can't play on the CDJ and has no converted copy yet. Run Convert first, or choose an AIFF/MP3."* The row stays yellow.
- Accepted picks get `status: 'manual', via: 'pick'` (tag *chosen*), and counts are recomputed.

### Find in folder (`playlist:searchFolder` → `findMissingInFolder`)
- **Button above the list; one folder dialog.** It then searches that folder's audio files for **all** missing rows at once.
- **Recursive** (setting `playlistSearchRecursive`, **off by default**): off = only the folder's own files; on = every subfolder too.
- **Matching:**
  - by file name: the entry's stem, raw or sanitised, compared case-insensitively and NFC
  - then the longest path-tail match
  - then format preference: AIFF > MP3/M4A/AAC > WAV > anything else (FLAC)
  - A remaining tie is left missing, not guessed (D16).
- **Each candidate goes through `resolveFile`**, so a FLAC in the folder only counts if its converted AIFF exists.
- **Result:** `status: 'manual', via: 'folder'` (tag *found in folder*). The status line says *Found N of M missing tracks in "folder" (K audio files checked).*
- **Safety for recursive searches** (D19):
  - `isTooBroadForRecursive` refuses:
    - a filesystem root
    - the home folder or anything above it
    - `/Volumes` itself
    - system folders (`/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`; on Windows `C:\Windows`, `Program Files*`, `ProgramData`)
  - The walk stops with an error after `SEARCH_MAX_DIRS` (20,000) folders.
  - It skips `node_modules`, dotfolders and the usual system folders, and doesn't follow symlinks.
  - It can be cancelled (`playlist:cancelSearch`), and progress (`folders`) streams on `playlist:progress`.

### Writing (`buildM3u`, `writePlaylist`, `playlistFileName`)
- **Content:** `#EXTM3U`, then the other header lines, then for each entry **with a target** its directives and the target's absolute path. Entries without a target are left out.
- **Encoding:** UTF-8 without BOM, in the original's newline style, written atomically (tmp + rename).
- **Default name:** `cleanPrefix(prefix) + <original name> + .m3u8`. `cleanPrefix` strips filename-illegal characters and caps at 40 chars.

### Where state lives
- **Main process** keeps `playlist = {path, match, savedPath, searchDir, searchAbort}` in memory. It is reset on quit, and `match` is cleared whenever the input, output, safe names or converted folder changes.
- **Renderer** only displays `publicMatch()` (no parsed file or directives) and sends indexes back.
- **Paths:** every path read or written comes from a native dialog (decision D18).

## Data shapes

```js
parsed = { header: ['#EXTM3U', …], entries: [{ directives: ['#EXTINF:…'], location }], newline: '\n' | '\r\n' }

match  = {
  playlistPath, convertedRoot, parsed,
  entries: [{
    index, directives, location, sourcePath /* resolved or null */, sourceName,
    segs,                             // location split into path segments (for tail matching)
    status: 'found' | 'original' | 'manual' | 'missing',
    reason?: 'not-converted' | 'unreadable' | 'not-found' | 'ambiguous' | 'unsupported',
    via?: 'pick' | 'folder',          // how a 'manual' entry was resolved
    target /* absolute path or null */, targetName,
  }],
  counts: { total, found, original, manual, missing },
  context,   // { records, inputRoots, sourceIndex, convertedIndex, convertedRoot, safeNames }, reused by resolveFile
}

// findMissingInFolder result
{ folder, recursive, filesSearched, foldersSearched, resolved, remaining }

// playlist:save result
{ path, written, skipped } | null /* dialog cancelled */
```

## Extending

- **rekordbox XML relink** (keeps cues, beatgrids and play counts): add `parseRekordboxXml`/`buildRekordboxXml` next to the M3U functions and reuse `matchEntry` per `TRACK@Location`. It's a `file://localhost/…` URL, so decode it with `resolveLocation` after stripping `localhost`. Also update `Kind`, `Size`, `BitRate` and `SampleRate`. See roadmap.md.
- **Relative paths in the output** (portable playlists next to the music): in `buildM3u`, write `path.relative(dirname(savePath), target)` instead of the absolute target. That needs the save path first, so pass it in.
- **Convert the missing tracks from here:** `not-converted` entries have keys. A "Convert these N" action could call `engine.convert` limited to those keys. The engine currently converts all pending tracks; it would need a key filter.
- **Batch mode** (a whole folder of playlists): loop `matchPlaylist` + `buildM3u` over the files. It fits the CLI best (cli.md).
- **Another prefix default:** `DEFAULTS.playlistPrefix` in `main.js`.

## Gotchas & limitations

- **Matching reads the manifest as of the last scan.** Tracks converted by a run that's still going are only found if their file already exists (steps 2–3 check the filesystem, so usually yes).
- **Path-tail matching can be ambiguous** for common names (`Intro.flac`) in several folders with the same parents. Those rows need a manual pick.
- **Written paths are absolute.** Moving the converted folder later breaks the playlist; re-run the playlist conversion.
- **The `#EXTINF` duration and title are copied as-is.** They describe the source, which is also correct for the AIFF.
- **`.m3u` files are always saved as `.m3u8` (UTF-8).** rekordbox reads both.
- **Session only:** the chosen playlist and its match are lost when the app quits. The prefix, converted-folder and recursive settings persist.
- **Find in folder matches by file name.** A track renamed in the search folder won't be found; use the per-row pick.
- **The 20,000-folder cap is a blunt limit.** A huge but legitimate music drive may hit it. Search a subfolder instead, or raise `SEARCH_MAX_DIRS`.

## Tests

`test/playlist.test.js` runs on its own converted fixture library:
- `parseM3u keeps header, per-track directives and newline style`: parse, CRLF, BOM, directives, serialise.
- `playlistFileName and resolveLocation`
- `matches entries to converted files and writes a relinked playlist`, which covers:
  - absolute paths, a `file://` URL and a relative path
  - a sanitised name and a collision suffix
  - a foreign Windows path (matched by path tail)
  - an original MP3, an unreadable file and a missing file
  - an ALAC `.m4a` (→ its AIFF) and an AAC `.m4a` (kept as original)
  - the written output
- `a different converted folder with the same structure is used`
- `without a known library, the converted folder is matched by path tail`
- `missing converted folder is rejected`
- `a picked file: playable as-is, original → its converted AIFF, unconverted → null`
- `find in folder: top level only, or recursive; prefers ready-to-play formats`
- `recursive search refuses the whole disk and the home folder; walk stops at maxDirs`

The UI flow (pick, match, manual pick, save) is covered by the CDP smoke run with stubbed dialogs (testing.md → *UI smoke*).
