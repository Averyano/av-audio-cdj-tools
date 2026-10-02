import { SOURCE_FORMATS, CDJ_PROFILE, OUTPUT_EXT } from './constants.js';
import { outputRelFor } from './names.js';

/** Source format of a file, or null. A format with a `codec` rule needs the probe (.m4a: ALAC, not AAC). */
export function formatIdFor(ext, probe) {
  for (const f of Object.values(SOURCE_FORMATS)) {
    if (f.exts.includes(ext) && (!f.codec || f.codec.test(probe?.codec ?? ''))) return f.id;
  }
  return null;
}

const okRate = (p) => CDJ_PROFILE.sampleRates.includes(p?.sampleRate);
const okBits = (p) => CDJ_PROFILE.bitDepths.includes(p?.bits);

/** Can the CDJ play this file as-is? Used for formats the user did not tick. */
export function isCompatible(ext, probe) {
  switch (ext) {
    case '.mp3':
      return true;
    case '.m4a': case '.aac': case '.mp4':
      return !!probe && /aac/i.test(probe.codec ?? '') && !/alac/i.test(probe.codec ?? '');
    case '.aif': case '.aiff':
      return !!probe && probe.container === 'AIFF' && okRate(probe) && okBits(probe);
    case '.wav': case '.wave':
      // WAVE_FORMAT_EXTENSIBLE shows up as "non-PCM (65534)" and fails on NXS1.
      return !!probe && probe.codec === 'PCM' && okRate(probe) && okBits(probe);
    default:
      return false;
  }
}

/**
 * Output spec for a source. Family-aware resampling: 88.2/176.4k → 44.1k,
 * 96/192k → 48k (integer ratios). ≤16-bit stays 16, anything deeper → 24.
 */
export function targetSpec(probe) {
  const src = probe.sampleRate;
  const sampleRate = CDJ_PROFILE.sampleRates.includes(src) ? src : (src % 11025 === 0 ? 44100 : 48000);
  const bits = probe.bits && probe.bits <= 16 ? 16 : 24;
  const srcChannels = probe.channels || 2;
  return {
    sampleRate,
    bits,
    channels: Math.min(srcChannels, 2),
    resample: sampleRate !== src,
    downmix: srcChannels > 2,
  };
}

/**
 * Decides what to do with every walked file and assigns output paths.
 * `records` is the manifest's file map, used to keep previously assigned output
 * names stable when a new file would otherwise collide with them.
 */
export function buildPlan(files, { formats, safeNames, records = {} }) {
  const ticked = new Set(formats);
  const entries = files.map((f) => {
    const probe = records[f.key]?.probe ?? null;
    const formatId = formatIdFor(f.ext, probe);
    let action;
    if (records[f.key]?.probeError) action = formatId && ticked.has(formatId) ? 'unreadable' : 'unsupported';
    else if (formatId && ticked.has(formatId)) action = probe?.sampleRate ? 'convert' : 'unreadable';
    else action = isCompatible(f.ext, probe) ? 'compatible' : 'unsupported';
    return { ...f, formatId, probe, action, target: action === 'convert' ? targetSpec(probe) : null, outRel: null };
  });

  // Output names are claimed case-insensitively (APFS/NTFS/FAT32 default).
  const claimed = new Set();
  const convert = entries.filter((e) => e.action === 'convert');
  const natural = (e) => outputRelFor(e.key, OUTPUT_EXT, safeNames);

  // 1) Files that already own an output keep it.
  for (const e of convert) {
    const prev = records[e.key]?.done?.outRel;
    const nat = natural(e);
    const ownsPrev = prev && (prev === nat || prev.startsWith(`${nat.slice(0, -OUTPUT_EXT.length)} (`));
    if (ownsPrev && !claimed.has(prev.toLowerCase())) {
      e.outRel = prev;
      e.renamed = prev !== nat;
      claimed.add(prev.toLowerCase());
    }
  }
  // 2) Everyone else: natural name, else " (wav)", " (wav 2)", …
  const byPriority = convert
    .filter((e) => !e.outRel)
    .sort((a, b) => priority(a) - priority(b) || (a.key < b.key ? -1 : 1));
  for (const e of byPriority) {
    let candidate = natural(e);
    const tag = e.ext.slice(1);
    for (let n = 1; claimed.has(candidate.toLowerCase()); n++) {
      candidate = outputRelFor(e.key, OUTPUT_EXT, safeNames, n === 1 ? ` (${tag})` : ` (${tag} ${n})`);
    }
    e.outRel = candidate;
    e.renamed = candidate !== natural(e);
    claimed.add(candidate.toLowerCase());
  }
  return entries;
}

const FORMAT_ORDER = Object.keys(SOURCE_FORMATS);
function priority(e) {
  const i = FORMAT_ORDER.indexOf(e.formatId);
  return i === -1 ? FORMAT_ORDER.length : i;
}

export function folderDepth(rel) {
  return rel.split('/').length - 1;
}

export function estimateBytes(entry) {
  const { duration } = entry.probe ?? {};
  const t = entry.target;
  if (!duration || !t) return 0;
  return Math.round(duration * t.sampleRate * t.channels * (t.bits / 8)) + 64 * 1024;
}
