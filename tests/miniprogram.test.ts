import { buildSync, transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION } from '../src/shared/contracts';
import { importText } from './fixtures/import-text';
import { feedingFixture } from './fixtures/feeding-text';
import { cloudBoot, cloudDetail } from './fixtures/mode-chat-detail';

// Execute actual mini-program page logic + local runtime with a wx boundary fake.
// This checks application behavior, not native rendering (which still needs DevTools).
const runtimeCode = buildSync({ entryPoints: ['src/miniprogram/runtime.ts'], bundle: true,
  write: false, format: 'cjs', platform: 'browser', target: 'es2018',
  define: { 'process.env.NODE_ENV': '"test"' } }).outputFiles[0]!.text;
function mini(cloudData?: (request: any) => unknown, file?: { size: number; text: string }, storageGuard?: (key: string, value: unknown) => void,
  image?: { width: number; height: number; tiles: string[] }) {
  const storage = new Map<string, unknown>(); const clipboards: string[] = []; const toasts: string[] = [];
  const cloudRequests: any[] = [];
  const modals: any[] = [];
  const events: any[] = [], navigations: any[] = []; let canvasTile = -1;
  const canvas = { width: 1, height: 1, createImage: () => ({ onload: () => {}, set src(_value: string) { this.onload(); } }),
    getContext: () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => { canvasTile++; } }),
    toDataURL: () => image?.tiles[canvasTile] ?? 'data:image/jpeg;base64,AAAA' };
  let fileReads = 0;
  const wx = { getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: unknown) => { storageGuard?.(key, value); storage.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync: (key: string) => storage.delete(key),
    showToast: (p: { title: string }) => toasts.push(p.title),
    setClipboardData: (p: { data: string; success?: () => void }) => { clipboards.push(p.data); p.success?.(); },
    navigateTo: (p: any) => { navigations.push(p); p.success?.({ eventChannel: { emit: (name: string, data: unknown) => events.push({ name, data }) } }); }, switchTab: () => undefined, redirectTo: () => undefined, navigateBack: () => undefined,
    chooseMedia: (p: any) => image ? p.success({ tempFiles: [{ size: 100, tempFilePath: '/mock/screenshot.jpg' }] }) : p.fail(),
    getImageInfo: (p: any) => p.success({ width: image?.width, height: image?.height }), previewImage: () => {},
    createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(cb: any) { cb([{ node: canvas }]); } }),
    setNavigationBarTitle: () => undefined, showModal: (p: any) => { modals.push(p); }, showActionSheet: () => undefined,
    chooseMessageFile: (options: any) => file ? options.success({ tempFiles: [{ size: file.size, path: '/mock/synthetic.txt', name: 'synthetic.txt' }] }) : options.fail(),
    getFileSystemManager: () => ({ readFile: (options: any) => { fileReads++; options.success({ data: file?.text ?? '' }); } }),
    cloud: { callFunction: async (request: any) => {
      cloudRequests.push(request); return { result: { ok: true, requestId: 'wx-mocked-test', data: await cloudData?.(request) } };
    } } };
  const runtimeModule = { exports: {} as Record<string, any> };
  const ctx = vm.createContext({ module: runtimeModule, exports: runtimeModule.exports, wx, console, Error, Date, setTimeout, clearTimeout },
    { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(runtimeCode, ctx);
  const api = runtimeModule.exports;
  // Most unit workflows intentionally exercise local fixtures. Production fresh
  // installs now default to cloud; mocked tests must never imply real inference.
  api.setMode('demo');
  function page(name: string): any {
    let options: any;
    const source = readFileSync(path.join('src/miniprogram/pages', name, 'index.ts'), 'utf8');
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2018' }).code;
    vm.runInContext(code, vm.createContext({ wx, console, Error, Date, setTimeout, clearTimeout, exports: {}, module: { exports: {} },
      require: (id: string) => id.endsWith('/config') ? { config: { version: '0.1.0' } } : api,
      Page: (p: unknown) => { options = p; } }));
    options.data = JSON.parse(JSON.stringify(options.data));
    options.setData = (patch: Record<string, unknown>) => Object.assign(options.data, patch);
    options.getOpenerEventChannel = () => ({ once: () => {}, emit: (name: string, data: unknown) => events.push({ name, data }) });
    return options;
  }
  return { api, page, clipboards, toasts, storage, cloudRequests, events, navigations, modals, fileReads: () => fileReads };
}
describe('native mini-program page workflows (wx mocked)', () => {
  it('loads the server Beijing timestamp without deriving the current date from the device clock', async () => {
    const response = { ...cloudDetail, clock: { dateTime: '2026-10-29 01:00:00' } };
    const m = mini(r => r.data.action === 'session.bootstrap' ? cloudBoot : response); m.api.setMode('cloud');
    const p = m.page('chat'); p.onLoad({ id: 'own-clock', mode: 'cloud' }); await p.onShow();
    expect(p.data.beijingTime).toBe('2026-10-29 01:00:00'); expect(m.cloudRequests).toHaveLength(2); p.onUnload();
  });
  it('automatically initiates exactly once after 45 seconds visible and idle, never before', async () => {
    vi.useFakeTimers();
    try {
      const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
      const m = mini(r => r.data.action === 'session.bootstrap' ? cloudBoot : response); m.api.setMode('cloud');
      const p = m.page('chat'); p.onLoad({ id: 'own-timer', mode: 'cloud' }); await p.onShow();
      await vi.advanceTimersByTimeAsync(44999); expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600000); expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(1); p.onUnload();
    } finally { vi.useRealTimers(); }
  });
  it('uses an absolute server deadline so clearing a draft does not restart the entire cooldown', async () => {
    vi.useFakeTimers();
    try {
      const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 101000 }, serverTime: 1000 };
      const m = mini(r => r.data.action === 'session.bootstrap' ? cloudBoot : response); m.api.setMode('cloud');
      const p = m.page('chat'); p.onLoad({ id: 'own-deadline', mode: 'cloud' }); await p.onShow();
      p.input({ detail: { value: '草稿' } }); await vi.advanceTimersByTimeAsync(40000); p.input({ detail: { value: '' } });
      await vi.advanceTimersByTimeAsync(59999); expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(1); p.onUnload();
    } finally { vi.useRealTimers(); }
  });
  it('stops the old timer during a fresh load and blocks direct initiative while loading', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0, release!: (value: unknown) => void;
      const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
      const m = mini(r => r.data.action === 'session.bootstrap' ? ++reads === 1 ? cloudBoot : new Promise(resolve => release = resolve) : response); m.api.setMode('cloud');
      const p = m.page('chat'); p.onLoad({ id: 'own-loading', mode: 'cloud' }); await p.onShow();
      const pending = p.load(); expect(p.initiativeTimer).toBeNull(); await vi.advanceTimersByTimeAsync(50000); await p.initiate();
      expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(0);
      release(cloudBoot); await pending; p.onUnload();
    } finally { vi.useRealTimers(); }
  });
  it('does not fetch or paint a late initiative onto a hidden page', async () => {
    let finish!: (value: unknown) => void;
    const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
    const m = mini(r => r.data.action === 'companion.initiative' ? new Promise(resolve => finish = resolve) : r.data.action === 'session.bootstrap' ? cloudBoot : response);
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'own-hidden', mode: 'cloud' }); await p.onShow(); p.lastActivityAt -= 45001;
    const pending = p.initiate(); p.onHide(); finish({}); await pending;
    expect(m.cloudRequests).toHaveLength(3); expect(p.data.initiativeNote).toBe(''); expect(p.data.initiativeBusy).toBe(false); p.onUnload();
  });
  it('never initiates without current consent, saved-history opt-in, or enabled model', async () => {
    for (const bootstrap of [{ ...cloudBoot, accepted: false }, { ...cloudBoot, enabled: false }, { ...cloudBoot, settings: { historyEnabled: false } }]) {
      const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
      const m = mini(r => r.data.action === 'session.bootstrap' ? bootstrap : response); m.api.setMode('cloud');
      const p = m.page('chat'); p.onLoad({ id: 'own-no-consent', mode: 'cloud' }); await p.onShow(); p.lastActivityAt -= 45001; await p.initiate();
      expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(0); expect(m.modals).toHaveLength(0); p.onUnload();
    }
  });
  it('loads a paused conversation without mode controls or silently enabling initiative', async () => {
    const m = mini(r => r.data.action === 'companion.conversation.get' ? { ...cloudDetail,
      conversation: { ...cloudDetail.conversation, settingsVersion: 2, interaction: { mode: 'quiet' } } } : { mode: 'light', version: 3 });
    m.api.setMode('cloud'); const p = m.page('chat-settings'); p.onLoad({ id: 'own-choice' }); await p.onShow();
    expect(p.interact).toBeUndefined(); expect(m.cloudRequests).toHaveLength(1); expect(m.modals).toHaveLength(0);
    expect(p.data.interactionMode).toBe('quiet'); expect(p.data.contextRounds).toBe(12);
    expect(m.cloudRequests.some(r => /send|initiative|role.save/.test(r.data.action))).toBe(false);
  });
  it('renders model paragraphs as bubbles without extra requests or changing copied full text', async () => {
    const response = { ...cloudDetail, role: { ...cloudDetail.role, bubbleStyle: 'natural' }, conversation: { ...cloudDetail.conversation,
      contextRounds: 12, messages: [{ id: 'own-test', speaker: 'assistant', text: '第一段\n\n第二段', mode: 'cloud', kind: 'reply' }] } };
    const m = mini(r => r.data.action === 'session.bootstrap' ? cloudBoot : response); m.api.setMode('cloud');
    const p = m.page('chat'); p.onLoad({ id: 'own-test-conversation', mode: 'cloud' }); await p.onShow();
    expect(p.data.messages[0].displayParts).toEqual(['第一段', '第二段']); expect(p.data.contextRounds).toBe(12);
    p.copy({ currentTarget: { dataset: { id: 'own-test' } } }); expect(m.clipboards[0]).toContain('第一段\n\n第二段');
    expect(m.cloudRequests).toHaveLength(2); p.onUnload();
  });
  it('cancels scheduled initiative on hide, draft entry or unload and never accepts consent for it', async () => {
    vi.useFakeTimers();
    try {
      const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { enabled: true, available: true, availableAt: 1, reason: 'ready' }, serverTime: 2 };
      const m = mini(r => r.data.action === 'session.bootstrap' ? cloudBoot : response); m.api.setMode('cloud');
      const p = m.page('chat'); p.onLoad({ id: 'own-test', mode: 'cloud' }); await p.onShow(); expect(p.initiativeTimer).not.toBeNull();
      p.onHide(); expect(p.initiativeTimer).toBeNull(); await vi.advanceTimersByTimeAsync(50000);
      expect(m.cloudRequests.some(r => r.data.action === 'companion.initiative')).toBe(false);
      await p.onShow(); p.input({ detail: { value: '正在写草稿' } }); expect(p.initiativeTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(50000); expect(m.cloudRequests.some(r => r.data.action === 'companion.initiative')).toBe(false);
      p.onUnload(); expect(m.modals).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not retry an initiative failure automatically or erase a draft typed during generation', async () => {
    const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
    const m = mini(r => { if (r.data.action === 'companion.initiative') throw new Error('MOCK_ONLY'); return r.data.action === 'session.bootstrap' ? cloudBoot : response; });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'own-test', mode: 'cloud' }); await p.onShow();
    p.lastActivityAt = Date.now() - 45001;
    await p.initiate(); expect(p.data.initiativeNote).toContain('不会自动重试'); expect(p.data.initiativeBusy).toBe(false);
    expect(m.cloudRequests.filter(r => r.data.action === 'companion.initiative')).toHaveLength(1);
    p.input({ detail: { value: '草稿仍可输入' } }); expect(p.data.text).toBe('草稿仍可输入'); p.onUnload();
  });
  it('changes context only after a confirmation, passing version and window without a model request', async () => {
    const m = mini(r => r.data.action === 'companion.conversation.get' ? { ...cloudDetail, conversation: { ...cloudDetail.conversation, contextRounds: 6, settingsVersion: 2 } } : { version: 3, contextRounds: 12 });
    m.api.setMode('cloud'); const p = m.page('chat-settings'); p.onLoad({ id: 'own-test' }); await p.onShow();
    p.context({ currentTarget: { dataset: { rounds: '12' } } }); expect(m.cloudRequests.filter(r => r.data.action.endsWith('configure'))).toHaveLength(0);
    await m.modals[0].success({ confirm: true });
    expect(m.cloudRequests.find(r => r.data.action.endsWith('configure')).data.payload).toEqual({ id: 'own-test', version: 2, contextRounds: 12 });
    expect(m.cloudRequests.some(r => /send|initiative/.test(r.data.action))).toBe(false);
  });
  it('preserves a draft typed during initiative generation and blocks an overlapping ordinary send', async () => {
    let finish!: (value: unknown) => void;
    const response = { ...cloudDetail, role: { ...cloudDetail.role, proactiveEnabled: true }, initiative: { availableAt: 1 }, serverTime: 2 };
    const m = mini(r => r.data.action === 'companion.initiative' ? new Promise(resolve => finish = resolve)
      : r.data.action === 'session.bootstrap' ? cloudBoot : response);
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'own-test', mode: 'cloud' }); await p.onShow();
    p.lastActivityAt = Date.now() - 45001;
    const pending = p.initiate(); expect(p.data.initiativeBusy).toBe(true);
    p.input({ detail: { value: '生成途中写下的草稿' } }); await p.send();
    expect(m.cloudRequests.some(r => r.data.action === 'companion.send')).toBe(false);
    finish({ job: { status: 'SUCCEEDED' } }); await pending;
    expect(p.data.text).toBe('生成途中写下的草稿'); expect(p.data.initiativeBusy).toBe(false); p.onUnload();
  });
  it('saves selected structured role preferences while keeping confirmation explicit', async () => {
    const m = mini(), p = m.page('role-edit'); p.data.name = '虚构伙伴'; p.data.step = 2;
    p.input({ currentTarget: { dataset: { field: 'userAddress' } }, detail: { value: '小林' } });
    p.input({ currentTarget: { dataset: { field: 'habits' } }, detail: { value: '少用反问' } });
    p.preference({ currentTarget: { dataset: { field: 'emotion', value: '温柔安慰' } } });
    p.preference({ currentTarget: { dataset: { field: 'closeness', value: '亲近' } } });
    await p.save(); expect((await m.api.call('companion.list')).roles).toHaveLength(0);
    p.agree(); await p.save(); const role = (await m.api.call('companion.list')).roles[0];
    expect(role).toMatchObject({ userAddress: '小林', habits: '少用反问', emotion: '温柔安慰', closeness: '亲近' });
    const edit = m.page('role-edit'); await edit.onLoad({ id: role.id }); expect(edit.data.userAddress).toBe('小林'); expect(edit.data.agreed).toBe(false);
  });
  it('saves a sourced typed fact as pending and resets source association for the next candidate', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const role = await m.api.call('companion.role.save', { name: '测试', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const doc = await m.api.call('companion.import', { roleId: role.id, title: '虚构', text: '我：你好\n对方：晴天', userSpeaker: '我', referenceSpeaker: '对方', authorized: true });
    const p = m.page('role-memory'); p.onLoad({ roleId: role.id, documentId: doc.id }); expect(p.data.subjectIndex).toBe(3);
    p.input({ detail: { value: '历史人物喜欢晴天' } }); p.input({ currentTarget: { dataset: { field: 'topic' } }, detail: { value: '天气喜好' } });
    p.pickDuration({ detail: { value: '2' } }); await p.save(); expect(p.data.items[0]).toMatchObject({ subject: 'reference', validFor: '7days', topic: '天气喜好', status: 'pending', documentId: doc.id });
    expect(p.data.documentId).toBe(''); expect(m.modals).toHaveLength(0); expect(p.data.items[0].conflict).toBe(false);
    p.edit({ currentTarget: { dataset: { id: p.data.items[0].id } } }); expect(p.data.subjectIndex).toBe(3); expect(p.data.documentId).toBe(doc.id);
  });
  it('does not auto-confirm a candidate or permit a UI conflict to silently replace a fact', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true }); await m.api.call('settings.update', { memoryEnabled: true });
    const role = await m.api.call('companion.role.save', { name: '测试', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const a = await m.api.call('companion.memory.save', { roleId: role.id, text: '喝咖啡', subject: 'user', topic: '咖啡', confirmed: false });
    const p = m.page('role-memory'); p.onLoad({ roleId: role.id }); await p.load(); p.confirm({ currentTarget: { dataset: { id: a.id } } });
    expect(m.modals).toHaveLength(1); expect((await m.api.call('companion.data', { id: role.id })).memories[0].status).toBe('pending');
    await m.modals[0].success({ confirm: false }); expect(p.data.items[0].status).toBe('pending');
    // This is only a mocked human callback, never a real consent action.
    p.confirm({ currentTarget: { dataset: { id: a.id } } }); await m.modals[1].success({ confirm: true });
    const b = await m.api.call('companion.memory.save', { roleId: role.id, text: '不喝咖啡', subject: 'user', topic: '咖啡', confirmed: false });
    await p.load(); p.confirm({ currentTarget: { dataset: { id: b.id } } }); expect(p.data.error).toContain('同一主体'); expect(m.modals).toHaveLength(2);
  });
  it('displays import quality without discarding repeated messages or writing confirmed facts', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const role = await m.api.call('companion.role.save', { name: '测试', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const doc = await m.api.call('companion.import', { roleId: role.id, title: '重复示例', text: '我：你好\n对方：你好\n对方：你好', userSpeaker: '我', referenceSpeaker: '对方', authorized: true });
    const p = m.page('source'); await p.onLoad({ id: doc.id }); expect(p.data).toMatchObject({ turnCount: 3, userCount: 1, referenceCount: 2, duplicateCount: 1 });
    expect((await m.api.call('companion.data', { id: role.id })).memories).toEqual([]);
  });
  it('creates a companion role, opts into chat saving, sends and copies a direct simulated reply', async () => {
    const m = mini(), role = m.page('role-edit'); role.data.name = '小屿'; role.data.agreed = true; await role.save();
    const roles = await m.api.call('companion.list'); expect(roles.roles).toHaveLength(1);
    const c = await m.api.call('companion.conversation.create', { roleId: roles.roles[0].id });
    const chat = m.page('chat'); chat.onLoad({ id: c.id }); await chat.onShow();
    expect(chat.data.bootstrap.settings.historyEnabled).toBe(false); chat.agree(); chat.agreeSave(); await chat.enable();
    chat.input({ detail: { value: '你好' } }); await chat.send();
    expect(chat.data.messages).toHaveLength(2); expect(chat.data.messages[1].text).toBe('嗨，我在呢。今天过得还好吗？');
    expect(chat.data.messages[1].mode).toBe('demo'); expect(chat.data.messages[1].text).not.toMatch(/我是|AI|模拟模板/);
    expect(chat.data.requestId).toBe(''); expect(chat.data.pendingText).toBe('');
    chat.copy({ currentTarget: { dataset: { id: chat.data.messages[1].id } } }); expect(m.clipboards[0]).toContain('【AI生成·模拟模板】');
    const list = m.page('chats'); await list.onShow(); expect(list.data.items[0].name).toBe('小屿');
  });
  it('previews an import before separate confirmation and keeps its memories pending', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const r = await m.api.call('companion.role.save', { name: '测试伙伴', relationship: 'friend', personality: '理性坦诚', description: '', boundaries: '' });
    const p = m.page('import'); p.onLoad({ roleId: r.id }); p.example(); p.preview(); expect(p.data.step).toBe(1);
    await p.save(); expect((await m.api.call('companion.data', { id: r.id })).documents).toHaveLength(0);
    p.confirmStep(); p.authorize(); await p.save(); expect((await m.api.call('companion.data', { id: r.id })).documents).toHaveLength(1);
    const memory = m.page('role-memory'); memory.onLoad({ roleId: r.id }); memory.input({ detail: { value: '我喜欢短句' } }); await memory.save();
    expect(memory.data.items[0].status).toBe('pending');
  });
  it('validates speaker mapping without persisting invalid import content', async () => {
    const m = mini(), p = m.page('import'); p.data.title = '混乱导出'; p.data.text = '张三：你好\n李四：你好'; p.preview();
    expect(p.data.step).toBe(1); expect(p.data.pendingCount).toBe(2); p.confirmStep(); expect(p.data.step).toBe(1);
    expect(p.data.error).toContain('待处理'); expect(m.cloudRequests).toHaveLength(0);
  });
  it('starts with saving off and requires an explicit consent action', async () => {
    const m = mini(); const p = m.page('compose'); await p.onShow();
    expect(p.data.bootstrap.mode).toBe('demo'); expect(p.data.bootstrap.settings.historyEnabled).toBe(false);
    p.example({ currentTarget: { dataset: { key: 'late' } } }); await p.generate();
    expect(p.data.result).toBeNull(); expect(p.data.error).toContain('同意');
  });
  it('generates labelled demo suggestions, edits and copies a single result', async () => {
    const m = mini(); const p = m.page('compose'); await p.onShow(); p.toggleConsent();
    p.example({ currentTarget: { dataset: { key: 'late' } } }); await p.generate();
    expect(p.data.result.replies).toHaveLength(3); expect(p.data.result.warnings[0]).toContain('模板演示');
    const event = { currentTarget: { dataset: { index: 0 } } };
    p.edit(event); p.onEdit({ detail: { value: '我想先听听你的看法。' } }); p.saveEdit(); await p.copy(event);
    expect(m.clipboards[0]).toBe('【AI生成】\n我想先听听你的看法。'); expect(p.data.copiedId).toBe('r1');
  });
  it('stores history only after opt-in and renders selected profile / confirmed memory', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    await m.api.call('settings.update', { historyEnabled: true, memoryEnabled: true });
    const profile = m.page('profile'); profile.input({ currentTarget: { dataset: { field: 'alias' } }, detail: { value: '朋友A' } });
    await profile.save(); expect(profile.data.items).toHaveLength(1);
    const memory = m.page('memory'); memory.onLoad({ profileId: profile.data.items[0].id }); await memory.load();
    memory.input({ detail: { value: '我不喝咖啡。' } }); memory.confirm(); await memory.save(); expect(memory.data.items[0].text).toBe('我不喝咖啡。');
    const compose = m.page('compose'); await compose.onShow(); compose.example({ currentTarget: { dataset: { key: 'late' } } }); await compose.generate();
    const history = m.page('history'); await history.load(); expect(history.data.items).toHaveLength(1);
    history.copy({ currentTarget: { dataset: { id: history.data.items[0].id, index: 0 } } }); expect(m.clipboards[0]).toMatch(/^【AI生成】/);
  });
  it('uses an explicit refusal fixture for the curated refusal example without inventing an excuse', async () => {
    const m = mini(); const p = m.page('compose'); await p.onShow(); p.toggleConsent();
    p.example({ currentTarget: { dataset: { key: 'refuse' } } }); await p.generate();
    expect(p.data.result.replies).toHaveLength(3);
    for (const r of p.data.result.replies) {
      expect(r.text).toMatch(/不参加|不想参加|不去了/);
      expect(r.text).not.toMatch(/生病|加班|有约|没时间/);
    }
    expect(p.data.result.warnings[0]).toContain('不是真实模型');
  });
});

describe('import cleaning page workflow (wx mocked)', () => {
  it('cleans desktop wrappers locally and sends exactly the redacted preview only after confirmation', async () => {
    const m = mini(request => ({ id: 'doc' })), p = m.page('import'); m.api.setMode('cloud');
    p.data.title = '测试资料'; p.data.userSpeaker = '用户'; p.data.referenceSpeaker = '女朋友'; p.applyText(feedingFixture); p.preview();
    expect(p.data.turnCount).toBe(4); expect(p.data.metadataCount).toBeGreaterThan(0); expect(p.data.pendingCount).toBe(0);
    expect(m.cloudRequests).toHaveLength(0); await p.save(); expect(m.cloudRequests).toHaveLength(0);
    p.confirmStep(); await p.save(); expect(m.cloudRequests).toHaveLength(0);
    p.authorize(); const preview = JSON.parse(JSON.stringify(p.reviewedTurns)); await p.save();
    expect(m.cloudRequests).toHaveLength(1); const payload = m.cloudRequests[0].data.payload;
    expect(payload.text).toBe(preview.map((v: any) => `${v.speaker === 'user' ? '0' : '1'}:${v.text}`).join('\n'));
    expect(payload.text).not.toMatch(/用途|数据统计|示例/); expect(p.analysis).toBeNull();
  });
  it('exposes every unknown row, requires resolution and can undo manual exclusion', () => {
    const m = mini(), p = m.page('import'); p.data.title = '测试'; p.applyText('未知标题\n我：你好\n对方：你好'); p.preview();
    expect(p.data.pendingCount).toBe(1); p.confirmStep(); expect(p.data.step).toBe(1);
    p.selectKind({ currentTarget: { dataset: { kind: 'issues' } } }); expect(p.data.previewRows[0].line).toBe(1);
    p.resolve({ currentTarget: { dataset: { index: 0, action: 'exclude' } } }); expect(p.data.pendingCount).toBe(0);
    p.selectKind({ currentTarget: { dataset: { kind: 'removed' } } }); expect(p.data.previewRows[0].text).toBe('未知标题');
    p.resetCleaning(); expect(p.data.pendingCount).toBe(1); expect(p.data.authorized).toBe(false);
  });
  it('maps aliases only after explicit selection and invalidates an old preview on conflicting mappings', () => {
    const m = mini(), p = m.page('import'); p.data.title = '测试'; p.applyText('用户：一\n女朋友：二'); p.preview();
    expect(p.data.pendingCount).toBe(2);
    p.setSpeaker({ currentTarget: { dataset: { name: '用户', side: 'userSpeaker' } } }); expect(p.data.pendingCount).toBe(1);
    p.setSpeaker({ currentTarget: { dataset: { name: '女朋友', side: 'referenceSpeaker' } } }); expect(p.data.pendingCount).toBe(0);
    p.setSpeaker({ currentTarget: { dataset: { name: '用户', side: 'referenceSpeaker' } } }); p.confirmStep();
    expect(p.data.step).toBe(1); expect(p.analysis).toBeNull(); expect(p.reviewedTurns).toHaveLength(0);
  });
  it('keeps a large unknown body in page memory while paginating its complete redacted preview', () => {
    const m = mini(), p = m.page('import'); p.data.title = '测试'; p.applyText('未知：' + '长'.repeat(100000) + '\n我：一\n对方：二'); p.preview();
    p.selectKind({ currentTarget: { dataset: { kind: 'issues' } } });
    expect(p.data.previewRows).toHaveLength(20); expect(Buffer.byteLength(JSON.stringify(p.data))).toBeLessThan(100000);
    p.showPreview(p.data.previewPages); expect(p.data.previewRows).not.toHaveLength(0);
    p.onUnload(); expect(p.analysis).toBeNull(); expect(p.resolutions).toHaveLength(0);
  });
});

describe('cloud-first routing and safe local-space upgrade', () => {
  const modeKey = 'communication-assistant.v0.1.mode', localKey = 'communication-assistant.v0.1.demo';
  it('defaults a fresh installation to cloud without inventing a local reply or accepting consent', async () => {
    const m = mini(() => ({ ...cloudBoot, accepted: false })); m.storage.delete(modeKey);
    expect(m.api.getMode()).toBe('cloud'); await m.api.call('session.bootstrap');
    expect(m.cloudRequests.map(r => r.data.action)).toEqual(['session.bootstrap']); expect(m.storage.has(localKey)).toBe(false);
  });
  it('preserves a legacy local installation without silently hiding or uploading its data', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const before = JSON.stringify([...m.storage]); m.storage.delete(modeKey);
    expect(m.api.getMode()).toBe('demo'); expect(m.cloudRequests).toHaveLength(0);
    expect([...m.storage.keys()].some(k => k === localKey)).toBe(true);
    m.api.setMode('cloud'); expect(m.api.getMode()).toBe('cloud'); expect(JSON.stringify([...m.storage])).toContain(localKey);
    expect(before).toContain(localKey);
  });
  it('switches only after the human confirmation callback and never migrates local content', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const saved = JSON.stringify(m.storage.get(localKey)); m.api.requestModeSwitch('cloud');
    expect(m.api.getMode()).toBe('demo'); expect(m.modals[0].content).toContain('不会自动搬到云端');
    m.modals[0].success({ confirm: false }); expect(m.api.getMode()).toBe('demo');
    m.api.requestModeSwitch('cloud'); m.modals[1].success({ confirm: true });
    expect(m.api.getMode()).toBe('cloud'); expect(JSON.stringify(m.storage.get(localKey))).toBe(saved); expect(m.cloudRequests).toHaveLength(0);
  });
  it('shows a cloud failure as cloud, without displaying a misleading local-mode status', async () => {
    const m = mini(() => { throw new Error('MOCK_NETWORK_FAILURE'); }); m.api.setMode('cloud');
    const p = m.page('chats'); await p.onShow(); expect(p.data.mode).toBe('cloud'); expect(p.data.error).not.toBe('');
    expect(p.data.bootstrap).toBeNull(); expect(m.api.getMode()).toBe('cloud'); expect(m.storage.has(localKey)).toBe(false);
  });
  it('never sends a local conversation ID to the cloud after an in-place mode change', async () => {
    const m = mini(); const p = m.page('chat'); p.onLoad({ id: 'local-conversation', mode: 'demo' });
    m.api.setMode('cloud'); await p.onShow(); expect(p.data.loadError).toContain('运行模式已切换');
    p.input({ detail: { value: '不能发送' } }); await p.send(); expect(m.cloudRequests).toHaveLength(0);
  });
  it('keeps the original request/draft on model failure and never substitutes a demo answer', async () => {
    const m = mini(request => { if (request.data.action === 'companion.send') throw new Error('MOCK_UNCERTAIN_NETWORK');
      return request.data.action === 'session.bootstrap' ? cloudBoot : cloudDetail; });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'cloud-conversation', mode: 'cloud' }); await p.onShow();
    p.input({ detail: { value: '你是什么人' } }); await p.send();
    expect(p.data.messages).toHaveLength(0); expect(p.data.text).toBe('你是什么人'); expect(p.data.requestId).not.toBe('');
    expect(m.cloudRequests.filter(r => r.data.action === 'companion.send')).toHaveLength(1);
    expect(m.api.getMode()).toBe('cloud'); expect(m.storage.has(localKey)).toBe(false);
  });
  it('keeps historical demo messages intact and collapses misleading source blocks by default', async () => {
    const message = { id: 'old-message', speaker: 'assistant', mode: 'demo', text: '旧模板，保留原样', sources: [{ documentId: 'd', title: '旧资料', turn: 3 }] };
    const m = mini(request => request.data.action === 'session.bootstrap' ? cloudBoot : { ...cloudDetail,
      conversation: { ...cloudDetail.conversation, messages: [message] } });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'cloud-conversation' }); await p.onShow();
    expect(p.data.messages[0].text).toBe(message.text); expect(p.data.messages[0].referenceCaption).toContain('未送入模型');
    expect(p.data.expandedSources).toEqual({}); p.toggleSources({ currentTarget: { dataset: { id: 'old-message' } } });
    expect(p.data.expandedSources['old-message']).toBe(true); expect(message.text).toBe('旧模板，保留原样');
    expect(readFileSync('src/miniprogram/pages/chat/index.wxml', 'utf8')).not.toContain('送入模型的参考：');
  });
  it('replaces message arrays when reloading rather than duplicating rendered messages', async () => {
    const m = mini(request => request.data.action === 'session.bootstrap' ? cloudBoot : { ...cloudDetail,
      conversation: { ...cloudDetail.conversation, messages: [{ id: 'once', speaker: 'assistant', mode: 'cloud', text: '唯一回复' }] } });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'cloud-conversation' });
    await p.onShow(); await p.load(); await p.load(); expect(p.data.messages).toHaveLength(1);
  });
});

describe('screenshot review page (native image and cloud boundaries mocked)', () => {
  const output = { overflow: false, messages: [
    { side: 'right', text: '今天好累', kind: 'text', uncertain: false },
    { side: 'left', text: '先休息吧', kind: 'text', uncertain: false } ] };
  const event = (data: unknown) => ({ currentTarget: { dataset: data } });
  it('locally tiles a long screenshot before any upload and requires separate upload authorization', async () => {
    const m = mini(() => output, undefined, undefined, { width: 1260, height: 9998, tiles: ['a', 'b', 'c'] }), p = m.page('screenshot');
    p.onLoad({ roleId: 'r' }); await p.chooseImage(); expect(p.data.tileCount).toBe(3); expect(p.tiles).toEqual(['a', 'b', 'c']);
    expect(p.data.uploadAuthorized).toBe(false); expect(m.cloudRequests).toHaveLength(0); await p.recognize(); expect(m.cloudRequests).toHaveLength(0);
    expect(p.data.error).toContain('授权');
  });
  it('never replaces real OCR with simulated text in local mode', async () => {
    const m = mini(), p = m.page('screenshot'); p.tiles = ['image']; p.data.uploadAuthorized = true;
    await p.recognize(); expect(p.data.error).toContain('本地模拟'); expect(m.cloudRequests).toHaveLength(0); expect(p.messages).toHaveLength(0);
  });
  it('retains successful tiles on a partial failure and retries only the failed tile on a new user action', async () => {
    let attempts = 0;
    const m = mini(() => { attempts++; if (attempts === 2) throw new Error('test failure'); return output; }), p = m.page('screenshot');
    m.api.setMode('cloud'); p.tiles = ['tile1', 'tile2', 'tile3']; p.requestIds = ['request_first_001', 'request_first_002', 'request_first_003'];
    p.data.tileCount = 3; p.data.uploadAuthorized = true; await p.recognize();
    expect(p.data.completed).toBe(1); expect(p.messages).toHaveLength(2); expect(p.data.recognized).toBe(false); expect(p.data.busy).toBe(false);
    p.requestIds[1] = 'manual_retry_002'; await p.recognize();
    expect(m.cloudRequests.map(r => r.data.payload.image)).toEqual(['tile1', 'tile2', 'tile2', 'tile3']);
    expect(p.data.completed).toBe(3); expect(p.messages).toHaveLength(6); expect(p.data.recognized).toBe(true);
  });
  it('requires manual result review, supports side switching and returns text to the parent without saving', async () => {
    const m = mini(() => output), p = m.page('screenshot'); m.api.setMode('cloud');
    p.tiles = ['image']; p.requestIds = ['request_first_001']; p.data.tileCount = 1; p.data.uploadAuthorized = true; await p.recognize();
    p.append(); expect(m.events).toHaveLength(0); p.review(); p.append(); expect(m.events).toHaveLength(1);
    expect(m.events[0].data.turns).toEqual([{ speaker: 'user', text: '今天好累' }, { speaker: 'reference', text: '先休息吧' }]);
    expect(m.cloudRequests.map(r => r.data.action)).toEqual(['screenshot.recognize']);
    p.userSide(event({ side: 'left' })); expect(p.data.reviewed).toBe(false);
  });
  it('allows correction and exclusion but blocks unresolved unknown or non-text content', () => {
    const m = mini(), p = m.page('screenshot'); p.data.recognized = true;
    p.messages = [{ side: 'unknown', text: '[图片]', kind: 'nontext', uncertain: true, tile: 1, excluded: false }]; p.showPage(1); p.review(); p.append();
    expect(m.events).toHaveLength(0); p.side(event({ index: 0, side: 'left' })); p.edit({ ...event({ index: 0 }), detail: { value: '我手动核实的文字' } });
    p.review(); p.append(); expect(m.events[0].data.turns[0].text).toBe('我手动核实的文字');
    p.exclude(event({ index: 0 })); expect(p.data.reviewed).toBe(false); expect(p.messages[0].excluded).toBe(true);
  });
  it('discards in-flight results when the page is closed without persisting screenshot data', async () => {
    let release!: () => void; const m = mini(async () => { await new Promise<void>(r => release = r); return output; }), p = m.page('screenshot');
    m.api.setMode('cloud'); p.tiles = ['image']; p.requestIds = ['request_first_001']; p.data.uploadAuthorized = true;
    const pending = p.recognize(); p.onUnload(); release(); await pending;
    expect(p.messages).toHaveLength(0); expect(p.tiles).toHaveLength(0); expect(m.events).toHaveLength(0);
  });
  it('appends only reviewed text to existing import text using configured speaker labels and invalidates authorization', () => {
    const m = mini(), p = m.page('import'); p.data.title = '原资料'; p.data.userSpeaker = '用户'; p.data.referenceSpeaker = '女朋友';
    p.applyText('用户：原问句\n女朋友：原回复'); p.data.authorized = true; p.screenshot();
    const nav = m.navigations[0]; expect(nav.url).toContain('/pages/screenshot/index');
    nav.events.screenshotText({ turns: [{ speaker: 'user', text: '识别问句' }, { speaker: 'reference', text: '识别回复' }] });
    expect(p.rawText).toBe('用户：原问句\n女朋友：原回复\n用户：识别问句\n女朋友：识别回复'); expect(p.data.authorized).toBe(false);
    expect(m.cloudRequests).toHaveLength(0); p.preview(); expect(p.data.turnCount).toBe(4);
  });
  it('keeps OCR review available when the parent rejects invalid labels instead of closing and losing text', () => {
    const m = mini(), p = m.page('import'); p.data.userSpeaker = '相同'; p.data.referenceSpeaker = '相同'; p.applyText('原资料'); p.screenshot();
    m.navigations[0].events.screenshotText({ turns: [{ speaker: 'user', text: '需保留的OCR文字' }] });
    expect(m.events[0]).toMatchObject({ name: 'screenshotResult', data: { ok: false } }); expect(p.rawText).toBe('原资料');
  });
  it('applies a local one-minute backoff on provider congestion without auto-retry or changing model', async () => {
    const m = mini(), p = m.page('screenshot'); m.api.setMode('cloud'); p.tiles = ['image']; p.requestIds = ['request_busy_001'];
    p.data.retryAfter = Date.now() + 60000; p.retry(); expect(m.cloudRequests).toHaveLength(0); expect(p.data.error).toContain('一分钟');
  });
});

describe('model access status UI (wx/cloud mocked)', () => {
  const testId = 'a'.repeat(64);
  const bootstrap = { enabled: false, accepted: true, settings: { historyEnabled: true, memoryEnabled: false },
    mode: 'cloud', contentReview: { mode: 'internal-test', eligible: false, testUserId: testId } };
  it('copies only the current account access identifier on an explicit tap without granting access', async () => {
    const m = mini(() => bootstrap); m.api.setMode('cloud'); const p = m.page('settings'); await p.refresh();
    p.copyTestId(); expect(m.clipboards).toEqual([testId]);
    expect(m.cloudRequests.map(r => r.data.action)).toEqual(['session.bootstrap']);
    expect(p.data.bootstrap.enabled).toBe(false);
  });
  it('preserves the draft and does not send when cloud generation is unavailable', async () => {
    const m = mini(request => request.data.action === 'session.bootstrap' ? bootstrap : {
      conversation: { messages: [] }, role: { name: '朋友' }, jobs: [] });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'conversation-test' }); await p.onShow();
    p.input({ detail: { value: '你好' } }); await p.send();
    expect(p.data.text).toBe('你好'); expect(p.data.pendingText).toBe(''); expect(p.data.requestId).toBe('');
    expect(m.cloudRequests.some(r => r.data.action === 'companion.send')).toBe(false);
    expect(m.toasts.at(-1)).toContain('访问权限');
  });
  it('does not show an internal-test banner in the chat interface but retains AI identity and privacy details', () => {
    for (const name of ['chat', 'chats']) {
      const wxml = readFileSync(`src/miniprogram/pages/${name}/index.wxml`, 'utf8');
      expect(wxml).not.toMatch(/内部测试|受限内部|chat-test-notice/);
      expect(wxml).toContain('AI');
    }
    expect(readFileSync('src/miniprogram/pages/legal/index.wxml', 'utf8')).toContain('当前未接入第三方内容审核接口');
  });
  it('still queries the original request after model shutdown instead of locking an uncertain result', async () => {
    const m = mini(request => request.data.action === 'session.bootstrap' ? bootstrap : request.data.action === 'companion.send'
      ? { job: { status: 'SUCCEEDED' } } : { conversation: { messages: [] }, role: { name: '朋友' }, jobs: [] });
    m.api.setMode('cloud'); const p = m.page('chat'); p.onLoad({ id: 'conversation-test' }); await p.onShow();
    p.setData({ text: '你好', pendingText: '你好', requestId: 'original_request_001' }); await p.query();
    expect(m.cloudRequests.filter(r => r.data.action === 'companion.send').map(r => r.data.clientRequestId)).toEqual(['original_request_001']);
    expect(p.data.pendingText).toBe(''); expect(p.data.requestId).toBe('');
  });
});

describe('cloud page loading avoids same-user transaction contention (transport mocked)', () => {
  const boot = { enabled: true, accepted: true, mode: 'cloud', settings: { historyEnabled: false, memoryEnabled: false } };
  const detail = { conversation: { messages: [] }, role: { name: '测试朋友' }, jobs: [] };
  function contentionTransport(failFirst = false) {
    let active = false, peak = 0, count = 0;
    return { peak: () => peak, respond: async (request: any) => {
      if (active) { peak = 2; throw new Error('MOCK_SAME_DOCUMENT_CONFLICT'); }
      active = true; peak = Math.max(peak, 1); const index = ++count;
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (failFirst && index === 1) throw new Error('MOCK_TRANSIENT_LOAD_FAILURE');
        return request.data.action === 'session.bootstrap' ? boot : request.data.action === 'companion.list'
          ? { roles: [{ id: 'role-one', name: '测试朋友' }], conversations: [] } : detail;
      } finally { active = false; }
    } };
  }
  it('loads chat bootstrap then detail sequentially and shows the missing save opt-in', async () => {
    const transport = contentionTransport(), m = mini(transport.respond); m.api.setMode('cloud');
    const p = m.page('chat'); p.onLoad({ id: 'conversation-one' }); await p.onShow();
    expect(p.data.role.name).toBe('测试朋友'); expect(p.data.bootstrap.settings.historyEnabled).toBe(false);
    expect(p.data.loadError).toBe(''); expect(p.data.loading).toBe(false); expect(transport.peak()).toBe(1);
    expect(m.cloudRequests.map(r => r.data.action)).toEqual(['session.bootstrap', 'companion.conversation.get']);
  });
  it('loads the conversation list sequentially instead of conflicting with bootstrap', async () => {
    const transport = contentionTransport(), m = mini(transport.respond); m.api.setMode('cloud');
    const p = m.page('chats'); await p.onShow();
    expect(p.data.error).toBe(''); expect(p.data.loading).toBe(false); expect(transport.peak()).toBe(1);
    expect(m.cloudRequests.map(r => r.data.action)).toEqual(['session.bootstrap', 'companion.list']);
  });
  it('coalesces repeated lifecycle/manual loads rather than opening a second pair of transactions', async () => {
    for (const name of ['chat', 'chats']) {
      const transport = contentionTransport(), m = mini(transport.respond); m.api.setMode('cloud'); const p = m.page(name);
      if (name === 'chat') p.onLoad({ id: 'conversation-one' });
      await Promise.all([p.onShow(), p.load(), p.load()]);
      expect(transport.peak()).toBe(1); expect(m.cloudRequests).toHaveLength(2); expect(p.data.loading).toBe(false);
    }
  });
  it('clears a recovered load failure but preserves the draft and separate generation error', async () => {
    const transport = contentionTransport(true), m = mini(transport.respond); m.api.setMode('cloud');
    const p = m.page('chat'); p.onLoad({ id: 'conversation-one' }); p.input({ detail: { value: '你好' } });
    await p.onShow(); expect(p.data.loadError).not.toBe('');
    p.setData({ error: 'GENERATION_ERROR_TO_PRESERVE' }); await p.load();
    expect(p.data.loadError).toBe(''); expect(p.data.error).toBe('GENERATION_ERROR_TO_PRESERVE'); expect(p.data.text).toBe('你好');
    expect(m.cloudRequests.some(r => r.data.action === 'companion.send')).toBe(false);
  });
  it('does not populate a page after it has been unloaded', async () => {
    const transport = contentionTransport(), m = mini(transport.respond); m.api.setMode('cloud');
    const p = m.page('chat'); p.onLoad({ id: 'conversation-one' }); const pending = p.onShow(); p.onUnload(); await pending;
    expect(p.data.role).toBeNull(); expect(m.cloudRequests.map(r => r.data.action)).toEqual(['session.bootstrap']);
  });
});

describe('TXT 1 MiB with no character limit (file picker mocked)', () => {
  it('accepts file metadata exactly at 1 MiB and previews the complete 20000-character content', () => {
    const text = importText(20000), m = mini(undefined, { size: 1024 * 1024, text }), p = m.page('import');
    p.chooseFile(); expect(m.fileReads()).toBe(1); expect(p.rawText).toBe(text); expect(p.data.limits.fileBytes).toBe(1048576);
    p.preview(); expect(p.data.step).toBe(1); expect(p.reviewedTurns).toHaveLength(50); expect(p.data.error).toBe('');
  });
  it('rejects a file one byte over 1 MiB before reading and preserves the existing draft', () => {
    const m = mini(undefined, { size: 1024 * 1024 + 1, text: importText(20000) }), p = m.page('import');
    p.data.text = '原草稿'; p.chooseFile(); expect(m.fileReads()).toBe(0); expect(p.data.text).toBe('原草稿');
    expect(m.toasts.at(-1)).toContain('1MB');
  });
  it('accepts a file with 20001 characters when its bytes are below the file cap', () => {
    const text = importText(20001), m = mini(undefined, { size: Buffer.byteLength(text), text }), p = m.page('import');
    p.chooseFile(); expect(p.rawText).toBe(text); expect(p.data.textCharacters).toBe(20001); p.preview(); expect(p.data.step).toBe(1);
  });
  it('accepts UTF-8 BOM without counting it as a text character', () => {
    const text = '\uFEFF' + importText(20000), m = mini(undefined, { size: Buffer.byteLength(text), text }), p = m.page('import');
    p.chooseFile(); expect(p.rawText.length).toBe(20000); p.preview(); expect(p.data.step).toBe(1);
  });
  it('accepts pasted text above 20000 and removes the native textarea maxlength cap', () => {
    const m = mini(), p = m.page('import'); p.data.title = '合成资料';
    p.input({ currentTarget: { dataset: { field: 'text' } }, detail: { value: importText(20001) } }); p.preview();
    expect(p.data.step).toBe(1); expect(p.data.error).toBe(''); expect(p.data.limits).not.toHaveProperty('characters');
    expect(readFileSync('src/miniprogram/pages/import/index.wxml', 'utf8')).toContain('maxlength="-1"');
  });
  it('paginates a long single message without dropping text or passing giant data into the view', () => {
    const text = '我：' + '长'.repeat(100000) + '\n对方：尾', m = mini(undefined, { size: Buffer.byteLength(text), text }), p = m.page('import');
    p.chooseFile(); p.preview(); expect(p.data.largeTextLoaded).toBe(true); expect(p.rawText).toBe(text);
    expect(p.data.previewRows.length).toBeLessThanOrEqual(20); expect(Buffer.byteLength(JSON.stringify(p.data))).toBeLessThan(100000);
    p.showPreview(p.data.previewPages); expect(p.data.previewRows.at(-1).text).toBe('尾');
    expect(p.reviewedTurns[0].text).toBe('长'.repeat(100000)); p.onUnload(); expect(p.rawText).toBe(''); expect(p.reviewedTurns).toEqual([]);
  });
  it('shows saved reference documents in bounded pages, with complete data still accessible', async () => {
    const document = { id: 'doc', roleId: 'r', title: '合成资料', expiresAt: Date.now() + 10000, turns: [{ speaker: 'user', text: '长'.repeat(100000) }, { speaker: 'reference', text: '末尾' }] };
    const m = mini(() => document); m.api.setMode('cloud'); const p = m.page('source'); await p.onLoad({ id: 'doc' });
    expect(p.data.document).not.toHaveProperty('turns'); expect(p.data.turnCount).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(p.data))).toBeLessThan(100000); p.showPreview(p.data.previewPages);
    expect(p.data.previewRows.at(-1).text).toBe('末尾');
  });
});

describe('large local reference persistence (storage API mocked)', () => {
  it('stores and reloads a 1 MiB reference while each storage value stays below 1 MiB', async () => {
    let maxBytes = 0;
    const m = mini(undefined, undefined, (_key, value) => { const size = Buffer.byteLength(JSON.stringify(value)); maxBytes = Math.max(maxBytes, size); if (size > 1024 * 1024) throw new Error('MOCK_PER_KEY_QUOTA'); });
    await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const role = await m.api.call('companion.role.save', { name: '合成角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const prefix = '我：', suffix = '\n对方：尾', text = prefix + 'x'.repeat(1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
    const doc = await m.api.call('companion.import', { roleId: role.id, title: '合成资料', text, userSpeaker: '我', referenceSpeaker: '对方', authorized: true });
    expect((await m.api.call('companion.document.get', { id: doc.id })).turns[0].text.length).toBe(text.length - prefix.length - suffix.length);
    expect(maxBytes).toBeLessThan(1024 * 1024); m.api.resetDemo(); expect([...m.storage.keys()].some(k => k.includes('.part.'))).toBe(false);
  }, 10000);
  it('keeps the committed snapshot when writing a replacement chunk fails', async () => {
    let fail = false;
    const m = mini(undefined, undefined, key => { if (fail && key.includes('.part.')) throw new Error('MOCK_FULL_DISK'); });
    await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const role = await m.api.call('companion.role.save', { name: '必须保留', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    fail = true; await expect(m.api.call('settings.update', { historyEnabled: true })).rejects.toBeDefined(); fail = false;
    expect((await m.api.call('companion.list')).roles[0].id).toBe(role.id);
    expect((await m.api.call('session.bootstrap')).settings.historyEnabled).toBe(false);
  });
  it('migrates legacy unchunked demo state without deleting existing roles', async () => {
    const m = mini(); await m.api.call('consent.update', { version: POLICY_VERSION, accepted: true });
    const role = await m.api.call('companion.role.save', { name: '旧角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
    const key = 'communication-assistant.v0.1.demo', index = m.storage.get(key) as any;
    const state = JSON.parse(index.keys.map((k: string) => m.storage.get(k)).join('')); for (const k of index.keys) m.storage.delete(k); m.storage.set(key, state);
    expect((await m.api.call('companion.list')).roles[0].id).toBe(role.id);
    expect(m.storage.get(key)).toMatchObject({ format: 'chunks-v1' });
  });
});
