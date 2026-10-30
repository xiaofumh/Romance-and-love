import { createHmac, randomUUID } from 'node:crypto';
import { createService } from '../server/service';
import { createHttpProvider } from '../server/providers';
import { modelConfigFromEnv } from '../server/model-config';
import { cloudBudget, cloudRepository } from './repository';
import { createContentReview } from './content-review';
import { createScreenshotProvider } from '../server/screenshot-provider';
import { safeDiagnostic } from './diagnostics';
import { autonomyTick } from './autonomy-tick';

// External SDKs are installed by CloudBase from the cloud function's package.json.
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const env = process.env;
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error('INVALID_SERVER_CONFIGURATION'); return n;
}
let service: ReturnType<typeof createService> | undefined;
function getService() {
  if (service) return service;
  const secret = env.ASSISTANT_USER_HASH_SECRET;
  if (!secret || secret.length < 32) throw new Error('MISSING_SERVER_SECRET');
  const enabled = env.ASSISTANT_ENABLED === 'true';
  const provider = createHttpProvider(modelConfigFromEnv(env));
  // Distinct HMAC domain: never disclose the database UID or the original OPENID.
  const review = createContentReview(env, uid => createHmac('sha256', secret).update(`internal-test:${uid}`).digest('hex'));
  service = createService({ repository: cloudRepository(db), budget: cloudBudget(db), provider, enabled, mode: 'cloud',
    screenshotProvider: createScreenshotProvider(env.MODEL_API_KEY ?? ''),
    id: randomUUID, hash: text => createHmac('sha256', secret).update(text).digest('hex'),
    callLimit: integer(env.DAILY_MODEL_CALL_LIMIT, 100, 1, 300000),
    chatDailyLimit: integer(env.CHAT_DAILY_USER_LIMIT, 100, 1, 1000),
    // User-authorized test allowance; resolver requires the original internal allowlist.
    // Production and ordinary accounts retain CHAT_DAILY_USER_LIMIT unchanged.
    internalTestChatDailyLimit: integer(env.INTERNAL_TEST_CHAT_DAILY_LIMIT, 1000, 1, 1000),
    operator: env.OPERATOR_NAME ?? '待填写实际运营主体', support: env.SUPPORT_CONTACT ?? '待填写投诉联系渠道',
    moderator: review.moderator, contentReview: review.status, assertGenerationAccess: review.assertGenerationAccess,
    onInternalError: error => console.error('assistant_internal_error', JSON.stringify(safeDiagnostic(error))),
  });
  return service;
}
export async function main(event: unknown) {
  try {
    const context = cloud.getWXContext();
    if (!context.OPENID && env.TRIGGER_SRC === 'timer' && (event as { Type?: string })?.Type === 'Timer') {
      const secret = env.ASSISTANT_USER_HASH_SECRET;
      if (!secret || secret.length < 32) throw new Error('MISSING_SERVER_SECRET');
      return await autonomyTick(db, cloudRepository(db), (uid, input) => getService().handle(uid, input),
        text => createHmac('sha256', secret).update(text).digest('hex'));
    }
    if (!context.OPENID) return { ok: false, requestId: randomUUID(), error: { code: 'UNAUTHENTICATED', message: '请通过微信小程序调用', retryable: false } };
    const secret = env.ASSISTANT_USER_HASH_SECRET;
    if (!secret || secret.length < 32) throw new Error('MISSING_SERVER_SECRET');
    const uid = createHmac('sha256', secret).update(`${context.APPID ?? ''}:${context.OPENID}`).digest('hex');
    // wx.cloud.callFunction can attach userInfo/tcbContext to the event. They are not
    // our business envelope and must never select identity; only getWXContext does.
    // Remove only these reserved fields, retaining strict rejection of every other
    // unknown top-level/payload field in the service's schema.
    let businessEvent = event;
    if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
      const { userInfo: _ignoredUserInfo, tcbContext: _ignoredTcbContext, ...envelope } = event as Record<string, unknown>;
      businessEvent = envelope;
    }
    return await getService().handle(uid, businessEvent);
  } catch {
    return { ok: false, requestId: randomUUID(), error: { code: 'SERVER_NOT_CONFIGURED', message: '云端尚未完成配置，请联系项目维护者', retryable: false } };
  }
}
