import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGES, rootPc, step, shiftSemitones, pctForSemitones, snapPct, pitchShift, semitoneLandings,
  compatibleKeys, mixingChart, tuning, sanitizeDeck, keyId, parseKeyId, shortName, longName, DECK_DEFAULTS, keyFromPitch,
  mixRelation, pitchTo, PITCH_TO_MAX,
} from '../src/engine/camelot.js';

const shift = (key, pct, masterTempo = false) => pitchShift({ ...parseKeyId(key), pct, masterTempo });
const near = (actual, expected, eps, msg) => assert.ok(Math.abs(actual - expected) < eps, `${msg}: ${actual} ≉ ${expected}`);

test('camelot: semitones, nearest and cents (handoff §7)', () => {
  const vectors = [
    [6, 1.009, 1, 0.9],
    [-6, -1.071, -1, -7.1],
    [3, 0.512, 1, -48.8],
    [8, 1.332, 1, 33.2],
    [16, 2.569, 3, -43.1],
    [2, 0.343, 0, 34.3],
    [100, 12, 12, 0],
    [-50, -12, -12, 0],
  ];
  for (const [pct, st, nearest, cents] of vectors) {
    const s = shift('1A', pct);
    near(s.semitones, st, 0.0005, `semitones at ${pct}%`);
    assert.equal(s.nearest, nearest, `nearest at ${pct}%`);
    near(s.cents, cents, 0.05, `cents at ${pct}%`);
  }
});

test('camelot: exact semitone landings', () => {
  const expected = { '-3': -15.91, '-2': -10.91, '-1': -5.61, 1: 5.95, 2: 12.25, 3: 18.92 };
  for (const [k, pct] of Object.entries(expected)) near(pctForSemitones(Number(k)), pct, 0.005, `k=${k}`);
  assert.deepEqual(semitoneLandings(6).map((l) => l.k), [-1, 0, 1]);
  assert.deepEqual(semitoneLandings(16).map((l) => l.k), [-3, -2, -1, 0, 1, 2]);
  const wide = semitoneLandings(100).map((l) => l.k);
  assert.equal(wide[0], -12);
  assert.equal(wide.at(-1), 12);
});

test('camelot: resulting keys and BPM', () => {
  const s = shift('1A', 6);
  assert.equal(keyId(s.result), '8A');
  assert.equal(longName(parseKeyId('1A')), 'A♭ minor');
  assert.equal(longName(s.result), 'A minor');
  assert.equal((124 * s.ratio).toFixed(1), '131.4');
  assert.equal(keyId(shift('1A', -6).result), '6A');
  assert.equal(keyId(shift('1A', 12.25).result), '3A');
  assert.equal(keyId(shift('1A', -10.91).result), '11A');
  assert.equal(keyId(shift('5B', 6).result), '12B', 'letter never changes');
});

test('camelot: root pitch classes and wheel moves', () => {
  assert.equal(rootPc(parseKeyId('8A')), 9);
  assert.equal(rootPc(parseKeyId('8B')), 0);
  assert.equal(rootPc(parseKeyId('1A')), 8);
  assert.equal(rootPc(parseKeyId('1B')), 11);
  assert.equal(step(12, 1), 1);
  assert.equal(step(1, -1), 12);
  assert.equal(shiftSemitones(1, 1), 8);
  assert.equal(shiftSemitones(1, -1), 6);
  assert.equal(shiftSemitones(1, 12), 1);
  assert.equal(shift('1A', 6).wheelSteps, 7);
  for (const mode of ['A', 'B']) for (let n = 1; n <= 12; n++) assert.deepEqual(keyFromPitch(rootPc({ n, mode }), mode), { n, mode });
  assert.equal(keyId(keyFromPitch(9, 'A')), '8A');
  assert.equal(keyId(keyFromPitch(0, 'B')), '8B');
});

test('camelot: Master Tempo and stopped platter', () => {
  const locked = shift('8A', 6, true);
  assert.equal(locked.semitones, 0);
  assert.equal(keyId(locked.result), '8A');
  const stopped = shift('8A', -100);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.result, null);
  assert.equal(stopped.cents, null);
  assert.equal(tuning(parseKeyId('8A'), stopped, false).tone, 'bad');
  assert.equal(tuning(parseKeyId('8A'), shift('8A', -100, true), true).tone, 'info');
});

test('camelot: tuning verdicts', () => {
  const v = (key, pct) => tuning(parseKeyId(key), shift(key, pct), false);
  assert.deepEqual(v('1A', 6), { tone: 'ok', text: 'Lands in 8A, 1 cent sharp.' });
  assert.deepEqual(v('1A', 0), { tone: 'ok', text: 'Still in 1A. No pitch change.' });
  assert.equal(v('1A', 8).tone, 'bad');
  assert.equal(v('1A', 8).text, 'Between 8A and 3A. 33 cents off, so it will clash with both.');
  assert.equal(v('1A', 3).text, 'Between 8A and 1A. 49 cents off, so it will clash with both.');
  assert.equal(v('1A', -1).tone, 'warn'); // −17.4 cents
  assert.match(v('1A', -1).text, /^Closest to 1A, but 17 cents flat/);
});

test('camelot: standard compatible keys', () => {
  assert.deepEqual(compatibleKeys(parseKeyId('8A')).map((c) => keyId(c.key)), ['8A', '7A', '9A', '8B']);
  assert.deepEqual(compatibleKeys(parseKeyId('1B')).map((c) => keyId(c.key)), ['1B', '12B', '2B', '1A']);
});

test("camelot: the user's mixing chart (handoff §7)", () => {
  const chart = (id) => mixingChart(parseKeyId(id)).map((row) => row.keys.map((k) => keyId(k.key)));
  assert.deepEqual(chart('8A'), [['8A', '7B'], ['8B', '9A'], ['10A', '3A'], ['7A'], ['6A', '1A'], ['11B']]);
  assert.deepEqual(chart('1A'), [['1A', '12B'], ['1B', '2A'], ['3A', '8A'], ['12A'], ['11A', '6A'], ['4B']]);
  assert.deepEqual(chart('1B'), [['1B', '2A'], ['2B'], ['3B', '8B'], ['1A', '12B'], ['11B', '6B'], ['10A']]);
  assert.deepEqual(chart('12B'), [['12B', '1A'], ['1B'], ['2B', '7B'], ['12A', '11B'], ['10B', '5B'], ['9A']]);
  const boost = mixingChart(parseKeyId('8A'))[2].keys;
  assert.deepEqual(boost.map((k) => k.semitones), [2, 1]);
  assert.equal(mixingChart(parseKeyId('8A'))[0].keys[0].semitones, undefined);
});

test('camelot: fader snapping', () => {
  assert.equal(snapPct(5.951, 10), 5.95);
  assert.equal(snapPct(6.01, 6), 6);
  assert.equal(snapPct(-20, 16), -16);
  assert.equal(snapPct(5.95, 100), 6);
  assert.equal(snapPct('abc', 6), 0);
  for (const r of Object.keys(RANGES)) assert.equal(snapPct(0, r), 0);
});

test('camelot: names and key ids', () => {
  assert.equal(shortName(parseKeyId('11A')), 'F♯m');
  assert.equal(shortName(parseKeyId('8B')), 'C');
  assert.equal(parseKeyId('13A'), null);
  assert.equal(parseKeyId('0B'), null);
  assert.equal(parseKeyId('8C'), null);
});

test('camelot: sanitizeDeck', () => {
  assert.deepEqual(sanitizeDeck(undefined), DECK_DEFAULTS);
  assert.deepEqual(sanitizeDeck({ n: 13, mode: 'C', range: '__proto__', pct: 'x', bpm: -5, masterTempo: 'yes' }), DECK_DEFAULTS);
  assert.deepEqual(sanitizeDeck({ n: 8, mode: 'B', range: 6, pct: 9, bpm: 999, masterTempo: true }),
    { n: 8, mode: 'B', range: 6, pct: 6, bpm: 300, masterTempo: true, target: null });
  assert.equal(sanitizeDeck({ range: '16', pct: 5.951 }).pct, 5.95);
  assert.deepEqual(sanitizeDeck({ target: { n: 1, mode: 'B' } }).target, { n: 1, mode: 'B' });
  for (const bad of [{ n: 0, mode: 'B' }, { n: 3, mode: 'C' }, '1B', []]) assert.equal(sanitizeDeck({ target: bad }).target, null);
});

test('camelot: a target key, relative to where the track is', () => {
  const k = parseKeyId;
  assert.deepEqual(mixRelation(k('2B'), k('1B')), { name: 'Energy drop', sym: '−', hint: 'Gentle drop' }); // the user's example
  assert.deepEqual(mixRelation(k('2B'), k('9B')), { name: 'Energy boost', sym: '++', hint: 'Big lift', semitones: 1 });
  assert.equal(mixRelation(k('8A'), k('8A')).name, 'Perfect match');
  assert.equal(mixRelation(k('2B'), k('7A')), null, 'clashes');
  // 2B → 9B is one semitone up: +5.95 % (in ±10); the way down (−11 st, −47 %) isn't offered
  const up = pitchTo(k('2B'), k('9B'), 10);
  assert.deepEqual(up.options.map((o) => [o.semitones, o.inRange]), [[1, true]]);
  assert.ok(Math.abs(up.options[0].pct - 5.946) < 0.01);
  // 2B → 4B is +2 st, +12.25 %: needs ±16, still offered
  assert.deepEqual(pitchTo(k('2B'), k('4B'), 10).options.map((o) => [o.semitones, o.inRange]), [[2, false]]);
  // 2B → 1B is −7 or +5 semitones (−33.3 % / +33.5 %): only WIDE reaches it, so nothing is offered
  const far = pitchTo(k('2B'), k('1B'), 100);
  assert.deepEqual(far.options, []);
  assert.equal(far.away, -7, 'the nearer one, by tempo');
  // 2B → 3B is −5 or +7 (−25 % / +50 %), the user's example
  assert.deepEqual(pitchTo(k('2B'), k('3B'), 10).options, []);
  assert.equal(PITCH_TO_MAX, 16);
  assert.deepEqual(pitchTo(k('2B'), k('2A'), 10), { sameLetter: false, options: [] });
  assert.deepEqual(pitchTo(k('2B'), k('2B'), 10).options.map((o) => o.semitones), [0], 'the octave down (−50 %) is too far');
});
