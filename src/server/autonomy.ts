import type { UserState } from './state';
import { dateKey } from './state';
import { POLICY_VERSION } from '../shared/policy';
import { initiativeStatus } from '../shared/interaction';
export const NO_INITIATIVE = Number.MAX_SAFE_INTEGER;
export const AUTONOMOUS_DAILY_LIMIT = 6;
export function nextAutonomousWake(s: UserState, now: number): number {
  const candidate = nextAutonomousConversation(s, now); if (candidate) return candidate.dueAt;
  if (s.status !== 'ACTIVE' || s.consent?.version !== POLICY_VERSION || s.consent.withdrawnAt != null || !s.settings.historyEnabled
    || !s.companion?.roles.some(r => r.autonomousEnabled && r.proactiveEnabled)) return NO_INITIATIVE;
  const leases = s.companion.jobs.filter(j => j.status === 'PROCESSING').map(j => j.leaseUntil + 1000);
  return leases.length ? Math.min(...leases) : NO_INITIATIVE;
}
export function nextAutonomousConversation(s: UserState, now: number): { id: string; dueAt: number; attempt: number; userRequestId: string } | undefined {
  if (s.status !== 'ACTIVE' || s.consent?.version !== POLICY_VERSION || s.consent.withdrawnAt != null || !s.settings.historyEnabled || !s.companion) return;
  const c = s.companion;
  if (c.jobs.some(j => j.status === 'PROCESSING')) return;
  const candidates = c.conversations.filter(v => v.primary === true).flatMap(v => {
    const role = c.roles.find(r => r.id === v.roleId);
    if (!role?.autonomousEnabled || !role.proactiveEnabled) return [];
    if (c.jobs.filter(j => j.roleId === role.id && j.kind === 'initiative' && j.day === dateKey(now)).length >= AUTONOMOUS_DAILY_LIMIT) return [];
    const user = [...v.messages].reverse().find(m => m.speaker === 'user');
    if (!user || user.createdAt <= now - 24 * 3600000 || v.contextAfterId === v.messages.at(-1)?.id) return [];
    const status = initiativeStatus(v, role, now, s.settings.memoryEnabled);
    if (!['ready', 'waiting', 'composing'].includes(status.reason)) return [];
    const hour = new Date(now + 8 * 3600000).getUTCHours(), day = Math.floor((now + 8 * 3600000) / 86400000);
    const quietUntil = hour < 8 ? day * 86400000 : hour >= 23 ? (day + 1) * 86400000 : 0;
    const attempt = v.interaction?.autonomousCycle?.requestId === user.requestId ? v.interaction.autonomousCycle.attempts : 0;
    return [{ id: v.id, dueAt: Math.max(status.availableAt, quietUntil), attempt, userRequestId: user.requestId }];
  });
  return candidates.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))[0];
}
