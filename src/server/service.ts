import { z } from 'zod';
import { GenerateSchema, OutputSchema, POLICY_VERSION } from '../shared/contracts';
import type { ApiResult, Bootstrap, ContentReviewStatus, Envelope, GenerateInput, GenerationView, Memory, ModelOutput, Profile } from '../shared/contracts';
import { AppError, fail } from './errors';
import { cancelPending, dateKey } from './state';
import type { CallBudget, Generation, StateRepository, UserState } from './state';
import { createCompanion, chatRemaining } from './companion';
import type { ChatContext } from './companion-prompt';
import { createScreenshot, type ScreenshotProvider } from './screenshot';
import { SCREENSHOT_LIMITS } from '../shared/screenshot';
import { chatDailyLimit } from './chat-quota';

export type ProviderContext = { input: GenerateInput; profile?: Profile; memories: Memory[] };
export interface Provider {
  name: string;
  generate(context: ProviderContext): Promise<{ output: unknown; usage?: { input: number; output: number } }>;
  chat?(context: ChatContext): Promise<{ output: unknown; usage?: { input: number; output: number };
    requestAudit?: { historySha256: string; historyMessages: number; protocol: string } }>;
}
export interface Moderator { check(text: string): Promise<boolean> }
export type ServiceOptions = {
  repository: StateRepository; budget: CallBudget; provider: Provider; moderator: Moderator;
  id: () => string; hash: (text: string) => string; now?: () => number;
  mode: 'demo' | 'cloud'; enabled: boolean; dailyLimit?: number; callLimit?: number;
  timeoutMs?: number; operator?: string; support?: string;
  chatDailyLimit?: number;
  internalTestChatDailyLimit?: number;
  screenshotProvider?: ScreenshotProvider;
  assertGenerationAccess?: (uid: string) => void;
  contentReview?: (uid: string) => ContentReviewStatus;
  onInternalError?: (error: unknown) => void;
};
const Id = z.string().min(1).max(100);
const objectId = z.object({ id: Id }).strict();
const EnvelopeSchema = z.object({ action: z.string().min(1).max(50),
  clientRequestId: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(), payload: z.unknown().optional() }).strict();
const ProfileSchema = z.object({ id: Id.optional(), version: z.number().int().nonnegative().optional(),
  alias: z.string().trim().min(1).max(30), scene: z.enum(['daily', 'relationship', 'work', 'customer']),
  preferences: z.string().trim().max(200), blockedTopics: z.string().trim().max(200) }).strict();
const MemorySchema = z.object({ id: Id.optional(), profileId: Id, version: z.number().int().nonnegative().optional(),
  text: z.string().trim().min(1).max(100), confirmed: z.literal(true) }).strict();

export function redact(text: string): string {
  return text.replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]')
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号已隐藏]')
    .replace(/\b\d{16,19}\b/g, '[长号码已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]');
}
function active(s: UserState): void {
  if (s.status !== 'ACTIVE') fail('ACCOUNT_DELETED', '账号数据已删除，当前账号不能继续生成');
}
function consent(s: UserState): void {
  active(s);
  if (s.consent?.version !== POLICY_VERSION || s.consent.withdrawnAt != null)
    fail('CONSENT_REQUIRED', '请先阅读并同意当前版本的使用与隐私说明');
}
function take<T extends { id: string }>(rows: T[], id: string): T {
  return rows.find(v => v.id === id) ?? fail('RESOURCE_UNAVAILABLE', '记录不存在或无权访问');
}
function remaining(s: UserState, limit: number): number { return Math.max(0, limit - s.quota.used - s.quota.reserved); }
export function createService(o: ServiceOptions) {
  const companion = createCompanion(o);
  const screenshot = createScreenshot(o);
  const now = o.now ?? Date.now;
  const daily = o.dailyLimit ?? 10;
  const timeoutMs = o.timeoutMs ?? 28000;
  const tx = <T>(uid: string, fn: (s: UserState) => T) => o.repository.transact(uid, now(), fn);
  const view = (s: UserState, g: Generation): GenerationView => ({ generationId: g.id, status: g.status,
    replies: g.replies, warnings: g.warnings, errorCode: g.errorCode, label: 'AI生成',
    remainingQuota: remaining(s, daily), mode: o.mode });

  async function generate(uid: string, event: Envelope): Promise<GenerationView> {
    const input = GenerateSchema.parse(event.payload);
    const requestId = Id.parse(event.clientRequestId);
    const gid = `g_${o.hash(`${uid}:${requestId}`)}`;
    const hash = o.hash(JSON.stringify(input));
    const start = await tx(uid, s => {
      consent(s);
      const previous = s.generations.find(g => g.id === gid);
      if (previous) {
        if (previous.payloadHash !== hash) fail('REQUEST_CONFLICT', '同一请求编号不能用于不同输入');
        if (previous.expiresAt <= now() || (previous.status === 'SUCCEEDED' && !previous.replies))
          fail('DATA_EXPIRED', '该请求的临时内容已清除，请主动重新生成');
        return { replay: view(s, previous) };
      }
      o.assertGenerationAccess?.(uid);
      if (!o.enabled) fail('SERVICE_UNAVAILABLE', '真实模型尚未启用，请先完成服务端配置');
      if (s.generations.some(g => g.status === 'PROCESSING')) fail('GENERATION_PENDING', '上一条请求仍在处理中，请稍候', true);
      if (s.rate.length >= 3) fail('RATE_LIMITED', '操作较频繁，请稍后再试', true);
      if (remaining(s, daily) <= 0) fail('QUOTA_EXCEEDED', '今日体验额度已用完，明天再来吧');
      if (input.saveHistory && !s.settings.historyEnabled) fail('CONSENT_REQUIRED', '请先在设置中开启历史保存');
      const profile = input.profileId ? take(s.profiles, input.profileId) : undefined;
      const memories = s.settings.memoryEnabled && profile ? s.memories.filter(m => m.profileId === profile.id) : [];
      const stamp = now();
      const g: Generation = { id: gid, payloadHash: hash, status: 'PROCESSING', createdAt: stamp,
        expiresAt: stamp + 3600000, leaseUntil: stamp + timeoutMs + 2000, dateKey: dateKey(stamp),
        revision: s.revision, input, profileId: input.profileId, provider: o.provider.name, promptVersion: '0.1.0' };
      s.generations.push(g); s.rate.push(stamp); s.quota.reserved++;
      return { run: { input, profile, memories, revision: s.revision, date: g.dateKey } };
    });
    if (start.replay) return start.replay;
    const context = start.run!;
    let usage: { input: number; output: number } | undefined;
    let stopped = false;
    try {
      const work = async (): Promise<ModelOutput> => {
        const sanitized: ProviderContext = {
          input: { ...context.input, message: redact(context.input.message), background: redact(context.input.background), goal: redact(context.input.goal) },
          profile: context.profile ? { ...context.profile, alias: redact(context.profile.alias), preferences: redact(context.profile.preferences), blockedTopics: redact(context.profile.blockedTopics) } : undefined,
          memories: context.memories.map(m => ({ ...m, text: redact(m.text) })),
        };
        if (!await o.moderator.check(JSON.stringify(sanitized))) fail('INPUT_BLOCKED', '输入未通过内容检查，请调整后再试');
        // A timeout/revocation during moderation must not start a later, billable model call.
        if (stopped) fail('PROVIDER_TIMEOUT', '请求已超时', true);
        await tx(uid, s => {
          const g = take(s.generations, gid);
          if (g.status !== 'PROCESSING' || s.status !== 'ACTIVE' || s.revision !== context.revision)
            fail('DATA_CHANGED', '相关数据或授权已变更，本次生成已取消');
        });
        // Count attempts, including failed external calls. Reserve before incurring provider cost.
        if (!await o.budget.reserve(context.date, o.callLimit ?? 100)) fail('BUDGET_EXCEEDED', '今日服务调用预算已用完，请稍后再来');
        const result = await o.provider.generate(sanitized); usage = result.usage;
        const parsed = OutputSchema.safeParse(result.output);
        if (!parsed.success) return fail('INVALID_MODEL_OUTPUT', '模型返回格式异常，本次不扣体验额度', true);
        if (!await o.moderator.check(JSON.stringify(parsed.data))) fail('OUTPUT_BLOCKED', '回复未通过内容检查，请调整输入后再试');
        return parsed.data;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const output = await Promise.race([
        work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('PROVIDER_TIMEOUT', '生成超时，请查询原请求状态', true)), timeoutMs); }),
      ]).finally(() => { stopped = true; if (timer) clearTimeout(timer); });
      return await tx(uid, s => {
        const g = take(s.generations, gid); g.usage = usage;
        if (g.status !== 'PROCESSING') return view(s, g);
        if (s.status !== 'ACTIVE' || s.revision !== context.revision || s.consent?.withdrawnAt != null) {
          g.status = 'CANCELLED'; g.errorCode = 'DATA_CHANGED';
        } else {
          g.status = 'SUCCEEDED'; g.replies = output.replies.map((r, i) => ({ id: `r${i + 1}`, text: r.text }));
          g.warnings = output.warnings;
          if (g.dateKey === s.quota.dateKey) s.quota.used++;
          if (input.saveHistory && s.settings.historyEnabled) {
            s.histories.unshift({ id: `h_${gid}`, generationId: gid, profileId: input.profileId,
              message: input.message, scene: input.scene, tone: input.tone, replies: g.replies,
              warnings: g.warnings, createdAt: now(), expiresAt: now() + 30 * 86400000 });
            // Explicit V0.1 bound prevents unbounded per-user transaction documents.
            s.histories = s.histories.slice(0, 20);
          }
        }
        if (g.dateKey === s.quota.dateKey) s.quota.reserved = Math.max(0, s.quota.reserved - 1);
        delete g.input;
        return view(s, g);
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
      await tx(uid, s => {
        const g = take(s.generations, gid); g.usage = usage;
        if (g.status !== 'PROCESSING') return;
        g.status = code.endsWith('_BLOCKED') ? 'BLOCKED' : code === 'PROVIDER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
        g.errorCode = code; delete g.input; delete g.replies; delete g.warnings;
        if (g.dateKey === s.quota.dateKey) s.quota.reserved = Math.max(0, s.quota.reserved - 1);
      });
      if (error instanceof AppError) throw error;
      return fail('SERVICE_UNAVAILABLE', '服务暂时不可用，本次不扣体验额度', true);
    }
  }

  async function route(uid: string, event: Envelope): Promise<unknown> {
    if (event.action === 'screenshot.recognize') return screenshot(uid, event);
    if (event.action.startsWith('companion.')) return companion(uid, event);
    if (event.action === 'generation.create') return generate(uid, event);
    return tx(uid, s => {
      const payload = event.payload ?? {};
      if (event.action === 'session.bootstrap') {
        z.object({}).strict().parse(payload);
        const review = o.contentReview?.(uid);
        return { settings: s.settings, remainingQuota: remaining(s, daily), policyVersion: POLICY_VERSION,
          accepted: s.consent?.version === POLICY_VERSION && s.consent.withdrawnAt == null,
          mode: o.mode, enabled: o.enabled && (review?.eligible ?? true), provider: o.provider.name,
          operator: o.operator ?? '开发演示，运营主体待填写', support: o.support ?? '请联系项目维护者', status: s.status,
          chatDailyLimit: chatDailyLimit(o, uid), chatRemaining: chatRemaining(s, now(), chatDailyLimit(o, uid)),
          globalDailyCallLimit: o.callLimit ?? 100,
          screenshotDailyLimit: SCREENSHOT_LIMITS.daily,
          screenshotRemaining: Math.max(0, SCREENSHOT_LIMITS.daily - (s.screenshotJobs ?? []).filter(j => j.day === dateKey(now())).length),
          ...(review ? { contentReview: review } : {}) } satisfies Bootstrap;
      }
      if (event.action === 'deletion.get') { const p = objectId.parse(payload); return take(s.deletions, p.id); }
      active(s);
      if (event.action === 'consent.update') {
        const p = z.object({ version: z.literal(POLICY_VERSION), accepted: z.boolean() }).strict().parse(payload);
        s.consent = { version: p.version, acceptedAt: now(), ...(p.accepted ? {} : { withdrawnAt: now() }) };
        if (!p.accepted) { s.settings = { historyEnabled: false, memoryEnabled: false }; cancelPending(s); }
        return { accepted: p.accepted };
      }
      if (event.action === 'account.delete') {
        z.object({ confirmed: z.literal(true) }).strict().parse(payload);
        cancelPending(s); s.status = 'DELETED'; s.profiles = []; s.memories = []; s.histories = []; s.feedback = [];
        s.companion = undefined;
        s.settings = { historyEnabled: false, memoryEnabled: false }; s.consent = undefined; s.settingEvents = [];
        const job = { id: o.id(), scope: 'account', completedAt: now() }; s.deletions = [job];
        return job;
      }
      if (event.action === 'generation.get') {
        const p = z.object({ generationId: Id }).strict().parse(payload); const g = take(s.generations, p.generationId);
        if (g.expiresAt <= now() || (g.status === 'SUCCEEDED' && !g.replies)) fail('DATA_EXPIRED', '临时结果已清除');
        return view(s, g);
      }
      if (event.action === 'settings.update') {
        consent(s);
        const p = z.object({ historyEnabled: z.boolean().optional(), memoryEnabled: z.boolean().optional() }).strict().parse(payload);
        for (const key of ['historyEnabled', 'memoryEnabled'] as const) {
          if (p[key] != null && p[key] !== s.settings[key]) {
            s.settings[key] = p[key]; s.settingEvents.push({ purpose: key, enabled: p[key], at: now() });
          }
        }
        if (p.memoryEnabled === false && s.companion) for (const v of s.companion.conversations) { v.messages = []; if (v.interaction) v.interaction.recentTopics = []; }
        s.settingEvents = s.settingEvents.slice(-40); cancelPending(s);
        return s.settings;
      }
      if (event.action === 'history.list') {
        const p = z.object({ cursor: Id.optional(), limit: z.number().int().min(1).max(20).default(10) }).strict().parse(payload);
        const idx = p.cursor ? s.histories.findIndex(h => h.id === p.cursor) + 1 : 0;
        if (p.cursor && idx === 0) fail('RESOURCE_UNAVAILABLE', '分页记录已失效，请刷新');
        const items = s.histories.slice(idx, idx + p.limit);
        return { items, nextCursor: idx + p.limit < s.histories.length ? items.at(-1)?.id : null };
      }
      if (event.action === 'history.delete') {
        const p = z.object({ id: Id.optional(), all: z.literal(true).optional() }).strict().refine(v => Boolean(v.id) !== Boolean(v.all)).parse(payload);
        if (p.id) take(s.histories, p.id);
        s.histories = p.all ? [] : s.histories.filter(h => h.id !== p.id); cancelPending(s);
        return { deleted: true };
      }
      if (event.action === 'profile.list') { z.object({}).strict().parse(payload); return s.profiles; }
      if (event.action === 'profile.save') {
        consent(s); const p = ProfileSchema.parse(payload);
        const existing = p.id ? take(s.profiles, p.id) : undefined;
        if (existing && existing.version !== p.version) fail('VERSION_CONFLICT', '档案已更新，请刷新后修改');
        if (!existing && s.profiles.length >= 10) fail('LIMIT_REACHED', '首版最多保存10个表达档案');
        const profile: Profile = { ...p, id: existing?.id ?? o.id(), version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? now() };
        s.profiles = [profile, ...s.profiles.filter(v => v.id !== profile.id)]; cancelPending(s); return profile;
      }
      if (event.action === 'profile.delete') {
        const p = objectId.parse(payload); take(s.profiles, p.id);
        s.profiles = s.profiles.filter(v => v.id !== p.id); s.memories = s.memories.filter(v => v.profileId !== p.id);
        s.histories = s.histories.filter(v => v.profileId !== p.id); cancelPending(s); return { deleted: true };
      }
      if (event.action === 'memory.list') {
        const p = z.object({ profileId: Id }).strict().parse(payload); take(s.profiles, p.profileId);
        return s.memories.filter(v => v.profileId === p.profileId);
      }
      if (event.action === 'memory.save') {
        consent(s); if (!s.settings.memoryEnabled) fail('CONSENT_REQUIRED', '请先开启记忆功能');
        const p = MemorySchema.parse(payload); take(s.profiles, p.profileId);
        const old = p.id ? take(s.memories, p.id) : undefined;
        if (old && (old.version !== p.version || old.profileId !== p.profileId)) fail('VERSION_CONFLICT', '记忆已更新，请刷新后修改');
        if (!old && s.memories.filter(m => m.profileId === p.profileId).length >= 10) fail('LIMIT_REACHED', '每个档案最多保存10条记忆');
        const item: Memory = { id: old?.id ?? o.id(), profileId: p.profileId, text: p.text, version: (old?.version ?? 0) + 1, confirmedAt: now() };
        s.memories = [item, ...s.memories.filter(m => m.id !== item.id)]; cancelPending(s); return item;
      }
      if (event.action === 'memory.delete') {
        const p = z.object({ id: Id.optional(), all: z.literal(true).optional() }).strict().refine(v => Boolean(v.id) !== Boolean(v.all)).parse(payload);
        if (p.id) take(s.memories, p.id); s.memories = p.all ? [] : s.memories.filter(m => m.id !== p.id);
        cancelPending(s); return { deleted: true };
      }
      if (event.action === 'feedback.create') {
        const p = z.object({ generationId: Id, reason: z.enum(['unnatural', 'invented', 'offensive', 'other']) }).strict().parse(payload);
        take(s.generations, p.generationId);
        s.feedback.unshift({ id: o.id(), generationId: p.generationId, reason: p.reason, createdAt: now() });
        s.feedback = s.feedback.slice(0, 50); return { submitted: true };
      }
      fail('INVALID_ACTION', '不支持的业务操作');
    });
  }
  return {
    async handle(userId: string, raw: unknown): Promise<ApiResult> {
      const requestId = o.id();
      try {
        if (!userId || userId.length > 150) fail('UNAUTHENTICATED', '无法确认用户身份');
        const event = EnvelopeSchema.parse(raw);
        return { ok: true, requestId, data: await route(userId, event) };
      } catch (error) {
        if (error instanceof z.ZodError) return { ok: false, requestId, error: { code: 'INVALID_INPUT', message: '输入格式不正确或超过长度限制', retryable: false } };
        if (error instanceof AppError) return { ok: false, requestId, error: { code: error.code, message: error.message, retryable: error.retryable } };
        o.onInternalError?.(error);
        return { ok: false, requestId, error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', retryable: true } };
      }
    },
  };
}
