import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '../src/shared/contracts';
import { dateKey } from '../src/server/state';

// Actual cloud entry + business service, with SDK/DB transport fakes. No network,
// real credentials, user consent changes or model requests in these unit tests.
const code = buildSync({ entryPoints: ['src/cloud/index.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', target: 'node20', external: ['wx-server-sdk', 'tencentcloud-sdk-nodejs-tms']
}).outputFiles[0]!.text;
const nativeRequire = createRequire(import.meta.url);
const testSecret = 'unit-test-only-not-a-real-secret-00000000';
function cloudEntry(enabled = false, extraEnv: Record<string, string> = {}, modelText?: string) {
  const context = { APPID: 'test-app', OPENID: 'trusted-user-A' };
  const documents = new Map<string, unknown>();
  let modelCalls = 0, sdkLoads = 0;
  const requests: any[] = [];
  const transaction = { collection: (collection: string) => ({ doc: (id: string) => {
    const key = `${collection}:${id}`;
    return { get: async () => ({ data: documents.get(key) }),
      set: async ({ data }: { data: unknown }) => { documents.set(key, structuredClone(data)); } };
  } }) };
  const cloud = { DYNAMIC_CURRENT_ENV: 'test-env', init: () => undefined,
    getWXContext: () => ({ ...context }), database: () => ({ runTransaction: async (operation: any) => operation(transaction) }) };
  const module = { exports: {} as { main: (event: unknown) => Promise<any> } };
  vm.runInContext(code, vm.createContext({ module, exports: module.exports, Buffer, URL, TextDecoder, AbortSignal,
    setTimeout, clearTimeout, process: { env: { ASSISTANT_USER_HASH_SECRET: testSecret, ASSISTANT_ENABLED: String(enabled), ...extraEnv } },
    fetch: async (_url: unknown, init: RequestInit) => {
      modelCalls++; requests.push(JSON.parse(String(init.body)));
      if (modelText == null) throw new Error('UNEXPECTED_MODEL_CALL');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: modelText } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    },
    require: (id: string) => {
      if (id === 'wx-server-sdk') return cloud;
      if (id === 'tencentcloud-sdk-nodejs-tms') { sdkLoads++; return {}; }
      return nativeRequire(id);
    },
  }, { codeGeneration: { strings: false, wasm: false } }));
  return { main: module.exports.main, context, documents, requests, modelCalls: () => modelCalls, sdkLoads: () => sdkLoads,
    key: (openid: string) => `assistant_users:${createHmac('sha256', testSecret).update(`test-app:${openid}`).digest('hex')}` };
}

describe('cloud entry envelope and trusted identity (SDK mocked)', () => {
  it('accepts wx transport userInfo but binds storage only to trusted WXContext', async () => {
    const c = cloudEntry();
    expect(await c.main({ action: 'session.bootstrap', payload: {}, userInfo: { appId: 'forged', openId: 'forged-user' },
      tcbContext: { APPID: 'forged', OPENID: 'forged-user', UID: 'forged-uid' } }))
      .toMatchObject({ ok: true, data: { mode: 'cloud', enabled: false, accepted: false } });
    expect([...c.documents.keys()]).toEqual([c.key('trusted-user-A')]);
    expect(c.modelCalls()).toBe(0);
  });

  it('does not let userInfo authenticate a request with no trusted OPENID', async () => {
    const c = cloudEntry(); c.context.OPENID = '';
    expect(await c.main({ action: 'session.bootstrap', userInfo: { openId: 'forged-user' },
      tcbContext: { OPENID: 'forged-user' } }))
      .toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(c.documents.size).toBe(0); expect(c.modelCalls()).toBe(0);
  });

  it('keeps rejecting other client-controlled top-level identity fields', async () => {
    const c = cloudEntry();
    expect(await c.main({ action: 'session.bootstrap', userInfo: {}, userId: 'another-user' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(c.documents.size).toBe(0);
  });

  it('does not loosen nested payload validation or non-object envelopes', async () => {
    const c = cloudEntry();
    expect(await c.main({ action: 'session.bootstrap', payload: { userInfo: {} }, userInfo: {} }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    for (const event of [null, [], 'session.bootstrap']) expect(await c.main(event))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(c.documents.size).toBe(0); expect(c.modelCalls()).toBe(0);
  });

  it('keeps two trusted users in different state documents despite identical userInfo', async () => {
    const c = cloudEntry(), event = { action: 'session.bootstrap', userInfo: { openId: 'same-forged-user' },
      tcbContext: { OPENID: 'same-forged-user' } };
    expect(await c.main(event)).toMatchObject({ ok: true });
    c.context.OPENID = 'trusted-user-B';
    expect(await c.main(event)).toMatchObject({ ok: true });
    expect([...c.documents.keys()]).toEqual([c.key('trusted-user-A'), c.key('trusted-user-B')]);
    expect(c.modelCalls()).toBe(0);
  });

  it('never returns the discarded metadata values or temporary transport diagnostics', async () => {
    const c = cloudEntry();
    const result = await c.main({ action: 'session.bootstrap', payload: {},
      tcbContext: { arbitrary: 'PRIVATE_CANARY' }, userInfo: { openId: 'PRIVATE_ID_CANARY' } });
    expect(result).toMatchObject({ ok: true }); expect(result).not.toHaveProperty('diagnostic');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|PRIVATE_ID_CANARY/);
    const enabled = cloudEntry(true);
    expect(await enabled.main({ action: 'session.bootstrap', unexpected: 'PRIVATE_CANARY' }))
      .not.toHaveProperty('diagnostic');
    expect(c.modelCalls() + enabled.modelCalls()).toBe(0);
  });

  it('continues rejecting other top-level identity/context lookalikes', async () => {
    const c = cloudEntry();
    for (const field of ['OPENID', 'APPID', 'uid', 'wxContext']) {
      expect(await c.main({ action: 'session.bootstrap', userInfo: {}, tcbContext: {}, [field]: 'forged' }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(c.documents.size).toBe(0); expect(c.modelCalls()).toBe(0);
  });
});

const testUserId = (openid: string) => {
  const uid = createHmac('sha256', testSecret).update(`test-app:${openid}`).digest('hex');
  return createHmac('sha256', testSecret).update(`internal-test:${uid}`).digest('hex');
};
const internalEnv = { ASSISTANT_RELEASE_STAGE: 'internal-test', CONTENT_REVIEW_MODE: 'internal-test',
  INTERNAL_TEST_USER_IDS: testUserId('trusted-user-A'), MODEL_API_KEY: 'unit-test-only-fake-key' };
async function prepareChat(c: ReturnType<typeof cloudEntry>) {
  const api = async (action: string, payload: unknown) => {
    const result = await c.main({ action, payload });
    expect(result).toMatchObject({ ok: true }); return result.data;
  };
  await api('consent.update', { version: POLICY_VERSION, accepted: true });
  await api('settings.update', { historyEnabled: true });
  const role = await api('companion.role.save', { name: '测试朋友', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
  const conversation = await api('companion.conversation.create', { roleId: role.id });
  return { api, send: (text = '你好', clientRequestId = 'internal_test_001') => c.main({
    action: 'companion.send', payload: { conversationId: conversation.id, text }, clientRequestId }), conversation };
}

describe('restricted internal-test cloud entry (SDK/DB/model transport mocked, no paid calls)', () => {
  it('accepts a configured 300000 daily global cap without changing the personal cap', async () => {
    const c = cloudEntry(true, { ...internalEnv, DAILY_MODEL_CALL_LIMIT: '300000', CHAT_DAILY_USER_LIMIT: '30', INTERNAL_TEST_CHAT_DAILY_LIMIT: '30' });
    expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true,
      data: { globalDailyCallLimit: 300000, chatDailyLimit: 30, chatRemaining: 30 } });
    expect(c.modelCalls()).toBe(0);
  });
  it('defaults only eligible internal test accounts to 1000, keeping ordinary accounts at 30', async () => {
    const c = cloudEntry(true, { ...internalEnv, DAILY_MODEL_CALL_LIMIT: '300000', CHAT_DAILY_USER_LIMIT: '30' });
    expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { chatDailyLimit: 1000, chatRemaining: 1000 } });
    c.context.OPENID = 'trusted-user-B';
    expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { enabled: false, chatDailyLimit: 30, chatRemaining: 30 } });
    const production = cloudEntry(true, { CHAT_DAILY_USER_LIMIT: '30' });
    expect(await production.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { chatDailyLimit: 30 } });
    expect(c.modelCalls()).toBe(0); expect(production.modelCalls()).toBe(0);
  });
  it('allows the 1000th test turn and rejects the 1001st before calling a model (transport fake)', async () => {
    const c = cloudEntry(true, { ...internalEnv, CHAT_DAILY_USER_LIMIT: '30' }, '收到');
    const chat = await prepareChat(c), stored = c.documents.get(c.key('trusted-user-A')) as any;
    const stamp = Date.now() - 61000;
    stored.state.companion.jobs = Array.from({ length: 999 }, (_, i) => ({ id: `seed_${i}`, conversationId: chat.conversation.id,
      roleId: stored.state.companion.roles[0].id, hash: `fake_${i}`, revision: stored.state.revision,
      status: 'SUCCEEDED', createdAt: stamp, leaseUntil: stamp, day: dateKey(Date.now()) }));
    expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { chatRemaining: 1 } });
    expect(await chat.send('第1000轮', 'test_quota_1000')).toMatchObject({ ok: true });
    expect(await chat.send('第1001轮', 'test_quota_1001')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    expect(c.modelCalls()).toBe(1);
    expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { chatRemaining: 0 } });
  });
  it('keeps the safe default and rejects invalid global daily caps', async () => {
    expect(await cloudEntry().main({ action: 'session.bootstrap' })).toMatchObject({ ok: true, data: { globalDailyCallLimit: 100 } });
    for (const value of ['300001', '0', '-1', '2.5', 'not-a-number', '']) {
      const c = cloudEntry(false, { DAILY_MODEL_CALL_LIMIT: value });
      expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: false, error: { code: 'SERVER_NOT_CONFIGURED' } });
      expect(c.modelCalls()).toBe(0);
    }
  });
  it('routes screenshots to the vision model under trusted WX identity without persisting image or recognised text', async () => {
    const content = { overflow: false, messages: [{ side: 'left', text: 'SCREENSHOT_PRIVATE_CANARY', kind: 'text', uncertain: false }] };
    const c = cloudEntry(true, internalEnv, JSON.stringify(content)), chat = await prepareChat(c);
    const roleId = (await chat.api('companion.list', {})).roles[0].id;
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=';
    expect(await c.main({ action: 'screenshot.recognize', clientRequestId: 'screenshot_test_001',
      payload: { roleId, image, authorized: true }, userInfo: { openId: 'forged-user' } }))
      .toMatchObject({ ok: true, data: content });
    expect(c.modelCalls()).toBe(1); expect(c.requests[0].model).toBe('glm-4.6v-flashx');
    const stored = JSON.stringify([...c.documents.values()]); expect(stored).not.toContain(image); expect(stored).not.toContain('SCREENSHOT_PRIVATE_CANARY');
    expect(c.documents.has(c.key('forged-user'))).toBe(false); expect(c.sdkLoads()).toBe(0);
  });
  it('imports and retrieves a full 1MiB text through the cloud adapter without a model call', async () => {
    const c = cloudEntry(false), chat = await prepareChat(c);
    const list = await chat.api('companion.list', {}), roleId = list.roles[0].id;
    const prefix = '我：', suffix = '\n对方：尾', text = prefix + 'x'.repeat(1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
    const doc = await chat.api('companion.import', { roleId, title: '合成大资料', text, userSpeaker: '我', referenceSpeaker: '对方', authorized: true });
    expect((await chat.api('companion.document.get', { id: doc.id })).turns[0].text.length).toBe(text.length - prefix.length - suffix.length);
    expect(c.modelCalls()).toBe(0); expect(c.sdkLoads()).toBe(0);
  });
  it('keeps missing production moderation fail-closed and makes no model request', async () => {
    const c = cloudEntry(true, { MODEL_API_KEY: 'unit-test-fake-key' }), chat = await prepareChat(c);
    expect(await chat.send()).toMatchObject({ ok: false, error: { code: 'MODERATION_UNAVAILABLE' } });
    expect(c.modelCalls()).toBe(0); expect(c.sdkLoads()).toBe(0);
    expect([...c.documents.keys()].some(k => k.startsWith('assistant_budgets:'))).toBe(false);
  });
  it('cannot skip external checks in a production stage or with an invalid mode', async () => {
    for (const env of [{ ...internalEnv, ASSISTANT_RELEASE_STAGE: 'production' },
      { ...internalEnv, CONTENT_REVIEW_MODE: 'off' }, { ...internalEnv, INTERNAL_TEST_USER_IDS: '*' }]) {
      const c = cloudEntry(true, env);
      expect(await c.main({ action: 'session.bootstrap' })).toMatchObject({ ok: false, error: { code: 'SERVER_NOT_CONFIGURED' } });
      expect(c.documents.size).toBe(0); expect(c.modelCalls()).toBe(0);
    }
  });
  it('defaults an empty allowlist to nobody and exposes only a separate self test identifier', async () => {
    const c = cloudEntry(true, { ...internalEnv, INTERNAL_TEST_USER_IDS: '' });
    const result = await c.main({ action: 'session.bootstrap' });
    expect(result).toMatchObject({ ok: true, data: { enabled: false,
      contentReview: { mode: 'internal-test', eligible: false, testUserId: testUserId('trusted-user-A') } } });
    expect(JSON.stringify(result)).not.toContain('trusted-user-A');
    expect(result.data.contentReview.testUserId).not.toBe(c.key('trusted-user-A').split(':')[1]);
    const chat = await prepareChat(c);
    expect(await chat.send()).toMatchObject({ ok: false, error: { code: 'INTERNAL_TEST_ONLY' } });
    expect(c.modelCalls()).toBe(0);
  });
  it('allows only an eligible user, keeps direct text chat and idempotency, and never loads the TMS SDK', async () => {
    const c = cloudEntry(true, internalEnv, '我在呢，今天过得怎么样？'), chat = await prepareChat(c);
    const first = await chat.send(), replay = await chat.send();
    expect(first).toMatchObject({ ok: true, data: { job: { status: 'SUCCEEDED' }, message: { text: '我在呢，今天过得怎么样？', mode: 'cloud' } } });
    expect(replay.data).toEqual(first.data); expect(c.modelCalls()).toBe(1); expect(c.sdkLoads()).toBe(0);
    expect(c.requests[0]).toMatchObject({ model: 'glm-4.7', response_format: { type: 'text' } });
    expect([...c.documents.entries()].filter(([k]) => k.startsWith('assistant_budgets:')).map(([, v]) => v))
      .toMatchObject([{ calls: 1 }]);
  });
  it('cannot impersonate an eligible user through metadata or client flags', async () => {
    const c = cloudEntry(true, internalEnv, '不会调用'); c.context.OPENID = 'trusted-user-B';
    const chat = await prepareChat(c);
    expect(await chat.send()).toMatchObject({ ok: false, error: { code: 'INTERNAL_TEST_ONLY' } });
    expect(await c.main({ action: 'session.bootstrap', userInfo: { openId: 'trusted-user-A' }, tcbContext: { OPENID: 'trusted-user-A' } }))
      .toMatchObject({ ok: true, data: { enabled: false, contentReview: { eligible: false, testUserId: testUserId('trusted-user-B') } } });
    expect(await c.main({ action: 'companion.send', clientRequestId: 'forged_test_001', payload: {
      conversationId: chat.conversation.id, text: '你好', internalTest: true } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(c.modelCalls()).toBe(0); expect(c.sdkLoads()).toBe(0);
    expect([...c.documents.keys()].some(k => k.startsWith('assistant_budgets:'))).toBe(false);
  });
  it('also enforces the allowlist on the legacy suggestion endpoint', async () => {
    const c = cloudEntry(true, { ...internalEnv, INTERNAL_TEST_USER_IDS: '' }); await prepareChat(c);
    expect(await c.main({ action: 'generation.create', clientRequestId: 'legacy_test_001', payload: {
      message: '你好', background: '', goal: '', scene: 'daily', tone: 'natural', length: 'short', profileId: null, saveHistory: false } }))
      .toMatchObject({ ok: false, error: { code: 'INTERNAL_TEST_ONLY' } });
    expect(c.modelCalls()).toBe(0);
  });
  it('does not enable the model or bypass the global billable-attempt budget', async () => {
    const disabled = cloudEntry(false, internalEnv, '不会调用'), chat = await prepareChat(disabled);
    expect(await chat.send()).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(disabled.modelCalls()).toBe(0);
    const limited = cloudEntry(true, { ...internalEnv, DAILY_MODEL_CALL_LIMIT: '1' }, '第一条回复'), active = await prepareChat(limited);
    expect(await active.send()).toMatchObject({ ok: true });
    expect(await active.send('第二条', 'internal_test_002')).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(limited.modelCalls()).toBe(1);
  });
  it('lets non-eligible users export and delete their own data without generation permission', async () => {
    const c = cloudEntry(true, { ...internalEnv, INTERNAL_TEST_USER_IDS: '' }), chat = await prepareChat(c);
    expect(await chat.api('companion.export', { confirmed: true })).toMatchObject({ roles: [{ name: '测试朋友' }] });
    await chat.api('companion.delete', { kind: 'conversation', id: chat.conversation.id });
    expect(await chat.api('companion.list', {})).toMatchObject({ conversations: [] });
    expect(c.modelCalls()).toBe(0);
  });
});
