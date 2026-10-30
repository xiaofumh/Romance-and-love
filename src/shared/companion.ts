import { z } from 'zod';
import { IMPORT_LIMITS, utf8Bytes } from './limits';
export { IMPORT_LIMITS, STORAGE_LIMITS, utf8Bytes } from './limits';
z.config({ jitless: true });
export const PERSONALITIES = ['温柔倾听', '理性坦诚', '活泼有趣', '自定义'] as const;
export const CLOSENESS = ['初识', '熟悉', '亲近'] as const;
export const EMOTIONS = ['自然回应', '温柔安慰', '轻松俏皮', '冷静认真'] as const;
export const CONTEXT_LIMITS = { messages: 12, historyCharacters: 600, storedMessages: 40, memories: 10, examples: 3 } as const;
export const CONTEXT_WINDOWS = [6, 12] as const;
export const DEFAULT_CONTEXT_ROUNDS = 12 as const;
export type InteractionMode = 'listening' | 'light' | 'quiet';
export const RoleInput = z.object({ id: z.string().min(1).max(100).optional(), version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(20), relationship: z.enum(['friend', 'partner']),
  personality: z.enum(PERSONALITIES), description: z.string().trim().max(300), boundaries: z.string().trim().max(200),
  userAddress: z.string().trim().max(20).optional(), selfAddress: z.string().trim().max(20).optional(),
  closeness: z.enum(CLOSENESS).optional(), emotion: z.enum(EMOTIONS).optional(), habits: z.string().trim().max(160).optional(),
  proactiveEnabled: z.boolean().optional(), bubbleStyle: z.enum(['single', 'natural']).optional(),
}).strict();
export type CompanionRole = z.infer<typeof RoleInput> & { id: string; version: number; createdAt: number };
export function rolePreferences(role: Partial<CompanionRole>) {
  return { userAddress: role.userAddress ?? '', selfAddress: role.selfAddress ?? '', closeness: role.closeness ?? '熟悉',
    emotion: role.emotion ?? '自然回应', habits: role.habits ?? '', proactiveEnabled: role.proactiveEnabled ?? false, bubbleStyle: role.bubbleStyle ?? 'single' };
}
export type ChatMessage = { id: string; requestId: string; speaker: 'user' | 'assistant'; text: string; createdAt: number;
  sources?: { documentId: string; title: string; turn: number }[]; mode?: 'demo' | 'cloud'; memoryUsed?: boolean;
  kind?: 'reply' | 'initiative'; parts?: string[] };
export type Conversation = { id: string; roleId: string; title: string; messages: ChatMessage[]; createdAt: number; updatedAt: number;
  primary?: boolean;
  contextAfterId?: string; contextResetReason?: string; contextRounds?: 6 | 12; settingsVersion?: number;
  interaction?: { mode: InteractionMode; initiativeAttemptFor?: string; lastInitiativeAt?: number; recentTopics?: string[] } };
// Presentation-only compatibility: do not rewrite stored historical messages or strip real/user text.
export function displayChatText(message: Pick<ChatMessage, 'speaker' | 'mode' | 'text'>): string {
  return message.speaker === 'assistant' && message.mode === 'demo'
    ? message.text.replace(/^【模拟模板，非真实模型】\s*/, '') : message.text;
}
export function referenceCaption(mode?: ChatMessage['mode']): string {
  return mode === 'cloud' ? '本轮提交模型的参考' : mode === 'demo' ? '本地检索示例（未送入模型）' : '历史资料参考（未核实发送状态）';
}
export type ReferenceTurn = { speaker: 'user' | 'reference'; text: string };
export type ReferenceDocument = { id: string; roleId: string; title: string; turns: ReferenceTurn[]; createdAt: number; expiresAt: number };
export function referenceQuality(turns: ReferenceTurn[]) {
  const seen = new Set<string>(); let duplicateCount = 0, userCount = 0, referenceCount = 0;
  for (const t of turns) {
    if (t.speaker === 'user') userCount++; else referenceCount++;
    const key = `${t.speaker}:${t.text.normalize('NFKC').replace(/\s+/g, '').toLowerCase()}`;
    if (seen.has(key)) duplicateCount++; else seen.add(key);
  }
  return { userCount, referenceCount, duplicateCount };
}
export type CompanionMemory = { id: string; roleId: string; text: string; status: 'pending' | 'confirmed'; version: number;
  documentId?: string; createdAt: number; subject?: 'user' | 'role' | 'reference' | 'unspecified'; topic?: string;
  sourceNote?: string; validFor?: 'long-term' | 'today' | '7days'; expiresAt?: number; expiryHandled?: boolean };
export const MEMORY_SUBJECTS = [{ value: 'unspecified', label: '未明确主体' }, { value: 'user', label: '我的事实' },
  { value: 'role', label: 'AI角色虚构设定' }, { value: 'reference', label: '历史参考人物' }] as const;
export const MEMORY_DURATIONS = [{ value: 'long-term', label: '长期（可手动纠正／删除）' },
  { value: 'today', label: '仅今天' }, { value: '7days', label: '7天' }] as const;
export const MemoryInput = z.object({ id: z.string().min(1).max(100).optional(), version: z.number().int().positive().optional(),
  roleId: z.string().min(1).max(100), text: z.string().trim().min(1).max(100), confirmed: z.boolean(),
  documentId: z.string().min(1).max(100).optional(), subject: z.enum(['user', 'role', 'reference', 'unspecified']).optional(),
  topic: z.string().trim().max(30).optional(), sourceNote: z.string().trim().max(80).optional(),
  validFor: z.enum(['long-term', 'today', '7days']).optional() }).strict();
export function memoryActive(memory: CompanionMemory, now: number): boolean {
  return memory.status === 'confirmed' && (memory.expiresAt == null || memory.expiresAt > now);
}
export function memoryConflict(memory: Pick<CompanionMemory, 'id' | 'subject' | 'topic' | 'text'>, others: CompanionMemory[], now: number): CompanionMemory | undefined {
  const key = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (!memory.topic?.trim() || !memory.subject || memory.subject === 'unspecified') return;
  return others.find(m => m.id !== memory.id && m.subject === memory.subject && key(m.topic ?? '') === key(memory.topic!)
    && key(m.text) !== key(memory.text) && memoryActive(m, now));
}
export type ChatJob = { id: string; conversationId: string; roleId: string; hash: string; revision: number;
  status: 'PROCESSING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'; createdAt: number; leaseUntil: number;
  errorCode?: string; day: string; kind?: 'reply' | 'initiative';
  metrics?: { contextRounds: 6 | 12; historyMessages: number; elapsedMs: number; inputTokens?: number; outputTokens?: number;
    failureStage?: string; failureKind?: string;
    requestAudit?: { historySha256: string; historyMessages: number; protocol: string; chatTemperature?: number } } };
export type CompanionState = { roles: CompanionRole[]; conversations: Conversation[]; documents: ReferenceDocument[];
  memories: CompanionMemory[]; jobs: ChatJob[] };
export function emptyCompanion(): CompanionState { return { roles: [], conversations: [], documents: [], memories: [], jobs: [] }; }
export type CompanionView = { roles: CompanionRole[]; conversations: { id: string; roleId: string; title: string; updatedAt: number; preview: string }[] };
export const ChatOutput = z.object({ text: z.string().trim().min(1).max(1200) }).strict();
export const ImportInput = z.object({ roleId: z.string().min(1).max(100), title: z.string().trim().min(1).max(40),
  text: z.string().min(1).refine(text => utf8Bytes(text) <= IMPORT_LIMITS.fileBytes, '文本超过1MB，请拆分后导入'), userSpeaker: z.string().trim().min(1).max(20),
  referenceSpeaker: z.string().trim().min(1).max(20), authorized: z.literal(true) }).strict();
export function redactPrivate(text: string): string {
  return text.replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]').replace(/\b\d{17}[\dXx]\b/g, '[证件号已隐藏]')
    .replace(/\b\d{16,19}\b/g, '[长号码已隐藏]')
    // Bounded quantifiers avoid pathological backtracking on long imported lines.
    .replace(/[\w.+-]{1,64}@[\w.-]{1,253}\.[A-Za-z]{2,63}/g, '[邮箱已隐藏]');
}
// Deliberately conservative: ambiguous timestamps/exports must be normalized by the user, never guessed.
export function parseReference(text: string, userSpeaker: string, referenceSpeaker: string): ReferenceTurn[] {
  const me = userSpeaker.trim(), other = referenceSpeaker.trim();
  if (!me || !other || me === other || /[：:\r\n]/.test(me + other)) throw new Error('双方称呼必须不同，且不能包含冒号或换行');
  if (utf8Bytes(text) > IMPORT_LIMITS.fileBytes) throw new Error('文本超过1MB，请拆分后导入');
  const lines = text.split(/\r?\n/).filter(v => v.trim());
  if (lines.length < 2) throw new Error('请导入至少2行，每行一条消息');
  const turns = lines.map((line, index): ReferenceTurn => {
    const m = /^\s*([^：:]+)[：:]\s*(.+)$/.exec(line);
    if (!m || ![me, other].includes(m[1]!.trim())) throw new Error(`第${index + 1}行无法识别说话人，请整理为“称呼：内容”`);
    return { speaker: m[1]!.trim() === me ? 'user' : 'reference', text: redactPrivate(m[2]!.trim()) };
  });
  if (!turns.some(v => v.speaker === 'user') || !turns.some(v => v.speaker === 'reference')) throw new Error('资料必须包含双方的消息');
  return turns;
}

export type ReferencePreview = { turn: number; part: number; speaker: ReferenceTurn['speaker']; text: string };
// Display-only slices; never truncate the stored reference or the reviewed data.
export function referencePreview(turns: ReferenceTurn[]): ReferencePreview[] {
  const rows: ReferencePreview[] = [];
  turns.forEach((turn, index) => {
    let buffer = '', part = 1;
    for (const ch of turn.text) {
      buffer += ch;
      if (buffer.length >= 1000) { rows.push({ turn: index + 1, part: part++, speaker: turn.speaker, text: buffer }); buffer = ''; }
    }
    if (buffer) rows.push({ turn: index + 1, part, speaker: turn.speaker, text: buffer });
  });
  return rows;
}
export function reviewedReferenceText(turns: ReferenceTurn[]): string {
  // Neutral short speaker markers avoid transmitting source names and length
  // growth caused by changing one-character names into Chinese display labels.
  return turns.map(turn => `${turn.speaker === 'user' ? '0' : '1'}:${turn.text}`).join('\n');
}
