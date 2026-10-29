import { call, ClientError, toast, getMode, uniqueId, requestModeSwitch } from '../../services/api';
import { POLICY_VERSION } from '../../../shared/contracts';
import type { Bootstrap } from '../../../shared/contracts';
import type { Conversation, CompanionRole, ChatJob, ChatMessage } from '../../../shared/companion';
import { displayChatText, referenceCaption } from '../../../shared/companion';
import { INITIATIVE_LIMITS, naturalBubbles } from '../../../shared/interaction';
import { beijingClock, type BeijingClock } from '../../../shared/beijing-time';
type Detail = { conversation: Conversation; role: CompanionRole; jobs: ChatJob[];
  initiative?: { enabled: boolean; available: boolean; availableAt: number; reason: string }; serverTime?: number; clock?: BeijingClock };
Page({ data: { id: '', role: null as CompanionRole | null, messages: [] as ChatMessage[], text: '', busy: false, error: '',
  loading: false, loadError: '', expandedSources: {} as Record<string, boolean>, contextResetReason: '', beijingTime: '',
  bootstrap: null as Bootstrap | null, agreed: false, saveAgreed: false, pendingText: '', requestId: '', lastJob: null as ChatJob | null,
  bottom: '', mode: getMode(), contextRounds: 12, initiativeReason: '', initiativeBusy: false, initiativeNote: '', initiativeWaitMs: -1 },
  alive: true, visible: false, lastActivityAt: 0, initiativeSuppressed: false, initiativeTimer: null as ReturnType<typeof setTimeout> | null,
  initiativeServerDueAt: 0,
  loadTask: null as Promise<void> | null, loadKey: '', sessionMode: getMode(),
  onLoad(q: Record<string, string>) { this.sessionMode = q.mode === 'demo' || q.mode === 'cloud' ? q.mode : getMode(); this.setData({ id: q.id ?? '' }); },
  onShow() { this.alive = true; this.visible = true; this.lastActivityAt = Date.now(); return this.load(); },
  onHide() { this.visible = false; this.stopInitiative(); },
  onUnload() { this.alive = false; this.visible = false; this.stopInitiative(); },
  stopInitiative() { if (this.initiativeTimer) clearTimeout(this.initiativeTimer); this.initiativeTimer = null; },
  armInitiative() {
    this.stopInitiative();
    if (!this.alive || !this.visible || this.initiativeSuppressed || this.data.mode !== 'cloud' || this.data.busy || this.data.initiativeBusy || this.data.text.trim()
      || this.data.loading || this.data.pendingText || this.data.loadError || !this.data.bootstrap?.enabled || !this.data.bootstrap?.accepted
      || !this.data.bootstrap?.settings.historyEnabled || !this.data.role?.proactiveEnabled || this.data.initiativeWaitMs < 0) return;
    const delay = Math.max(100, this.initiativeServerDueAt - Date.now(), INITIATIVE_LIMITS.idleMs - (Date.now() - this.lastActivityAt));
    this.initiativeTimer = setTimeout(() => { this.initiativeTimer = null; void this.initiate(); }, delay);
  },
  async initiate() {
    if (!this.visible || !this.alive || getMode() !== this.sessionMode || this.data.mode !== 'cloud' || this.data.busy
      || this.initiativeSuppressed || this.data.loading || this.data.loadError || !this.data.bootstrap?.enabled || !this.data.bootstrap?.accepted
      || !this.data.bootstrap?.settings.historyEnabled || this.data.initiativeWaitMs < 0 || Date.now() < this.initiativeServerDueAt
      || Date.now() - this.lastActivityAt < INITIATIVE_LIMITS.idleMs
      || this.data.initiativeBusy || this.data.text.trim() || this.data.pendingText || !this.data.role?.proactiveEnabled) return;
    this.stopInitiative(); this.initiativeSuppressed = true; this.setData({ initiativeBusy: true, initiativeNote: 'AI正在主动接话，你可以继续写草稿…', initiativeWaitMs: -1 });
    const mode = getMode(), id = this.data.id;
    try {
      await call('companion.initiative', { conversationId: this.data.id }, uniqueId());
      if (this.alive && this.visible && id === this.data.id && mode === getMode()) { this.setData({ initiativeNote: '' }); await this.load(); }
    } catch(e) { if (this.alive && this.visible && id === this.data.id && mode === getMode()) this.setData({ initiativeNote: e instanceof ClientError && e.code === 'INITIATIVE_REPEATED'
      ? '本次话题与近期回复重复，已跳过，不会自动重试。' : '未确认本次主动接话结果，不会自动重试；重新进入会话可查看，你也可以继续写草稿。' }); }
    finally { if (this.alive) this.setData({ initiativeBusy: false, ...(this.visible ? {} : { initiativeNote: '' }) }); }
  },
  async load(): Promise<void> {
    const key = `${getMode()}:${this.data.id}`;
    if (this.loadTask) {
      if (this.loadKey === key) return this.loadTask;
      await this.loadTask;
      if (!this.alive) return;
      return this.load();
    }
    this.loadKey = key;
    const task = this.fetchData(); this.loadTask = task;
    try { await task; } finally { if (this.loadTask === task) this.loadTask = null; }
  },
  async fetchData(): Promise<void> {
    const mode = getMode(), id = this.data.id;
    this.stopInitiative();
    this.setData({ loading: true, loadError: '', mode, bootstrap: null });
    if (mode !== this.sessionMode) {
      this.setData({ loading: false, messages: [], role: null,
        loadError: '运行模式已切换，不能在另一模式打开这条会话。本地与云端记录分别保留，请返回当前模式会话列表。' });
      return;
    }
    try {
      // CloudBase reads currently also maintain/write the same user document.
      // Do not launch these transactions concurrently or auto-retry generation.
      const bootstrap = await call<Bootstrap>('session.bootstrap');
      if (!this.alive || mode !== getMode() || id !== this.data.id) return;
      const detail = await call<Detail>('companion.conversation.get', { id });
      if (!this.alive || mode !== getMode() || id !== this.data.id) return;
      this.initiativeServerDueAt = Date.now() + (detail.initiative?.availableAt ? Math.max(0, detail.initiative.availableAt - (detail.serverTime ?? Date.now())) : 0);
      this.setData({ role: detail.role, messages: detail.conversation.messages.map(m => ({ ...m, text: displayChatText(m),
        displayTime: Number.isFinite(m.createdAt) ? beijingClock(m.createdAt).dateTime.slice(0, 16) : '',
        displayParts: naturalBubbles(displayChatText(m), m.speaker === 'assistant' && detail.role.bubbleStyle === 'natural' ? 'natural' : 'single'), referenceCaption: referenceCaption(m.mode) })), bootstrap, mode,
        contextRounds: detail.conversation.contextRounds ?? 12,
        beijingTime: detail.clock?.dateTime ?? '', initiativeReason: detail.initiative?.reason ?? '',
        initiativeWaitMs: detail.initiative?.availableAt ? Math.max(0, detail.initiative.availableAt - (detail.serverTime ?? Date.now())) : -1,
        contextResetReason: detail.conversation.contextResetReason ?? '', lastJob: detail.jobs.at(-1) ?? null, bottom: `msg-${detail.conversation.messages.at(-1)?.id ?? 'end'}` });
      wx.setNavigationBarTitle({ title: `${detail.role.name} · AI` });
    } catch(e) { if (this.alive && mode === getMode() && id === this.data.id)
      this.setData({ loadError: e instanceof Error ? e.message : '加载失败' }); }
    finally { if (this.alive && mode === getMode() && id === this.data.id) { this.setData({ loading: false }); this.armInitiative(); } }
  },
  input(e: WechatMiniprogram.Input) { this.lastActivityAt = Date.now(); this.setData({ text: e.detail.value }); this.armInitiative(); },
  agree() { this.setData({ agreed: !this.data.agreed }); },
  agreeSave() { this.setData({ saveAgreed: !this.data.saveAgreed }); },
  legal() { wx.navigateTo({ url: '/pages/legal/index' }); },
  async enable() {
    if (!this.data.agreed || !this.data.saveAgreed) return toast(new Error('请分别确认使用说明与会话保存'));
    try { await call('consent.update', { version: POLICY_VERSION, accepted: true }); await call('settings.update', { historyEnabled: true }); await this.load(); }
    catch(e) { toast(e); }
  },
  async send() {
    if (this.data.busy || this.data.initiativeBusy || this.data.loading || this.data.loadError || !this.data.text.trim()) return;
    this.stopInitiative(); this.lastActivityAt = Date.now(); this.setData({ initiativeNote: '' });
    if (getMode() !== this.sessionMode) { await this.load(); return; }
    // Original requests may still be queried/replayed after access/model shutdown;
    // the server decides whether this is a replay or a new billable attempt.
    if (!this.data.requestId && !this.data.bootstrap?.enabled) return toast(new Error(this.data.bootstrap?.contentReview?.eligible === false
      ? '当前账号尚未获得访问权限，请到“我的”复制接入标识' : '云端模型尚未启用，请联系维护者完成配置'));
    if (this.data.pendingText && this.data.text.trim() !== this.data.pendingText) return toast(new Error('请先查询上一条消息状态，避免重复提交'));
    const text = this.data.text.trim(), mode = getMode(), requestId = this.data.requestId || uniqueId();
    this.setData({ busy: true, error: '', pendingText: text, requestId });
    try {
      const r = await call<{ job: ChatJob }>('companion.send', { conversationId: this.data.id, text }, requestId);
      if (!this.alive || mode !== getMode()) return;
      this.setData({ lastJob: r.job });
      if (r.job.status === 'SUCCEEDED') { this.initiativeSuppressed = false; this.setData({ text: '', pendingText: '', requestId: '' }); }
      else if (r.job.status !== 'PROCESSING') this.setData({ error: '该次请求已结束且未生成回复，可保留草稿后重新发送。' });
      await this.load();
    } catch(e) { if (this.alive && mode === getMode()) { this.setData({ error: e instanceof Error ? e.message : '发送失败' }); await this.load(); } }
    finally { if (this.alive && mode === getMode()) { this.setData({ busy: false }); this.armInitiative(); } }
  },
  async query() {
    if (this.data.busy) return;
    // Retrying with the original request id is idempotent even after a lost response.
    if (this.data.requestId) return this.send();
    this.setData({ error: '' }); await this.load();
  },
  discard() {
    if (this.data.busy || this.data.lastJob?.status === 'PROCESSING') return toast(new Error('请求仍在处理中，请先查询状态'));
    this.setData({ requestId: '', pendingText: '', error: '' });
  },
  settings() { this.stopInitiative(); wx.navigateTo({ url: `/pages/chat-settings/index?id=${encodeURIComponent(this.data.id)}` }); },
  realChat() { if (!this.data.busy && !this.data.pendingText) requestModeSwitch('cloud'); },
  home() { wx.switchTab({ url: '/pages/chats/index' }); },
  toggleSources(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    if (typeof id === 'string') this.setData({ expandedSources: { ...this.data.expandedSources, [id]: !this.data.expandedSources[id] } });
  },
  source(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/source/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }); },
  copy(e: WechatMiniprogram.TouchEvent) {
    const m = this.data.messages.find(v => v.id === e.currentTarget.dataset.id);
    if (m) wx.setClipboardData({ data: m.speaker === 'assistant' ? `【AI生成${m.mode === 'demo' ? '·模拟模板' : ''}】\n${m.text}` : m.text });
  },
});
