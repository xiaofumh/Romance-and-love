import { memoryActive, memoryConflict, CONTEXT_LIMITS } from '../shared/companion';
import type { CompanionMemory, MemorySelection, MemorySelectionEntry, MemorySource, ChatMessage } from '../shared/companion';

// 维护入口：排序权重、衰减半衰期和背景条数都在本文件。先做权限/状态
// 过滤，再计算分数；任何分数都不能把候选、过期或冲突记录变成有效事实。
// 不复制桌面插件宿主，避免把本地文件权限或全局状态带进多用户云端。
export const MEMORY_POLICY = { version: 'external-memory-v1', storedPerRole: 60, fallbackCount: 2, sourcesPerMemory: 4 } as const;
const day = 86400000;
const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
export const memoryKey = (m: Pick<CompanionMemory, 'text' | 'subject' | 'topic'>) => `${m.subject ?? 'unspecified'}:${key(m.topic ?? '')}:${key(m.text)}`;
function grams(s: string): Set<string> {
  const text = key(s), out = new Set<string>();
  if (text.length === 1) out.add(text);
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}
function similarity(query: Set<string>, text: string): number {
  const terms = grams(text); let count = 0;
  for (const t of query) if (terms.has(t)) count++;
  // Query coverage prevents a short, precise topic from being diluted by a
  // longer fact. This is lexical relevance, not a claim of semantic reasoning.
  return query.size ? count / query.size : 0;
}
const round = (n: number) => Math.round(n * 10000) / 10000;
function sourceKey(s: MemorySource): string {
  return s.kind === 'message' ? `m:${s.conversationId}:${s.messageId}`
    : s.kind === 'document' ? `d:${s.documentId}:${s.turn}` : 'manual';
}
export function appendMemorySource(previous: MemorySource[] = [], source: MemorySource): MemorySource[] {
  // Replaying the same source does not manufacture independent evidence.
  const found = previous.some(s => sourceKey(s) === sourceKey(source));
  return found ? previous : [...previous, source].slice(-MEMORY_POLICY.sourcesPerMemory);
}
export function memoryUsesDocument(m: CompanionMemory, id: string): boolean {
  return m.documentId === id || Boolean(m.sources?.some(s => s.documentId === id));
}

/** Pure policy: the caller supplies one trusted user's state. Filter the role
 * before scoring or diagnostics so audit records cannot leak other personas.
 * Retrieval itself never reinforces a fact or mutates its confirmation time.
 */
export function selectMemories(memories: CompanionMemory[], roleId: string, query: string, now: number, enabled = true) {
  const own = memories.filter(m => m.roleId === roleId), terms = grams(query), audit: MemorySelection = { policy: MEMORY_POLICY.version, entries: [] };
  const seen = new Set<string>(), ranked: { memory: CompanionMemory; entry: MemorySelectionEntry; index: number; pinned: boolean }[] = [];
  for (const [index, m] of own.entries()) {
    const entry: MemorySelectionEntry = { id: m.id, version: m.version, selected: false, reason: 'unrelated' };
    audit.entries.push(entry);
    if (!enabled) { entry.reason = 'disabled'; continue; }
    if (m.status !== 'confirmed') { entry.reason = 'pending'; continue; }
    if (!memoryActive(m, now)) { entry.reason = 'expired'; continue; }
    if (memoryConflict(m, own, now)) { entry.reason = 'conflict'; continue; }
    const identity = memoryKey(m);
    if (seen.has(identity)) { entry.reason = 'duplicate'; continue; } seen.add(identity);
    const pinned = m.kind === 'boundary', halfLife = m.kind === 'event' ? 2 : m.kind === 'preference' ? 180 : 90;
    // Event age follows the event/source time, not the latest edit. Reconfirming
    // an old event must not turn it into something that happened today.
    const ageFrom = m.kind === 'event' ? m.sources?.[0]?.occurredAt ?? m.createdAt : m.confirmedAt ?? m.createdAt;
    const recency = pinned ? 1 : Math.pow(.5, Math.max(0, now - ageFrom) / (halfLife * day));
    const relevance = similarity(terms, `${m.topic ?? ''} ${m.text}`), importance = ((m.importance ?? 3) - 1) / 4;
    // Confirmation means the owner checked the statement, not external proof.
    // Different source pointers are only a small signal, never a probability.
    const evidence = Math.min(1, .5 + .125 * (new Set((m.sources ?? []).filter(s => s.kind !== 'manual').map(sourceKey)).size));
    const score = .6 * relevance + .15 * importance + .15 * recency + .1 * evidence;
    Object.assign(entry, { score: round(score), relevance: round(relevance), importance: round(importance), recency: round(recency), evidence: round(evidence) });
    ranked.push({ memory: m, entry, index, pinned });
  }
  ranked.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.entry.score! - a.entry.score! || a.index - b.index);
  let fallbacks = 0;
  const selected: CompanionMemory[] = [];
  for (const item of ranked) {
    const relevant = item.pinned || item.entry.relevance! > 0;
    if (!relevant && fallbacks >= MEMORY_POLICY.fallbackCount) continue;
    if (selected.length >= CONTEXT_LIMITS.memories) { item.entry.reason = 'limit'; continue; }
    if (!relevant) fallbacks++;
    item.entry.selected = true; item.entry.reason = relevant ? 'selected' : 'background'; selected.push(item.memory);
  }
  return { memories: selected, audit };
}

/** First iteration deliberately extracts only an explicit, unquoted request.
 * Keep the user's exact wording, never an AI summary; leave confirmation and
 * subject selection to the owner. Ordinary chat does not silently become facts.
 */
export function explicitMemoryCandidate(message: ChatMessage): string | undefined {
  if (message.speaker !== 'user') return;
  const match = /^(?:请)?(?:帮我)?记住[：:,，\s]+([^\n]+)$/u.exec(message.text.trim());
  const text = match?.[1]?.trim();
  if (!text || text.length > 100 || /[“”「」『』"？?]|(?:假如|假设|如果|举例|比如|系统提示|密钥|API_KEY)/i.test(text)) return;
  return text;
}
