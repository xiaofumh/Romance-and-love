import { HISTORY_COLLECTION, TAIL_COLLECTION, HISTORY_GC_COLLECTION, historyKey } from './history-storage';
import type { HistoryDb, StoredMessage } from './history-storage';

// 用户删除后旧epoch立即不可读；物理删除分批执行，避免一个超大历史
// 删除事务超时。到期消息也独立清理，不依赖用户再次打开聊天页。
export async function cleanupHistory(db: HistoryDb, now: number) {
  if (!db.collection || !db.command) return { retired: 0, expired: 0 };
  let retired = 0, expired = 0;
  const tasks = await db.collection(HISTORY_GC_COLLECTION).limit(5).get();
  for (const task of tasks.data) {
    const rows = await db.collection(HISTORY_COLLECTION).where({ ownerId: task.ownerId, conversationId: task.conversationId, epoch: task.epoch }).limit(20).get();
    retired += await db.runTransaction(async tx => {
      const owner = (await tx.collection('assistant_users').doc(task.ownerId).get()).data;
      const active = owner?.state?.status === 'ACTIVE' && owner.state.companion?.conversations.some((c: any) => c.id === task.conversationId && c.history?.epoch === task.epoch);
      if (active) { await tx.collection(HISTORY_GC_COLLECTION).doc(task._id).remove!(); return 0; }
      let removed = 0;
      for (const row of rows.data as (StoredMessage & { _id: string })[]) {
        if (row.ownerId !== task.ownerId || row.conversationId !== task.conversationId || row.epoch !== task.epoch) continue;
        const id = historyKey(row.ownerId, row.conversationId, row.epoch, row.message.id);
        if (id !== row._id) continue;
        await tx.collection(HISTORY_COLLECTION).doc(id).remove!(); removed++;
      }
      if (rows.data.length < 20) {
        await tx.collection(TAIL_COLLECTION).doc(historyKey(task.ownerId, task.conversationId, task.epoch, 'tail')).remove!();
        await tx.collection(HISTORY_GC_COLLECTION).doc(task._id).remove!();
      }
      return removed;
    });
  }
  const rows = await db.collection(HISTORY_COLLECTION).where({ expiresAt: db.command.lte(now) }).limit(40).get();
  for (const row of rows.data) expired += await db.runTransaction(async tx => {
    const doc = tx.collection(HISTORY_COLLECTION).doc(row._id), current = (await doc.get()).data as StoredMessage | undefined;
    if (current && current.expiresAt <= now) { await doc.remove!(); return 1; }
    return 0;
  });
  return { retired, expired };
}
