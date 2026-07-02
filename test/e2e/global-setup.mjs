// ABOUTME: Generates the y4m fake-camera fixture: a bright soft blob tracing a lissajous
// ABOUTME: orbit over a dark field, so the motion pipeline gets real optical flow to chew on.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./fixtures/blob.y4m', import.meta.url));

const W = 320;
const H = 180;
const FRAMES = 120; // 4s loop at 30fps; Chromium loops the file forever

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
}
