import { randomUUID } from 'node:crypto';
import { AppError } from '../server/errors';
import type { Moderator } from '../server/service';
import type { ContentReviewStatus } from '../shared/contracts';

type Env = Record<string, string | undefined>;
type TmsClient = { TextModeration(params: unknown): Promise<{ Suggestion?: string }> };

// Server-only policy. "internal-test" explicitly skips external content checks;
// it is not a safety filter, a production fallback, or an approval to publish.
export function createContentReview(env: Env, testId: (uid: string) => string,
  loadSdk: () => any = () => require('tencentcloud-sdk-nodejs-tms')) {
  const mode = env.CONTENT_REVIEW_MODE ?? 'tms';
  if (mode !== 'tms' && mode !== 'internal-test') throw new Error('INVALID_CONTENT_REVIEW_MODE');
  if (mode === 'internal-test' && env.ASSISTANT_RELEASE_STAGE !== 'internal-test')
    throw new Error('INTERNAL_TEST_STAGE_REQUIRED');
  const ids = new Set((env.INTERNAL_TEST_USER_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean));
  if (mode === 'internal-test' && (ids.size > 20 || [...ids].some(v => !/^[a-f0-9]{64}$/.test(v))))
    throw new Error('INVALID_INTERNAL_TEST_USER_IDS');
  const eligible = (uid: string) => mode === 'tms' || ids.has(testId(uid));
  let tms: TmsClient | undefined;
  const moderator: Moderator = { async check(text) {
    if (mode === 'internal-test') return true;
    if (!env.TMS_BIZ_TYPE || !env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY)
      throw new AppError('MODERATION_UNAVAILABLE', '请先完成服务端内容审核配置');
    try {
      const sdk = loadSdk();
      tms ??= new sdk.tms.v20201229.Client({
        credential: { secretId: env.TENCENT_SECRET_ID, secretKey: env.TENCENT_SECRET_KEY,
          token: env.TENCENT_SESSION_TOKEN }, region: env.TENCENT_REGION ?? 'ap-guangzhou',
        profile: { httpProfile: { endpoint: 'tms.tencentcloudapi.com', reqTimeout: 6 } },
      });
      const result = await tms!.TextModeration({ Content: Buffer.from(text).toString('base64'),
        BizType: env.TMS_BIZ_TYPE, DataId: randomUUID() });
      return result.Suggestion === 'Pass';
    } catch { throw new AppError('MODERATION_UNAVAILABLE', '内容检查服务暂不可用，请稍后再试', true); }
  } };
  return {
    moderator,
    status(uid: string): ContentReviewStatus {
      return mode === 'internal-test'
        ? { mode: 'internal-test', eligible: eligible(uid), testUserId: testId(uid) }
        : { mode: 'external', eligible: true };
    },
    assertGenerationAccess(uid: string) {
      if (!eligible(uid)) throw new AppError('INTERNAL_TEST_ONLY', '当前账号尚未获得模型访问权限，请在“我的”复制接入标识交给维护者');
    },
  };
}
