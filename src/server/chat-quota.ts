import type { ServiceOptions } from './service';

// A test allowance never grants access: the existing allowlist gate still runs.
export function chatDailyLimit(o: ServiceOptions, uid: string): number {
  const review = o.contentReview?.(uid);
  return review?.mode === 'internal-test' && review.eligible && o.internalTestChatDailyLimit != null
    ? o.internalTestChatDailyLimit : o.chatDailyLimit ?? 100;
}
