import { describe, expect, it } from 'vitest';
import { createHttpProvider } from '../src/server/providers';
import type { ChatContext } from '../src/server/companion-prompt';
import type { ProviderContext } from '../src/server/service';

const config = { url: 'https://provider.example/v1/chat/completions', apiKey: 'FAKE-STREAM-TEST-KEY',
  model: 'test', name: 'stream-boundary-unit-only', timeoutMs: 1000, jsonMode: true };
const chat: ChatContext = { role: { id: 'r', version: 1, createdAt: 1, name: '虚构', relationship: 'friend',
  personality: '温柔倾听', description: '', boundaries: '' }, messages: [], memories: [], examples: [], message: '你好' };
const suggestion: ProviderContext = { input: { message: '你好', background: '', goal: '', scene: 'daily',
  tone: 'natural', length: 'short', profileId: null, saveHistory: false }, memories: [] };
const rawPrivateError = 'FAKE-PRIVATE-VENDOR-DETAIL https://private.example/FAKE-KEY';
const operations = ['chat', 'generate'] as const;

function brokenBody(error: unknown) {
  let reads = 0, released = 0, requests = 0;
  const response = { ok: true, status: 200, body: { getReader: () => ({
    async read() {
      reads++;
      if (reads === 1) return { done: false, value: new TextEncoder().encode('{"choices":[') };
      throw error;
    },
    releaseLock() { released++; },
  }) } } as unknown as Response;
  const provider = createHttpProvider(config, (async () => { requests++; return response; }) as typeof fetch);
  return { provider, counters: () => ({ reads, released, requests }) };
}

describe('provider response-stream failure classification (transport mocked)', () => {
  for (const operation of operations) for (const name of ['AbortError', 'TimeoutError']) {
    it(`${operation}: preserves ${name} after headers as a timeout and sends only once`, async () => {
      const f = brokenBody(new DOMException(rawPrivateError, name));
      const promise = operation === 'chat' ? f.provider.chat!(chat) : f.provider.generate(suggestion);
      const error = await promise.catch(e => e);
      expect(error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
      expect(error.message).not.toContain(rawPrivateError);
      expect(JSON.stringify(error)).not.toContain('FAKE-PRIVATE');
      expect(JSON.stringify(error)).not.toContain('private.example');
      expect(JSON.stringify(error)).not.toContain(config.apiKey);
      expect(f.counters()).toEqual({ reads: 2, released: 1, requests: 1 });
    });
  }
  for (const operation of operations) {
    it(`${operation}: reports an interrupted partial body as unavailable, not malformed JSON`, async () => {
      const f = brokenBody(new TypeError(rawPrivateError));
      const error = await (operation === 'chat' ? f.provider.chat!(chat) : f.provider.generate(suggestion)).catch(e => e);
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      expect(error.message).not.toContain(rawPrivateError);
      expect(f.counters()).toEqual({ reads: 2, released: 1, requests: 1 });
    });
    it(`${operation}: still classifies an actually truncated JSON body as invalid output`, async () => {
      let requests = 0;
      const provider = createHttpProvider(config, (async () => { requests++; return new Response('{"choices":['); }) as typeof fetch);
      await expect(operation === 'chat' ? provider.chat!(chat) : provider.generate(suggestion))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      expect(requests).toBe(1);
    });
  }
  it('keeps invalid finish reasons and malformed model envelopes as format failures', async () => {
    for (const [content, finish] of [['hello', 'length'], ['{broken}', 'stop'], [' ', 'stop']]) {
      let requests = 0;
      const provider = createHttpProvider(config, (async () => { requests++; return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] })); }) as typeof fetch);
      await expect(provider.chat!(chat)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      expect(requests).toBe(1);
    }
  });
  it('preserves the response-size failure if cancellation also fails', async () => {
    let reads = 0, released = 0, requests = 0;
    const response = { ok: true, body: { getReader: () => ({ async read() { reads++; return { done: false, value: new Uint8Array(100001) }; },
      async cancel() { throw new TypeError(rawPrivateError); }, releaseLock() { released++; } }) } } as unknown as Response;
    const provider = createHttpProvider(config, (async () => { requests++; return response; }) as typeof fetch);
    await expect(provider.chat!(chat)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    expect({ reads, released, requests }).toEqual({ reads: 1, released: 1, requests: 1 });
  });
  it('does not let releaseLock failure mask the network classification', async () => {
    let requests = 0;
    const response = { ok: true, body: { getReader: () => ({ async read() { throw new DOMException(rawPrivateError, 'AbortError'); },
      releaseLock() { throw new TypeError(rawPrivateError); } }) } } as unknown as Response;
    const provider = createHttpProvider(config, (async () => { requests++; return response; }) as typeof fetch);
    await expect(provider.chat!(chat)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' }); expect(requests).toBe(1);
  });
  it('still accepts a successful plain-text chat and structured suggestion body', async () => {
    let requests = 0;
    const provider = createHttpProvider(config, (async (_url, init) => { requests++; const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: body.response_format.type === 'text' ? '我在。' : '{"replies":[],"warnings":[]}' } }] })); }) as typeof fetch);
    expect((await provider.chat!(chat)).output).toEqual({ text: '我在。' });
    expect((await provider.generate(suggestion)).output).toEqual({ replies: [], warnings: [] });
    expect(requests).toBe(2);
  });
});
