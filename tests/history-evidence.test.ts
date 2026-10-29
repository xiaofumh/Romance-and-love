import { describe, expect, it } from 'vitest';
import { historyEvidence } from '../src/server/history-evidence';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
const context: ChatContext = { role: { id: 'r', name: '虚构角色', version: 1, createdAt: 1, personality: '温柔倾听',
  relationship: 'friend', description: '', boundaries: '' }, memories: [], examples: [], message: '蓝色笔记本的代号是什么？', messages: [] };
describe('query-time emphasis stays inside the already selected window', () => {
  it('prioritises a factual answer and final-turn statement guidance over topic steering', () => {
    const c: ChatContext = { ...context, dialoguePlan: { action: 'answer', questionAllowance: 'none',
      ledger: { openThreads: [], declinedTopics: [], questionsAsked: [], lastUserText: '' } } };
    const wire = companionMessages(c);
    expect(JSON.parse(wire[1]!.content)).not.toHaveProperty('dialoguePlan');
    const current = JSON.parse(wire.at(-1)!.content);
    expect(current.task).toContain('过去那轮的限制'); expect(current.replyGuidance).toContain('不新增反问');
  });
  it('selects verbatim related history, not unrelated examples or confirmed memories', () => {
    const c = { ...context, messages: [{ speaker: 'user' as const, text: '蓝色笔记本代号薄荷星。' },
      { speaker: 'assistant' as const, text: '收到' }, { speaker: 'user' as const, text: '今天有雨' }] };
    expect(historyEvidence(c)).toEqual([{ index: 0, speaker: 'user', text: c.messages[0]!.text }]);
    const wire = companionMessages(c); expect(JSON.parse(wire.at(-1)!.content).inWindowEvidence[0].text).toBe(c.messages[0]!.text);
  });
  it('does not invent out-of-window evidence or use it to initiate', () => {
    expect(historyEvidence(context)).toEqual([]);
    expect(historyEvidence({ ...context, intent: 'initiative', messages: [{ speaker: 'user', text: '蓝色笔记本代号秘密' }] })).toEqual([]);
  });
  it('bounds evidence to three original excerpts in chronological order, preserving correction text', () => {
    const c = { ...context, messages: ['蓝色笔记本代号旧值', '蓝色笔记本是旧值？', '更正蓝色笔记本代号新值', '蓝色笔记本代号已经更正']
      .map(text => ({ speaker: 'user' as const, text })) };
    const evidence = historyEvidence(c); expect(evidence).toHaveLength(3);
    expect(evidence.map(m => m.index)).toEqual([...evidence.map(m => m.index)].sort((a, b) => a - b));
    expect(evidence.some(m => m.text.includes('新值'))).toBe(true);
  });
});
