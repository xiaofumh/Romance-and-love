import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cloudRepository, cloudBudget } from '../src/cloud/repository';
import type { Db } from '../src/cloud/repository';
import { AppError } from '../src/server/errors';
import { createService } from '../src/server/service';
import type { ServiceOptions } from '../src/server/service';
import { POLICY_VERSION } from '../src/shared/contracts';
import { safeDiagnostic } from '../src/cloud/diagnostics';

const stamp = Date.parse('2026-10-30T01:00:00Z');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const conflict = () => Object.assign(new Error('DATABASE_TRANSACTION_CONFLICT FAKE-PRIVATE-DOCUMENT'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
// Unlike the older serial fake, this fake allows overlapping snapshots. Writes
// stage until commit; failed commits never leak partial state. It deliberately
// simulates exhausted SDK retries, not the SDK's own retry implementation.
function mvcc() {
  const records = new Map<string, { version: number; data: any }>();
  let writes = 0;
  const faults: { set?: (data: any, key: string) => void } = {};
  const db: Db = { async runTransaction(fn) {
    const seen = new Map<string, number>(), pending = new Map<string, unknown>();
    const result = await fn({ collection(name) { return { doc(id) {
      const key = `${name}/${id}`;
      return { async get() {
        const row = records.get(key); seen.set(key, row?.version ?? 0);
        return { data: row ? clone(row.data) : undefined };
      }, async set(input) { faults.set?.(input.data, key); pending.set(key, clone(input.data)); } };
    } }; } });
    if (pending.size) {
      for (const [key, version] of seen) if ((records.get(key)?.version ?? 0) !== version) throw conflict();
      for (const [key, data] of pending) { records.set(key, { version: (records.get(key)?.version ?? 0) + 1, data }); writes++; }
    }
    return result;
  } };
  return { db, records, faults, writes: () => writes };
}

describe('cloud observation versus mutation with overlapping transactions', () => {
  it('creates once and permits simultaneous observations without writes or conflicts', async () => {
    const f = mvcc(), repo = cloudRepository(f.db);
    await repo.transact('A', stamp, () => null);
    expect(f.writes()).toBe(1);
    expect(await Promise.all(Array.from({ length: 8 }, () => repo.transact('A', stamp + 1000, s => s.id))))
      .toEqual(Array(8).fill('A'));
    expect(f.writes()).toBe(1);
    expect(f.records.get('assistant_users/A')!.data.updatedAt).toBe(stamp);
  });
  it('still persists real edits, maintenance and a new Beijing quota day', async () => {
    const f = mvcc(), repo = cloudRepository(f.db);
    await repo.transact('A', stamp, s => { s.settings.historyEnabled = true; s.rate = [stamp]; });
    await repo.transact('A', stamp + 61000, s => expect(s.rate).toEqual([]));
    await repo.transact('A', stamp + 86400000, s => expect(s.quota.dateKey).toBe('2026-10-31'));
    expect(f.writes()).toBe(3);
    expect(f.records.get('assistant_users/A')!.data.state.settings.historyEnabled).toBe(true);
  });
  it('cleanup explicitly advances an unchanged record so the oldest scan page progresses', async () => {
    const f = mvcc(); await cloudRepository(f.db).transact('A', stamp, () => null);
    await cloudRepository(f.db, { touchUnchanged: true }).transact('A', stamp + 900001, () => null);
    expect(f.writes()).toBe(2);
    expect(f.records.get('assistant_users/A')!.data.updatedAt).toBe(stamp + 900001);
  });
  it('real concurrent edits retain conflict detection instead of silently losing one', async () => {
    const f = mvcc(), repo = cloudRepository(f.db); await repo.transact('A', stamp, () => null);
    const results = await Promise.allSettled([1, 2].map(() => repo.transact('A', stamp, s => ++s.revision)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'DATABASE_BUSY', kind: 'database-conflict' } });
    expect(f.records.get('assistant_users/A')!.data.state.revision).toBe(1);
  });
  it('keeps business and programmer exceptions distinct from SDK failures', async () => {
    const repo = cloudRepository(mvcc().db), business = new AppError('CONSENT_REQUIRED', 'test'), bug = new TypeError('test logic');
    await expect(repo.transact('A', stamp, () => { throw business; })).rejects.toBe(business);
    await expect(repo.transact('A', stamp, () => { throw bug; })).rejects.toBe(bug);
  });
  it('sanitizes SDK read/budget errors without retrying reservations', async () => {
    let attempts = 0;
    const db: Db = { async runTransaction() { attempts++; throw new Error('FAKE-PRIVATE-DOCUMENT provider-key-sentinel'); } };
    for (const call of [() => cloudRepository(db).transact('A', stamp, () => null), () => cloudBudget(db).reserve('2026-10-30', 3)]) {
      const error = await call().catch(e => e);
      expect(error.code).toBe('DATABASE_UNAVAILABLE'); expect(JSON.stringify(error)).not.toMatch(/FAKE-PRIVATE|sentinel/);
    }
    expect(attempts).toBe(2);
  });
});

async function harness(f: ReturnType<typeof mvcc>, override: Partial<ServiceOptions> = {}) {
  let calls = 0; const events: unknown[] = [];
  const service = createService({ repository: cloudRepository(f.db), budget: cloudBudget(f.db), enabled: true, mode: 'cloud',
    id: randomUUID, hash: text => createHash('sha256').update(text).digest('hex'), now: () => stamp, timeoutMs: 2000,
    provider: { name: 'synthetic-only', generate: async () => ({ output: {} }), chat: async () => {
      calls++; return { output: { text: '这是合成测试回复。' }, usage: { input: 123, output: 9 } };
    } }, moderator: { check: async () => true }, onInternalError: e => events.push(e), ...override });
  const api = (action: string, payload: unknown = {}, clientRequestId?: string) => service.handle('A', { action, payload, ...(clientRequestId ? { clientRequestId } : {}) });
  const data = async (action: string, payload: unknown = {}) => { const r = await api(action, payload); if (!r.ok) throw new Error(r.error.code); return r.data as any; };
  await data('consent.update', { version: POLICY_VERSION, accepted: true });
  await data('settings.update', { historyEnabled: true });
  const role = await data('companion.role.save', { name: '虚构测试', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
  const conversation = await data('companion.conversation.create', { roleId: role.id });
  return { api, data, events, calls: () => calls, send: () => api('companion.send', { conversationId: conversation.id, text: '合成测试你好' }, 'synthetic-request-001'), conversation };
}
describe('paid chat failure provenance and idempotency', () => {
  it('logs only allowlisted phase/categories and discards arbitrary error fields', () => {
    const raw = { kind: 'chat-failure-persist', phase: 'commit', primaryKind: 'database-conflict', persistenceKind: 'FAKE-PRIVATE',
      message: 'FAKE-PRIVATE', uid: 'FAKE-PRIVATE', key: 'FAKE-PRIVATE', prompt: 'FAKE-PRIVATE' };
    expect(safeDiagnostic(raw)).toEqual({ kind: 'chat-failure-persist', phase: 'commit', primaryKind: 'database-conflict', persistenceKind: 'unknown' });
    expect(safeDiagnostic(new Error('FAKE-PRIVATE'))).toEqual({ kind: 'unhandled-service-error' });
    expect(JSON.stringify(safeDiagnostic(raw))).not.toContain('FAKE-PRIVATE');
  });
  it('records a failed commit as database conflict, keeps token usage and never resends the model', async () => {
    const f = mvcc(), h = await harness(f); let failed = false;
    f.faults.set = data => { if (!failed && data.state?.companion?.jobs.some((j: any) => j.status === 'SUCCEEDED')) { failed = true; throw conflict(); } };
    expect(await h.send()).toMatchObject({ ok: false, error: { code: 'DATABASE_BUSY' } });
    const state = f.records.get('assistant_users/A')!.data.state;
    expect(state.companion.jobs[0]).toMatchObject({ status: 'FAILED', errorCode: 'DATABASE_BUSY', metrics: {
      failureStage: 'commit', failureKind: 'database-conflict', inputTokens: 123, outputTokens: 9 } });
    expect(state.companion.conversations[0].messages).toEqual([]);
    expect(await h.send()).toMatchObject({ ok: true, data: { job: { status: 'FAILED', errorCode: 'DATABASE_BUSY' } } });
    expect(h.calls()).toBe(1); expect(f.records.get('assistant_budgets/2026-10-30')!.data.calls).toBe(1);
    expect(JSON.stringify(state)).not.toContain('FAKE-PRIVATE');
  });
  it('a failure-recording outage does not mask the original timeout or trigger another model call', async () => {
    const f = mvcc(); let providerCalls = 0;
    const h = await harness(f, { provider: { name: 'synthetic-timeout', generate: async () => ({ output: {} }), chat: async () => {
      providerCalls++; throw new AppError('PROVIDER_TIMEOUT', '模型请求超时', true);
    } } });
    f.faults.set = data => { if (data.state?.companion?.jobs.some((j: any) => j.status === 'TIMED_OUT')) throw conflict(); };
    expect(await h.send()).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } });
    expect(h.events).toEqual([{ kind: 'chat-failure-persist', phase: 'provider', primaryKind: 'controlled', persistenceKind: 'database-conflict' }]);
    expect(await h.send()).toMatchObject({ ok: true, data: { job: { status: 'PROCESSING' } } });
    expect(providerCalls).toBe(1); expect(f.records.get('assistant_budgets/2026-10-30')!.data.calls).toBe(1);
    expect(JSON.stringify(h.events)).not.toContain('FAKE-PRIVATE');
  });
});
