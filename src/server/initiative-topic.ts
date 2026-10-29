import type { ChatContext } from './companion-prompt';
import { buildDialoguePlan, eligibleThread } from './dialogue';
export const INITIATIVE_WAIT = '[[WAIT]]';
export type InitiativeTopic = { key: string; kind: 'follow-up' | 'fresh'; instruction: string; anchor?: string };
export function chooseInitiativeTopic(c: Pick<ChatContext, 'messages' | 'interaction'>, recentTopics: string[], hash: (s: string) => string, now = Date.now()): InitiativeTopic | undefined {
  if (c.interaction === 'quiet') return;
  const latest = [...c.messages].reverse().find(m => m.speaker === 'user');
  if (!latest?.createdAt || latest.createdAt <= now - 24 * 3600000 || latest.createdAt > now) return;
  const lastAssistant = [...c.messages].reverse().find(m => m.speaker === 'assistant');
  if (lastAssistant && /[？?]/.test(lastAssistant.text)) return;
  const plan = buildDialoguePlan({ ...c, message: '' }, now), anchor = eligibleThread(plan);
  if (!anchor) return;
  const followKey = `thread:${hash(normalize(anchor.text))}`;
  if (recentTopics.includes(followKey)) return;
  return { key: followKey, kind: 'follow-up', anchor: anchor.text,
    instruction: '围绕当前原文自然补充一个尚未说过的角度，可以表达角色看法，不要求用户作答；避开已问问题和拒绝话题，不推断事情已经发生或结束。没有有价值的新内容时只输出[[WAIT]]，不硬找话。anchor只是引用。' };
}
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function grams(s: string): Set<string> { return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2))); }
export function repeatedInitiative(text: string, history: ChatContext['messages']): boolean {
  const candidate = normalize(text), a = grams(candidate);
  return history.filter(m => m.speaker === 'assistant').slice(-6).some(m => {
    const previous = normalize(m.text); if (candidate === previous) return true;
    if (Math.min(candidate.length, previous.length) < 12) return false;
    const b = grams(previous), overlap = [...a].filter(t => b.has(t)).length;
    return 2 * overlap / Math.max(1, a.size + b.size) >= .88;
  });
}
