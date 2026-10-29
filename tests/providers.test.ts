import { describe, expect, it } from 'vitest';
import { createHttpProvider } from '../src/server/providers';
import { BIGMODEL_CHAT_URL, modelConfigFromEnv } from '../src/server/model-config';
import type { ProviderContext } from '../src/server/service';
import { cloudBudget, cloudRepository } from '../src/cloud/repository';
import type { Db } from '../src/cloud/repository';
import { createHash } from 'node:crypto';
const context: ProviderContext = { input: { message: '请解释一下', background: '', goal: '', scene: 'daily', tone: 'natural', length: 'short', profileId: null, saveHistory: false }, memories: [] };
const config = { url: 'https://provider.example/v1/chat/completions', apiKey: 'server-only-test-key', model: 'test-model', name: '测试', timeoutMs: 1000, jsonMode: true };
describe('real model adapter (transport mocked, no paid calls)', () => {
  it('sends the companion protocol through the same server-only model adapter', async () => {
    let body: any;
    const provider = createHttpProvider(config, (async (_url, init) => { body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '你好，我在听。' } }] }));
    }) as typeof fetch);
    const result = await provider.chat!({ role: { id: 'r', version: 1, createdAt: 1, name: '小屿', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' },
      messages: [{ speaker: 'user', text: '上一轮用户消息' }, { speaker: 'assistant', text: '上一轮AI消息' }], memories: [], examples: [], message: '你好' });
    expect(body.messages[0].content).toContain('直接对用户'); expect(JSON.parse(body.messages.at(-1).content).currentMessage).toBe('你好');
    expect(body.messages[0].content).toContain('不例行自我介绍'); expect(body.messages[0].content).toContain('如实说明是AI角色');
    expect(body.messages[3].role).toBe('assistant'); expect(result.output).toEqual({ text: '你好，我在听。' });
    expect(body.messages[3].content).toBe('上一轮AI消息'); expect(body.response_format).toEqual({ type: 'text' });
    expect(result.requestAudit).toEqual({ historyMessages: 2, protocol: 'window-evidence-v2',
      historySha256: createHash('sha256').update(JSON.stringify(body.messages.slice(2, -1))).digest('hex') });
    expect(body.messages[0].content).toContain('纯文本聊天正文'); expect(body.messages[0].content).not.toContain('输出严格JSON对象');
    expect(body.model).toBe(config.model);
  });
  it('keeps key in the server authorization header, separates quoted content and disables streaming', async () => {
    let request: RequestInit | undefined;
    const provider = createHttpProvider(config, (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ replies: [], warnings: [] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    }) as typeof fetch);
    const result = await provider.generate(context);
    const body = JSON.parse(String(request?.body));
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer server-only-test-key' });
    expect(body.stream).toBe(false); expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('thinking');
    expect(JSON.parse(body.messages[1].content).quotedMessage).toBe(context.input.message);
    expect(body.messages[0].content).toContain('warnings必须是字符串数组');
    expect(body.messages[0].content).toContain('不得改写成');
    expect(result.usage).toEqual({ input: 20, output: 10 });
  });
  it('uses the selected official GLM preset with thinking disabled and validates its response', async () => {
    const preset = modelConfigFromEnv({ MODEL_API_KEY: 'fake-server-key' });
    expect(preset).toMatchObject({ url: BIGMODEL_CHAT_URL, model: 'glm-4.7', thinking: 'disabled', jsonMode: true });
    let body: any;
    const provider = createHttpProvider(preset, (async (url, init) => {
      expect(String(url)).toBe(BIGMODEL_CHAT_URL); body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        reasoning_content: 'not user-visible', content: '{"replies":[],"warnings":[]}' } }] }));
    }) as typeof fetch);
    expect((await provider.generate(context)).output).toEqual({ replies: [], warnings: [] });
    expect(body.thinking).toEqual({ type: 'disabled' }); expect(body.max_tokens).toBe(1024);
  });
  it('keeps other providers configurable and rejects invalid server configuration', () => {
    expect(modelConfigFromEnv({ MODEL_API_URL: config.url, MODEL_NAME: 'other' }).thinking).toBeUndefined();
    expect(modelConfigFromEnv({ MODEL_THINKING: 'default' }).thinking).toBeUndefined();
    expect(modelConfigFromEnv({ MODEL_THINKING: 'enabled' }).thinking).toBe('enabled');
    expect(() => modelConfigFromEnv({ MODEL_THINKING: 'invalid' })).toThrow('INVALID_MODEL_THINKING');
    expect(() => modelConfigFromEnv({ MODEL_TIMEOUT_MS: '60000' })).toThrow('INVALID_MODEL_TIMEOUT');
  });
  it('rejects insecure endpoints before any network call', async () => {
    let calls = 0;
    const provider = createHttpProvider({ ...config, url: 'http://provider.example/' }, (async () => { calls++; return new Response(''); }) as typeof fetch);
    await expect(provider.generate(context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' }); expect(calls).toBe(0);
  });
  it('rejects truncated output and sanitizes raw error responses', async () => {
    const truncated = createHttpProvider(config, (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))) as typeof fetch);
    await expect(truncated.generate(context)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    const failed = createHttpProvider(config, (async () => new Response('secret-vendor-message', { status: 401 })) as typeof fetch);
    await expect(failed.generate(context)).rejects.toThrow('401');
    await expect(failed.generate(context)).rejects.not.toThrow('secret-vendor-message');
  });
});

describe('cloud repository SDK contract fake', () => {
  function fake() {
    const records = new Map<string, unknown>(); let queue: Promise<unknown> = Promise.resolve();
    const db: Db = { runTransaction(fn) {
      const run = queue.then(() => fn({ collection(name) { return { doc(id) { const key = `${name}/${id}`;
        return { async get() { if (!records.has(key)) throw new Error('document.get: document not exist'); return { data: records.get(key) }; },
          async set(input) { records.set(key, JSON.parse(JSON.stringify(input.data))); } }; } }; } }));
      queue = run.catch(() => undefined); return run;
    } };
    return { db, records };
  }
  it('creates and atomically updates bounded user state', async () => {
    const f = fake(); const repo = cloudRepository(f.db);
    await repo.transact('A', Date.now(), s => { s.settings.historyEnabled = true; return null; });
    expect(await repo.transact('A', Date.now(), s => s.settings.historyEnabled)).toBe(true);
    expect(await repo.transact('B', Date.now(), s => s.settings.historyEnabled)).toBe(false);
  });
  it('reserves global call slots across independent clients', async () => {
    const f = fake(); const one = cloudBudget(f.db), two = cloudBudget(f.db);
    expect(await Promise.all([one.reserve('2026-10-18', 1), two.reserve('2026-10-18', 1)])).toEqual([true, false]);
  });
  it('supports a per-user reference larger than the old 700KB guard', async () => {
    const f = fake(), repo = cloudRepository(f.db);
    await repo.transact('A', Date.now(), s => { s.profiles = [{ id: 'p', alias: '合成', scene: 'daily', preferences: 'x'.repeat(1024 * 1024), blockedTopics: '', version: 1, createdAt: Date.now() }]; return null; });
    expect(await repo.transact('A', Date.now(), s => s.profiles[0]?.preferences.length)).toBe(1024 * 1024);
  });
  it('retains the 5MiB per-account guard with an actionable error and no write', async () => {
    const f = fake(), repo = cloudRepository(f.db);
    await expect(repo.transact('A', Date.now(), s => { s.profiles = [{ id: 'p', alias: '合成', scene: 'daily', preferences: 'x'.repeat(5 * 1024 * 1024), blockedTopics: '', version: 1, createdAt: Date.now() }]; return null; }))
      .rejects.toMatchObject({ code: 'STORAGE_LIMIT' });
    expect(f.records.size).toBe(0);
  });
});
