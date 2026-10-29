import type { ChatContext } from './companion-prompt';
function terms(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const result = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) result.add(normalized.slice(i, i + 2));
  return result;
}
// This is query-time emphasis, NOT extra memory or a search of stored chats.
// Input has already passed ownership, consent, correction barriers and windowing.
export function historyEvidence(c: ChatContext) {
  if (c.intent === 'initiative') return [];
  const query = terms(c.message);
  return c.messages.map((m, index) => {
    const words = terms(m.text); let score = 0;
    query.forEach(t => { if (words.has(t)) score++; });
    return { index, speaker: m.speaker, text: m.text, score };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 3)
    .sort((a, b) => a.index - b.index).map(({ score: _score, ...m }) => m);
}
