// Audio analyzer view: drop a track (or two) and see its spectrogram, a verdict (real lossless
// or made from an MP3; optionally real hi-res, per Settings), the average spectrum, and tempo + a
// key estimate that follow a few seconds later. Decoding and maths run in the main process
// (engine/analyze.js, spectrum.js, tempokey.js); this file only draws (analyzer.md).
// Markup: index.html → [data-view="analyzer"].

import { $, el } from '../shared/js/dom.js';
import { lut as colorLut, gradient } from '../shared/js/colormap.js';
import { keyColor, keyEstimate, beatNote } from '../camelot/keys.js';

const SLOTS = ['a', 'b'];
const DISPLAY = { lo: -140, hi: -20 }; // spectrogram contrast window, dB (matches .an-scale)
const CHART_H = 220;
const NS = 'http://www.w3.org/2000/svg';

let api, call, mode, colors, useOnWheel;
let compare = false;
const slots = { a: blank(), b: blank() };

function blank() {
  // status: 'empty' | 'busy' | 'done' | 'error'; pending: a request is in flight for this slot.
  // tk: tempo and key, which follow the result as an analyzer:tempoKey event with its token.
  return { status: 'empty', result: null, error: null, frac: 0, token: 0, pending: false, bitmap: null, tk: null };
}

const card = (slot) => document.querySelector(`.an-slot[data-slot="${slot}"]`);
const q = (slot, sel) => card(slot).querySelector(sel);
const shown = (slot) => slot === 'a' || compare;
const done = () => SLOTS.filter((s) => shown(s) && slots[s].result);
const nf = new Intl.NumberFormat();
const kHz = (hz) => `${+(hz / 1000).toFixed(1)} kHz`;
const dB = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} dB`; // typographic minus, like the rest of the UI
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

// A round step giving at most `max` ticks up to `top`.
function niceStep(top, max, steps) {
  return steps.find((s) => top / s <= max) ?? steps.at(-1);
}

// Shared frequency axis: when comparing, both spectrograms and the chart run to the higher Nyquist.
function axisTop() {
  return Math.max(1, ...done().map((s) => slots[s].result.spectrogram.nyquist));
}

// ---------- running an analysis ----------

async function run(slot, start, { immediate = false } = {}) {
  const s = slots[slot];
  const t = ++s.token;
  s.pending = true;
  if (immediate) Object.assign(s, { status: 'busy', frac: 0, error: null });
  render();
  try {
    const result = await call(start);
    if (t !== s.token) return; // replaced by a newer file
    if (result) Object.assign(s, { status: 'done', result, bitmap: null, error: null, tk: { token: result.tempoKey, data: null, error: null } });
    else if (s.status === 'busy') s.status = s.result ? 'done' : 'empty'; // dialog cancelled
  } catch (err) {
    if (t !== s.token) return;
    // A file that can't be analysed doesn't throw away the one already shown.
    Object.assign(s, { status: s.result ? 'done' : 'error', error: err.message });
  } finally {
    if (t === s.token) s.pending = false;
  }
  render();
}

function drop(slot, files) {
  if (files.length >= 2) {
    setCompare(true);
    SLOTS.forEach((s, i) => run(s, () => api.analyzerDrop(s, files[i]), { immediate: true }));
  } else if (files.length === 1) {
    run(slot, () => api.analyzerDrop(slot, files[0]), { immediate: true });
  }
}

function clear(slot) {
  const s = slots[slot];
  if (s.pending || (s.tk && !s.tk.data && !s.tk.error)) api.analyzerCancel(slot);
  slots[slot] = { ...blank(), token: slots[slot].token + 1 };
  render();
}

function setCompare(on) {
  compare = on;
  card('b').hidden = !on;
  $('#an-compare').setAttribute('aria-pressed', String(on));
  $('#an-compare').textContent = on ? 'Stop comparing' : 'Compare two tracks';
  render();
}

// ---------- drawing ----------

// The decoded matrix (row 0 = Nyquist) as an image, through the colour scale from Settings.
function bitmap(spec) {
  const scale = colorLut(colors());
  const lut = Array.from({ length: 256 }, (_, b) => {
    const db = spec.dbFloor * (1 - b / 255);
    const t = Math.min(1, Math.max(0, (db - DISPLAY.lo) / (DISPLAY.hi - DISPLAY.lo)));
    return scale[Math.round(t * 255)];
  });
  const c = Object.assign(document.createElement('canvas'), { width: spec.columns, height: spec.rows });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(spec.columns, spec.rows);
  for (let i = 0; i < spec.image.length; i++) {
    const [r, g, b] = lut[spec.image[i]];
    img.data.set([r, g, b, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function drawSpectrogram(slot) {
  const s = slots[slot];
  const canvas = q(slot, '.an-canvas');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return; // view hidden; the ResizeObserver redraws when it shows
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas, { width: Math.round(w * dpr), height: Math.round(h * dpr) });
  const ctx = canvas.getContext('2d');
  const share = s.result.spectrogram.nyquist / axisTop(); // part of the axis this file can hold
  // Above this file's Nyquist (only when comparing with a higher rate): hatched, not black,
  // so "can't hold sound" doesn't read as "silent".
  ctx.fillStyle = token('--card-2');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = token('--line');
  ctx.lineWidth = dpr;
  const top = (1 - share) * canvas.height;
  for (let x = -top; x < canvas.width; x += 8 * dpr) {
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + top, 0);
    ctx.stroke();
  }
  s.bitmap ??= bitmap(s.result.spectrogram);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(s.bitmap, 0, top, canvas.width, canvas.height - top);
}

function placeLine(node, hz, text) {
  node.hidden = hz == null;
  if (hz == null) return;
  node.style.top = `${(1 - hz / axisTop()) * 100}%`;
  node.querySelector('span').textContent = text;
}

function renderResult(slot) {
  const { result: r } = slots[slot];
  const f = r.format;
  const verdict = r.verdicts[mode()]; // 'lossless' or 'hires', from Settings → Audio Analyzer
  const bits = f.bits ? `${f.bits}-bit${f.lossless !== false && f.usedBits != null && f.usedBits < f.bits ? ` · ${f.usedBits} used` : ''}` : null;
  const facts = [
    f.codec || f.container,
    kHz(f.sampleRate),
    bits,
    f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`,
    mmss(f.duration),
    f.bitrate ? `${nf.format(f.bitrate)} kbps` : null,
  ];
  q(slot, '.an-facts').replaceChildren(...facts.filter(Boolean).map((t) => el('span', { className: 'an-fact', textContent: t })));
  q(slot, '.an-verdict').className = `callout an-verdict ${verdict.tone}`;
  q(slot, '.an-verdict-title').textContent = verdict.title;
  q(slot, '.an-notes').replaceChildren(...verdict.notes.map((n) => el('li', { textContent: n })));
  q(slot, '.an-canvas').setAttribute('aria-label', `Spectrogram of ${r.name}. ${verdict.title}.`);
  renderTempoKey(slot);

  const topHz = axisTop();
  const fStep = niceStep(topHz / 1000, 6, [2, 5, 10, 20, 50]) * 1000;
  const yTicks = [];
  for (let hz = 0; hz <= topHz; hz += fStep) yTicks.push(el('span', { textContent: hz ? `${hz / 1000}k` : '0', style: `top:${(1 - hz / topHz) * 100}%` }));
  q(slot, '.an-yaxis').replaceChildren(...yTicks);
  const tStep = niceStep(f.duration, 8, [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]);
  const xTicks = [];
  for (let t = 0; t <= f.duration; t += tStep) xTicks.push(el('span', { textContent: mmss(t), style: `left:${(t / f.duration) * 100}%` }));
  q(slot, '.an-xaxis').replaceChildren(...xTicks);
  q(slot, '.an-scale i').style.background = gradient(colors());

  const nyq = r.spectrogram.nyquist;
  placeLine(q(slot, '.an-nyq'), nyq < topHz - 1 ? nyq : null, `File limit ${kHz(nyq)}`);
  placeLine(q(slot, '.an-cutoff'), r.edge.cutoff, `Cutoff ${kHz(r.edge.cutoff ?? 0)}`);
  drawSpectrogram(slot);
}

const signed = (v, digits) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

function renderTempoKey(slot) {
  const { tk } = slots[slot];
  const d = tk?.data;
  q(slot, '.an-tk-busy').hidden = !tk || !!d || !!tk.error;
  q(slot, '.an-tk-error').hidden = !tk?.error;
  q(slot, '.an-tk-error').textContent = tk?.error ? `⚠ Tempo and key: ${tk.error}` : '';
  q(slot, '.an-tk-stats').hidden = !d;
  if (!d) return;
  q(slot, '.an-bpm').textContent = d.bpm ? d.bpm.toFixed(1) : '—';
  q(slot, '.an-bpm-note').textContent = d.bpm ? `${beatNote(d.clarity)}${d.truncated ? ' · first 20 min' : ''}` : 'no beat found';
  const est = keyEstimate(d.key);
  const chip = q(slot, '.an-key-chip');
  chip.textContent = est.chip;
  chip.style.background = est.usable ? keyColor(d.key) : '';
  q(slot, '.an-key-name').textContent = est.name;
  q(slot, '.an-key-note').textContent = est.note;
  q(slot, '.an-tuning').textContent = `${signed(d.tuning, 0)} ¢`;
  q(slot, '.an-tuning-note').textContent = Math.abs(d.tuning) < 3 ? 'on concert pitch (A440)' : `≈ ${signed((2 ** (d.tuning / 1200) - 1) * 100, 2)}% from A440`;
  const what = [est.usable && d.key.camelot, d.bpm && `${d.bpm.toFixed(1)} BPM`].filter(Boolean).join(' · ');
  const use = q(slot, '.an-use');
  use.hidden = !what;
  use.textContent = `Use ${what} on Camelot wheel`;
}

function renderSlot(slot) {
  const s = slots[slot];
  const swatch = compare ? el('i', { className: `an-swatch ${slot}` }) : null;
  q(slot, '.an-label').replaceChildren(...[swatch, compare ? `Track ${slot.toUpperCase()}` : 'Track'].filter(Boolean));
  q(slot, '.an-name').textContent = s.status === 'done' ? s.result.name : '';
  q(slot, '.an-clear').hidden = s.status === 'empty' && !s.pending;
  q(slot, '.an-drop').hidden = s.status === 'done';
  q(slot, '.an-drop-title').textContent = s.status === 'busy' ? 'Analysing…' : 'Drop a track here';
  q(slot, '.an-progress').hidden = s.status !== 'busy';
  q(slot, '.progress .fill').style.width = `${Math.round(s.frac * 100)}%`;
  q(slot, '.an-progress-text').textContent = `Decoding and measuring · ${Math.round(s.frac * 100)}%`;
  q(slot, '.an-error').hidden = !s.error || s.status === 'busy';
  q(slot, '.an-error').textContent = s.error ? `⚠ ${s.error}` : '';
  q(slot, '.an-result').hidden = s.status !== 'done';
  if (s.status === 'done') renderResult(slot);
}

// Average spectrum: one 2px line per track, shared frequency axis, crosshair on hover.
function renderChart() {
  const series = done().map((slot) => ({ slot, r: slots[slot].result, color: token(`--series-${slot}`) }));
  $('#an-spectrum').hidden = !series.length;
  const box = $('#an-chart');
  const W = box.clientWidth;
  if (!series.length || !W) return;
  const m = { l: 56, r: 16, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = CHART_H - m.t - m.b;
  const topHz = axisTop();
  const audible = series.flatMap(({ r }) => [...r.spectrum].filter((v) => v > -190));
  const yHi = Math.ceil((Math.max(...audible) + 5) / 10) * 10;
  const yLo = Math.max(-160, Math.min(yHi - 40, Math.floor((Math.min(...audible) - 5) / 10) * 10));
  const x = (hz) => m.l + (hz / topHz) * pw;
  const y = (db) => m.t + ((yHi - Math.max(yLo, db)) / (yHi - yLo)) * ph;
  const at = (r, i) => ((i + 0.5) / r.spectrum.length) * r.spectrogram.nyquist;

  const grid = [];
  for (let db = yHi; db >= yLo; db -= 20) {
    grid.push(svg('line', { class: 'an-grid', x1: m.l, x2: m.l + pw, y1: y(db), y2: y(db) }),
      svg('text', { class: 'an-tick', x: m.l - 6, y: y(db) + 4, 'text-anchor': 'end' }, db === yHi ? dB(db) : dB(db).replace(' dB', '')));
  }
  const fStep = niceStep(topHz / 1000, 8, [2, 5, 10, 20, 50]) * 1000;
  for (let hz = 0; hz <= topHz; hz += fStep) {
    grid.push(svg('text', { class: 'an-tick', x: x(hz), y: CHART_H - 6, 'text-anchor': 'middle' }, hz ? `${hz / 1000}k` : '0'));
  }
  const marks = series.flatMap(({ r, color }) => {
    const pts = Array.from(r.spectrum, (v, i) => `${x(at(r, i)).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const out = [svg('polyline', { class: 'an-series', points: pts, stroke: color })];
    if (r.edge.cutoff) out.push(svg('line', { class: 'an-cut', x1: x(r.edge.cutoff), x2: x(r.edge.cutoff), y1: m.t, y2: m.t + ph, stroke: color }));
    return out;
  });
  const cross = svg('line', { class: 'an-cross', y1: m.t, y2: m.t + ph, visibility: 'hidden' });
  const hit = svg('rect', { class: 'an-hit', x: m.l, y: m.t, width: pw, height: ph });
  const tip = el('div', { className: 'an-tip', hidden: true });
  hit.addEventListener('mousemove', (e) => {
    const bx = e.clientX - box.getBoundingClientRect().left;
    const hz = ((bx - m.l) / pw) * topHz;
    cross.setAttribute('x1', bx);
    cross.setAttribute('x2', bx);
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(el('b', { textContent: kHz(hz) }), ...series.map(({ slot, r }) => {
      const i = Math.floor((hz / r.spectrogram.nyquist) * r.spectrum.length);
      const v = r.spectrum[i];
      const text = i >= r.spectrum.length ? 'beyond this file' : v <= -190 ? 'silent' : dB(v);
      return el('span', {}, el('i', { className: `an-swatch ${slot}` }), `${series.length > 1 ? slot.toUpperCase() : 'Level'} ${text}`);
    }));
    tip.hidden = false;
    tip.style.left = `${Math.min(bx + 12, W - 150)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
  box.replaceChildren(svg('svg', { width: W, height: CHART_H, role: 'img', 'aria-label': 'Average spectrum' },
    ...grid, ...marks, cross, hit), tip);

  // One series: the title names it. Two: a legend (identity is never colour alone).
  $('#an-spectrum-title').textContent = series.length > 1 ? 'Average spectrum' : `Average spectrum · ${series[0].r.name}`;
  $('#an-legend').hidden = series.length < 2;
  $('#an-legend').replaceChildren(...series.map(({ slot, r }) => el('span', {},
    el('i', { className: `an-swatch ${slot}` }), `${slot.toUpperCase()} · ${r.name}`,
    el('em', { textContent: r.edge.cutoff ? ` cutoff ${kHz(r.edge.cutoff)}` : ' no hard cutoff' }))));
}

function render() {
  SLOTS.forEach((slot) => { if (shown(slot)) renderSlot(slot); });
  renderChart();
}

// Hover readout on a spectrogram: time, frequency and level under the pointer.
function wireHover(slot) {
  const wrap = q(slot, '.an-canvas-wrap');
  const tip = q(slot, '.an-tip');
  wrap.addEventListener('mousemove', (e) => {
    const s = slots[slot];
    if (s.status !== 'done') return;
    const box = wrap.getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width, fy = (e.clientY - box.top) / box.height;
    const spec = s.result.spectrogram;
    const hz = (1 - fy) * axisTop();
    let level = 'beyond this file';
    if (hz <= spec.nyquist) {
      const col = Math.min(spec.columns - 1, Math.floor(fx * spec.columns));
      const row = Math.min(spec.rows - 1, Math.floor((1 - hz / spec.nyquist) * spec.rows));
      const b = spec.image[row * spec.columns + col];
      level = b === 0 ? `below ${dB(spec.dbFloor)}` : dB(spec.dbFloor * (1 - b / 255));
    }
    tip.textContent = `${mmss(fx * s.result.format.duration)} · ${kHz(hz)} · ${level}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX - box.left + 12, box.width - 190)}px`;
    tip.style.top = `${Math.max(0, e.clientY - box.top - 30)}px`;
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
}

function wireDrop(slot) {
  const c = card(slot);
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  c.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    c.classList.add('an-dragover');
  });
  c.addEventListener('dragleave', (e) => { if (!c.contains(e.relatedTarget)) c.classList.remove('an-dragover'); });
  c.addEventListener('drop', (e) => {
    e.preventDefault();
    c.classList.remove('an-dragover');
    drop(slot, [...e.dataTransfer.files]);
  });
}

export function initAnalyzer(deps) {
  ({ api, call, mode, colors, useOnWheel } = deps);
  // Verdict and colours follow Settings at once: drop the cached bitmaps and redraw.
  document.addEventListener('prefs:change', () => {
    for (const s of Object.values(slots)) s.bitmap = null;
    render();
  });
  const tpl = $('#an-slot-tpl');
  for (const slot of SLOTS) {
    card(slot).append(tpl.content.cloneNode(true));
    card(slot).querySelectorAll('.an-pick').forEach((b) => b.addEventListener('click', () => run(slot, () => api.analyzerPick(slot))));
    q(slot, '.an-clear').addEventListener('click', () => clear(slot));
    q(slot, '.an-use').addEventListener('click', () => {
      const d = slots[slot].tk?.data;
      if (!d) return;
      useOnWheel({ ...(keyEstimate(d.key).usable && { n: d.key.n, mode: d.key.mode }), bpm: d.bpm ?? 0 });
    });
    wireDrop(slot);
    wireHover(slot);
  }
  // Anywhere else, a dropped file must not navigate the window or look droppable.
  document.addEventListener('dragover', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('drop', (e) => e.preventDefault());
  $('#an-compare').addEventListener('click', () => setCompare(!compare));
  api.onAnalyzerProgress(({ slot, frac }) => {
    const s = slots[slot];
    if (!s.pending) return; // a late event from a cancelled decode
    if (s.status !== 'busy') Object.assign(s, { status: 'busy', error: null });
    s.frac = frac;
    renderSlot(slot);
  });
  api.onAnalyzerTempoKey(({ slot, token, ok, data, error }) => {
    const s = slots[slot];
    if (!s?.tk || s.tk.token !== token) return; // for a file that's no longer shown
    Object.assign(s.tk, ok ? { data } : { error });
    if (s.status === 'done' && shown(slot)) renderTempoKey(slot);
  });
  // Canvases and the chart follow the card width (and draw once the view is first shown).
  new ResizeObserver(() => render()).observe($('[data-view="analyzer"] .shell'));
  render();
}
