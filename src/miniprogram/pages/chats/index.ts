import { call, getMode, readableTime, requestModeSwitch } from '../../services/api';
import type { Bootstrap } from '../../../shared/contracts';
import type { CompanionView } from '../../../shared/companion';
Page({ data: { bootstrap: null as Bootstrap | null, items: [] as unknown[], loading: true, error: '', mode: getMode() },
  loadTask: null as Promise<void> | null, loadMode: getMode(),
  onShow() { return this.load(); },
  async load(): Promise<void> {
    const mode = getMode();
    if (this.loadTask) {
      if (this.loadMode === mode) return this.loadTask;
      await this.loadTask;
      return this.load();
    }
    this.loadMode = mode;
    const task = this.fetchData(); this.loadTask = task;
    try { await task; } finally { if (this.loadTask === task) this.loadTask = null; }
  },
  async fetchData(): Promise<void> {
    const mode = getMode();
    this.setData({ loading: true, error: '', items: [], bootstrap: null, mode });
    try {
      const b = await call<Bootstrap>('session.bootstrap');
      if (mode !== getMode()) return;
      const v = await call<CompanionView>('companion.list');
      if (mode !== getMode()) return;
      this.setData({ bootstrap: b, items: [...v.conversations].sort((a, b) => b.updatedAt - a.updatedAt).map(c => {
        const role = v.roles.find(r => r.id === c.roleId); return { ...c, name: role?.name ?? c.title,
          avatar: role?.name.slice(0, 1) ?? '伴', personality: role?.personality, time: readableTime(c.updatedAt) };
      }) });
    } catch(e) { if (mode === getMode()) this.setData({ error: e instanceof Error ? e.message : '加载失败' }); }
    finally { if (mode === getMode()) this.setData({ loading: false }); }
  },
  open(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/chat/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}&mode=${getMode()}` }); },
  realChat() { requestModeSwitch('cloud'); },
  roles() { wx.switchTab({ url: '/pages/roles/index' }); },
  settings() { wx.switchTab({ url: '/pages/settings/index' }); },
});
