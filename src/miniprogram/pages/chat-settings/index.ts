import { call, toast } from '../../services/api';
import type { CompanionRole, Conversation } from '../../../shared/companion';
Page({ data: { id: '', role: null as CompanionRole | null, count: 0, contextResetReason: '', contextRounds: 12, interactionMode: 'listening', settingsVersion: 1, busy: false },
  onLoad(q: Record<string, string>) { this.setData({ id: q.id ?? '' }); },
  async onShow() { try { const d = await call<{ role: CompanionRole; conversation: Conversation }>('companion.conversation.get', { id: this.data.id }); this.setData({ role: d.role, count: d.conversation.messages.length, contextResetReason: d.conversation.contextResetReason ?? '', contextRounds: d.conversation.contextRounds ?? 12, interactionMode: d.conversation.interaction?.mode ?? 'listening', settingsVersion: d.conversation.settingsVersion ?? 1 }); } catch(e) { toast(e); } },
  context(e: WechatMiniprogram.TouchEvent) {
    const rounds = Number(e.currentTarget.dataset.rounds); if (this.data.busy || ![6, 12].includes(rounds) || rounds === this.data.contextRounds) return;
    wx.showModal({ title: `使用${rounds}轮历史上下文？`, content: (rounds === 12 ? '默认12轮按最近12条用户消息分组，保留对应回复和主动接话，最多36条语义消息。' : '6轮原版按最多12条近期消息截取。') + '每条历史仍最多600字符，纠错和隐私边界保持不变。仅当前会话变更，将取消当前账号在途生成，不重置每日额度。', success: async r => {
      if (!r.confirm || this.data.busy) return; this.setData({ busy: true });
      try { await call('companion.conversation.configure', { id: this.data.id, version: this.data.settingsVersion, contextRounds: rounds }); await this.onShow(); }
      catch(e) { toast(e); } finally { this.setData({ busy: false }); }
    } });
  },
  role() { wx.navigateTo({ url: `/pages/role-edit/index?id=${this.data.role?.id}` }); },
  memory() { wx.navigateTo({ url: `/pages/role-memory/index?roleId=${this.data.role?.id}` }); },
  importData() { wx.navigateTo({ url: `/pages/import/index?roleId=${this.data.role?.id}` }); },
  remove() { wx.showModal({ title: '删除当前会话？', content: '删除全部消息并取消在途回复。角色、参考资料和已确认记忆仍保留。', success: async r => {
    if (!r.confirm) return; try { await call('companion.delete', { kind: 'conversation', id: this.data.id }); wx.switchTab({ url: '/pages/chats/index' }); } catch(e) { toast(e); }
  } }); },
});
