import { call, readableTime, toast } from '../../services/api';
import type { Bootstrap, Memory } from '../../../shared/contracts';
Page({
  data: { profileId: '', items: [] as (Memory & { timeLabel: string })[], enabled: false,
    text: '', confirmed: false, editingId: '', editingVersion: 0, saving: false },
  onLoad(query: Record<string, string | undefined>) { this.setData({ profileId: query.profileId ?? '' }); },
  onShow() { void this.load(); },
  async load() { try {
    const b = await call<Bootstrap>('session.bootstrap');
    const items = await call<Memory[]>('memory.list', { profileId: this.data.profileId });
    this.setData({ enabled: b.settings.memoryEnabled, items: items.map(m => ({ ...m, timeLabel: readableTime(m.confirmedAt) })) });
  } catch (e) { toast(e); } },
  input(e: WechatMiniprogram.Input) { this.setData({ text: e.detail.value }); },
  confirm() { this.setData({ confirmed: !this.data.confirmed }); },
  settings() { wx.switchTab({ url: '/pages/settings/index' }); },
  async save() {
    if (this.data.saving || !this.data.enabled) return;
    if (!this.data.confirmed) { toast(new Error('请先确认这条事实真实且可用于生成')); return; }
    this.setData({ saving: true });
    try { await call('memory.save', { profileId: this.data.profileId, text: this.data.text, confirmed: true,
      ...(this.data.editingId ? { id: this.data.editingId, version: this.data.editingVersion } : {}) }); this.cancel(); await this.load(); }
    catch (e) { toast(e); } finally { this.setData({ saving: false }); }
  },
  cancel() { this.setData({ text: '', confirmed: false, editingId: '', editingVersion: 0 }); },
  edit(e: WechatMiniprogram.TouchEvent) { const m = this.data.items.find(v => v.id === e.currentTarget.dataset.id); if (m) this.setData({ text: m.text, editingId: m.id, editingVersion: m.version, confirmed: false }); },
  remove(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    wx.showModal({ title: '删除这条记忆？', content: '后续生成不再使用该事实。历史记录需另行清除。', confirmText: '删除', confirmColor: '#a76451', success: async r => {
      if (!r.confirm) return; try { await call('memory.delete', { id }); this.cancel(); await this.load(); } catch (error) { toast(error); }
    } });
  },
});
