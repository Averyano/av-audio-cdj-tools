# CLI

## Scope & files

`src/cli.js` is a thin terminal front-end over the same `Engine` the app uses. It shares the data dir, so runs from the CLI and the app see the same state.

## Behaviour

```bash
node src/cli.js scan    --in <library> --out <output> [options]
node src/cli.js convert --in <library> --out <output> [options]
npm run cli -- scan --in … --out …
```

| Option | Default | Notes |
|---|---|---|
| `--formats flac,wav` | formats with `defaultOn` | comma list of `SOURCE_FORMATS` ids |
| `--workers N` | `defaultWorkers()` | parallel ffmpeg processes |
| `--unsafe-names` | off | disables FAT32/Windows-safe renaming (`safeNames: false`) |
| `--ffmpeg PATH` | auto | engine `ffmpegPath` override |
| `--data-dir DIR` | `defaultDataDir()` | manifests location; `AUDIOCONVERTER_DATA_DIR` also works |
| `--json` | off | prints the summary/result as JSON; disables the progress line |
| `-h, --help` | | usage |

- **Progress:** a single `\r`-updated line on stderr, only when stderr is a TTY and `--json` is off. Phases are the same as engine events.
- **Summary** (stdout):
  - paths and ffmpeg version
  - counts
  - missing sources
  - size estimate
  - last run
  - each warning with up to 5 examples
  - failures (up to 20, with the ffmpeg stderr tail indented)
- **Ctrl-C:** while busy it calls `engine.cancel()`, and finished tracks are kept. When idle it exits with 130.
- **Exit codes:**
  - `0`: OK, including a convert cancelled mid-run (`lastRun.cancelled`)
  - `1`: error (validation, ffmpeg missing, cancelled scan)
  - `2`: convert finished with at least one failure

## Extending

- **New option:** add it to `parseArgs` options, map it into `opts`, and document it in `USAGE` and the table above.
- **New progress phase:** add a branch in the `engine.on('progress')` handler.
- **Machine consumers** should use `--json`. Its shape is exactly the engine summary/result (engine.md).

## Gotchas & limitations

- **Relative `--in`/`--out`** are resolved against the current directory. The manifest id uses the resolved path, so the same folders give the same state.
- **Playlist relinking is app-only** for now. The engine functions (`matchPlaylist`, `findMissingInFolder`, `buildM3u`) are CLI-ready if a `playlist` subcommand is wanted; see playlists.md → *Extending → Batch mode*.
- **Formats** are lower-cased and trimmed. An unknown id is a validation error from the engine.
