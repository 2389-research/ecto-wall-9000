// ABOUTME: Generates the fake-capture fixtures: a y4m moving-blob orbit for the camera and
// ABOUTME: a silence-then-thumps WAV for the microphone, so e2e gets real signal to chew on.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./fixtures/blob.y4m', import.meta.url));

const W = 320;
const H = 180;
const FRAMES = 120; // 4s loop at 30fps; Chromium loops the file forever

const WAV_OUT = fileURLToPath(new URL('./fixtures/beats.wav', import.meta.url));

// Audio fixture: 2s of silence, then a 110Hz decaying thump every 500ms — enough silence
// up front to watch the signals rise from zero, enough onsets for the beat detector.
// Chromium loops the file, but 90s outlives every assertion even if it never loops.
const SR = 44100;
const WAV_SECONDS = 90;
const LEAD_IN_S = 2;
const THUMP_EVERY_S = 0.5;

function generateWav() {
  const n = SR * WAV_SECONDS;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t < LEAD_IN_S) continue;
    const tt = (t - LEAD_IN_S) % THUMP_EVERY_S;
    if (tt < 0.1) {
      const env = Math.exp(-tt / 0.03);
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 110 * tt) * env * 0.8 * 32767);
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // linear PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  mkdirSync(dirname(WAV_OUT), { recursive: true });
  writeFileSync(WAV_OUT, buf);
}

function generate() {
  const ySize = W * H;
  const cSize = (W / 2) * (H / 2);
  const frameBytes = 6 + ySize + cSize * 2; // "FRAME\n" + planes
  const header = `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`;
  const buf = Buffer.alloc(header.length + frameBytes * FRAMES);
  let off = buf.write(header, 0, 'ascii');

  for (let k = 0; k < FRAMES; k++) {
    off += buf.write('FRAME\n', off, 'ascii');
    const ph = (k / FRAMES) * Math.PI * 2;
    const cx = W / 2 + Math.cos(ph) * W * 0.3;
    const cy = H / 2 + Math.sin(ph * 2) * H * 0.25;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const glow = Math.max(0, 1 - d / 26);
        buf[off + y * W + x] = 20 + Math.round(215 * glow * glow);
      }
    }
    off += ySize;
    buf.fill(133, off, off + cSize); // U: faint cool cast
    off += cSize;
    buf.fill(122, off, off + cSize); // V
    off += cSize;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, buf);
}

export default function globalSetup() {
  if (!existsSync(OUT)) generate();
  if (!existsSync(WAV_OUT)) generateWav();
}
