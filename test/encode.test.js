/**
 * Encode round-trip test. Requires the wasm build (dist/libxaac.js); skips
 * cleanly when it is not present so `npm test` is green pre-build and in CI's
 * lint-only stage.
 */

import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { genSignal } from './wav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBuilt = existsSync(join(__dirname, '..', 'dist', 'libxaac.js'));

test('encode() produces a parseable AAC-in-MP4', { skip: !distBuilt && 'dist not built (run npm run build)' }, async () => {
  const { encode } = await import('../src/index.js');
  const { channels, sampleRate } = genSignal('sine', { seconds: 1, sampleRate: 44100, channels: 2 });
  const res = await encode({ channels, sampleRate, bitrate: 192000 });

  assert.ok(res.data instanceof Uint8Array, 'returns bytes');
  assert.ok(res.data.length > 0, 'non-empty');
  assert.equal(res.sampleRate, 44100);
  assert.equal(res.channels, 2);
  assert.ok(Number.isInteger(res.encoderDelaySamples), 'reports encoder delay');

  // ftyp at the front.
  const tag = String.fromCharCode(res.data[4], res.data[5], res.data[6], res.data[7]);
  assert.equal(tag, 'ftyp');
});

test('output is accepted by stem-mp4 muxer', { skip: !distBuilt && 'dist not built' }, async () => {
  let muxTracks;
  try {
    ({ muxTracks } = await import('stem-mp4/src/muxer.js'));
  } catch {
    return skip('stem-mp4 not linked');
  }
  const { encode } = await import('../src/index.js');
  const a = await encode({ ...genSignal('sine', { seconds: 1 }) });
  const b = await encode({ ...genSignal('sweep', { seconds: 1 }) });
  // Mux two encoder outputs into one multi-track MP4; should not throw.
  const muxed = muxTracks([
    { data: a.data, kind: 'soun', enabled: true },
    { data: b.data, kind: 'soun', enabled: false },
  ]);
  assert.ok(muxed.length > a.data.length, 'muxed file contains both tracks');
});
