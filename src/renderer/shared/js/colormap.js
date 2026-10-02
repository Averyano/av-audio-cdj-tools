// Spectrogram colour scales, shared by the analyzer and Listen
// (Settings → Audio Analyzer → Spectrogram colours; analyzer.md → UI).
// - 'color': the classic spectral scale most audio tools use, black → blue → cyan → green →
//   yellow → red → magenta → white. Data colours, the same in every theme, like the key colours.
// - 'grayscale': the theme's --spectro-low → --spectro-high, one neutral ramp.

const SPECTRAL = [
  [0, '#000000'],
  [0.14, '#00006e'],
  [0.28, '#0000ff'],
  [0.42, '#00c8ff'],
  [0.54, '#00ff40'],
  [0.66, '#ffff00'],
  [0.78, '#ff2000'],
  [0.9, '#ff00ff'],
  [1, '#ffffff'],
];

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Any CSS colour → [r, g, b], resolved by a canvas so tokens may use any syntax. */
export function rgb(color) {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/** [[position 0…1, CSS colour], …] for a mode. */
export function stops(mode) {
  return mode === 'color' ? SPECTRAL : [[0, token('--spectro-low')], [1, token('--spectro-high')]];
}

/** 256 [r, g, b] entries: quiet (0) … loud (255). */
export function lut(mode) {
  const s = stops(mode).map(([at, color]) => [at, rgb(color)]);
  return Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    const hi = s.findIndex(([at]) => at >= t);
    if (hi <= 0) return s[Math.max(0, hi)][1];
    const [a, ca] = s[hi - 1], [b, cb] = s[hi];
    const f = (t - a) / (b - a);
    return ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
  });
}

/** The same scale as a CSS gradient, for legends. */
export const gradient = (mode) => `linear-gradient(90deg, ${stops(mode).map(([at, color]) => `${color} ${at * 100}%`).join(', ')})`;
