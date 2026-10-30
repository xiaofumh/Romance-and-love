import { createService } from '../../server/service';
import { freshState, maintain, clone, MemoryBudget } from '../../server/state';
import type { StateRepository, UserState } from '../../server/state';
import { demoOutput } from '../../shared/demo-provider';
import { companionDemoText } from '../../shared/companion-demo';
import type { ApiResult, Envelope } from '../../shared/contracts';
import { config } from '../config';

const STORAGE_KEY = 'communication-assistant.v0.1.demo';
const MODE_KEY = 'communication-assistant.v0.1.mode';
let serial = 0;
let listRevision = 0, listReset = 0;
export function getListSignal() { return { revision: listRevision, reset: listReset }; }
const listMutation = /^(?:companion\.(?:send|initiative|role\.save|conversation\.(?:create|configure)|delete|clear|import|memory\.save)|consent\.update|settings\.update|account\.delete)$/;
const listPrivateReset = /^(?:companion\.(?:delete|clear)|consent\.update|settings\.update|account\.delete)$/;
export function uniqueId(): string { return `${Date.now().toString(36)}_${(++serial).toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function localHash(text: string): string {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
type ChunkIndex = { format: 'chunks-v1'; keys: string[] };
function chunkIndex(value: unknown): ChunkIndex | undefined {
  const v = value as Partial<ChunkIndex> | undefined;
  return v?.format === 'chunks-v1' && Array.isArray(v.keys) && v.keys.length <= 64 && v.keys.every(k => typeof k === 'string' && k.startsWith(STORAGE_KEY + '.part.'))
    ? v as ChunkIndex : undefined;
}
function readLocalState(): UserState | undefined {
  const saved = wx.getStorageSync(STORAGE_KEY), index = chunkIndex(saved);
  if (saved?.format === 'chunks-v1' && !index) throw new Error('本地资料索引损坏，请勿覆盖；可联系维护者恢复');
  if (!index) return saved || undefined;
  const chunks = index.keys.map(key => wx.getStorageSync(key));
  if (chunks.some(v => typeof v !== 'string')) throw new Error('本地资料缓存不完整，请勿覆盖；可联系维护者恢复');
  try { return JSON.parse(chunks.join('')) as UserState; }
  catch { throw new Error('本地资料缓存格式异常，请勿覆盖；可联系维护者恢复'); }
}
function writeLocalState(state: UserState): void {
  const previous = chunkIndex(wx.getStorageSync(STORAGE_KEY)), text = JSON.stringify(state), keys: string[] = [];
  if (text.length > 64 * 128 * 1024) throw new Error('本机演示存储空间不足，旧数据保留，请先导出；云端聊天使用独立归档');
  try {
    // Commit the small index last; on a storage failure retain the prior snapshot.
    const generation = uniqueId();
    for (let i = 0; i < text.length; i += 128 * 1024) {
      const key = `${STORAGE_KEY}.part.${generation}.${keys.length}`; keys.push(key);
      wx.setStorageSync(key, text.slice(i, i + 128 * 1024));
    }
    wx.setStorageSync(STORAGE_KEY, { format: 'chunks-v1', keys } satisfies ChunkIndex);
  } catch {
    for (const key of keys) { try { wx.removeStorageSync(key); } catch { /* Preserve the original failure. */ } }
    throw new Error('本地存储空间不足或保存失败，旧数据保留，请先导出并清理');
  }
  for (const key of previous?.keys ?? []) { try { wx.removeStorageSync(key); } catch { /* Committed snapshot remains valid. */ } }
}
class LocalRepository implements StateRepository {
  private queue: Promise<unknown> = Promise.resolve();
  transact<T>(uid: string, now: number, operation: (s: UserState) => T): Promise<T> {
    const run = this.queue.then(() => {
      const saved = readLocalState();
      const state = saved?.id === uid ? clone(saved) : freshState(uid, now);
      maintain(state, now);
      const result = operation(state);
      writeLocalState(state);
      return clone(result);
    });
    this.queue = run.catch(() => undefined); return run;
  }
}
const demoService = createService({
  repository: new LocalRepository(), budget: new MemoryBudget(), enabled: true, mode: 'demo',
  id: uniqueId, hash: localHash,
  chatDailyLimit: 100, callLimit: 10000,
  provider: { name: '本地通用模板（非真实模型）', generate: async c => {
    await new Promise(resolve => setTimeout(resolve, 550));
    return { output: demoOutput(c, serial) };
  }, chat: async c => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return { output: { text: companionDemoText(c) } };
  } },
  moderator: { check: async () => true },
  operator: '本地开发演示，运营主体待填写', support: '正式发布前填写投诉渠道',
  onInternalError: error => {
    // Local development only; no input payload, database record or API secret is logged.
    console.error('[assistant:demo]', error instanceof Error ? error.name : 'UnknownError',
      error instanceof Error ? error.message : '本地模拟运行异常');
  },
});
export function getMode(): 'demo' | 'cloud' {
  const mode = wx.getStorageSync(MODE_KEY);
  if (mode === 'demo' || mode === 'cloud') return mode;
  // Existing installations may have never explicitly selected a mode. Keep
  // their local space visible; do not silently upload or hide it after upgrade.
  return wx.getStorageSync(STORAGE_KEY) ? 'demo' : config.defaultMode;
}
export function setMode(mode: 'demo' | 'cloud'): void {
  if (mode === 'cloud' && !config.cloudEnvId) throw new Error('请先在 src/miniprogram/config.ts 填写云开发环境 ID 并重新构建');
  if (mode !== getMode()) { listRevision++; listReset++; }
  wx.setStorageSync(MODE_KEY, mode);
}
export function requestModeSwitch(mode: 'demo' | 'cloud'): void {
  if (mode === getMode()) return;
  wx.showModal({ title: mode === 'cloud' ? '切换到真实AI聊天？' : '切换到本地演示？',
    content: mode === 'cloud'
      ? '切换后进入云端会话列表，聊天会调用GLM-4.7，可能计费，数据去向见使用与隐私说明。本地角色、聊天、资料保留，不会自动搬到云端；云端需要选择或创建角色。模型不可用时只报错，不回退到模拟回复。'
      : '本地仅固定模板，不调用真实模型。本地和云端角色、会话、资料分别保存，切换不删除或自动迁移数据。',
    confirmText: '确认切换', success: result => {
      if (!result.confirm) return;
      try { setMode(mode); wx.switchTab({ url: '/pages/chats/index' }); } catch(error) { toast(error); }
    } });
}
export class ClientError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
export async function call<T = unknown>(action: string, payload: unknown = {}, requestId?: string): Promise<T> {
  if (listMutation.test(action)) { listRevision++; if (listPrivateReset.test(action)) listReset++; }
  const event: Envelope = { action, payload, ...(requestId ? { clientRequestId: requestId } : {}) };
  let result: ApiResult<T>;
  if (getMode() === 'demo') result = await demoService.handle('local-demo-user', event) as ApiResult<T>;
  else {
    if (!config.cloudEnvId || !wx.cloud) throw new ClientError('CLOUD_NOT_CONFIGURED', '云开发尚未配置');
    try {
      const response = await wx.cloud.callFunction({ name: config.apiFunction, data: event, config: { env: config.cloudEnvId } });
      result = response.result as ApiResult<T>;
    } catch { throw new ClientError('NETWORK_ERROR', '连接失败，请检查网络；不要重复提交同一生成请求', true); }
  }
  if (!result || typeof result.ok !== 'boolean') throw new ClientError('INVALID_RESPONSE', '服务响应异常');
  if (!result.ok) throw new ClientError(result.error.code, result.error.message, result.error.retryable);
  if (listMutation.test(action)) listRevision++;
  return result.data;
}
export function toast(error: unknown): void { wx.showToast({ title: error instanceof Error ? error.message : '操作未完成，请重试', icon: 'none', duration: 3000 }); }
export function readableTime(time: number): string {
  const d = new Date(time); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function resetDemo(): void {
  const index = chunkIndex(wx.getStorageSync(STORAGE_KEY));
  wx.removeStorageSync(STORAGE_KEY);
  for (const key of index?.keys ?? []) wx.removeStorageSync(key);
}
