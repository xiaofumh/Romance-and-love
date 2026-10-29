import { describe, expect, it } from 'vitest';
import { chatDailyLimit } from '../src/server/chat-quota';
import type { ServiceOptions } from '../src/server/service';
describe('allowlisted internal-test allowance (no network)', () => {
  const options = { chatDailyLimit: 30, internalTestChatDailyLimit: 1000,
    contentReview: (uid: string) => ({ mode: 'internal-test', eligible: uid === 'test' }) } as ServiceOptions;
  it('raises only an already eligible test user, not an ordinary user', () => {
    expect(chatDailyLimit(options, 'test')).toBe(1000); expect(chatDailyLimit(options, 'other')).toBe(30);
  });
  it('does not raise production users or environments with no override', () => {
    expect(chatDailyLimit({ ...options, contentReview: () => ({ mode: 'external', eligible: true }) }, 'test')).toBe(30);
    expect(chatDailyLimit({ ...options, internalTestChatDailyLimit: undefined }, 'test')).toBe(30);
  });
});
