import { call, toast, readableTime } from '../../services/api';
import type { ReferenceDocument } from '../../../shared/companion';
import { referencePreview, referenceQuality } from '../../../shared/companion';
import type { ReferencePreview } from '../../../shared/companion';
Page({ data: { id: '', document: null as Omit<ReferenceDocument, 'turns'> | null, expires: '', error: '', turnCount: 0,
  previewRows: [] as ReferencePreview[], previewPage: 1, previewPages: 1, pageInput: '1', userCount: 0, referenceCount: 0, duplicateCount: 0 },
  previewSlices: [] as ReferencePreview[],
  async onLoad(q: Record<string, string>) { this.setData({ id: q.id ?? '' }); await this.load(); },
  async load() { try { const d = await call<ReferenceDocument>('companion.document.get', { id: this.data.id });
    this.previewSlices = referencePreview(d.turns); const { turns, ...metadata } = d;
    this.setData({ document: metadata, turnCount: turns.length, ...referenceQuality(turns), expires: readableTime(d.expiresAt), error: '', previewPages: Math.max(1, Math.ceil(this.previewSlices.length / 20)) }); this.showPreview(1);
  } catch(e) { this.previewSlices = []; this.setData({ document: null, previewRows: [], error: e instanceof Error ? e.message : '无法读取' }); } },
  onUnload() { this.previewSlices = []; },
  showPreview(page: number) { const n = Math.max(1, Math.min(this.data.previewPages, page)); this.setData({ previewPage: n, pageInput: String(n), previewRows: this.previewSlices.slice((n - 1) * 20, n * 20) }); },
  previous() { this.showPreview(this.data.previewPage - 1); },
  next() { this.showPreview(this.data.previewPage + 1); },
  pageInput(e: WechatMiniprogram.Input) { this.setData({ pageInput: e.detail.value }); },
  jump() { const n = Number(this.data.pageInput); if (Number.isInteger(n)) this.showPreview(n); },
  memory() { if (this.data.document) wx.navigateTo({ url: `/pages/role-memory/index?roleId=${this.data.document.roleId}&documentId=${this.data.id}` }); },
  remove() { wx.showModal({ title: '删除参考资料？', content: '删除后不再检索，取消在途回复，并清空曾引用此资料的会话正文，避免从旧回复带回资料。相关来源记忆也会移除。不可在应用中恢复。', success: async r => {
    if (!r.confirm) return; try { await call('companion.delete', { kind: 'document', id: this.data.id }); wx.navigateBack(); } catch(e) { toast(e); }
  } }); },
});
