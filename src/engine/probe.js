import fs from 'node:fs/promises';
import { parseFile } from 'music-metadata';

/**
 * Reads stream info only (no covers). Fast: FLAC/WAV/AIFF headers give exact
 * duration without decoding. Result is cached in the manifest per size+mtime.
 */
export async function probeFile(abs) {
  const { format } = await parseFile(abs, { skipCovers: true, duration: false, skipPostHeaders: true });
  const probe = {
    container: format.container ?? null,
    codec: format.codec ?? null,
    sampleRate: format.sampleRate || null,
    bits: format.bitsPerSample ?? null,
    channels: format.numberOfChannels ?? null,
    duration: format.duration ?? null,
    lossless: format.lossless ?? null,
  };
  if (probe.codec === 'ALAC' && !probe.sampleRate) probe.sampleRate = (await alacCookie(abs))?.sampleRate || null;
  return probe;
}

// An MP4 sample entry stores the rate in 16 bits, so music-metadata reads ALAC above 65535 Hz
// (88.2k, 96k, 192k) as 0. The ALAC magic cookie, a 36-byte 'alac' box inside that sample
// entry, has the real 32-bit rate. moov can sit at either end of the file, so walk the
// top-level boxes to it and read only moov.
const COOKIE = Buffer.from([0, 0, 0, 36, 0x61, 0x6c, 0x61, 0x63]); // size 36, 'alac'
const MOOV_MAX = 64 * 1024 * 1024;

export async function alacCookie(abs) {
  const fh = await fs.open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    for (let pos = 0; pos + 8 <= size;) {
      await fh.read(head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      let hdr = 8;
      if (len === 1) [len, hdr] = [Number(head.readBigUInt64BE(8)), 16];
      else if (len === 0) len = size - pos; // runs to the end of the file
      if (len < hdr) return null;
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (len > MOOV_MAX) return null;
        const moov = Buffer.alloc(len);
        await fh.read(moov, 0, len, pos);
        const at = moov.indexOf(COOKIE);
        if (at < 0 || at + 36 > len) return null;
        // 4 bytes version/flags, then ALACSpecificConfig: frameLength u32, compatibleVersion u8,
        // bitDepth u8, pb, mb, kb, numChannels u8, maxRun u16, maxFrameBytes u32, avgBitRate u32, sampleRate u32
        return { bits: moov[at + 17], channels: moov[at + 21], sampleRate: moov.readUInt32BE(at + 32) };
      }
      pos += len;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Full parse for conversion time: tags + embedded pictures. */
export async function readTags(abs) {
  const { common, native } = await parseFile(abs, { skipCovers: false, duration: false });
  return { common, native };
}

/** Stream info of a written AIFF, used to verify the result before it replaces anything. */
export async function inspectOutput(abs) {
  const { format, common } = await parseFile(abs, { skipCovers: true, duration: false });
  return {
    container: format.container,
    sampleRate: format.sampleRate,
    bits: format.bitsPerSample,
    channels: format.numberOfChannels,
    duration: format.duration,
    common,
  };
}
