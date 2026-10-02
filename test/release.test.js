import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, parseNotes, readRelease, timeAgo, MAX_NOTES } from '../src/engine/release.js';

test('versions compare in semver order, with or without the v', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { parts: [1, 2, 3], pre: '' });
  assert.equal(parseVersion('latest'), null);
  assert.equal(compareVersions('0.1.0', 'v0.2.0'), -1);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1, 'numeric, not string order');
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1, 'a pre-release comes before its release');
  assert.equal(compareVersions('nonsense', '0.1.0'), 0, 'unreadable never counts as newer');
});

test('release notes: bullets as plain text, boilerplate after --- dropped', () => {
  const body = [
    '## What\'s new',
    '- Removed **Songstats**',
    '* Fixed [Amazon Music](https://example.com) fetching',
    '+ Added `Add to Queue`',
    '1. Renamed file_name_x _properly_',
    '* Fix crash by @someone in https://github.com/o/r/pull/3',
    '',
    '---',
    '**First launch.** Installers are unsigned …',
    '- not a note',
  ].join('\r\n');
  assert.deepEqual(parseNotes(body), {
    items: ['Removed Songstats', 'Fixed Amazon Music fetching', 'Added Add to Queue', 'Renamed file_name_x properly', 'Fix crash'],
    more: 0,
  });
  // No bullets: the plain lines, headings left out
  assert.deepEqual(parseNotes('# v0.2.0\nFaster scans.\n\nNew wheel.').items, ['Faster scans.', 'New wheel.']);
  const many = parseNotes(Array.from({ length: 15 }, (_, i) => `- n${i}`).join('\n'));
  assert.equal(many.items.length, MAX_NOTES);
  assert.equal(many.more, 3);
  assert.deepEqual(parseNotes(null), { items: [], more: 0 });
  assert.deepEqual(parseNotes('<script>x</script>- <b>bold</b>').items, ['x- bold'], 'tags never survive');
});

test('readRelease takes what the app needs from GitHub\'s answer', () => {
  const r = readRelease({ tag_name: 'v1.1.0', name: 'AudioConverter v1.1.0', published_at: '2026-10-01T10:00:00Z', body: '- One', draft: false, html_url: 'https://evil.example' });
  assert.deepEqual(r, { version: '1.1.0', name: 'AudioConverter v1.1.0', publishedAt: '2026-10-01T10:00:00.000Z', notes: { items: ['One'], more: 0 } });
  assert.equal(readRelease({ message: 'Not Found' }), null);
  assert.equal(readRelease({ tag_name: 'v0.2.0', draft: true }), null);
  assert.equal(readRelease(null), null);
  assert.equal(readRelease({ tag_name: 'v0.3.0' }).publishedAt, null);
});

test('timeAgo: the largest unit plus the next one', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const ago = (ms) => timeAgo(now - ms, now);
  const m = 60e3, h = 60 * m, d = 24 * h;
  assert.equal(ago(20e3), 'just now');
  assert.equal(ago(m), '1 minute ago');
  assert.equal(ago(2 * h + 5 * m), '2 hours 5 minutes ago');
  assert.equal(ago(3 * d + 21 * h + 59 * m), '3 days 21 hours ago');
  assert.equal(ago(3 * d), '3 days ago', 'a zero second unit is left out');
  assert.equal(ago(9 * d), '1 week 2 days ago');
  assert.equal(ago(45 * d), '1 month 2 weeks ago');
  assert.equal(ago(400 * d), '1 year 1 month ago');
  assert.equal(ago(800 * d), '2 years 2 months ago');
  assert.equal(timeAgo(now + h, now), 'just now', 'a clock that runs behind never says "in the future"');
  assert.equal(timeAgo('2026-10-02T09:30:00Z', now), '2 hours 30 minutes ago', 'ISO strings work');
});
