import { z } from 'zod';
import { redactPrivate, type ReferenceTurn } from './companion';
z.config({ jitless: true });
export const SCREENSHOT_LIMITS = { imageBytes: 512 * 1024, sourceBytes: 8 * 1024 * 1024,
  sourcePixels: 24_000_000, tileWidth: 900, tileHeight: 2600, overlap: 160, tiles: 6, messages: 120, daily: 10 } as const;
export const ScreenshotOutput = z.object({ overflow: z.boolean(), messages: z.array(z.object({
  side: z.enum(['left', 'right', 'unknown']), text: z.string().trim().min(1).max(4000),
  kind: z.enum(['text', 'nontext']), uncertain: z.boolean(),
}).strict()).max(SCREENSHOT_LIMITS.messages) }).strict();
export type ScreenshotResult = z.infer<typeof ScreenshotOutput>;
export type ScreenshotMessage = ScreenshotResult['messages'][number] & { tile: number; excluded: boolean };
export type ScreenshotJob = { id: string; hash: string; day: string; createdAt: number; leaseUntil: number;
  status: 'PROCESSING' | 'FINISHED' | 'FAILED' };
export function screenshotTurns(messages: ScreenshotMessage[], userSide: 'left' | 'right'): ReferenceTurn[] {
  const kept = messages.filter(v => !v.excluded);
  if (!kept.length) throw new Error('没有可加入的文字消息');
  if (kept.some(v => v.side === 'unknown' || v.kind !== 'text' || !v.text.trim()))
    throw new Error('请确认未知归属，补全或排除非文字消息');
  return kept.map(v => ({ speaker: v.side === userSide ? 'user' : 'reference',
    text: redactPrivate(v.text.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()) }));
}
export function screenshotTiles(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > SCREENSHOT_LIMITS.sourcePixels)
    throw new Error('图片分辨率过大，请先裁剪或拆分截图');
  const scale = Math.min(1, SCREENSHOT_LIMITS.tileWidth / width), sourceHeight = Math.floor(SCREENSHOT_LIMITS.tileHeight / scale);
  const overlap = Math.ceil(SCREENSHOT_LIMITS.overlap / scale), out: { y: number; height: number; width: number; outputHeight: number }[] = [];
  for (let y = 0; y < height; y += sourceHeight - overlap) {
    const h = Math.min(sourceHeight, height - y);
    out.push({ y, height: h, width: Math.max(1, Math.round(width * scale)), outputHeight: Math.max(1, Math.round(h * scale)) });
    if (out.length > SCREENSHOT_LIMITS.tiles) throw new Error('长截图超过6个分片，请拆分后识别');
    if (y + h >= height) break;
  }
  return out;
}
