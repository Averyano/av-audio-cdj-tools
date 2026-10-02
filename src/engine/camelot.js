// Camelot pitch shift: which key a track lands in when the CDJ tempo fader moves with
// Master Tempo (key lock) off. Pure functions and constants with no imports at all, so the
// renderer can import this file directly as well as main and the tests (camelot.md).
//
// A key is { n: 1..12, mode: 'A' | 'B' }. A = minor, B = major (rekordbox "alphanumeric").

const NAMES = {
  A: {
    short: ['A♭m', 'E♭m', 'B♭m', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F♯m', 'D♭m'],
    long: ['A♭ minor', 'E♭ minor', 'B♭ minor', 'F minor', 'C minor', 'G minor', 'D minor', 'A minor', 'E minor', 'B minor', 'F♯ minor', 'D♭ minor'],
  },
  B: {
    short: ['B', 'F♯', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E'],
    long: ['B major', 'F♯ major', 'D♭ major', 'A♭ major', 'E♭ major', 'B♭ major', 'F major', 'C major', 'G major', 'D major', 'A major', 'E major'],
  },
};

// Pitch classes, C = 0 … B = 11.
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

// CDJ-2000NXS operating instructions, "Adjusting the playing speed": units of adjustment
// per range. WIDE is ±100 %; at −100 % playback stops. The deck powers on at ±10.
export const RANGES = {
  6: { max: 6, step: 0.02, label: '±6' },
  10: { max: 10, step: 0.05, label: '±10' },
  16: { max: 16, step: 0.05, label: '±16' },
  100: { max: 100, step: 0.5, label: 'WIDE' },
};

export const BPM_MIN = 20;
export const BPM_MAX = 300;

// What the Camelot view shows first; also the settings default (desktop-app.md → Settings).
// target: the key the user is heading for (clicked on the wheel or a suggestion), or null.
export const DECK_DEFAULTS = { n: 1, mode: 'A', range: 10, pct: 6, bpm: 124, masterTempo: false, target: null };

export const mod = (a, m) => ((a % m) + m) % m;
export const keyId = ({ n, mode }) => `${n}${mode}`;
export const shortName = ({ n, mode }) => NAMES[mode].short[n - 1];
export const longName = ({ n, mode }) => NAMES[mode].long[n - 1];
export const otherMode = (mode) => (mode === 'A' ? 'B' : 'A');

export function parseKeyId(id) {
  const m = /^(1[0-2]|[1-9])([AB])$/.exec(id);
  return m ? { n: Number(m[1]), mode: m[2] } : null;
}

// Root pitch class: 1A = A♭ minor (8), 8A = A minor (9), 1B = B major (11), 8B = C major (0).
export const rootPc = ({ n, mode }) => mod((mode === 'A' ? 8 : 11) + 7 * (n - 1), 12);

// The inverse of rootPc: the Camelot key whose root is pitch class pc (C = 0) in that mode.
// 7 is its own inverse mod 12, so n − 1 = 7·(pc − root of n = 1).
export const keyFromPitch = (pc, mode) => ({ n: mod(7 * (pc - (mode === 'A' ? 8 : 11)), 12) + 1, mode });

// Move d positions around the wheel (wraps to 1..12).
export const step = (n, d) => mod(n - 1 + d, 12) + 1;

// One semitone up = 7 positions clockwise. The letter never changes when pitching.
export const shiftSemitones = (n, semitones) => mod(n - 1 + 7 * semitones, 12) + 1;

// Fader % that moves the pitch by exactly k semitones.
export const pctForSemitones = (k) => (2 ** (k / 12) - 1) * 100;

// Clamp to the range and snap to its step; rounded to 2 decimals so 5.95 doesn't become 5.9500000001.
export function snapPct(pct, range) {
  const { max, step: unit } = RANGES[range];
  const v = Math.max(-max, Math.min(max, Number(pct) || 0));
  return Math.round(Math.round(v / unit) * unit * 100) / 100;
}

/**
 * What a tempo change does to a key.
 * - semitones: pitch change (0 with Master Tempo on; null when the platter is stopped)
 * - nearest / cents: the whole-semitone shift it's closest to, and how far off (−50…+50)
 * - result: the key it lands in (null when stopped)
 * - wheelSteps: clockwise positions from the original key, 0..11
 */
export function pitchShift({ n, mode, pct, masterTempo }) {
  const ratio = 1 + pct / 100;
  const stopped = ratio <= 0;
  const raw = stopped ? null : 12 * Math.log2(ratio);
  const semitones = masterTempo ? 0 : raw;
  const nearest = semitones === null ? null : Math.round(semitones);
  const cents = nearest === null ? null : (semitones - nearest) * 100;
  return {
    ratio,
    stopped,
    raw,
    semitones,
    nearest,
    cents,
    result: nearest === null ? null : { n: shiftSemitones(n, nearest), mode },
    wheelSteps: nearest === null ? null : mod(7 * nearest, 12),
  };
}

// Every whole-semitone landing inside a range, −12…+12.
export function semitoneLandings(range) {
  const { max } = RANGES[range];
  const out = [];
  for (let k = -12; k <= 12; k++) {
    const pct = pctForSemitones(k);
    if (Math.abs(pct) <= max + 1e-9) out.push({ k, pct });
  }
  return out;
}

// Standard Camelot rules: same key, ±1 on the wheel, and the relative major/minor.
export function compatibleKeys({ n, mode }) {
  return [
    { key: { n, mode }, why: 'same' },
    { key: { n: step(n, -1), mode }, why: '−1' },
    { key: { n: step(n, 1), mode }, why: '+1' },
    { key: { n, mode: otherMode(mode) }, why: mode === 'A' ? 'major' : 'minor' },
  ];
}

// The user's own mixing chart (decision D22). It deliberately differs from standard Camelot:
// "perfect match" uses the diagonal (1A ↔ 12B). Entries with `semitones` change the key.
export function mixingChart({ n, mode }) {
  const k = (d, m, semitones) => ({ key: { n: step(n, d), mode: m }, ...(semitones && { semitones }) });
  return mode === 'A'
    ? [
        { name: 'Perfect match', sym: '', hint: 'Same feel', keys: [k(0, 'A'), k(-1, 'B')] },
        { name: 'Energy boost', sym: '+', hint: 'Gentle lift', keys: [k(0, 'B'), k(1, 'A')] },
        { name: 'Energy boost', sym: '++', hint: 'Big lift', keys: [k(2, 'A', 2), k(7, 'A', 1)] },
        { name: 'Energy drop', sym: '−', hint: 'Gentle drop', keys: [k(-1, 'A')] },
        { name: 'Energy drop', sym: '−−', hint: 'Big drop', keys: [k(-2, 'A', -2), k(-7, 'A', -1)] },
        { name: 'Mood change', sym: '', hint: 'Minor to major', keys: [k(3, 'B')] },
      ]
    : [
        { name: 'Perfect match', sym: '', hint: 'Same feel', keys: [k(0, 'B'), k(1, 'A')] },
        { name: 'Energy boost', sym: '+', hint: 'Gentle lift', keys: [k(1, 'B')] },
        { name: 'Energy boost', sym: '++', hint: 'Big lift', keys: [k(2, 'B', 2), k(7, 'B', 1)] },
        { name: 'Energy drop', sym: '−', hint: 'Gentle drop', keys: [k(0, 'A'), k(-1, 'B')] },
        { name: 'Energy drop', sym: '−−', hint: 'Big drop', keys: [k(-2, 'B', -2), k(-7, 'B', -1)] },
        { name: 'Mood change', sym: '', hint: 'Major to minor', keys: [k(-3, 'A')] },
      ];
}

const sameKey = (a, b) => a.n === b.n && a.mode === b.mode;

/**
 * How `to` relates to `from` for mixing: the user's chart row if it lists `to`, else the
 * standard Camelot rule, else null (they clash). { name, sym, hint, semitones? }
 */
export function mixRelation(from, to) {
  for (const row of mixingChart(from)) {
    const hit = row.keys.find((k) => sameKey(k.key, to));
    if (hit) return { name: row.name, sym: row.sym, hint: row.hint, ...(hit.semitones && { semitones: hit.semitones }) };
  }
  const std = compatibleKeys(from).find((c) => sameKey(c.key, to));
  return std ? { name: 'Compatible', sym: '', hint: `standard Camelot: ${std.why}` } : null;
}

// "Pitch the track there" stops at ±16 %: only WIDE goes further, and nobody plays a track at
// −25 % or +50 %. That's ±2 semitones (±12.2 %); 3 semitones already needs ±18.9 %.
export const PITCH_TO_MAX = RANGES[16].max;

/**
 * Fader settings that pitch a track in `from` exactly into `to`, nearest first. Pitching keeps
 * the letter, so a different letter gives no options. The two candidates are k and k − 12
 * semitones (one up, one down); only those within ±PITCH_TO_MAX are offered. inRange says
 * whether the current range's fader reaches one. `away` is the nearer candidate's semitones,
 * for saying how far a target is when none is offered.
 */
export function pitchTo(from, to, range) {
  if (from.mode !== to.mode) return { sameLetter: false, options: [] };
  const up = mod(7 * (to.n - from.n), 12); // +1 semitone = +7 on the wheel, and 7 is its own inverse mod 12
  const candidates = [...new Set([up, up - 12])]
    .map((k) => ({ semitones: k, pct: pctForSemitones(k), inRange: Math.abs(pctForSemitones(k)) <= RANGES[range].max + 1e-9 }))
    .sort((a, b) => Math.abs(a.pct) - Math.abs(b.pct));
  const options = candidates.filter((o) => Math.abs(o.pct) <= PITCH_TO_MAX + 1e-9);
  return { sameLetter: true, away: candidates[0].semitones, options };
}

const centsText = (c) => `${c} cent${c === 1 ? '' : 's'}`;

/**
 * How in tune the pitched track is. tone: 'ok' (≤ 10 cents) · 'warn' (10–25) · 'bad' (> 25, or
 * stopped) · 'info' (Master Tempo on). `key` is the original key, `shift` a pitchShift() result.
 */
export function tuning(key, shift, masterTempo) {
  const from = keyId(key);
  if (masterTempo) return { tone: 'info', text: `Master Tempo is on, so the key stays ${from} at any tempo. Turn it off to see the key move.` };
  if (shift.stopped) return { tone: 'bad', text: 'At −100% the track stops.' };
  const to = keyId(shift.result);
  const ac = Math.abs(shift.cents);
  const c = Math.round(ac);
  const dir = shift.cents > 0 ? 'sharp' : 'flat';
  if (ac <= 10) {
    if (shift.nearest === 0) return { tone: 'ok', text: `Still in ${from}. ${ac < 0.5 ? 'No pitch change.' : `Only ${centsText(c)} ${dir}.`}` };
    return { tone: 'ok', text: `Lands in ${to}, ${ac < 0.5 ? 'right on pitch' : `${centsText(c)} ${dir}`}.` };
  }
  if (ac <= 25) return { tone: 'warn', text: `Closest to ${to}, but ${centsText(c)} ${dir}. Slightly out of tune.` };
  const other = keyId({ n: shiftSemitones(key.n, shift.nearest + (shift.cents > 0 ? 1 : -1)), mode: key.mode });
  return { tone: 'bad', text: `Between ${to} and ${other}. ${centsText(c)} off, so it will clash with both.` };
}

// Settings shape for the deck. Anything unknown or out of range falls back to the default.
export function sanitizeDeck(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const range = Object.hasOwn(RANGES, d.range) ? Number(d.range) : DECK_DEFAULTS.range;
  const bpm = Number(d.bpm);
  const t = d.target && typeof d.target === 'object' ? d.target : null;
  return {
    n: Number.isInteger(d.n) && d.n >= 1 && d.n <= 12 ? d.n : DECK_DEFAULTS.n,
    mode: d.mode === 'A' || d.mode === 'B' ? d.mode : DECK_DEFAULTS.mode,
    range,
    pct: snapPct(Number.isFinite(d.pct) ? d.pct : DECK_DEFAULTS.pct, range),
    bpm: Number.isFinite(bpm) && bpm > 0 ? Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 100) / 100)) : DECK_DEFAULTS.bpm,
    masterTempo: d.masterTempo === true,
    target: t && Number.isInteger(t.n) && t.n >= 1 && t.n <= 12 && (t.mode === 'A' || t.mode === 'B') ? { n: t.n, mode: t.mode } : null,
  };
}
