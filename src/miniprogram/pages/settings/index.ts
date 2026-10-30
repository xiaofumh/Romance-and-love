import { call, getMode, resetDemo, requestModeSwitch, toast } from '../../services/api';
import { POLICY_VERSION } from '../../../shared/contracts';
import type { Bootstrap } from '../../../shared/contracts';
import { config } from '../../config';
import { streamHistoryExport, type CompanionExport } from '../../services/history-export';
import type { HistoryPage, HistoryCursor } from '../../../shared/history';

Page({
  data: { bootstrap: null as Bootstrap | null, version: config.version, mode: getMode(), busy: false, exportPath: '' },
  onShow() { void this.refresh(); },
  async refresh() { try { const b = await call<Bootstrap>('session.bootstrap'); this.setData({ bootstrap: b, mode: getMode() }); } catch (e) { this.setData({ bootstrap: null }); toast(e); } },
  async changeSetting(e: WechatMiniprogram.SwitchChange) {
    const field = e.currentTarget.dataset.field as string; if (!['historyEnabled', 'memoryEnabled'].includes(field)) return;
    const enabled = e.detail.value;
    const apply = async () => {
      try {
        if (!this.data.bootstrap?.accepted) await call('consent.update', { version: POLICY_VERSION, accepted: true });
        await call('settings.update', { [field]: enabled }); await this.refresh();
      } catch (error) { toast(error); await this.refresh(); }
    };
    if (enabled) {
      wx.showModal({ title: field === 'historyEnabled' ? '开启历史保存？' : '开启已确认记忆？',
        content: field === 'historyEnabled' ? '云端陪伴聊天按消息时间保存最近30天，不再按40条截断，可分页查看。手动删除会提前清理；本地演示受设备空间限制。旧版建议历史保留20条。模拟版仅在本地保存，云端模式上传至已配置服务。可随时删除。请先阅读隐私说明。' : '只使用你明确确认的事实，按用户与角色隔离。关闭记忆将清空全部陪伴会话正文，避免旧回复复述记忆；记忆条目本身需单独删除。请先阅读隐私说明。',
        confirmText: '同意开启', success: r => { if (r.confirm) void apply(); else void this.refresh(); } });
    } else if (field === 'memoryEnabled') {
      wx.showModal({ title: '关闭记忆并清空旧消息？', content: '清空全部陪伴会话正文，防止旧回复继续携带记忆。记忆条目仍保留，可单独删除。', success: r => { if (r.confirm) void apply(); else void this.refresh(); } });
    } else await apply();
  },
  profiles() { wx.navigateTo({ url: '/pages/profile/index' }); },
  legal() { wx.navigateTo({ url: '/pages/legal/index' }); },
  roles() { wx.switchTab({ url: '/pages/roles/index' }); },
  copyTestId() {
    const id = this.data.bootstrap?.contentReview?.testUserId;
    if (id && /^[a-f0-9]{64}$/.test(id)) wx.setClipboardData({ data: id });
  },
  legacy() { wx.navigateTo({ url: '/pages/compose/index' }); },
  legacyHistory() { wx.navigateTo({ url: '/pages/history/index' }); },
  clearCompanion() { this.confirm('清空全部陪伴数据？', '清除所有角色、会话正文、资料和记忆，取消在途回复。无正文的请求状态最多保留48小时，防止重复计费。不可在应用中恢复。', async () => { await call('companion.clear', { confirmed: true }); }); },
  exportData() { this.confirm('导出私人数据文件？', '将在本机保存未加密JSON，包含角色、聊天、资料和记忆。请自行保管并及时删除，切勿随意转发。', async () => {
    const mode = getMode(), data = await call<CompanionExport>('companion.export', { confirmed: true });
    if (getMode() !== mode) throw new Error('运行模式已切换，导出停止');
    const filePath = `${wx.env.USER_DATA_PATH}/companion-export-${Date.now()}.json`;
    const fs = wx.getFileSystemManager();
    this.setData({ exportPath: '' });
    try {
      await new Promise<void>((resolve, reject) => fs.writeFile({ filePath, data: '', encoding: 'utf8', success: () => resolve(), fail: () => reject(new Error('导出创建失败')) }));
      await streamHistoryExport(data, async (id: string, cursor?: HistoryCursor) => {
        if (getMode() !== mode) throw new Error('运行模式已切换，导出停止');
        return call<HistoryPage>('companion.history.page', { conversationId: id, ...(cursor ? { cursor } : {}) });
      }, chunk => new Promise<void>((resolve, reject) => fs.appendFile({ filePath, data: chunk, encoding: 'utf8', success: () => resolve(), fail: () => reject(new Error('导出空间不足或写入失败')) })));
      this.setData({ exportPath: filePath });
    } catch(e) { fs.unlink({ filePath, fail: () => {} }); throw e; }
  }); },
  shareExport() { if (this.data.exportPath) wx.shareFileMessage({ filePath: this.data.exportPath, fileName: 'AI陪伴-私人数据.json' }); },
  modePicker() {
    wx.showActionSheet({ itemList: ['本地模拟：通用模板，不上传内容', '真实模型：调用已配置云函数'], success: async r => {
      try { requestModeSwitch(r.tapIndex === 0 ? 'demo' : 'cloud'); }
      catch (error) { toast(error); }
    } });
  },
  clearHistory() { this.confirm('清空所有历史？', '历史记录与关联临时结果将被清除，正在处理的生成任务会取消。', async () => { await call('history.delete', { all: true }); }); },
  clearMemory() { this.confirm('清空全部记忆？', '已确认的事实与临时上下文将清除。历史记录仍需单独删除。', async () => { await call('memory.delete', { all: true }); }); },
  revoke() { this.confirm('撤回使用授权？', '撤回后停止生成并关闭后续保存。已有历史和记忆可在这里单独清除。', async () => { await call('consent.update', { version: POLICY_VERSION, accepted: false }); }); },
  deleteAccount() { this.confirm('删除账号业务数据？', '清除档案、记忆、历史和反馈。当前账号将停止生成；正式云端账号不提供自动恢复。', async () => { await call('account.delete', { confirmed: true }); }); },
  reset() {
    if (getMode() !== 'demo') return;
    this.confirm('重置本地演示？', '仅清除本项目的本地演示数据，恢复体验额度；不影响其他小程序或真实云端数据。', async () => { resetDemo(); });
  },
  confirm(title: string, content: string, action: () => Promise<void>) {
    wx.showModal({ title, content, confirmText: '确认', confirmColor: '#a76451', success: async r => {
      if (!r.confirm || this.data.busy) return;
      this.setData({ busy: true });
      try { await action(); await this.refresh(); wx.showToast({ title: '操作完成', icon: 'success' }); } catch (error) { toast(error); }
      finally { this.setData({ busy: false }); }
    } });
  },
});
