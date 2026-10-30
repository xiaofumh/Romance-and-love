import { describe, expect, it } from 'vitest';
import { BIGMODEL_CHAT_URL, modelConfigFromEnv } from '../src/server/model-config';
import { createHttpProvider } from '../src/server/providers';
import type { ModelConfig } from '../src/server/providers';
import type { ChatContext } from '../src/server/companion-prompt';
import type { ProviderContext } from '../src/server/service';

// Synthetic transport only: no real key, vendor request or paid retry.
const env = { MODEL_API_KEY: 'FAKE-CHAT-SAMPLING-KEY' };
const chat: ChatContext = { role: { id: 'r', version: 1, createdAt: 1, name: '虚构', relationship: 'friend',
  personality: '理性坦诚', description: '', boundaries: '' }, messages: [], memories: [], examples: [], message: '合成测试你好' };
const suggestion: ProviderContext = { input: { message: '合成测试你好', background: '', goal: '', scene: 'daily',
  tone: 'natural', length: 'short', profileId: null, saveHistory: false }, memories: [] };
function capture(config: ModelConfig) {
  const bodies: any[] = [];
  const provider = createHttpProvider(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const content = body.response_format?.type === 'text' ? '我在。' : '{"replies":[],"warnings":[]}';
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  }) as typeof fetch);
  return { bodies, provider };
}

describe('bounded companion chat sampling candidate (transport mocked)', () => {
  it('uses the project candidate 0.6 only for official GLM-4.7 chat and records the serialized value', async () => {
    const config = modelConfigFromEnv(env), f = capture(config);
    expect(config).toMatchObject({ url: BIGMODEL_CHAT_URL, model: 'glm-4.7', chatTemperature: 0.6 });
    const result = await f.provider.chat!(chat);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]).toMatchObject({ model: 'glm-4.7', temperature: 0.6, stream: false, response_format: { type: 'text' } });
    expect(f.bodies[0]).not.toHaveProperty('top_p');
    expect(f.bodies[0]).not.toHaveProperty('do_sample');
    expect(result.requestAudit).toMatchObject({ protocol: 'window-evidence-v2', historyMessages: 0, chatTemperature: 0.6 });
  });

  it.each(['0', '0.00', '0.01', '0.29', '0.6', '0.60', '0.99', '1', '1.0', '1.00'])('serializes explicit override %s as a number in one chat request', async value => {
    const f = capture(modelConfigFromEnv({ ...env, MODEL_CHAT_TEMPERATURE: value }));
    const result = await f.provider.chat!(chat);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].temperature).toBe(Number(value));
    expect(result.requestAudit?.chatTemperature).toBe(Number(value));
    expect(f.bodies[0]).not.toHaveProperty('top_p');
  });

  it.each(['', ' ', '\t', 'NaN', 'Infinity', '-Infinity', '-0.1', '-0', '1.01', '2', '0.001', '0.600', '1.000',
    '0.6x', '0,6', '.6', '0.', '+0.6', '1e-1', '0x0', ' 0.6', '0.6 '])('rejects invalid/ambiguous server value %j before constructing a request', value => {
    expect(() => modelConfigFromEnv({ ...env, MODEL_CHAT_TEMPERATURE: value })).toThrow('INVALID_MODEL_CHAT_TEMPERATURE');
  });

  it('leaves structured suggestion sampling absent even with an explicit chat override', async () => {
    for (const value of [undefined, '0', '1']) {
      const f = capture(modelConfigFromEnv({ ...env, ...(value === undefined ? {} : { MODEL_CHAT_TEMPERATURE: value }) }));
      const result = await f.provider.generate(suggestion);
      expect(f.bodies).toHaveLength(1);
      expect(f.bodies[0]).not.toHaveProperty('temperature');
      expect(f.bodies[0]).not.toHaveProperty('top_p');
      expect(f.bodies[0].response_format).toEqual({ type: 'json_object' });
      expect(result).not.toHaveProperty('requestAudit');
    }
  });

  it.each([
    { MODEL_API_URL: 'https://provider.example/v1/chat/completions', MODEL_NAME: 'glm-4.7' },
    { MODEL_NAME: 'another-model' },
  ])('preserves nonofficial defaults without adding sampling: %j', async override => {
    const config = modelConfigFromEnv({ ...env, ...override }), f = capture(config);
    expect(config).not.toHaveProperty('chatTemperature');
    const result = await f.provider.chat!(chat);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]).not.toHaveProperty('temperature');
    expect(f.bodies[0]).not.toHaveProperty('top_p');
    expect(result.requestAudit).not.toHaveProperty('chatTemperature');
  });

  it('allows an explicit bounded override for another provider without changing its suggestion sampling', async () => {
    const f = capture(modelConfigFromEnv({ ...env, MODEL_API_URL: 'https://provider.example/v1/chat/completions', MODEL_NAME: 'other', MODEL_CHAT_TEMPERATURE: '0.42' }));
    await f.provider.chat!(chat); await f.provider.generate(suggestion);
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0].temperature).toBe(0.42); expect(f.bodies[1]).not.toHaveProperty('temperature');
  });

  it.each([NaN, Infinity, -Infinity, -0.01, 1.01, 0.001])('rejects an invalid direct adapter sampling value %s without transport', async value => {
    const f = capture({ ...modelConfigFromEnv(env), chatTemperature: value });
    await expect(f.provider.chat!(chat)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(f.bodies).toHaveLength(0);
  });

  it('does not retry a failed request at another temperature', async () => {
    let calls = 0;
    const provider = createHttpProvider(modelConfigFromEnv(env), (async (_url, init) => {
      calls++; expect(JSON.parse(String(init?.body)).temperature).toBe(0.6);
      return new Response('FAKE-PRIVATE-VENDOR-MESSAGE', { status: 503 });
    }) as typeof fetch);
    const error = await provider.chat!(chat).catch(e => e);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(error.message).not.toContain('FAKE-PRIVATE'); expect(calls).toBe(1);
  });
});
