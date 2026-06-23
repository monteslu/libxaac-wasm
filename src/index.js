/**
 * libxaac-wasm: portable WASM AAC-LC encoder.
 *
 * PCM in, AAC-in-MP4 (single-track .m4a) out. Runs in Node and the browser from
 * one wasm binary (libxaac's generic plain-C path + Emscripten WASM SIMD). The
 * encoder produces AAC-LC; this module wraps the raw AAC access units into a
 * minimal MP4 container so the output drops straight into muxers like stem-mp4.
 *
 * Encoding is intentionally the ONLY job here. Multiplexing many tracks, atoms,
 * metadata, etc. belong to the consumer (e.g. stem-mp4).
 */

import { wrapAccessUnitsToMp4 } from './mp4.js';
// Emscripten glue, built by scripts/build.sh (SINGLE_FILE inlines the wasm).
// Exported as the factory `createLibxaac`. dist/ is published with the package.
import createLibxaac from '../dist/libxaac.js';

let _modPromise = null;

/**
 * Resolve and cache the Emscripten module instance. The wasm is decoded lazily on
 * first encode so importing this package is cheap.
 */
async function getModule() {
  if (!_modPromise) {
    _modPromise = createLibxaac();
  }
  return _modPromise;
}

/**
 * @typedef {Object} EncodeOptions
 * @property {Float32Array[]} channels - One Float32Array of [-1,1] samples per
 *   channel. 1 (mono) or 2 (stereo).
 * @property {number} sampleRate - e.g. 44100, 48000.
 * @property {number} [bitrate=192000] - target bits/sec for AAC-LC.
 */

/**
 * @typedef {Object} EncodeResult
 * @property {Uint8Array} data - the encoded single-track AAC-in-MP4 (.m4a) bytes.
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} encoderDelaySamples - AAC priming/encoder delay introduced.
 *   Pass this to the downstream muxer to keep timing aligned.
 */

/**
 * Encode interleaved/planar PCM to a single-track AAC-LC MP4.
 *
 * @param {EncodeOptions} opts
 * @returns {Promise<EncodeResult>}
 */
export async function encode({ channels, sampleRate, bitrate = 192000 }) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new Error('channels must be an array of 1 or 2 Float32Arrays');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate must be a positive number');
  }

  const mod = await getModule();
  const enc = new mod.AacEncoder(sampleRate, channels.length, bitrate);
  try {
    const accessUnits = [];
    const frameSize = enc.frameSize(); // samples per channel per AAC frame (1024 for LC)
    const total = channels[0].length;

    // libxaac LC has one frame of encoder/priming delay: the first process() call
    // primes and the final input frame is still inside the encoder when input ends.
    // Feed all input frames, then one extra silent frame to push out the tail. The
    // resulting stream is offset by `encoderDelaySamples`; the downstream muxer
    // trims that priming so timing stays aligned.
    const numInputFrames = Math.ceil(total / frameSize);
    const empty = channels.map(() => new Float32Array(0));

    for (let f = 0; f <= numInputFrames; f++) {
      const pos = f * frameSize;
      const block = pos < total ? channels.map((ch) => ch.subarray(pos, pos + frameSize)) : empty;
      const valid = pos < total ? Math.min(frameSize, total - pos) : 0;
      const au = enc.encodeFrame(block, valid);
      if (au && au.length) accessUnits.push(au.slice());
    }

    const audioSpecificConfig = enc.audioSpecificConfig();
    const encoderDelaySamples = enc.encoderDelaySamples();
    const data = wrapAccessUnitsToMp4(accessUnits, {
      sampleRate,
      channels: channels.length,
      avgBitrate: bitrate,
      audioSpecificConfig: audioSpecificConfig.length ? audioSpecificConfig.slice() : null,
      encoderDelaySamples,
    });

    return { data, sampleRate, channels: channels.length, encoderDelaySamples };
  } finally {
    enc.delete();
  }
}

export { wrapAccessUnitsToMp4 };
export default { encode };
