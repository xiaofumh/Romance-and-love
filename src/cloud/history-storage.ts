import { createHash } from 'node:crypto';
import type { ChatMessage, Conversation } from '../shared/companion';
import { HISTORY_POLICY, inlineHistoryPage } from '../shared/history';
import type { HistoryCursor, HistoryMessage, HistoryPage } from '../shared/history';
import type { UserState } from '../server/state';
import { AppError } from '../server/errors';

export const HISTORY_COLLECTION = 'assistant_chat_messages';
export const TAIL_COLLECTION = 'assistant_chat_tails';
export const HISTORY_GC_COLLECTION = 'assistant_chat_cleanup';
export const historyKey = (uid: string, cid: string, epoch: number, suffix: string) => createHash('sha256').update(JSON.stringify([uid, cid, epoch, suffix])).digest('hex');
type Doc = { get(): Promise<{ data?: any }>; set(v: { data: any }): Promise<unknown>; remove?(): Promise<unknown> };
export type HistoryTransaction = { collection(name: string): { doc(id: string): Doc } };
export type HistoryDb = { runTransaction<T>(f: (tx: HistoryTransaction) => Promise<T>): Promise<T>; collection?: (name: string) => any; command?: any };
export type StoredMessage = { ownerId: string; conversationId: string; epoch: number; sequence: number; message: ChatMessage; expiresAt: number };
async function read(doc: Doc): Promise<any> {
  try { return (await doc.get()).data; }
  catch (e) { const x = e as any; if (/DOCUMENT_NOT_EXIST|文档不存在|document.*(?:not exist|not found)/i.test(`${x?.code ?? ''} ${x?.errCode ?? ''} ${x?.message ?? ''}`)) return undefined; throw e; }
}
export async function hydrateHistory(tx: HistoryTransaction, uid: string, s: UserState): Promise<void> {
  for (const c of s.companion?.conversations ?? []) if (c.history) {
    const tail = await read(tx.collection(TAIL_COLLECTION).doc(historyKey(uid, c.id, c.history.epoch, 'tail')));
    if (!tail || tail.ownerId !== uid || tail.conversationId !== c.id || tail.epoch !== c.history.epoch)
      throw new AppError('HISTORY_UNAVAILABLE', '聊天工作记录暂时不可用，未覆盖原数据', true);
    c.messages = tail.messages;
  }
}
/** 所有消息写入、缓存更新、用户状态在同一事务提交。失败时旧结构仍在，
 * 不先清空旧正文再补写归档。每次最多迁移60条，控制在100操作内。
 */
export async function persistHistory(tx: HistoryTransaction, uid: string, before: UserState, s: UserState, now: number) {
  const writes: { doc: Doc; data: unknown }[] = [], previous = before.companion?.conversations ?? [];
  let migrated = 0;
  const conversations = [...(s.companion?.conversations ?? [])].sort((a, b) => Number(previous.some(v => v.id === a.id)) - Number(previous.some(v => v.id === b.id)));
  for (const c of conversations) {
    const old = previous.find(v => v.id === c.id), freshBefore = old?.messages.filter(m => m.createdAt > now - HISTORY_POLICY.retentionMs) ?? [];
    const removed = old?.history && freshBefore.some(m => !c.messages.some(n => n.id === m.id));
    let reset = Boolean(removed), epoch = old?.history?.epoch ?? 1;
    if (reset) epoch++;
    const initialize = !old?.history || reset;
    if (initialize && c.messages.length + migrated > HISTORY_POLICY.migrationBatch) {
      // 尚未完成迁移的记录继续保留旧正文，绝不能仅留下一个空的归档指针。
      if (!old?.history) { delete c.history; for (const m of c.messages) delete m.sequence; }
      continue;
    }
    if (initialize) {
      migrated += c.messages.length; c.history = { epoch, nextSequence: 0 };
      for (const m of c.messages) delete m.sequence;
    }
    c.referenceDocumentIds = [...new Set([...(reset ? [] : c.referenceDocumentIds ?? []), ...c.messages.flatMap(m => m.sources?.map(s => s.documentId) ?? [])])];
    const history = c.history!;
    for (const m of c.messages) if (m.sequence == null) {
      m.sequence = history.nextSequence++;
      const data: StoredMessage = { ownerId: uid, conversationId: c.id, epoch, sequence: m.sequence, message: m, expiresAt: m.createdAt + HISTORY_POLICY.retentionMs };
      writes.push({ doc: tx.collection(HISTORY_COLLECTION).doc(historyKey(uid, c.id, epoch, m.id)), data });
    }
    const tail = c.messages.slice(-HISTORY_POLICY.workingMessages);
    if (initialize || JSON.stringify(tail) !== JSON.stringify(old?.messages)) writes.push({
      doc: tx.collection(TAIL_COLLECTION).doc(historyKey(uid, c.id, epoch, 'tail')),
      data: { ownerId: uid, conversationId: c.id, epoch, messages: tail, updatedAt: now },
    });
    c.messages = tail;
  }
  for (const old of previous) if (old.history && !s.companion?.conversations.some(c => c.id === old.id && c.history?.epoch === old.history!.epoch)) {
    writes.push({ doc: tx.collection(HISTORY_GC_COLLECTION).doc(historyKey(uid, old.id, old.history.epoch, 'gc')),
      data: { ownerId: uid, conversationId: old.id, epoch: old.history.epoch, createdAt: now } });
  }
  // Reads: root + at most18 tails; mutations here are bounded. Fail before any
  // write if a future bulk operation exceeds this adapter's atomic budget.
  if (writes.length > 75) throw new AppError('HISTORY_BUSY', '聊天迁移批次较大，请稍后重试', true);
  for (const w of writes) await w.doc.set({ data: JSON.parse(JSON.stringify(w.data)) });
}
export function storedState(s: UserState): UserState {
  const copy = JSON.parse(JSON.stringify(s)) as UserState;
  for (const c of copy.companion?.conversations ?? []) if (c.history) c.messages = [];
  return copy;
}
async function member(tx: HistoryTransaction, uid: string, cid: string) {
  const row = await read(tx.collection('assistant_users').doc(uid)), s = row?.state as UserState | undefined;
  if (s?.status !== 'ACTIVE') throw new AppError('RESOURCE_UNAVAILABLE', '会话不存在或无权访问');
  const c = s.companion?.conversations.find(v => v.id === cid);
  if (!c) throw new AppError('RESOURCE_UNAVAILABLE', '会话不存在或无权访问');
  return c;
}
export async function readHistoryMessage(db: HistoryDb, uid: string, now: number, cid: string, id: string): Promise<HistoryMessage> {
  return db.runTransaction(async tx => {
    const c = await member(tx, uid, cid), epoch = c.history?.epoch ?? 0;
    const row = c.history ? await read(tx.collection(HISTORY_COLLECTION).doc(historyKey(uid, cid, epoch, id))) as StoredMessage | undefined : undefined;
    const message = c.history ? row?.ownerId === uid && row.conversationId === cid && row.epoch === epoch ? row.message : undefined : c.messages.find(m => m.id === id);
    return { epoch, roleId: c.roleId, ...(message && message.createdAt > now - HISTORY_POLICY.retentionMs ? { message } : {}) };
  });
}
export async function readHistoryPage(db: HistoryDb, uid: string, now: number, cid: string, cursor?: HistoryCursor): Promise<HistoryPage> {
  const c = await db.runTransaction(tx => member(tx, uid, cid));
  if (!c.history) return inlineHistoryPage(c, now, cursor);
  const epoch = c.history.epoch;
  if (cursor && cursor.epoch !== epoch && !(cursor.epoch === 0 && epoch === 1)) throw new AppError('DATA_CHANGED', '会话历史已清理，请重新加载');
  let before = c.history.nextSequence;
  if (cursor) {
    const anchor = await readHistoryMessage(db, uid, now, cid, cursor.beforeId);
    if (anchor.epoch !== epoch || !anchor.message) throw new AppError('DATA_CHANGED', '分页位置已过期，请重新加载');
    before = anchor.message.sequence!;
  }
  if (!db.collection || !db.command) throw new AppError('HISTORY_UNAVAILABLE', '历史查询暂时不可用', true);
  const rows = await db.collection(HISTORY_COLLECTION).where({ ownerId: uid, conversationId: cid, epoch,
    sequence: db.command.lt(before), expiresAt: db.command.gt(now) }).orderBy('sequence', 'desc').limit(HISTORY_POLICY.pageSize + 1).get();
  // Query filters are not the only access check: recheck after the read so a
  // concurrent privacy reset cannot republish a now-obsolete generation.
  const current = await db.runTransaction(tx => member(tx, uid, cid));
  if (current.history?.epoch !== epoch) throw new AppError('DATA_CHANGED', '会话历史已清理，请重新加载');
  const valid = (rows.data as StoredMessage[]).filter(r => r.ownerId === uid && r.conversationId === cid && r.epoch === epoch && r.expiresAt > now && r.sequence < before);
  const messages = valid.slice(0, HISTORY_POLICY.pageSize).map(r => r.message).reverse(), hasMore = valid.length > HISTORY_POLICY.pageSize;
  return { messages, hasMore, epoch, ...(hasMore && messages[0] ? { cursor: { epoch, beforeId: messages[0].id } } : {}) };
}
