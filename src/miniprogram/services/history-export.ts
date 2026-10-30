import type { Conversation } from '../../shared/companion';
import type { HistoryCursor, HistoryPage } from '../../shared/history';
export type CompanionExport = { exportedAt: number; historyPaged?: boolean; conversations: Conversation[]; [key: string]: unknown };

// 每次只持有一页正文，直接追加到用户主动导出的文件。全量历史不重新
// 塞回账号状态，也不因为“导出”再次调用模型。导出顺序明确为新到旧。
export async function streamHistoryExport(data: CompanionExport, readPage: (id: string, cursor?: HistoryCursor) => Promise<HistoryPage>, write: (chunk: string) => Promise<void>) {
  if (!data.historyPaged) { await write(JSON.stringify(data)); return; }
  const { conversations, ...header } = data;
  await write(JSON.stringify({ ...header, formatVersion: 'chat-history-v2', messageOrder: 'newest-first' }).slice(0, -1) + ',"conversations":[');
  for (let i = 0; i < conversations.length; i++) {
    const { messages: _cache, ...conversation } = conversations[i]!;
    await write((i ? ',' : '') + JSON.stringify(conversation).slice(0, -1) + ',"messages":[');
    let cursor: HistoryCursor | undefined, first = true;
    do {
      const page = await readPage(conversation.id, cursor);
      if (conversation.history && page.epoch !== conversation.history.epoch) throw new Error('历史已清理，导出已停止，请重新操作');
      const messages = page.messages.filter(m => m.createdAt <= data.exportedAt).slice().reverse();
      if (messages.length) { await write((first ? '' : ',') + messages.map(m => JSON.stringify(m)).join(',')); first = false; }
      if (page.hasMore && (!page.cursor || page.cursor.beforeId === cursor?.beforeId)) throw new Error('历史分页未前进，导出已停止');
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    await write(']}');
  }
  await write(']}');
}
