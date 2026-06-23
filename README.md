# libxaac-wasm

[![CI](https://github.com/monteslu/libxaac-wasm/actions/workflows/ci.yml/badge.svg)](https://github.com/monteslu/libxaac-wasm/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A tiny, portable WebAssembly **AAC-LC encoder**. PCM in, AAC-in-MP4 (`.m4a`) out. One wasm binary that runs the same in Node and the browser.

Built on [Ittiam libxaac](https://github.com/ittiam-systems/libxaac) (Apache-2.0). The encoder uses libxaac's generic plain-C path compiled with Emscripten; x86 SSE intrinsics are lowered to WASM SIMD via `-msimd128`, so it is fast and architecture-neutral with no per-platform builds.

## Why

WebCodecs `AudioEncoder` cannot encode AAC on desktop Linux (any browser) or in Firefox on any platform, and the official `@ffmpeg/ffmpeg` dropped Node support at 0.12.0. Shipping a 25 MB ffmpeg-wasm blob to do one job is overkill. This package does exactly one thing, everywhere, in a small binary:

> **PCM samples -> AAC-LC inside a minimal MP4 container.**

Multiplexing multiple tracks, metadata, atoms, etc. are deliberately out of scope. The output is a single-track `.m4a` that drops straight into a muxer such as [stem-mp4](https://github.com/monteslu/stem-mp4).

## Features

- **AAC-LC** (`mp4a.40.2`), mono or stereo
- **Isomorphic** - one binary for Node and the browser
- **Portable** - libxaac generic C path, no per-arch builds
- **SIMD** - x86 SSE intrinsics lowered to WASM SIMD by Emscripten
- **Single-threaded** - no `SharedArrayBuffer` / COOP-COEP requirement
- **MP4 output** - container synthesized in pure JS, no native deps at runtime
- **Apache-2.0** - clean to redistribute (unlike fdk-aac)

## Install

```bash
npm install libxaac-wasm
```

The published package includes a prebuilt `dist/libxaac.js` (the wasm is inlined via `SINGLE_FILE`), so consumers do not need Emscripten.

## Usage

```javascript
import { encode } from 'libxaac-wasm';

// channels: one Float32Array of [-1, 1] samples per channel (1 or 2).
const { data, sampleRate, channels, encoderDelaySamples } = await encode({
  channels: [leftFloat32, rightFloat32],
  sampleRate: 44100,
  bitrate: 192000,
});

// `data` is a single-track AAC-in-MP4 (.m4a) Uint8Array.
// `encoderDelaySamples` is the AAC priming delay; pass it to your muxer so lyric
// or marker timing stays aligned.
```

### With stem-mp4

```javascript
import { encode } from 'libxaac-wasm';
import { StemMp4Writer } from 'stem-mp4';

const enc = (chans) => encode({ channels: chans, sampleRate: 44100 });

const [mixdown, drums, bass, other, vocals] = await Promise.all([
  enc(mixdownChannels), enc(drumsChannels), enc(bassChannels),
  enc(otherChannels), enc(vocalsChannels),
]);

await StemMp4Writer.write({
  outputPath: 'song.stem.mp4',
  mixdownAac: mixdown.data,
  stemsAac: { drums: drums.data, bass: bass.data, other: other.data, vocals: vocals.data },
  encoderDelaySamples: mixdown.encoderDelaySamples,
  metadata: { title: 'Song', artist: 'Artist' },
});
```

## API

### `encode(options) => Promise<EncodeResult>`

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `channels` | `Float32Array[]` | required | 1 (mono) or 2 (stereo), planar |
| `sampleRate` | `number` | required | 8000 to 96000 (standard AAC table) |
| `bitrate` | `number` | `192000` | target bits/sec |

`EncodeResult`: `{ data: Uint8Array, sampleRate, channels, encoderDelaySamples }`.

### `wrapAccessUnitsToMp4(accessUnits, info) => Uint8Array`

Lower-level: wrap an array of raw AAC access units into a single-track MP4. Exposed for callers that already have encoded AUs.

## Building from source

Requires [Emscripten](https://emscripten.org/) on `PATH` (or `EMSDK` set).

```bash
npm run vendor   # fetch + pin Ittiam libxaac into vendor/ (gitignored)
npm run build    # compile the wasm encoder into dist/libxaac.js
npm test         # pure-JS unit tests always run; encode tests run once dist exists
```

### Updating libxaac

The upstream source is vendored, not committed. Bump `LIBXAAC_REF` in `scripts/vendor-libxaac.sh`, re-vendor, rebuild, then run the benchmark to confirm no quality or speed regression:

```bash
LIBXAAC_REF=<tag> npm run vendor && npm run build && npm run bench
```

## Benchmark and quality gate

`npm run bench` (needs `ffmpeg` on `PATH`) encodes a set of test signals with this package and with `ffmpeg -c:a aac` (plus `libfdk_aac` if available), decodes everything back to PCM, and reports encode time, output size, and segmental SNR against the source. A build ships only when its quality is within range of ffmpeg's native AAC and its speed is acceptable.

For ship-grade quality decisions, layer a perceptual metric (PEAQ / ViSQOL) on top of the coarse SNR gate.

## License

Apache-2.0. See [LICENSE](LICENSE).

Bundles [Ittiam libxaac](https://github.com/ittiam-systems/libxaac) (Apache-2.0).
