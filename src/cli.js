#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Engine } from './engine/engine.js';
import { SOURCE_FORMATS, defaultWorkers, defaultDataDir } from './engine/constants.js';

const USAGE = `Usage:
  node src/cli.js scan    --in <library> --out <output> [options]
  node src/cli.js convert --in <library> --out <output> [options]

Options:
  --formats flac,wav   source formats to convert (default: ${Object.values(SOURCE_FORMATS).filter((f) => f.defaultOn).map((f) => f.id).join(',')})
  --workers N          parallel ffmpeg processes (default: ${defaultWorkers()})
  --unsafe-names       keep names as-is (skip FAT32/Windows-safe renaming)
  --ffmpeg PATH        use this ffmpeg binary
  --data-dir DIR       where manifests live (default: ${defaultDataDir()})
  --json               print the result as JSON
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    formats: { type: 'string' },
    workers: { type: 'string' },
    'unsafe-names': { type: 'boolean', default: false },
    ffmpeg: { type: 'string' },
    'data-dir': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
if (values.help || !['scan', 'convert'].includes(command)) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const engine = new Engine({ dataDir: values['data-dir'] ?? defaultDataDir(), ffmpegPath: values.ffmpeg ?? null });
const opts = {
  inputRoot: values.in,
  outputRoot: values.out,
  formats: (values.formats ?? Object.values(SOURCE_FORMATS).filter((f) => f.defaultOn).map((f) => f.id).join(','))
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  safeNames: !values['unsafe-names'],
  workers: values.workers ? Number(values.workers) : defaultWorkers(),
};

const tty = process.stderr.isTTY && !values.json;
engine.on('progress', (p) => {
  if (!tty) return;
  let line = '';
  if (p.phase === 'walk') line = `Scanning… ${p.found} audio files`;
  else if (p.phase === 'probe') line = `Reading new/changed files… ${p.done}/${p.total}`;
  else if (p.phase === 'check') line = `Checking outputs… ${p.done}/${p.total}`;
  else if (p.phase === 'convert') {
    const eta = p.etaMs != null ? `, ~${fmtDuration(p.etaMs)} left` : '';
    line = `Converting ${p.converted + p.failed}/${p.total} (${p.failed} failed${eta}) ${p.active[0] ?? ''}`;
  }
  const width = process.stderr.columns || 100;
  process.stderr.write(`\r${line.slice(0, width - 1).padEnd(width - 1)}`);
});

process.on('SIGINT', () => {
  if (engine.busy) {
    process.stderr.write('\nCancelling…\n');
    engine.cancel();
  } else process.exit(130);
});

try {
  const result = command === 'scan' ? await engine.scan(opts) : await engine.convert(opts);
  if (tty) process.stderr.write('\n');
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printSummary(result);
  process.exit(result.failures?.length ? 2 : 0);
} catch (err) {
  if (tty) process.stderr.write('\n');
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}

function printSummary(r) {
  const c = r.counts;
  const lines = [
    `Input:   ${r.inputRoot}`,
    `Output:  ${r.outputRoot}`,
    `ffmpeg:  ${r.ffmpeg.error ?? `${r.ffmpeg.version}${r.ffmpeg.soxr ? ' (soxr)' : ''}`}`,
    '',
    `Library: ${c.audio} audio files in ${c.folders} folders`,
    `To convert (${r.formats.join(', ')}): ${c.selected}  |  up to date: ${c.upToDate}  |  pending: ${c.pending}${c.resample ? ` (${c.resample} resampled)` : ''}`,
    `Already CDJ-playable (skipped): ${c.compatible}   Unsupported: ${c.unsupported}   Unreadable: ${c.unreadable}`,
  ];
  if (c.missing) lines.push(`Removed from library since conversion: ${c.missing} (outputs kept)`);
  if (r.estimate.bytes) lines.push(`Estimated output for pending: ${(r.estimate.bytes / 1024 ** 3).toFixed(2)} GB (free: ${r.estimate.freeBytes == null ? '?' : (r.estimate.freeBytes / 1024 ** 3).toFixed(1) + ' GB'})`);
  if (r.lastRun) {
    const lr = r.lastRun;
    lines.push(`Last run: ${new Date(lr.finishedAt).toLocaleString()} — converted ${lr.converted}, failed ${lr.failed}${lr.cancelled ? ' (cancelled)' : ''} in ${fmtDuration(lr.durationMs)}`);
  }
  for (const w of r.warnings) {
    lines.push('', `⚠ ${w.message}`);
    for (const ex of w.examples.slice(0, 5)) lines.push(`   · ${ex}`);
    if (w.count > 5) lines.push(`   · … ${w.count - 5} more`);
  }
  if (r.failures?.length) {
    lines.push('', `✗ ${r.failures.length} failed:`);
    for (const f of r.failures.slice(0, 20)) lines.push(`   · ${f.key}\n     ${f.message.split('\n').join('\n     ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
