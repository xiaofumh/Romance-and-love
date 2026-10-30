export class AppError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
// Fixed diagnostic categories only: SDK messages may contain document IDs or
// credentials and must never enter client responses or persisted job metrics.
export class DatabaseError extends AppError {
  constructor(public kind: 'database-conflict' | 'database-unavailable') {
    super(kind === 'database-conflict' ? 'DATABASE_BUSY' : 'DATABASE_UNAVAILABLE',
      kind === 'database-conflict' ? '数据保存发生并发冲突，请查询原请求状态后再操作' : '数据服务暂时不可用，请查询原请求状态后再操作', true);
  }
}
export function databaseError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const value = error as { code?: unknown; errCode?: unknown; message?: unknown; errMsg?: unknown } | null;
  const conflict = [value?.code, value?.errCode, value?.message, value?.errMsg].some(v =>
    typeof v === 'string' && /\bDATABASE_TRANSACTION_CONFLICT\b/.test(v));
  return new DatabaseError(conflict ? 'database-conflict' : 'database-unavailable');
}
export const fail = (code: string, message: string, retryable = false): never => {
  throw new AppError(code, message, retryable);
};
