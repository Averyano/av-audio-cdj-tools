import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREF_SECTIONS, PREF_DEFAULTS, sanitizePrefs } from '../src/engine/prefs.js';

test('prefs: defaults come from the schema', () => {
  assert.deepEqual(PREF_DEFAULTS, { analyzer: { checkHiRes: false, spectrogramColors: 'color' }, camelot: { autoApplyListen: false } });
  assert.deepEqual(PREF_SECTIONS.map((s) => s.title), ['Audio Analyzer', 'Camelot Wheel']);
  for (const s of PREF_SECTIONS) for (const p of s.prefs) assert.ok(p.label && p.type && 'default' in p, `${s.id}.${p.key} is complete`);
});

test('prefs: sanitize keeps valid values and drops the rest', () => {
  assert.deepEqual(sanitizePrefs({ camelot: { autoApplyListen: true }, analyzer: { checkHiRes: true, spectrogramColors: 'grayscale' } }),
    { analyzer: { checkHiRes: true, spectrogramColors: 'grayscale' }, camelot: { autoApplyListen: true } });
  assert.equal(sanitizePrefs({ analyzer: { spectrogramColors: 'rainbow' } }).analyzer.spectrogramColors, 'color', 'unknown choice → default');
  for (const s of PREF_SECTIONS) for (const p of s.prefs.filter((q) => q.type === 'choice')) assert.ok(p.options.some((o) => o.value === p.default), `${p.key} default is an option`);
  assert.deepEqual(sanitizePrefs({ camelot: { autoApplyListen: 'yes', extra: 1 }, other: {} }), PREF_DEFAULTS);
  for (const bad of [undefined, null, 7, 'x', [], { camelot: [] }, { camelot: null }, JSON.parse('{"__proto__": {"camelot": {"autoApplyListen": true}}}')]) {
    assert.deepEqual(sanitizePrefs(bad), PREF_DEFAULTS, JSON.stringify(bad));
  }
});
