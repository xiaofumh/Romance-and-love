import { z } from 'zod';
import { ChatOutput, ImportInput, RoleInput, MemoryInput, CONTEXT_LIMITS, DEFAULT_CONTEXT_ROUNDS, STORAGE_LIMITS, emptyCompanion, parseReference, redactPrivate, utf8Bytes, memoryActive, memoryConflict } from '../shared/companion';
import type { CompanionState, CompanionMemory, Conversation, ReferenceDocument, ChatJob } from '../shared/companion';
import { POLICY_VERSION } from '../shared/contracts';
import type { Envelope } from '../shared/contracts';
import { AppError, DatabaseError, fail } from './errors';
import { cancelPending, dateKey, resetRoleContext } from './state';
import type { UserState } from './state';
import type { ServiceOptions } from './service';
import type { ChatContext, RetrievedExample } from './companion-prompt';
import { currentHistory, selectContext, nextInteractionMode, initiativeStatus, naturalBubbles } from '../shared/interaction';
import { chatDailyLimit } from './chat-quota';
import { chooseInitiativeTopic, repeatedInitiative, INITIATIVE_WAIT } from './initiative-topic';
import { buildDialoguePlan } from './dialogue';
import { beijingClock } from '../shared/beijing-time';
import { primaryConversation } from './primary-conversation';

const Id = z.string().min(1).max(100), ById = z.object({ id: Id }).strict();
function take<T extends { id: string }>(items: T[], id: string): T { return items.find(v => v.id === id) ?? fail('RESOURCE_UNAVAILABLE', '记录不存在或无权访问'); }
export function companionState(s: UserState): CompanionState { return s.companion ??= emptyCompanion(); }
export function chatRemaining(s: UserState, now: number, limit: number): number {
  return Math.max(0, limit - companionState(s).jobs.filter(j => j.day === dateKey(now) && ['PROCESSING', 'SUCCEEDED', 'SKIPPED'].includes(j.status)).length);
}
function allowed(s: UserState): void {
  if (s.status !== 'ACTIVE') fail('ACCOUNT_DELETED', '账号数据已删除');
  if (s.consent?.version !== POLICY_VERSION || s.consent.withdrawnAt != null) fail('CONSENT_REQUIRED', '请先阅读并同意使用与隐私说明');
}
function terms(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set<string>(); for (let i = 0; i < normalized.length - 1; i++) out.add(normalized.slice(i, i + 2)); return out;
}
// Ownership filtering happens before ranking. There is no global/shared retrieval index.
export function retrieve(documents: ReferenceDocument[], roleId: string, query: string): RetrievedExample[] {
  const keys = terms(query);
  if (!keys.size) return [];
  const best: (RetrievedExample & { score: number })[] = [];
  // Bound working memory/top-k; scan long messages in overlapping windows so a
  // match near the end is not scored against an unrelated first-240-char prefix.
  for (const d of documents.filter(d => d.roleId === roleId)) for (let i = 0; i < d.turns.length; i++) {
    const t = d.turns[i]!; if (t.speaker !== 'reference') continue;
    const user = d.turns[i - 1]?.speaker === 'user' ? d.turns[i - 1]!.text.slice(-240) : '';
    let winner: { score: number; reference: string } | undefined;
    for (let start = 0; start < t.text.length; start += 160) {
      const reference = t.text.slice(start, start + 240), ts = terms(user + reference); let score = 0;
      keys.forEach(k => { if (ts.has(k)) score++; });
      if (score && (!winner || score > winner.score)) winner = { score, reference };
    }
    if (winner) { best.push({ documentId: d.id, title: d.title, turn: i + 1, user, ...winner }); best.sort((a, b) => b.score - a.score); best.length = Math.min(CONTEXT_LIMITS.examples, best.length); }
  }
  return best.map(({ score: _score, ...e }) => e);
}
export function createCompanion(o: ServiceOptions) {
  const now = o.now ?? Date.now, timeout = o.timeoutMs ?? 28000;
  const tx = <T>(uid: string, fn: (s: UserState, c: CompanionState) => T) => o.repository.transact(uid, now(), s => {
    const c = companionState(s), result = fn(s, c);
    if (utf8Bytes(JSON.stringify(c)) > STORAGE_LIMITS.companionBytes) fail('STORAGE_LIMIT', '资料或聊天总空间已满（4MB），请先导出并清理旧内容');
    return result;
  });
  const result = (c: CompanionState, id: string) => {
    const job = take(c.jobs, id), conversation = take(c.conversations, job.conversationId);
    const message = conversation.messages.find(m => m.requestId === id && m.speaker === 'assistant');
    if (job.status === 'SUCCEEDED' && !message) fail('DATA_EXPIRED', '该轮聊天已过期或清除，不会再次调用模型');
    return { job, ...(message ? { message } : {}), mode: o.mode };
  };
  async function send(uid: string, event: Envelope): Promise<unknown> {
    const isInitiative = event.action === 'companion.initiative';
    const p = isInitiative ? { ...z.object({ conversationId: Id }).strict().parse(event.payload), text: '' }
      : z.object({ conversationId: Id, text: z.string().trim().min(1).max(1200) }).strict().parse(event.payload);
    const request = Id.parse(event.clientRequestId), id = `chat_${o.hash(`${uid}:${request}`)}`, hash = o.hash(JSON.stringify(p));
    const start = await tx(uid, (s, c) => {
      allowed(s); const conversation = take(c.conversations, p.conversationId), role = take(c.roles, conversation.roleId);
      const previous = c.jobs.find(j => j.id === id);
      if (previous) { if (previous.hash !== hash) fail('REQUEST_CONFLICT', '同一请求编号不能用于不同消息'); return { replay: result(c, id) }; }
      o.assertGenerationAccess?.(uid);
      if (!o.enabled || !o.provider.chat) fail('SERVICE_UNAVAILABLE', '聊天模型尚未配置');
      if (isInitiative && o.mode !== 'cloud') fail('SERVICE_UNAVAILABLE', '本地模拟不启动主动模型生成');
      if (!s.settings.historyEnabled) fail('HISTORY_REQUIRED', '请明确开启会话保存后再聊天；关闭后仍可查看和删除旧记录');
      if (c.jobs.some(j => j.status === 'PROCESSING')) fail('CHAT_PENDING', '上一条消息仍在处理中，请稍候', true);
      if (c.jobs.filter(j => j.createdAt > now() - 60000).length >= 12) fail('RATE_LIMITED', '消息发送较频繁，请稍后再试', true);
      if (!chatRemaining(s, now(), chatDailyLimit(o, uid))) fail('QUOTA_EXCEEDED', '今日聊天体验额度已用完');
      const recent = selectContext(conversation, s.settings.memoryEnabled);
      // Decide before reserving a model attempt, and use precisely the same
      // history as generation. No generic rotating topics when the gate waits.
      const initiativeTopic = isInitiative ? chooseInitiativeTopic({ messages: recent, interaction: conversation.interaction?.mode },
        conversation.interaction?.recentTopics ?? [], o.hash, now()) : undefined;
      if (isInitiative) {
        if (!initiativeStatus(conversation, role, now(), s.settings.memoryEnabled).available)
          fail('INITIATIVE_NOT_READY', '当前不适合主动接话，已暂停；无需重复尝试');
        if (!initiativeTopic) fail('INITIATIVE_NOT_READY', '当前没有适合继续的话题，先留些空间');
        const latest = [...currentHistory(conversation, s.settings.memoryEnabled)].reverse().find(m => m.speaker === 'user')!;
        conversation.interaction = { ...conversation.interaction, mode: conversation.interaction?.mode ?? 'listening',
          initiativeAttemptFor: latest.requestId, lastInitiativeAt: now() };
      } else conversation.interaction = { ...conversation.interaction, mode: nextInteractionMode(p.text, conversation.interaction?.mode) };
      const contextRounds = conversation.contextRounds ?? DEFAULT_CONTEXT_ROUNDS;
      const context: ChatContext = { role, message: redactPrivate(p.text), clock: beijingClock(now()),
        intent: isInitiative ? 'initiative' : 'reply', interaction: conversation.interaction.mode,
        messages: recent.map(m => ({ speaker: m.speaker, text: redactPrivate(m.text).slice(0, CONTEXT_LIMITS.historyCharacters), createdAt: m.createdAt })),
        memories: s.settings.memoryEnabled ? c.memories.filter(m => m.roleId === role.id && memoryActive(m, now())).slice(0, CONTEXT_LIMITS.memories) : [],
        examples: retrieve(c.documents, role.id, p.text) };
      context.dialoguePlan = buildDialoguePlan(context, now());
      if (isInitiative && initiativeTopic) {
        context.initiativeTopic = initiativeTopic;
        conversation.interaction.recentTopics = [...(conversation.interaction.recentTopics ?? []), context.initiativeTopic.key].slice(-4);
      }
      // Redact every outbound field, not just the current message.
      const safe = JSON.parse(redactPrivate(JSON.stringify(context))) as ChatContext;
      c.jobs.push({ id, conversationId: p.conversationId, roleId: role.id, hash, revision: s.revision,
        kind: isInitiative ? 'initiative' : 'reply', metrics: { contextRounds, historyMessages: recent.length, elapsedMs: 0 },
        status: 'PROCESSING', createdAt: now(), leaseUntil: now() + timeout + 2000, day: dateKey(now()) });
      return { run: { context: safe, revision: s.revision, day: dateKey(now()) } };
    });
    if (start.replay) return start.replay;
    const run = start.run!; let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, phase = 'input-review';
    let usage: { input: number; output: number } | undefined;
    let requestAudit: NonNullable<ChatJob['metrics']>['requestAudit'];
    const timing = (job: ChatJob) => {
      if (!job.metrics) return;
      job.metrics.elapsedMs = Math.max(0, now() - job.createdAt);
      if (requestAudit) job.metrics.requestAudit = requestAudit;
      if (usage) { if (Number.isFinite(usage.input) && usage.input >= 0) job.metrics.inputTokens = usage.input;
        if (Number.isFinite(usage.output) && usage.output >= 0) job.metrics.outputTokens = usage.output; }
    };
    try {
      const work = async () => {
        const materials = JSON.stringify({ role: run.context.role, memories: run.context.memories,
          examples: run.context.examples, message: run.context.message, dialoguePlan: run.context.dialoguePlan, initiativeTopic: run.context.initiativeTopic && {
            instruction: run.context.initiativeTopic.instruction, anchor: run.context.initiativeTopic.anchor } });
        // Production external checks fail closed. Explicit allowlisted internal-test
        // configuration skips them; it must never be reported as a moderation pass.
        for (let i = 0; i < materials.length; i += 1500) {
          if (stopped) fail('PROVIDER_TIMEOUT', '请求已超时');
          if (!await o.moderator.check(materials.slice(i, i + 1500))) fail('INPUT_BLOCKED', '输入或参考资料未通过内容检查');
        }
        if (stopped) fail('PROVIDER_TIMEOUT', '请求已超时');
        await tx(uid, (s, c) => { allowed(s); if (take(c.jobs, id).status !== 'PROCESSING' || s.revision !== run.revision) fail('DATA_CHANGED', '资料或授权已变更，请刷新'); });
        phase = 'budget';
        if (!await o.budget.reserve(run.day, o.callLimit ?? 100)) fail('BUDGET_EXCEEDED', '服务今日模型调用预算已用完');
        if (stopped) fail('PROVIDER_TIMEOUT', '请求已超时');
        await tx(uid, (s, c) => { allowed(s); if (take(c.jobs, id).status !== 'PROCESSING' || s.revision !== run.revision) fail('DATA_CHANGED', '资料或授权已变更，本次调用已取消'); });
        if (stopped) fail('PROVIDER_TIMEOUT', '请求已超时');
        phase = 'provider';
        const response = await o.provider.chat!(run.context); usage = response.usage; requestAudit = response.requestAudit;
        phase = 'output-validation';
        const parsed = ChatOutput.safeParse(response.output);
        if (!parsed.success) return fail('INVALID_MODEL_OUTPUT', '模型回复格式异常，本次不扣体验额度');
        if (/<\/?(?:think|analysis|reasoning)(?:\s[^>]*)?>|<\|(?:im_start|im_end|endoftext)\|>/i.test(parsed.data.text))
          fail('INVALID_MODEL_OUTPUT', '模型回复含异常生成标记，本轮未展示，请稍后重新发送');
        if (isInitiative && parsed.data.text === INITIATIVE_WAIT) return INITIATIVE_WAIT;
        if (parsed.data.text.includes(INITIATIVE_WAIT)) fail('INVALID_MODEL_OUTPUT', '模型回复包含内部标记，本轮未展示');
        phase = 'deduplicate';
        if (isInitiative && repeatedInitiative(parsed.data.text, run.context.messages))
          fail('INITIATIVE_REPEATED', '本次主动话题与近期回复重复，已跳过，不会自动重试', true);
        phase = 'output-review';
        if (!await o.moderator.check(parsed.data.text)) fail('OUTPUT_BLOCKED', '回复未通过内容检查');
        return parsed.data.text;
      };
      const text = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('PROVIDER_TIMEOUT', '聊天超时，请查询原请求，不要反复重发', true)), timeout); })])
        .finally(() => { stopped = true; if (timer) clearTimeout(timer); });
      phase = 'commit';
      return await tx(uid, (s, c) => {
        allowed(s); const job = take(c.jobs, id);
        if (job.status !== 'PROCESSING' || s.revision !== run.revision || !s.settings.historyEnabled) fail('DATA_CHANGED', '会话或资料已变更，本轮回复已取消');
        const conversation = take(c.conversations, p.conversationId);
        if (isInitiative && text === INITIATIVE_WAIT) {
          job.status = 'SKIPPED'; timing(job);
          // A provider request occurred: keep usage and count the personal/global
          // attempt, while storing no fake assistant message or control token.
          return result(c, id);
        }
        if (!isInitiative) conversation.messages.push({ id: o.id(), requestId: id, speaker: 'user', text: redactPrivate(p.text), createdAt: job.createdAt, memoryUsed: run.context.memories.length > 0 });
        conversation.messages.push(
          { id: o.id(), requestId: id, speaker: 'assistant', text, createdAt: now(), mode: o.mode, memoryUsed: run.context.memories.length > 0,
            kind: isInitiative ? 'initiative' : 'reply', ...(run.context.role.bubbleStyle === 'natural' ? { parts: naturalBubbles(text, 'natural') } : {}),
            sources: run.context.examples.map(e => ({ documentId: e.documentId, title: e.title, turn: e.turn })) });
        conversation.messages = conversation.messages.slice(-CONTEXT_LIMITS.storedMessages); conversation.updatedAt = now(); job.status = 'SUCCEEDED'; timing(job);
        return result(c, id);
      });
    } catch (error) {
      if (timer) clearTimeout(timer); stopped = true;
      const kind = (e: unknown) => e instanceof DatabaseError ? e.kind : e instanceof AppError ? 'controlled'
        : e instanceof TypeError ? 'TypeError' : e instanceof ReferenceError ? 'ReferenceError' : 'unknown';
      try { await tx(uid, (_s, c) => { const job = c.jobs.find(j => j.id === id); if (job?.status === 'PROCESSING') {
        timing(job);
        if (job.metrics) {
          job.metrics.failureStage = phase;
          job.metrics.failureKind = kind(error);
        }
        job.status = error instanceof AppError && error.code === 'PROVIDER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
        job.errorCode = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
      } }); } catch (persistenceError) {
        // A second DB outage must not replace the original model/save failure.
        // Leave the idempotent lease intact; never repeat a paid model request.
        try { o.onInternalError?.({ kind: 'chat-failure-persist', phase, primaryKind: kind(error), persistenceKind: kind(persistenceError) }); } catch { /* diagnostics cannot change the API result */ }
      }
      if (error instanceof AppError) throw error;
      fail('SERVICE_UNAVAILABLE', '模型服务暂时不可用，本次不扣体验额度', true);
    }
  }
  return async (uid: string, event: Envelope): Promise<unknown> => {
    if (event.action === 'companion.send' || event.action === 'companion.initiative') return send(uid, event);
    return tx(uid, (s, c) => {
      if (s.status !== 'ACTIVE') fail('ACCOUNT_DELETED', '账号数据已删除');
      const p = event.payload ?? {};
      if (event.action === 'companion.list') {
        z.object({}).strict().parse(p);
        const conversations = c.roles.flatMap(role => {
          const room = primaryConversation(role, c.conversations); return room ? [room] : [];
        });
        return { roles: c.roles, conversations: conversations.map(({ messages, ...v }) => ({ ...v, preview: messages.at(-1)?.text.slice(0, 50) ?? '开始聊天' })) };
      }
      if (event.action === 'companion.conversation.get') {
        const { id } = ById.parse(p), v = take(c.conversations, id), role = take(c.roles, v.roleId);
        const status = initiativeStatus(v, role, now(), s.settings.memoryEnabled);
        const topic = chooseInitiativeTopic({ messages: selectContext(v, s.settings.memoryEnabled), interaction: v.interaction?.mode },
          v.interaction?.recentTopics ?? [], o.hash, now());
        const initiative = ['ready', 'waiting'].includes(status.reason) && !topic
          ? { ...status, available: false, availableAt: 0, reason: 'no-topic' } : status;
        return { conversation: { ...v, contextRounds: v.contextRounds ?? DEFAULT_CONTEXT_ROUNDS }, role, jobs: c.jobs.filter(j => j.conversationId === id).slice(-8),
          initiative, serverTime: now(), clock: beijingClock(now()) };
      }
      if (event.action === 'companion.job.get') { const { id } = ById.parse(p); return result(c, id); }
      if (event.action === 'companion.data') {
        const { id } = ById.parse(p); take(c.roles, id);
        return { documents: c.documents.filter(d => d.roleId === id).map(({ turns, ...d }) => ({ ...d, count: turns.length })), memories: c.memories.filter(m => m.roleId === id) };
      }
      if (event.action === 'companion.document.get') { const { id } = ById.parse(p); return take(c.documents, id); }
      if (event.action === 'companion.export') { z.object({ confirmed: z.literal(true) }).strict().parse(p); return { exportedAt: now(), roles: c.roles, conversations: c.conversations, documents: c.documents, memories: c.memories }; }
      // Destructive operations remain available after revocation; creation requires current consent.
      if (event.action === 'companion.clear') {
        z.object({ confirmed: z.literal(true) }).strict().parse(p); cancelPending(s); s.companion = { ...emptyCompanion(), jobs: c.jobs }; return { deleted: true };
      }
      if (event.action === 'companion.delete') {
        const q = z.object({ id: Id, kind: z.enum(['role', 'conversation', 'document', 'memory']) }).strict().parse(p);
        if (q.kind === 'role') { take(c.roles, q.id); c.roles = c.roles.filter(v => v.id !== q.id); c.conversations = c.conversations.filter(v => v.roleId !== q.id); c.documents = c.documents.filter(v => v.roleId !== q.id); c.memories = c.memories.filter(v => v.roleId !== q.id); }
        if (q.kind === 'conversation') { take(c.conversations, q.id); c.conversations = c.conversations.filter(v => v.id !== q.id); }
        if (q.kind === 'document') { take(c.documents, q.id); const affected = new Set(c.memories.filter(m => m.documentId === q.id).map(m => m.roleId)); c.documents = c.documents.filter(v => v.id !== q.id); c.memories = c.memories.filter(v => v.documentId !== q.id);
          // Drop entire referenced rounds, not only citation labels, to avoid resurrecting source text.
          for (const v of c.conversations) if (affected.has(v.roleId) || v.messages.some(m => m.sources?.some(e => e.documentId === q.id))) {
            v.messages = []; if (v.interaction) v.interaction.recentTopics = [];
          }
        }
        if (q.kind === 'memory') { const m = take(c.memories, q.id); c.memories = c.memories.filter(v => v.id !== q.id);
          // Old model replies can restate a deleted fact. Reset that role's conversation context too.
          for (const v of c.conversations.filter(v => v.roleId === m.roleId)) { v.messages = []; if (v.interaction) v.interaction.recentTopics = []; }
        }
        cancelPending(s); return { deleted: true };
      }
      allowed(s);
      if (event.action === 'companion.interaction.configure') {
        const q = z.object({ id: Id, version: z.number().int().positive(), mode: z.enum(['listening', 'light', 'quiet']) }).strict().parse(p);
        const v = take(c.conversations, q.id);
        if (q.version !== (v.settingsVersion ?? 1)) fail('VERSION_CONFLICT', '会话设置已更新，请刷新');
        v.interaction = { ...v.interaction, mode: q.mode }; v.settingsVersion = (v.settingsVersion ?? 1) + 1;
        // This preference belongs to one conversation, not the whole account.
        for (const job of c.jobs) if (job.conversationId === v.id && job.status === 'PROCESSING') {
          job.status = 'CANCELLED'; job.errorCode = 'DATA_CHANGED';
        }
        return { mode: q.mode, version: v.settingsVersion };
      }
      if (event.action === 'companion.conversation.configure') {
        const q = z.object({ id: Id, version: z.number().int().positive(), contextRounds: z.union([z.literal(6), z.literal(12)]) }).strict().parse(p);
        const v = take(c.conversations, q.id); if (q.version !== (v.settingsVersion ?? 1)) fail('VERSION_CONFLICT', '会话设置已更新，请刷新');
        v.contextRounds = q.contextRounds; v.settingsVersion = q.version + 1; cancelPending(s); return { contextRounds: v.contextRounds, version: v.settingsVersion };
      }
      if (event.action === 'companion.conversation.fork') {
        const q = z.object({ id: Id, contextRounds: z.union([z.literal(6), z.literal(12)]) }).strict().parse(p);
        const original = take(c.conversations, q.id); take(c.roles, original.roleId);
        if (c.jobs.some(j => j.conversationId === q.id && j.status === 'PROCESSING')) fail('CHAT_PENDING', '原会话仍在生成，请完成后再建立对比快照');
        if (c.conversations.length >= 12) fail('LIMIT_REACHED', '最多12个会话，请先清理测试会话');
        const fork: Conversation = { ...JSON.parse(JSON.stringify(original)), id: o.id(), title: `上下文${q.contextRounds}轮对比`,
          primary: false, contextRounds: q.contextRounds, settingsVersion: 1, createdAt: now(), updatedAt: now() };
        c.conversations.unshift(fork); return fork;
      }
      if (event.action === 'companion.role.save') {
        const q = RoleInput.parse(p), old = q.id ? take(c.roles, q.id) : undefined;
        if (old && q.version !== old.version) fail('VERSION_CONFLICT', '角色已更新，请刷新');
        if (!old && c.roles.length >= 6) fail('LIMIT_REACHED', '开发版最多6个独立角色');
        const role = { ...old, ...q, name: redactPrivate(q.name), description: redactPrivate(q.description), boundaries: redactPrivate(q.boundaries),
          ...(q.userAddress != null ? { userAddress: redactPrivate(q.userAddress) } : {}),
          ...(q.selfAddress != null ? { selfAddress: redactPrivate(q.selfAddress) } : {}),
          ...(q.habits != null ? { habits: redactPrivate(q.habits) } : {}),
          id: old?.id ?? o.id(), version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now() };
        if (old) resetRoleContext(c, old.id, '角色设定已更新，旧消息保留但不再作为上下文');
        c.roles = [role, ...c.roles.filter(v => v.id !== role.id)]; cancelPending(s); return role;
      }
      if (event.action === 'companion.conversation.create') {
        const q = z.object({ roleId: Id }).strict().parse(p); const role = take(c.roles, q.roleId);
        const existing = primaryConversation(role, c.conversations);
        if (existing) return existing;
        if (c.conversations.length >= 18) fail('LIMIT_REACHED', '历史会话空间已满，请先导出并清理旧会话');
        const v: Conversation = { id: o.id(), roleId: role.id, title: role.name, messages: [], contextRounds: DEFAULT_CONTEXT_ROUNDS, createdAt: now(), updatedAt: now() };
        v.primary = true; c.conversations.unshift(v); return v;
      }
      if (event.action === 'companion.import') {
        const q = ImportInput.parse(p); take(c.roles, q.roleId);
        if (c.documents.filter(d => d.roleId === q.roleId).length >= 6) fail('LIMIT_REACHED', '每个角色最多6份资料');
        const turns = (() => { try { return parseReference(q.text, q.userSpeaker, q.referenceSpeaker); } catch (e) { throw new AppError('INVALID_INPUT', (e as Error).message); } })();
        const d: ReferenceDocument = { id: o.id(), roleId: q.roleId, title: redactPrivate(q.title), turns, createdAt: now(), expiresAt: now() + 30 * 86400000 };
        c.documents.unshift(d); cancelPending(s); return d;
      }
      if (event.action === 'companion.memory.save') {
        const q = MemoryInput.parse(p);
        take(c.roles, q.roleId); const old = q.id ? take(c.memories, q.id) : undefined;
        if (old && (q.version !== old.version || q.roleId !== old.roleId)) fail('VERSION_CONFLICT', '记忆已变更，请刷新');
        if (q.documentId && take(c.documents, q.documentId).roleId !== q.roleId) fail('RESOURCE_UNAVAILABLE', '资料不属于此角色');
        if (q.confirmed && !s.settings.memoryEnabled) fail('CONSENT_REQUIRED', '请先在“我的”开启已确认记忆');
        if (!old && c.memories.filter(m => m.roleId === q.roleId).length >= 10) fail('LIMIT_REACHED', '每个角色最多10条候选及确认记忆');
        const validFor = q.validFor ?? old?.validFor ?? 'long-term';
        const expiresAt = q.validFor == null && old ? old.expiresAt : validFor === 'today'
          ? Date.parse(`${dateKey(now())}T00:00:00+08:00`) + 86400000 : validFor === '7days' ? now() + 7 * 86400000 : undefined;
        if (q.confirmed && expiresAt != null && expiresAt <= now()) fail('MEMORY_EXPIRED', '这条记忆已过期，请编辑有效期后重新确认');
        const memory: CompanionMemory = { ...old, id: old?.id ?? o.id(), roleId: q.roleId, text: redactPrivate(q.text), status: q.confirmed ? 'confirmed' : 'pending',
          version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now(), ...(q.documentId ? { documentId: q.documentId } : {}),
          subject: q.subject ?? old?.subject ?? (q.documentId ? 'reference' : 'unspecified'), topic: redactPrivate(q.topic ?? old?.topic ?? ''),
          sourceNote: redactPrivate(q.sourceNote ?? old?.sourceNote ?? ''), validFor, expiresAt, expiryHandled: false };
        if (q.confirmed && memoryConflict(memory, c.memories.filter(m => m.roleId === q.roleId), now()))
          fail('MEMORY_CONFLICT', '同一主体与主题已有不同的有效事实，请编辑并纠正原条目；系统不会擅自覆盖');
        c.memories = [memory, ...c.memories.filter(m => m.id !== memory.id)];
        if (old || q.confirmed) resetRoleContext(c, q.roleId, '事实记忆已更新，旧消息保留但不再作为上下文');
        cancelPending(s); return memory;
      }
      fail('INVALID_ACTION', '不支持的陪伴操作');
    });
  };
}
