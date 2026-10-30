// Original pixel art, drawn in code on a 240x144 canvas and scaled up with
// image-rendering: pixelated. No external images.
import { FURS, type FurId, type StageId } from './logic';

export const W = 240;
export const H = 144;

export type Pose = 'idle' | 'eat' | 'run' | 'sleep' | 'happy' | 'grumpy';

export interface Scene {
  fur: FurId;
  stage: StageId;
  pose: Pose;
  hat: string | null;
  skin: string;
  bg: string;
  festival: boolean;
}

// Left half of a front-facing hamster; each row is mirrored to 16 px.
const BODY = [
  '..oo....',
  '.opfo...',
  '.offoooo',
  'offfffff',
  'offfffff',
  'offfewff',
  'offfeeff',
  'olcllffp',
  'olllllll',
  'olllllll',
  '.ollllll',
  '.oppolll',
  '..oooooo',
];

function rowsFor(pose: Pose, frame: number): string[] {
  const r = BODY.slice();
  if (pose === 'sleep') {
    r[5] = 'offfffff';
    r[6] = 'offfooff';
  } else if (pose === 'happy') {
    r[5] = 'offfooff';
    r[6] = 'offfffff';
  } else if (pose === 'grumpy') {
    r[4] = 'offffoff';
    r[6] = 'offfeeff';
  } else if (pose === 'eat') {
    r[7] = 'occclffp';
    r[8] = frame % 2 ? 'ollllllm' : 'olllllll';
  } else if (pose === 'run') {
    r[11] = frame % 2 ? '.olpplll' : '.oppolll';
  } else if (pose === 'idle' && frame % 24 === 0) {
    r[5] = 'offfffff';
    r[6] = 'offfooff'; // blink
  }
  return r.map((half) => half + [...half].reverse().join(''));
}

const PINK = '#f29aa6';
const PALETTE_BASE: Record<string, string> = { p: PINK, e: '#24140e', w: '#ffffff', c: '#f6a3a3', m: '#6b2626' };

const SKINS: Record<string, { rim: string; spoke: string; star?: string }> = {
  'skin-classic': { rim: '#8d96a1', spoke: '#c2c9d1' },
  'skin-sunset': { rim: '#e9773c', spoke: '#ffc078' },
  'skin-mint': { rim: '#3fae8e', spoke: '#a8e6cf' },
  'skin-galaxy': { rim: '#5b3c99', spoke: '#b69df8', star: '#fff3b0' },
};

const HATS: Record<string, { rows: string[]; colors: Record<string, string> }> = {
  'hat-party': {
    rows: ['...rr...', '...bb...', '..bybb..', '..bbyb..', '.bybbyb.', '.bbbbbb.'],
    colors: { r: '#ef476f', b: '#4f86e8', y: '#ffd166' },
  },
  'hat-flower': {
    rows: ['.r..y..r', 'rgrygyrg', '.g..g..g'],
    colors: { r: '#ff7aa2', y: '#ffd166', g: '#5fae4f' },
  },
  'hat-top': {
    rows: ['..kkkk..', '..kkkk..', '..kkkk..', '..rrrr..', 'kkkkkkkk'],
    colors: { k: '#2b2730', r: '#d64545' },
  },
};

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function drawGrid(ctx: CanvasRenderingContext2D, rows: string[], colors: Record<string, string>, x: number, y: number, s: number) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = colors[row[i]];
      if (c) px(ctx, x + i * s, y + j * s, s, s, c);
    }
  });
}

function drawBackground(ctx: CanvasRenderingContext2D, bg: string, t: number) {
  const floorY = 118;
  if (bg === 'bg-meadow') {
    px(ctx, 0, 0, W, floorY, '#a9dcf2');
    px(ctx, 0, 70, W, floorY - 70, '#bfe6f5');
    for (const [cx, cy] of [[30, 20], [150, 30], [205, 14]]) {
      px(ctx, cx, cy, 24, 6, '#ffffff');
      px(ctx, cx + 5, cy - 4, 12, 4, '#ffffff');
    }
    px(ctx, 0, floorY, W, H - floorY, '#7dbb5f');
    for (let x = 3; x < W; x += 9) px(ctx, x, floorY - 2, 2, 3, '#5f9f45');
  } else if (bg === 'bg-night') {
    px(ctx, 0, 0, W, floorY, '#1f2450');
    for (let i = 0; i < 26; i++) {
      const sx = (i * 53) % W;
      const sy = (i * 29) % 100;
      const on = (Math.floor(t / 900) + i) % 7 !== 0;
      if (on) px(ctx, sx, sy, 1, 1, '#fff6c9');
    }
    px(ctx, 196, 14, 12, 12, '#f6edc2');
    px(ctx, 200, 14, 8, 8, '#1f2450');
    px(ctx, 0, floorY, W, H - floorY, '#3a3f74');
  } else if (bg === 'bg-library') {
    px(ctx, 0, 0, W, floorY, '#e7cfae');
    const books = ['#b5523b', '#3f6fa3', '#5f9f6f', '#d8a23b', '#7a4f8f'];
    for (const sy of [24, 58]) {
      px(ctx, 8, sy + 22, 120, 4, '#7a4e2d');
      for (let i = 0; i < 22; i++) px(ctx, 10 + i * 5 + (i % 3), sy + (i % 4) + 2, 4, 20 - (i % 4), books[i % books.length]);
    }
    px(ctx, 0, floorY, W, H - floorY, '#9a6a45');
  } else {
    px(ctx, 0, 0, W, floorY, '#f3dcb8');
    for (let x = 0; x < W; x += 12) px(ctx, x, 0, 6, floorY, '#efd3a9');
    px(ctx, 0, floorY, W, H - floorY, '#e6bf83');
    for (let i = 0; i < 60; i++) px(ctx, (i * 37) % W, floorY + 3 + ((i * 11) % (H - floorY - 4)), 3, 1, i % 2 ? '#f3d7a4' : '#cfa266');
  }
  // water bottle and food bowl
  px(ctx, 14, 30, 10, 34, '#cfe8f7');
  px(ctx, 14, 44, 10, 20, '#7cc3ec');
  px(ctx, 17, 64, 4, 8, '#9aa3ad');
  px(ctx, 10, 110, 28, 8, '#d36b5b');
  px(ctx, 12, 108, 24, 3, '#f5d27a');
}

function drawWheel(ctx: CanvasRenderingContext2D, skin: string, angle: number) {
  const s = SKINS[skin] ?? SKINS['skin-classic'];
  const cx = 176;
  const cy = 72;
  const r = 46;
  // stand
  for (let i = 0; i < 46; i++) {
    px(ctx, cx - 4 - i * 0.55, cy + i, 3, 1, '#7b828c');
    px(ctx, cx + 2 + i * 0.55, cy + i, 3, 1, '#7b828c');
  }
  px(ctx, cx - 3, cy - 3, 6, 6, '#7b828c');
  // spokes
  for (let k = 0; k < 8; k++) {
    const a = angle + (k * Math.PI) / 4;
    for (let d = 4; d < r - 3; d += 1) px(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1, 1, s.spoke);
  }
  // rim as a crisp pixel ring
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y);
      if (d <= r && d > r - 4) px(ctx, cx + x, cy + y, 1, 1, d > r - 1.5 ? '#00000033' : s.rim);
    }
  }
  if (s.star) {
    for (let k = 0; k < 6; k++) {
      const a = angle * 0.5 + k;
      px(ctx, cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), 1, 1, s.star);
    }
  }
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number) {
  drawGrid(ctx, ['.r.r.', 'rrrrr', '.rrr.', '..r..'], { r: '#ef5b7a' }, x, y, 1);
}

export const STAGE_SCALE: Record<StageId, number> = { pup: 3, junior: 4, adult: 5, legend: 5 };

/** Draw one frame. `t` is ms; `frame` advances the pose; `angle` turns the wheel. */
export function drawScene(ctx: CanvasRenderingContext2D, sc: Scene, t: number, frame: number, angle: number) {
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, sc.bg, t);
  drawWheel(ctx, sc.skin, angle);

  const furDef = FURS.find((f) => f.id === sc.fur) ?? FURS[0];
  const colors = { ...PALETTE_BASE, o: furDef.dark, f: furDef.fur, l: furDef.light };
  const s = STAGE_SCALE[sc.stage];
  const spriteW = 16 * s;
  const spriteH = 13 * s;
  const running = sc.pose === 'run';
  const bob = running ? (frame % 2) * s : sc.pose === 'happy' ? -((frame % 4) < 2 ? s : 0) : 0;
  const footY = running ? 72 + 46 - 4 : 124;
  const x = running ? 176 - spriteW / 2 : 84 - spriteW / 2;
  const y = footY - spriteH + bob;

  // soft shadow
  if (!running) px(ctx, x + s, footY - 1, spriteW - 2 * s, 2, '#00000022');
  drawGrid(ctx, rowsFor(sc.pose, frame), colors, x, y, s);

  if (sc.stage === 'legend') drawGrid(ctx, ['.yy.', 'yooy', '.yy.'].map((r) => r.replace(/o/g, 'k')), { y: '#f2c14e', k: '#c8902a' }, x + 6 * s, y + 9 * s, s);

  if (sc.hat && HATS[sc.hat]) {
    const hat = HATS[sc.hat];
    drawGrid(ctx, hat.rows, hat.colors, x + 4 * s, y + (3 - hat.rows.length) * s, s);
  }

  if (sc.pose === 'sleep') {
    const zx = x + spriteW + 2;
    const zy = y - 4 - (frame % 3) * 3;
    ctx.fillStyle = '#5a5f8a';
    ctx.font = '8px monospace';
    ctx.fillText('z', zx, zy + 8);
    ctx.fillText('z', zx + 6, zy);
  } else if (sc.pose === 'happy') {
    drawHeart(ctx, x + spriteW, y - 6 - (frame % 4));
    drawHeart(ctx, x - 6, y - 2 - ((frame + 2) % 4));
  } else if (sc.pose === 'grumpy') {
    const cx = x + spriteW / 2 - 9;
    const cy = y - 14;
    px(ctx, cx, cy + 3, 18, 6, '#8d93a0');
    px(ctx, cx + 4, cy, 10, 4, '#8d93a0');
    if (frame % 6 < 3) px(ctx, cx + 8, cy + 9, 1, 3, '#6ea8de');
  } else if (sc.pose === 'eat') {
    drawGrid(ctx, ['.s.', 'sds', 'sds', '.s.'], { s: '#3b3b3b', d: '#d9d3c0' }, x + 7 * s + 1, y + 8 * s + (frame % 2), 1);
  }

  if (sc.festival) {
    const colorsF = ['#ef476f', '#ffd166', '#06d6a0', '#4f86e8'];
    for (let i = 0; i < 14; i++) px(ctx, (i * 17 + frame * 3) % W, (i * 23 + frame * 5) % 60, 2, 2, colorsF[i % 4]);
  }
}

/** Small portrait used by the adopt picker and favicon-like spots. */
export function drawPortrait(ctx: CanvasRenderingContext2D, fur: FurId, scale: number) {
  const furDef = FURS.find((f) => f.id === fur) ?? FURS[0];
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  drawGrid(ctx, rowsFor('happy', 1), { ...PALETTE_BASE, o: furDef.dark, f: furDef.fur, l: furDef.light }, 0, 0, scale);
}

export { BODY, rowsFor };
