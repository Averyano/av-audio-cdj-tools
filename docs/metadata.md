# Metadata (tags & artwork)

## Scope & files

This subsystem reads a source's tags and cover, maps them to ID3v2.3 frames that rekordbox and CDJs read, and writes them into the AIFF.

| File | Role |
|---|---|
| `src/engine/probe.js` → `readTags` | Full music-metadata parse: `{common, native}` including pictures |
| `src/engine/tags.js` | `buildTagPairs(common, native)`, `pickCover(common)`, `nativeValue` fallback lookup |
| `src/engine/id3.js` | `encodeId3v23(pairs, picture)`, `appendAiffChunk(file, 'ID3 ', buffer)` |
| `src/engine/engine.js` → `#convertOne` | Order: read tags → ffmpeg (no tags) → append ID3 chunk → verify |

Decision D6 explains why tags aren't written by ffmpeg: ffmpeg would store BPM, key and comment as `TXXX` frames, which rekordbox ignores.

## Behaviour

### Reading
- **Call:** `parseFile(src, {skipCovers: false, duration: false})`. It runs once per job, just before ffmpeg.
- **On failure:** the track still converts, just without tags. Audio matters most.

### Mapping (`tags.js#buildTagPairs`)
| ID3 frame | Source (music-metadata) | Transform |
|---|---|---|
| TIT2 title | `common.title` | |
| TPE1 artist | `common.artist`, else `common.artists` | arrays joined with `, ` |
| TALB album | `common.album` | |
| TPE2 album artist | `common.albumartist` | |
| TCON genre | `common.genre[]` | joined `, ` |
| TYER year | `common.date` or `common.year` | first 4 digits only (no TDAT) |
| TRCK track | `common.track {no, of}` | `n` or `n/of` |
| TPOS disc | `common.disk {no, of}` | `n` or `n/of` |
| **TBPM** | `common.bpm` | rounded to an integer (ID3 spec) |
| **TKEY** | `common.key`, else native `INITIALKEY` / `INITIAL KEY` | Traktor, Mixed In Key and Beatport write `INITIALKEY`, which music-metadata doesn't map |
| **TPUB** label | `common.label[]` (Vorbis LABEL, ORGANIZATION, PUBLISHER) | joined `, ` |
| TCOM composer | `common.composer[]` | joined |
| TSRC ISRC | `common.isrc[0]` | |
| TPE4 remixer | `common.remixer[]`, else native `MIXARTIST` | joined |
| TIT3 subtitle/mix | `common.subtitle[]` | joined |
| TIT1 grouping | `common.grouping` | |
| TCOP copyright | `common.copyright` | |
| **COMM** comment | first `common.comment[].text` | language `eng`, empty description |
| TXXX:CATALOGNUMBER | `common.catalognumber[0]` | |

- **Cleaning:** every value is `String()`-ed, NUL-stripped and trimmed. Empty values are dropped and each value is capped at 2000 characters.
- **Native fallback:** `nativeValue(native, ids)` searches every native tag type (vorbis, ID3, iTunes…) for the upper-cased ids. In an `.m4a` (ALAC) these are iTunes freeform atoms, e.g. `----:com.apple.iTunes:initialkey`; the `----:com.apple.iTunes:` prefix is stripped before comparing (D37). BPM there is `tmpo`, which music-metadata maps to `common.bpm`.
- **Not carried over:**
  - lyrics, ReplayGain, ratings, sort-order tags, compilation flag
  - MusicBrainz IDs and other unmapped Vorbis fields
  - extra pictures
  - DJ-software private frames (rekordbox, Serato or Traktor cue points and beatgrids)

### Artwork (`tags.js#pickCover`)
- **Choice:** the first picture whose `type` matches `/front/i`, otherwise the first picture.
- **Written as:** an APIC frame, type 3 (front cover), MIME from `picture.format` (default `image/jpeg`), empty description, original bytes. No resizing.

### ID3v2.3 encoder (`id3.js#encodeId3v23`)
- **Header:**
  - `ID3`, version `3.0`, flags `0`
  - body size as a 4-byte synchsafe integer
  - no padding, no unsynchronisation, no extended header
- **Frames:** 10-byte header with a plain big-endian size (v2.3), flags `0`.
- **Text encoding:** byte `0` (Latin-1) when every character is ≤ U+00FF, otherwise `1` (UTF-16 LE with BOM `FF FE`).
- **Frame kinds** (by the pair's id):
  - `T` + 3 alphanumerics, except `TXXX` → text frame: encoding + text
  - `COMM` → encoding + `eng` + description + terminator + text
  - anything else → `TXXX` with the id as description (e.g. `CATALOGNUMBER`)
  - COMM and TXXX use one encoding for both parts, so UTF-16 if either needs it
  - a picture → `APIC`: encoding 0 + MIME + `\0` + type + empty description + `\0` + data

### AIFF chunk (`id3.js#appendAiffChunk`)
1. Checks the file starts with `FORM….AIFF` (plain AIFF only).
2. Appends `ID3 ` + big-endian size + data, plus a pad byte when the length is odd. The pad isn't counted in the chunk size, and the chunk starts on an even offset.
3. Rewrites the FORM size to `fileEnd − 8`.

This runs on the `.part` file before verification, so the verification read also parses the tags.

## Data shapes

```js
pairs   = [['TIT2', 'Title'], ['TKEY', '8A'], ['COMM', 'Energy 7'], ['CATALOGNUMBER', 'CAT001'], …]
picture = { format: 'image/png', data: Uint8Array, type?: 'Cover (front)', description? } | null
```

## Extending

- **Carry another tag:** add a `[frameId, value]` row in `buildTagPairs`. For a `T***` frame nothing else changes. For non-text frames (e.g. `USLT` lyrics, `POPM` rating), add an encoder branch in `encodeId3v23`, following `describedFrame`/`apicFrame`.
- **Another vendor-specific source field:** add its upper-cased name to the relevant `nativeValue(...)` list.
- **Keep all unknown Vorbis fields:** iterate `native.vorbis`, skip ids already mapped, and emit `[ID, value]`. Anything that isn't a `T***` id automatically becomes `TXXX:ID`.
- **Downscale huge covers:** this needs an image library (none is bundled). Do it before `encodeId3v23` and keep the MIME consistent.
- **Switch to ID3v2.4:** version byte `4`, synchsafe *frame* sizes, UTF-8 (encoding `3`), and `TDRC` instead of `TYER`. This isn't recommended for older CDJs (decision D14).
- **Tags for another output container:** WAV would take a RIFF `id3 ` chunk plus a RIFF size fix. Write an `append<Container>Chunk` next to `appendAiffChunk`.

## Gotchas & limitations

- **Where tags are read:** rekordbox reads them when importing. A CDJ playing a rekordbox-exported USB shows rekordbox's database values, not file tags. File tags matter for rekordbox import and for non-exported USB browsing.
- **Any tag edit in the source re-converts the whole file**, because change detection works on size and mtime.
- **The artist text** comes from music-metadata's `common.artist`, which may already join multiple artists in its own style.
- **Large embedded covers** (5–20 MB PNGs happen) are held in memory per job and copied into every output.
- **No padding in the tag.** Tools that later edit the AIFF tags in place will rewrite the file; that's harmless.

## Tests

- **`test/unit.test.js`:**
  - `buildTagPairs maps DJ-relevant tags to real ID3 frames` (includes the native INITIALKEY and MIXARTIST fallbacks, and the iTunes freeform key)
  - `encodeId3v23 writes a valid v2.3 header and frames`
- **`test/e2e.test.js` → `convert writes CDJ-safe AIFF…`:** reads the output back and asserts title, unicode artist, BPM, key, label, comment, year, a PNG cover and tag type `ID3v2.3`.
