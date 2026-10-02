// Camelot wheel view: a CDJ deck (tempo fader, range, Master Tempo) and what its pitch does
// to the track's Camelot key. The maths lives in ../../engine/camelot.js; this file only
// builds and renders the DOM (camelot.md). Markup skeleton: index.html → [data-view="camelot"].

import {
  RANGES, BPM_MIN, BPM_MAX, NOTE_NAMES, BLACK_KEYS, mod, keyId, parseKeyId, shortName, longName,
  rootPc, shiftSemitones, snapPct, pitchShift, semitoneLandings, compatibleKeys, mixingChart, tuning, sanitizeDeck,
  mixRelation, pitchTo, pctForSemitones,
} from '../../engine/camelot.js';
import { $, el } from '../shared/js/dom.js';
import { keyColor } from './keys.js';

// Wheel geometry in viewBox units (−215…215): B outside, A inside, 12 at the top, clockwise.
const RING = { B: [142, 205], A: [80, 142] };
const HUB_R = 78;
const NS = 'http://www.w3.org/2000/svg';

let deck; // { n, mode, range, pct, bpm, masterTempo }: settings.camelot
let onChange; // app.js saves (debounced)
let pianoRoot = null; // root pitch class the ruler was built for
const segs = new Map(); // keyId → wheel <g>
const wheel = {}; // hub texts and arrow

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);
const fmtPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const parseNum = (s) => parseFloat(String(s).replace(',', '.')); // a Danish locale shows 6,00

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

// Point on a circle; 0° is 12 o'clock, clockwise.
const pt = (r, deg) => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];
function arc(r0, r1, a0, a1) {
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z`;
}

// ---------- state changes ----------

function changed() {
  render();
  onChange({ ...deck });
}
// A new track key starts from scratch: any target was relative to the old one.
function setKey({ n, mode }) {
  Object.assign(deck, { n, mode, target: null });
  changed();
}

// Clicking a suggestion makes it the target (clicking it again clears it): the track stays, and
// Result shows how it gets there (camelot.md → Target). The wheel sets the track key instead.
function setTarget(key) {
  deck.target = deck.target && keyId(deck.target) === keyId(key) ? null : { n: key.n, mode: key.mode };
  changed();
}

// "Pitch the track there": Master Tempo off, and the smallest range whose fader reaches it.
function pitchToTarget(pct) {
  const range = Math.abs(pct) <= RANGES[deck.range].max + 1e-9 ? deck.range
    : Number(Object.keys(RANGES).find((r) => RANGES[r].max + 1e-9 >= Math.abs(pct)));
  Object.assign(deck, { masterTempo: false, range });
  buildScales();
  setPct(pct);
}
function setPct(v) {
  deck.pct = snapPct(v, deck.range);
  changed();
}
// Listen's "Use as track": what was heard becomes the track, played at 0 %.
export function setTrack({ n, mode, bpm }) {
  if (n) Object.assign(deck, { n, mode, target: null });
  deck.pct = 0;
  if (bpm > 0) deck.bpm = clamp(Math.round(bpm * 100) / 100, BPM_MIN, BPM_MAX);
  changed();
}

function setRange(range) {
  deck.range = range;
  buildScales();
  setPct(deck.pct); // clamps and re-snaps to the new range
}

// ---------- build (once) ----------

function keyButton(key, sub, shift = false) {
  const isTarget = deck.target && keyId(deck.target) === keyId(key);
  const b = el('button', { type: 'button', className: `cam-key${shift ? ' shift' : ''}${isTarget ? ' target' : ''}`, title: `${longName(key)}. Click to ${isTarget ? 'clear the target' : 'set it as the target'}` },
    keyId(key), el('small', { textContent: sub }));
  b.style.background = keyColor(key);
  b.dataset.key = keyId(key);
  b.setAttribute('aria-label', `${keyId(key)}, ${longName(key)}${shift ? `, ${sub.replace('st', 'semitones')}` : ''}. ${isTarget ? 'Clear target' : 'Set as target'}`);
  b.setAttribute('aria-pressed', String(!!isTarget));
  b.addEventListener('click', () => setTarget(key));
  return b;
}

function buildWheel() {
  const root = $('#cam-wheel');
  root.append(svg('defs', {}, svg('marker', { id: 'cam-arrowhead', viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
    svg('path', { class: 'cam-arrowhead', d: 'M0,0 L10,5 L0,10 z' }))));
  for (let n = 1; n <= 12; n++) {
    for (const mode of ['B', 'A']) {
      const key = { n, mode };
      const c = (n % 12) * 30;
      const [r0, r1] = RING[mode];
      const [tx, ty] = pt((r0 + r1) / 2, c);
      const g = svg('g', { class: 'cam-seg', tabindex: 0, role: 'button', 'aria-label': `${keyId(key)}, ${longName(key)}. Set as track key` },
        svg('path', { d: arc(r0, r1, c - 15, c + 15), fill: keyColor(key) }),
        svg('text', { x: tx, y: ty - 1, 'text-anchor': 'middle', 'font-size': mode === 'B' ? 19 : 17 }, keyId(key)),
        svg('text', { class: 'sub', x: tx, y: ty + 13, 'text-anchor': 'middle' }, shortName(key)));
      g.addEventListener('click', () => setKey(key));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setKey(key);
        }
      });
      root.append(g);
      segs.set(keyId(key), g);
    }
  }
  // The arrow sits behind the hub so it reads as going around the centre.
  wheel.arrow = svg('path', { class: 'cam-arrow-path', 'marker-end': 'url(#cam-arrowhead)' });
  wheel.label = svg('text', { class: 'cam-hubtext small', y: -10 });
  wheel.key = svg('text', { class: 'cam-hubtext big', y: 24 });
  root.append(wheel.arrow, svg('circle', { class: 'cam-hub', r: HUB_R }), wheel.label, wheel.key);
}

// Fader scale labels, semitone marks and input limits for the current range.
function buildScales() {
  const { max, step } = RANGES[deck.range];
  const at = (v) => `top:${((v / max + 1) / 2) * 100}%`;
  $('#cam-scale-l').replaceChildren(...[-1, -0.5, 0, 0.5, 1].map((m) => {
    const v = m * max;
    return el('span', { textContent: v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`, style: at(v) });
  }));
  // On WIDE only every 3rd semitone, or the labels overlap.
  $('#cam-scale-r').replaceChildren(...semitoneLandings(deck.range)
    .filter(({ k }) => k !== 0 && (deck.range !== 100 || k % 3 === 0))
    .map(({ k, pct }) => el('span', { textContent: `${k > 0 ? '+' : '−'}${Math.abs(k)} st`, style: at(pct) })));
  $('#cam-ticks').replaceChildren(...Array.from({ length: 21 }, (_, i) => el('i', { style: `top:${i * 5}%` })));
  Object.assign($('#cam-pct'), { step, min: -max, max });
  $('#cam-fader').setAttribute('aria-valuemin', -max);
  $('#cam-fader').setAttribute('aria-valuemax', max);
}

// 25 chromatic cells, root −12 … root +12.
function buildPiano(root) {
  const cells = [];
  for (let k = -12; k <= 12; k++) {
    const pc = mod(root + k, 12);
    const cell = el('div', { className: `cam-pk${BLACK_KEYS.has(pc) ? ' black' : ''}${k === 0 ? ' root' : ''}` },
      el('span', { className: 'cam-pk-st', textContent: k % 3 === 0 ? (k > 0 ? `+${k}` : String(k)) : '' }), NOTE_NAMES[pc]);
    cells.push(cell);
  }
  $('#cam-piano').replaceChildren(...cells, el('div', { className: 'cam-omarker' }), el('div', { className: 'cam-pmarker', id: 'cam-pmarker' }));
  pianoRoot = root;
}

function wireFader() {
  const fader = $('#cam-fader');
  const fromY = (clientY) => {
    const r = fader.getBoundingClientRect();
    const { max } = RANGES[deck.range];
    setPct(-max + clamp((clientY - r.top) / r.height, 0, 1) * 2 * max);
  };
  fader.addEventListener('pointerdown', (e) => {
    fader.setPointerCapture(e.pointerId);
    fromY(e.clientY);
    fader.focus();
  });
  fader.addEventListener('pointermove', (e) => { if (fader.hasPointerCapture(e.pointerId)) fromY(e.clientY); });
  fader.addEventListener('dblclick', () => setPct(0));
  // Like the hardware: up = minus, down = plus.
  fader.addEventListener('keydown', (e) => {
    const { step } = RANGES[deck.range];
    const d = { ArrowDown: step, ArrowRight: step, ArrowUp: -step, ArrowLeft: -step, PageDown: step * 10, PageUp: -step * 10 }[e.key];
    if (e.key === 'Home' || e.key === '0') {
      e.preventDefault();
      setPct(0);
    } else if (d) {
      e.preventDefault();
      setPct(deck.pct + d);
    }
  });
}

export function initCamelot(saved, save) {
  deck = sanitizeDeck(saved);
  onChange = save;

  $('#cam-key').append(...Array.from({ length: 12 }, (_, i) => ['A', 'B'].map((mode) => {
    const key = { n: i + 1, mode };
    return el('option', { value: keyId(key), textContent: `${keyId(key)} · ${shortName(key)}` });
  })).flat());
  $('#cam-ranges').append(...Object.entries(RANGES).map(([range, { label }]) => {
    const b = el('button', { type: 'button', className: 'cam-range', textContent: label });
    b.dataset.range = range;
    b.addEventListener('click', () => setRange(Number(range)));
    return b;
  }));
  Object.assign($('#cam-bpm'), { min: BPM_MIN, max: BPM_MAX });
  buildWheel();
  buildScales();
  wireFader();

  $('#cam-key').addEventListener('change', (e) => setKey(parseKeyId(e.target.value)));
  $('#cam-bpm').addEventListener('input', (e) => {
    const v = parseNum(e.target.value);
    if (v > 0) {
      deck.bpm = clamp(Math.round(v * 100) / 100, BPM_MIN, BPM_MAX);
      changed();
    }
  });
  $('#cam-bpm').addEventListener('change', render); // show the clamped value once typing ends
  $('#cam-pct').addEventListener('change', (e) => setPct(parseNum(e.target.value)));
  $('#cam-mt').addEventListener('change', (e) => {
    deck.masterTempo = e.target.checked;
    changed();
  });
  // The target becomes the new track, played from 0 % (like Listen's "Use as the track").
  $('#cam-target-make').addEventListener('click', () => {
    if (!deck.target) return;
    deck.pct = 0;
    setKey(deck.target);
  });
  $('#cam-target-clear').addEventListener('click', () => {
    deck.target = null;
    changed();
  });
  $('#cam-minus').addEventListener('click', () => setPct(deck.pct - RANGES[deck.range].step));
  $('#cam-plus').addEventListener('click', () => setPct(deck.pct + RANGES[deck.range].step));
  $('#cam-reset').addEventListener('click', () => setPct(0));
  // A landing row jumps the fader there; it only means something with Master Tempo off.
  const jump = (tr) => {
    deck.masterTempo = false;
    setPct(Number(tr.dataset.pct));
  };
  $('#cam-landings').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-pct]');
    if (tr) jump(tr);
  });
  $('#cam-landings').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.pct) {
      e.preventDefault();
      jump(e.target);
    }
  });
  render();
}

// ---------- render (every change) ----------

// Result with a target: how `here` (where the track sounds) mixes into the target, and the
// fader settings that pitch the track (from its original key) exactly there.
function renderTarget(track, here, target, s) {
  const hereId = keyId(here), targetId = keyId(target), trackId = keyId(track);
  const rel = mixRelation(here, target);
  const semis = rel?.semitones ? `, ${signed(rel.semitones, 0)} semitone${Math.abs(rel.semitones) === 1 ? '' : 's'}` : '';
  $('#cam-target-relation').className = `callout ${rel ? 'ok' : 'warn'}`;
  $('#cam-target-relation').textContent = hereId === targetId ? `Already there: the track sounds in ${targetId}.`
    : rel ? `${rel.name}${rel.sym ? ` ${rel.sym}` : ''} (${rel.hint.toLowerCase()}${semis}). Mixes harmonically.`
      : `Not a harmonic match: ${hereId} and ${targetId} will probably clash.`;
  const reach = pitchTo(track, target, deck.range);
  let options;
  if (!reach.sameLetter) {
    const relative = target.n === track.n;
    options = [el('p', { className: 'cam-hint', textContent: `Pitching keeps the letter (${track.mode}), so the track can't land in ${targetId}.${relative
      ? ` At 0 % it has the same notes as ${targetId}, its relative ${target.mode === 'A' ? 'minor' : 'major'}.`
      : ' Mix them as they are.'}` })];
    if (relative && deck.pct !== 0) {
      const back = el('button', { type: 'button', className: 'btn', textContent: `${fmtPct(0)} · back to ${trackId}`, title: 'Set the fader to 0 %' });
      back.addEventListener('click', () => setPct(0));
      options.push(back);
    }
  } else if (!reach.options.length) {
    const n = Math.abs(reach.away);
    options = [el('p', { className: 'cam-hint', textContent: `${targetId} is ${n} semitone${n === 1 ? '' : 's'} away, so the fader would need ${fmtPct(pctForSemitones(reach.away))}: too far to pitch. Mix them as they are.` })];
  } else {
    options = reach.options.map(({ semitones, pct }) => {
      const needs = Object.keys(RANGES).find((r) => RANGES[r].max + 1e-9 >= Math.abs(pct));
      const there = !deck.masterTempo && s.nearest === semitones && Math.abs(s.cents) <= 10;
      const b = el('button', { type: 'button', className: there ? 'btn current' : 'btn',
        textContent: `${fmtPct(pct)} · ${signed(semitones, 0)} st${Number(needs) !== deck.range && !reach.options.find((o) => o.pct === pct).inRange ? ` · ${RANGES[needs].label}` : ''}${there ? ' · now' : ''}` });
      b.title = there ? 'The fader is here' : `Set the fader to ${fmtPct(pct)}${Number(needs) !== deck.range ? ` (switches to ${RANGES[needs].label})` : ''}, Master Tempo off`;
      b.addEventListener('click', () => pitchToTarget(pct));
      return b;
    });
  }
  $('#cam-reach').replaceChildren(...options);
  $('#cam-target-make').textContent = `Make ${targetId} the track key`;
  $('#cam-target-make').hidden = targetId === trackId;
}

// Rebuilt lists drop keyboard focus; put it back on the same item if it still exists.
function refill(container, nodes, attr) {
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset[attr] : null;
  container.replaceChildren(...nodes);
  if (focused != null) [...container.querySelectorAll(`[data-${attr}]`)].find((n) => n.dataset[attr] === focused)?.focus();
}

function render() {
  const key = { n: deck.n, mode: deck.mode };
  const { max, label } = RANGES[deck.range];
  const s = pitchShift({ ...key, pct: deck.pct, masterTempo: deck.masterTempo });
  const fromId = keyId(key);
  const toId = s.result ? keyId(s.result) : '—';
  const newBpm = Math.max(0, deck.bpm * s.ratio);

  // Controls (inputs being typed into are left alone)
  $('#cam-key').value = fromId;
  if (document.activeElement !== $('#cam-bpm')) $('#cam-bpm').value = deck.bpm;
  if (document.activeElement !== $('#cam-pct')) $('#cam-pct').value = deck.pct.toFixed(2);
  document.querySelectorAll('.cam-range').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === deck.range)));
  $('#cam-mt').checked = deck.masterTempo;

  // Fader: cap position and the fill from the centre detent
  const f = (deck.pct + max) / (2 * max);
  $('#cam-cap').style.top = `${f * 100}%`;
  Object.assign($('#cam-fill').style, { top: `${Math.min(f, 0.5) * 100}%`, height: `${Math.abs(f - 0.5) * 100}%` });
  $('#cam-fader').setAttribute('aria-valuenow', deck.pct);
  $('#cam-fader').setAttribute('aria-valuetext', fmtPct(deck.pct));

  // LCD
  $('#cam-lcd-range').textContent = label;
  $('#cam-lcd-pct').textContent = fmtPct(deck.pct);
  $('#cam-lcd-mt').textContent = deck.masterTempo ? 'MT ON' : 'MT OFF';
  $('#cam-lcd-keys').textContent = `${fromId} → ${toId}`;
  $('#cam-lcd-bpm').textContent = `${newBpm.toFixed(1)} BPM`;

  // Result. No target: the track's original → pitched key. A target: where the track sounds
  // now → the target, how the two mix, and the fader setting that gets the track there.
  const target = deck.target;
  $('#cam-target').hidden = !target;
  $('#cam-status').hidden = !!target;
  $('#cam-legend-target').hidden = !target;
  if (target) {
    const here = s.result ?? key;
    $('#cam-from').textContent = keyId(here);
    $('#cam-to').textContent = keyId(target);
    $('#cam-to').style.background = keyColor(target);
    $('#cam-names').replaceChildren(el('strong', { textContent: longName(here) }), ' becomes ', el('strong', { textContent: longName(target) }));
    renderTarget(key, here, target, s);
  } else {
    $('#cam-from').textContent = fromId;
    $('#cam-to').textContent = toId;
    $('#cam-to').style.background = s.result ? keyColor(s.result) : 'var(--line)';
    $('#cam-names').replaceChildren(...(s.result
      ? [el('strong', { textContent: longName(key) }), ' becomes ', el('strong', { textContent: longName(s.result) })]
      : ['The platter is stopped, so there is no pitch.']));
  }
  const verdict = tuning(key, s, deck.masterTempo);
  $('#cam-status').className = `callout cam-status ${verdict.tone}`;
  $('#cam-status').textContent = verdict.text;
  $('#cam-s-pct').textContent = fmtPct(deck.pct);
  $('#cam-s-st').textContent = s.raw === null ? '—' : `${signed(s.raw, 2)} st${deck.masterTempo ? ' (locked)' : ''}`;
  $('#cam-s-near').textContent = s.nearest === null ? '—' : `${signed(s.nearest, 0)} st`;
  $('#cam-s-cents').textContent = s.cents === null ? '—' : `${signed(s.cents, 1)} ¢`;
  const w = s.wheelSteps;
  $('#cam-s-steps').textContent = w === null ? '—' : w === 0 ? '0' : w <= 6 ? `${w} clockwise` : `${12 - w} anticlockwise`;
  $('#cam-s-bpm').textContent = `${deck.bpm.toFixed(1)} → ${newBpm.toFixed(1)}`;
  $('#cam-needle').style.left = `${clamp(s.cents ?? 0, -50, 50) + 50}%`;

  // Mixing
  const compat = s.result ? compatibleKeys(s.result) : [];
  refill($('#cam-compat'), compat.map(({ key: k, why }) => keyButton(k, why)), 'key');
  $('#cam-chart-title').textContent = s.result ? `Mixing chart for ${toId}` : 'Mixing chart';
  refill($('#cam-chart'), (s.result ? mixingChart(s.result) : []).map((row) => el('div', { className: 'cam-chart-row' },
    el('div', { className: 'cam-chart-name' }, row.name, row.sym ? el('span', { className: 'cam-sym', textContent: row.sym }) : null, el('em', { textContent: row.hint })),
    el('div', { className: 'cam-chips' }, ...row.keys.map(({ key: k, semitones }) => (semitones
      ? keyButton(k, `${signed(semitones, 0)} st`, true)
      : keyButton(k, shortName(k))))))), 'key');

  // Wheel: original dashed, result solid, the result's neighbours half-lit, the rest dimmed.
  const compatIds = new Set(compat.slice(1).map((c) => keyId(c.key)));
  const targetId = deck.target ? keyId(deck.target) : null;
  for (const [id, g] of segs) {
    const state = s.result && id === toId ? 'res' : id === fromId ? 'orig' : compatIds.has(id) ? 'compat' : 'dim';
    g.setAttribute('class', `cam-seg ${state}${id === targetId ? ' target' : ''}`);
    if (state === 'res' || state === 'orig' || id === targetId) { // drawn above neighbours so the outline isn't covered
      const focused = document.activeElement === g;
      g.parentNode.insertBefore(g, wheel.arrow);
      if (focused) g.focus(); // moving a node drops its focus
    }
  }
  wheel.label.textContent = deck.masterTempo ? 'KEY LOCKED'
    : s.nearest === null ? 'STOPPED'
      : s.nearest === 0 ? 'NO KEY CHANGE'
        : `${signed(s.nearest, 0)} SEMITONE${Math.abs(s.nearest) === 1 ? '' : 'S'}`;
  wheel.key.textContent = toId;
  const moved = s.result && toId !== fromId;
  wheel.arrow.toggleAttribute('hidden', !moved); // SVG elements have no .hidden property
  if (moved) {
    const [r0, r1] = RING[deck.mode];
    const r = (r0 + r1) / 2 - 22;
    const [x0, y0] = pt(r, (deck.n % 12) * 30), [x1, y1] = pt(r, (s.result.n % 12) * 30);
    wheel.arrow.setAttribute('d', `M${x0},${y0} Q${((x0 + x1) / 2) * 0.25},${((y0 + y1) / 2) * 0.25} ${x1},${y1}`);
  }

  // Pitch ruler
  const root = rootPc(key);
  if (root !== pianoRoot) buildPiano(root);
  const pos = s.semitones === null ? -12.5 : clamp(s.semitones, -12.5, 12.5);
  $('#cam-pmarker').style.left = `${((pos + 12.5) / 25) * 100}%`;

  // Exact landings in this range
  refill($('#cam-landings'), semitoneLandings(deck.range).map(({ k, pct }) => {
    const landed = { n: shiftSemitones(deck.n, k), mode: deck.mode };
    const on = !deck.masterTempo && s.nearest === k && Math.abs(s.cents) <= 10;
    const dot = el('span', { className: 'cam-dot' });
    dot.style.background = keyColor(landed);
    const tr = el('tr', { className: on ? 'on' : '', tabIndex: 0 },
      el('td', { textContent: fmtPct(pct) }),
      el('td', { textContent: k === 0 ? '0' : signed(k, 0) }),
      el('td', { title: longName(landed) }, dot, keyId(landed), el('span', { className: 'cam-land-name', textContent: ` · ${shortName(landed)}` })),
      el('td', { textContent: (deck.bpm * (1 + pct / 100)).toFixed(1) }));
    tr.dataset.pct = pct;
    return tr;
  }), 'pct');
}
