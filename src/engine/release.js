// Releases and update checks: version maths, release notes and "released … ago". No imports at
// all: main parses GitHub's answer with it, and the renderer loads it directly for the live
// "ago" text (desktop-app.md → Updates).

/** "v1.2.3" / "1.2.3-beta.1" → { parts: [1, 2, 3], pre: 'beta.1' }, or null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
}

/** −1, 0 or 1, semver order: a pre-release sorts before its release (0.2.0-beta < 0.2.0). */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre || !y.pre) return x.pre ? -1 : 1;
  return x.pre < y.pre ? -1 : 1;
}

// Inline markdown → plain text. The notes go into the page with textContent, never as HTML.
function plain(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(\S.*?\S|\S)\*/g, '$1')
    .replace(/(^|\W)_(\S.*?\S|\S)_(?=\W|$)/g, '$1$2') // _italic_, but not file_name_x
    .replace(/`([^`]+)`/g, '$1')
    .replace(/ by @[\w-]+ in https?:\/\/\S+$/, '') // GitHub's generated notes: "Fix x by @me in https://…/pull/3"
    .replace(/<[^>]+>/g, '')
    .trim();
}

export const MAX_NOTES = 12;

/**
 * A release body (markdown) → up to MAX_NOTES plain-text lines for the update dialog, plus how
 * many were left out. Bullets (-, *, +, 1.) are the notes; without any, the plain lines are.
 * Headings, rules and the download/install boilerplate after a "---" line are dropped.
 */
export function parseNotes(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const end = lines.findIndex((l) => /^\s*(---+|\*\*\*+)\s*$/.test(l));
  const kept = (end === -1 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean);
  const bullets = kept.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*+]|\d+[.)])\s+/, ''));
  const items = (bullets.length ? bullets : kept.filter((l) => !/^#/.test(l))).map(plain).filter(Boolean);
  return { items: items.slice(0, MAX_NOTES), more: Math.max(0, items.length - MAX_NOTES) };
}

/**
 * GitHub's GET /repos/{owner}/{repo}/releases/latest → what the app needs, or null when the
 * answer isn't a usable release. The page link is not taken from here (main opens a fixed URL).
 */
export function readRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || !parseVersion(json.tag_name)) return null;
  const published = Date.parse(json.published_at ?? '');
  return {
    version: json.tag_name.replace(/^v/, ''),
    name: typeof json.name === 'string' ? json.name.slice(0, 200) : '',
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
    notes: parseNotes(typeof json.body === 'string' ? json.body.slice(0, 20000) : ''),
  };
}

// Calendar months and years vary; these averages are close enough for "released … ago".
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const UNITS = [
  ['year', 365.25 * DAY], ['month', (365.25 / 12) * DAY], ['week', 7 * DAY], ['day', DAY], ['hour', HOUR], ['minute', MIN],
];

/**
 * "3 days 21 hours ago": the largest unit that fits, plus the next smaller one when it isn't 0
 * ("1 month 2 weeks", "2 hours 5 minutes", "1 year"). Under a minute: "just now".
 */
export function timeAgo(then, now = Date.now()) {
  let ms = Math.max(0, now - new Date(then).getTime());
  if (!Number.isFinite(ms)) return '';
  const i = UNITS.findIndex(([, size]) => ms >= size);
  if (i === -1) return 'just now';
  const part = ([name, size]) => {
    const n = Math.floor(ms / size);
    ms -= n * size;
    return n ? `${n} ${name}${n === 1 ? '' : 's'}` : '';
  };
  return `${[part(UNITS[i]), UNITS[i + 1] ? part(UNITS[i + 1]) : ''].filter(Boolean).join(' ')} ago`;
}
