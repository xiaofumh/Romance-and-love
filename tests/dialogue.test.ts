import { describe, expect, it } from 'vitest';
import { buildDialoguePlan, TOPIC_TTL_MS } from '../src/server/dialogue';
import { chooseInitiativeTopic } from '../src/server/initiative-topic';
import { nextInteractionMode, selectContext } from '../src/shared/interaction';
import type { ChatContext } from '../src/server/companion-prompt';
import type { Conversation } from '../src/shared/companion';
const now = Date.parse('2026-10-29T12:00:00Z');
const u = (text: string, createdAt = now - 1000) => ({ speaker: 'user' as const, text, createdAt });
const a = (text: string) => ({ speaker: 'assistant' as const, text, createdAt: now - 500 });
const plan = (messages: ChatContext['messages'], message = '') => buildDialoguePlan({ messages, message }, now);
const choose = (messages: ChatContext['messages']) => chooseInitiativeTopic({ messages }, [], t => t, now);
describe('bounded sourced dialogue planning', () => {
  it('remembers a scoped topic refusal without pausing unrelated topics', () => {
    const p = plan([u('今天工作里遇到一件事情'), a('哪件事让你烦？'), u('今天别聊工作了'), u('聊聊我正在布置的小花园')]);
    expect(p.ledger.declinedTopics).toEqual([{ topic: '工作', sourceIndex: 2 }]);
    expect(p.ledger.openThreads.map(t => t.text)).toEqual(['聊聊我正在布置的小花园']);
    expect(p.ledger.questionsAsked[0]).toMatchObject({ sourceIndex: 1, text: '哪件事让你烦？' });
    expect(nextInteractionMode('今天别聊工作了')).toBe('listening');
    expect(choose([u('今天工作里遇到一件事情'), u('今天别聊工作了')])).toBeUndefined();
    const mixed = plan([u('别聊工作了，我想聊聊虚构小花园')]);
    expect(mixed.ledger.current?.text).toBe('我想聊聊虚构小花园');
    expect(choose([u('别聊工作了，我想聊聊虚构小花园')])?.anchor).toBe('我想聊聊虚构小花园');
    expect(plan([u('我想聊聊虚构小花园，别提问')]).ledger.declinedTopics).toEqual([]);
    expect(choose([u('我想聊聊虚构小花园，别提问')])?.anchor).toBe('我想聊聊虚构小花园');
  });
  it('does not treat quotations or third party reports as topic permission changes', () => {
    for (const t of ['朋友说别聊工作了', '“别聊工作了”这句话怎么回', '她说：别聊工作了'])
      expect(plan([u(t)]).ledger.declinedTopics).toEqual([]);
    expect(plan([u('别聊工作了'), u('朋友说可以聊工作了')]).ledger.declinedTopics).toHaveLength(1);
  });
  it('requires explicit reopening and never turns acknowledgements into facts', () => {
    expect(plan([u('别聊工作了'), u('嗯')]).ledger.declinedTopics).toHaveLength(1);
    const p = plan([u('别聊工作了'), u('现在可以聊工作了')]);
    expect(p.ledger.declinedTopics).toEqual([]);
    expect(plan([], '嗯').questionAllowance).toBe('none');
    expect(plan([], '别连续问我问题，说说你对这个想法的看法。').questionAllowance).toBe('none');
    expect(plan([a('今天怎么样？'), u('还行'), a('有什么想分享的吗？')], '刚刚看完了一部电影').questionAllowance).toBe('none');
  });
  it('waits for acknowledgement, an unanswered question, absent or expired sources', () => {
    expect(choose([u('聊聊我正在布置的小花园'), a('想放什么花？')])).toBeUndefined();
    expect(choose([u('聊聊我正在布置的小花园'), a('听起来有意思。'), u('嗯')])).toBeUndefined();
    expect(choose([u('我明天要参加面试', now - TOPIC_TTL_MS)])).toBeUndefined();
    expect(choose([{ speaker: 'user', text: '没有服务端时间的旧资料' }])).toBeUndefined();
    expect(choose([u('未来消息不能作为当前依据', now + 1)])).toBeUndefined();
    expect(choose([u('聊聊我正在布置的小花园'), u('谢谢分享')])).toBeUndefined();
    expect(choose([u('我今天不想说话'), u('我又想聊了')])).toBeUndefined();
    expect(plan([u('好了先不聊吃饭了')]).ledger.declinedTopics[0]?.topic).toBe('饮食');
  });
  it('expires temporary notes, preserves exact event wording, and stores no inferred outcome', () => {
    const p = plan([u('别聊工作了', now - TOPIC_TTL_MS), u('我明天下午面试')]);
    expect(p.ledger.declinedTopics).toEqual([]);
    expect(p.ledger.current).toMatchObject({ sourceIndex: 1, text: '我明天下午面试', recordedAt: now - 1000 });
    expect(JSON.stringify(p)).not.toMatch(/面试通过|面试结束|永久记忆/);
  });
  it('cannot reconstruct notes outside a correction or selected six-round boundary', () => {
    const messages = [u('别聊工作了'), ...Array.from({ length: 14 }, (_, i) => i % 2 ? a(`回应${i}`) : u(`当前话题${i}`))]
      .map((m, i) => ({ ...m, id: `m${i}`, requestId: `r${i}` }));
    const c: Conversation = { id: 'c', roleId: 'r', title: '', createdAt: now, updatedAt: now, messages, contextRounds: 6 };
    expect(plan(selectContext(c, true)).ledger.declinedTopics).toEqual([]);
    c.contextRounds = 12; expect(plan(selectContext(c, true)).ledger.declinedTopics).toHaveLength(1);
    c.contextAfterId = 'm0'; expect(plan(selectContext(c, true)).ledger.declinedTopics).toEqual([]);
  });
  it('recognises ordinary leave/resume wording while quoted leave text has no control', () => {
    for (const t of ['我先忙，晚点聊', '先不聊了', '别追问', '明天再聊']) expect(nextInteractionMode(t)).toBe('quiet');
    expect(nextInteractionMode('好了，继续聊', 'quiet')).toBe('listening');
    expect(nextInteractionMode('好了继续聊', 'quiet')).toBe('listening');
    expect(nextInteractionMode('好了先不聊了')).toBe('quiet');
    expect(nextInteractionMode('“继续聊”是什么意思', 'quiet')).toBe('quiet');
  });
});
