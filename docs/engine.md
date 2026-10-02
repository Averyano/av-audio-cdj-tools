# Engine (API, events, runs)

## Scope & files

The engine is the orchestration layer and the contract every interface (app, CLI, tests) relies on.

| File | Role |
|---|---|
| `src/engine/engine.js` → `Engine` | Public API, exclusivity, progress events, summary, convert loop, per-job lifecycle |
| `src/engine/pool.js` → `runPool` | Bounded concurrency with an abort signal |
| `src/engine/constants.js` → `defaultWorkers`, `defaultDataDir` | Defaults |

What a scan decides is in library-sync.md. How a file becomes an AIFF is in audio-pipeline.md and metadata.md.

## API

```js
import { Engine } from './src/engine/engine.js';
const engine = new Engine({ dataDir /* default defaultDataDir() */, ffmpegPath /* default null = auto */ });

await engine.scan(opts);      // → summary
await engine.convert(opts);   // → result = summary + failures (runs its own fresh scan first)
engine.cancel();              // aborts the running scan/convert
await engine.status({ inputRoot, outputRoot }); // → { lastRun, lastScanAt } | null (no scan, no writes)
await engine.matchPlaylist({ playlistPath, inputRoot, outputRoot, convertedRoot, safeNames }); // → match (playlists.md); read-only, allowed while busy
await engine.ffmpeg();        // → { path, version, soxr } (cached; throws if none found)
engine.busy;                  // true while a scan/convert runs
engine.on('progress', fn);    // see Events

opts = { inputRoot, outputRoot, formats: ['flac','wav'], safeNames = true, workers = defaultWorkers() }
```

- **One run at a time per `Engine`:** `#exclusive` throws `A scan or conversion is already running.`
- **`scan` / `convert` reject with:**
  - validation messages (library-sync.md → *Folder validation*)
  - `Cancelled` if aborted *during a scan* (including the scan phase at the start of `convert`)
  - the ffmpeg-not-found message: `convert` checks ffmpeg before scanning, while `scan` puts it in `summary.ffmpeg.error` instead

## Events

All events go through `engine.on('progress', payload)`. They are throttled to one per **100 ms** (`PROGRESS_EVERY_MS`, a single timer shared by all phases). The first and last event of a phase are forced through.

| phase | Payload | Emitted |
|---|---|---|
| `walk` | `{ phase, found }` | per directory; forced at the end |
| `probe` | `{ phase, done, total }` | per probed file; forced at the end if anything was probed |
| `check` | `{ phase, done, total }` | per `convert` entry stat |
| `convert` | `{ phase, total, converted, failed, active: [key], elapsedMs, etaMs \| null }` | on start, job start, job end; forced at start and end |

- **`total`** in the convert phase is the pending count at the start of that convert.
- **`etaMs`** is weighted by duration: `elapsed × (1 − frac) / frac`, where `frac` = seconds of audio processed ÷ total seconds pending. Failed tracks count as processed. It is `null` until something finishes.

## Summary (return of `scan`)

```js
{
  inputRoot, outputRoot,          // resolved real paths
  formats, safeNames, scannedAt, durationMs,
  counts: {
    audio,        // all walked audio files
    folders,      // walked directories
    selected,     // convert + unreadable (files of ticked formats)
    upToDate,     // convert entries with status 'done'
    pending,      // convert entries with status 'pending'
    resample,     // pending entries whose target.resample is true
    hires,        // convert entries with source rate > 48 kHz (done or pending)
    compatible, unsupported, unreadable,
    missing,      // sources gone since conversion (outputs kept)
  },
  estimate: { bytes, freeBytes /* null if unknown */ },
  warnings: [{ code, count, message, examples: [string] /* ≤ 20 */ }],  // codes: library-sync.md
  lastRun: lastRun | null,
  ffmpeg: { version, soxr, path } | { error },
}
```

## Convert result (return of `convert`)

This is the summary from the scan at the start of the run, adjusted for what happened:
- `counts.upToDate += converted`
- `counts.pending` = what's left
- `counts.resample` and `estimate.bytes` recomputed for what's left
- plus these fields:

```js
lastRun  = { startedAt, finishedAt, durationMs, pending, converted, failed, cancelled }
failures = [{ key, abs, message }]   // this run only; older failures show as the 'failedBefore' warning
```

`lastRun` is also persisted in the manifest. It drives "Last converted …" in the UI.

## Job lifecycle (`#convert` → `#convertOne`)

1. `#convert`:
   - get ffmpeg (throws early if missing)
   - fresh `#scan`
   - pick `pending` entries
   - `mkdir` the output root
   - run the pool with `workers`
2. Per job (`#convertOne`):
   1. `mkdir -p` the track's output folder. Only folders that receive tracks are created.
   2. `readTags` → `encodeId3v23`. Tag errors are swallowed.
   3. `runFfmpeg(buildArgs(...))` → `<out>.aiff.part`.
   4. Aborted → throw `Cancelled`. Non-zero exit → throw with the stderr tail.
   5. `appendAiffChunk(part, 'ID3 ', tag)`.
   6. Verify (audio-pipeline.md → *Verification*).
   7. `rename(part → .aiff)`, overwriting an older output.
   8. On any throw: `rm` the `.part` (3 retries, 200 ms apart, for Windows file locks) and return `{ok:false, message}`.
3. Back in the pool callback:
   - **success:** `record.done = {outRel, srcSize, srcMtimeMs, at}`; clear `record.error`
   - **failure while not cancelled:** set `record.error` and push to `failures`
   - **failure caused by cancel:** not recorded
   - then `manifest.maybeSave()`
4. After the pool: write and save `lastRun`, emit a forced final progress event, return the result.

## Concurrency

| Work | Limit | Where |
|---|---|---|
| Conversions | `opts.workers`; default `defaultWorkers()` = `min(cpus − 1, 6)`, at least 1; the app clamps to 1–16 | `#convert` |
| Probing | 8 | `PROBE_CONCURRENCY` |
| Output stat checks | 16 | `STAT_CONCURRENCY` |

`runPool(items, limit, worker, signal)` starts at most `limit` workers. Each pulls the next item until the list is exhausted or the signal aborts. Workers must catch their own errors, because one throw rejects the whole pool.

## Cancellation

- `cancel()` aborts the internal `AbortController` with reason `Error('Cancelled')`.
- **During a scan:** the walk checks the signal per directory and the pools stop taking items. The scan then throws `Cancelled`.
- **During conversion:**
  - The pool stops starting jobs.
  - Running ffmpeg processes are killed through `spawn`'s `signal`.
  - Their `.part` files are deleted and they are not recorded as failures.
  - `convert` resolves normally with `lastRun.cancelled = true`.
  - The next run converts exactly what's left.

## Extending

- **New progress phase:** emit `{phase: 'x', …}` via `#emit` (force the last one). Then handle it in `ui.md` (`onProgress`) and `cli.md` (progress line).
- **New summary field:** add it in `#summarize`. If it depends on the run, adjust it in the convert result as well.
- **Pause/resume:** today it's cancel + run again, which resumes naturally. A true pause would gate `runPool` on a promise rather than abort.
- **UI jank with huge libraries:** move the `Engine` into an Electron `utilityProcess` and forward events. The engine has no Electron dependencies, so only `main.js` changes.

## Gotchas & limitations

- **`convert` always rescans first.** This is cheap, but it means the counts shown in the UI can shift slightly between Scan and Convert.
- **The throttle timer is shared by all phases**, so an intermediate event right after a phase change can be dropped. Only the forced ones are guaranteed.
- **`hires` counts done entries too.** It describes the library, not the remaining work.
- **`status()` only reads the manifest.** It never creates one.

## Tests

`test/e2e.test.js` covers these:
- `second run converts nothing`
- `changed source is reconverted…` (lastRun and counts)
- `cancel stops a run and leaves no partial files`, which cancels from a progress listener and then resumes, expecting exactly the remaining count
