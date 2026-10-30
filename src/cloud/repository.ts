import { freshState, maintain } from '../server/state';
import type { StateRepository, UserState, CallBudget } from '../server/state';
import { STORAGE_LIMITS } from '../shared/limits';
import { AppError, databaseError } from '../server/errors';
import { nextAutonomousWake } from '../server/autonomy';
import { hydrateHistory, persistHistory, storedState, readHistoryMessage, readHistoryPage } from './history-storage';

// Minimal SDK surface; checked with a contract fake and requires live CloudBase validation before release.
export type Db = { runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T>; collection?: (name: string) => any; command?: any };
type Document = { get(): Promise<{ data?: unknown }>; set(input: { data: unknown }): Promise<unknown> };
type Transaction = { collection(name: string): { doc(id: string): Document } };
function missing(error: unknown): boolean {
  const e = error as { errCode?: number | string; code?: number | string; message?: string };
  return e?.code === 'DOCUMENT_NOT_EXIST' || e?.errCode === 'DOCUMENT_NOT_EXIST' ||
    /document(?:\.get)?[^\n]*(?:not exist|not found)|document_not_exist|文档不存在/i.test(e?.message ?? '');
}
async function read<T>(doc: Document): Promise<T | undefined> {
  try { const result = await doc.get(); return result.data == null ? undefined : JSON.parse(JSON.stringify(result.data)) as T; }
  catch (e) { if (missing(e)) return undefined; throw e; }
}
// 根文档保存角色/授权/任务元数据；正文与近期工作缓存分开保存。
// 三者仍在同一事务提交，客户端不直接访问任何数据库集合。
export function cloudRepository(db: Db, options: { touchUnchanged?: boolean } = {}): StateRepository {
  return { async transact<T>(uid: string, now: number, operation: (s: UserState) => T): Promise<T> {
    let logicFailed = false, logicError: unknown;
    try { return await db.runTransaction(async transaction => {
      logicFailed = false;
      const doc = transaction.collection('assistant_users').doc(uid);
      const stored = await read<{ state: UserState; initiativeDueAt?: number }>(doc);
      const before = stored?.state == null ? undefined : JSON.stringify(stored.state);
      const state = stored?.state ?? freshState(uid, now);
      await hydrateHistory(transaction, uid, state);
      const observed = JSON.parse(JSON.stringify(state)) as UserState;
      let result: T, encoded: string;
      try {
        maintain(state, now); result = operation(state);
      } catch (error) { logicFailed = true; logicError = error; throw error; }
      try { await persistHistory(transaction, uid, observed, state, now); }
      catch (error) { if (error instanceof AppError) { logicFailed = true; logicError = error; } throw error; }
      try {
        encoded = JSON.stringify(storedState(state));
        if (Buffer.byteLength(encoded) > STORAGE_LIMITS.userBytes)
          throw new AppError('STORAGE_LIMIT', '账号总存储空间已满，请先导出并清理旧内容');
      } catch (error) { logicFailed = true; logicError = error; throw error; }
      // Observational polls must not rewrite the same large user document.
      // Maintenance and actual mutations still commit atomically. Cleanup opts
      // into touching scan timestamps so an unchanged first page cannot starve it.
      const initiativeDueAt = nextAutonomousWake(state, now);
      if (options.touchUnchanged || before !== encoded || stored?.initiativeDueAt !== initiativeDueAt)
        await doc.set({ data: { state: JSON.parse(encoded), updatedAt: now, initiativeDueAt } });
      return result;
    }); } catch (error) { if (logicFailed && error === logicError) throw error; throw databaseError(error); }
  },
    async historyPage(uid, now, conversationId, cursor) {
      try { return await readHistoryPage(db, uid, now, conversationId, cursor); }
      catch (e) { if (e instanceof AppError) throw e; throw databaseError(e); }
    },
    async historyMessage(uid, now, conversationId, messageId) {
      try { return await readHistoryMessage(db, uid, now, conversationId, messageId); }
      catch (e) { if (e instanceof AppError) throw e; throw databaseError(e); }
    },
  };
}
export function cloudBudget(db: Db): CallBudget {
  return { async reserve(day: string, limit: number): Promise<boolean> {
    try { return await db.runTransaction(async transaction => {
      const doc = transaction.collection('assistant_budgets').doc(day);
      const current = await read<{ calls: number }>(doc);
      const calls = current?.calls ?? 0;
      if (calls >= limit) return false;
      await doc.set({ data: { calls: calls + 1, dateKey: day, updatedAt: Date.now() } }); return true;
    }); } catch (error) { throw databaseError(error); }
  } };
}
