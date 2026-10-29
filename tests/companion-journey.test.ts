import { describe, expect, it } from 'vitest';
import { JOURNEY_INPUTS, runCompanionJourney, selectReferenceRows } from '../scripts/companion-journey';
import type { Provider } from '../src/server/service';
const rows = ['感觉今天好累', '刚看完一部电影', '你好', '今天超开心'].flatMap(user => ['我懂你', '然后呢'].map(girl => ({ user, girl, source: 'ChatRel synthetic_couple.json', language: 'zh' })));
describe('50-round live journey harness (all network mocked)', () => {
  it('can cap focused regression at6rounds without accidentally paying for50', async () => {
    let calls = 0;
    const provider: Provider = { name: 'TEST', generate: async () => ({ output: {} }), chat: async () => { calls++; return { output: { text: '嗯，在呢。' } }; } };
    const report = await runCompanionJourney(provider, selectReferenceRows(rows), { real: false, maxRounds: 6 });
    expect(calls).toBe(6); expect(report.targetRounds).toBe(6); expect(report.completed).toBe(true); expect(report.allApiSucceeded).toBe(true);
  });
  it('only selects small explicitly synthetic Chinese reference samples', () => {
    const selected = selectReferenceRows([...rows, { user: 'unrelated', girl: 'English', language: 'en', source: 'PersonaConflicts Corpus' }]);
    expect(selected.total).toBe(9); expect(selected.selected).toHaveLength(8); expect(selected.text).not.toContain('English');
    expect(selected.warning).toContain('not personal'); expect(JOURNEY_INPUTS).toHaveLength(50);
  });
  it('runs all50 route-level user rounds with isolated test accounts, no real money', async () => {
    let calls = 0;
    const provider: Provider = { name: 'TEST-ONLY', generate: async () => ({ output: {} }), chat: async () => { calls++; return { output: { text: '好，你慢慢说。' }, usage: { input: 1, output: 2 } }; } };
    const report = await runCompanionJourney(provider, selectReferenceRows(rows), { real: false });
    expect(report.completed).toBe(true); expect(report.completedRounds).toBe(50); expect(calls).toBe(50); expect(report.usage).toEqual({ input: 50, output: 100 });
    expect(report.assertions.every(c => c.pass)).toBe(true); expect(report.rounds.every(r => r.context?.isolationPassed)).toBe(true);
    expect(report.rounds.flatMap(r => r.checks.filter(c => c.name.includes('上下文为空'))).every(c => c.pass)).toBe(true);
  });
  it('stops on the first failed provider round and never invents missing rounds or silently retries', async () => {
    let calls = 0;
    const provider: Provider = { name: 'FAIL', generate: async () => ({ output: {} }), chat: async () => { calls++; throw new Error('test transport failure'); } };
    const report = await runCompanionJourney(provider, selectReferenceRows(rows), { real: false });
    expect(calls).toBe(1); expect(report.completed).toBe(false); expect(report.completedRounds).toBe(0); expect(report.rounds).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('test transport failure');
  });
  it('can explicitly continue to different inputs after format errors, without counting failures as successes', async () => {
    let calls = 0;
    const provider: Provider = { name: 'BAD-SCHEMA', generate: async () => ({ output: {} }), chat: async () => { calls++; return { output: { reply: 'wrong schema' } }; } };
    const report = await runCompanionJourney(provider, selectReferenceRows(rows), { real: false, continueFormatErrors: true });
    expect(calls).toBe(50); expect(report.executedRounds).toBe(50); expect(report.completed).toBe(true); expect(report.completedRounds).toBe(0); expect(report.allApiSucceeded).toBe(false);
  });
});
