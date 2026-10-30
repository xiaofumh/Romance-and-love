import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createService } from '../src/server/service';
import { MemoryRepository, MemoryBudget } from '../src/server/state';
import { POLICY_VERSION } from '../src/shared/contracts';
import type { CompanionMemory, MemorySource } from '../src/shared/companion';
import { appendMemorySource, selectMemories } from '../src/server/companion-memory';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';

const now = Date.parse('2026-10-30T04:00:00Z');
const memory = (id: string, extra: Partial<CompanionMemory> = {}): CompanionMemory => ({ id, roleId: 'r', text: `资料${id}`, subject: 'user', status: 'confirmed', version: 1, createdAt: now, ...extra });

describe('external memory selection (pure rules, no model/network)', () => {
  it('retrieves a relevant old fact beyond the former ten-entry prefix, without exposing another role in the audit', () => {
    const items = Array.from({ length: 14 }, (_, i) => memory('new' + i, { text: '最近的普通资料' + i }));
    items.push(memory('old', { text: '我喜欢喝乌龙茶', topic: '乌龙茶', createdAt: now - 180 * 86400000 }));
    items.push(memory('foreign', { roleId: 'other', text: '乌龙茶私密' }));
    const r = selectMemories(items, 'r', '乌龙茶', now);
    expect(r.memories[0]?.id).toBe('old'); expect(JSON.stringify(r.audit)).not.toContain('foreign');
    expect(r.memories.length).toBeLessThanOrEqual(10);
  });
  it('excludes pending, expired, duplicate and conflicting records before ranking, even with maximum importance', () => {
    const items = [memory('pending', { status: 'pending', importance: 5 }), memory('expired', { expiresAt: now, importance: 5 }),
      memory('a', { topic: '当前城市', text: '住上海' }), memory('b', { topic: '当前城市', text: '住北京' }),
      memory('dup1', { text: '喜欢茶' }), memory('dup2', { text: ' 喜欢 茶！' })];
    const r = selectMemories(items, 'r', '喜欢茶当前城市', now);
    expect(r.audit.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending', reason: 'pending', selected: false }),
      expect.objectContaining({ id: 'expired', reason: 'expired', selected: false }),
      expect.objectContaining({ id: 'a', reason: 'conflict', selected: false }),
      expect.objectContaining({ id: 'b', reason: 'conflict', selected: false }),
      expect.objectContaining({ id: 'dup2', reason: 'duplicate', selected: false }),
    ])); expect(r.memories.map(m => m.id)).toEqual(['dup1']);
  });
  it('decays events faster than preferences, keeps explicit boundaries, and never reinforces on retrieval', () => {
    const items = [memory('event', { kind: 'event', createdAt: now - 30 * 86400000, confirmedAt: now }),
      memory('pref', { kind: 'preference', createdAt: now - 30 * 86400000 }),
      memory('boundary', { kind: 'boundary', createdAt: now - 1000 * 86400000 })];
    const before = JSON.stringify(items), r = selectMemories(items, 'r', '', now);
    expect(r.audit.entries.find(e => e.id === 'event')!.recency).toBeLessThan(.001);
    expect(r.audit.entries.find(e => e.id === 'pref')!.recency).toBeGreaterThan(.8);
    expect(r.audit.entries.find(e => e.id === 'boundary')!.recency).toBe(1);
    for (let i = 0; i < 10; i++) selectMemories(items, 'r', '', now);
    expect(JSON.stringify(items)).toBe(before);
  });
  it('bounds unrelated fallback and source evidence, and honours memory-off regardless of relevance', () => {
    const items = Array.from({ length: 15 }, (_, i) => memory('m' + i));
    expect(selectMemories(items, 'r', '没有重叠的话题', now).memories).toHaveLength(2);
    const r = selectMemories(items, 'r', '资料', now, false); expect(r.memories).toEqual([]);
    expect(r.audit.entries.every(e => e.reason === 'disabled')).toBe(true);
    const source: MemorySource = { kind: 'message', conversationId: 'c', messageId: 'u1', speaker: 'user', occurredAt: now, recordedAt: now };
    expect(appendMemorySource([source], source)).toHaveLength(1);
    let sources: MemorySource[] = [];
    for (let i = 0; i < 10; i++) sources = appendMemorySource(sources, { ...source, messageId: 'u' + i });
    expect(sources).toHaveLength(4);
  });
});

async function setup() {
  let clock = now; const contexts: ChatContext[] = [], repo = new MemoryRepository(), budget = new MemoryBudget();
  const service = createService({ repository: repo, budget, id: randomUUID, now: () => clock,
    hash: t => createHash('sha256').update(t).digest('hex'), enabled: true, mode: 'cloud', chatDailyLimit: 1000,
    moderator: { check: async () => true }, provider: { name: 'synthetic-memory-test', generate: async () => ({ output: {} }),
      chat: async c => { contexts.push(c); return { output: { text: c.intent === 'initiative' ? '合成主动内容：花园的颜色很柔和。' : '合成测试回复' } }; } } });
  const raw = (action: string, payload: unknown = {}, uid = 'A', requestId = randomUUID()) => service.handle(uid, { action, payload, clientRequestId: requestId });
  const api = async (action: string, payload: unknown = {}, uid = 'A'): Promise<any> => { const r = await raw(action, payload, uid); if (!r.ok) throw new Error(r.error.code); return r.data; };
  const prepare = async (uid = 'A') => {
    await api('consent.update', { accepted: true, version: POLICY_VERSION }, uid);
    await api('settings.update', { historyEnabled: true, memoryEnabled: true }, uid);
    const role = await api('companion.role.save', { name: '合成角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '', proactiveEnabled: true, autonomousEnabled: true }, uid);
    const chat = await api('companion.conversation.create', { roleId: role.id }, uid); return { role, chat };
  };
  const { role, chat } = await prepare();
  const data = () => api('companion.data', { id: role.id });
  return { raw, api, role, chat, contexts, repo, budget, data, prepare, advance: (n: number) => { clock += n; },
    send: (text: string) => api('companion.send', { conversationId: chat.id, text }),
    save: (text: string, extra = {}) => api('companion.memory.save', { roleId: role.id, text, confirmed: false, ...extra }) };
}

describe('external memory service integration', () => {
  it('saves an explicit remember request only as a sourced pending candidate, with idempotent replay', async () => {
    const h = await setup(), requestId = randomUUID(), payload = { conversationId: h.chat.id, text: '记住：我喜欢喝乌龙茶' };
    expect((await h.raw('companion.send', payload, 'A', requestId)).ok).toBe(true);
    await h.raw('companion.send', payload, 'A', requestId);
    const d = await h.data(); expect(d.memories).toHaveLength(1);
    const m = d.memories[0]; expect(m).toMatchObject({ status: 'pending', subject: 'unspecified', text: '我喜欢喝乌龙茶', sources: [{ kind: 'message', speaker: 'user', occurredAt: now }] });
    await h.send('乌龙茶'); expect(h.contexts.at(-1)!.memories).toEqual([]);
    await h.api('companion.memory.save', { roleId: h.role.id, id: m.id, version: m.version, text: m.text, subject: 'user', confirmed: true, kind: 'preference' });
    await h.send('乌龙茶'); expect(h.contexts.at(-1)!.memories[0]).toMatchObject({ id: m.id, subject: 'user' });
    const wire = JSON.parse(companionMessages(h.contexts.at(-1)!)[1]!.content);
    expect(wire.confirmedMemories[0].sources[0].sourceBeijingTime).toBe('2026-10-30 12:00:00');
  });
  it('does not extract reported/quoted/hypothetical requests, ordinary chat or memory-disabled messages', async () => {
    const h = await setup();
    for (const text of ['朋友说：记住我喜欢茶', '记住：“我喜欢茶”', '记住：如果我喜欢茶', '我喜欢喝乌龙茶']) await h.send(text);
    expect((await h.data()).memories).toEqual([]);
    await h.api('settings.update', { memoryEnabled: false }); await h.send('记住：我喜欢茶'); expect((await h.data()).memories).toEqual([]);
  });
  it('resolves original user sources on the server and rejects assistant, cross-user, cross-role and forged provenance', async () => {
    const h = await setup(), sent = await h.send('我喜欢喝茶'), detail = await h.api('companion.conversation.get', { id: h.chat.id });
    const user = detail.conversation.messages[0], assistant = sent.message;
    const source = { kind: 'message', conversationId: h.chat.id, messageId: user.id };
    const m = await h.save('我喜欢喝茶', { source }); expect(m.sources[0]).toMatchObject({ ...source, speaker: 'user', occurredAt: now });
    expect(await h.api('companion.memory.source', { id: m.id })).toMatchObject({ available: true, text: '我喜欢喝茶' });
    for (const bad of [{ ...source, speaker: 'user' }, { ...source, occurredAt: 123 }, { ...source, messageId: assistant.id }]) {
      expect(await h.raw('companion.memory.save', { roleId: h.role.id, text: '合成测试回复', confirmed: false, source: bad })).toMatchObject({ ok: false });
    }
    const b = await h.prepare('B');
    expect(await h.raw('companion.memory.save', { roleId: b.role.id, text: m.text, confirmed: false, source }, 'B')).toMatchObject({ ok: false });
    const other = await h.prepare();
    expect(await h.raw('companion.memory.save', { roleId: other.role.id, text: m.text, confirmed: false, source })).toMatchObject({ ok: false });
    expect(await h.raw('companion.memory.inspect', { roleId: h.role.id, text: '茶' }, 'B')).toMatchObject({ ok: false });
    expect(await h.raw('companion.memory.source', { id: m.id }, 'B')).toMatchObject({ ok: false });
  });
  it('deduplicates new copies without implicitly confirming, resets source evidence on correction and protects versions', async () => {
    const h = await setup(); await h.send('我喜欢喝茶'); const messages = (await h.api('companion.conversation.get', { id: h.chat.id })).conversation.messages;
    const source = { kind: 'message', conversationId: h.chat.id, messageId: messages[0].id };
    const m = await h.save('我喜欢喝茶', { source, subject: 'user', topic: '饮食' });
    const duplicate = await h.save('我喜欢喝茶', { subject: 'user', topic: '饮食', confirmed: true });
    expect(duplicate).toMatchObject({ id: m.id, version: 1, status: 'pending' }); expect((await h.data()).memories).toHaveLength(1);
    const edited = await h.save('不喝茶', { id: m.id, version: m.version, confirmed: true });
    expect(edited.sources).toEqual([{ kind: 'manual', recordedAt: now }]);
    expect(await h.raw('companion.memory.save', { roleId: h.role.id, id: m.id, version: m.version, text: '过时版本', confirmed: true })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    await h.send('喝茶'); expect(h.contexts.at(-1)!.memories.map(m => m.text)).toEqual(['不喝茶']); expect(h.contexts.at(-1)!.messages).toEqual([]);
  });
  it('inspects without model calls or quota changes, records content-free audits, and scrubs them on deletion', async () => {
    const h = await setup(), m = await h.save('虚构私密事实', { confirmed: true, subject: 'user' });
    const before = await h.api('session.bootstrap');
    const dry = await h.api('companion.memory.inspect', { roleId: h.role.id, text: '虚构私密事实' }); expect(dry.entries[0].selected).toBe(true);
    expect(h.contexts).toHaveLength(0); expect(await h.api('session.bootstrap')).toMatchObject({ chatRemaining: before.chatRemaining });
    const sent = await h.send('虚构私密事实'); expect(sent.job.metrics.memorySelection.entries[0]).toMatchObject({ id: m.id, selected: true });
    expect(JSON.stringify(sent.job.metrics.memorySelection)).not.toContain('虚构私密事实');
    await h.api('companion.delete', { kind: 'memory', id: m.id });
    expect((await h.api('companion.conversation.get', { id: h.chat.id })).jobs[0].metrics.memorySelection.entries).toEqual([]);
    await h.send('继续'); expect(JSON.stringify(h.contexts.at(-1))).not.toContain('虚构私密事实');
  });
  it('uses the same ranking for background initiative and removes document-derived facts when sources expire', async () => {
    const h = await setup();
    const doc = await h.api('companion.import', { roleId: h.role.id, title: '合成原文', text: '甲：小花园\n乙：花园里的紫色花', userSpeaker: '甲', referenceSpeaker: '乙', authorized: true });
    const m = await h.save('花园里的紫色花', { source: { kind: 'document', documentId: doc.id, turn: 2 }, confirmed: true });
    expect(m).toMatchObject({ subject: 'reference', documentId: doc.id, sources: [{ kind: 'document', speaker: 'reference' }] });
    await h.send('今天想聊聊我在布置的虚构小花园'); h.advance(45001);
    await h.api('companion.initiative', { conversationId: h.chat.id }); expect(h.contexts.at(-1)!.intent).toBe('initiative');
    expect(h.contexts.at(-1)!.memories.map(m => m.id)).toContain(m.id);
    h.advance(31 * 86400000); expect((await h.data()).memories).toEqual([]);
  });
  it('keeps at most eight detailed audits instead of multiplying all facts across a thousand requests', async () => {
    const h = await setup(); await h.save('喝茶', { confirmed: true });
    for (let i = 0; i < 12; i++) { h.advance(60001); await h.send('喝茶' + i); }
    const state = await h.repo.transact('A', now + 12 * 60001, s => s);
    expect(state.companion!.jobs.filter(j => j.metrics?.memorySelection)).toHaveLength(8);
    expect(state.companion!.jobs).toHaveLength(12);
  });
});
