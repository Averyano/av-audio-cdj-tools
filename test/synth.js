// Deterministic synthetic "tracks" for the Listen tests: drums at a known tempo plus chords in
// a known key, optionally detuned. Not a test file itself (no side effects on import).

const midiHz = (m, cents = 0) => 440 * 2 ** ((m - 69) / 12 + cents / 1200);

// mulberry32: a real 32-bit PRNG in −1…1 (a float LCG with a big multiplier loses precision and repeats).
export function noise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

export const PATTERNS = {
  // beat positions within a 4-beat bar
  house: { kick: [0, 1, 2, 3], snare: [1, 3], hat: [0.5, 1.5, 2.5, 3.5] },
  breaks: { kick: [0, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
};

export const PROGRESSIONS = {
  'A minor': [[45, 57, 60, 64], [38, 62, 65, 69], [40, 52, 56, 59], [45, 57, 60, 64]],
  'C major': [[36, 60, 64, 67], [41, 53, 57, 60], [43, 55, 59, 62], [36, 60, 64, 67]],
  'F# minor': [[42, 54, 57, 61], [47, 59, 62, 66], [49, 61, 64, 68], [42, 54, 57, 61]],
};

export function synthTrack({ bpm, pattern, progression, cents = 0, seconds = 10, sr = 48000, seed = 1 }) {
  const rand = noise(seed);
  const out = new Float32Array(Math.round(seconds * sr));
  const beat = 60 / bpm;
  const add = (t0, dur, fn) => {
    const i0 = Math.round(t0 * sr);
    for (let i = 0; i < dur * sr && i0 + i < out.length; i++) out[i0 + i] += fn(i / sr);
  };
  const p = PATTERNS[pattern];
  for (let bar = 0; bar * 4 * beat < seconds; bar++) {
    const t = bar * 4 * beat;
    for (const b of p.kick) add(t + b * beat, 0.18, (x) => 0.7 * Math.exp(-x * 25) * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-x * 40)) * x));
    for (const b of p.snare) add(t + b * beat, 0.15, (x) => 0.3 * Math.exp(-x * 30) * rand());
    for (const b of p.hat) {
      let prev = 0;
      add(t + b * beat, 0.04, (x) => { const n = rand(); const v = 0.12 * Math.exp(-x * 120) * (n - prev); prev = n; return v; });
    }
    // One chord per bar: bass note (louder) + three chord tones with two harmonics each.
    const chord = PROGRESSIONS[progression][bar % 4];
    add(t, 4 * beat, (x) => {
      const env = Math.min(1, x * 50) * Math.exp(-x * 0.3);
      let v = 0;
      chord.forEach((m, i) => {
        const f = midiHz(m, cents), a = i === 0 ? 0.12 : 0.06;
        v += a * (Math.sin(2 * Math.PI * f * x) + 0.5 * Math.sin(4 * Math.PI * f * x) + 0.25 * Math.sin(6 * Math.PI * f * x));
      });
      return env * v;
    });
  }
  return out;
}
