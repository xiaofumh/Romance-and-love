import { call, ClientError, toast, getMode, uniqueId, requestModeSwitch, getListSignal } from '../../services/api';
import { POLICY_VERSION } from '../../../shared/contracts';
import type { Bootstrap } from '../../../shared/contracts';
import type { Conversation, CompanionRole, ChatJob, ChatMessage } from '../../../shared/companion';
import { displayChatText, referenceCaption } from '../../../shared/companion';
import { INITIATIVE_LIMITS, naturalBubbles } from '../../../shared/interaction';
import { beijingClock, type BeijingClock } from '../../../shared/beijing-time';
import type { HistoryCursor, HistoryPage } from '../../../shared/history';

function presented(messages: ChatMessage[], role: CompanionRole) {
  return messages.map(m => ({ ...m, text: displayChatText(m), displayTime: Number.isFinite(m.createdAt) ? beijingClock(m.createdAt).dateTime.slice(0, 16) : '',
    displayParts: naturalBubbles(displayChatText(m), m.speaker === 'assistant' && role.bubbleStyle === 'natural' ? 'natural' : 'single'), referenceCaption: referenceCaption(m.mode) }));
}
type Detail = { conversation: Conversation; role: CompanionRole; jobs: ChatJob[];
  initiative?: { enabled: boolean; available: boolean; availableAt: number; reason: string }; serverTime?: number; clock?: BeijingClock };
Page({ data: { id: '', role: null as CompanionRole | null, messages: [] as ChatMessage[], text: '', busy: false, error: '',
  loading: false, loadError: '', expandedSources: {} as Record<string, boolean>, contextResetReason: '', beijingTime: '',
  bootstrap: null as Bootstrap | null, agreed: false, saveAgreed: false, pendingText: '', requestId: '', lastJob: null as ChatJob | null,
  bottom: '', mode: getMode(), contextRounds: 12, initiativeReason: '', initiativeBusy: false, initiativeNote: '', initiativeWaitMs: -1, historyHasMore: false, olderBusy: false },
  historyCursor: null as HistoryCursor | null, historyEpoch: 0, historyHasMore: false, olderBusy: false, viewingOlder: false,
  alive: true, visible: false, lastActivityAt: 0, initiativeSuppressed: false, initiativeTimer: null as ReturnType<typeof setTimeout> | null,
  initiativeServerDueAt: 0,
  syncTimer: null as ReturnType<typeof setTimeout> | null, presenceTimer: null as ReturnType<typeof setTimeout> | null,
  loadTask: null as Promise<void> | null, loadKey: '', sessionMode: getMode(),
  onLoad(q: Record<string, string>) { this.sessionMode = q.mode === 'demo' || q.mode === 'cloud' ? q.mode : getMode(); this.setData({ id: q.id ?? '' }); },
  onShow() { this.alive = true; this.visible = true; this.lastActivityAt = Date.now(); return this.load().finally(() => this.armSync()); },
  onHide() { this.visible = false; this.stopInitiative(); this.stopSync(); void this.presence(false); },
  onUnload() { this.alive = false; this.visible = false; this.stopInitiative(); this.stopSync(); void this.presence(false); },
  stopSync() { if (this.syncTimer) clearTimeout(this.syncTimer); if (this.presenceTimer) clearTimeout(this.presenceTimer); this.syncTimer = null; this.presenceTimer = null; },
  armSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (!this.alive || !this.visible || this.data.mode !== 'cloud' || !this.data.role?.autonomousEnabled) return;
    this.syncTimer = setTimeout(async () => { this.syncTimer = null;
      if (this.visible && !this.data.busy && !this.data.initiativeBusy && !this.data.text.trim() && !this.data.pendingText) await this.load(true);
      this.armSync();
    }, 15000);
  },
  async presence(composing: boolean) {
    if (this.presenceTimer) clearTimeout(this.presenceTimer); this.presenceTimer = null;
    if (!this.data.role?.autonomousEnabled || this.sessionMode !== 'cloud' || getMode() !== this.sessionMode
      || !this.data.bootstrap?.accepted || !this.data.bootstrap?.settings.historyEnabled) return;
    try { await call('companion.presence', { conversationId: this.data.id, composing }); } catch { /* Never block a draft or invent a sent status. */ }
    if (composing && this.visible && this.alive && this.data.text.trim()) this.presenceTimer = setTimeout(() => { void this.presence(true); }, 30000);
  },
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
      if (this.alive && this.visible && id === this.data.id && mode === getMode()) { this.initiativeSuppressed = !this.data.role?.autonomousEnabled; this.setData({ initiativeNote: '' }); await this.load(true); }
    } catch(e) { if (this.alive && this.visible && id === this.data.id && mode === getMode()) this.setData({ initiativeNote: e instanceof ClientError && e.code === 'INITIATIVE_REPEATED'
      ? '本次话题与近期回复重复，已跳过，不会自动重试。' : '未确认本次主动接话结果，不会自动重试；重新进入会话可查看，你也可以继续写草稿。' }); }
    finally { if (this.alive) this.setData({ initiativeBusy: false, ...(this.visible ? {} : { initiativeNote: '' }) }); }
  },
  async load(silent: unknown = false): Promise<void> {
    const key = `${getMode()}:${this.data.id}`;
    if (this.loadTask) {
      if (this.loadKey === key) return this.loadTask;
      await this.loadTask;
      if (!this.alive) return;
      return this.load();
    }
    this.loadKey = key;
    const task = this.fetchData(silent === true); this.loadTask = task;
    try { await task; } finally { if (this.loadTask === task) this.loadTask = null; }
  },
  async fetchData(silent = false): Promise<void> {
    const mode = getMode(), id = this.data.id, privacyReset = getListSignal().reset;
    this.stopInitiative();
    this.setData({ loading: !silent, loadError: '', mode, ...(silent ? {} : { bootstrap: null }) });
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
      if (privacyReset !== getListSignal().reset) { this.setData({ messages: [] }); return; }
      this.initiativeServerDueAt = Date.now() + (detail.initiative?.availableAt ? Math.max(0, detail.initiative.availableAt - (detail.serverTime ?? Date.now())) : 0);
      const epoch = detail.conversation.history?.epoch ?? 0, recent = detail.conversation.messages.slice(-40);
      const keepOlder = silent && this.viewingOlder && this.historyEpoch === epoch && recent.some(m => this.data.messages.some(v => v.id === m.id));
      const visible = keepOlder ? [...new Map([...this.data.messages.filter(m => m.createdAt > (detail.serverTime ?? Date.now()) - 30 * 86400000), ...recent].map(m => [m.id, m])).values()] : recent;
      if (!keepOlder) {
        this.viewingOlder = false; this.historyEpoch = epoch;
        this.historyCursor = recent[0] ? { epoch, beforeId: recent[0].id } : null;
        this.historyHasMore = detail.conversation.messages.length >= 40 || (detail.conversation.history?.nextSequence ?? 0) > recent.length;
      }
      this.setData({ role: detail.role, messages: presented(visible, detail.role), historyHasMore: this.historyHasMore, bootstrap, mode,
        contextRounds: detail.conversation.contextRounds ?? 12,
        beijingTime: detail.clock?.dateTime ?? '', initiativeReason: detail.initiative?.reason ?? '',
        initiativeWaitMs: detail.initiative?.availableAt ? Math.max(0, detail.initiative.availableAt - (detail.serverTime ?? Date.now())) : -1,
        contextResetReason: detail.conversation.contextResetReason ?? '', lastJob: detail.jobs.at(-1) ?? null,
        ...(keepOlder || silent && this.data.messages.at(-1)?.id === detail.conversation.messages.at(-1)?.id ? {} : { bottom: `msg-${detail.conversation.messages.at(-1)?.id ?? 'end'}` }) });
      wx.setNavigationBarTitle({ title: `${detail.role.name} · AI` });
    } catch(e) { if (this.alive && mode === getMode() && id === this.data.id)
      this.setData({ loadError: e instanceof Error ? e.message : '加载失败' }); }
    finally { if (this.alive && mode === getMode() && id === this.data.id) { this.setData({ loading: false }); this.armInitiative(); } }
  },
  async loadOlder() {
    if (this.olderBusy || !this.historyHasMore || !this.historyCursor || this.data.loading || !this.data.role) return;
    const mode = getMode(), id = this.data.id, epoch = this.historyEpoch, cursor = this.historyCursor, firstId = this.data.messages[0]?.id, privacyReset = getListSignal().reset;
    this.olderBusy = true; this.setData({ olderBusy: true });
    try { const page = await call<HistoryPage>('companion.history.page', { conversationId: id, cursor });
      if (!this.alive || mode !== getMode() || id !== this.data.id || epoch !== this.historyEpoch || privacyReset !== getListSignal().reset) return;
      this.viewingOlder = true; this.historyEpoch = page.epoch; this.historyCursor = page.cursor ?? null; this.historyHasMore = page.hasMore;
      const messages = [...new Map([...page.messages, ...this.data.messages].map(m => [m.id, m])).values()];
      // 分页只更新展示，不把翻页记录上传为模型上下文；保留原顶部锚点。
      this.setData({ messages: presented(messages, this.data.role!), historyHasMore: page.hasMore, ...(firstId ? { bottom: `msg-${firstId}` } : {}) });
    } catch(e) { if (mode === getMode()) toast(e); }
    finally { this.olderBusy = false; this.setData({ olderBusy: false }); }
  },
  input(e: WechatMiniprogram.Input) { const wasTyping = Boolean(this.data.text.trim()); this.lastActivityAt = Date.now(); this.setData({ text: e.detail.value }); this.armInitiative();
    if (wasTyping !== Boolean(this.data.text.trim())) void this.presence(Boolean(this.data.text.trim())); },
  agree() { this.setData({ agreed: !this.data.agreed }); },
  agreeSave() { this.setData({ saveAgreed: !this.data.saveAgreed }); },
  legal() { wx.navigateTo({ url: '/pages/legal/index' }); },
  async enable() {
    if (!this.data.agreed || !this.data.saveAgreed) return toast(new Error('请分别确认使用说明与会话保存'));
    try { await call('consent.update', { version: POLICY_VERSION, accepted: true }); await call('settings.update', { historyEnabled: true }); await this.load(); }
    catch(e) { toast(e); }
  },
  async send(replay: unknown = false) {
    if (this.data.busy || (this.data.initiativeBusy && !this.data.role?.autonomousEnabled) || this.data.loading || this.data.loadError) return;
    const retry = replay === true, text = retry ? this.data.pendingText : this.data.text.trim();
    if (!text) return;
    if (!retry && this.data.requestId) return toast(new Error('上一条仍待确认，请先查询原请求；新草稿会保留'));
    this.stopInitiative(); this.lastActivityAt = Date.now(); this.setData({ initiativeNote: '' });
    if (getMode() !== this.sessionMode) { await this.load(); return; }
    // Original requests may still be queried/replayed after access/model shutdown;
    // the server decides whether this is a replay or a new billable attempt.
    if (!this.data.requestId && !this.data.bootstrap?.enabled) return toast(new Error(this.data.bootstrap?.contentReview?.eligible === false
      ? '当前账号尚未获得访问权限，请到“我的”复制接入标识' : '云端模型尚未启用，请联系维护者完成配置'));
    const mode = getMode(), requestId = this.data.requestId || uniqueId();
    // Render the outgoing bubble and release the composer before any network
    // await. The pending bubble is not a server-delivery acknowledgement.
    this.setData({ busy: true, error: '', pendingText: text, requestId, text: retry ? this.data.text : '', lastJob: null, bottom: 'msg-end' });
    if (this.presenceTimer) clearTimeout(this.presenceTimer); this.presenceTimer = null;
    try {
      const r = await call<{ job: ChatJob }>('companion.send', { conversationId: this.data.id, text }, requestId);
      if (!this.alive || mode !== getMode()) return;
      this.setData({ lastJob: r.job });
      if (r.job.status === 'SUCCEEDED') { this.initiativeSuppressed = false; this.setData({ pendingText: '', requestId: '' }); }
      else if (r.job.status !== 'PROCESSING') this.setData({ error: '该次请求已结束且未生成回复，可保留草稿后重新发送。' });
      await this.load();
    } catch(e) { if (this.alive && mode === getMode()) { this.setData({ error: e instanceof Error ? e.message : '发送失败' }); await this.load(); } }
    finally { if (this.alive && mode === getMode()) { this.setData({ busy: false }); this.armInitiative(); } }
  },
  async query() {
    if (this.data.busy) return;
    // Retrying with the original request id is idempotent even after a lost response.
    if (this.data.requestId) return this.send(true);
    this.setData({ error: '' }); await this.load();
  },
  discard() {
    if (this.data.busy || this.data.lastJob?.status === 'PROCESSING') return toast(new Error('请求仍在处理中，请先查询状态'));
    if (this.data.text.trim() && this.data.text.trim() !== this.data.pendingText)
      return toast(new Error('输入框已有新草稿，请先保留它，再恢复上一条消息'));
    this.setData({ text: this.data.pendingText || this.data.text, requestId: '', pendingText: '', error: '' });
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
    if (!m) return;
    if (m.speaker === 'assistant') return wx.setClipboardData({ data: `【AI生成${m.mode === 'demo' ? '·模拟模板' : ''}】\n${m.text}` });
    // 只传来源ID，目标页重新读取原文并核对归属；不把私人正文放进URL。
    wx.showActionSheet({ itemList: ['复制', '存为候选记忆'], success: r => {
      if (r.tapIndex === 0) wx.setClipboardData({ data: m.text });
      else if (r.tapIndex === 1) wx.navigateTo({ url: `/pages/role-memory/index?roleId=${encodeURIComponent(this.data.role!.id)}&conversationId=${encodeURIComponent(this.data.id)}&messageId=${encodeURIComponent(m.id)}` });
    } });
  },
});
