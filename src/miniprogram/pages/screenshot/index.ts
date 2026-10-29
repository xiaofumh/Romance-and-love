import { call, getMode, uniqueId, toast, ClientError } from '../../services/api';
import { SCREENSHOT_LIMITS, screenshotTiles, screenshotTurns } from '../../../shared/screenshot';
import type { ScreenshotMessage, ScreenshotResult } from '../../../shared/screenshot';
import type { Bootstrap } from '../../../shared/contracts';
Page({ data: { roleId: '', imagePath: '', tileCount: 0, completed: 0, busy: false, preparing: false,
  uploadAuthorized: false, reviewed: false, userSide: 'right', rows: [] as (ScreenshotMessage & { index: number })[],
  messageCount: 0, page: 1, pages: 1, recognized: false, error: '', remaining: 0, attempted: false, retryAfter: 0, returning: false,
  quotaKnown: false, dailyRemaining: 0, dailyLimit: SCREENSHOT_LIMITS.daily as number },
  tiles: [] as string[], messages: [] as ScreenshotMessage[], requestIds: [] as string[], stopped: false,
  onLoad(q: Record<string, string>) { this.setData({ roleId: q.roleId ?? '' }); void this.refreshQuota(); },
  async refreshQuota() {
    if (getMode() !== 'cloud') return;
    try { const b = await call<Bootstrap>('session.bootstrap');
      if (!this.stopped && Number.isInteger(b.screenshotRemaining) && Number.isInteger(b.screenshotDailyLimit))
        this.setData({ quotaKnown: true, dailyRemaining: b.screenshotRemaining, dailyLimit: b.screenshotDailyLimit });
    } catch { /* Availability is still enforced by the server; do not fabricate a quota. */ }
  },
  onUnload() { this.stopped = true; this.tiles = []; this.messages = []; this.requestIds = []; },
  async chooseImage() {
    if (this.data.busy || this.data.preparing) return;
    this.setData({ preparing: true, error: '' });
    try {
      const chosen = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) =>
        wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'], success: resolve, fail: reject }));
      const file = chosen.tempFiles[0]; if (!file) throw new Error('没有选择截图');
      await this.prepareImage(file.tempFilePath, file.size);
    } catch (error) {
      if (!this.stopped) this.setData({ error: error instanceof Error ? error.message : '未能选择图片，可重新选择' });
    } finally { if (!this.stopped) this.setData({ preparing: false }); }
  },
  async prepareImage(filePath: string, sourceBytes: number) {
    this.setData({ preparing: true, error: '' });
    let drawing: WechatMiniprogram.Canvas | undefined;
    try {
      if (sourceBytes > SCREENSHOT_LIMITS.sourceBytes) throw new Error('原截图最多8MB，请先裁剪或拆分');
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) =>
        wx.getImageInfo({ src: filePath, success: resolve, fail: reject }));
      const parts = screenshotTiles(info.width, info.height);
      // Create the local canvas node before processing; it is outside the viewport.
      const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
        wx.createSelectorQuery().in(this).select('#ocr-canvas').fields({ node: true, size: true }).exec(result => {
          const node = result?.[0]?.node; if (node) resolve(node); else reject(new Error('当前微信不支持截图处理，请升级后重试'));
        });
      });
      const image = canvas.createImage();
      drawing = canvas;
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('截图解码失败'));
        image.src = filePath; });
      const tiles: string[] = [];
      for (const part of parts) {
        if (this.stopped) return;
        canvas.width = part.width; canvas.height = part.outputHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, part.width, part.outputHeight);
        ctx.drawImage(image, 0, part.y, info.width, part.height, 0, 0, part.width, part.outputHeight);
        let tile = canvas.toDataURL('image/jpeg', 0.85);
        if ((tile.length - tile.indexOf(',') - 1) * 3 / 4 > SCREENSHOT_LIMITS.imageBytes) tile = canvas.toDataURL('image/jpeg', 0.65);
        if ((tile.length - tile.indexOf(',') - 1) * 3 / 4 > SCREENSHOT_LIMITS.imageBytes)
          throw new Error('截图背景复杂，分片仍超过512KB，请裁去无关背景或拆小后重试');
        tiles.push(tile);
      }
      // Release the large drawing surface; originals stay only in local temporary storage.
      canvas.width = 1; canvas.height = 1;
      if (this.stopped) return;
      this.tiles = tiles; this.messages = []; this.requestIds = tiles.map(() => uniqueId());
      this.setData({ imagePath: filePath, tileCount: tiles.length, completed: 0, uploadAuthorized: false,
        reviewed: false, recognized: false, attempted: false, retryAfter: 0, rows: [], messageCount: 0, page: 1, pages: 1, remaining: tiles.length });
    } catch (error) {
      if (!this.stopped) this.setData({ error: error instanceof Error ? error.message : '未能选择或处理图片，可重新选择' });
    } finally { if (drawing) { drawing.width = 1; drawing.height = 1; } if (!this.stopped) this.setData({ preparing: false }); }
  },
  previewImage() { if (this.data.imagePath) wx.previewImage({ urls: [this.data.imagePath], current: this.data.imagePath }); },
  authorizeUpload() { if (!this.data.busy && !this.data.preparing) this.setData({ uploadAuthorized: !this.data.uploadAuthorized }); },
  async recognize() {
    if (this.data.busy || this.data.preparing || !this.tiles.length) return;
    if (!this.data.uploadAuthorized) return this.setData({ error: '请先阅读并确认截图上传与使用授权' });
    if (getMode() !== 'cloud') return this.setData({ error: '当前为本地模拟，请在“我的”切换云端模式后识别；不会用模拟文字冒充结果' });
    this.setData({ busy: true, error: '', reviewed: false, attempted: true });
    try {
      for (let i = this.data.completed; i < this.tiles.length; i++) {
        if (this.stopped) return;
        const result = await call<ScreenshotResult>('screenshot.recognize', { roleId: this.data.roleId,
          image: this.tiles[i], authorized: true }, this.requestIds[i]);
        if (this.stopped) return;
        this.messages.push(...result.messages.map(v => ({ ...v, tile: i + 1, excluded: false })));
        // Only advance when this tile actually succeeded. Do not re-send earlier tiles.
        this.setData({ completed: i + 1, remaining: this.tiles.length - i - 1 }); this.showPage(this.data.pages);
      }
      this.setData({ recognized: true });
      if (!this.messages.length) this.setData({ error: '没有识别到聊天气泡，请确认是清晰的聊天截图，或手动粘贴文本' });
    } catch (error) {
      if (!this.stopped) this.setData({ error: error instanceof Error ? error.message : '识别失败，已成功分片仍保留；未自动重试',
        retryAfter: error instanceof ClientError && error.code === 'OCR_BUSY' ? Date.now() + 60000 : 0 });
    } finally { if (!this.stopped) { this.setData({ busy: false }); if (this.data.quotaKnown) void this.refreshQuota(); } }
  },
  retry() {
    if (this.data.busy || this.data.completed >= this.tiles.length) return;
    if (Date.now() < this.data.retryAfter) return this.setData({ error: '视觉模型拥堵，请至少间隔一分钟后再主动重试，避免连续消耗尝试次数' });
    // A distinct user tap creates a new attempt for the failed tile only.
    this.requestIds[this.data.completed] = uniqueId(); void this.recognize();
  },
  userSide(e: WechatMiniprogram.Input) {
    const side = e.currentTarget.dataset.side;
    if (!this.data.busy && ['left', 'right'].includes(side)) this.setData({ userSide: side, reviewed: false });
  },
  edit(e: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const row = this.messages[Number(e.currentTarget.dataset.index)]; if (!row) return;
    row.text = e.detail.value; row.kind = 'text'; this.setData({ reviewed: false }); this.showPage(this.data.page);
  },
  side(e: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const row = this.messages[Number(e.currentTarget.dataset.index)], side = e.currentTarget.dataset.side;
    if (row && ['left', 'right'].includes(side)) { row.side = side; this.setData({ reviewed: false }); this.showPage(this.data.page); }
  },
  exclude(e: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const row = this.messages[Number(e.currentTarget.dataset.index)];
    if (row) { row.excluded = !row.excluded; this.setData({ reviewed: false }); this.showPage(this.data.page); }
  },
  showPage(page: number) {
    const pages = Math.max(1, Math.ceil(this.messages.length / 12)), n = Math.max(1, Math.min(pages, page));
    this.setData({ messageCount: this.messages.length, page: n, pages,
      rows: this.messages.slice((n - 1) * 12, n * 12).map((v, i) => ({ ...v, index: (n - 1) * 12 + i })) });
  },
  previous() { this.showPage(this.data.page - 1); }, next() { this.showPage(this.data.page + 1); },
  review() { if (!this.data.busy) this.setData({ reviewed: !this.data.reviewed }); },
  append() {
    try {
      if (this.data.returning) return;
      if (this.data.busy || !this.data.recognized || !this.data.reviewed) throw new Error('请完成所有分片并手动核对识别结果');
      const turns = screenshotTurns(this.messages, this.data.userSide as 'left' | 'right');
      const channel = this.getOpenerEventChannel?.();
      if (typeof channel?.emit !== 'function' || typeof channel?.once !== 'function') throw new Error('请从资料导入页打开截图识别');
      this.setData({ returning: true });
      channel.once('screenshotResult', (result: { ok: boolean; error?: string }) => {
        if (this.stopped) return;
        this.setData({ returning: false });
        if (result.ok) wx.navigateBack(); else toast(new Error(result.error || '文字未加入，识别结果仍保留'));
      });
      channel.emit('screenshotText', { turns });
    } catch (error) { toast(error); }
  },
});
