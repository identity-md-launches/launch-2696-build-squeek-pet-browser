import { drawScene, W, H, type Scene } from './art';
import { DAY, type Save } from './logic';
import { formatNumber, translate } from './i18n';

/** Local-only PNG. The same scene renderer as Home preserves pose/cosmetics. */
export async function makeShareImage(save: Save, scene: Scene, now: number, frame: number, angle: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  const t = (key: Parameters<typeof translate>[1]) => translate(save.language, key);
  const number = (n: number) => formatNumber(save.language, n);
  ctx.fillStyle = '#fbf4e9';
  ctx.fillRect(0, 0, 1200, 630);
  ctx.fillStyle = '#a5481a';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText(t('brand'), 48, 53);
  ctx.fillStyle = '#3a2a1e';
  ctx.font = '700 48px system-ui, sans-serif';
  // Names are limited to 20 characters; fit the full name without clipping.
  if (ctx.measureText(save.pet.name).width > 1104) ctx.font = '700 38px system-ui, sans-serif';
  ctx.fillText(save.pet.name, 48, 118);
  ctx.fillStyle = '#6e5a48';
  ctx.font = '400 24px system-ui, sans-serif';
  ctx.fillText(t(`stage.${scene.stage}`), 48, 159);

  const cage = document.createElement('canvas');
  cage.width = W;
  cage.height = H;
  const cageCtx = cage.getContext('2d');
  if (!cageCtx) throw new Error('canvas');
  drawScene(cageCtx, scene, now, frame, angle);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cage, 48, 185, 648, 389);

  const label = (text: string, y: number) => {
    ctx.font = '400 22px system-ui, sans-serif';
    ctx.fillStyle = '#6e5a48';
    ctx.fillText(text, 744, y);
  }
  const value = (text: string, y: number) => {
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillStyle = '#3a2a1e';
    // Preserve arbitrarily large counters on the canvas without cropping.
    if (ctx.measureText(text).width > 408) ctx.font = '700 26px system-ui, sans-serif';
    ctx.fillText(text, 744, y);
  }
  label(t('earnedTotal'), 217);
  value(number(save.seedsEarned), 267);
  label(t('daysTogether'), 326);
  value(number(Math.max(0, Math.floor((now - save.pet.bornAt) / DAY))), 376);
  ctx.fillStyle = '#3a2a1e';
  ctx.font = '600 25px system-ui, sans-serif';
  let line = '';
  let y = 458;
  for (const word of t('shareTagline').split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > 408 && line) { ctx.fillText(line, 744, y); y += 35; line = word; }
    else line = next;
  }
  if (line) ctx.fillText(line, 744, y);
  ctx.fillStyle = '#6e5a48';
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText(t('siteAddress'), 48, 609);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('png')), 'image/png'));
}
