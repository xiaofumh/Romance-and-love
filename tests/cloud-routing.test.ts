import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Execute the actual client with a wx transport boundary fake, not a cloud integration test.
const code = buildSync({ entryPoints: ['src/miniprogram/services/api.ts'], bundle: true,
  write: false, format: 'cjs', platform: 'browser', target: 'es2018' }).outputFiles[0]!.text;

function cloudClient(result: unknown) {
  const requests: any[] = [];
  const module = { exports: {} as { call: (action: string, payload?: unknown, requestId?: string) => Promise<unknown> } };
  const wx = { getStorageSync: (key: string) => key.endsWith('.mode') ? 'cloud' : undefined,
    cloud: { callFunction: async (request: unknown) => { requests.push(request); return { result }; } } };
  vm.runInContext(code, vm.createContext({ module, exports: module.exports, wx, console, Error, setTimeout, clearTimeout },
    { codeGeneration: { strings: false, wasm: false } }));
  return { api: module.exports, requests };
}

describe('cloud function V2 routing (wx mocked)', () => {
  it('routes the real client to V2 in the designated environment without supplying user identity', async () => {
    const c = cloudClient({ ok: true, requestId: 'server-test', data: { mode: 'cloud' } });
    expect(await c.api.call('session.bootstrap', {}, 'routing_test_001')).toEqual({ mode: 'cloud' });
    expect(c.requests).toEqual([{ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' },
      data: { action: 'session.bootstrap', payload: {}, clientRequestId: 'routing_test_001' } }]);
  });

  it('surfaces incomplete server configuration instead of pretending the model replied', async () => {
    const c = cloudClient({ ok: false, requestId: 'server-test', error: {
      code: 'SERVER_NOT_CONFIGURED', message: '云端尚未完成配置', retryable: false } });
    await expect(c.api.call('session.bootstrap')).rejects.toMatchObject({ code: 'SERVER_NOT_CONFIGURED' });
    expect(c.requests).toHaveLength(1);
  });
  it('surfaces the global budget stop without substituting a simulated answer', async () => {
    const c = cloudClient({ ok: false, requestId: 'budget-test', error: {
      code: 'BUDGET_EXCEEDED', message: '今日服务调用预算已用完', retryable: false } });
    await expect(c.api.call('companion.send', { conversationId: 'test', text: '你是什么人' }, 'budget_test_001'))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' }); expect(c.requests).toHaveLength(1);
  });
});
