import { nextAutonomousConversation } from '../server/autonomy';
import type { StateRepository } from '../server/state';
type TickDb = { command: { lte(n: number): unknown }; collection(name: string): { where(q: unknown): { limit(n: number): { get(): Promise<{ data: { _id: string }[] }> } } } };
// At most one provider attempt per invocation; ordinary send and timer races use
// the same account transaction and deterministic request id, never a paid retry.
export async function autonomyTick(db: TickDb, repo: StateRepository, handle: (uid: string, event: unknown) => Promise<any>, hash: (s: string) => string, now = Date.now()) {
  const rows = await db.collection('assistant_users').where({ initiativeDueAt: db.command.lte(now) }).limit(1).get();
  const row = rows.data[0]; if (!row) return { ok: true, processed: 0 };
  const candidate = await repo.transact(row._id, now, s => nextAutonomousConversation(s, now));
  if (!candidate || candidate.dueAt > now) return { ok: true, processed: 0 };
  let result;
  try { result = await handle(row._id, { action: 'companion.initiative', payload: { conversationId: candidate.id },
    clientRequestId: 'auto_' + hash(`${candidate.id}:${candidate.userRequestId}:${candidate.attempt}`).slice(0, 48) }); }
  catch { result = { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } }; }
  // “没有合适话题”也要推迟，否则同一个到期用户每分钟占住队头。
  // 若此时已有新用户消息，不能让旧任务的失败暂停新的相处周期。
  if (!result.ok && !['DATA_CHANGED', 'CHAT_PENDING'].includes(result.error?.code)) await repo.transact(row._id, now, s => {
    const c = s.companion?.conversations.find(v => v.id === candidate.id);
    if (c && [...c.messages].reverse().find(m => m.speaker === 'user')?.requestId === candidate.userRequestId)
      c.interaction = { ...c.interaction, mode: c.interaction?.mode ?? 'listening', backgroundRetryAfter: now + 3600000 };
  });
  return { ok: true, processed: 1, succeeded: result.ok, status: result.ok ? result.data?.job?.status : 'DEFERRED' };
}
