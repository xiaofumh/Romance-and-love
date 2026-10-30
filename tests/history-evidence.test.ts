import { describe, expect, it } from 'vitest';
import { historyEvidence } from '../src/server/history-evidence';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
import { selectContext } from '../src/shared/interaction';
import type { Conversation } from '../src/shared/companion';
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
  it('keeps an implicit correction next to its user subject instead of three higher-scoring old claims', () => {
    const c: ChatContext = { ...context, messages: [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'assistant', text: '蓝色笔记本的代号是海盐云，对吧？' },
      { speaker: 'user', text: '对，蓝色笔记本的代号就是海盐云' },
      { speaker: 'user', text: '不对，应该是青柠桥' },
      { speaker: 'assistant', text: '好，改成青柠桥' },
    ] };
    const evidence = historyEvidence(c);
    expect(evidence).toHaveLength(3);
    expect(evidence).toContainEqual({ index: 2, speaker: 'user', text: c.messages[2]!.text });
    expect(evidence).toContainEqual({ index: 3, speaker: 'user', text: '不对，应该是青柠桥' });
    expect(evidence.every(e => e.text === c.messages[e.index]!.text)).toBe(true);
    expect(evidence.map(e => e.index)).toEqual([...evidence.map(e => e.index)].sort((a, b) => a - b));
  });
  it('bridges short acknowledgements and repeated corrections but pins only the latest correction', () => {
    const c: ChatContext = { ...context, messages: [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' }, { speaker: 'assistant', text: '收到' },
      { speaker: 'user', text: '嗯' }, { speaker: 'assistant', text: '好' },
      { speaker: 'user', text: '不对，应该是青柠桥' }, { speaker: 'assistant', text: '好的' },
      { speaker: 'user', text: '再更正一次，应该是檀木舟' },
    ] };
    const evidence = historyEvidence(c);
    expect(evidence).toContainEqual({ index: 0, speaker: 'user', text: c.messages[0]!.text });
    expect(evidence).toContainEqual({ index: 6, speaker: 'user', text: c.messages[6]!.text });
    expect(evidence.some(e => e.index === 4)).toBe(false);
    expect(evidence.length).toBeLessThanOrEqual(3);
  });
  it('does not attach a bicycle correction to a notebook, and retains its actual subject when asked about the bicycle', () => {
    const messages: ChatContext['messages'] = [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' }, { speaker: 'assistant', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'user', text: '我的蓝色自行车的代号是橙子' }, { speaker: 'assistant', text: '橙子，收到' },
      { speaker: 'user', text: '不对，应该是青柠桥' },
    ];
    expect(historyEvidence({ ...context, messages }).some(e => e.text.includes('青柠桥'))).toBe(false);
    const bicycle = historyEvidence({ ...context, messages, message: '蓝色自行车的代号是什么？' });
    expect(bicycle).toContainEqual({ index: 2, speaker: 'user', text: messages[2]!.text });
    expect(bicycle).toContainEqual({ index: 4, speaker: 'user', text: messages[4]!.text });
  });
  it('does not cross a near-identical object or a substantive topic change', () => {
    const messages: ChatContext['messages'] = [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' }, { speaker: 'assistant', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'user', text: '红色笔记本的代号是橙子' }, { speaker: 'user', text: '不对，应该是青柠桥' },
    ];
    expect(historyEvidence({ ...context, messages }).some(e => e.index === 3)).toBe(false);
    messages[2] = { speaker: 'user', text: '换个话题，我们聊聊电影' };
    expect(historyEvidence({ ...context, messages }).some(e => e.index === 3)).toBe(false);
  });
  it('treats an explicit correction about another object as a topic boundary', () => {
    const messages: ChatContext['messages'] = [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'assistant', text: '蓝色笔记本的代号是海盐云，对吧？' },
      { speaker: 'user', text: '不对，自行车的代号应该是橙子' },
      { speaker: 'assistant', text: '橙子，收到' },
      { speaker: 'user', text: '不对，应该是青柠桥' },
    ];
    expect(historyEvidence({ ...context, messages }).map(e => e.index)).toEqual([0, 1]);
    const bicycle = historyEvidence({ ...context, messages, message: '自行车的代号是什么？' });
    expect(bicycle.map(e => e.index)).toEqual([2, 4]);
  });
  it('binds a value-only correction to the latest explicit correction of the same subject', () => {
    const messages: ChatContext['messages'] = [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'assistant', text: '蓝色笔记本的代号是海盐云，对吧？' },
      { speaker: 'user', text: '更正蓝色笔记本的代号为橙子' },
      { speaker: 'assistant', text: '收到' },
      { speaker: 'user', text: '不对，应该是青柠桥' },
    ];
    const evidence = historyEvidence({ ...context, messages });
    expect(evidence.map(e => e.index)).toContain(2);
    expect(evidence.map(e => e.index)).toContain(4);
    expect(evidence.length).toBeLessThanOrEqual(3);
  });
  it('does not link an unspecified question merely because several objects have a code', () => {
    const messages: ChatContext['messages'] = [
      { speaker: 'user', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'user', text: '自行车的代号是橙子' },
      { speaker: 'user', text: '不对，应该是青柠桥' },
    ];
    expect(historyEvidence({ ...context, messages, message: '代号是什么？' })).toEqual([]);
  });
  it('does not elevate quotations or another person’s correction into a user correction', () => {
    const messages: ChatContext['messages'] = [{ speaker: 'user', text: '蓝色笔记本的代号是海盐云' },
      { speaker: 'user', text: '她说：“不对，应该是青柠桥”' }];
    expect(historyEvidence({ ...context, messages }).some(e => e.index === 1)).toBe(false);
    messages[1] = { speaker: 'user', text: '“不对，应该是青柠桥”这句话是什么意思' };
    expect(historyEvidence({ ...context, messages }).some(e => e.index === 1)).toBe(false);
  });
  it('returns no invented link when the subject is outside the supplied or corrected context', () => {
    const messages: Conversation['messages'] = [
      { id: 'm0', requestId: 'r0', speaker: 'user', text: '蓝色笔记本的代号是海盐云', createdAt: 1 },
      { id: 'm1', requestId: 'r0', speaker: 'assistant', text: '收到', createdAt: 2 },
      { id: 'm2', requestId: 'r1', speaker: 'user', text: '不对，应该是青柠桥', createdAt: 3 },
    ];
    const conversation: Conversation = { id: 'c', roleId: 'r', title: '', createdAt: 1, updatedAt: 3, messages, contextAfterId: 'm1', contextRounds: 12 };
    const visible = selectContext(conversation, true);
    expect(historyEvidence({ ...context, messages: visible })).toEqual([]);
    expect(historyEvidence({ ...context, messages: [{ speaker: 'user', text: '不对，应该是青柠桥' }] })).toEqual([]);
    expect(historyEvidence({ ...context, messages, intent: 'initiative' })).toEqual([]);
  });
});
