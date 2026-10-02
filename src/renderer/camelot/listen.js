// Listen (Camelot page): capture ~10 s from an audio input while drawing a live spectrogram, then
// ask main for tempo, key and tuning (engine/tempokey.js). The audio stays in memory on this
// computer and is dropped after the analysis (camelot.md → Listen).

import { $, el } from '../shared/js/dom.js';
import { NOTE_NAMES, keyId, rootPc } from '../../engine/camelot.js';
import { keyColor, keyEstimate, beatNote } from './keys.js';
import { lut as colorLut } from '../shared/js/colormap.js';

const SECONDS = 10; // auto-stop
const MIN_SECONDS = 4; // Stop earlier than this and there's too little to go on
const QUIET_DB = -45; // RMS below this: warn that the input is barely there
const FREQ = { lo: 40, hi: 12000 }; // live spectrogram, log scale
const MIC_OFF = 'Microphone access is off for this app. Turn it on in System Settings → Privacy & Security → Microphone, then restart the app.';

let api, call, apply, autoApply, colors, savedInput, saveInput;
let phase = 'idle'; // 'idle' | 'starting' | 'listening' | 'analysing' | 'done' | 'error'
let capture = null; // the running capture (stream, audio graph, collected chunks)
let result = null;
let factor = 1; // ½× / 2× applied to the detected BPM
// The Input select's value: '' (default input), 'mic:<deviceId>' (Chromium, first two channels) or
// 'line:<device name>|<channels>' (recorded in main through ffmpeg: any pair of a multichannel
// interface, e.g. a Scarlett's inputs 3/4). Remembered in settings.listenInput.
let input = '';

function parseInput(value) {
  if (value.startsWith('line:')) {
    const [device, chans] = value.slice(5).split('|');
    return { kind: 'line', device, channels: chans.split(',').map(Number) };
  }
  return { kind: 'mic', deviceId: value.startsWith('mic:') ? value.slice(4) : '' };
}

const signed = (v, d) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;


// ---------- capture ----------

function friendly(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return MIC_OFF;
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No audio input found. Plug in a mic or audio interface, or pick another input.';
  if (err?.name === 'NotReadableError') return 'That input is busy or unavailable. Close other apps using it, or pick another input.';
  return err?.message || String(err);
}

// Plain inputs from Chromium, plus every pair of each multichannel interface (from main). A
// multichannel device's own Chromium entry is left out: it would only ever give inputs 1/2.
async function fillDevices() {
  const [media, lines] = await Promise.all([
    navigator.mediaDevices.enumerateDevices().catch(() => []),
    call(api.listenLineInputs).catch(() => []),
  ]);
  const lineNames = new Set(lines.map((l) => l.name));
  // Chromium appends USB ids or a type, e.g. "Scarlett 6i6 USB (1235:8203)"; Core Audio doesn't.
  const bare = (label) => label.replace(/\s*\([^)]*\)$/, '');
  const mics = media.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && !lineNames.has(bare(d.label)));
  const sel = $('#cam-listen-device');
  sel.replaceChildren(
    el('option', { value: '', textContent: 'Default input' }),
    ...mics.map((d, i) => el('option', { value: `mic:${d.deviceId}`, textContent: d.label || `Input ${i + 1}` })),
    ...lines.map((l) => {
      const group = el('optgroup', { label: `${l.name} · ${l.channels} inputs` });
      group.append(...l.choices.map((c) => el('option', { value: `line:${l.name}|${c.channels.join(',')}`, textContent: `${l.name} · inputs ${c.label}` })));
      return group;
    }),
  );
  sel.value = [...sel.options].some((o) => o.value === input) ? input : '';
}

async function start() {
  if (capture || phase === 'starting' || phase === 'analysing') return;
  $('#cam-listen').hidden = false;
  result = null;
  factor = 1;
  setPhase('starting');
  const chosen = parseInput(input);
  const c = { chunks: [], frames: 0, rms: -200, loudest: -200, x: 0, line: chosen.kind === 'line' };
  capture = c;
  try {
    const access = await call(api.listenAccess);
    if (access === 'denied' || access === 'restricted') throw new Error(MIC_OFF);
    if (c.line) return await startLine(c, chosen);
    // Echo cancellation, noise suppression and auto-gain are made for voice; they mangle music.
    c.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: chosen.deviceId ? { exact: chosen.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (capture !== c) return stop(c); // cancelled while asking
    await fillDevices();
    c.ctx = new AudioContext();
    await c.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    const source = c.ctx.createMediaStreamSource(c.stream);
    c.node = new AudioWorkletNode(c.ctx, 'capture');
    c.analyser = Object.assign(c.ctx.createAnalyser(), { fftSize: 4096, smoothingTimeConstant: 0, minDecibels: -110, maxDecibels: -20 });
    c.mute = c.ctx.createGain();
    c.mute.gain.value = 0; // the graph has to reach the output to run; nothing is played
    source.connect(c.node).connect(c.mute).connect(c.ctx.destination);
    source.connect(c.analyser);
    c.sr = c.ctx.sampleRate;
    c.node.port.onmessage = ({ data }) => {
      c.chunks.push(data);
      c.frames += data.length;
      let sum = 0;
      for (const v of data) sum += v * v;
      c.rms = 10 * Math.log10(sum / data.length + 1e-20);
      c.loudest = Math.max(c.loudest, c.rms);
      if (c.frames >= SECONDS * c.sr) finish();
    };
    c.started = performance.now();
    setPhase('listening');
    prepareCanvas(c);
    c.raf = requestAnimationFrame(() => draw(c));
  } catch (err) {
    stop(c);
    if (capture === c) capture = null;
    showError(friendly(err));
  }
}

// Line input: main records and analyses; this side only draws the columns it streams.
async function startLine(c, { device, channels }) {
  // Opening an interface through AVFoundation takes ~2.5 s, so the take (countdown, picture, Stop)
  // starts with the first column of audio, not the click; until then it reads "Opening the input…".
  c.unsub = api.onListenColumn(({ rows, level }) => {
    c.latest = rows;
    c.rms = level;
    c.loudest = Math.max(c.loudest, level);
    if (!c.started && capture === c) {
      c.started = performance.now();
      setPhase('listening');
      prepareCanvas(c);
      c.raf = requestAnimationFrame(() => draw(c));
    }
  });
  try {
    const r = await call(api.listenCaptureLine, { device, channels, seconds: SECONDS });
    if (capture !== c) return; // closed meanwhile
    capture = null;
    stop(c);
    if (!r) return setPhase('idle');
    result = r;
    setPhase('done');
  } catch (err) {
    stop(c);
    if (capture === c) capture = null;
    showError(friendly(err));
  }
}

function stop(c) {
  if (!c) return;
  c.unsub?.();
  cancelAnimationFrame(c.raf);
  if (c.node) c.node.port.onmessage = null;
  c.stream?.getTracks().forEach((t) => t.stop());
  c.ctx?.close().catch(() => {});
}

// Stop listening (auto at SECONDS, or the Stop button) and analyse what came in.
async function finish() {
  const c = capture;
  if (!c || phase !== 'listening') return;
  if (c.line) { // main stops ffmpeg and analyses what came in; startLine() gets the result
    setPhase('analysing');
    api.listenStopLine(false);
    return;
  }
  capture = null;
  stop(c);
  const seconds = c.frames / c.sr;
  if (seconds < MIN_SECONDS) return showError(`Only ${seconds.toFixed(1)} s came in. Listen for at least ${MIN_SECONDS} s.`);
  const samples = new Float32Array(c.frames);
  let at = 0;
  for (const chunk of c.chunks) {
    samples.set(chunk, at);
    at += chunk.length;
  }
  setPhase('analysing');
  try {
    result = await call(api.listenAnalyze, samples, c.sr);
    setPhase('done');
  } catch (err) {
    showError(friendly(err));
  }
}

// ---------- drawing ----------

function prepareCanvas(c) {
  const canvas = $('#cam-listen-canvas');
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas, { width: Math.round(canvas.clientWidth * dpr), height: Math.round(canvas.clientHeight * dpr) });
  const ctx = canvas.getContext('2d');
  c.lut = colorLut(colors());
  ctx.fillStyle = `rgb(${c.lut[0].join(',')})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (c.line) return; // main's columns already span FREQ on the same log scale, top row = highest
  c.freq = new Uint8Array(c.analyser.frequencyBinCount);
  // Canvas row → analyser bin, on a log frequency scale (bass gets room).
  const binHz = c.sr / c.analyser.fftSize;
  c.rowBin = Array.from({ length: canvas.height }, (_, y) => {
    const f = FREQ.lo * (FREQ.hi / FREQ.lo) ** (1 - y / (canvas.height - 1));
    return Math.min(c.freq.length - 1, Math.round(f / binHz));
  });
}

// The picture fills left to right over SECONDS, so the finished take stays on screen.
function draw(c) {
  if (capture !== c) return;
  const canvas = $('#cam-listen-canvas');
  const ctx = canvas.getContext('2d');
  const elapsed = (performance.now() - c.started) / 1000;
  const x = Math.min(canvas.width, Math.round((elapsed / SECONDS) * canvas.width));
  // One column source per path: the analyser (Chromium input) or main's latest column (line input).
  let level = null;
  if (c.line) {
    const rows = c.latest;
    if (rows) level = (y) => rows[Math.min(rows.length - 1, Math.floor((y / canvas.height) * rows.length))];
  } else {
    c.analyser.getByteFrequencyData(c.freq);
    level = (y) => c.freq[c.rowBin[y]];
  }
  if (x > c.x && level) {
    const col = ctx.createImageData(x - c.x, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      const [r, g, b] = c.lut[level(y)];
      for (let i = 0; i < x - c.x; i++) col.data.set([r, g, b, 255], (y * (x - c.x) + i) * 4);
    }
    ctx.putImageData(col, c.x, 0);
    c.x = x;
  }
  $('#cam-listen-count').textContent = `${Math.max(0, Math.ceil(SECONDS - elapsed))} s`;
  $('#cam-listen-meter').style.width = `${Math.max(0, Math.min(100, ((c.rms + 70) / 60) * 100))}%`;
  $('#cam-listen-quiet').hidden = !(elapsed > 2 && c.loudest < QUIET_DB);
  c.raf = requestAnimationFrame(() => draw(c));
}

// ---------- result ----------

function chromaBars(r) {
  const tonic = r.key && r.key.confidence !== 'none' ? rootPc(r.key) : -1;
  return NOTE_NAMES.map((name, pc) => {
    const bar = el('i');
    bar.style.height = `${Math.max(2, r.chroma[pc] * 100)}%`;
    if (pc === tonic) bar.style.background = keyColor(r.key);
    return el('span', { className: pc === tonic ? 'tonic' : '', title: `${name}: ${Math.round(r.chroma[pc] * 100)}%` }, bar, el('b', { textContent: name }));
  });
}

function renderResult() {
  const r = result;
  const bpm = r.tempo ? Math.round(r.tempo.bpm * factor * 10) / 10 : null;
  $('#cam-l-bpm').textContent = bpm ? bpm.toFixed(1) : '—';
  $('#cam-l-bpm-note').textContent = !r.tempo ? 'no beat found' : beatNote(r.tempo.clarity);
  $('#cam-l-half').disabled = !bpm || bpm / 2 < 40;
  $('#cam-l-double').disabled = !bpm || bpm * 2 > 300;

  const est = keyEstimate(r.key);
  const chip = $('#cam-l-key');
  chip.textContent = est.chip;
  chip.style.background = est.usable ? keyColor(r.key) : 'var(--line)';
  $('#cam-l-key-name').textContent = est.name;
  $('#cam-l-key-note').textContent = est.note;

  $('#cam-l-tuning').textContent = `${signed(r.tuning, 0)} ¢`;
  const pct = (2 ** (r.tuning / 1200) - 1) * 100;
  $('#cam-l-tuning-note').textContent = Math.abs(r.tuning) < 3 ? 'on concert pitch (A440)' : `≈ ${signed(pct, 2)}% pitch, if the original is tuned to A440`;
  $('#cam-l-chroma').replaceChildren(...chromaBars(r));

  const warn = r.level.rms < QUIET_DB ? `Very quiet input (${r.level.rms.toFixed(0)} dBFS): turn it up or move closer, then listen again.`
    : r.tempo && r.tempo.clarity < 0.25 ? 'No clear beat: try a part of the track with drums.'
      : r.key && !est.usable ? 'No clear key: try a part with chords or a bassline, not just drums.' : '';
  $('#cam-l-warn').hidden = !warn;
  $('#cam-l-warn').textContent = warn;
  // The BPM is reliable enough to apply automatically (Settings → Camelot Wheel); the key is an
  // estimate, so it always waits for its own button.
  const auto = autoApply();
  $('#cam-l-use').hidden = auto || !bpm;
  $('#cam-l-use').textContent = bpm ? `Use ${bpm.toFixed(1)} BPM` : '';
  $('#cam-l-use-key').hidden = !est.usable;
  $('#cam-l-use-key').textContent = est.usable ? `Use key ${keyId(r.key)}` : '';
  $('#cam-l-used').hidden = true;
  if (auto && bpm) useBpm(true);
}

function useBpm(auto = false) {
  apply({ bpm: result.tempo.bpm * factor });
  $('#cam-l-used').textContent = auto ? 'BPM applied to the deck automatically · fader at 0 % · change this in Settings' : 'Deck updated · fader at 0 %';
  $('#cam-l-used').hidden = false;
}

function useKey() {
  apply({ n: result.key.n, mode: result.key.mode });
  $('#cam-l-used').textContent = 'Key set on the deck · fader at 0 %';
  $('#cam-l-used').hidden = false;
}

// ---------- state ----------

function showError(text) {
  setPhase('error');
  $('#cam-listen-error').textContent = `⚠ ${text}`;
}

function setPhase(next) {
  phase = next;
  const btn = $('#cam-listen-btn');
  btn.disabled = phase === 'starting' || phase === 'analysing';
  btn.classList.toggle('danger', phase === 'listening');
  btn.classList.toggle('primary', phase !== 'listening');
  $('#cam-listen-label').textContent = phase === 'listening' ? 'Stop' : phase === 'analysing' ? 'Analysing…' : phase === 'done' ? 'Listen again' : 'Listen';
  $('#cam-listen-device').disabled = phase === 'listening' || phase === 'starting';
  $('#cam-listen-overlay').hidden = !['starting', 'listening', 'analysing'].includes(phase);
  $('#cam-listen-count').hidden = phase !== 'listening';
  $('#cam-listen-state').textContent = phase === 'starting' ? 'Opening the input…' : phase === 'listening' ? 'Listening' : 'Working out tempo and key…';
  $('#cam-listen-quiet').hidden = true;
  $('#cam-listen-error').hidden = phase !== 'error';
  $('#cam-listen-result').hidden = phase !== 'done';
  if (phase === 'done') renderResult();
}

export function initListen(deps) {
  ({ api, call, apply, autoApply, colors, savedInput, saveInput } = deps);
  input = savedInput() || '';
  fillDevices(); // line inputs need no permission, so they're listed straight away
  $('#cam-listen-btn').addEventListener('click', () => (phase === 'listening' ? finish() : start()));
  $('#cam-listen-close').addEventListener('click', () => {
    if (capture) {
      if (capture.line) api.listenStopLine(true); // discard: nothing is analysed
      stop(capture);
      capture = null;
    }
    setPhase('idle');
    $('#cam-listen').hidden = true;
  });
  $('#cam-listen-device').addEventListener('change', (e) => {
    input = e.target.value;
    saveInput(input);
  });
  $('#cam-l-half').addEventListener('click', () => { factor /= 2; renderResult(); });
  $('#cam-l-double').addEventListener('click', () => { factor *= 2; renderResult(); });
  $('#cam-l-use').addEventListener('click', () => useBpm());
  $('#cam-l-use-key').addEventListener('click', () => useKey());
  setPhase('idle');
}
