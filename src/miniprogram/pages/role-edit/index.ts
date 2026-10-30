import { call, toast } from '../../services/api';
import { PERSONALITIES, CLOSENESS, EMOTIONS, rolePreferences } from '../../../shared/companion';
import { POLICY_VERSION } from '../../../shared/contracts';
import type { CompanionRole, CompanionView } from '../../../shared/companion';
Page({ data: { id: '', version: 0, step: 0, name: '', relationship: 'friend', personality: '温柔倾听',
  description: '', boundaries: '', autonomousEnabled: false, ...rolePreferences({ bubbleStyle: 'natural' }), personalities: [...PERSONALITIES], closenessOptions: [...CLOSENESS], emotions: [...EMOTIONS], agreed: false, busy: false },
  async onLoad(q: Record<string, string>) { if (!q.id) return;
    try { const v = await call<CompanionView>('companion.list'), role = v.roles.find(r => r.id === q.id); if (!role) throw new Error('角色不存在'); this.setData({ ...role, ...rolePreferences(role), step: 2 }); } catch(e) { toast(e); }
  },
  input(e: WechatMiniprogram.Input) { const k = e.currentTarget.dataset.field as string; if (['name', 'description', 'boundaries', 'userAddress', 'selfAddress', 'habits'].includes(k)) this.setData({ [k]: e.detail.value }); },
  preference(e: WechatMiniprogram.TouchEvent) { const { field, value } = e.currentTarget.dataset;
    if (field === 'closeness' && (CLOSENESS as readonly string[]).includes(value) || field === 'emotion' && (EMOTIONS as readonly string[]).includes(value)) this.setData({ [field]: value }); },
  relationship(e: WechatMiniprogram.TouchEvent) { this.setData({ relationship: e.currentTarget.dataset.value }); },
  personality(e: WechatMiniprogram.TouchEvent) { this.setData({ personality: e.currentTarget.dataset.value }); },
  next() { this.setData({ step: Math.min(2, this.data.step + 1) }); },
  back() { this.setData({ step: Math.max(0, this.data.step - 1) }); },
  agree() { this.setData({ agreed: !this.data.agreed }); },
  changeInitiative(e: WechatMiniprogram.SwitchChange) { this.setData({ proactiveEnabled: e.detail.value, autonomousEnabled: e.detail.value }); },
  bubble(e: WechatMiniprogram.TouchEvent) { const v = e.currentTarget.dataset.value; if (v === 'single' || v === 'natural') this.setData({ bubbleStyle: v }); },
  legal() { wx.navigateTo({ url: '/pages/legal/index' }); },
  async save() {
    if (this.data.busy) return;
    if (!this.data.agreed) return toast(new Error('请阅读说明并确认这是AI角色，不是历史记录中的真人'));
    this.setData({ busy: true });
    try {
      await call('consent.update', { version: POLICY_VERSION, accepted: true });
      const d = this.data;
      const role = await call<CompanionRole>('companion.role.save', { ...(d.id ? { id: d.id, version: d.version } : {}), name: d.name,
        relationship: d.relationship, personality: d.personality, description: d.description, boundaries: d.boundaries,
        userAddress: d.userAddress, selfAddress: d.selfAddress, closeness: d.closeness, emotion: d.emotion, habits: d.habits,
          proactiveEnabled: d.proactiveEnabled, autonomousEnabled: d.autonomousEnabled, bubbleStyle: d.bubbleStyle });
      this.setData({ id: role.id, version: role.version }); wx.showToast({ title: '角色已保存' }); wx.navigateBack();
    } catch(e) { toast(e); } finally { this.setData({ busy: false }); }
  },
  memory() { wx.navigateTo({ url: `/pages/role-memory/index?roleId=${this.data.id}` }); },
  importData() { wx.navigateTo({ url: `/pages/import/index?roleId=${this.data.id}` }); },
  remove() { if (!this.data.id) return; wx.showModal({ title: '删除此角色？', content: '同时清除该角色的会话、资料和记忆，并取消正在处理的回复。不可在应用中恢复。', success: async r => {
    if (!r.confirm) return; try { await call('companion.delete', { kind: 'role', id: this.data.id }); wx.navigateBack(); } catch(e) { toast(e); }
  } }); },
});
