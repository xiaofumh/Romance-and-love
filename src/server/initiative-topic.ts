import type { ChatContext } from './companion-prompt';
import { buildDialoguePlan, eligibleThread } from './dialogue';
export const INITIATIVE_WAIT = '[[WAIT]]';
export type InitiativeTopic = { key: string; kind: 'follow-up' | 'fresh'; instruction: string; anchor?: string };
export function chooseInitiativeTopic(c: Pick<ChatContext, 'messages' | 'interaction'>, recentTopics: string[], hash: (s: string) => string, now = Date.now(), autonomous = false): InitiativeTopic | undefined {
  if (c.interaction === 'quiet') return;
  const latest = [...c.messages].reverse().find(m => m.speaker === 'user');
  if (!latest?.createdAt || latest.createdAt <= now - 24 * 3600000 || latest.createdAt > now) return;
  const lastAssistant = [...c.messages].reverse().find(m => m.speaker === 'assistant');
  if (!autonomous && lastAssistant && /[？?]/.test(lastAssistant.text)) return;
  const plan = buildDialoguePlan({ ...c, message: '' }, now), anchor = eligibleThread(plan);
  if (autonomous) {
    if (plan.ledger.declinedTopics.length && !anchor) return;
    if (/^(?:晚安|再见|不聊了|先不聊了|我先忙|先不说了|不想聊|不想说)/.test(latest.text.trim())) return;
    return { key: `auto:${hash(latest.text)}:${recentTopics.length}`, kind: anchor ? 'follow-up' : 'fresh', anchor: anchor?.text ?? latest.text,
      instruction: '这是用户允许的持续主动聊天。结合人格、称呼、当前会话与已确认记忆，自行判断此刻是否有自然的新内容，可以短短接几句或换个轻量角度；不要重复已有问题、催促回复、推断用户心情或虚构线下行动。不要每次都提问，不用依赖、生死、内疚或充值压力。没有合适内容、用户想留白时仅输出[[WAIT]]。' };
  }
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
