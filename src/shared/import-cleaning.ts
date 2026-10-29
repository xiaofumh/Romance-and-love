import { redactPrivate, reviewedReferenceText, type ReferenceTurn } from './companion';
import { IMPORT_LIMITS, utf8Bytes } from './limits';

export type ImportRow = { line: number; endLine: number; text: string; kind: 'message' | 'metadata' | 'issue';
  speaker?: ReferenceTurn['speaker']; sourceSpeaker?: string; reason?: string };
export type ImportAnalysis = { rows: ImportRow[]; format: string; blankLines: number; normalizedBreaks: number;
  candidates: string[]; corpus: boolean };
export type ImportResolution = { index: number; action: 'user' | 'reference' | 'exclude' };
export type ImportReview = { turns: ReferenceTurn[]; pending: number; excluded: number; english: number; duplicates: number };
const stamp = '(?:\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?[ T]+)?\\d{1,2}:\\d{2}(?::\\d{2})?';
const leadingTime = new RegExp(`^\\[?${stamp}\\]?\\s+(.+)$`);
const trailingTime = new RegExp(`^(.+?)\\s+\\[?${stamp}\\]?$`);
const onlyTime = new RegExp(`^\\[?${stamp}\\]?$`);
const onlyDate = /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/;

/** Local, deterministic preparation. Source text is data, never executable instructions.
 * Unknown content is retained as an issue; only explicit, recognised wrappers are excluded.
 */
export function analyzeImport(text: string, userSpeaker: string, referenceSpeaker: string): ImportAnalysis {
  const me = userSpeaker.trim(), other = referenceSpeaker.trim();
  if (!me || !other || me === other || /[：:\r\n]/.test(me + other)) throw new Error('双方称呼必须不同，且不能包含冒号或换行');
  if (utf8Bytes(text) > IMPORT_LIMITS.fileBytes) throw new Error('文本超过1MB，请拆分后导入');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const firstExample = lines.findIndex(v => /^###\s*示例\s+\d+\s*$/.test(v.trim()));
  const corpus = /^微信\s*AI\s*自动回复助手[｜|].*喂养聊天数据/.test(lines[0]?.trim() ?? '') && firstExample > 0;
  const result: ImportAnalysis = { rows: [], format: corpus ? '桌面版喂养数据（独立问答样本）' : '带称呼的聊天文本',
    blankLines: 0, normalizedBreaks: 0, candidates: [], corpus };
  const rows = result.rows;
  const candidates = new Set<string>();
  const add = (kind: ImportRow['kind'], index: number, body: string, extra: Partial<ImportRow> = {}) => {
    rows.push({ kind, line: index + 1, endLine: index + 1, text: body, ...extra });
  };
  let lastMessage: ImportRow | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!, value = raw.trim().replace(/[\u2028\u2029]/g, () => { result.normalizedBreaks++; return ' '; });
    if (!value) { result.blankLines++; lastMessage = undefined; continue; }
    if (corpus && (i < firstExample || /^###\s*示例\s+\d+\s*$/.test(value) || /^【数据组[｜|].*】$/.test(value))) {
      add('metadata', i, raw, { reason: i < firstExample ? '数据集标题、来源或使用说明（不作为聊天）' : '样本编号或分组标记' });
      lastMessage = undefined; continue;
    }
    if (onlyTime.test(value) || onlyDate.test(value)) {
      add('metadata', i, raw, { reason: '独立时间标记' }); lastMessage = undefined; continue;
    }
    // Strip timestamps only from header positions, not from message bodies.
    let header = value;
    const timed = leadingTime.exec(header);
    if (timed) { header = timed[1]!.trim(); result.format = corpus ? result.format : '带时间的聊天文本'; }
    const trailingMatch = trailingTime.exec(header);
    const trailing = trailingMatch && !/[：:]/.test(trailingMatch[1]!) ? trailingMatch : null;
    if (trailing) header = trailing[1]!.trim();
    let named = /^(?:【([^】\r\n]{1,20})】|\[([^\]\r\n]{1,20})\])\s*[：:]?\s*(.*)$/.exec(header);
    let name: string | undefined, body: string | undefined;
    if (named) { name = (named[1] ?? named[2])!.trim(); body = named[3]!; }
    else {
      const colon = /^([^：:\r\n]{1,20})[：:]\s*(.*)$/.exec(header);
      if (colon) { name = colon[1]!.trim(); body = colon[2]!; }
      else if ([me, other].includes(header)) { name = header; body = ''; }
      else if (trailing || timed) { name = header; body = ''; }
    }
    if (name !== undefined) {
      // A header on its own may be followed by one or more body lines. Never
      // consume the next named header, metadata, or a blank-line boundary.
      const end = i;
      if (!body && [me, other].includes(name)) {
        const next = lines[i + 1]?.trim();
        const nextHeader = next && (/^(?:【|\[|###|[^：:]{1,20}[：:])/.test(next) || [me, other].includes(next) || onlyTime.test(next) || onlyDate.test(next));
        if (next && !nextHeader) { body = next; i++; }
      }
      let message = (body ?? '').replace(/[\u2028\u2029]/g, () => { result.normalizedBreaks++; return ' '; });
      if (corpus) message = message.replace(/\\n/g, () => { result.normalizedBreaks++; return ' '; });
      if (!candidates.has(name) && name.length <= 20) { candidates.add(name); result.candidates.push(name); }
      if ([me, other].includes(name) && message.trim() && !message.includes('\u0000')) {
        add('message', end, message.trim(), { endLine: i + 1, sourceSpeaker: name, speaker: name === me ? 'user' : 'reference' });
        lastMessage = rows[rows.length - 1];
      } else {
        add('issue', end, message.trim() || raw, { endLine: i + 1, sourceSpeaker: name,
          reason: ![me, other].includes(name) ? '称呼与双方设置不匹配' : '缺少正文或包含无效字符' });
        lastMessage = undefined;
      }
      continue;
    }
    // Unlabelled continuation is safe only immediately after a mapped message;
    // unknown colon lines are NOT attached to a previous speaker.
    if (lastMessage && !/[：:\u0000]/.test(value) && !/^\s*(?:#|【|\[|[-=]{3})/.test(value)) {
      lastMessage.text += ' ' + value.replace(/[\u2028\u2029]/g, () => { result.normalizedBreaks++; return ' '; });
      lastMessage.endLine = i + 1; result.normalizedBreaks++;
    } else {
      add('issue', i, raw, { reason: '无法确定说话人；请返回修改或逐段处理' }); lastMessage = undefined;
    }
  }
  return result;
}

export function reviewImport(analysis: ImportAnalysis, resolutions: ImportResolution[] = []): ImportReview {
  const changes = new Map(resolutions.map(r => [r.index, r.action]));
  const result: ImportReview = { turns: [], pending: 0, excluded: 0, english: 0, duplicates: 0 };
  const seen = new Set<string>();
  analysis.rows.forEach((row, index) => {
    if (row.kind === 'metadata') return;
    let speaker = row.speaker;
    if (row.kind === 'issue') {
      const action = changes.get(index);
      if (!action) { result.pending++; return; }
      if (action === 'exclude') { result.excluded++; return; }
      speaker = action;
    }
    const body = row.text.trim();
    if (!body || /[\r\n\u0000\u2028\u2029]/.test(body)) { result.pending++; return; }
    const turn = { speaker: speaker!, text: redactPrivate(body) };
    const key = JSON.stringify(turn);
    if (seen.has(key)) result.duplicates++; else seen.add(key);
    if (/[A-Za-z]{3}/.test(body) && !/[\u3400-\u9fff]/.test(body)) result.english++;
    result.turns.push(turn);
  });
  return result;
}

export function validateImportReview(review: ImportReview): void {
  if (review.pending) throw new Error(`还有${review.pending}段待处理，不会自动忽略或猜测说话人`);
  if (review.turns.length < 2 || !review.turns.some(v => v.speaker === 'user') || !review.turns.some(v => v.speaker === 'reference'))
    throw new Error('资料必须包含双方的消息，且至少2条');
  if (utf8Bytes(reviewedReferenceText(review.turns)) > IMPORT_LIMITS.fileBytes)
    throw new Error('脱敏后的文本超过1MB，请拆分资料；不会自动截断');
}
