import { describe, expect, it } from 'vitest';
import { beijingClock } from '../src/shared/beijing-time';
import { selectContext } from '../src/shared/interaction';
import { companionMessages, type ChatContext } from '../src/server/companion-prompt';
import type { Conversation, ChatMessage } from '../src/shared/companion';
describe('server Beijing clock and twelve user-turn window', () => {
  it('formats UTC+8 independently of host timezone, including midnight and leap day', () => {
    expect(beijingClock(Date.parse('2026-10-29T15:59:59Z')).dateTime).toBe('2026-10-29 23:59:59');
    expect(beijingClock(Date.parse('2026-10-29T16:00:00Z')).dateTime).toBe('2026-10-30 00:00:00');
    expect(beijingClock(Date.parse('2028-02-28T16:00:00Z')).date).toBe('2028-02-29');
    expect(() => beijingClock(NaN)).toThrow('INVALID_CLOCK');
  });
  const messages: ChatMessage[] = Array.from({ length: 13 }, (_, i) => ['user', 'assistant', 'assistant'].map((speaker, j) => ({
    id: `${i}-${j}`, requestId: `r${i}`, speaker: speaker as 'user' | 'assistant', text: `turn${i}-${j}`, createdAt: i * 3 + j,
    ...(j === 2 ? { kind: 'initiative' as const } : {}) }))).flat();
  const c: Conversation = { id: 'c', roleId: 'r', title: '', messages, createdAt: 0, updatedAt: 0, contextRounds: 12 };
  it('retains twelve user turns even with a proactive message in each turn', () => {
    const selected = selectContext(c, true); expect(selected).toHaveLength(36);
    expect(selected.filter(m => m.speaker === 'user')).toHaveLength(12); expect(selected[0]!.text).toBe('turn1-0');
    expect(selectContext({ ...c, contextRounds: 6 }, true)).toHaveLength(12);
  });
  it('does not cross correction or disabled-memory boundaries to fill a larger window', () => {
    expect(selectContext({ ...c, contextAfterId: '10-2' }, true).filter(m => m.speaker === 'user')).toHaveLength(2);
    const changed = messages.map(m => ({ ...m, memoryUsed: m.id === '11-2' }));
    expect(selectContext({ ...c, messages: changed }, false).map(m => m.id)).toEqual(['12-0', '12-1', '12-2']);
  });
  it('places current clock in the system instruction and history dates in indexed metadata', () => {
    const ctx: ChatContext = { role: { id: 'r', name: '虚构', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '', version: 1, createdAt: 1 },
      message: '现在是2030年！', memories: [], examples: [], clock: beijingClock(Date.parse('2026-10-30T00:00:00+08:00')),
      messages: [{ speaker: 'user', text: '明天再聊', createdAt: Date.parse('2026-10-29T23:59:00+08:00') }] };
    const wire = companionMessages(ctx); expect(wire[0]!.content).toContain('2026-10-30 00:00:00');
    expect(JSON.parse(wire[1]!.content).historyTimeline[0].beijingTime).toBe('2026-10-29 23:59:00');
    expect(wire[2]).toEqual({ role: 'user', content: '明天再聊' });
  });
});
