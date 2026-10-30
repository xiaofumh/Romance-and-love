import { describe, expect, it } from 'vitest';
import { nextInteractionMode } from '../src/shared/interaction';
import { chooseInitiativeTopic, repeatedInitiative } from '../src/server/initiative-topic';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
describe('explicit interaction choices and bounded topic planning (no model)', () => {
  it('retains quiet across acknowledgement and resumes only on an explicit current-chat choice', () => {
    expect(nextInteractionMode('你好，我今天不想说话')).toBe('quiet');
    for (const t of ['嗯', '好', '今天下雨了', '明天再聊']) expect(nextInteractionMode(t, 'quiet')).toBe('quiet');
    expect(nextInteractionMode('我又想聊了', 'quiet')).toBe('listening');
    expect(nextInteractionMode('换个话题', 'quiet')).toBe('light');
    expect(nextInteractionMode('收到', 'light')).toBe('light');
    expect(nextInteractionMode('先听我说', 'light')).toBe('listening');
  });
  it('does not let quotations, third parties, or a specific rejected topic control the state', () => {
    for (const t of ['朋友说晚安', '她说：不想聊了', '她说，先不聊了', '他对我说，我先睡了', '“不想聊了”怎么回复', '晚安是什么意思', '不想聊工作'])
      expect(nextInteractionMode(t)).toBe('listening');
    expect(nextInteractionMode('你好，我先睡了')).toBe('quiet');
    expect(nextInteractionMode('晚安，我现在又想聊了')).toBe('listening');
    for (const t of ['先不说了', '不聊了']) expect(nextInteractionMode(t)).toBe('quiet');
  });
  it('uses a fresh sourced thread once and waits instead of rotating generic topics', () => {
    const now = Date.now();
    const input = { messages: [{ speaker: 'user' as const, text: '今天想聊聊我的虚构小花园', createdAt: now }], interaction: 'listening' as const };
    const follow = chooseInitiativeTopic(input, [], s => `fake-${s.length}`, now)!;
    expect(follow).toMatchObject({ kind: 'follow-up', anchor: input.messages[0]!.text });
    expect(chooseInitiativeTopic(input, [follow.key], s => `fake-${s.length}`, now)).toBeUndefined();
    expect(chooseInitiativeTopic({ ...input, messages: [] }, [], s => s, now)).toBeUndefined();
  });
  it('blocks exact or very similar repeats, but does not claim semantic duplicate detection', () => {
    const history = [{ speaker: 'assistant' as const, text: '如果有半天自由时间，你更想去公园还是海边？' }];
    expect(repeatedInitiative('如果有半天自由时间，你更想去公园还是海边！', history)).toBe(true);
    expect(repeatedInitiative('如果有半天自由时间，你更想去公园还是海边呢？', history)).toBe(true);
    expect(repeatedInitiative('今天要不要玩一个词语小游戏？', history)).toBe(false);
  });
  it('marks recent AI turns for ordinary conversational variety without blocking explicit recall or exporting internal topic keys', () => {
    const c: ChatContext = { role: { id: 'r', name: '测试', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '', version: 1, createdAt: 1 },
      messages: Array.from({ length: 10 }, (_, i) => ({ speaker: i % 2 ? 'assistant' : 'user', text: `t${i}` })), memories: [], examples: [], message: '刚才你问了什么？' };
    const normal = JSON.parse(companionMessages(c).at(-1)!.content);
    expect(normal.recentAssistantTurnsToAvoidRepeating).toEqual(['t5', 't7', 't9']); expect(normal.currentMessage).toBe(c.message);
    const proactive = JSON.parse(companionMessages({ ...c, intent: 'initiative', initiativeTopic: { key: 'internal-only-hash', kind: 'fresh', instruction: '轻量邀请' } }).at(-1)!.content);
    expect(proactive.initiativeTopic).not.toHaveProperty('key'); expect(proactive).not.toHaveProperty('recentAssistantTurnsToAvoidRepeating');
  });
});
