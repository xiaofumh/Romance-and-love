import type { InteractionMode } from './companion';

export type ConversationClause = { text: string; plain: string; direct: boolean };
const quotationEnds: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };
const reportedLead = /^(?:(?:我(?:的)?|咱们的)?(?:朋友|同事|同学|室友|家人|父母|妈妈|爸爸|老师|领导|老板|客户|男朋友|女朋友)|他|她|他们|她们|对方|有人|别人|那个人).{0,16}?(?:说|讲|告诉我|回复|留言|发来|表示|要求|问)/;
const directContrast = /^(?:但是|但|不过|可是|而|至于)(?:是)?(?=我们|我)/;
const speakerSwitch = /^(?:(?:但是|但|不过|可是|而|至于)(?:是)?(?:我们|我)|现在我|其实我|我的意思是)/;

// Split only outside quotations. A reported speaker continues across commas;
// a clearly marked speaker switch or sentence starts the user's own speech.
// Bare "我" after a comma can still be the reported speaker's first person.
// The original wording remains available as data, never as an executed command.
export function conversationClauses(text: string): ConversationClause[] {
  const clauses: ConversationClause[] = [], quotes: string[] = [];
  let original = '', plain = '', reported = false, escaped = false;
  function flush() {
    const t = plain.trim(), source = original.trim();
    if (source) {
      if (reportedLead.test(t)) reported = true;
      else if (speakerSwitch.test(t)) reported = false;
      clauses.push({ text: source, plain: reported ? t : t.replace(directContrast, ''), direct: !reported });
    }
    original = ''; plain = '';
  }
  for (const ch of text) {
    if (!quotes.length && /[，,。；;！!？?\n]/.test(ch)) {
      flush(); if (/[。！!？?\n]/.test(ch)) reported = false;
      escaped = false; continue;
    }
    original += ch;
    if (quotes.length) {
      if (!escaped && ch === quotes.at(-1)) quotes.pop();
      else if (!escaped && quotationEnds[ch] && ch !== '"') quotes.push(quotationEnds[ch]!);
    } else if (!escaped && quotationEnds[ch]) quotes.push(quotationEnds[ch]!);
    else plain += ch;
    escaped = ch === '\\' && !escaped;
  }
  flush(); return clauses;
}
export function normalizeControlClause(text: string): string {
  return text.trim().replace(/[～~\s]+$/g, '').replace(/^(?:好了|那就)\s*/, '');
}
export function interactionCommand(text: string): InteractionMode | undefined {
  const t = normalizeControlClause(text);
  if (/^(?:请|你)?(?:先)?(?:别主动|不要主动|别催|不用回)/.test(t)
    || /^(?:我)?(?:现在|今天|暂时)?(?:先)?(?:不想聊(?:天|了)?|不想说(?:话|了)?|想静静|想安静一会)(?:了|啦|吧)?$/.test(t)
    || /^(?:晚安|再见|先这样|我先睡了|我先去忙了|我先忙|先不聊了|不聊了|先不说了|别追问|不要追问|别再问了|晚点聊|明天再聊)(?:啦|了|吧)?$/.test(t)) return 'quiet';
  if (/^(?:我们)?(?:换个话题|聊点轻松|讲个笑话|一起玩)(?:吧|点的|的)?$/.test(t)) return 'light';
  if (/^(?:我|我们)?(?:现在|又|现在又)?(?:想聊了|可以主动找我了|恢复主动接话|继续聊吧|继续聊)$/.test(t)
    || /^(?:认真聊聊|听我说|先听我说|恢复倾听陪伴)$/.test(t)) return 'listening';
}
export function isContinuationControlOnly(text: string): boolean {
  const clauses = conversationClauses(text).filter(c => c.direct && c.plain);
  if (!clauses.length) return false;
  let last: InteractionMode | undefined;
  for (const c of clauses) {
    const command = interactionCommand(c.plain);
    if (command) last = command;
    else if (!/^(?:好了|那就|好吧|嗯|好)$/.test(c.plain)) return false;
  }
  return last != null ? last !== 'quiet' : clauses.length === 1 && clauses[0]!.plain === '好了';
}
