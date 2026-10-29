import { describe, expect, it } from 'vitest';
import { createContentReview } from '../src/cloud/content-review';

describe('content review configuration (external SDK mocked)', () => {
  it('rejects invalid or overly broad internal-test allowlists', () => {
    for (const value of ['*', 'abc', 'A'.repeat(64), Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(64, '0')).join(',')])
      expect(() => createContentReview({ ASSISTANT_RELEASE_STAGE: 'internal-test', CONTENT_REVIEW_MODE: 'internal-test', INTERNAL_TEST_USER_IDS: value }, v => v))
        .toThrow('INVALID_INTERNAL_TEST_USER_IDS');
  });
  it('does not turn a TMS error into skipped moderation or a successful check', async () => {
    const review = createContentReview({ TMS_BIZ_TYPE: 'test', TENCENT_SECRET_ID: 'fake', TENCENT_SECRET_KEY: 'fake' }, v => v,
      () => { throw new Error('SDK_UNAVAILABLE'); });
    await expect(review.moderator.check('合成文本')).rejects.toMatchObject({ code: 'MODERATION_UNAVAILABLE' });
    expect(review.status('user')).toEqual({ mode: 'external', eligible: true });
  });
  it('continues accepting only an explicit Pass from external review', async () => {
    const suggestions = ['Pass', 'Review', 'Block', undefined]; let calls = 0;
    const review = createContentReview({ TMS_BIZ_TYPE: 'test', TENCENT_SECRET_ID: 'fake', TENCENT_SECRET_KEY: 'fake' }, v => v,
      () => ({ tms: { v20201229: { Client: class { async TextModeration() { return { Suggestion: suggestions[calls++] }; } } } } }));
    for (const expected of [true, false, false, false]) expect(await review.moderator.check('合成文本')).toBe(expected);
  });
});
