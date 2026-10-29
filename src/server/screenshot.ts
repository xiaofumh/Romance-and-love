import { z } from 'zod';
import { SCREENSHOT_LIMITS, ScreenshotOutput, type ScreenshotResult } from '../shared/screenshot';
import { POLICY_VERSION, type Envelope } from '../shared/contracts';
import { dateKey, type UserState } from './state';
import { fail } from './errors';
import type { ServiceOptions } from './service';
const Input = z.object({ roleId: z.string().min(1).max(100), image: z.string().max(4 * Math.ceil(SCREENSHOT_LIMITS.imageBytes / 3) + 40),
  authorized: z.literal(true) }).strict();
export interface ScreenshotProvider { recognize(image: string): Promise<ScreenshotResult> }
export function validateScreenshotImage(image: string): void {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!m || m[2]!.length % 4 !== 0) return fail('INVALID_IMAGE', '仅支持JPEG/PNG图片，不接受外部图片链接');
  const buffer = Buffer.from(m[2]!, 'base64');
  if (buffer.length > SCREENSHOT_LIMITS.imageBytes || buffer.length < 24 || buffer.toString('base64') !== m[2])
    fail('INVALID_IMAGE', '图片无效或超过512KB，请裁剪或拆分');
  let width = 0, height = 0;
  if (m[1] === 'png') {
    if (!buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii', 12, 16) !== 'IHDR')
      fail('INVALID_IMAGE', '图片格式与内容不一致');
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else {
    if (buffer[0] !== 255 || buffer[1] !== 216 || buffer[buffer.length - 2] !== 255 || buffer[buffer.length - 1] !== 217)
      fail('INVALID_IMAGE', 'JPEG图片不完整');
    let i = 2;
    while (i + 4 < buffer.length) {
      if (buffer[i] !== 255) break;
      const marker = buffer[i + 1]!;
      if (marker === 255) { i++; continue; }
      if (marker === 218 || marker === 217) break;
      const length = buffer.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > buffer.length) break;
      if ([192,193,194].includes(marker) && length >= 8) { height = buffer.readUInt16BE(i + 5); width = buffer.readUInt16BE(i + 7); break; }
      i += length + 2;
    }
  }
  if (!width || !height || width > 6000 || height > 6000 || width * height > SCREENSHOT_LIMITS.sourcePixels)
    fail('INVALID_IMAGE', '无法识别图片尺寸或图片过大，请拆分后重试');
}
export function createScreenshot(o: ServiceOptions) {
  const now = o.now ?? Date.now;
  function allowed(s: UserState, roleId: string) {
    if (s.status !== 'ACTIVE') fail('ACCOUNT_DELETED', '账号数据已删除');
    if (s.consent?.version !== POLICY_VERSION || s.consent.withdrawnAt != null) fail('CONSENT_REQUIRED', '请先阅读并同意使用与隐私说明');
    if (!s.companion?.roles.some(v => v.id === roleId)) fail('RESOURCE_UNAVAILABLE', '角色不存在或无权访问');
    o.assertGenerationAccess?.(s.id);
    if (o.contentReview?.(s.id).mode === 'external') fail('OCR_RESTRICTED', '当前环境尚未完成截图审核配置，暂不开放图片上传');
    if (!o.enabled || o.mode !== 'cloud' || !o.screenshotProvider) fail('OCR_NOT_CONFIGURED', '截图识别需云端模式与视觉模型配置');
  }
  return async (uid: string, event: Envelope) => {
    const p = Input.parse(event.payload), request = z.string().min(8).max(100).parse(event.clientRequestId);
    validateScreenshotImage(p.image);
    const id = `ocr_${o.hash(`${uid}:${request}`)}`, hash = o.hash(p.roleId + ':' + p.image);
    const start = await o.repository.transact(uid, now(), s => {
      allowed(s, p.roleId);
      const jobs = s.screenshotJobs ??= [], previous = jobs.find(v => v.id === id);
      if (previous) {
        if (previous.hash !== hash) fail('REQUEST_CONFLICT', '同一识别编号不能用于其他图片');
        fail(previous.status === 'PROCESSING' ? 'OCR_PENDING' : 'OCR_ALREADY_ATTEMPTED',
          previous.status === 'PROCESSING' ? '该分片仍在识别，请不要重复提交' : '该分片已尝试过；结果不在云端保存，如需重试请主动重新识别');
      }
      if (jobs.some(v => v.status === 'PROCESSING')) fail('OCR_PENDING', '另一张截图仍在识别');
      if (jobs.filter(v => v.day === dateKey(now())).length >= SCREENSHOT_LIMITS.daily) fail('OCR_QUOTA', '今日截图识别已达10个分片（含失败），请明天再试');
      jobs.push({ id, hash, day: dateKey(now()), createdAt: now(), leaseUntil: now() + 32000, status: 'PROCESSING' });
      return { revision: s.revision };
    });
    try {
      // Share the existing global model-attempt budget; no extra spending channel.
      if (!await o.budget.reserve(dateKey(now()), o.callLimit ?? 100)) fail('BUDGET_EXCEEDED', '今日服务调用预算已用完');
      await o.repository.transact(uid, now(), s => {
        allowed(s, p.roleId);
        if (s.revision !== start.revision) fail('DATA_CHANGED', '授权或角色资料已变化，本次识别已取消');
        const job = s.screenshotJobs?.find(v => v.id === id);
        if (!job || job.status !== 'PROCESSING' || job.leaseUntil <= now()) fail('OCR_EXPIRED', '识别请求已失效');
      });
      const output = ScreenshotOutput.parse(await o.screenshotProvider!.recognize(p.image));
      if (output.overflow) fail('OCR_OVERFLOW', '截图内容过多，请拆分后重新识别；未自动截断');
      if (!await o.moderator.check(JSON.stringify(output))) fail('INPUT_BLOCKED', '识别内容未通过检查');
      return await o.repository.transact(uid, now(), s => {
        allowed(s, p.roleId);
        if (s.revision !== start.revision) fail('DATA_CHANGED', '授权或角色资料已变化，本次识别已取消');
        const job = s.screenshotJobs?.find(v => v.id === id);
        if (!job || job.status !== 'PROCESSING' || job.leaseUntil <= now()) return fail('OCR_EXPIRED', '识别请求已失效');
        job.status = 'FINISHED';
        // Image and OCR text are returned only to this caller, never persisted.
        return output;
      });
    } catch (error) {
      await o.repository.transact(uid, now(), s => { const j = s.screenshotJobs?.find(v => v.id === id); if (j) j.status = 'FAILED'; });
      throw error;
    }
  };
}
