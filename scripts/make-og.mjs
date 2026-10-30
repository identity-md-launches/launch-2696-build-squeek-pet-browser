// Generates public/og.png (1200x630 share card) and public/favicon.svg from
// the same pixel hamster rows used in src/art.ts. Run: npm run og
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BODY = ['..oo....', '.opfo...', '.offoooo', 'offfffff', 'offfffff', 'offfooff', 'offfffff', 'olcllffp', 'olllllll', 'olllllll', '.ollllll', '.oppolll', '..oooooo'];
const rows = BODY.map((h) => h + [...h].reverse().join(''));
const PAL = { o: '#5a3418', f: '#d99a4e', l: '#f6dfb8', p: '#f29aa6', c: '#f6a3a3', e: '#24140e', w: '#ffffff' };
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

// ---- PNG ----
const Wd = 1200, Ht = 630;
const img = new Uint8Array(Wd * Ht * 3);
const rect = (x, y, w, h, c) => {
  const [r, g, b] = hex(c);
  for (let j = Math.max(0, y); j < Math.min(Ht, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(Wd, x + w); i++) {
      const k = (j * Wd + i) * 3;
      img[k] = r; img[k + 1] = g; img[k + 2] = b;
    }
};
rect(0, 0, Wd, Ht, '#f3dcb8');
for (let x = 0; x < Wd; x += 60) rect(x, 0, 30, 500, '#efd3a9');
rect(0, 500, Wd, 130, '#e6bf83');
// wheel ring
const cx = 820, cy = 300, R = 220;
for (let y = -R; y <= R; y += 10) for (let x = -R; x <= R; x += 10) {
  const d = Math.hypot(x, y);
  if (d <= R && d > R - 22) rect(cx + x, cy + y, 10, 10, '#8d96a1');
}
for (let k = 0; k < 8; k++) {
  const a = (k * Math.PI) / 4;
  for (let d = 0; d < R - 20; d += 10) rect(Math.round((cx + Math.cos(a) * d) / 10) * 10, Math.round((cy + Math.sin(a) * d) / 10) * 10, 10, 10, '#c2c9d1');
}
// hamster
const S = 22, ox = 160, oy = 500 - 13 * S;
rows.forEach((row, j) => [...row].forEach((ch, i) => PAL[ch] && rect(ox + i * S, oy + j * S, S, S, PAL[ch])));
// hearts
for (const [hx, hy] of [[540, 150], [600, 210]]) ['.r.r.', 'rrrrr', '.rrr.', '..r..'].forEach((r, j) => [...r].forEach((ch, i) => ch === 'r' && rect(hx + i * 10, hy + j * 10, 10, 10, '#ef5b7a')));

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((Wd * 3 + 1) * Ht);
for (let y = 0; y < Ht; y++) { raw[y * (Wd * 3 + 1)] = 0; Buffer.from(img.buffer, y * Wd * 3, Wd * 3).copy(raw, y * (Wd * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(Wd, 0); ihdr.writeUInt32BE(Ht, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(new URL('../public/og.png', import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));

// ---- favicon ----
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -2 18 18" shape-rendering="crispEdges">`;
rows.forEach((row, j) => [...row].forEach((ch, i) => { if (PAL[ch]) svg += `<rect x="${i}" y="${j}" width="1" height="1" fill="${PAL[ch]}"/>`; }));
svg += '</svg>\n';
writeFileSync(new URL('../public/favicon.svg', import.meta.url), svg);
console.log('wrote public/og.png and public/favicon.svg');
