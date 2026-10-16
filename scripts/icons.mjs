// Generates the extension's PNG icons (rounded square with two overlapping circles) without image deps.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** `pad` leaves a transparent margin, e.g. the Chrome Web Store's 96px artwork inside a 128px icon. */
function render(size, pad = 0) {
  const ss = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  const s = (size - 2 * pad) / 128;
  const shapes = [
    { cx: pad + 52 * s, cy: pad + 64 * s, r: 26 * s, color: [59, 130, 246, 1] },
    { cx: pad + 76 * s, cy: pad + 64 * s, r: 26 * s, color: [167, 139, 250, 0.9] },
  ];
  const radius = 28 * s;
  const lo = pad;
  const hi = size - pad;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;
          // Rounded-rect background
          if (fx < lo || fx > hi || fy < lo || fy > hi) continue;
          const dx = Math.max(lo + radius - fx, 0, fx - (hi - radius));
          const dy = Math.max(lo + radius - fy, 0, fy - (hi - radius));
          if (dx * dx + dy * dy > radius * radius) continue;
          let c = [17, 24, 39];
          for (const sh of shapes) {
            if ((fx - sh.cx) ** 2 + (fy - sh.cy) ** 2 <= sh.r ** 2) {
              const a = sh.color[3];
              c = c.map((v, i) => v * (1 - a) + sh.color[i] * a);
            }
          }
          acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2], acc[3] + 255];
        }
      }
      const n = ss * ss;
      const cov = acc[3] / 255;
      const i = (y * size + x) * 4;
      px[i] = cov ? acc[0] / cov : 0;
      px[i + 1] = cov ? acc[1] / cov : 0;
      px[i + 2] = cov ? acc[2] / cov : 0;
      px[i + 3] = acc[3] / n;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icons/${size}.png`, render(size));
// Store listing icon: 96×96 artwork centered in 128×128, as the Chrome Web Store asks.
mkdirSync('store', { recursive: true });
writeFileSync('store/icon-128.png', render(128, 16));
console.log('icons written');
