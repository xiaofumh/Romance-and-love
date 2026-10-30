import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createService, type ServiceOptions } from '../src/server/service';
import { MemoryBudget, MemoryRepository } from '../src/server/state';
import { POLICY_VERSION } from '../src/shared/contracts';
import { INITIATIVE_LIMITS, interactionMode, naturalBubbles, selectContext } from '../src/shared/interaction';
import type { ChatContext } from '../src/server/companion-prompt';
import { companionMessages } from '../src/server/companion-prompt';
import type { Conversation } from '../src/shared/companion';
function harness(model?: (c: ChatContext) => Promise<{ output: unknown; usage?: { input: number; output: number } }>, options: Partial<ServiceOptions> = {}) {
  let now = Date.parse('2026-10-24T00:00:00Z'); const contexts: ChatContext[] = [], budget = new MemoryBudget();
  const service = createService({ repository: new MemoryRepository(), budget, enabled: true, mode: 'cloud', id: randomUUID,
    hash: t => createHash('sha256').update(t).digest('hex'), now: () => now, timeoutMs: 1000, callLimit: 300000, chatDailyLimit: 30,
    moderator: { check: async t => !t.includes('BLOCK_CANARY') }, provider: { name: 'UNIT_ONLY', generate: async () => ({ output: {} }),
      chat: async c => { contexts.push(c); return model ? model(c) : { output: { text: c.intent === 'initiative'
        ? `测试专用主动话题：${c.initiativeTopic?.key}`
        : '先缓一缓。\n\n想说的话，我听着。' }, usage: { input: 111, output: 9 } }; } }, ...options });
  const raw = (action: string, payload: unknown = {}, id = randomUUID(), uid = 'A') => service.handle(uid, { action, payload, clientRequestId: id });
  const api = async (action: string, payload: unknown = {}, uid = 'A'): Promise<any> => { const r = await raw(action, payload, randomUUID(), uid); if (!r.ok) throw new Error(r.error.code); return r.data; };
  return { raw, api, contexts, advance: (ms: number) => now += ms,
    async prepare(proactiveEnabled = false, uid = 'A') {
      await api('consent.update', { version: POLICY_VERSION, accepted: true }, uid); await api('settings.update', { historyEnabled: true }, uid);
      const role = await api('companion.role.save', { name: '虚构伙伴', relationship: 'partner', personality: '温柔倾听', description: '', boundaries: '', proactiveEnabled, bubbleStyle: 'natural' }, uid);
      const c = await api('companion.conversation.create', { roleId: role.id }, uid); return { role, c };
    },
    send: (conversationId: string, text = '今天想聊聊虚构的小花园') => api('companion.send', { conversationId, text }),
    initiate: (conversationId: string, id = randomUUID()) => raw('companion.initiative', { conversationId }, id),
  };
}
describe('controlled companion initiative and bounded context (no network)', () => {
  it('rejects stray reasoning markers without displaying, storing, or retrying the response', async () => {
    const h = harness(async () => ({ output: { text: '异常前缀</think>正常正文' }, usage: { input: 111, output: 9 } })), { c } = await h.prepare();
    expect(await h.raw('companion.send', { conversationId: c.id, text: '你好' })).toMatchObject({ ok: false, error: { code: 'INVALID_MODEL_OUTPUT' } });
    const d = await h.api('companion.conversation.get', { id: c.id });
    expect(d.conversation.messages).toEqual([]); expect(h.contexts).toHaveLength(1);
    expect(d.jobs.at(-1).metrics).toMatchObject({ inputTokens: 111, outputTokens: 9 });
  });
  it('defaults new and unset legacy conversations to twelve without changing an explicit six choice', async () => {
    const repo = new MemoryRepository(), h = harness(undefined, { repository: repo }), { c } = await h.prepare();
    expect(c.contextRounds).toBe(12);
    await repo.transact('A', Date.parse('2026-10-24T00:00:00Z'), s => { delete s.companion!.conversations[0]!.contextRounds; });
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.contextRounds).toBe(12);
    await h.api('companion.conversation.configure', { id: c.id, version: 1, contextRounds: 6 });
    await h.send(c.id); expect(h.contexts.at(-1)!.messages).toHaveLength(0);
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.contextRounds).toBe(6);
  });
  it('waits without a model attempt on acknowledgements, refusals and an unanswered assistant question', async () => {
    const h = harness(), { c } = await h.prepare(true);
    await h.send(c.id, '嗯'); h.advance(45001);
    expect((await h.api('companion.conversation.get', { id: c.id })).initiative.reason).toBe('no-topic');
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    await h.send(c.id, '今天别聊工作了'); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false }); expect(h.contexts).toHaveLength(2);
    const question = harness(async () => ({ output: { text: '想放什么花？' } })), own = await question.prepare(true);
    await question.send(own.c.id); question.advance(45001);
    expect(await question.initiate(own.c.id)).toMatchObject({ ok: false }); expect(question.contexts).toHaveLength(1);
  });
  it('records paid model WAIT once with metrics and no visible message, including replay', async () => {
    const h = harness(async c => ({ output: { text: c.intent === 'initiative' ? '[[WAIT]]' : '花园这个话题挺好。' }, usage: { input: 12, output: 3 } }));
    const { c } = await h.prepare(true); await h.send(c.id); h.advance(45001);
    const id = randomUUID(), first = await h.initiate(c.id, id), replay = await h.initiate(c.id, id);
    expect(first).toMatchObject({ ok: true, data: { job: { status: 'SKIPPED', metrics: { inputTokens: 12 } } } });
    if (!first.ok || !replay.ok) throw new Error('WAIT_REPLAY_FAILED');
    expect(replay.data).toEqual(first.data); expect(h.contexts).toHaveLength(2);
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(2);
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(28);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false });
  });
  it('keeps source notes isolated by conversation and excludes them after role correction', async () => {
    const h = harness(), { c, role } = await h.prepare(true);
    const other = await h.api('companion.conversation.fork', { id: c.id, contextRounds: 12 });
    await h.send(c.id, '今天别聊工作了'); await h.send(other.id);
    expect(h.contexts.at(-1)!.dialoguePlan!.ledger.declinedTopics).toEqual([]);
    await h.send(c.id, '今天我在布置一个小花园');
    expect(h.contexts.at(-1)!.dialoguePlan!.ledger.declinedTopics).toHaveLength(1);
    await h.api('companion.role.save', { id: role.id, version: role.version, name: role.name, relationship: role.relationship,
      personality: role.personality, description: '更新设定', boundaries: role.boundaries, proactiveEnabled: true });
    await h.send(c.id, '继续聊一个新的故事');
    expect(h.contexts.at(-1)!.dialoguePlan!.ledger.declinedTopics).toEqual([]);
  });
  it('uses server Beijing time and refuses a client clock field before model generation', async () => {
    const h = harness(), { c } = await h.prepare();
    expect(await h.raw('companion.send', { conversationId: c.id, text: '你好', clock: { date: '2030-01-01' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(h.contexts).toHaveLength(0); await h.send(c.id, '北京时间几点？');
    expect(h.contexts[0]!.clock).toMatchObject({ timeZone: 'Asia/Shanghai', dateTime: '2026-10-24 08:00:00' });
    expect((await h.api('companion.conversation.get', { id: c.id })).clock.dateTime).toBe('2026-10-24 08:00:00');
  });
  it('passes twelve complete user turns with initiative through the service after the 40-message storage trim', async () => {
    const h = harness(), { c } = await h.prepare(true);
    await h.api('companion.conversation.configure', { id: c.id, version: 1, contextRounds: 12 });
    for (let i = 0; i < 13; i++) {
      h.advance(600001); await h.send(c.id, `虚构第${i}轮，聊聊独立的小花园话题${i}`); h.advance(45001);
      expect(await h.initiate(c.id)).toMatchObject({ ok: true });
    }
    h.advance(600001); const reply = await h.send(c.id, '现在的窗口是什么？');
    const selected = h.contexts.at(-1)!.messages;
    expect(selected).toHaveLength(36); expect(selected.filter(m => m.speaker === 'user')).toHaveLength(12);
    expect(selected[0]!.text).toContain('虚构第1轮'); expect(reply.job.metrics.historyMessages).toBe(36);
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(40);
  });
  it('uses one model call for natural bubbles and stores one semantic assistant message', async () => {
    const h = harness(), { c } = await h.prepare(); const result = await h.send(c.id);
    expect(result.message.parts).toEqual(['先缓一缓。', '想说的话，我听着。']); expect(h.contexts).toHaveLength(1);
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(2);
    expect(result.job.metrics).toMatchObject({ contextRounds: 12, historyMessages: 0, inputTokens: 111, outputTokens: 9 });
  });
  it('does not generate initiative when disabled, too early, or before any user message', async () => {
    const h = harness(), off = await h.prepare(), on = await h.prepare(true);
    expect(await h.initiate(on.c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    await h.send(off.c.id); await h.send(on.c.id); h.advance(INITIATIVE_LIMITS.idleMs - 1);
    expect(await h.initiate(on.c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    h.advance(10); expect(await h.initiate(off.c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } }); expect(h.contexts).toHaveLength(2);
  });
  it('generates only an assistant initiative, is idempotent and counts one personal/global attempt', async () => {
    const h = harness(), { c } = await h.prepare(true); await h.send(c.id); h.advance(INITIATIVE_LIMITS.idleMs + 1);
    const id = randomUUID(), first = await h.initiate(c.id, id), second = await h.initiate(c.id, id);
    if (!first.ok || !second.ok) throw new Error('INITIATIVE_FAILED'); expect(second.data).toEqual(first.data);
    expect(first).toMatchObject({ ok: true, data: { message: { speaker: 'assistant', kind: 'initiative' } } });
    const detail = await h.api('companion.conversation.get', { id: c.id }); expect(detail.conversation.messages).toHaveLength(3);
    expect(detail.conversation.messages.filter((m: any) => m.speaker === 'user')).toHaveLength(1);
    expect(h.contexts[1]).toMatchObject({ intent: 'initiative', message: '' });
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(28);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } }); expect(h.contexts).toHaveLength(2);
  });
  it('honours explicit quiet and cooldown even after page reloads; a new message can resume', async () => {
    const h = harness(), { c } = await h.prepare(true); await h.send(c.id, '晚安'); h.advance(600000);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    await h.send(c.id, '我又想聊了，想聊聊虚构花园'); h.advance(45001); expect(await h.initiate(c.id)).toMatchObject({ ok: true });
    await h.send(c.id, '换个话题，今天想讨论虚构的电影'); h.advance(45001); expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    h.advance(300000); expect(await h.initiate(c.id)).toMatchObject({ ok: true }); expect(h.contexts.at(-1)!.interaction).toBe('light');
  });
  it('does not auto-retry a failed billable initiative, and does not invent a user message', async () => {
    const h = harness(async c => { if (c.intent === 'initiative') throw new Error('PROVIDER_FAILURE'); return { output: { text: '收到' } }; });
    const { c } = await h.prepare(true); await h.send(c.id); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false }); h.advance(600000);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(2); expect(h.contexts).toHaveLength(2);
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(29);
  });
  it('respects foreign user IDs and authorization withdrawal', async () => {
    const h = harness(), a = await h.prepare(true), b = await h.prepare(true, 'B'); await h.send(a.c.id); h.advance(45001);
    expect(await h.raw('companion.initiative', { conversationId: a.c.id }, randomUUID(), 'B')).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    await h.api('consent.update', { version: POLICY_VERSION, accepted: false });
    expect(await h.initiate(a.c.id)).toMatchObject({ ok: false, error: { code: 'CONSENT_REQUIRED' } }); expect(h.contexts).toHaveLength(1); expect(b.c.id).not.toBe(a.c.id);
  });
  it('cannot use old context to initiate after a fact/role correction barrier', async () => {
    const h = harness(), { role, c } = await h.prepare(true); await h.send(c.id); h.advance(45001);
    await h.api('companion.role.save', { name: role.name, relationship: role.relationship, personality: role.personality, description: '', boundaries: '', id: role.id, version: role.version, proactiveEnabled: true });
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
  });
  it('does not bypass model shutdown or the existing shared global call limit', async () => {
    const disabled = harness(undefined, { enabled: false }), off = await disabled.prepare(true);
    expect(await disabled.initiate(off.c.id)).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } }); expect(disabled.contexts).toHaveLength(0);
    const h = harness(undefined, { callLimit: 1 }), { c } = await h.prepare(true); await h.send(c.id); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } }); expect(h.contexts).toHaveLength(1);
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(29);
  });
  it('rejects a late initiative after the user disables the role option', async () => {
    let release!: (v: { output: unknown }) => void, started!: () => void; const begin = new Promise<void>(r => started = r);
    const h = harness(async c => { if (c.intent !== 'initiative') return { output: { text: '收到' } }; started(); return new Promise(r => release = r); });
    const { role, c } = await h.prepare(true); await h.send(c.id); h.advance(45001); const pending = h.initiate(c.id); await begin;
    await h.api('companion.role.save', { id: role.id, version: role.version, name: role.name, relationship: role.relationship,
      personality: role.personality, description: '', boundaries: '', proactiveEnabled: false });
    release({ output: { text: '不应落库的主动消息' } }); expect(await pending).toMatchObject({ ok: false, error: { code: 'DATA_CHANGED' } });
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(2);
  });
  it('compares six/twelve windows using independent forks of the exact same twelve-round history', async () => {
    const h = harness(), { c } = await h.prepare();
    for (let i = 0; i < 12; i++) { h.advance(60001); await h.send(c.id, `seed_${i}`); }
    const a = await h.api('companion.conversation.fork', { id: c.id, contextRounds: 6 }), b = await h.api('companion.conversation.fork', { id: c.id, contextRounds: 12 });
    expect(a.messages).toEqual(b.messages); expect(a.messages).toHaveLength(24);
    await h.send(a.id, '相同的验收问题'); await h.send(b.id, '相同的验收问题');
    expect(h.contexts.at(-2)!.messages).toHaveLength(12); expect(h.contexts.at(-1)!.messages).toHaveLength(24);
    expect(h.contexts.at(-2)!.messages[0]!.text).toBe('seed_6'); expect(h.contexts.at(-1)!.messages[0]!.text).toBe('seed_0');
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.messages).toHaveLength(24);
  });
  it('only accepts six/twelve and rejects stale settings or a foreign fork', async () => {
    const h = harness(), a = await h.prepare(); await h.prepare(false, 'B');
    await h.api('companion.conversation.configure', { id: a.c.id, version: 1, contextRounds: 12 });
    expect(await h.raw('companion.conversation.configure', { id: a.c.id, version: 1, contextRounds: 6 })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await h.raw('companion.conversation.configure', { id: a.c.id, version: 2, contextRounds: 60 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await h.raw('companion.conversation.fork', { id: a.c.id, contextRounds: 12 }, randomUUID(), 'B')).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(30);
  });
  it('retains correction and memory-off boundaries in both windows and forks', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, requestId: `r${i}`, speaker: i % 2 ? 'assistant' as const : 'user' as const, text: `t${i}`, createdAt: i, memoryUsed: i === 23 }));
    const c: Conversation = { id: 'c', roleId: 'r', title: '', messages, createdAt: 0, updatedAt: 0, contextRounds: 12, contextAfterId: 'm25' };
    expect(selectContext(c, false).map(m => m.text)).toEqual(['t26', 't27', 't28', 't29']);
    c.contextAfterId = undefined; expect(selectContext(c, false).map(m => m.text)).toEqual(['t24', 't25', 't26', 't27', 't28', 't29']);
  });
  it('keeps code or a single short reply intact, bounds bubbles and does not infer a mood diagnosis', () => {
    expect(naturalBubbles('a\n\nb\n\nc\n\nd', 'natural')).toEqual(['a', 'b', 'c\n\nd']);
    expect(naturalBubbles('```\na\n\nb\n```', 'natural')).toHaveLength(1); expect(naturalBubbles('好呀', 'natural')).toEqual(['好呀']);
    expect(interactionMode('今天很累')).toBe('listening'); expect(interactionMode('不想说了')).toBe('quiet'); expect(interactionMode('朋友说晚安')).toBe('listening');
  });
  it('distinguishes current history recall from confirmed long-term memory and temporary answer formats', async () => {
    const h = harness(), { c } = await h.prepare(); await h.send(c.id, '这轮只回复收到'); await h.send(c.id, '上一轮说了什么？');
    const wire = companionMessages(h.contexts.at(-1)!);
    expect(wire[0]!.content).toContain('不需要先存入长期记忆'); expect(wire[0]!.content).toContain('只约束对应的那轮回复');
    expect(JSON.parse(wire.at(-1)!.content).currentMessage).toBe('上一轮说了什么？');
  });
  it('keeps a paused conversation paused after a short acknowledgement but answers ordinary messages', async () => {
    const h = harness(), { c } = await h.prepare(true);
    await h.send(c.id, '我今天不想说话'); await h.send(c.id, '嗯'); h.advance(600000);
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.interaction.mode).toBe('quiet');
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    expect(h.contexts).toHaveLength(2); await h.send(c.id, '我又想聊了，想聊聊虚构花园'); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: true });
  });
  it('manual interaction choices are versioned, owned, free of model calls, and do not enable an off role', async () => {
    const h = harness(), { c } = await h.prepare(false); await h.prepare(true, 'B');
    await h.api('companion.interaction.configure', { id: c.id, version: 1, mode: 'light' });
    expect(await h.raw('companion.interaction.configure', { id: c.id, version: 1, mode: 'quiet' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await h.raw('companion.interaction.configure', { id: c.id, version: 2, mode: 'quiet' }, randomUUID(), 'B')).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(await h.raw('companion.interaction.configure', { id: c.id, version: 2, mode: 'diagnosed' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const detail = await h.api('companion.conversation.get', { id: c.id });
    expect(detail.conversation.interaction.mode).toBe('light'); expect(detail.initiative.enabled).toBe(false); expect(h.contexts).toHaveLength(0);
  });
  it('rejects duplicate proactive text without appending it or retrying a consumed topic', async () => {
    const h = harness(async () => ({ output: { text: '我在呢，随时都可以叫我。' } })), { c } = await h.prepare(true);
    await h.send(c.id, '今天想聊一个轻松话题'); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_REPEATED' } });
    expect(await h.initiate(c.id)).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } });
    const detail = await h.api('companion.conversation.get', { id: c.id }); expect(detail.conversation.messages).toHaveLength(2);
    expect(detail.conversation.interaction.recentTopics).toHaveLength(1); expect(h.contexts).toHaveLength(2);
    expect((await h.api('session.bootstrap')).chatRemaining).toBe(29);
  });
  it('manual pause cancels an in-flight proactive result before it can be stored', async () => {
    let release!: (v: { output: unknown }) => void, start!: () => void; const began = new Promise<void>(r => start = r);
    const h = harness(async c => { if (c.intent !== 'initiative') return { output: { text: '收到' } }; start(); return new Promise(r => release = r); });
    const { c } = await h.prepare(true); await h.send(c.id, '今天想聊聊虚构花园'); h.advance(45001);
    const pending = h.initiate(c.id); await began; await h.api('companion.interaction.configure', { id: c.id, version: 1, mode: 'quiet' });
    release({ output: { text: '这条迟到的主动回复不应保存' } });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'DATA_CHANGED' } });
    const detail = await h.api('companion.conversation.get', { id: c.id }); expect(detail.conversation.messages).toHaveLength(2); expect(detail.initiative.reason).toBe('quiet');
  });
  it('clears derived topic history on role correction and memory deletion without overriding quiet', async () => {
    const h = harness(), { c, role } = await h.prepare(true); await h.send(c.id, '今天聊聊我的虚构小花园'); h.advance(45001);
    expect(await h.initiate(c.id)).toMatchObject({ ok: true });
    await h.api('companion.interaction.configure', { id: c.id, version: 1, mode: 'quiet' });
    await h.api('companion.role.save', { id: role.id, version: role.version, name: role.name, relationship: role.relationship,
      personality: role.personality, description: '纠正虚构角色设定', boundaries: '', proactiveEnabled: true });
    let d = await h.api('companion.conversation.get', { id: c.id }); expect(d.conversation.interaction.recentTopics).toEqual([]); expect(d.conversation.interaction.mode).toBe('quiet');
    const memory = await h.api('companion.memory.save', { roleId: role.id, text: '虚构设定', subject: 'role', confirmed: false });
    await h.api('companion.delete', { kind: 'memory', id: memory.id }); d = await h.api('companion.conversation.get', { id: c.id });
    expect(d.conversation.messages).toEqual([]); expect(d.conversation.interaction.recentTopics).toEqual([]); expect(d.conversation.interaction.mode).toBe('quiet');
  });
  it('changing another conversation state does not cancel the current conversation model reply', async () => {
    let release!: (v: { output: unknown }) => void, start!: () => void; const began = new Promise<void>(r => start = r);
    const h = harness(async () => { start(); return new Promise(r => release = r); }), { c, role } = await h.prepare(true);
    const other = await h.api('companion.conversation.fork', { id: c.id, contextRounds: 12 });
    const pending = h.send(c.id, '当前会话自己的虚构问题'); await began;
    await h.api('companion.interaction.configure', { id: other.id, version: 1, mode: 'quiet' });
    release({ output: { text: '当前会话正常完成' } }); expect((await pending).job.status).toBe('SUCCEEDED');
    expect((await h.api('companion.conversation.get', { id: c.id })).conversation.interaction.mode).toBe('listening');
  });
});
