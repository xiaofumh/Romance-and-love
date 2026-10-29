import { call, toast } from '../../services/api';
import type { CompanionView, CompanionRole, CompanionMemory } from '../../../shared/companion';
type Docs = { id: string; title: string; count: number; expiresAt: number };
Page({ data: { roles: [] as CompanionRole[], selected: 0, roleId: '', documents: [] as Docs[], memoryCount: 0, error: '' },
  onShow() { return this.load(); },
  async load() {
    try { const v = await call<CompanionView>('companion.list');
      const index = Math.max(0, v.roles.findIndex(r => r.id === this.data.roleId)), roleId = v.roles[index]?.id ?? '';
      this.setData({ roles: v.roles, selected: index, roleId, error: '', documents: [], memoryCount: 0 }); await this.details();
    } catch(e) { this.setData({ error: e instanceof Error ? e.message : '加载失败' }); }
  },
  async details() {
    if (!this.data.roleId) return; const roleId = this.data.roleId;
    try { const d = await call<{ documents: Docs[]; memories: CompanionMemory[] }>('companion.data', { id: roleId });
      if (roleId === this.data.roleId) this.setData({ documents: d.documents, memoryCount: d.memories.filter(m => m.status === 'confirmed').length });
    } catch(e) { toast(e); }
  },
  async select(e: WechatMiniprogram.PickerChange) { const selected = Number(e.detail.value); this.setData({ selected, roleId: this.data.roles[selected]?.id ?? '', documents: [], memoryCount: 0 }); await this.details(); },
  importData() { if (this.data.roleId) wx.navigateTo({ url: `/pages/import/index?roleId=${this.data.roleId}` }); },
  memory() { if (this.data.roleId) wx.navigateTo({ url: `/pages/role-memory/index?roleId=${this.data.roleId}` }); },
  source(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/source/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }); },
  roles() { wx.switchTab({ url: '/pages/roles/index' }); },
});
