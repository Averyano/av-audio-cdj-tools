// App preferences. The Settings page is drawn from PREF_SECTIONS, and settings.json keeps the
// values under `prefs.<section id>.<key>`. No imports at all: main sanitizes with it and the
// renderer draws from it (decision D25). Adding a preference = one entry here.

export const PREF_SECTIONS = [
  {
    id: 'analyzer',
    title: 'Audio Analyzer',
    prefs: [
      {
        key: 'checkHiRes',
        type: 'toggle',
        default: false,
        label: 'Also check hi-res claims',
        hint: 'Off: the verdict answers one question: is this really lossless, or made from an MP3? On: files at 88.2 kHz and up must also hold real sound above 24 kHz, so CD audio upsampled to "hi-res" is called out.',
      },
      {
        key: 'spectrogramColors',
        type: 'choice',
        default: 'color',
        options: [{ value: 'color', label: 'Color' }, { value: 'grayscale', label: 'Grayscale' }],
        label: 'Spectrogram colours',
        hint: 'Color uses the classic spectral scale most audio tools use (blue → green → yellow → red → white), which makes small level differences easier to spot. Grayscale matches the app. Also used by Listen.',
      },
    ],
  },
  {
    id: 'camelot',
    title: 'Camelot Wheel',
    prefs: [
      {
        key: 'autoApplyListen',
        type: 'toggle',
        default: false,
        label: 'Automatically apply analyzed BPM to Camelot wheel',
        hint: 'After Listen, the detected BPM goes straight onto the deck, fader at 0 %. The key is only an estimate, so it always waits for "Use key …". When off, the BPM waits for "Use … BPM" too.',
      },
    ],
  },
];

// One cleaner per pref type: keep a valid value, otherwise fall back to the default.
const CLEAN = {
  toggle: (value, fallback) => (typeof value === 'boolean' ? value : fallback),
  choice: (value, fallback, pref) => (pref.options.some((o) => o.value === value) ? value : fallback),
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every section and pref from the schema, each value validated; unknown keys are dropped. */
export function sanitizePrefs(raw) {
  const src = isObject(raw) ? raw : {};
  return Object.fromEntries(PREF_SECTIONS.map((section) => {
    const values = Object.hasOwn(src, section.id) && isObject(src[section.id]) ? src[section.id] : {};
    return [section.id, Object.fromEntries(section.prefs.map((p) => [p.key, CLEAN[p.type](Object.hasOwn(values, p.key) ? values[p.key] : undefined, p.default, p)]))];
  }));
}

export const PREF_DEFAULTS = sanitizePrefs({});
