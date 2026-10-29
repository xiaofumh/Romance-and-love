import { z } from 'zod';

// Mini-program runtimes restrict dynamic Function/eval. Use Zod's interpreter everywhere.
z.config({ jitless: true });

export const POLICY_VERSION = '2026-10-18.v0.2-companion';
export const SCENES = [
  { value: 'daily', label: '日常聊天' },
  { value: 'relationship', label: '亲密关系' },
  { value: 'work', label: '职场沟通' },
  { value: 'customer', label: '客户沟通' },
] as const;
export const TONES = [
  { value: 'natural', label: '自然' }, { value: 'warm', label: '温和' },
  { value: 'concise', label: '简洁' }, { value: 'formal', label: '正式' },
  { value: 'firm', label: '坚定' },
] as const;
export const GenerateSchema = z.object({
  message: z.string().trim().min(1, '请先输入对方的话').max(2000),
  background: z.string().trim().max(1000).default(''),
  goal: z.string().trim().max(1000).default(''),
  scene: z.enum(['daily', 'relationship', 'work', 'customer']),
  tone: z.enum(['natural', 'warm', 'concise', 'formal', 'firm']),
  length: z.enum(['short', 'medium']),
  profileId: z.string().max(80).nullable().default(null),
  saveHistory: z.boolean().default(false),
}).strict().refine(v => v.background.length + v.goal.length <= 1000, '背景和目标合计最多1000字');
export type GenerateInput = z.infer<typeof GenerateSchema>;
export const OutputSchema = z.object({
  replies: z.array(z.object({ text: z.string().trim().min(2).max(240) }).strict()).length(3),
  warnings: z.array(z.string().trim().min(1).max(150)).max(4),
}).strict().refine(v => new Set(v.replies.map(r => r.text.replace(/[\p{P}\s]/gu, ''))).size === 3,
  '回复不能重复');
export type ModelOutput = z.infer<typeof OutputSchema>;
export type Reply = { id: string; text: string };
export type GenerationStatus = 'PROCESSING' | 'SUCCEEDED' | 'BLOCKED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
export type GenerationView = {
  generationId: string; status: GenerationStatus; replies?: Reply[]; warnings?: string[];
  label: string; remainingQuota: number; errorCode?: string; mode: 'cloud' | 'demo';
};
export type Profile = { id: string; alias: string; scene: GenerateInput['scene']; preferences: string;
  blockedTopics: string; version: number; createdAt: number };
export type Memory = { id: string; profileId: string; text: string; version: number; confirmedAt: number };
export type History = { id: string; generationId: string; profileId: string | null; message: string;
  scene: string; tone: string; replies: Reply[]; warnings: string[]; createdAt: number; expiresAt: number };
export type Settings = { historyEnabled: boolean; memoryEnabled: boolean };
export type ContentReviewStatus = { mode: 'external' | 'internal-test'; eligible: boolean; testUserId?: string };
export type Bootstrap = { settings: Settings; remainingQuota: number; policyVersion: string;
  accepted: boolean; mode: 'cloud' | 'demo'; enabled: boolean; provider: string; operator: string;
  support: string; status: string; chatDailyLimit: number; chatRemaining: number; contentReview?: ContentReviewStatus;
  screenshotDailyLimit?: number; screenshotRemaining?: number; globalDailyCallLimit?: number };
export type Envelope = { action: string; clientRequestId?: string; payload?: unknown };
export type ApiResult<T = unknown> = { ok: true; requestId: string; data: T } |
  { ok: false; requestId: string; error: { code: string; message: string; retryable: boolean } };
export const COPY_LABEL = '【AI生成】';
export function labelledText(text: string): string {
  return text.startsWith(COPY_LABEL) ? text : `${COPY_LABEL}\n${text}`;
}
