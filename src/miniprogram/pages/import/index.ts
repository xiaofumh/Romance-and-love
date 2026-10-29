import { call, toast } from '../../services/api';
import { IMPORT_LIMITS, utf8Bytes, referencePreview, reviewedReferenceText, redactPrivate } from '../../../shared/companion';
import type { ReferenceTurn, ReferenceDocument, ReferencePreview } from '../../../shared/companion';
import { analyzeImport, reviewImport, validateImportReview } from '../../../shared/import-cleaning';
import type { ImportAnalysis, ImportResolution } from '../../../shared/import-cleaning';
type ReviewRow = Partial<ReferencePreview> & { key: string; index?: number; line?: number; endLine?: number; reason?: string; sourceSpeaker?: string };
Page({ data: { roleId: '', title: '', text: '', textCharacters: 0, largeTextLoaded: false, userSpeaker: '我', referenceSpeaker: '对方',
  previewRows: [] as ReviewRow[], turnCount: 0, previewPage: 1, previewPages: 1, pageInput: '1',
  reviewKind: 'messages', format: '', metadataCount: 0, pendingCount: 0, excludedCount: 0, blankLines: 0, normalizedBreaks: 0,
  englishCount: 0, duplicateCount: 0, corpus: false, candidates: [] as string[], candidateCount: 0,
  step: 0, authorized: false, busy: false, error: '', limits: IMPORT_LIMITS },
  rawText: '', reviewedTurns: [] as ReferenceTurn[], previewSlices: [] as ReferencePreview[],
  analysis: null as ImportAnalysis | null, resolutions: [] as ImportResolution[],
  onLoad(q: Record<string, string>) { this.setData({ roleId: q.roleId ?? '' }); },
  onUnload() { this.rawText = ''; this.reviewedTurns = []; this.previewSlices = []; this.analysis = null; this.resolutions = []; },
  invalidate() { this.reviewedTurns = []; this.previewSlices = []; this.analysis = null; this.resolutions = [];
    this.setData({ previewRows: [], turnCount: 0, authorized: false, error: '', pendingCount: 0 }); },
  applyText(text: string) {
    if (utf8Bytes(text) > IMPORT_LIMITS.fileBytes) throw new Error('文本超过1MB，请拆分后导入');
    this.rawText = text; this.invalidate();
    // Large source stays in page memory, not in an oversized setData payload.
    this.setData({ text: text.length <= 8000 ? text : '', textCharacters: text.length, largeTextLoaded: text.length > 8000 });
  },
  input(e: WechatMiniprogram.Input) {
    const k = e.currentTarget.dataset.field as string;
    if (k === 'text') { try { this.applyText(e.detail.value); } catch(error) { toast(error); } }
    else if (['title', 'userSpeaker', 'referenceSpeaker'].includes(k)) { this.setData({ [k]: e.detail.value }); this.invalidate(); }
  },
  clearText() { this.applyText(''); },
  screenshot() {
    if (this.data.busy) return;
    let channel: WechatMiniprogram.EventChannel | undefined;
    wx.navigateTo({ url: `/pages/screenshot/index?roleId=${encodeURIComponent(this.data.roleId)}`, events: {
      screenshotText: (result: { turns: ReferenceTurn[] }) => {
        try {
          const me = this.data.userSpeaker.trim(), other = this.data.referenceSpeaker.trim();
          if (!me || !other || me === other || /[：:\r\n]/.test(me + other)) throw new Error('请先设置不同的双方称呼，且不能含冒号或换行');
          const added = result.turns.map(v => `${v.speaker === 'user' ? me : other}：${v.text}`).join('\n');
          const original = this.rawText || this.data.text;
          this.applyText(original ? original + '\n' + added : added);
          this.setData({ title: this.data.title.trim() || '截图聊天参考', step: 0 });
          channel?.emit?.('screenshotResult', { ok: true });
        } catch(error) { channel?.emit?.('screenshotResult', { ok: false, error: error instanceof Error ? error.message : '加入失败，请保留识别结果' }); }
      },
    }, success: result => { channel = result.eventChannel; } });
  },
  example() { this.setData({ title: '虚构示例 · 日常表达' }); this.applyText('我：今天有点累。\n对方：那就先歇一会儿，想聊的时候我听着。\n我：想找个安静的地方散步。\n对方：慢慢走，看看路上的树和晚风也很好。'); },
  chooseFile() {
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['txt'], success: r => {
      const f = r.tempFiles[0]; if (!f) return;
      if (f.size > IMPORT_LIMITS.fileBytes) return toast(new Error('TXT文件最多1MB（1024KB），不另设字数限制'));
      wx.getFileSystemManager().readFile({ filePath: f.path, encoding: 'utf8', success: r => {
        const text = String(r.data).replace(/^\uFEFF/, '');
        if (text.includes('\uFFFD')) return toast(new Error('文件编码不正确，请另存为UTF-8 TXT'));
        try { this.applyText(text); this.setData({ title: f.name.replace(/\.txt$/i, '').slice(0, 40) }); } catch(error) { toast(error); }
      }, fail: () => toast(new Error('文件读取失败，请重新选择或粘贴文本')) });
    }, fail: () => toast(new Error('未选择文件，可直接粘贴文本')) });
  },
  preview() {
    this.invalidate();
    try {
      if (!this.data.title.trim()) throw new Error('请给资料取一个名称');
      this.analysis = analyzeImport(this.rawText || this.data.text, this.data.userSpeaker, this.data.referenceSpeaker);
      this.resolutions = []; this.setData({ reviewKind: 'messages', authorized: false, error: '' }); this.refreshReview();
      this.setData({ step: 1 });
    } catch(e) { this.setData({ error: e instanceof Error ? e.message : '解析失败' }); }
  },
  refreshReview() {
    if (!this.analysis) return;
    const r = reviewImport(this.analysis, this.resolutions);
    this.reviewedTurns = r.turns; this.previewSlices = referencePreview(r.turns);
    this.setData({ turnCount: r.turns.length, pendingCount: r.pending, excludedCount: r.excluded,
      englishCount: r.english, duplicateCount: r.duplicates, format: this.analysis.format, corpus: this.analysis.corpus,
      blankLines: this.analysis.blankLines, normalizedBreaks: this.analysis.normalizedBreaks,
      metadataCount: this.analysis.rows.filter(v => v.kind === 'metadata').length,
      candidates: this.analysis.candidates.slice(0, 20), candidateCount: this.analysis.candidates.length, authorized: false, error: '' });
    this.showPreview(1);
  },
  selectKind(e: WechatMiniprogram.Input) {
    const kind = e.currentTarget.dataset.kind;
    if (['messages', 'issues', 'removed'].includes(kind)) { this.setData({ reviewKind: kind }); this.showPreview(1); }
  },
  setSpeaker(e: WechatMiniprogram.Input) {
    const { name, side } = e.currentTarget.dataset;
    if (typeof name !== 'string' || !['userSpeaker', 'referenceSpeaker'].includes(side)) return;
    this.setData({ [side]: name }); this.preview();
  },
  resolve(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index), action = e.currentTarget.dataset.action;
    if (!this.analysis || this.analysis.rows[index]?.kind !== 'issue' || !['user', 'reference', 'exclude'].includes(action)) return;
    // A native tap resolves exactly one source block. Never bulk-exclude unknown content.
    this.resolutions = [...this.resolutions.filter(v => v.index !== index), { index, action }]; this.refreshReview();
  },
  resetCleaning() { this.preview(); },
  showPreview(page: number) {
    let rows: ReviewRow[];
    if (this.data.reviewKind === 'messages') rows = this.previewSlices.map(v => ({ ...v, key: `m-${v.turn}-${v.part}` }));
    else {
      rows = []; const changes = new Map(this.resolutions.map(v => [v.index, v.action]));
      this.analysis?.rows.forEach((row, index) => {
        const included = this.data.reviewKind === 'issues' ? row.kind === 'issue' && !changes.has(index)
          : row.kind === 'metadata' || changes.get(index) === 'exclude';
        if (!included) return;
        for (const part of referencePreview([{ speaker: 'user', text: redactPrivate(row.text) }]))
          rows.push({ text: part.text, part: part.part, key: `r-${index}-${part.part}`, index, line: row.line, endLine: row.endLine,
            sourceSpeaker: row.sourceSpeaker, reason: changes.get(index) === 'exclude' ? '你手动排除的内容' : row.reason });
      });
    }
    const pages = Math.max(1, Math.ceil(rows.length / 20)), n = Math.max(1, Math.min(pages, page));
    this.setData({ previewPages: pages, previewPage: n, pageInput: String(n), previewRows: rows.slice((n - 1) * 20, n * 20) });
  },
  previous() { this.showPreview(this.data.previewPage - 1); },
  next() { this.showPreview(this.data.previewPage + 1); },
  pageInput(e: WechatMiniprogram.Input) { this.setData({ pageInput: e.detail.value }); },
  jump() { const n = Number(this.data.pageInput); if (Number.isInteger(n)) this.showPreview(n); },
  back() { this.setData({ step: 0, authorized: false }); },
  confirmStep() {
    try { if (!this.analysis) throw new Error('请先解析并预览'); validateImportReview(reviewImport(this.analysis, this.resolutions));
      this.setData({ step: 2, authorized: false, error: '' });
    } catch(e) { this.setData({ error: e instanceof Error ? e.message : '请核对解析结果' }); }
  },
  authorize() { this.setData({ authorized: !this.data.authorized }); },
  async save() {
    if (this.data.busy || !this.data.authorized || !this.reviewedTurns.length) return toast(new Error('请先核对脱敏预览并确认有权使用这些资料'));
    this.setData({ busy: true, error: '' });
    try {
      if (!this.analysis || this.data.step !== 2) throw new Error('请先核对预览并进入授权步骤');
      const checked = reviewImport(this.analysis, this.resolutions); validateImportReview(checked);
      this.reviewedTurns = checked.turns;
      // Send only the reviewed/redacted representation, not the raw selected file.
      const d = await call<Pick<ReferenceDocument, 'id'>>('companion.import', { roleId: this.data.roleId, title: this.data.title,
        text: reviewedReferenceText(this.reviewedTurns), userSpeaker: '0', referenceSpeaker: '1', authorized: true });
      this.rawText = ''; this.reviewedTurns = []; this.previewSlices = []; this.analysis = null; this.resolutions = [];
      this.setData({ text: '', textCharacters: 0, previewRows: [] }); wx.redirectTo({ url: `/pages/source/index?id=${d.id}` });
    } catch(e) { this.setData({ error: e instanceof Error ? e.message : '保存失败' }); } finally { this.setData({ busy: false }); }
  },
});
