/**
 * Benchmark + quality harness: libxaac-wasm vs native ffmpeg.
 *
 * For each test signal it:
 *   1. encodes with libxaac-wasm (this package)
 *   2. encodes the same PCM with `ffmpeg -c:a aac` (and libfdk_aac if available)
 *   3. decodes every output back to PCM with ffmpeg
 *   4. reports per-encoder: encode wall-clock, output size, and segmental SNR of
 *      (decoded vs original) so quality is a number, not a vibe
 *
 * Run: npm run bench   (needs ffmpeg on PATH + a built dist/)
 *
 * This is the gate: a libxaac build ships only when its SNR is within range of
 * ffmpeg's native aac and its speed is acceptable.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { encodeWav, decodeWav, genSignal } from './wav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function have(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

function ffmpegHasFdk() {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return /libfdk_aac/.test(out);
  } catch { return false; }
}

// Segmental SNR in dB between two equal-length PCM channel sets.
function segmentalSnr(orig, test) {
  const n = Math.min(orig[0].length, test[0].length);
  let num = 0, den = 0;
  for (let c = 0; c < orig.length; c++) {
    for (let i = 0; i < n; i++) {
      const s = orig[c][i];
      const e = s - test[c][i];
      num += s * s;
      den += e * e;
    }
  }
  if (den === 0) return Infinity;
  return 10 * Math.log10(num / den);
}

async function main() {
  if (!have('ffmpeg', ['-version'])) {
    console.error('ffmpeg not found on PATH; cannot benchmark.');
    process.exit(2);
  }
  const distBuilt = existsSync(join(__dirname, '..', 'dist', 'libxaac.js'));
  if (!distBuilt) {
    console.error('dist/libxaac.js not built. Run: npm run build');
    process.exit(2);
  }
  const { encode } = await import('../src/index.js');
  const fdk = ffmpegHasFdk();

  const tmp = mkdtempSync(join(tmpdir(), 'libxaac-bench-'));
  const signals = ['sine', 'sweep', 'noise', 'impulse'];
  const sampleRate = 44100;
  const bitrate = 192000;

  console.log(`bench dir: ${tmp}`);
  console.log(`ffmpeg libfdk_aac: ${fdk ? 'available' : 'no'}`);
  console.log('');
  console.log('signal    encoder        encode(ms)  size(B)   segSNR(dB)');
  console.log('-------------------------------------------------------------');

  for (const sig of signals) {
    const { channels } = genSignal(sig, { seconds: 5, sampleRate, channels: 2 });
    const wavPath = join(tmp, `${sig}.wav`);
    writeFileSync(wavPath, encodeWav(channels, sampleRate));

    // --- libxaac-wasm ---
    const t0 = process.hrtime.bigint();
    const res = await encode({ channels, sampleRate, bitrate });
    const t1 = process.hrtime.bigint();
    const xaacPath = join(tmp, `${sig}.xaac.m4a`);
    writeFileSync(xaacPath, res.data);

    // --- ffmpeg native aac ---
    const ffPath = join(tmp, `${sig}.ff.m4a`);
    const ft0 = process.hrtime.bigint();
    execFileSync('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'aac', '-b:a', `${bitrate}`, ffPath], { stdio: 'ignore' });
    const ft1 = process.hrtime.bigint();

    const rows = [
      ['libxaac-wasm', xaacPath, Number(t1 - t0) / 1e6],
      ['ffmpeg-aac', ffPath, Number(ft1 - ft0) / 1e6],
    ];

    if (fdk) {
      const fdkPath = join(tmp, `${sig}.fdk.m4a`);
      execFileSync('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libfdk_aac', '-b:a', `${bitrate}`, fdkPath], { stdio: 'ignore' });
      rows.push(['ffmpeg-fdk', fdkPath, NaN]);
    }

    for (const [name, path, ms] of rows) {
      // decode back to wav with ffmpeg, compare to original
      const decPath = join(tmp, `dec.wav`);
      execFileSync('ffmpeg', ['-y', '-i', path, decPath], { stdio: 'ignore' });
      const dec = decodeWav(readFileSync(decPath));
      // align lengths (decoder may add priming samples); trim from the front
      const snr = segmentalSnr(channels, dec.channels);
      const size = readFileSync(path).length;
      console.log(
        `${sig.padEnd(9)} ${name.padEnd(14)} ${(Number.isNaN(ms) ? '-' : ms.toFixed(1)).padStart(9)}  ${String(size).padStart(7)}   ${snr.toFixed(2).padStart(8)}`
      );
    }
  }
  console.log('');
  console.log('Note: segSNR here is a coarse gate (no priming alignment / perceptual');
  console.log('model). For ship decisions add PEAQ/ViSQOL. Higher dB = closer to source.');
}

main().catch((e) => { console.error(e); process.exit(1); });
