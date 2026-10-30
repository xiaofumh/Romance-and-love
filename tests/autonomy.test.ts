import { randomUUID, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createService } from '../src/server/service';
import { MemoryRepository, MemoryBudget, maintain } from '../src/server/state';
import { POLICY_VERSION } from '../src/shared/contracts';
import { nextAutonomousConversation, nextAutonomousWake, NO_INITIATIVE } from '../src/server/autonomy';
import { autonomyTick } from '../src/cloud/autonomy-tick';
import type { ChatContext } from '../src/server/companion-prompt';
async function setup(auto = true, wait = false, override?: (c: ChatContext) => Promise<{ output: unknown }>) {
  let now = Date.parse('2026-10-30T04:00:00Z'), calls = 0;
  const repo = new MemoryRepository(), budget = new MemoryBudget();
  const texts = ['花园的颜色很舒服。', '窗边的光落在花叶上，想起来很柔和。', '我还想给这个小角落起个名字，先在心里留着。', '我给这段聊天留一点空白，你忙完再来就好。'];
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const service = createService({ repository: repo, budget, hash, id: randomUUID, now: () => now, enabled: true, mode: 'cloud',
    moderator: { check: async () => true }, timeoutMs: 1000, chatDailyLimit: 1000,
    provider: { name: 'synthetic-only', generate: async () => ({ output: {} }), chat: async c => {
      calls++; if (override) return override(c);
      return { output: { text: wait && c.intent === 'initiative' ? '[[WAIT]]' : texts[(calls - 1) % texts.length]! } };
    } } });
  const raw = (action: string, payload: unknown = {}, id: string = randomUUID(), uid = 'A') => service.handle(uid, { action, payload, clientRequestId: id });
  const api = async (action: string, payload: unknown = {}) => { const r = await raw(action, payload); if (!r.ok) throw new Error(r.error.code); return r.data as any; };
  await api('consent.update', { version: POLICY_VERSION, accepted: true }); await api('settings.update', { historyEnabled: true });
  const role = await api('companion.role.save', { name: '合成角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '', proactiveEnabled: true, autonomousEnabled: auto });
  const c = await api('companion.conversation.create', { roleId: role.id });
  const send = (text = '今天想聊聊我正在布置的虚构小花园') => api('companion.send', { conversationId: c.id, text });
  const initiate = (id?: string) => raw('companion.initiative', { conversationId: c.id }, id);
  const state = () => repo.transact('A', now, s => s);
  const tickDb = { command: { lte: (n: number) => n }, collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ data: [{ _id: 'A' }] }) }) }) }) };
  return { api, raw, role, c, repo, send, initiate, state, calls: () => calls, now: () => now, advance: (n: number) => { now += n; },
    tick: () => autonomyTick(tickDb, repo, (uid, e) => service.handle(uid, e), hash, now) };
}
it('supports three bounded attempts without new user input and retains ordinary legacy once-only behavior', async () => {
  const h = await setup(); await h.send(); h.advance(45001);
  for (let i = 0; i < 3; i++) { expect(await h.initiate()).toMatchObject({ ok: true, data: { job: { status: 'SUCCEEDED' } } }); h.advance(300001); }
  expect(await h.initiate()).toMatchObject({ ok: false, error: { code: 'INITIATIVE_NOT_READY' } }); expect(h.calls()).toBe(4);
  const old = await setup(false); await old.send(); old.advance(45001); expect((await old.initiate()).ok).toBe(true);
  old.advance(300001); expect((await old.initiate()).ok).toBe(false);
});
it('counts WAIT as an attempt without creating fake assistant messages or immediately re-running', async () => {
  const h = await setup(true, true); await h.send(); h.advance(45001);
  expect(await h.tick()).toMatchObject({ processed: 1, status: 'SKIPPED' });
  expect(await h.tick()).toMatchObject({ processed: 0 }); expect(h.calls()).toBe(2);
  expect((await h.state()).companion!.conversations[0]!.messages).toHaveLength(2);
});
it('does not let a forged user ID or another account set composing state', async () => {
  const h = await setup();
  expect(await h.raw('companion.presence', { conversationId: h.c.id, composing: true }, randomUUID(), 'B')).toMatchObject({ ok: false });
  expect(await h.raw('companion.presence', { conversationId: h.c.id, composing: true, until: 9999999999999 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
it('defers on composing, resumes after its lease, and honours pause without a new model request', async () => {
  const h = await setup(); await h.send(); h.advance(45001);
  await h.api('companion.presence', { conversationId: h.c.id, composing: true });
  expect(await h.tick()).toMatchObject({ processed: 0 }); expect(h.calls()).toBe(1);
  h.advance(90001); expect(await h.tick()).toMatchObject({ processed: 1 });
  await h.send('先不聊了'); h.advance(360000);
  expect(nextAutonomousConversation(await h.state(), h.now())).toBeUndefined();
});
it('leaves old roles opted out of background work and never includes an experimental fork', async () => {
  const old = await setup(false); await old.send(); old.advance(45001);
  expect(nextAutonomousWake(await old.state(), old.now())).toBe(NO_INITIATIVE);
  const h = await setup(); await h.send(); h.advance(45001);
  const fork = await h.api('companion.conversation.fork', { id: h.c.id, contextRounds: 6 });
  const next = nextAutonomousConversation(await h.state(), h.now()); expect(next?.id).toBe(h.c.id); expect(next?.id).not.toBe(fork.id);
});
it('blocks background work on revocation/history-off/deletion and keeps global budgets unchanged', async () => {
  for (const action of ['history', 'consent', 'delete']) {
    const h = await setup(); await h.send(); h.advance(45001);
    if (action === 'history') await h.api('settings.update', { historyEnabled: false });
    if (action === 'consent') await h.api('consent.update', { version: POLICY_VERSION, accepted: false });
    if (action === 'delete') await h.api('companion.delete', { kind: 'role', id: h.role.id });
    expect(nextAutonomousWake(await h.state(), h.now())).toBe(NO_INITIATIVE); expect((await h.tick()).processed).toBe(0); expect(h.calls()).toBe(1);
  }
});
it('schedules a morning wake rather than generating at night or exceeding six attempts per role/day', async () => {
  const h = await setup(); await h.send(); h.advance(11 * 3600000 + 45001);
  expect(nextAutonomousConversation(await h.state(), h.now())!.dueAt).toBe(Date.parse('2026-10-31T00:00:00Z'));
  expect((await h.initiate()).ok).toBe(false); expect(h.calls()).toBe(1);
  const normal = await setup(); await normal.send(); normal.advance(45001);
  await normal.repo.transact('A', normal.now(), s => { for (let i = 0; i < 6; i++) s.companion!.jobs.push({ ...s.companion!.jobs[0]!, id: 'old' + i, kind: 'initiative' }); });
  expect(nextAutonomousConversation(await normal.state(), normal.now())).toBeUndefined(); expect((await normal.initiate()).ok).toBe(false);
});
it('wakes expired PROCESSING leases for maintenance without replaying a paid model attempt', async () => {
  const h = await setup(); await h.send(); const s = await h.state();
  s.companion!.jobs[0]!.status = 'PROCESSING'; s.companion!.jobs[0]!.leaseUntil = h.now() + 1000;
  expect(nextAutonomousWake(s, h.now())).toBe(h.now() + 2000);
  maintain(s, h.now() + 2001); expect(s.companion!.jobs[0]!.status).toBe('TIMED_OUT');
});
it('coalesces overlapping timer invocations into one billable attempt and one saved initiative', async () => {
  const h = await setup(); await h.send(); h.advance(45001);
  await Promise.all([h.tick(), h.tick()]);
  expect(h.calls()).toBe(2);
  const s = await h.state(); expect(s.companion!.jobs.filter(j => j.kind === 'initiative')).toHaveLength(1);
  expect(s.companion!.conversations[0]!.messages.filter(m => m.kind === 'initiative')).toHaveLength(1);
});
it('prioritizes a real user message and rejects a late, superseded autonomous reply', async () => {
  let release!: (r: { output: unknown }) => void, begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const h = await setup(true, false, async c => {
    if (c.intent !== 'initiative') return { output: { text: '回应用户本次输入。' } };
    begin(); return new Promise(resolve => { release = resolve; });
  });
  await h.send(); h.advance(45001); const old = h.initiate(); await started;
  await h.send('换个话题，现在我有新的事情想说');
  release({ output: { text: '这条过时的主动消息不该再显示。' } });
  expect(await old).toMatchObject({ ok: false, error: { code: 'DATA_CHANGED' } });
  const s = await h.state(); expect(s.companion!.jobs.find(j => j.kind === 'initiative')!.status).toBe('CANCELLED');
  expect(s.companion!.conversations[0]!.messages).toHaveLength(4);
  expect(JSON.stringify(s.companion!.conversations[0]!.messages)).not.toContain('过时的主动消息');
});
it('backs off a failed background request instead of repeatedly spending provider attempts each tick', async () => {
  const h = await setup(true, false, async c => {
    if (c.intent === 'initiative') throw new Error('synthetic upstream failure');
    return { output: { text: '合成普通回复。' } };
  });
  await h.send(); h.advance(45001); expect(await h.tick()).toMatchObject({ processed: 1, succeeded: false, status: 'DEFERRED' });
  expect(await h.tick()).toMatchObject({ processed: 0 }); expect(h.calls()).toBe(2);
  expect((await h.state()).companion!.conversations[0]!.interaction!.backgroundRetryAfter).toBe(h.now() + 3600000);
});
it('defers no-topic/throwing workers without starving the next scan, but never pauses a newer user turn', async () => {
  for (const failure of ['no-topic', 'throw', 'new-turn']) {
    const h = await setup(); await h.send(); h.advance(45001);
    const db = { command: { lte: (n: number) => n }, collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ data: [{ _id: 'A' }] }) }) }) }) };
    const result = await autonomyTick(db, h.repo, async () => {
      if (failure === 'throw') throw new Error('synthetic worker boundary failure');
      if (failure === 'new-turn') await h.send('新的用户消息先到达');
      return { ok: false, error: { code: 'INITIATIVE_NOT_READY' } };
    }, value => value, h.now());
    expect(result).toMatchObject({ processed: 1, status: 'DEFERRED' });
    const state = await h.state();
    if (failure === 'new-turn') expect(state.companion!.conversations[0]!.interaction!.backgroundRetryAfter).toBe(0);
    else expect(nextAutonomousConversation(state, h.now())!.dueAt).toBe(h.now() + 3600000);
  }
});
