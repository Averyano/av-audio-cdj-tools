# AudioConverter — developer docs

AudioConverter mirrors a FLAC/WAV/ALAC library into AIFF files that a Pioneer CDJ-2000NXS (NXS1) can play. It keeps the folder structure, tags and artwork. Runs are incremental: only new or changed tracks are converted. The app is Electron + Node, with a CLI that shares the same engine.

The root `README.md` is for users. These docs are for changing the code.

## Doc map

| Doc | Covers | Open it when… |
|---|---|---|
| [architecture.md](architecture.md) | Layers, module map, end-to-end flow, glossary | You're new here or tracing a flow across layers |
| [library-sync.md](library-sync.md) | Walking the library, probe cache, planning, output names, manifest, self-heal, warnings | Wrong counts, tracks re-converted or skipped wrongly, name/path problems, manifest questions |
| [audio-pipeline.md](audio-pipeline.md) | CDJ profile, format rules, target spec, ffmpeg arguments, resampling, output verification | Wrong rate/bit depth, AIFF won't play, ffmpeg errors, adding formats or CDJ models |
| [metadata.md](metadata.md) | Reading tags, tag→ID3 mapping, ID3v2.3 encoder, AIFF chunk, artwork | Missing or wrong tags, key/BPM/artwork not showing in rekordbox |
| [playlists.md](playlists.md) | Playlist conversion: relinking .m3u/.m3u8 to converted files, matching rules, manual picks, Find in folder (recursive guard), writing | Playlist tracks not found or wrongly matched, new playlist content or naming |
| [engine.md](engine.md) | Engine API, events, result shapes, convert job lifecycle, cancellation, concurrency | Progress/ETA issues, cancel/resume, API contract for UI or CLI |
| [desktop-app.md](desktop-app.md) | Dev workflow (reload vs restart, DevTools), Electron main process, IPC contract, settings, security, window lifecycle, packaging, update check, versions and releases | Changes not showing up, IPC errors, settings not saved, quitting mid-run, building `.dmg`/`.exe`/`.AppImage`, cutting a release, update dialog |
| [ui.md](ui.md) | Renderer state and rendering, UI states and copy, visual system (tokens, fonts, logo/images, components) | Anything visual, button states, status text, styling |
| [cli.md](cli.md) | Command line interface | Scripting, headless runs, CLI output |
| [testing.md](testing.md) | Test suites, fixtures, UI smoke via CDP, real-world checklist | Adding tests, reproducing bugs, verifying a release |
| [decisions.md](decisions.md) | Why things are the way they are, and when to revisit | Before changing a core behaviour |
| [analyzer.md](analyzer.md) | Audio analyzer: decoding, spectrogram, cutoff/ultrasonic/bit-depth detection, verdicts, tempo + key estimate, drop & compare UI | Wrong hi-res verdict, spectrogram looks off, drop not working, compare, tempo/key row |
| [camelot.md](camelot.md) | Camelot wheel view: key model, tempo → pitch maths, CDJ ranges, mixing chart, verdicts, deck UI, Listen (tempo/key/tuning from an audio input) | Wrong landed key/cents, fader or wheel behaviour, mixing suggestions |
| [roadmap.md](roadmap.md) | Planned features and how they plug in | Starting a new feature |

## Bug triage: symptom → where to look

| Symptom | Start in |
|---|---|
| Track not converted / wrongly counted "compatible" or "unsupported" | library-sync.md → *Planning*; audio-pipeline.md → *Compatibility rules* |
| Everything re-converts every run | library-sync.md → *Up-to-date check* |
| Changed track not re-converted | library-sync.md → *Change detection* |
| Output name mangled / `(wav)` suffix | library-sync.md → *Output names* |
| Wrong sample rate / bit depth / channels | audio-pipeline.md → *Target spec* |
| CDJ refuses a file | audio-pipeline.md → *CDJ profile*; testing.md → *Real-world checklist* |
| ffmpeg error in the failure list | audio-pipeline.md → *ffmpeg invocation*; engine.md → *Job lifecycle* |
| Tags, key, BPM or artwork missing in rekordbox | metadata.md |
| Progress bar / ETA / live counters wrong | engine.md → *Events*; ui.md → *Progress* |
| Cancel leaves files or doesn't stop | engine.md → *Cancellation* |
| "already running" errors, IPC failures | desktop-app.md → *IPC contract* |
| Settings not remembered | desktop-app.md → *Settings* |
| Settings page: add a preference, a toggle not applied | ui.md → *Settings*, *Extending → New preference* |
| Layout, colours, accent scheme, night mode | ui.md → *Visual system* |
| Nav rail, switching views, adding a view | ui.md → *Page structure*, *Extending → New view* |
| Analyzer: wrong verdict (fake hi-res missed, genuine file accused) | analyzer.md → *Detection*, *Verdict*; run `node --test test/spectrum.test.js test/analyzer.test.js` |
| Analyzer: drop does nothing, file refused, spectrogram blank | analyzer.md → *Flow*, *Gotchas* |
| Analyzer: tempo/key row stuck on "Working out…", wrong BPM (4:3, half/double) or key | analyzer.md → *Tempo and key*; camelot.md → *Extending* (4:3, mode), *Library check* |
| "Something went wrong" banner, or an error dialog from main | desktop-app.md → *Error handling*; the log line `[main] unexpected error` has the stack |
| Camelot: wrong key, cents or verdict | camelot.md → *Behaviour*; run `node --test test/camelot.test.js` |
| Camelot: fader, wheel or layout glitch, deck not remembered | camelot.md → *UI*, *Gotchas* |
| Camelot layout on a wide window (pinned wheel, columns) | camelot.md → *UI layouts* |
| Listen: an interface's inputs 3/4 missing, line input silent or refused | camelot.md → *Line inputs* |
| Listen: line input reads a higher BPM than the mic, *no clear beat*, or fails to start | camelot.md → *Line inputs* (dropped buffers, failed starts), decisions.md → D31 |
| How accurate BPM/key are on real tracks; running the rekordbox comparison | camelot.md → *Tests → Library check* |
| Listen: wrong tempo (half/double) or key, silent input, mic permission | camelot.md → *Listen*, *Gotchas*; desktop-app.md → *Packaging* (mic) |
| Playlist track yellow / wrongly matched | playlists.md → *Matching* |
| New playlist content, paths, name or encoding wrong | playlists.md → *Writing* |
| Playlist card buttons, greyed folder, prefix, what shows when | ui.md → *Playlist card* |
| Manual pick refused / Find in folder finds nothing or refuses a folder | playlists.md → *Manual pick*, *Find in folder* |
| Element visible although `hidden` | ui.md → *Gotchas* (`[hidden]` rule) |
| Font, logo or icon wrong | ui.md → *Fonts*, *Images* |
| Code change not showing in the app | desktop-app.md → *Development workflow* |
| Packaged app can't find ffmpeg, *ffmpeg is needed* dialog, chosen ffmpeg refused | audio-pipeline.md → *Locating ffmpeg*; desktop-app.md → *Gotchas* (quarantine) |
| Update dialog doesn't appear, wrong version, *No release has been published yet* | desktop-app.md → *Updates* (private repo, drafts, skipped version) |
| Cutting a release; release build failed; version/tag mismatch | desktop-app.md → *Releases*; `.github/workflows/release.yml` |
| Release notes in the dialog look wrong | `release.js#parseNotes`; keep the changes above the `---` line in the release body |

## Writing and updating these docs

- **Update in the same change.** A change in behaviour updates its doc too. New decisions go in `decisions.md`.
- **Anchor on names, not line numbers.** Point to `file.js → functionName`, which stays true as code moves.
- **One doc per subsystem.** Add a file only for a genuinely new subsystem; otherwise add a section to an existing doc.
- **Same shape for component docs.** Each one uses these sections, so bugs and extensions are easy to place:
  1. **Scope & files**: what the component owns and which files implement it.
  2. **Behaviour**: rules, with the reason where it isn't obvious.
  3. **Data shapes**: objects this component produces or consumes.
  4. **Extending**: recipes for likely changes.
  5. **Gotchas & limitations**: known sharp edges, deliberate trade-offs.
  6. **Tests**: which tests cover it.
