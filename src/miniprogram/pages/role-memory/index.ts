import { call, toast, readableTime } from '../../services/api';
import { MEMORY_SUBJECTS, MEMORY_DURATIONS, memoryConflict } from '../../../shared/companion';
import type { CompanionMemory } from '../../../shared/companion';
Page({ data: { roleId: '', documentId: '', items: [] as CompanionMemory[], text: '', id: '', version: 0, busy: false,
  topic: '', sourceNote: '', subjectIndex: 0, durationIndex: 0, error: '', subjects: [...MEMORY_SUBJECTS], durations: [...MEMORY_DURATIONS] },
  onLoad(q: Record<string, string>) { this.setData({ roleId: q.roleId ?? '', documentId: q.documentId ?? '', subjectIndex: q.documentId ? 3 : 0 }); },
  onShow() { return this.load(); },
  async load() { try {
    const d = await call<{ memories: CompanionMemory[] }>('companion.data', { id: this.data.roleId }); const now = Date.now();
    this.setData({ items: d.memories.map(m => ({ ...m,
      subjectLabel: MEMORY_SUBJECTS.find(s => s.value === (m.subject ?? 'unspecified'))?.label,
      expires: m.expiresAt ? readableTime(m.expiresAt) : '长期（直到纠正、删除或来源过期）',
      expired: m.expiresAt != null && m.expiresAt <= now, conflict: Boolean(memoryConflict(m, d.memories, now)) })) });
  } catch(e) { this.setData({ error: e instanceof Error ? e.message : '读取记忆失败' }); } },
  input(e: WechatMiniprogram.Input) { const field = e.currentTarget?.dataset?.field ?? 'text';
    if (['text', 'topic', 'sourceNote'].includes(field)) this.setData({ [field]: e.detail.value, error: '' }); },
  pickSubject(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (MEMORY_SUBJECTS[n]) this.setData({ subjectIndex: n }); },
  pickDuration(e: WechatMiniprogram.PickerChange) { const n = Number(e.detail.value); if (MEMORY_DURATIONS[n]) this.setData({ durationIndex: n }); },
  edit(e: WechatMiniprogram.TouchEvent) { const m = this.data.items.find(v => v.id === e.currentTarget.dataset.id); if (!m) return;
    this.setData({ text: m.text, id: m.id, version: m.version, documentId: m.documentId ?? '', topic: m.topic ?? '', sourceNote: m.sourceNote ?? '', error: '',
      subjectIndex: Math.max(0, MEMORY_SUBJECTS.findIndex(s => s.value === m.subject)), durationIndex: Math.max(0, MEMORY_DURATIONS.findIndex(d => d.value === m.validFor)) }); },
  cancelEdit() { this.setData({ text: '', id: '', version: 0, topic: '', sourceNote: '', documentId: '', subjectIndex: 0, durationIndex: 0, error: '' }); },
  async save() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { const d = this.data; await call('companion.memory.save', { roleId: d.roleId, text: d.text, confirmed: false,
      subject: MEMORY_SUBJECTS[d.subjectIndex]!.value, topic: d.topic, sourceNote: d.sourceNote, validFor: MEMORY_DURATIONS[d.durationIndex]!.value,
      ...(d.id ? { id: d.id, version: d.version } : {}), ...(d.documentId ? { documentId: d.documentId } : {}) }); this.cancelEdit(); await this.load(); }
    catch(e) { this.setData({ error: e instanceof Error ? e.message : '保存失败' }); } finally { this.setData({ busy: false }); }
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
