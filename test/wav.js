/**
 * Tiny WAV read/write helpers for tests + benchmarks. 16-bit and 32-bit float
 * PCM, mono or stereo. Returns/accepts planar Float32Array channels.
 */

export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const numSamples = channels[0].length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numCh * bytesPerSample;
  const dataLen = numSamples * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readStr = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  // walk chunks
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = readStr(off, 4);
    const len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = len;
    }
    off += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('malformed WAV');

  const { channels: numCh, sampleRate, bits, format } = fmt;
  const bytesPerSample = bits / 8;
  const frames = dataLen / (numCh * bytesPerSample);
  const out = Array.from({ length: numCh }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const p = dataOff + (i * numCh + c) * bytesPerSample;
      let v;
      if (format === 3 && bits === 32) v = dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 0x8000;
      else throw new Error(`unsupported WAV: format ${format}, ${bits}-bit`);
      out[c][i] = v;
    }
  }
  return { channels: out, sampleRate };
}

/** Generate a test signal: { sine, sweep, noise, silence, impulse }. */
export function genSignal(kind, { seconds = 2, sampleRate = 44100, channels = 2 } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const chans = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    switch (kind) {
      case 'sine': v = 0.5 * Math.sin(2 * Math.PI * 440 * t); break;
      case 'sweep': v = 0.5 * Math.sin(2 * Math.PI * (200 + (4000 * t) / seconds) * t); break;
      case 'noise': v = (((i * 1103515245 + 12345) >>> 16) / 32768 - 1) * 0.3; break;
      case 'silence': v = 0; break;
      case 'impulse': v = i % 4410 === 0 ? 0.9 : 0; break;
      default: throw new Error(`unknown signal: ${kind}`);
    }
    for (let c = 0; c < channels; c++) chans[c][i] = v;
  }
  return { channels: chans, sampleRate };
}
