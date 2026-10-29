import type { ChatContext } from './companion-prompt';
import { nextInteractionMode } from '../shared/interaction';

// Rebuilt from this request's authorised, bounded history. Nothing is persisted,
// promoted to a fact, or read beyond a correction/privacy/window boundary.
type Source = { sourceIndex: number; text: string; recordedAt?: number };
export type DialogueLedger = {
  current?: Source; openThreads: Source[]; declinedTopics: { topic: string; sourceIndex: number }[];
  questionsAsked: Source[]; lastUserText: string; lastUserIndex?: number;
};
export type DialoguePlan = { action: 'answer' | 'acknowledge' | 'respect-boundary' | 'shift' | 'continue';
  questionAllowance: 'none' | 'optional'; ledger: DialogueLedger };
export const TOPIC_TTL_MS = 24 * 3600000;
const aliases = [ ['工作', /工作|上班|下班|同事|领导|公司|加班/], ['考试', /考试|面试|考研|成绩/],
  ['饮食', /吃饭|吃什么|吃啥|晚饭|午饭|早餐|外卖|饮食/], ['家庭', /家庭|家人|父母|爸爸|妈妈/],
  ['感情', /感情|恋爱|前任/], ['游戏', /游戏|打游戏/], ['花园', /花园|种花|植物/],
  ['电影', /电影|影片/], ['音乐', /音乐|听歌|歌曲/] ] as const;
const unquote = (t: string) => t.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, '');
const key = (t: string) => t.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
export function topicTags(text: string): string[] {
  return aliases.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
export function declinedIn(text: string): string[] {
  const topics: string[] = [];
  for (const clause of unquote(text).split(/[，,。；;！!？?\n]/)) {
    const m = /^(?:我)?(?:今天|现在|暂时)?(?:先)?(?:不想|别|不要|不)(?:再)?(?:聊|说|提|问|谈|分析)(?:起|到|关于)?(.{1,20}?)(?:了|啦|吧)?$/.exec(clause.trim().replace(/^(?:好了|算了)\s*/, ''));
    if (!m) continue;
    const topic = m[1]!.replace(/(?:的事|这件事|这个话题)$/, '').trim();
    if (!topic || /^(?:话|天|了|问|问题|问我|问我问题)$/.test(topic)) continue;
    topics.push(...(topicTags(topic).length ? topicTags(topic) : [topic]));
  }
  return [...new Set(topics)];
}
function reopenedIn(text: string): string[] {
  const result: string[] = [];
  for (const clause of unquote(text).split(/[，,。；;！!\n]/)) {
    const m = /^(?:我|我们)?(?:现在|又|还是)?(?:想|可以|继续|重新)(?:聊聊|聊|说说|谈谈)(.{1,20}?)(?:吧|了)?$/.exec(clause.trim());
    if (m) result.push(...(topicTags(m[1]!).length ? topicTags(m[1]!) : [m[1]!]));
  }
  return result;
}
export function isAcknowledgement(text: string): boolean {
  return /^(?:嗯+|哦+|噢+|好(?:的|吧|呀|啊)?|行|知道了|收到|谢谢|哈哈+|晚安|再见|不|不了)[呀啊呢哦吧啦～~！!。.\s]*$/.test(text.trim());
}
export function isControlOnly(text: string): boolean {
  return /^(?:(?:我|我们)?(?:又|现在|现在又)?(?:想聊了|继续聊吧|继续聊|好了|换个话题|聊点轻松的|先听我说|认真聊聊|恢复主动接话|可以主动找我了))[吧呀啊～~！!。.\s]*$/.test(text.trim());
}
function avoidQuestionsIn(text: string): boolean {
  return unquote(text).split(/[，,。；;！!\n]/).some(clause =>
    /^(?:这次|这轮|现在|今天|你)?(?:先)?(?:别|不要|不用)(?:再|总|连续|每句(?:话)?都)?(?:反问|追问|提问|问我)/.test(clause.trim()));
}
function related(text: string, topic: string): boolean {
  return topicTags(text).includes(topic) || key(text).includes(key(topic));
}
export function buildDialoguePlan(c: Pick<ChatContext, 'messages' | 'message' | 'interaction'>, now: number): DialoguePlan {
  const declined = new Map<string, number>(), threads: Source[] = [], questions: Source[] = [];
  let lastUserText = '', lastUserIndex: number | undefined;
  const rows = [...c.messages, ...(c.message ? [{ speaker: 'user' as const, text: c.message, createdAt: now }] : [])];
  for (const [sourceIndex, m] of rows.entries()) {
    // Un-timestamped legacy history may guide replies, but cannot become a
    // time-sensitive proactive anchor. Production messages have server times.
    if (m.createdAt != null && (m.createdAt <= now - TOPIC_TTL_MS || m.createdAt > now)) continue;
    const item: Source = { sourceIndex, text: m.text.slice(0, 240), ...(m.createdAt != null ? { recordedAt: m.createdAt } : {}) };
    if (m.speaker === 'assistant') {
      for (const part of m.text.split(/\n+/).filter(p => /[？?]/.test(p)).slice(-2)) questions.push({ ...item, text: part.slice(0, 200) });
      continue;
    }
    lastUserText = m.text; lastUserIndex = sourceIndex;
    for (const t of reopenedIn(m.text)) declined.delete(t);
    const refused = declinedIn(m.text);
    for (const t of refused) declined.set(t, sourceIndex);
    if (/^(?:我们)?(?:换个话题|聊点别的)/.test(unquote(m.text).trim())) threads.length = 0;
    if (nextInteractionMode(m.text) === 'quiet' || isAcknowledgement(m.text) || isControlOnly(m.text)) continue;
    // A refusal and a new subject may occur in one message. Keep sourced clauses
    // separately so declining work doesn't discard an invitation about a garden.
    for (const clause of m.text.split(/[，,。；;！!\n]/).map(t => t.trim()).filter(Boolean)) {
      if (clause.length < 6 || declinedIn(clause).length || avoidQuestionsIn(clause) || isControlOnly(clause)
        || /^(?:这轮|这次|本轮)(?:先)?(?:只|别|不要|不用)/.test(clause)) continue;
      // Preserve original wording, never infer a future event, diagnosis or outcome.
      threads.push({ ...item, text: clause.slice(0, 240) });
    }
  }
  const openThreads = threads.filter(t => ![...declined].some(([topic]) => related(t.text, topic))).slice(-4);
  const ledger: DialogueLedger = { current: openThreads.at(-1), openThreads,
    declinedTopics: [...declined].slice(-6).map(([topic, sourceIndex]) => ({ topic, sourceIndex })),
    questionsAsked: questions.slice(-6), lastUserText: lastUserText.slice(0, 240), lastUserIndex };
  const current = c.message.trim();
  const refusal = declinedIn(current).length > 0 || c.interaction === 'quiet';
  const action = refusal ? 'respect-boundary' : isAcknowledgement(current) ? 'acknowledge'
    : /换个话题|聊点别的/.test(unquote(current)) ? 'shift' : /[？?]|什么|怎么|多少|几点|是谁/.test(current) ? 'answer' : 'continue';
  const consecutiveQuestions = c.messages.filter(m => m.speaker === 'assistant').slice(-2).filter(m => /[？?]/.test(m.text)).length;
  return { action, questionAllowance: refusal || avoidQuestionsIn(current) || isAcknowledgement(current) || consecutiveQuestions === 2 ? 'none' : 'optional', ledger };
}
export function eligibleThread(plan: DialoguePlan): Source | undefined {
  const ledger = plan.ledger;
  // A short acknowledgement, refusal, or unanswered AI question is a cue to
  // leave space. The model can also choose WAIT after this conservative gate.
  if (isAcknowledgement(ledger.lastUserText)) return;
  const last = ledger.current;
  if (last?.sourceIndex !== ledger.lastUserIndex && !isControlOnly(ledger.lastUserText)) return;
  return last?.recordedAt != null ? last : undefined;
}
