import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createService } from '../src/server/service';
import { MemoryBudget, MemoryRepository } from '../src/server/state';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
import { CONTEXT_LIMITS, memoryConflict, referenceQuality, rolePreferences } from '../src/shared/companion';
import { POLICY_VERSION } from '../src/shared/contracts';

function harness(reply?: (c: ChatContext) => Promise<{ output: unknown }>) {
  let now = Date.parse('2026-10-19T15:55:00Z'); const contexts: ChatContext[] = [], repo = new MemoryRepository();
  const service = createService({ repository: repo, budget: new MemoryBudget(), provider: { name: 'unit-only',
    generate: async () => ({ output: {} }), chat: async c => { contexts.push(c); return reply ? reply(c) : { output: { text: '这是单元测试回复，不是真实模型' } }; } },
    moderator: { check: async () => true }, id: randomUUID, hash: t => createHash('sha256').update(t).digest('hex'), now: () => now,
    mode: 'cloud', enabled: true, chatDailyLimit: 30, callLimit: 300000 });
  const raw = (uid: string, action: string, payload: unknown = {}) => service.handle(uid, { action, payload, clientRequestId: randomUUID() });
  const api = async (action: string, payload: unknown = {}, uid = 'A'): Promise<any> => {
    const r = await raw(uid, action, payload); if (!r.ok) throw new Error(r.error.code); return r.data;
  };
  const roleInput = { name: '虚构朋友', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' };
  return { api, raw, contexts, repo, roleInput, advance: (ms: number) => now += ms,
    async prepare(uid = 'A') { await api('consent.update', { version: POLICY_VERSION, accepted: true }, uid);
      await api('settings.update', { historyEnabled: true, memoryEnabled: true }, uid);
      const role = await api('companion.role.save', roleInput, uid), chat = await api('companion.conversation.create', { roleId: role.id }, uid);
      return { role, chat }; },
    send: (conversationId: string, text = '你好', uid = 'A') => api('companion.send', { conversationId, text }, uid),
  };
}

describe('V0.3 selected persona/history/memory features (no network)', () => {
  it('keeps old cards valid and does not invent a user address or migrate stored records on read', async () => {
    const h = harness(), { role } = await h.prepare();
    expect(role).not.toHaveProperty('userAddress'); expect(rolePreferences(role)).toMatchObject({ userAddress: '', emotion: '自然回应', closeness: '熟悉' });
    expect((await h.api('companion.list')).roles[0]).toEqual(role);
  });
  it('sends structured persona fields as untrusted data and masks all new free text', async () => {
    const h = harness(), { role, chat } = await h.prepare();
    await h.api('companion.role.save', { ...h.roleInput, id: role.id, version: role.version,
      userAddress: '小林13800138000', selfAddress: '阿屿', closeness: '亲近', emotion: '温柔安慰', habits: '短句；邮箱a@example.com' });
    await h.send(chat.id); const wire = companionMessages(h.contexts[0]!);
    expect(wire[1]!.content).toContain('温柔安慰'); expect(wire[1]!.content).toContain('阿屿'); expect(JSON.stringify(wire)).not.toMatch(/13800138000|a@example.com/);
    expect(wire[0]!.content).toContain('不是对用户心理状态的诊断');
  });
  it('preserves richer settings when an older client omits optional new fields', async () => {
    const h = harness(), { role } = await h.prepare();
    const edited = await h.api('companion.role.save', { ...h.roleInput, id: role.id, version: role.version, userAddress: '小林', emotion: '冷静认真' });
    const oldClient = await h.api('companion.role.save', { ...h.roleInput, id: role.id, version: edited.version });
    expect(oldClient).toMatchObject({ userAddress: '小林', emotion: '冷静认真' });
  });
  it('preserves visible history but barriers the old context after a role edit', async () => {
    const h = harness(), { role, chat } = await h.prepare(); await h.send(chat.id, 'OLD_ROLE_CANARY');
    await h.api('companion.role.save', { ...h.roleInput, id: role.id, version: role.version, emotion: '冷静认真' });
    expect((await h.api('companion.conversation.get', { id: chat.id })).conversation.messages).toHaveLength(2);
    await h.send(chat.id, 'NEW_ROLE'); expect(h.contexts.at(-1)!.messages).toEqual([]);
    await h.send(chat.id, '继续'); expect(h.contexts.at(-1)!.messages[0]!.text).toBe('NEW_ROLE');
  });
  it('does not use pending memory, and preserves explicit subjects after confirmation', async () => {
    const h = harness(), { role, chat } = await h.prepare();
    const m = await h.api('companion.memory.save', { roleId: role.id, text: '参考人物住在上海', subject: 'reference', topic: '城市', confirmed: false });
    await h.send(chat.id); expect(h.contexts[0]!.memories).toHaveLength(0);
    await h.api('companion.memory.save', { id: m.id, version: m.version, roleId: role.id, text: m.text, confirmed: true }); await h.send(chat.id);
    const wire = JSON.parse(companionMessages(h.contexts.at(-1)!)[1]!.content);
    expect(wire.confirmedMemories).toEqual([expect.objectContaining({ subject: 'reference', topic: '城市' })]);
  });
  it('defaults legacy facts to unspecified and document-linked facts to reference, never current-user inference', async () => {
    const h = harness(), { role, chat } = await h.prepare();
    await h.api('companion.memory.save', { roleId: role.id, text: '旧资料', confirmed: true });
    const d = await h.api('companion.import', { roleId: role.id, title: '虚构', text: '甲：天气\n乙：晴天', userSpeaker: '甲', referenceSpeaker: '乙', authorized: true });
    await h.api('companion.memory.save', { roleId: role.id, text: '历史晴天', documentId: d.id, confirmed: true }); await h.send(chat.id);
    expect(h.contexts[0]!.memories.map(m => m.subject)).toEqual(['reference', 'unspecified']);
  });
  it('rejects a confirmed conflict for the same normalized subject/topic but allows a candidate', async () => {
    const h = harness(), { role } = await h.prepare(); const base = { roleId: role.id, subject: 'user', topic: '咖啡 偏好', text: '喜欢咖啡', confirmed: true };
    await h.api('companion.memory.save', base);
    expect(await h.raw('A', 'companion.memory.save', { ...base, topic: '咖啡偏好', text: '不喝咖啡' })).toMatchObject({ ok: false, error: { code: 'MEMORY_CONFLICT' } });
    const m = await h.api('companion.memory.save', { ...base, text: '不喝咖啡', confirmed: false });
    expect(memoryConflict(m, (await h.api('companion.data', { id: role.id })).memories, Date.now())).toBeTruthy();
    await h.api('companion.memory.save', { ...base, subject: 'reference', text: '不喝咖啡' });
  });
  it('corrects by optimistic version, keeps old display text and sends only the updated fact', async () => {
    const h = harness(), { role, chat } = await h.prepare();
    const m = await h.api('companion.memory.save', { roleId: role.id, text: '喜欢咖啡', subject: 'user', topic: '饮食', confirmed: true });
    await h.send(chat.id, 'OLD_FACT_CHAT');
    const updated = await h.api('companion.memory.save', { roleId: role.id, id: m.id, version: m.version, text: '不喝咖啡', confirmed: false });
    expect((await h.api('companion.conversation.get', { id: chat.id })).conversation.messages).toHaveLength(2);
    expect(await h.raw('A', 'companion.memory.save', { roleId: role.id, id: m.id, version: m.version, text: '过时写入', confirmed: true })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    await h.api('companion.memory.save', { roleId: role.id, id: m.id, version: updated.version, text: updated.text, confirmed: true }); await h.send(chat.id);
    expect(h.contexts.at(-1)!.messages).toHaveLength(0); expect(h.contexts.at(-1)!.memories.map(m => m.text)).toEqual(['不喝咖啡']);
  });
  it('expires today at Beijing midnight, retains display data, and never revives old context', async () => {
    const h = harness(), { role, chat } = await h.prepare();
    const m = await h.api('companion.memory.save', { roleId: role.id, text: '今天正在散步', subject: 'user', topic: '活动', validFor: 'today', confirmed: true });
    expect(m.expiresAt).toBe(Date.parse('2026-10-19T16:00:00Z')); await h.send(chat.id);
    h.advance(6 * 60000); await h.send(chat.id, '下一天');
    expect(h.contexts.at(-1)!.memories).toEqual([]); expect(h.contexts.at(-1)!.messages).toEqual([]);
    expect((await h.api('companion.data', { id: role.id })).memories[0]).toMatchObject({ expiryHandled: true });
    expect((await h.api('companion.conversation.get', { id: chat.id })).conversation.messages).toHaveLength(4);
    expect(await h.raw('A', 'companion.memory.save', { roleId: role.id, id: m.id, version: m.version, text: m.text, confirmed: true })).toMatchObject({ ok: false, error: { code: 'MEMORY_EXPIRED' } });
    await h.send(chat.id, '再聊'); expect(h.contexts.at(-1)!.messages[0]!.text).toBe('下一天');
  });
  it('keeps structured facts isolated across users and roles, rejecting foreign IDs and fields', async () => {
    const h = harness(), a = await h.prepare('A'), b = await h.prepare('B');
    const m = await h.api('companion.memory.save', { roleId: a.role.id, text: 'PRIVATE_A', subject: 'user', confirmed: true });
    expect(await h.raw('B', 'companion.memory.save', { roleId: b.role.id, id: m.id, version: m.version, text: 'x', confirmed: true })).toMatchObject({ ok: false });
    expect(await h.raw('A', 'companion.memory.save', { roleId: a.role.id, text: 'x', confirmed: true, expiresAt: 9999999999999 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await h.send(b.chat.id, 'hello', 'B'); expect(JSON.stringify(h.contexts)).not.toContain('PRIVATE_A');
  });
  it('does not mix same-user roles or accept another role document as a fact source', async () => {
    const h = harness(), a = await h.prepare();
    const b = await h.api('companion.role.save', { ...h.roleInput, name: '角色乙' }), bc = await h.api('companion.conversation.create', { roleId: b.id });
    const d = await h.api('companion.import', { roleId: a.role.id, title: '甲资料', text: '我：雨天\n对方：甲秘密', userSpeaker: '我', referenceSpeaker: '对方', authorized: true });
    await h.api('companion.memory.save', { roleId: a.role.id, text: 'ROLE_A_PRIVATE', subject: 'user', topic: '偏好', confirmed: true });
    expect(await h.raw('A', 'companion.memory.save', { roleId: b.id, documentId: d.id, text: '越界', confirmed: true })).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    await h.send(bc.id, '雨天'); expect(JSON.stringify(h.contexts)).not.toContain('ROLE_A_PRIVATE'); expect(h.contexts[0]!.examples).toEqual([]);
  });
  it('rejects a late reply after correction without deleting already visible history', async () => {
    let release!: (r: { output: unknown }) => void, begin!: () => void; let count = 0;
    const started = new Promise<void>(r => begin = r);
    const h = harness(async () => { if (++count === 1) return { output: { text: '第一轮保留' } };
      begin(); return new Promise(r => release = r); });
    const { role, chat } = await h.prepare(); const m = await h.api('companion.memory.save', { roleId: role.id, text: '旧事实', subject: 'user', topic: '主题', confirmed: true });
    await h.send(chat.id); const pending = h.raw('A', 'companion.send', { conversationId: chat.id, text: '进行中' }); await started;
    await h.api('companion.memory.save', { roleId: role.id, id: m.id, version: m.version, text: '新事实', confirmed: true });
    release({ output: { text: '不应写入的过时答案' } }); expect(await pending).toMatchObject({ ok: false, error: { code: 'DATA_CHANGED' } });
    const result = (await h.api('companion.conversation.get', { id: chat.id })).conversation.messages;
    expect(result).toHaveLength(2); expect(JSON.stringify(result)).not.toContain('过时答案');
  });
  it('does not double-reserve or change personal/global limits when persona or facts are edited', async () => {
    const h = harness(), { role, chat } = await h.prepare(); await h.send(chat.id);
    await h.api('companion.role.save', { ...h.roleInput, id: role.id, version: role.version, selfAddress: '我' });
    await h.api('companion.memory.save', { roleId: role.id, text: '喜欢短句', subject: 'user', confirmed: false });
    expect(await h.api('session.bootstrap')).toMatchObject({ chatRemaining: 29, chatDailyLimit: 30, globalDailyCallLimit: 300000 });
    expect(h.contexts).toHaveLength(1);
  });
  it('retains a twelve-round window by default and truncates each historical entry to 600 characters', async () => {
    const h = harness(), { chat } = await h.prepare();
    for (let i = 0; i < 8; i++) { h.advance(60001); await h.send(chat.id, `ROUND_${i}_` + '长'.repeat(800)); }
    const ctx = h.contexts.at(-1)!; expect(ctx.messages).toHaveLength(14); expect(ctx.messages[0]!.text).toMatch(/^ROUND_0_/);
    expect(ctx.messages.every(m => m.text.length <= 600)).toBe(true); expect(CONTEXT_LIMITS).not.toHaveProperty('storedMessages');
  });
  it('reports duplicate reference content without deleting or changing speaker roles', () => {
    const turns = [{ speaker: 'user' as const, text: '你好' }, { speaker: 'reference' as const, text: '你好' }, { speaker: 'reference' as const, text: ' 你好 ' }];
    expect(referenceQuality(turns)).toEqual({ userCount: 1, referenceCount: 2, duplicateCount: 1 }); expect(turns).toHaveLength(3);
  });
});
