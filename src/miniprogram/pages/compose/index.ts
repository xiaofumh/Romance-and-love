import { call, ClientError, readableTime, toast, uniqueId } from '../../services/api';
import { labelledText, SCENES, TONES, POLICY_VERSION } from '../../../shared/contracts';
import type { Bootstrap, GenerationView, Profile, Reply } from '../../../shared/contracts';

Page({
  data: { scenes: SCENES, tones: TONES, scene: 'daily', tone: 'natural', length: 'short',
    message: '', background: '', goal: '', showBackground: false, accepted: false, saving: false,
    busy: false, initializing: true, error: '', result: null as GenerationView | null, bootstrap: null as Bootstrap | null,
    profiles: [] as Profile[], profileNames: ['不使用档案'], profileIndex: 0,
    editing: false, editText: '', editIndex: -1, copiedId: '', generatedAt: '', hasPending: false,
  },
  pending: null as { requestId: string; payload: Record<string, unknown> } | null,
  async onShow() { await this.refresh(); },
  async refresh() {
    this.setData({ result: null, copiedId: '', error: '', initializing: true });
    try {
      const b = await call<Bootstrap>('session.bootstrap');
      const p = b.status === 'ACTIVE' ? await call<Profile[]>('profile.list') : [];
      this.setData({ bootstrap: b, accepted: b.accepted, saving: b.settings.historyEnabled,
        profiles: p, profileNames: ['不使用档案', ...p.map(x => x.alias)], profileIndex: 0 });
      if (!b.accepted || b.status !== 'ACTIVE') this.setData({ result: null });
    } catch (e) { this.setData({ bootstrap: null, error: e instanceof Error ? e.message : '初始化失败，请稍后重试' }); }
    finally { this.setData({ initializing: false }); }
  },
  onField(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    if (['message', 'background', 'goal'].includes(field)) { this.setData({ [field]: e.detail.value }); this.pending = null; }
  },
  select(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const field = e.currentTarget.dataset.field as string;
    if (['scene', 'tone', 'length'].includes(field)) { this.setData({ [field]: e.currentTarget.dataset.value }); this.pending = null; }
  },
  toggleBackground() { this.setData({ showBackground: !this.data.showBackground }); },
  toggleConsent() { this.setData({ accepted: !this.data.accepted }); },
  onProfile(e: WechatMiniprogram.PickerChange) { if (this.data.busy) return; this.setData({ profileIndex: Number(e.detail.value), hasPending: false }); this.pending = null; },
  openProfiles() { wx.navigateTo({ url: '/pages/profile/index' }); },
  openSettings() { wx.switchTab({ url: '/pages/settings/index' }); },
  openLegal() { wx.navigateTo({ url: '/pages/legal/index' }); },
  example(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key;
    const samples = key === 'work' ? { message: '这个需求明天能全部做完吗？', background: '还有两项需求没有明确，不能确定工期。', goal: '礼貌确认范围，不承诺未经评估的时间。', scene: 'work' } : key === 'refuse' ?
      { message: '周末你一定要陪我去，我都答应别人了。', background: '我不想参加这次活动。', goal: '温和拒绝，保持边界。', scene: 'daily' } :
      { message: '你是不是最近不想理我？', background: '今天开会较多，今晚是否有空还不确定。', goal: '解释回复慢，不承诺时间。', scene: 'relationship' };
    this.setData({ ...samples, showBackground: true, result: null, error: '' }); this.pending = null;
  },
  async generate() {
    if (this.data.busy) return;
    if (this.data.initializing || !this.data.bootstrap) { this.setData({ error: '尚未完成初始化，请点击重新加载。' }); return; }
    if (!this.data.message.trim()) { this.setData({ error: '先输入对方的话，或试试上方的示例。' }); return; }
    if (!this.data.accepted) { this.setData({ error: '请先阅读并同意使用与隐私说明。' }); return; }
    if (this.data.background.length + this.data.goal.length > 1000) { this.setData({ error: '补充背景和目标合计最多1000字。' }); return; }
    const b = this.data.bootstrap;
    if (b?.status !== 'ACTIVE') { this.setData({ error: '当前账号数据已删除。模拟模式可在“我的”重置体验数据。' }); return; }
    const payload = { message: this.data.message, background: this.data.background, goal: this.data.goal,
      scene: this.data.scene, tone: this.data.tone, length: this.data.length,
      profileId: this.data.profiles[this.data.profileIndex - 1]?.id ?? null,
      saveHistory: b.settings.historyEnabled && this.data.saving };
    this.setData({ busy: true, error: '', result: null });
    try {
      if (!b.accepted) await call('consent.update', { version: POLICY_VERSION, accepted: true });
      if (!this.pending) this.pending = { requestId: uniqueId(), payload };
      const result = await call<GenerationView>('generation.create', this.pending.payload, this.pending.requestId);
      this.displayResult(result);
      this.pending = result.status === 'PROCESSING' ? this.pending : null;
      if (result.status === 'PROCESSING') this.setData({ error: '原请求仍在处理中，请稍后查询，不会重复调用模型。' });
    } catch (e) {
      const uncertain = e instanceof ClientError && ['NETWORK_ERROR', 'PROVIDER_TIMEOUT', 'GENERATION_PENDING'].includes(e.code);
      if (!uncertain) this.pending = null;
      this.setData({ error: e instanceof Error ? e.message : '生成失败，请稍后重试' });
    } finally { this.setData({ busy: false, hasPending: Boolean(this.pending) }); }
  },
  displayResult(result: GenerationView) {
    this.setData({ result, generatedAt: readableTime(Date.now()), copiedId: '',
      ...(this.data.bootstrap ? { bootstrap: { ...this.data.bootstrap, accepted: true, remainingQuota: result.remainingQuota } } : {}) });
    if (result.status !== 'SUCCEEDED' && result.status !== 'PROCESSING') this.setData({ error: '该请求未产生可用回复，本次没有扣除体验额度。' });
  },
  async copy(e: WechatMiniprogram.TouchEvent) {
    const r = this.data.result?.replies?.[Number(e.currentTarget.dataset.index)]; if (!r) return;
    wx.setClipboardData({ data: labelledText(r.text), success: () => { this.setData({ copiedId: r.id }); }, fail: () => toast(new Error('复制失败，请重试')) });
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.index); const r = this.data.result?.replies?.[idx];
    if (r) this.setData({ editing: true, editText: r.text, editIndex: idx });
  },
  onEdit(e: WechatMiniprogram.Input) { this.setData({ editText: e.detail.value }); },
  closeEdit() { this.setData({ editing: false }); },
  saveEdit() {
    if (!this.data.editText.trim() || !this.data.result?.replies) return;
    const replies: Reply[] = this.data.result.replies.map((r, i) => i === this.data.editIndex ? { ...r, text: this.data.editText.trim() } : r);
    this.setData({ result: { ...this.data.result, replies }, editing: false });
  },
  async feedback(e: WechatMiniprogram.TouchEvent) {
    const generationId = this.data.result?.generationId; if (!generationId) return;
    const reasons = ['unnatural', 'invented', 'offensive', 'other'];
    wx.showActionSheet({ itemList: ['不够自然', '编造事实', '表达冒犯', '其他问题'], success: async r => {
      try { await call('feedback.create', { generationId, reason: reasons[r.tapIndex] }); wx.showToast({ title: '已记录反馈', icon: 'success' }); } catch (error) { toast(error); }
    } });
  },
  clear() { if (!this.data.busy) { this.pending = null; this.setData({ message: '', background: '', goal: '', result: null, error: '', hasPending: false }); } },
  noop() {},
});
