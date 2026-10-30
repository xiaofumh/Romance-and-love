import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createService } from '../src/server/service';
import { freshState, MemoryBudget } from '../src/server/state';
import { cloudRepository, type Db } from '../src/cloud/repository';
import { HISTORY_COLLECTION, TAIL_COLLECTION, HISTORY_GC_COLLECTION, historyKey } from '../src/cloud/history-storage';
import { cleanupHistory } from '../src/cloud/history-cleanup';
import { POLICY_VERSION } from '../src/shared/contracts';
import type { ChatContext } from '../src/server/companion-prompt';
import type { HistoryCursor, HistoryPage } from '../src/shared/history';

const stamp = Date.parse('2026-10-30T04:00:00Z'), clone = (x: any) => x == null ? x : JSON.parse(JSON.stringify(x));
function database() {
  const records = new Map<string, any>(); let maxWrites = 0;
  const fault: { key?: string } = {};
  function query(name: string) {
    let where: any = {}, limit = 100, order = '' as string, direction = 'asc';
    const q = { where(v: any) { where = v; return q; }, limit(n: number) { limit = n; return q; }, orderBy(k: string, dir: string) { order = k; direction = dir; return q; },
      async get() { const rows = [...records].filter(([key]) => key.startsWith(name + '/')).map(([key, value]) => ({ ...clone(value), _id: key.slice(name.length + 1) }))
        .filter(row => Object.entries(where).every(([key, expected]: [string, any]) => expected?.op === 'lt' ? row[key] < expected.n : expected?.op === 'lte' ? row[key] <= expected.n : expected?.op === 'gt' ? row[key] > expected.n : row[key] === expected));
        if (order) rows.sort((a, b) => (a[order] - b[order]) * (direction === 'asc' ? 1 : -1)); return { data: rows.slice(0, limit) }; } };
    return q;
  }
  const db: Db = { command: { lt: (n: number) => ({ op: 'lt', n }), lte: (n: number) => ({ op: 'lte', n }), gt: (n: number) => ({ op: 'gt', n }) }, collection: query,
    async runTransaction(fn) {
      const pending = new Map<string, any>();
      const result = await fn({ collection(name: string) { return { doc(id: string) {
        const key = `${name}/${id}`;
        return { async get() { return { data: clone(records.get(key)) }; }, async set(v: any) { if (fault.key && key.startsWith(fault.key)) throw new Error('synthetic archive write failure'); pending.set(key, clone(v.data)); },
          async remove() { pending.set(key, null); } };
      } }; } });
      maxWrites = Math.max(maxWrites, pending.size);
      for (const [key, value] of pending) if (value == null) records.delete(key); else records.set(key, value);
      return clone(result);
    } };
  return { db, records, fault, maxWrites: () => maxWrites, rows: (name: string) => [...records].filter(([k]) => k.startsWith(name + '/')) };
}
async function setup() {
  let now = stamp; const d = database(), contexts: ChatContext[] = [], repo = cloudRepository(d.db);
  const service = createService({ repository: repo, budget: new MemoryBudget(), enabled: true, mode: 'cloud', now: () => now,
    hash: text => createHash('sha256').update(text).digest('hex'), id: randomUUID, chatDailyLimit: 1000,
    moderator: { check: async () => true }, provider: { name: 'archive-synthetic-only', generate: async () => ({ output: {} }), chat: async c => {
      contexts.push(c); return { output: { text: '合成回复：' + c.message.slice(0, 20) } };
    } } });
  const raw = (action: string, payload: unknown = {}, uid = 'A') => service.handle(uid, { action, payload, clientRequestId: randomUUID() });
  const api = async (action: string, payload: unknown = {}, uid = 'A'): Promise<any> => { const r = await raw(action, payload, uid); if (!r.ok) throw new Error(r.error.code); return r.data; };
  await api('consent.update', { accepted: true, version: POLICY_VERSION }); await api('settings.update', { historyEnabled: true, memoryEnabled: true });
  const role = await api('companion.role.save', { name: '合成角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
  const chat = await api('companion.conversation.create', { roleId: role.id });
  const page = (cursor?: HistoryCursor) => api('companion.history.page', { conversationId: chat.id, ...(cursor ? { cursor } : {}) }) as Promise<HistoryPage>;
  const send = async (text: string) => { now += 61001; return api('companion.send', { conversationId: chat.id, text }); };
  return { ...d, repo, contexts, api, raw, role, chat, send, page, now: () => now, advance: (ms: number) => { now += ms; } };
}
it('retains more than40 messages in separate storage, pages without omissions, and keeps the model window bounded', async () => {
  const h = await setup();
  for (let i = 0; i < 80; i++) await h.send('ROUND_' + i);
  expect(h.rows(HISTORY_COLLECTION)).toHaveLength(160);
  const stored = h.records.get('assistant_users/A').state;
  expect(stored.companion.conversations[0].messages).toEqual([]);
  expect(h.rows(TAIL_COLLECTION)[0]![1].messages).toHaveLength(60);
  const ids: string[] = []; let cursor: HistoryCursor | undefined;
  do { const p = await h.page(cursor); ids.unshift(...p.messages.map(m => m.id)); cursor = p.cursor; } while (cursor);
  expect(ids).toHaveLength(160); expect(new Set(ids).size).toBe(160);
  expect(h.contexts.at(-1)!.messages.filter(m => m.speaker === 'user')).toHaveLength(12);
  expect(h.contexts.at(-1)!.messages.some(m => m.text === 'ROUND_0')).toBe(false);
  expect(h.maxWrites()).toBeLessThan(100);
});
it('reads an old message as a memory source outside the working cache and enforces tenant ownership', async () => {
  const h = await setup(); const first = await h.send('我喜欢喝乌龙茶');
  for (let i = 0; i < 45; i++) await h.send('新的合成话题' + i);
  const firstUser = h.rows(HISTORY_COLLECTION).find(([, r]) => r.message.text === '我喜欢喝乌龙茶')![1].message;
  const source = { kind: 'message', conversationId: h.chat.id, messageId: firstUser.id };
  expect(await h.api('companion.history.message', { conversationId: h.chat.id, messageId: firstUser.id })).toMatchObject({ message: { text: '我喜欢喝乌龙茶' } });
  const m = await h.api('companion.memory.save', { roleId: h.role.id, text: '我喜欢喝乌龙茶', confirmed: false, source });
  expect(await h.api('companion.memory.source', { id: m.id })).toMatchObject({ available: true, text: '我喜欢喝乌龙茶' });
  expect(await h.raw('companion.history.page', { conversationId: h.chat.id }, 'B')).toMatchObject({ ok: false });
  expect(await h.raw('companion.history.message', { conversationId: h.chat.id, messageId: firstUser.id }, 'B')).toMatchObject({ ok: false });
  expect(first.job.status).toBe('SUCCEEDED');
});
it('hides expired records immediately and physically cleans them in bounded scheduled batches', async () => {
  const h = await setup(); for (let i = 0; i < 25; i++) await h.send('合成到期测试' + i);
  h.advance(30 * 86400000 + 1);
  expect((await h.page()).messages).toEqual([]); expect(h.rows(HISTORY_COLLECTION)).toHaveLength(50);
  await cleanupHistory(h.db, h.now()); await cleanupHistory(h.db, h.now());
  expect(h.rows(HISTORY_COLLECTION)).toEqual([]);
});
it('invalidates stale cursors on privacy clearing and deletes archived generations through the cleanup queue', async () => {
  const h = await setup(); for (let i = 0; i < 25; i++) await h.send('隐私测试' + i);
  const page = await h.page(); expect(page.hasMore).toBe(true);
  await h.api('settings.update', { memoryEnabled: false });
  expect(await h.raw('companion.history.page', { conversationId: h.chat.id, cursor: page.cursor })).toMatchObject({ ok: false, error: { code: 'DATA_CHANGED' } });
  expect((await h.page()).messages).toEqual([]); expect(h.rows(HISTORY_GC_COLLECTION)).toHaveLength(1);
  for (let i = 0; i < 3; i++) await cleanupHistory(h.db, h.now());
  expect(h.rows(HISTORY_COLLECTION)).toEqual([]); expect(h.rows(HISTORY_GC_COLLECTION)).toEqual([]);
});
it('migrates legacy messages atomically and never discards the old document on an archive-write failure', async () => {
  const d = database(), state = freshState('A', stamp);
  state.companion = { roles: [], documents: [], memories: [], jobs: [], conversations: [{ id: 'c', roleId: 'r', title: '旧记录', createdAt: stamp, updatedAt: stamp,
    messages: Array.from({ length: 40 }, (_, i) => ({ id: 'old' + i, requestId: 'q' + i, speaker: i % 2 ? 'assistant' as const : 'user' as const, text: '旧版原文' + i, createdAt: stamp })) }] };
  d.records.set('assistant_users/A', { state: clone(state), updatedAt: stamp }); const original = JSON.stringify(d.records.get('assistant_users/A'));
  d.fault.key = HISTORY_COLLECTION;
  await expect(cloudRepository(d.db).transact('A', stamp, () => null)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  expect(JSON.stringify(d.records.get('assistant_users/A'))).toBe(original); expect(d.rows(HISTORY_COLLECTION)).toEqual([]);
  d.fault.key = undefined; await cloudRepository(d.db).transact('A', stamp, () => null);
  expect(d.rows(HISTORY_COLLECTION)).toHaveLength(40); expect(d.records.get('assistant_users/A').state.companion.conversations[0].messages).toEqual([]);
  expect(d.maxWrites()).toBeLessThan(100);
});
it('rolls back archive and cache writes if the root commit fails', async () => {
  const h = await setup(); await h.send('原来的记录');
  const before = JSON.stringify([...h.records]); h.fault.key = 'assistant_users';
  await expect(h.repo.transact('A', h.now(), s => { s.companion!.conversations[0]!.messages.push({ id: 'new', requestId: 'new-request', speaker: 'user', text: '不应部分保存', createdAt: h.now() }); })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  expect(JSON.stringify([...h.records])).toBe(before);
});
it('keeps an archive larger than5MB outside the bounded account-state document', async () => {
  const h = await setup(); await h.send('开始');
  const c = h.records.get('assistant_users/A').state.companion.conversations[0];
  const messages = Array.from({ length: 2000 }, (_, i) => ({ id: 'bulk' + i, requestId: 'bulk-q' + i, speaker: i % 2 ? 'assistant' : 'user', text: '合'.repeat(1000), createdAt: h.now(), sequence: i + 2 }));
  for (const message of messages) h.records.set(HISTORY_COLLECTION + '/' + historyKey('A', c.id, 1, message.id), { ownerId: 'A', conversationId: c.id, epoch: 1, sequence: message.sequence, message, expiresAt: h.now() + 30 * 86400000 });
  c.history.nextSequence = 2002;
  h.records.get(TAIL_COLLECTION + '/' + historyKey('A', c.id, 1, 'tail')).messages = messages.slice(-60);
  expect(Buffer.byteLength(JSON.stringify(h.rows(HISTORY_COLLECTION)))).toBeGreaterThan(5 * 1024 * 1024);
  expect((await h.send('新消息仍能正常保存')).job.status).toBe('SUCCEEDED');
  expect(Buffer.byteLength(JSON.stringify(h.records.get('assistant_users/A')))).toBeLessThan(100000);
});
