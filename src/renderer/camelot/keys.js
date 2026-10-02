// Camelot key colours, shared by the deck view and Listen. They follow the classic Camelot wheel
// (1 = green … 8 = red …). OKLCH keeps every key at the same lightness, so onyx text reads on all
// of them; B (major, outer ring) is lighter.
const HUES = [152, 195, 245, 264, 290, 328, 355, 29, 55, 110, 128, 142];
export const keyColor = ({ n, mode }) => `oklch(${mode === 'B' ? 0.84 : 0.75} 0.13 ${HUES[n - 1]})`;

/**
 * Copy for a detected key (engine tempokey.js → estimateKey), shared by Listen and the analyzer.
 * It's an estimate: on the user's library it matched rekordbox about half the time
 * (camelot.md → Library check). usable: worth a "Use key" button; with no clear key the best guess
 * is only mentioned.
 */
export function keyEstimate(key) {
  if (!key) return { chip: '—', name: 'no key found', note: '', usable: false };
  const other = `or ${key.runnerUp.camelot} ${key.runnerUp.name}`;
  if (key.confidence === 'likely') return { chip: key.camelot, name: key.name, note: 'likely', usable: true };
  if (key.confidence === 'possible') return { chip: key.camelot, name: key.name, note: `possible · ${other}`, usable: true };
  return { chip: '?', name: 'no clear key', note: `best guess ${key.camelot} ${key.name}, ${other}`, usable: false };
}

/** Beat copy from a tempo's clarity, shared by Listen and the analyzer. */
export const beatNote = (clarity) => (clarity >= 0.5 ? 'steady beat' : clarity >= 0.25 ? 'beat found, some doubt' : 'no clear beat');
