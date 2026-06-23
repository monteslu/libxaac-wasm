/**
 * Unit tests for the pure-JS MP4 wrapper. These run with NO wasm build, so CI
 * can validate the container logic even before the encoder is compiled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapAccessUnitsToMp4 } from '../src/mp4.js';

// Read a big-endian box header at offset; return { size, type, dataOffset }.
function readBox(buf, off) {
  const size = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
  const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  return { size, type, dataOffset: off + 8 };
}

// Find a top-level box by type.
function findTop(buf, type) {
  let off = 0;
  while (off + 8 <= buf.length) {
    const b = readBox(buf, off);
    if (b.type === type) return b;
    off += b.size;
  }
  return null;
}


function fakeAUs(count, size) {
  return Array.from({ length: count }, (_, i) =>
    Uint8Array.from({ length: size }, () => (i * 31 + 7) & 0xff)
  );
}

test('produces ftyp + mdat + moov in order', () => {
  const aus = fakeAUs(10, 100);
  const mp4 = wrapAccessUnitsToMp4(aus, { sampleRate: 44100, channels: 2 });
  const ftyp = findTop(mp4, 'ftyp');
  const mdat = findTop(mp4, 'mdat');
  const moov = findTop(mp4, 'moov');
  assert.ok(ftyp, 'has ftyp');
  assert.ok(mdat, 'has mdat');
  assert.ok(moov, 'has moov');
  assert.ok(ftyp.size > 0 && mdat.size > 0 && moov.size > 0);
});

test('mdat payload equals concatenated access units', () => {
  const aus = fakeAUs(5, 64);
  const mp4 = wrapAccessUnitsToMp4(aus, { sampleRate: 48000, channels: 1 });
  const mdat = findTop(mp4, 'mdat');
  const payload = mp4.subarray(mdat.dataOffset, mdat.dataOffset + (mdat.size - 8));
  const expected = new Uint8Array(aus.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const au of aus) { expected.set(au, p); p += au.length; }
  assert.deepEqual(payload, expected);
});

test('stco chunk offset points at the mdat payload', () => {
  const aus = fakeAUs(3, 200);
  const mp4 = wrapAccessUnitsToMp4(aus, { sampleRate: 44100, channels: 2 });
  const mdat = findTop(mp4, 'mdat');
  // stco lives in moov/trak/mdia/minf/stbl/stco; just scan for it.
  let stcoOff = -1;
  for (let i = 0; i + 8 < mp4.length; i++) {
    if (String.fromCharCode(mp4[i + 4], mp4[i + 5], mp4[i + 6], mp4[i + 7]) === 'stco') {
      stcoOff = i;
      break;
    }
  }
  assert.ok(stcoOff > 0, 'found stco');
  const b = readBox(mp4, stcoOff);
  // version+flags(4) + entryCount(4) + first offset(4)
  const off = b.dataOffset + 8;
  const chunkOffset = (mp4[off] << 24) | (mp4[off + 1] << 16) | (mp4[off + 2] << 8) | mp4[off + 3];
  assert.equal(chunkOffset, mdat.dataOffset, 'stco offset == mdat payload start');
});

test('rejects unsupported sample rate', () => {
  assert.throws(() => wrapAccessUnitsToMp4(fakeAUs(1, 10), { sampleRate: 12345, channels: 2 }));
});
