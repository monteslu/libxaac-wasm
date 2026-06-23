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

// SNR in dB between two PCM channel sets, after sliding `test` left by `delay`
// samples to undo encoder priming. Without this, a correct encoder still scores
// near-zero/negative SNR because the decoded signal is shifted vs the source.
function snr(orig, test, delay = 0) {
  const n = Math.min(orig[0].length, test[0].length - delay);
  if (n <= 0) return NaN;
  let num = 0, den = 0;
  for (let c = 0; c < orig.length; c++) {
    const o = orig[c];
    const t = test[c];
    for (let i = 0; i < n; i++) {
      const s = o[i];
      const e = s - t[i + delay];
      num += s * s;
      den += e * e;
    }
  }
  if (den === 0) return Infinity;
  return 10 * Math.log10(num / den);
}

// Find the integer delay (0..maxDelay) that maximizes SNR, then return that SNR.
// This both reports best-case quality and recovers the true priming offset.
function bestSnr(orig, test, maxDelay) {
  let best = -Infinity, bestDelay = 0;
  for (let d = 0; d <= maxDelay; d++) {
    const v = snr(orig, test, d);
    if (v > best) { best = v; bestDelay = d; }
  }
  return { snr: best, delay: bestDelay };
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
  console.log('signal    encoder        encode(ms)  size(B)   bestSNR(dB)  delay');
  console.log('-------------------------------------------------------------------');

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
      // Decoders/encoders introduce priming delay; search a small window for the
      // alignment that maximizes SNR so we measure quality, not offset. ~3 AAC
      // frames covers encoder delay + decoder priming.
      const { snr: best, delay } = bestSnr(channels, dec.channels, 1024 * 3);
      const size = readFileSync(path).length;
      console.log(
        `${sig.padEnd(9)} ${name.padEnd(14)} ${(Number.isNaN(ms) ? '-' : ms.toFixed(1)).padStart(9)}  ${String(size).padStart(7)}   ${best.toFixed(2).padStart(8)}   ${String(delay).padStart(5)}`
      );
    }
  }
  console.log('');
  console.log('bestSNR aligns by the priming delay the search recovers, so it measures');
  console.log('quality not offset. It is still a coarse gate (no perceptual model); for');
  console.log('ship decisions add PEAQ/ViSQOL. The recovered delay should match the');
  console.log("encoder's reported encoderDelaySamples.");
}

main().catch((e) => { console.error(e); process.exit(1); });
