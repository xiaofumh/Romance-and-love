import { call, toast, readableTime, getMode } from '../../services/api';
import { MEMORY_SUBJECTS, MEMORY_DURATIONS, MEMORY_KINDS, memoryConflict } from '../../../shared/companion';
import type { CompanionMemory, Conversation, MemorySelection, MemorySelectionEntry } from '../../../shared/companion';
const reasons: Record<MemorySelectionEntry['reason'], string> = { selected: '与话题相关或属于明确边界', background: '少量背景参考', pending: '尚未确认', expired: '已过期', conflict: '存在冲突，请先纠正', duplicate: '内容重复', unrelated: '与话题关联不足', limit: '本轮已有足够参考', disabled: '未开启已确认记忆' };
type MessageSource = { kind: 'message'; conversationId: string; messageId: string };
Page({ data: { roleId: '', documentId: '', items: [] as CompanionMemory[], text: '', id: '', version: 0, busy: false,
  topic: '', sourceNote: '', subjectIndex: 0, durationIndex: 0, kindIndex: 0, importanceIndex: 2,
  source: null as MessageSource | null, sourceHint: '', query: '', inspecting: false, inspection: [] as { id: string; text: string; selected: boolean; reason: string }[],
  error: '', subjects: [...MEMORY_SUBJECTS], durations: [...MEMORY_DURATIONS], kinds: [...MEMORY_KINDS], importanceLabels: ['较低', '偏低', '普通', '重要', '非常重要'] },
  sourceLoaded: false, sessionMode: getMode(),
  onLoad(q: Record<string, string>) { this.setData({ roleId: q.roleId ?? '', documentId: q.documentId ?? '', subjectIndex: q.documentId ? 3 : 0,
    source: q.conversationId && q.messageId ? { kind: 'message', conversationId: q.conversationId, messageId: q.messageId } : null }); },
  async onShow() {
    if (getMode() !== this.sessionMode) { this.setData({ items: [], inspection: [], text: '', source: null, error: '运行模式已切换，请返回当前模式的角色资料页。' }); return; }
    if (this.data.source && !this.sourceLoaded) {
      this.sourceLoaded = true;
      try { const source = this.data.source, d = await call<{ conversation: Conversation }>('companion.conversation.get', { id: source.conversationId });
        if (getMode() !== this.sessionMode) return;
        const message = d.conversation.messages.find(m => m.id === source.messageId && m.speaker === 'user');
        if (!message || d.conversation.roleId !== this.data.roleId) throw new Error('原消息已不可用，请手动添加并核对来源');
        this.setData({ text: message.text.slice(0, 100), subjectIndex: 0, sourceHint: message.text.length > 100 ? '已关联用户消息；只预填前100字，请选取原文并核对主体。' : '已关联用户消息，请核对主体；转述别人的话不等于你的事实。' });
      } catch(e) { this.setData({ source: null, error: e instanceof Error ? e.message : '读取来源失败' }); }
    }
    return this.load();
  },
  async load() { try {
    if (getMode() !== this.sessionMode) return;
    const d = await call<{ memories: CompanionMemory[]; serverTime?: number }>('companion.data', { id: this.data.roleId }); const now = d.serverTime ?? Date.now();
    if (getMode() !== this.sessionMode) return;
    this.setData({ items: d.memories.map(m => ({ ...m,
      kindLabel: MEMORY_KINDS.find(k => k.value === m.kind)?.label ?? '一般事实', importanceLabel: this.data.importanceLabels[(m.importance ?? 3) - 1],
      sourceLabel: m.sources?.map(s => s.kind === 'message' ? '用户聊天原文' : s.kind === 'document' ? '导入资料原文' : '手动整理').filter((s, i, all) => all.indexOf(s) === i).join('、') || (m.documentId ? '关联导入资料' : '旧版手动资料'),
      subjectLabel: MEMORY_SUBJECTS.find(s => s.value === (m.subject ?? 'unspecified'))?.label,
      expires: m.expiresAt ? readableTime(m.expiresAt) : '长期（直到纠正、删除或来源过期）',
      expired: m.expiresAt != null && m.expiresAt <= now, conflict: Boolean(memoryConflict(m, d.memories, now)) })) });
  } catch(e) { this.setData({ error: e instanceof Error ? e.message : '读取记忆失败' }); } },
  input(e: WechatMiniprogram.Input) { const field = e.currentTarget?.dataset?.field ?? 'text';
    if (['text', 'topic', 'sourceNote', 'query'].includes(field)) this.setData({ [field]: e.detail.value, error: '', inspection: [] }); },
  pickSubject(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (MEMORY_SUBJECTS[n]) this.setData({ subjectIndex: n }); },
  pickDuration(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (MEMORY_DURATIONS[n]) this.setData({ durationIndex: n }); },
  pickKind(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (MEMORY_KINDS[n]) this.setData({ kindIndex: n }); },
  pickImportance(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (this.data.importanceLabels[n]) this.setData({ importanceIndex: n }); },
  edit(e: WechatMiniprogram.TouchEvent) { const m = this.data.items.find(v => v.id === e.currentTarget.dataset.id); if (!m) return;
    this.setData({ text: m.text, id: m.id, version: m.version, documentId: m.documentId ?? '', topic: m.topic ?? '', sourceNote: m.sourceNote ?? '', error: '', source: null, sourceHint: '',
      kindIndex: Math.max(0, MEMORY_KINDS.findIndex(k => k.value === m.kind)), importanceIndex: (m.importance ?? 3) - 1,
      subjectIndex: Math.max(0, MEMORY_SUBJECTS.findIndex(s => s.value === m.subject)), durationIndex: Math.max(0, MEMORY_DURATIONS.findIndex(d => d.value === m.validFor)) }); },
  cancelEdit() { this.setData({ text: '', id: '', version: 0, topic: '', sourceNote: '', documentId: '', subjectIndex: 0, durationIndex: 0, kindIndex: 0, importanceIndex: 2, source: null, sourceHint: '', inspection: [], error: '' }); },
  detachSource() { this.setData({ source: null, sourceHint: '已改为手动整理；不会将改写内容标成原文证据。' }); },
  async viewSource(e: WechatMiniprogram.TouchEvent) {
    try { const source = await call<{ available: boolean; reason?: string; text?: string; truncated?: boolean }>('companion.memory.source', { id: e.currentTarget.dataset.id });
      if (getMode() !== this.sessionMode) return;
      wx.showModal({ title: '来源记录', showCancel: false, content: source.available
        ? `${source.text}${source.truncated ? '\n（原消息较长，仅显示前2000字）' : ''}\n来源原文不等于外部核验，请核对人物与时间。`
        : source.reason === 'manual' ? '这是手动整理或旧版资料，没有保存可定位的逐字来源。' : '原消息已到期、清理或不再可用。来源记录不能代替原文或外部核验。' });
    } catch(e) { toast(e); }
  },
  async save() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { const d = this.data; await call('companion.memory.save', { roleId: d.roleId, text: d.text, confirmed: false,
      subject: MEMORY_SUBJECTS[d.subjectIndex]!.value, topic: d.topic, sourceNote: d.sourceNote, validFor: MEMORY_DURATIONS[d.durationIndex]!.value,
      kind: MEMORY_KINDS[d.kindIndex]!.value, importance: d.importanceIndex + 1, ...(d.source ? { source: d.source } : {}),
      ...(d.id ? { id: d.id, version: d.version } : {}), ...(d.documentId ? { documentId: d.documentId } : {}) }); this.cancelEdit(); await this.load(); }
    catch(e) { this.setData({ error: e instanceof Error ? e.message : '保存失败' }); } finally { this.setData({ busy: false }); }
  },
  async inspect() {
    if (this.data.inspecting || this.data.busy) return; this.setData({ inspecting: true, error: '' });
    const query = this.data.query;
    try { const result = await call<MemorySelection>('companion.memory.inspect', { roleId: this.data.roleId, text: query });
      if (getMode() !== this.sessionMode || query !== this.data.query) return;
      this.setData({ inspection: result.entries.map(e => ({ id: e.id, text: this.data.items.find(m => m.id === e.id)?.text ?? '资料已更新，请刷新', selected: e.selected, reason: reasons[e.reason] })) });
    } catch(e) { this.setData({ error: e instanceof Error ? e.message : '检查失败' }); } finally { this.setData({ inspecting: false }); }
  },
  confirm(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const m = this.data.items.find(v => v.id === e.currentTarget.dataset.id); if (!m) return;
    if (m.expiresAt != null && m.expiresAt <= Date.now()) return this.setData({ error: '记忆已过期，请编辑有效期后再确认。' });
    if (memoryConflict(m, this.data.items, Date.now())) return this.setData({ error: '同一主体与主题存在不同事实，请编辑并纠正原条目，不要重复确认。' });
    wx.showModal({ title: '确认这条资料？', content: `${MEMORY_SUBJECTS.find(s => s.value === m.subject)?.label ?? '未明确主体'}：${m.text}\n确认表示你已核对，并非模型查证。开启记忆后仅供当前角色使用；历史消息保留但重新开始上下文。`, success: async r => {
      if (!r.confirm || this.data.busy) return; this.setData({ busy: true, error: '' });
      try { await call('companion.memory.save', { id: m.id, version: m.version, roleId: m.roleId, text: m.text, confirmed: true,
        ...(m.documentId ? { documentId: m.documentId } : {}) }); await this.load(); }
      catch(e) { this.setData({ error: e instanceof Error ? e.message : '确认失败' }); } finally { this.setData({ busy: false }); }
    } });
  },
  remove(e: WechatMiniprogram.TouchEvent) { wx.showModal({ title: '删除记忆并清空该角色旧消息？', content: '删除与纠错不同：为避免找回被删除事实，将清空此角色会话正文。若只想纠错，请取消并选择“编辑／纠错”；若事实也在导入资料中，还需修订来源。删除不可在应用中恢复。', success: async r => {
    if (!r.confirm) return; try { await call('companion.delete', { kind: 'memory', id: e.currentTarget.dataset.id }); await this.load(); } catch(e) { toast(e); }
  } }); },
  settings() { wx.switchTab({ url: '/pages/settings/index' }); },
});
