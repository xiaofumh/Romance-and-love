import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createService } from '../src/server/service';
import type { Provider, ProviderContext } from '../src/server/service';
import { MemoryBudget, MemoryRepository } from '../src/server/state';
import type { ApiResult, Bootstrap, GenerateInput, GenerationView, History, Memory, Profile } from '../src/shared/contracts';
import { labelledText, POLICY_VERSION } from '../src/shared/contracts';

const input: GenerateInput = { message: '你是不是不想理我？', background: '今天在开会，今晚是否有空不确定。',
  goal: '解释回复慢，不承诺时间', scene: 'relationship', tone: 'warm', length: 'short', profileId: null, saveHistory: false };
const output = { replies: [{ text: '我看到了你的消息，想先听你说清楚。' }, { text: '我们先把彼此的想法说清楚，好吗？' }, { text: '我理解你的关注，可以再具体说一下吗？' }], warnings: [] };
function unwrap<T>(r: ApiResult): T { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.data as T; }
function harness(provider?: Provider, opts: { timeoutMs?: number; callLimit?: number; enabled?: boolean } = {}) {
  let time = Date.parse('2026-10-18T00:00:00Z'); let calls = 0;
  const repository = new MemoryRepository(); const budget = new MemoryBudget();
  const service = createService({ repository, budget, mode: 'cloud', enabled: opts.enabled ?? true,
    id: randomUUID, hash: s => createHash('sha256').update(s).digest('hex'), now: () => time,
    timeoutMs: opts.timeoutMs ?? 1000, callLimit: opts.callLimit ?? 100,
    provider: provider ?? { name: 'test-only', async generate() { calls++; return { output }; } },
    moderator: { async check(text) { return !text.includes('TEST_BLOCK'); } } });
  return { ...service, repository, budget, now: () => time, advance: (ms: number) => { time += ms; }, calls: () => calls,
    async accept(user = 'A') { unwrap(await service.handle(user, { action: 'consent.update', payload: { version: POLICY_VERSION, accepted: true } })); },
    async run(user = 'A', id = randomUUID(), payload = input) { return service.handle(user, { action: 'generation.create', clientRequestId: id, payload }); },
  };
}

describe('generation and authorization', () => {
  it('requires current consent and rejects client-controlled identity fields', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'CONSENT_REQUIRED' } });
    expect(await h.handle('A', { action: 'session.bootstrap', userId: 'B' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(h.calls()).toBe(0);
  });
  it('does not invoke a real provider while service is disabled', async () => {
    const h = harness(undefined, { enabled: false }); await h.accept();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } }); expect(h.calls()).toBe(0);
  });
  it('returns three replies and charges exactly once for an idempotent replay', async () => {
    const h = harness(); await h.accept(); const id = randomUUID();
    const first = unwrap<GenerationView>(await h.run('A', id)); const second = unwrap<GenerationView>(await h.run('A', id));
    expect(first.replies).toHaveLength(3); expect(second).toEqual(first); expect(first.remainingQuota).toBe(9); expect(h.calls()).toBe(1);
    expect(await h.run('A', id, { ...input, message: '不同内容' })).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
  });
  it('does not store history unless separately opted in', async () => {
    const h = harness(); await h.accept(); await h.run();
    expect(unwrap<{ items: History[] }>(await h.handle('A', { action: 'history.list' })).items).toEqual([]);
    expect(await h.run('A', randomUUID(), { ...input, saveHistory: true })).toMatchObject({ ok: false, error: { code: 'CONSENT_REQUIRED' } });
  });
  it('isolates history, generations, profiles, memories and deletion job ids', async () => {
    const h = harness(); await h.accept('A'); await h.accept('B');
    unwrap(await h.handle('A', { action: 'settings.update', payload: { historyEnabled: true, memoryEnabled: true } }));
    const p = unwrap<Profile>(await h.handle('A', { action: 'profile.save', payload: { alias: '工作', scene: 'work', preferences: '', blockedTopics: '' } }));
    const m = unwrap<Memory>(await h.handle('A', { action: 'memory.save', payload: { profileId: p.id, text: '我不喝咖啡', confirmed: true } }));
    const g = unwrap<GenerationView>(await h.run('A', randomUUID(), { ...input, saveHistory: true, profileId: p.id }));
    const history = unwrap<{ items: History[] }>(await h.handle('A', { action: 'history.list' })).items[0]!;
    for (const event of [
      { action: 'generation.get', payload: { generationId: g.generationId } },
      { action: 'profile.delete', payload: { id: p.id } },
      { action: 'memory.list', payload: { profileId: p.id } },
      { action: 'memory.delete', payload: { id: m.id } },
      { action: 'history.delete', payload: { id: history.id } },
      { action: 'feedback.create', payload: { generationId: g.generationId, reason: 'other' } },
    ]) expect(await h.handle('B', event)).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(unwrap<{ items: History[] }>(await h.handle('B', { action: 'history.list' })).items).toEqual([]);
    const job = unwrap<{ id: string }>(await h.handle('A', { action: 'account.delete', payload: { confirmed: true } }));
    expect(await h.handle('B', { action: 'deletion.get', payload: { id: job.id } })).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
  });
  it('bounds attempts globally even when different users call', async () => {
    const h = harness(undefined, { callLimit: 1 }); await h.accept('A'); await h.accept('B'); await h.run('A');
    expect(await h.run('B')).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } }); expect(h.calls()).toBe(1);
    expect(unwrap<Bootstrap>(await h.handle('B', { action: 'session.bootstrap' })).remainingQuota).toBe(10);
  });
  it('rejects blocked input before provider invocation', async () => {
    const h = harness(); await h.accept();
    expect(await h.run('A', randomUUID(), { ...input, message: 'TEST_BLOCK' })).toMatchObject({ ok: false, error: { code: 'INPUT_BLOCKED' } }); expect(h.calls()).toBe(0);
  });
  it('rejects malformed and duplicate model replies without charging quota', async () => {
    const h = harness({ name: 'bad', async generate() { return { output: { replies: [{ text: '一样' }, { text: '一样！' }, { text: '一样。' }], warnings: [] } }; } });
    await h.accept(); expect(await h.run()).toMatchObject({ ok: false, error: { code: 'INVALID_MODEL_OUTPUT' } });
    expect(unwrap<Bootstrap>(await h.handle('A', { action: 'session.bootstrap' })).remainingQuota).toBe(10);
  });
  it('rejects object-valued GLM warnings without saving history or charging experience quota', async () => {
    const h = harness({ name: 'glm-schema-regression', async generate() {
      return { output: { ...output, warnings: [{ text: '不应被悄悄转换成字符串' }] } };
    } });
    await h.accept();
    unwrap(await h.handle('A', { action: 'settings.update', payload: { historyEnabled: true } }));
    const result = await h.run('A', randomUUID(), { ...input, saveHistory: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MODEL_OUTPUT' } });
    expect(unwrap<Bootstrap>(await h.handle('A', { action: 'session.bootstrap' })).remainingQuota).toBe(10);
    expect(unwrap<{ items: History[] }>(await h.handle('A', { action: 'history.list' })).items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('不应被悄悄转换');
  });
  it('rejects unsafe output before returning it to the client', async () => {
    const h = harness({ name: 'blocked', async generate() { return { output: { ...output, warnings: ['TEST_BLOCK'] } }; } });
    await h.accept(); const r = await h.run(); expect(r).toMatchObject({ ok: false, error: { code: 'OUTPUT_BLOCKED' } }); expect(JSON.stringify(r)).not.toContain('TEST_BLOCK');
  });
  it('masks phone numbers and only loads explicitly selected, confirmed memories', async () => {
    let context: ProviderContext | undefined;
    const h = harness({ name: 'capture', async generate(c) { context = c; return { output }; } }); await h.accept();
    unwrap(await h.handle('A', { action: 'settings.update', payload: { memoryEnabled: true } }));
    const p = unwrap<Profile>(await h.handle('A', { action: 'profile.save', payload: { alias: '同事', scene: 'work', preferences: '', blockedTopics: '' } }));
    unwrap(await h.handle('A', { action: 'memory.save', payload: { profileId: p.id, text: '我不喝咖啡', confirmed: true } }));
    await h.run('A', randomUUID(), { ...input, message: '号码是13800138000', profileId: p.id });
    expect(context?.input.message).not.toContain('13800138000'); expect(context?.memories.map(m => m.text)).toEqual(['我不喝咖啡']);
    h.advance(61000); await h.run(); expect(context?.memories).toEqual([]);
  });
});

describe('concurrency, expiration and deletion', () => {
  it('coalesces concurrent retries and prevents independent parallel generations', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
    const h = harness({ name: 'slow', async generate() { calls++; await gate; return { output }; } }); await h.accept();
    const id = randomUUID(); const first = h.run('A', id);
    await new Promise(r => setTimeout(r, 5));
    expect(unwrap<GenerationView>(await h.run('A', id)).status).toBe('PROCESSING');
    expect(await h.run('A')).toMatchObject({ ok: false, error: { code: 'GENERATION_PENDING' } });
    release(); unwrap(await first); expect(calls).toBe(1);
  });
  it('does not reintroduce results when account is deleted during generation', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const h = harness({ name: 'slow', async generate() { await gate; return { output }; } }); await h.accept();
    const promise = h.run(); await new Promise(r => setTimeout(r, 5));
    unwrap(await h.handle('A', { action: 'account.delete', payload: { confirmed: true } })); release();
    const result = unwrap<GenerationView>(await promise);
    expect(result.status).toBe('CANCELLED'); expect(result.replies).toBeUndefined();
    const state = await h.repository.transact('A', h.now(), s => s);
    expect(state.generations.every(g => !g.input && !g.replies)).toBe(true); expect(state.histories).toHaveLength(0);
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'ACCOUNT_DELETED' } });
  });
  it('history deletion also revokes corresponding task results', async () => {
    const h = harness(); await h.accept(); unwrap(await h.handle('A', { action: 'settings.update', payload: { historyEnabled: true } }));
    const g = unwrap<GenerationView>(await h.run('A', randomUUID(), { ...input, saveHistory: true }));
    unwrap(await h.handle('A', { action: 'history.delete', payload: { all: true } }));
    expect(await h.handle('A', { action: 'generation.get', payload: { generationId: g.generationId } })).toMatchObject({ ok: false, error: { code: 'DATA_EXPIRED' } });
  });
  it('expires plaintext after one hour while preventing replay within the tombstone period', async () => {
    const h = harness(); await h.accept(); const id = randomUUID(); const g = unwrap<GenerationView>(await h.run('A', id)); h.advance(3600001);
    expect(await h.handle('A', { action: 'generation.get', payload: { generationId: g.generationId } })).toMatchObject({ ok: false, error: { code: 'DATA_EXPIRED' } });
    expect(await h.run('A', id)).toMatchObject({ ok: false, error: { code: 'DATA_EXPIRED' } }); expect(h.calls()).toBe(1);
  });
  it('ignores late provider output after timeout and releases quota once', async () => {
    const h = harness({ name: 'timeout', async generate() { await new Promise(r => setTimeout(r, 45)); return { output }; } }, { timeoutMs: 10 });
    await h.accept(); expect(await h.run()).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } });
    await new Promise(r => setTimeout(r, 60));
    const state = await h.repository.transact('A', h.now(), s => s);
    expect(state.quota).toMatchObject({ used: 0, reserved: 0 }); expect(state.generations[0]?.replies).toBeUndefined();
  });
  it('limits frequency and resets daily quota on Beijing midnight', async () => {
    const h = harness(); await h.accept(); for (let n = 0; n < 3; n++) unwrap(await h.run());
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    for (let n = 0; n < 7; n++) { h.advance(61000); unwrap(await h.run()); }
    h.advance(61000); expect(await h.run()).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    h.advance(16 * 3600000); expect(unwrap<Bootstrap>(await h.handle('A', { action: 'session.bootstrap' })).remainingQuota).toBe(10);
  });
  it('adds exactly one copy label', () => { expect(labelledText('你好')).toBe('【AI生成】\n你好'); expect(labelledText(labelledText('你好'))).toBe('【AI生成】\n你好'); });
});
