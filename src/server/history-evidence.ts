import type { ChatContext } from './companion-prompt';
function terms(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const result = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) result.add(normalized.slice(i, i + 2));
  return result;
}
// Request/field words alone cannot identify which person or object an excerpt
// concerns. Full bounded history remains present even when no emphasis is safe.
const generic = new Set(['代号', '名字', '名称', '什么', '多少', '哪里', '之前', '前面', '刚才', '现在', '最新', '记得']);
function subjectTerms(text: string): Set<string> {
  return new Set([...terms(text)].filter(t => !generic.has(t) && !/[的了是我你给把被]/.test(t)));
}
function correction(text: string): boolean {
  const plain = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, '').trim();
  return /^(?:不对(?:[，,。:：\s]|$|应该|应当)|(?:我)?(?:刚才|前面)?(?:说错了|记错了)|(?:我)?(?:再|重新)?(?:纠正|更正)|(?:应该|应当)是|改成|改为|不是.{1,80}?(?:而是|是))/.test(plain);
}
function acknowledgement(text: string): boolean {
  return /^(?:嗯+|哦+|噢+|好(?:的|吧|呀|啊)?|行|对|是的|没错|知道了|收到|谢谢)[呀啊呢哦吧啦～~！!。.\s]*$/.test(text.trim());
}
function implicitCorrection(text: string): boolean {
  // An explicit new subject must match independently; do not skip it while
  // walking a chain of short value-only corrections.
  const rest = text.trim().replace(/^(?:不对|(?:我)?(?:刚才|前面)?(?:说错了|记错了)|(?:我)?(?:再|重新)?(?:纠正|更正)(?:一次)?)[，,。:：\s]*/, '');
  return !/(?:代号|名字|名称)/.test(rest)
    && /^(?:(?:应该|应当)?是|改成|改为|不是.{1,80}?(?:而是|是))/.test(rest);
}
// This is query-time emphasis, NOT extra memory or a search of stored chats.
// Input has already passed ownership, consent, correction barriers and windowing.
export function historyEvidence(c: ChatContext) {
  if (c.intent === 'initiative') return [];
  const query = subjectTerms(c.message);
  const entries = c.messages.map((m, index) => {
    const words = terms(m.text); let score = 0;
    query.forEach(t => { if (words.has(t)) score++; });
    return { index, speaker: m.speaker, text: m.text, score, words };
  });
  const ranked = entries.filter(m => m.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
  if (!ranked.length) return [];
  const strongestUser = ranked.find(m => m.speaker === 'user');
  const anchors = strongestUser ? [...query].filter(t => strongestUser.words.has(t)) : [];
  let linked: (typeof entries)[number][] = [];
  // Pin the latest explicit correction only when its previous substantive user
  // statement identifies the same lexical subject. A different user topic stops
  // this backward walk; assistant paraphrases never create the association.
  for (const candidate of entries) {
    if (!anchors.length || candidate.speaker !== 'user' || !correction(candidate.text)) continue;
    const matchesSubject = (row: (typeof entries)[number]) => anchors.every(t => row.words.has(t));
    if (!matchesSubject(candidate) && !implicitCorrection(candidate.text)) continue;
    let previous: (typeof entries)[number] | undefined;
    for (let i = candidate.index - 1; i >= 0; i--) {
      const row = entries[i]!;
      if (row.speaker !== 'user' || acknowledgement(row.text)) continue;
      if (correction(row.text) && !matchesSubject(row) && implicitCorrection(row.text)) continue;
      previous = row; break;
    }
    if (!previous || previous.score === 0) continue;
    if (!matchesSubject(previous)) continue;
    linked = [previous, candidate];
  }
  const selected = [...linked];
  for (const item of ranked) if (selected.length < 3 && !selected.some(m => m.index === item.index)) selected.push(item);
  return selected.sort((a, b) => a.index - b.index).map(({ index, speaker, text }) => ({ index, speaker, text }));
}
