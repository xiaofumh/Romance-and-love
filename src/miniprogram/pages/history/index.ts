import { call, readableTime, toast } from '../../services/api';
import { labelledText, SCENES, TONES } from '../../../shared/contracts';
import type { Bootstrap, History } from '../../../shared/contracts';
type Item = History & { timeLabel: string; sceneLabel: string; toneLabel: string };
Page({
  data: { items: [] as Item[], loading: false, expanded: '', cursor: null as string | null,
    enabled: false, mode: 'demo', error: '' },
  onShow() { this.setData({ items: [], cursor: null, expanded: '' }); void this.load(false); },
  async load(more = false) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const b = await call<Bootstrap>('session.bootstrap');
      this.setData({ enabled: b.settings.historyEnabled, mode: b.mode });
      const data = await call<{ items: History[]; nextCursor: string | null }>('history.list', { limit: 10, ...(more && this.data.cursor ? { cursor: this.data.cursor } : {}) });
      const items = data.items.map(h => ({ ...h, timeLabel: readableTime(h.createdAt), sceneLabel: SCENES.find(s => s.value === h.scene)?.label ?? h.scene, toneLabel: TONES.find(t => t.value === h.tone)?.label ?? h.tone }));
      this.setData({ items: more ? [...this.data.items, ...items] : items, cursor: data.nextCursor });
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : '读取失败' }); }
    finally { this.setData({ loading: false }); }
  },
  more() { void this.load(true); },
  toggle(e: WechatMiniprogram.TouchEvent) { const id = String(e.currentTarget.dataset.id); this.setData({ expanded: this.data.expanded === id ? '' : id }); },
  copy(e: WechatMiniprogram.TouchEvent) {
    const item = this.data.items.find(h => h.id === e.currentTarget.dataset.id);
    const r = item?.replies[Number(e.currentTarget.dataset.index)];
    if (r) wx.setClipboardData({ data: labelledText(r.text), fail: () => toast(new Error('复制失败，请重试')) });
  },
  remove(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id);
    wx.showModal({ title: '删除这条记录？', content: '关联的临时生成结果会一起清除，无法从任务接口恢复。', confirmText: '删除', confirmColor: '#a76451', success: async r => {
      if (!r.confirm) return;
      try { await call('history.delete', { id }); await this.load(); } catch (error) { toast(error); }
    } });
  },
  openSettings() { wx.switchTab({ url: '/pages/settings/index' }); },
  compose() { wx.navigateTo({ url: '/pages/compose/index' }); },
});
