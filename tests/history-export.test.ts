import { expect, it } from 'vitest';
import { streamHistoryExport } from '../src/miniprogram/services/history-export';
import type { HistoryPage } from '../src/shared/history';

it('streams all history pages as valid JSON without keeping all messages in the export metadata', async () => {
  const chunks: string[] = [], calls: string[] = [];
  const messages = Array.from({ length: 85 }, (_, i) => ({ id: 'm' + i, requestId: 'q' + i, speaker: 'user' as const, text: '原文' + i, createdAt: i }));
  await streamHistoryExport({ exportedAt: 100, historyPaged: true, roles: [], conversations: [{ id: 'c', roleId: 'r', title: '合成会话', createdAt: 0, updatedAt: 100, messages: messages.slice(-3), history: { epoch: 1, nextSequence: 85 } }] }, async (id, cursor) => {
    calls.push(id); const end = cursor ? messages.findIndex(m => m.id === cursor.beforeId) : messages.length;
    const pageMessages = messages.slice(Math.max(0, end - 40), end), hasMore = end > 40;
    return { messages: pageMessages, hasMore, epoch: 1, ...(hasMore ? { cursor: { epoch: 1, beforeId: pageMessages[0]!.id } } : {}) };
  }, async chunk => { chunks.push(chunk); });
  const result = JSON.parse(chunks.join('')); expect(calls).toHaveLength(3);
  expect(result.conversations[0].messages).toHaveLength(85); expect(result.messageOrder).toBe('newest-first');
  expect(result.conversations[0].messages[0].id).toBe('m84'); expect(result.conversations[0].messages[84].id).toBe('m0');
});
it('stops if privacy generation changes or pagination repeats, rather than exporting incomplete history as success', async () => {
  const input = { exportedAt: 100, historyPaged: true, conversations: [{ id: 'c', roleId: 'r', title: '', createdAt: 0, updatedAt: 100, messages: [], history: { epoch: 1, nextSequence: 5 } }] };
  await expect(streamHistoryExport(input, async () => ({ messages: [], epoch: 2, hasMore: false }), async () => {})).rejects.toThrow('已清理');
  await expect(streamHistoryExport(input, async () => ({ messages: [], epoch: 1, hasMore: true } as HistoryPage), async () => {})).rejects.toThrow('未前进');
});
