import fs from 'node:fs/promises';

// Minimal ID3v2.3 writer. v2.3 is what rekordbox and older CDJs read most
// reliably; text is Latin-1 when possible, otherwise UTF-16 with BOM.

const isLatin1 = (s) => /^[\u0000-ÿ]*$/.test(s);

function encodeText(s) {
  if (isLatin1(s)) return { enc: 0, bytes: Buffer.from(s, 'latin1'), term: Buffer.alloc(1) };
  return { enc: 1, bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]), term: Buffer.alloc(2) };
}

function frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4); // v2.3 frame sizes are plain big-endian
  return Buffer.concat([head, body]);
}

function textFrame(id, value) {
  const t = encodeText(value);
  return frame(id, Buffer.concat([Buffer.from([t.enc]), t.bytes]));
}

// COMM and TXXX carry a description + value; both must share one encoding.
function describedFrame(id, description, value, withLang) {
  const utf16 = !isLatin1(description) || !isLatin1(value);
  const enc = (s) => (utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]) : Buffer.from(s, 'latin1'));
  const term = Buffer.alloc(utf16 ? 2 : 1);
  const parts = [Buffer.from([utf16 ? 1 : 0])];
  if (withLang) parts.push(Buffer.from('eng', 'latin1'));
  parts.push(enc(description), term, enc(value));
  return frame(id, Buffer.concat(parts));
}

function apicFrame(picture) {
  const mime = picture.format || 'image/jpeg';
  return frame('APIC', Buffer.concat([
    Buffer.from([0]),
    Buffer.from(mime, 'latin1'), Buffer.alloc(1),
    Buffer.from([3]), // picture type 3 = front cover
    Buffer.alloc(1), // empty description
    Buffer.from(picture.data),
  ]));
}

function synchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/**
 * frames: [[id, value]] — 'T***' ids become text frames, 'COMM' a comment,
 * anything else a TXXX with that description. picture: {format, data} | null.
 */
export function encodeId3v23(frames, picture = null) {
  const bodies = frames.map(([id, value]) => {
    if (id === 'COMM') return describedFrame('COMM', '', value, true);
    if (/^T[A-Z0-9]{3}$/.test(id) && id !== 'TXXX') return textFrame(id, value);
    return describedFrame('TXXX', id, value, false);
  });
  if (picture?.data?.length) bodies.push(apicFrame(picture));
  const body = Buffer.concat(bodies);
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(body.length)]);
  return Buffer.concat([header, body]);
}

/**
 * Appends an IFF chunk to an AIFF file and fixes the FORM size.
 * Chunk bodies are padded to even length (pad byte not counted in the size).
 */
export async function appendAiffChunk(file, chunkId, data) {
  const fh = await fs.open(file, 'r+');
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'FORM' || head.toString('latin1', 8, 12) !== 'AIFF') {
      throw new Error('Not a plain AIFF file');
    }
    const { size } = await fh.stat();
    const chunkHead = Buffer.alloc(8);
    chunkHead.write(chunkId, 0, 'latin1');
    chunkHead.writeUInt32BE(data.length, 4);
    const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const chunk = Buffer.concat([chunkHead, data, pad]);
    const start = size + (size % 2); // chunks start on even offsets
    if (start !== size) await fh.write(Buffer.alloc(1), 0, 1, size);
    await fh.write(chunk, 0, chunk.length, start);
    const formSize = Buffer.alloc(4);
    formSize.writeUInt32BE(start + chunk.length - 8);
    await fh.write(formSize, 0, 4, 4);
  } finally {
    await fh.close();
  }
}
