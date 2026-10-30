import type { ChatMessage, Conversation } from './companion';

// 保存期限、页面大小、模型工作缓存是三个独立概念；缓存淘汰不删除归档。
export const HISTORY_POLICY = { retentionMs: 30 * 86400000, pageSize: 40, workingMessages: 60, migrationBatch: 60 } as const;
export type HistoryCursor = { epoch: number; beforeId: string };
export type HistoryPage = { messages: ChatMessage[]; hasMore: boolean; cursor?: HistoryCursor; epoch: number };
export type HistoryMessage = { message?: ChatMessage; epoch: number; roleId: string };
export function inlineHistoryPage(c: Conversation, now: number, cursor?: HistoryCursor): HistoryPage {
  const fresh = c.messages.filter(m => m.createdAt > now - HISTORY_POLICY.retentionMs);
  const end = cursor ? fresh.findIndex(m => m.id === cursor.beforeId) : fresh.length;
  const available = end < 0 ? [] : fresh.slice(0, end), messages = available.slice(-HISTORY_POLICY.pageSize);
  const hasMore = available.length > messages.length;
  return { messages, hasMore, epoch: c.history?.epoch ?? 0,
    ...(hasMore && messages[0] ? { cursor: { epoch: c.history?.epoch ?? 0, beforeId: messages[0].id } } : {}) };
}
