/**
 * Minimal MP4 (.m4a) container builder for AAC-LC access units. Pure JS, no deps.
 *
 * Wraps a list of raw AAC access units into a single-track MP4 with the boxes a
 * downstream muxer (e.g. stem-mp4) needs to parse: ftyp + mdat + moov, where moov
 * carries a real stbl (stsd/esds + stts/stsc/stsz/stco) describing the samples.
 *
 * This is deliberately the inverse of "parse an .m4a": it does NOT touch the codec
 * (the bytes are already encoded AAC). It only synthesizes the container so the
 * encoder output is a valid MP4 track rather than a raw ADTS/ES stream.
 */

const SAMPLES_PER_AAC_FRAME = 1024;

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function str(s) {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function box(type, ...payloads) {
  const body = payloads.flat();
  const size = 8 + body.length;
  return [...u32(size), ...str(type), ...body];
}

// Sampling frequency index per the MPEG-4 AAC table.
const SR_INDEX = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
};

/**
 * AudioSpecificConfig for AAC-LC (AOT 2): 5 bits objectType, 4 bits freqIndex,
 * 4 bits channelConfig. Two bytes for the common cases.
 */
function audioSpecificConfig(sampleRate, channels) {
  const aot = 2; // AAC-LC
  const freqIdx = SR_INDEX[sampleRate];
  if (freqIdx === undefined) {
    throw new Error(`unsupported sample rate for AAC: ${sampleRate}`);
  }
  const b0 = (aot << 3) | (freqIdx >> 1);
  const b1 = ((freqIdx & 1) << 7) | (channels << 3);
  return [b0 & 0xff, b1 & 0xff];
}

/** esds box (ES descriptor wrapping the AudioSpecificConfig). */
function esdsBox(sampleRate, channels, avgBitrate) {
  const asc = audioSpecificConfig(sampleRate, channels);
  // DecoderSpecificInfo (tag 0x05)
  const dsi = [0x05, asc.length, ...asc];
  // DecoderConfigDescriptor (tag 0x04): objectTypeIndication 0x40 (AAC), streamType 0x15
  const dcd = [
    0x04, 13 + dsi.length,
    0x40, 0x15,
    0x00, 0x00, 0x00, // bufferSizeDB
    ...u32(avgBitrate), // maxBitrate
    ...u32(avgBitrate), // avgBitrate
    ...dsi,
  ];
  // SLConfigDescriptor (tag 0x06)
  const sl = [0x06, 0x01, 0x02];
  // ES_Descriptor (tag 0x03)
  const es = [0x03, 3 + dcd.length + sl.length, 0x00, 0x00, 0x00, ...dcd, ...sl];
  return box('esds', u32(0), es); // version+flags, then ES_Descriptor
}

/** mp4a sample entry containing the esds. */
function mp4aSampleEntry(sampleRate, channels, avgBitrate) {
  const esds = esdsBox(sampleRate, channels, avgBitrate);
  return box(
    'mp4a',
    [0, 0, 0, 0, 0, 0], // reserved
    u16(1), // data reference index
    [0, 0, 0, 0, 0, 0, 0, 0], // reserved
    u16(channels),
    u16(16), // sample size (bits)
    [0, 0], // pre_defined
    [0, 0], // reserved
    u16(sampleRate), // sample rate (upper 16 of 16.16)
    [0, 0],
    esds
  );
}

/**
 * @param {Uint8Array[]} accessUnits - raw AAC-LC access units, in order.
 * @param {{sampleRate:number, channels:number, encoderDelaySamples:number}} info
 * @returns {Uint8Array} the .m4a (single AAC track).
 */
export function wrapAccessUnitsToMp4(accessUnits, { sampleRate, channels, avgBitrate = 192000 }) {
  const n = accessUnits.length;
  const sizes = accessUnits.map((au) => au.length);
  const mdatPayload = accessUnits;

  // ftyp
  const ftyp = box('ftyp', str('M4A '), u32(0), str('M4A '), str('mp42'), str('isom'));

  // mdat: header + concatenated AUs. Chunk offset = after ftyp + mdat header.
  const mdatLen = sizes.reduce((a, b) => a + b, 0);
  const mdatHeader = [...u32(8 + mdatLen), ...str('mdat')];
  const chunkOffset = ftyp.length + mdatHeader.length;

  // --- sample table ---
  const stsd = box('stsd', u32(0), u32(1), mp4aSampleEntry(sampleRate, channels, avgBitrate));

  // stts: every sample 1024 ticks (timescale = sampleRate).
  const stts = box('stts', u32(0), u32(1), u32(n), u32(SAMPLES_PER_AAC_FRAME));

  // stsc: 1 chunk holding all samples.
  const stsc = box('stsc', u32(0), u32(1), u32(1), u32(n), u32(1));

  // stsz: per-sample sizes.
  const stsz = box('stsz', u32(0), u32(0), u32(n), sizes.flatMap(u32));

  // stco: single chunk offset.
  const stco = box('stco', u32(0), u32(1), u32(chunkOffset));

  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);

  const duration = n * SAMPLES_PER_AAC_FRAME;
  const smhd = box('smhd', u32(0), [0, 0], [0, 0]);
  const dref = box('dref', u32(0), u32(1), box('url ', u32(1)));
  const dinf = box('dinf', dref);
  const minf = box('minf', smhd, dinf, stbl);

  const hdlr = box('hdlr', u32(0), u32(0), str('soun'), u32(0), u32(0), u32(0), [0]);
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(sampleRate), u32(duration), u16(0x55c4), u16(0));
  const mdia = box('mdia', mdhd, hdlr, minf);

  const tkhd = box(
    'tkhd',
    [0, 0, 0, 0x07], // version+flags: enabled+in-movie+in-preview
    u32(0), u32(0), // create/modify
    u32(1), // track id
    u32(0),
    u32(duration),
    u32(0), u32(0),
    [0, 0], [0, 0], u16(0x0100), [0, 0],
    // unity matrix
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(0), u32(0) // width/height
  );
  const trak = box('trak', tkhd, mdia);

  const mvhd = box(
    'mvhd',
    u32(0), u32(0), u32(0), u32(sampleRate), u32(duration),
    u32(0x00010000), u16(0x0100), [0, 0], u32(0), u32(0),
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2) // next track id
  );
  const moov = box('moov', mvhd, trak);

  // assemble: ftyp + mdat + moov
  const out = new Uint8Array(ftyp.length + mdatHeader.length + mdatLen + moov.length);
  let p = 0;
  out.set(ftyp, p); p += ftyp.length;
  out.set(mdatHeader, p); p += mdatHeader.length;
  for (const au of mdatPayload) { out.set(au, p); p += au.length; }
  out.set(moov, p);
  return out;
}
