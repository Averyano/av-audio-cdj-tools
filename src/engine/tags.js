// music-metadata tags → ID3v2.3 frames (encoded by id3.js).
//
// ffmpeg would store BPM/key as TXXX:BPM / TXXX:INITIALKEY and comments as
// TXXX, all of which rekordbox ignores, so the mapping is explicit here.

const MAX_VALUE = 2000;

const join = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v);
const first = (v) => (Array.isArray(v) ? v.find(Boolean) : v);

function numberPair(obj) {
  if (!obj?.no) return undefined;
  return obj.of ? `${obj.no}/${obj.of}` : String(obj.no);
}

function year(common) {
  const m = String(common.date ?? common.year ?? '').match(/^\d{4}/);
  return m ? m[0] : undefined;
}

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\u0000/g, '').trim();
  if (!s) return undefined;
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s;
}

// Vorbis names music-metadata doesn't fold into `common` (Traktor, Mixed In Key, Beatport). In an
// .m4a they're iTunes freeform atoms with the same name, e.g. "----:com.apple.iTunes:initialkey".
const FREEFORM = /^----:com\.apple\.itunes:/i;
function nativeValue(native, ids) {
  for (const tags of Object.values(native ?? {})) {
    for (const t of tags) {
      if (!ids.includes(String(t.id).replace(FREEFORM, '').toUpperCase())) continue;
      const v = typeof t.value === 'object' && t.value !== null ? t.value.text : t.value;
      if (v) return String(v);
    }
  }
  return undefined;
}

/** Returns [[frameId, value], …]; 'COMM' → comment, non-T ids → TXXX. */
export function buildTagPairs(common = {}, native = {}) {
  const pairs = [
    ['TIT2', common.title],
    ['TPE1', common.artist ?? join(common.artists)],
    ['TALB', common.album],
    ['TPE2', common.albumartist],
    ['TCON', join(common.genre)],
    ['TYER', year(common)],
    ['TRCK', numberPair(common.track)],
    ['TPOS', numberPair(common.disk)],
    ['TBPM', common.bpm ? String(Math.round(common.bpm)) : undefined],
    ['TKEY', common.key ?? nativeValue(native, ['INITIALKEY', 'INITIAL KEY'])],
    ['TPUB', join(common.label)],
    ['TCOM', join(common.composer)],
    ['TSRC', first(common.isrc)],
    ['TPE4', join(common.remixer) || nativeValue(native, ['MIXARTIST'])],
    ['TIT3', join(common.subtitle)],
    ['TIT1', common.grouping],
    ['TCOP', common.copyright],
    ['COMM', first(common.comment?.map((c) => c?.text))],
    ['CATALOGNUMBER', first(common.catalognumber)], // → TXXX:CATALOGNUMBER
  ];
  return pairs
    .map(([k, v]) => [k, clean(v)])
    .filter(([, v]) => v !== undefined);
}

/** Front cover if tagged as such, otherwise the first picture. */
export function pickCover(common = {}) {
  const pics = common.picture ?? [];
  return pics.find((p) => /front/i.test(p.type ?? '')) ?? pics[0] ?? null;
}
