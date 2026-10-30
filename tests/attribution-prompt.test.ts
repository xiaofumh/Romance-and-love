import { describe, expect, it } from 'vitest';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
const context: ChatContext = { role: { id: 'r', name: '虚构角色', version: 1, createdAt: 1, personality: '温柔倾听',
  relationship: 'friend', description: '', boundaries: '' }, messages: [], memories: [], examples: [], message: '' };
const task = (message: string) => JSON.parse(companionMessages({ ...context, message }).at(-1)!.content);
describe('provider-bound attribution for current-turn language', () => {
  it('preserves a third-party report as data without presenting it as the current user command', () => {
    const text = '他对我说，先不聊了';
    const output = task(text);
    expect(output.currentMessage).toBe(text);
    expect(output.currentMessageClauses).toEqual([
      { text: '他对我说', attribution: 'reported-speaker' }, { text: '先不聊了', attribution: 'reported-speaker' },
    ]);
    expect(output.attributionGuidance).toContain('不等于用户本人要求暂停');
  });
  it('distinguishes explicit current-user stance after a report and preserves quotation text', () => {
    const text = '她说：“先不聊了”，不过我想聊了';
    const output = task(text);
    expect(output.currentMessage).toBe(text);
    expect(output.currentMessageClauses).toEqual([
      { text: '她说：“先不聊了”', attribution: 'reported-speaker' }, { text: '不过我想聊了', attribution: 'current-user' },
    ]);
    expect(task('先不聊了').currentMessageClauses).toEqual([{ text: '先不聊了', attribution: 'current-user' }]);
  });
});
