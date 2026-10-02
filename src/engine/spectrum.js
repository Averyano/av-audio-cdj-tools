// Spectrogram and "is it really hi-res?" maths for the audio analyzer (analyzer.md).
// Pure: takes samples and numbers, returns numbers. analyze.js does the decoding.

export const FFT_SIZE = 4096; // 10.8 Hz bins at 44.1 kHz, 23 Hz at 96 kHz
export const DB_FLOOR = -150; // bottom of the spectrogram's dB range (per FFT bin, full-scale sine = 0 dB)
export const DB_SILENT = -200; // digital silence is clamped here instead of −∞

/** In-place radix-2 FFT. re/im are Float64Array of the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

const toDb = (power) => (power > 1e-20 ? 10 * Math.log10(power) : DB_SILENT);

/**
 * Streaming spectrogram. push() mono samples (−1…1) as they decode; finish() returns
 * - image: Uint8Array rows×columns, row 0 = Nyquist (top), 0 = DB_FLOOR … 255 = 0 dB
 * - spectrum: the long-term average spectrum in dB, one value per FFT bin (0 … Nyquist)
 * Each column averages FFTs spread across its slice of the track: at least `windows`, and
 * enough to cover the whole slice for long tracks (up to 32), so a quiet column isn't one
 * unlucky 90 ms snapshot and no audio is skipped. `totalSamples` only sets the column width;
 * if the real length differs, the column count changes with it.
 */
export class SpectrogramBuilder {
  constructor({ sampleRate, totalSamples, columns = 1024, rows = 512, fftSize = FFT_SIZE, windows = 4 }) {
    this.sampleRate = sampleRate;
    this.n = fftSize;
    this.rows = rows;
    this.hop = Math.max(1, Math.floor((totalSamples || sampleRate * 600) / columns));
    // Windows no further apart than one FFT, so they cover the slice end to end (6:20 at 44.1 kHz
    // is where 4 stopped being enough). Capped for very long files; push() skips the gaps then.
    this.windows = Math.max(windows, Math.min(32, Math.ceil(this.hop / fftSize)));
    this.win = hann(fftSize);
    this.scale = (fftSize / 4) ** 2; // Hann: a full-scale sine peaks at N/4
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.ltas = new Float64Array(fftSize / 2);
    this.ltasCount = 0;
    this.cols = [];
    this.buf = new Float32Array(this.hop + fftSize + 65536);
    this.bufStart = 0; // absolute index of buf[0]
    this.bufLen = 0;
    this.skip = 0; // incoming samples no column needs (only when columns are further apart than their windows)
    this.total = 0;
  }

  push(samples) {
    this.total += samples.length;
    if (this.skip > 0) {
      const k = Math.min(this.skip, samples.length);
      this.skip -= k;
      samples = samples.subarray(k);
      if (!samples.length) return;
    }
    if (this.bufLen + samples.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + samples.length));
      bigger.set(this.buf.subarray(0, this.bufLen));
      this.buf = bigger;
    }
    this.buf.set(samples, this.bufLen);
    this.bufLen += samples.length;
    // A column is ready once its last window is fully buffered.
    while (this.#columnEnd(this.cols.length) <= this.bufStart + this.bufLen) this.#column(this.cols.length);
    // Drop what no future column needs. The next column may start beyond what's buffered (a
    // column wider than its windows): then empty the buffer and skip incoming samples up to it.
    // Dropping more than bufLen here was the 2026-10-01 crash (negative bufLen → RangeError).
    const keepFrom = this.cols.length * this.hop - this.bufStart;
    if (keepFrom >= this.bufLen) {
      this.skip = keepFrom - this.bufLen;
      this.bufStart += keepFrom;
      this.bufLen = 0;
    } else if (keepFrom > 0) {
      this.buf.copyWithin(0, keepFrom, this.bufLen);
      this.bufLen -= keepFrom;
      this.bufStart += keepFrom;
    }
  }

  #windowStart(c, j) {
    return c * this.hop + Math.floor((j * this.hop) / this.windows);
  }

  #columnEnd(c) {
    return this.#windowStart(c, this.windows - 1) + this.n;
  }

  // Average power of this column's windows, zero-padded past the end of the track.
  #column(c) {
    const half = this.n / 2;
    const power = new Float64Array(half);
    let used = 0;
    for (let j = 0; j < this.windows; j++) {
      const start = this.#windowStart(c, j) - this.bufStart;
      if (start >= this.bufLen) break;
      for (let i = 0; i < this.n; i++) {
        const k = start + i;
        this.re[i] = k < this.bufLen ? this.buf[k] * this.win[i] : 0;
        this.im[i] = 0;
      }
      fft(this.re, this.im);
      for (let i = 0; i < half; i++) power[i] += (this.re[i] ** 2 + this.im[i] ** 2) / this.scale;
      used++;
    }
    for (let i = 0; i < half; i++) {
      power[i] /= used || 1;
      this.ltas[i] += power[i];
    }
    this.ltasCount++;
    // Rows: the loudest bin in each band, so narrow tones don't average away.
    const col = new Uint8Array(this.rows);
    const per = half / this.rows;
    for (let r = 0; r < this.rows; r++) {
      let max = 0;
      for (let i = Math.floor(r * per); i < Math.floor((r + 1) * per); i++) if (power[i] > max) max = power[i];
      const t = (toDb(max) - DB_FLOOR) / -DB_FLOOR;
      col[this.rows - 1 - r] = Math.round(255 * Math.min(1, Math.max(0, t)));
    }
    this.cols.push(col);
  }

  finish() {
    while (this.#windowStart(this.cols.length, 0) < this.total) this.#column(this.cols.length);
    const columns = this.cols.length;
    const image = new Uint8Array(this.rows * columns);
    this.cols.forEach((col, c) => {
      for (let r = 0; r < this.rows; r++) image[r * columns + c] = col[r];
    });
    const spectrum = Float32Array.from(this.ltas, (p) => toDb(p / (this.ltasCount || 1)));
    return { columns, rows: this.rows, image, spectrum, totalSamples: this.total, binHz: this.sampleRate / this.n };
  }
}

// Moving average over ±w bins, in power (averaging dB would let the gaps between
// harmonics drag the level down).
function smooth(db, w) {
  const sum = new Float64Array(db.length + 1);
  for (let i = 0; i < db.length; i++) sum[i + 1] = sum[i] + 10 ** (db[i] / 10);
  return Float64Array.from(db, (_, i) => {
    const from = Math.max(0, i - w), to = Math.min(db.length, i + w + 1);
    return toDb((sum[to] - sum[from]) / (to - from));
  });
}

/**
 * Where the audio content stops (analyzer.md → Detection).
 * - cutoff: the highest brick wall, in Hz, or null. Encoders and resamplers leave one: 20+ dB
 *   down within ~800 Hz and staying down to Nyquist. Natural roll-off is gradual and has none.
 * - bandwidth: highest frequency within 45 dB of the 10–16 kHz music level, cliff or not
 * - ultrasonic: for rates above 48 kHz, how much sound 26 kHz … 0.9×Nyquist holds relative to
 *   that level (power mean): 'present' ≥ −40 dB, 'weak' −40…−60, 'absent' below; null under
 *   48 kHz. Upsampled files are near-silent there; ffmpeg's default resampler leaks ~−50 dB.
 */
export function findCutoff(spectrum, binHz) {
  const s = smooth(spectrum, Math.max(1, Math.round(100 / binHz)));
  const bin = (hz) => Math.min(s.length, Math.max(0, Math.round(hz / binHz)));
  const sum = new Float64Array(s.length + 1); // prefix sums: mean of any range in O(1)
  for (let i = 0; i < s.length; i++) sum[i + 1] = sum[i] + s[i];
  const mean = (from, to) => (sum[to] - sum[from]) / Math.max(1, to - from);
  const nyquist = s.length * binHz;
  const reference = mean(bin(10000), bin(16000));

  let bandwidth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] >= reference - 45) {
      bandwidth = Math.min(nyquist, (i + 1) * binHz);
      break;
    }
  }

  let ultrasonic = null;
  if (nyquist > 30000) {
    let p = 0;
    const from = bin(26000), to = bin(nyquist * 0.9);
    for (let i = from; i < to; i++) p += 10 ** (s[i] / 10);
    const rel = toDb(p / (to - from)) - reference;
    ultrasonic = rel >= -40 ? 'present' : rel >= -60 ? 'weak' : 'absent';
  }

  const lo = bin(1000);
  const gap = bin(400); // the edge has to fall within this distance…
  const span = bin(800); // …between the levels compared on each side
  for (let i = s.length - 1 - gap - span; i >= lo + gap + span; i--) {
    const below = mean(i - gap - span, i - gap);
    if (below - mean(i + gap, i + gap + span) < 20 || below - mean(i + gap, s.length) < 15) continue;
    // The first window that trips the test straddles the wall, so take the music level one
    // window further down. The content stops at the last bin within 6 dB of it; a looser
    // margin lands on a slow resampler's skirt (ffmpeg's default one fades over ~4 kHz).
    const level = mean(Math.max(lo, i - gap - 2 * span), i - gap - span);
    let edge = i - gap;
    for (let k = i + gap; k >= i - gap - span; k--) {
      if (s[k] >= level - 6) {
        edge = k;
        break;
      }
    }
    return { cutoff: edge * binHz, bandwidth: Math.min(bandwidth, (edge + 1) * binHz), ultrasonic, reference };
  }
  return { cutoff: null, bandwidth, ultrasonic, reference };
}

const kHz = (hz) => `${(hz / 1000).toFixed(1)} kHz`;

// LAME's default low-pass per bitrate (lame.c → optimum_bandwidth → freq_map), kbps → Hz.
// Measured walls of real LAME output sit at these or up to ~0.9 kHz above (analyzer.md).
export const LAME_LOWPASS = [[96, 15100], [112, 15600], [128, 17000], [160, 17500], [192, 18600], [224, 19400], [256, 19700], [320, 20500]];
export const LOSSY_BELOW = 19000; // a wall below this: made from a lossy file
export const MAYBE_BELOW = 20600; // a wall below this: possibly (high-bitrate MP3 cut here, so do some CD masters)

/** "128 kbps", "256–320 kbps" or "under 96 kbps": MP3 bitrates whose low-pass is within 600 Hz of the wall. */
export function likelyBitrate(cutoff) {
  const near = LAME_LOWPASS.filter(([, hz]) => Math.abs(hz - cutoff) <= 600).map(([kbps]) => kbps);
  if (!near.length) return cutoff < LAME_LOWPASS[0][1] ? `under ${LAME_LOWPASS[0][0]} kbps` : null;
  return near.length === 1 ? `${near[0]} kbps` : `${near[0]}–${near.at(-1)} kbps`;
}

const codecName = (codec) => (/layer 3/i.test(codec ?? '') ? 'MP3' : codec);

// Shared by both verdicts: what the file is, and any sign it came from a lossy file.
function evidence(format, usedBits, edge) {
  const { codec, lossless, sampleRate: sr, bits } = format;
  const padded = lossless !== false && bits > 16 && usedBits != null && usedBits <= 16;
  const lossy = edge.cutoff != null && edge.cutoff < LOSSY_BELOW;
  const maybe = edge.cutoff != null && !lossy && edge.cutoff < MAYBE_BELOW;
  // A wall at or below 26 kHz means a 44.1/48 kHz origin: real hi-res anti-alias walls sit at
  // 40 kHz and up, and a slow resampler's skirt can push the measured edge past 24 kHz.
  const upsampled = sr > 48000 && (edge.cutoff != null ? edge.cutoff <= 26000 : edge.ultrasonic === 'absent');
  const rate = likelyBitrate(edge.cutoff ?? 0);
  return {
    lossyFile: lossless === false ? { tone: 'info', title: `Lossy file${codec ? ` (${codecName(codec)})` : ''}, not lossless`, notes: [`Content stops at ${kHz(edge.cutoff ?? edge.bandwidth)}.`] } : null,
    lossy: lossy && {
      tone: 'bad',
      title: 'Made from an MP3, not real lossless',
      notes: [`Sharp cutoff at ${kHz(edge.cutoff)}${rate ? `, where an MP3 at about ${rate} stops` : ''}. Real lossless audio keeps going to 20–22 kHz.`],
    },
    maybe: maybe && {
      tone: 'warn',
      title: 'Possibly made from a high-bitrate MP3',
      notes: [`Sharp cutoff at ${kHz(edge.cutoff)}, like an MP3 at roughly ${rate ?? '256–320 kbps'}. Some CD masters are filtered here too, so compare with another copy if you can.`],
    },
    padded,
    paddedNote: `${bits}-bit file, but only ${usedBits} bits carry sound: padded from a ${usedBits}-bit source.`,
    upsampled,
    realBits: bits > 16 && !padded,
  };
}

/**
 * Default verdict: is this really lossless, or made from an MP3/AAC? (analyzer.md → Verdicts)
 * tone: 'ok' real lossless · 'warn' possibly from a high-bitrate MP3 · 'bad' made from one ·
 * 'info' a lossy file in the first place. A hi-res file upsampled from CD audio, or 16-bit audio
 * padded to 24, is still real lossless; a note says so.
 */
export function losslessVerdict(format, usedBits, edge) {
  const e = evidence(format, usedBits, edge);
  if (e.lossyFile) return e.lossyFile;
  const extra = [];
  if (e.upsampled) extra.push(`Stored at ${kHz(format.sampleRate)}, but the sound stops at ${kHz(edge.cutoff ?? 24000)}: upsampled from CD quality. Still lossless, just not hi-res.`);
  if (e.padded) extra.push(e.paddedNote);
  if (e.lossy) return { ...e.lossy, notes: [...e.lossy.notes, ...extra] };
  if (e.maybe) return { ...e.maybe, notes: [...e.maybe.notes, ...extra] };
  const top = edge.cutoff ?? edge.bandwidth;
  let main;
  if (e.upsampled) main = 'No sign of MP3/AAC.'; // the upsampling note below gives the numbers
  else if (edge.cutoff != null) main = `No sign of MP3/AAC: the sound runs up to ${kHz(top)}, above where MP3s cut off.`;
  else if (top < 16000) main = `Little above ${kHz(top)}, but it fades out gradually instead of stopping at a hard edge, like an old or lo-fi recording. No sign of MP3/AAC.`;
  else main = `No sign of MP3/AAC: the sound runs up to ${kHz(top)} without a hard cutoff.`;
  return { tone: 'ok', title: 'Real lossless', notes: [main, ...extra] };
}

/**
 * Optional stricter verdict (Settings → Audio Analyzer → hi-res): on top of the lossy checks,
 * a file above 48 kHz must hold real sound above 24 kHz, and "24-bit" must use its bits.
 * tone: 'ok' genuine hi-res · 'info' honest but not hi-res · 'warn' doubtful · 'bad' fake.
 */
export function hiresVerdict(format, usedBits, edge) {
  const { sampleRate: sr, bits } = format;
  const e = evidence(format, usedBits, edge);
  const band = edge.cutoff ?? edge.bandwidth;
  const notes = e.padded ? [e.paddedNote] : [];
  if (e.lossyFile) return { ...e.lossyFile, title: `${e.lossyFile.title}, so not hi-res` };
  if (e.lossy) return { ...e.lossy, notes: [...e.lossy.notes, ...notes] };
  if (e.upsampled) {
    return {
      tone: 'bad',
      title: 'Upsampled, not real hi-res',
      notes: [
        edge.cutoff != null
          ? `Nothing above ${kHz(edge.cutoff)} although the file could hold up to ${kHz(sr / 2)}. It was likely made from a 44.1 or 48 kHz master.`
          : `No sound above 24.5 kHz although the file could hold up to ${kHz(sr / 2)}: likely upsampled, or a hi-res transfer of a source with nothing up there.`,
        ...notes,
      ],
    };
  }
  // Lossy evidence outranks bit depth: an MP3 converted with ffmpeg comes out as a 24-bit FLAC.
  if (e.maybe) return { ...e.maybe, notes: [...e.maybe.notes, ...notes] };
  if (sr > 48000 && edge.cutoff == null && edge.ultrasonic === 'weak') {
    return {
      tone: 'warn',
      title: 'Little sound above 24 kHz',
      notes: ['The ultrasonic band is 40–60 dB below the music: maybe upsampled with a leaky filter, or a hi-res recording with little up there.', ...notes],
    };
  }
  if (sr > 48000) {
    return e.realBits
      ? { tone: 'ok', title: 'Genuine hi-res', notes: [`Real content up to ${kHz(band)}.`, ...notes] }
      : { tone: 'warn', title: 'Hi-res sample rate, CD bit depth', notes: [`Real content up to ${kHz(band)}.`, ...notes] };
  }
  if (e.realBits) return { tone: 'ok', title: `Real ${bits}-bit at ${sr / 1000} kHz`, notes: [`Content up to ${kHz(band)}; the sample rate is CD-class.`, ...notes] };
  return { tone: 'info', title: 'CD quality, not hi-res', notes: [`Full band for its rate: content up to ${kHz(band)}.`, ...notes] };
}

/** Both verdicts, so the page can switch between them without decoding again. */
export const verdicts = (format, usedBits, edge) => ({ lossless: losslessVerdict(format, usedBits, edge), hires: hiresVerdict(format, usedBits, edge) });

/** Bits that carry signal, from the OR of every sample as 32-bit integers (24-bit audio arrives << 8). */
export function usedBitsFromOr(or) {
  if (or === 0) return 0;
  let tz = 0;
  while (((or >>> tz) & 1) === 0) tz++;
  return 32 - tz;
}
