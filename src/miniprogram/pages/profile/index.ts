import { call, toast } from '../../services/api';
import { SCENES } from '../../../shared/contracts';
import type { Profile } from '../../../shared/contracts';
Page({
  data: { items: [] as Profile[], sceneNames: SCENES.map(s => s.label), sceneIndex: 0,
    editingId: '', editingVersion: 0, alias: '', preferences: '', blockedTopics: '', saving: false },
  onShow() { void this.load(); },
  async load() { try { this.setData({ items: await call<Profile[]>('profile.list') }); } catch (e) { toast(e); } },
  input(e: WechatMiniprogram.Input) { const f = e.currentTarget.dataset.field as string; if (['alias', 'preferences', 'blockedTopics'].includes(f)) this.setData({ [f]: e.detail.value }); },
  scene(e: WechatMiniprogram.PickerChange) { this.setData({ sceneIndex: Number(e.detail.value) }); },
  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await call('profile.save', { ...(this.data.editingId ? { id: this.data.editingId, version: this.data.editingVersion } : {}),
        alias: this.data.alias, scene: SCENES[this.data.sceneIndex]?.value ?? 'daily', preferences: this.data.preferences, blockedTopics: this.data.blockedTopics });
      this.cancel(); await this.load(); wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) { toast(e); } finally { this.setData({ saving: false }); }
  },
  cancel() { this.setData({ editingId: '', editingVersion: 0, alias: '', preferences: '', blockedTopics: '', sceneIndex: 0 }); },
  edit(e: WechatMiniprogram.TouchEvent) { const p = this.data.items.find(v => v.id === e.currentTarget.dataset.id); if (p) this.setData({ editingId: p.id, editingVersion: p.version, alias: p.alias, preferences: p.preferences, blockedTopics: p.blockedTopics, sceneIndex: SCENES.findIndex(s => s.value === p.scene) }); },
  memory(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/memory/index?profileId=${encodeURIComponent(String(e.currentTarget.dataset.id))}` }); },
  remove(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    wx.showModal({ title: '删除表达档案？', content: '关联的记忆和历史会一并删除，进行中的生成会取消。', confirmText: '删除', confirmColor: '#a76451', success: async r => {
      if (!r.confirm) return;
      try { await call('profile.delete', { id }); this.cancel(); await this.load(); } catch (error) { toast(error); }
    } });
  },
});
