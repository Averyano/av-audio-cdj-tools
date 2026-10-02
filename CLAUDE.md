# CLAUDE.md

AudioConverter mirrors a FLAC/WAV/ALAC library into CDJ-2000NXS-compatible AIFF. It's an Electron app plus a CLI, sharing a pure-Node engine.

**Developer docs live in `docs/`. Start at `docs/README.md`**, which has the doc map and a symptom → doc triage table. Read the doc for the subsystem you're touching before changing it. When behaviour changes, update that doc in the same change, and log new decisions in `.claude/docs/decisions.md`.

(The `CLAUDE.md` in the parent `vscode/` folder describes an unrelated project and doesn't apply here.)

## Prerequisites

Node.js ≥ 22.12 is the only system requirement for working on the source. `ffmpeg-static` (a dev dependency) provides ffmpeg for `npm start` and the tests, and there are no native modules. The installers don't contain ffmpeg; the packaged app finds the user's own (D41). Details are in `README.md` → *Requirements*.

## Commands

```bash
npm install        # Electron + ffmpeg-static (npm ≥ 11: install scripts allowed via package.json allowScripts)
npm start          # desktop app
npm test           # unit + e2e (fixtures generated with ffmpeg)
node src/cli.js scan|convert --in <library> --out <output>
npm run dist:mac   # / dist:win / dist:linux — build on the target OS
npm version minor && git push --follow-tags   # release: CI builds a draft (docs/desktop-app.md → Releases)
```

## Rules

- `src/engine/` must stay free of Electron imports; the CLI and the tests run it directly. `src/engine/camelot.js`, `prefs.js` and `release.js` must import nothing at all: the renderer loads them directly.
- Never add behaviour that deletes or rewrites existing files in the output folder (decision D3).
- Use `AUDIOCONVERTER_DATA_DIR=<tmp>` for experiments so real settings and manifests aren't touched. `AUDIOCONVERTER_RELEASE_FILE=<json>` fakes the latest GitHub release for the update dialog.
- The app only opens fixed URLs (`LINKS` in `main.js`); never open a URL that came from the page or from GitHub's answer.
- Every path the app reads or writes comes from a native dialog. The one exception is the analyzer, which only reads: a dropped file's path is resolved in the preload with `webUtils.getPathForFile`. The renderer never sends arbitrary paths (decisions D18, D23).
- Toggle visibility with `el.hidden`. A global `[hidden]` rule makes it win over component `display` values.
- Dev loop: renderer edits → Cmd+R in the window; `src/main` or `src/engine` edits → restart `npm start`. There's no HMR or dev server.
