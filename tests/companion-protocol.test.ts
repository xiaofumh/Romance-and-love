import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHttpProvider } from '../src/server/providers';
import { createService } from '../src/server/service';
import { MemoryRepository, MemoryBudget } from '../src/server/state';
import { POLICY_VERSION } from '../src/shared/contracts';
import type { ChatContext } from '../src/server/companion-prompt';
import type { ApiResult } from '../src/shared/contracts';
const config = { url: 'https://provider.example/v1/chat/completions', apiKey: 'fake-server-key', model: 'test', name: 'test', timeoutMs: 1000, jsonMode: true };
const c: ChatContext = { role: { id: 'r', name: '小小', relationship: 'partner', personality: '温柔倾听', version: 1, createdAt: 1, description: '', boundaries: '' }, messages: [], memories: [], examples: [], message: '你好' };
const wire = (content: unknown, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
const providerFor = (content: unknown, finish = 'stop') => createHttpProvider(config, (async () => wire(content, finish)) as typeof fetch);
function unwrap<T = any>(r: ApiResult): T { if (!r.ok) throw new Error(r.error.code); return r.data as T; }
describe('chat plain-text protocol with strict validation', () => {
  it('accepts actual plain-text response shapes that failed the earlier live run', async () => {
    for (const text of ['是啊，看着挺揪心的。不过有时候，没在一起也是一种真实的结局吧。', '好，那我们聊点别的。',
      '我没法查天气哦，而且你也还没说在哪儿，所以更不知道啦。', '好，那我安静陪着你。']) {
      expect((await providerFor(text).chat!(c)).output).toEqual({ text });
    }
  });
  it('supports the exact legacy envelope without displaying JSON syntax', async () => {
    expect((await providerFor('{"text":"在呢，怎么啦？"}').chat!(c)).output).toEqual({ text: '在呢，怎么啦？' });
  });
  it('rejects blank, oversized, non-string, truncated and malformed legacy responses', async () => {
    for (const content of ['', '  \n ', '长'.repeat(1201), null, ['text'], '{"text":1}', '{"text":"hello","extra":"do not silently discard"}', '{broken}'])
      await expect(providerFor(content).chat!(c)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    await expect(providerFor('不完整的正文', 'length').chat!(c)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
  });
  it('does not weaken structured reply-suggestion JSON parsing', async () => {
    await expect(providerFor('普通文本').generate({ input: { message: '你好', background: '', goal: '', scene: 'daily', tone: 'natural', length: 'short', profileId: null, saveHistory: false }, memories: [] }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
  });
  it('commits consecutive plain-text API replies, reuses plain history and does not call twice on replay', async () => {
    const requests: any[] = [], replies = ['在呢，怎么啦？', '哪一段让你印象最深？', '好，那就先不聊这个。'];
    const provider = createHttpProvider(config, (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return wire(replies[requests.length - 1]); }) as typeof fetch);
    const service = createService({ repository: new MemoryRepository(), budget: new MemoryBudget(), enabled: true, mode: 'cloud',
      id: randomUUID, hash: s => createHash('sha256').update(s).digest('hex'), provider, moderator: { check: async () => true } });
    const api = async (action: string, payload: unknown = {}, clientRequestId?: string) => unwrap(await service.handle('fictional-test-user', { action, payload, ...(clientRequestId ? { clientRequestId } : {}) }));
    await api('consent.update', { version: POLICY_VERSION, accepted: true }); await api('settings.update', { historyEnabled: true });
    const role = await api('companion.role.save', { name: '小小', relationship: 'partner', personality: '温柔倾听', description: '', boundaries: '' });
    const conversation = await api('companion.conversation.create', { roleId: role.id });
    const inputs = ['你好', '刚看完一部电影', '不']; const ids = inputs.map(() => randomUUID());
    for (let i = 0; i < inputs.length; i++) {
      const r = await api('companion.send', { conversationId: conversation.id, text: inputs[i] }, ids[i]); expect(r.job.status).toBe('SUCCEEDED'); expect(r.message.text).toBe(replies[i]);
    }
    const replay = await api('companion.send', { conversationId: conversation.id, text: inputs[2] }, ids[2]); expect(replay.message.text).toBe(replies[2]); expect(requests).toHaveLength(3);
    expect(requests.every(r => r.response_format.type === 'text')).toBe(true);
    expect(requests[1].messages).toContainEqual({ role: 'assistant', content: replies[0] });
    expect((await api('companion.conversation.get', { id: conversation.id })).conversation.messages).toHaveLength(6);
  });
  it('still applies production service output moderation to plain text without storing it', async () => {
    const service = createService({ repository: new MemoryRepository(), budget: new MemoryBudget(), enabled: true, mode: 'cloud', id: randomUUID,
      hash: s => createHash('sha256').update(s).digest('hex'), provider: providerFor('TEST_BLOCK'), moderator: { check: async t => !t.includes('TEST_BLOCK') } });
    const api = async (action: string, payload: unknown = {}) => unwrap(await service.handle('test', { action, payload }));
    await api('consent.update', { version: POLICY_VERSION, accepted: true }); await api('settings.update', { historyEnabled: true });
    const role = await api('companion.role.save', { name: '小小', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const conv = await api('companion.conversation.create', { roleId: role.id });
    expect(await service.handle('test', { action: 'companion.send', payload: { conversationId: conv.id, text: '你好' }, clientRequestId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'OUTPUT_BLOCKED' } });
    expect((await api('companion.conversation.get', { id: conv.id })).conversation.messages).toHaveLength(0);
  });
});
