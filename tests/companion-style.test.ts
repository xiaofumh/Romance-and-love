import { describe, expect, it } from 'vitest';
import { companionDemoText } from '../src/shared/companion-demo';
import { displayChatText, referenceCaption, PERSONALITIES } from '../src/shared/companion';
import type { ChatContext } from '../src/server/companion-prompt';
const context: ChatContext = { role: { id: 'r', version: 1, createdAt: 1, name: '小小', relationship: 'partner', personality: '理性坦诚', description: '', boundaries: '' }, messages: [], memories: [], examples: [], message: '你好' };
describe('direct in-character chat presentation', () => {
  it('greets directly in every personality/relationship without boilerplate or mode prefixes', () => {
    for (const personality of PERSONALITIES) for (const relationship of ['friend', 'partner'] as const) {
      const text = companionDemoText({ ...context, role: { ...context.role, personality, relationship } });
      expect(text).not.toMatch(/我是|AI|模拟模板|伴侣角色|一起理一理/); expect(text.length).toBeLessThan(40);
    }
  });
  it('respects a short refusal instead of forcing analysis', () => {
    expect(companionDemoText({ ...context, message: '不' })).toBe('好，那就先不聊这个。你想说的时候，我听着。');
    expect(companionDemoText({ ...context, message: '不想说了' })).not.toMatch(/为什么|发生了什么|哪一部分|下结论/);
  });
  it('answers honestly when directly asked whether it is AI', () => {
    expect(companionDemoText({ ...context, message: '你是AI吗？' })).toContain('AI角色，不是真人');
  });
  it('does not mistake quoted greetings for a greeting to the character', () => {
    expect(companionDemoText({ ...context, message: '别人和我说你好，但我不想理他' })).not.toBe(companionDemoText(context));
  });
  it('only hides the exact legacy demo prefix in presentation and preserves source messages', () => {
    const m = { speaker: 'assistant' as const, mode: 'demo' as const, text: '【模拟模板，非真实模型】你好，我在。' };
    expect(displayChatText(m)).toBe('你好，我在。'); expect(m.text).toContain('【模拟模板');
    expect(displayChatText({ ...m, mode: 'cloud' })).toBe(m.text);
    expect(displayChatText({ ...m, speaker: 'user' })).toBe(m.text);
  });
  it('responds distinctly to the exact screenshot sequence instead of returning one catch-all template', () => {
    const texts = ['是你？', '？', '你是什么人'].map(message => companionDemoText({ ...context, message }));
    expect(new Set(texts).size).toBe(3); expect(texts[2]).toContain('小小'); expect(texts[2]).toContain('AI角色');
    expect(texts).not.toContain('嗯，我听着。你最在意的是哪一件事？');
  });
  it('does not repeat a generic fallback on consecutive demo turns but still remains fixed fixture behavior', () => {
    const first = companionDemoText({ ...context, message: '未覆盖的第一句' });
    const second = companionDemoText({ ...context, message: '未覆盖的第二句', messages: [{ speaker: 'assistant', text: first }] });
    expect(second).not.toBe(first);
  });
  it('never labels local or unknown references as submitted to a model', () => {
    expect(referenceCaption('demo')).toContain('未送入模型'); expect(referenceCaption(undefined)).toContain('未核实');
    expect(referenceCaption('cloud')).toBe('本轮提交模型的参考');
  });
});
