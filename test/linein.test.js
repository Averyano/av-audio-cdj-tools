import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { parseCoreAudio, parseAvfoundationList, channelChoices, captureLine, LINE_RATE } from '../src/engine/linein.js';
import { analyzeClip } from '../src/engine/tempokey.js';

// Real outputs from a Mac with a Scarlett 6i6 (2026-10-01), trimmed.
const PROFILE = JSON.stringify({ SPAudioDataType: [{ _name: 'coreaudio_device', _items: [
  { _name: 'BenQ PD2700U', coreaudio_device_transport: 'coreaudio_device_type_displayport' },
  { _name: 'Scarlett 6i6 USB', coreaudio_device_input: 6, coreaudio_device_manufacturer: 'Focusrite' },
  { _name: 'MacBook Pro Microphone', coreaudio_device_input: 1 },
  { _name: 'Camo Microphone', coreaudio_device_input: 2 },
] }] });
const LIST = `[AVFoundation indev @ 0x156b06b60] AVFoundation video devices:
[AVFoundation indev @ 0x156b06b60] [0] FaceTime HD Camera
[AVFoundation indev @ 0x156b06b60] AVFoundation audio devices:
[AVFoundation indev @ 0x156b06b60] [0] Microsoft Teams Audio
[AVFoundation indev @ 0x156b06b60] [1] MacBook Pro Microphone
[AVFoundation indev @ 0x156b06b60] [2] Scarlett 6i6 USB
[AVFoundation indev @ 0x156b06b60] [3] Averyano 🌿 Microphone
: Input/output error`;

test('linein: parse Core Audio channel counts and the AVFoundation device list', () => {
  assert.deepEqual(parseCoreAudio(PROFILE), [
    { name: 'Scarlett 6i6 USB', channels: 6 }, { name: 'MacBook Pro Microphone', channels: 1 }, { name: 'Camo Microphone', channels: 2 },
  ]);
  assert.deepEqual(parseAvfoundationList(LIST), [
    { index: 0, name: 'Microsoft Teams Audio' }, { index: 1, name: 'MacBook Pro Microphone' },
    { index: 2, name: 'Scarlett 6i6 USB' }, { index: 3, name: 'Averyano 🌿 Microphone' },
  ], 'video devices are not audio devices');
});

test('linein: inputs offered as pairs', () => {
  assert.deepEqual(channelChoices(6).map((c) => c.label), ['1/2', '3/4', '5/6']);
  assert.deepEqual(channelChoices(6)[1].channels, [2, 3]);
  assert.deepEqual(channelChoices(5).map((c) => [c.label, c.channels]), [['1/2', [0, 1]], ['3/4', [2, 3]], ['5', [4]]]);
});

// A 4-channel source with a tone only on inputs 3/4, like CDJs on a Scarlett's line inputs.
const quad = { format: 'lavfi', device: 'aevalsrc=0|0|0.5*sin(2*PI*440*t)|0.5*sin(2*PI*440*t):s=44100' };
const rms = (x) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length + 1e-20);

test('linein: records only the chosen pair, at the line rate, with live columns', async () => {
  const columns = [];
  const r = await captureLine({ ffmpegPath, input: quad, channels: [2, 3], seconds: 1.5, onColumn: (rows, level) => columns.push([rows, level]) });
  assert.equal(r.sampleRate, LINE_RATE);
  assert.ok(Math.abs(r.samples.length - 1.5 * LINE_RATE) < LINE_RATE * 0.05, `samples ${r.samples.length}`);
  assert.ok(rms(r.samples) > -12, `inputs 3/4 rms ${rms(r.samples)}`);
  assert.ok(columns.length >= 25 && columns[0][0].length === 160, `columns ${columns.length}`);
  assert.ok(columns.at(-1)[1] > -12, 'level reported with each column');
  const quiet = await captureLine({ ffmpegPath, input: quad, channels: [0, 1], seconds: 0.5 });
  assert.equal(rms(quiet.samples), -200, 'inputs 1/2 are silent');
});

test('linein: stopping early keeps what came in; a missing channel rejects', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const real = { format: 'lavfi', device: 'aevalsrc=0|0|0.5*sin(2*PI*440*t)|0.5*sin(2*PI*440*t):s=44100,arealtime' };
  const r = await captureLine({ ffmpegPath, input: real, channels: [2, 3], seconds: 10, signal: ac.signal });
  assert.ok(r.samples.length > 0 && r.samples.length < 2 * LINE_RATE, `samples ${r.samples.length}`);
  await assert.rejects(captureLine({ ffmpegPath, input: quad, channels: [6, 7], inputChannels: 4, seconds: 0.5 }), /has 4 channels/);
  await assert.rejects(captureLine({ ffmpegPath, input: quad, channels: [], seconds: 0.5 }), /pick another pair/);
});

test('linein: dropped device buffers come back as silence, so the tempo stays right', async () => {
  // AVFoundation loses ~12 % of its 512-sample buffers but keeps their timestamps. Without
  // filling the holes, a 130 BPM take was squeezed and read ~149 (2026-10-01, Scarlett 6i6).
  const beat = '0.01*sin(2*PI*997*t)+0.8*exp(-25*mod(t\\,60/130))*sin(2*PI*55*t)';
  const dropping = { format: 'lavfi', device: `aevalsrc=0|0|${beat}|${beat}:s=48000:d=8,asetnsamples=n=512,aselect=gte(random(0)\\,0.12)` };
  const r = await captureLine({ ffmpegPath, input: dropping, channels: [2, 3], seconds: 10 });
  assert.ok(Math.abs(r.samples.length - 8 * LINE_RATE) < LINE_RATE * 0.05, `${(r.samples.length / LINE_RATE).toFixed(2)} s of 8`);
  const { tempo } = analyzeClip(r.samples, r.sampleRate);
  assert.ok(Math.abs(tempo.bpm - 130) <= 0.5, `bpm ${tempo.bpm}`);
  assert.ok(tempo.clarity >= 0.5, `clarity ${tempo.clarity}`);
});

test('linein: a start AVFoundation rejects is retried; other failures are not', { skip: process.platform === 'win32' && 'needs a shell script as ffmpeg' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audioconverter-linein-'));
  const fake = async (name, fails, message) => {
    const script = path.join(dir, name);
    const count = path.join(dir, `${name}.count`);
    await fs.writeFile(script, `#!/bin/sh
n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n + 1)) > "${count}"
if [ "$n" -lt ${fails} ]; then echo "${message}" >&2; echo ":2: Input/output error" >&2; exit 1; fi
exec "${ffmpegPath}" "$@"
`, { mode: 0o755 });
    return { script, calls: async () => Number(await fs.readFile(count, 'utf8')) };
  };
  try {
    const flaky = await fake('flaky', 2, '[avfoundation @ 0x1] audio format is not supported');
    const r = await captureLine({ ffmpegPath: flaky.script, input: quad, channels: [2, 3], seconds: 0.5 });
    assert.ok(r.samples.length > 0.4 * LINE_RATE, 'recorded on the third start');
    assert.equal(await flaky.calls(), 3);
    const denied = await fake('denied', 1, 'Permission denied');
    await assert.rejects(captureLine({ ffmpegPath: denied.script, input: quad, channels: [2, 3], seconds: 0.5 }), /Input\/output error/);
    assert.equal(await denied.calls(), 1, 'not retried');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
