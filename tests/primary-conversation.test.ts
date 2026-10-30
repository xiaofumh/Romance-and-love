import { expect, it } from 'vitest';
import { primaryConversation } from '../src/server/primary-conversation';
import type { CompanionRole, Conversation } from '../src/shared/companion';
const role = (): CompanionRole => ({ id: 'r', name: '合成人格', personality: '温柔倾听', relationship: 'friend', description: '', boundaries: '', version: 1, createdAt: 1 });
const room = (id: string, updatedAt: number, populated = false, roleId = 'r'): Conversation => ({ id, roleId, title: id, createdAt: 1, updatedAt,
  messages: populated ? [{ id: 'm', requestId: id, speaker: 'user', text: '合成历史', createdAt: 1 }] : [] });
it('prefers the latest populated legacy room to empty duplicates and preserves every record', () => {
  const rows = [room('empty', 100), room('older', 1, true), room('latest', 2, true)], before = JSON.stringify(rows), r = role();
  expect(primaryConversation(r, rows)?.id).toBe('latest'); expect(rows[2]!.primary).toBe(true);
  expect(JSON.stringify(rows.map(({primary, ...v}) => v))).toBe(before);
  rows[1]!.updatedAt = 200;
  expect(primaryConversation(r, rows)?.id).toBe('latest');
});
it('does not cross a role boundary even if a stale pointer refers to another role', () => {
  const r = role();
  expect(primaryConversation(r, [room('foreign', 100, true, 'other'), room('own', 1)])?.id).toBe('own');
  expect(primaryConversation(role(), [room('foreign', 1, true, 'other')])).toBeUndefined();
});
it('selects empty legacy rooms deterministically independent of array order', () => {
  const a = room('a', 1), b = room('b', 1);
  expect(primaryConversation(role(), [b, a])?.id).toBe('a'); expect(primaryConversation(role(), [a, b])?.id).toBe('a');
});
