import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Builds a small fake library with ffmpeg: tagged FLACs with cover art, hi-res
// sources, WAV variants, ALAC and AAC .m4a, awkward names, a name clash, junk and a broken file.

function ff(bin, args) {
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`);
}

const sine = (rate, seconds = 2, channels = 2) => [
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`,
  ...(channels > 1 ? ['-ac', String(channels)] : []),
];

export const FIXTURES = {
  tagged: 'Techno/2024/Artist - Track One.flac',
  hires96: 'Techno/2024/HiRes 96k.flac',
  hires88: 'House/Deep/Track 88k.flac',
  wav24: 'House/Deep/Wave 24.wav',
  wavFloat: 'House/Float 32.wav',
  // ':' and '?' can't be created on Windows; there the name only tests unicode.
  weird: process.platform === 'win32' ? 'Ünïcödé Földer/Tëst What.flac' : 'Ünïcödé Földer/Tëst: What?.flac',
  clashFlac: 'Clash/Same.flac',
  clashWav: 'Clash/Same.wav',
  surround: 'Multi/Six Channel.flac',
  alac: 'Apple/Hi-Res ALAC.m4a', // 96 kHz: above the 16-bit rate field of an MP4 sample entry
  aac: 'Apple/Lossy.m4a',
  mp3: 'Other/song.mp3',
  junk: 'Other/._junk.flac',
  broken: 'Other/broken.flac',
  image: 'Other/cover.jpg',
};

export async function makeLibrary(root, bin) {
  const p = (rel) => path.join(root, ...rel.split('/'));
  for (const rel of Object.values(FIXTURES)) await fs.mkdir(path.dirname(p(rel)), { recursive: true });

  const cover = path.join(root, '..', `cover-${Date.now()}.png`);
  ff(bin, ['-f', 'lavfi', '-i', 'color=c=orange:s=200x200:d=1', '-frames:v', '1', cover]);

  ff(bin, [...sine(44100), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata:s:v', 'comment=Cover (front)', '-c:a', 'flac', '-sample_fmt', 's16',
    '-metadata', 'TITLE=Track One', '-metadata', 'ARTIST=Àrtist Ñame', '-metadata', 'ALBUM=Test EP',
    '-metadata', 'BPM=128', '-metadata', 'INITIALKEY=8A', '-metadata', 'LABEL=Test Label',
    '-metadata', 'COMMENT=Energy 7', '-metadata', 'DATE=2024-05-03', '-metadata', 'TRACKNUMBER=1',
    '-metadata', 'GENRE=Techno', p(FIXTURES.tagged)]);
  ff(bin, [...sine(96000), '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-metadata', 'TITLE=HiRes', p(FIXTURES.hires96)]);
  ff(bin, [...sine(88200), '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', p(FIXTURES.hires88)]);
  ff(bin, [...sine(48000), '-c:a', 'pcm_s24le', p(FIXTURES.wav24)]);
  ff(bin, [...sine(44100), '-c:a', 'pcm_f32le', p(FIXTURES.wavFloat)]);
  ff(bin, [...sine(44100), '-c:a', 'flac', '-metadata', 'TITLE=Weird', p(FIXTURES.weird)]);
  ff(bin, [...sine(44100), '-c:a', 'flac', p(FIXTURES.clashFlac)]);
  ff(bin, [...sine(44100), '-c:a', 'pcm_s16le', p(FIXTURES.clashWav)]);
  ff(bin, [...sine(48000, 2, 6), '-c:a', 'flac', p(FIXTURES.surround)]);
  ff(bin, [...sine(44100), '-c:a', 'libmp3lame', '-b:a', '128k', p(FIXTURES.mp3)]);
  ff(bin, [...sine(96000), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-c:a', 'alac', '-sample_fmt', 's32p', '-ac', '2', '-metadata', 'title=Apple Track', '-metadata', 'artist=Àpple', p(FIXTURES.alac)]);
  ff(bin, [...sine(44100), '-c:a', 'aac', '-b:a', '128k', p(FIXTURES.aac)]);
  await fs.writeFile(p(FIXTURES.junk), Buffer.alloc(4096, 7));
  await fs.writeFile(p(FIXTURES.broken), Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(100, 1)]));
  await fs.writeFile(p(FIXTURES.image), Buffer.alloc(100, 2));
  await fs.rm(cover, { force: true });
}
