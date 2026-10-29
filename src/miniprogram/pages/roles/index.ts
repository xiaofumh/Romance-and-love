import { call, toast, getMode } from '../../services/api';
import type { CompanionView, Conversation } from '../../../shared/companion';
Page({ data: { items: [] as CompanionView['roles'], error: '', busy: false },
  onShow() { return this.load(); },
  async load() { try { const v = await call<CompanionView>('companion.list'); this.setData({ items: v.roles, error: '' }); } catch(e) { this.setData({ items: [], error: e instanceof Error ? e.message : '加载失败' }); } },
  create() { wx.navigateTo({ url: '/pages/role-edit/index' }); },
  edit(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/role-edit/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }); },
  async chat(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return; this.setData({ busy: true });
    try { const v = await call<Conversation>('companion.conversation.create', { roleId: e.currentTarget.dataset.id }); wx.navigateTo({ url: `/pages/chat/index?id=${v.id}&mode=${getMode()}` }); }
    catch(e) { toast(e); } finally { this.setData({ busy: false }); }
  },
});
