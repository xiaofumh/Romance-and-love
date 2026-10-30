import type { GenerateInput, GenerationStatus, History, Memory, Profile, Reply, Settings } from '../shared/contracts';
import type { CompanionState } from '../shared/companion';
import type { ScreenshotJob } from '../shared/screenshot';

export type Generation = { id: string; payloadHash: string; status: GenerationStatus; createdAt: number;
  expiresAt: number; leaseUntil: number; dateKey: string; revision: number; input?: GenerateInput;
  profileId: string | null; replies?: Reply[]; warnings?: string[]; errorCode?: string;
  usage?: { input: number; output: number }; provider: string; promptVersion: string };
export type UserState = {
  id: string; status: 'ACTIVE' | 'DELETED'; revision: number; createdAt: number;
  consent?: { version: string; acceptedAt: number; withdrawnAt?: number };
  settingEvents: { purpose: string; enabled: boolean; at: number }[];
  settings: Settings; profiles: Profile[]; memories: Memory[]; histories: History[];
  generations: Generation[];
  companion?: CompanionState;
  screenshotJobs?: ScreenshotJob[];
  quota: { dateKey: string; used: number; reserved: number };
  rate: number[];
  feedback: { id: string; generationId: string; reason: string; createdAt: number }[];
  deletions: { id: string; scope: string; completedAt: number }[];
};
export function dateKey(now: number): string { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
// Keep the old text visible, but do not reuse it after a correction. This helper
// stays dependency-free so the scheduled cleanup does not bundle the app schema.
export function resetRoleContext(state: CompanionState, roleId: string, reason: string): void {
  for (const c of state.conversations.filter(c => c.roleId === roleId)) {
    c.contextAfterId = c.messages.at(-1)?.id; c.contextResetReason = reason;
    if (c.interaction) c.interaction.recentTopics = [];
  }
}
export function freshState(id: string, now: number): UserState {
  return { id, status: 'ACTIVE', revision: 0, createdAt: now, settingEvents: [],
    settings: { historyEnabled: false, memoryEnabled: false }, profiles: [], memories: [], histories: [],
    generations: [], quota: { dateKey: dateKey(now), used: 0, reserved: 0 }, rate: [], feedback: [], deletions: [] };
}
export function maintain(s: UserState, now: number): void {
  if (s.screenshotJobs) {
    s.screenshotJobs = s.screenshotJobs.filter(j => j.createdAt > now - 48 * 3600000);
    for (const j of s.screenshotJobs) if (j.status === 'PROCESSING' && j.leaseUntil <= now) j.status = 'FAILED';
  }
  if (s.companion) {
    const c = s.companion;
    const expired = new Set(c.documents.filter(d => d.expiresAt <= now).map(d => d.id));
    // Attached source documents expire too; relying on legacy documentId alone
    // would keep derived facts alive after their source had been removed.
    const expiredSource = (m: (typeof c.memories)[number]) => Boolean(m.documentId && expired.has(m.documentId)) || Boolean(m.sources?.some(s => s.documentId && expired.has(s.documentId)));
    const affected = new Set(c.memories.filter(expiredSource).map(m => m.roleId));
    c.documents = c.documents.filter(d => !expired.has(d.id));
    c.memories = c.memories.filter(m => !expiredSource(m));
    const liveMemories = new Set(c.memories.map(m => m.id));
    for (const j of c.jobs) if (j.metrics?.memorySelection) j.metrics.memorySelection.entries = j.metrics.memorySelection.entries.filter(e => liveMemories.has(e.id));
    const expiredMemories = c.memories.filter(m => m.expiresAt != null && m.expiresAt <= now && !m.expiryHandled);
    for (const m of expiredMemories) { m.expiryHandled = true; resetRoleContext(c, m.roleId, '短期记忆已过期，旧消息保留但不再作为上下文'); }
    for (const v of c.conversations) {
      if (affected.has(v.roleId) || v.messages.some(m => m.sources?.some(e => expired.has(e.documentId)))) {
        v.messages = []; if (v.interaction) v.interaction.recentTopics = [];
      }
      v.messages = v.messages.filter(m => m.createdAt > now - 30 * 86400000);
      if (!v.messages.length && v.interaction) v.interaction.recentTopics = [];
    }
    if (expired.size || expiredMemories.length) cancelPending(s);
    for (const j of c.jobs) if (j.status === 'PROCESSING' && j.leaseUntil <= now) { j.status = 'TIMED_OUT'; j.errorCode = 'PROVIDER_TIMEOUT'; }
    c.jobs = c.jobs.filter(j => j.createdAt > now - 48 * 3600000);
  }
  if (s.quota.dateKey !== dateKey(now)) s.quota = { dateKey: dateKey(now), used: 0, reserved: 0 };
  for (const g of s.generations) {
    if (g.status === 'PROCESSING' && g.leaseUntil <= now) {
      g.status = 'TIMED_OUT'; g.errorCode = 'PROVIDER_TIMEOUT'; delete g.input;
      if (g.dateKey === s.quota.dateKey) s.quota.reserved = Math.max(0, s.quota.reserved - 1);
    }
    if (g.expiresAt <= now) { delete g.input; delete g.replies; delete g.warnings; }
  }
  // Retain content-free idempotency tombstones for 48 hours, not indefinite chat text.
  s.generations = s.generations.filter(g => g.createdAt > now - 48 * 3600000);
  s.histories = s.histories.filter(h => h.expiresAt > now);
  s.rate = s.rate.filter(t => t > now - 60000);
  s.feedback = s.feedback.filter(f => f.createdAt > now - 90 * 86400000);
}
export function cancelPending(s: UserState): void {
  s.revision++;
  for (const j of s.companion?.jobs ?? []) if (j.status === 'PROCESSING') { j.status = 'CANCELLED'; j.errorCode = 'DATA_CHANGED'; }
  for (const g of s.generations) {
    if (g.status === 'PROCESSING') {
      g.status = 'CANCELLED'; g.errorCode = 'DATA_CHANGED';
      if (g.dateKey === s.quota.dateKey) s.quota.reserved = Math.max(0, s.quota.reserved - 1);
    }
    // Revoke all temporary snapshots so deleted facts cannot be recovered there.
    delete g.input; delete g.replies; delete g.warnings;
  }
}
export interface StateRepository {
  transact<T>(userId: string, now: number, operation: (state: UserState) => T): Promise<T>;
}
export class MemoryRepository implements StateRepository {
  private states = new Map<string, UserState>();
  private tail: Promise<unknown> = Promise.resolve();
  transact<T>(userId: string, now: number, operation: (state: UserState) => T): Promise<T> {
    const result = this.tail.then(() => {
      const state = clone(this.states.get(userId) ?? freshState(userId, now));
      maintain(state, now);
      const value = operation(state);
      this.states.set(userId, clone(state));
      return clone(value);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
export interface CallBudget { reserve(day: string, limit: number): Promise<boolean> }
export class MemoryBudget implements CallBudget {
  counts = new Map<string, number>();
  async reserve(day: string, limit: number): Promise<boolean> {
    const used = this.counts.get(day) ?? 0;
    if (used >= limit) return false;
    this.counts.set(day, used + 1); return true;
  }
}
