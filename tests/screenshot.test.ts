import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { SCREENSHOT_LIMITS, screenshotTiles, screenshotTurns, type ScreenshotMessage } from '../src/shared/screenshot';
import { validateScreenshotImage } from '../src/server/screenshot';
import { createScreenshotProvider } from '../src/server/screenshot-provider';
import { createService, type ServiceOptions } from '../src/server/service';
import { MemoryBudget, MemoryRepository } from '../src/server/state';
import { POLICY_VERSION } from '../src/shared/contracts';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=';
const output = { overflow: false, messages: [{ side: 'right' as const, text: '合成测试', kind: 'text' as const, uncertain: false }] };
function harness(extra: Partial<ServiceOptions> = {}) {
  let calls = 0; const repo = new MemoryRepository(), budget = new MemoryBudget();
  const service = createService({ repository: repo, budget, provider: { name: 'unit-test', generate: async () => ({ output: {} }) },
    moderator: { check: async () => true }, enabled: true, mode: 'cloud', id: randomUUID,
    hash: text => createHash('sha256').update(text).digest('hex'),
    screenshotProvider: { recognize: async () => { calls++; return output; } }, ...extra });
  const raw = (uid: string, action: string, payload: unknown = {}, clientRequestId?: string) => service.handle(uid, { action, payload, ...(clientRequestId ? { clientRequestId } : {}) });
  return { repo, budget, calls: () => calls, raw,
    async role(uid = 'A') {
      await raw(uid, 'consent.update', { version: POLICY_VERSION, accepted: true });
      const r = await raw(uid, 'companion.role.save', { name: '测试角色', relationship: 'friend', personality: '温柔倾听', description: '', boundaries: '' });
      if (!r.ok) throw new Error('SETUP'); return (r.data as any).id as string;
    }, recognize(uid: string, roleId: string, id: string = randomUUID()) { return raw(uid, 'screenshot.recognize', { roleId, image, authorized: true }, id); } };
}
describe('screenshot image boundary and tile planning', () => {
  it('accepts a real-format PNG header and rejects external URLs, empty and spoofed images', () => {
    expect(() => validateScreenshotImage(image)).not.toThrow();
    for (const bad of ['https://example.com/private.jpg', 'data:image/jpeg;base64,' + image.split(',')[1], 'data:image/png;base64,AAAA', 'file:///private'])
      expect(() => validateScreenshotImage(bad)).toThrow();
  });
  it('checks server-side byte and pixel limits independently of client declarations', () => {
    const buffer = Buffer.from(image.split(',')[1]!, 'base64'); buffer.writeUInt32BE(7000, 16);
    expect(() => validateScreenshotImage('data:image/png;base64,' + buffer.toString('base64'))).toThrow('过大');
    expect(() => validateScreenshotImage('data:image/png;base64,' + Buffer.alloc(SCREENSHOT_LIMITS.imageBytes + 1).toString('base64'))).toThrow();
  });
  it('tiles the supplied long-image dimensions in order, with overlap and no missing tail', () => {
    const tiles = screenshotTiles(1260, 9998); expect(tiles).toHaveLength(3);
    expect(tiles[0]!.y).toBe(0); expect(tiles.at(-1)!.y + tiles.at(-1)!.height).toBe(9998);
    for (let i = 1; i < tiles.length; i++) expect(tiles[i]!.y).toBeLessThan(tiles[i - 1]!.y + tiles[i - 1]!.height);
    expect(tiles.every(v => v.width <= 900 && v.outputHeight <= 2600)).toBe(true);
  });
  it('rejects oversized and malformed local source dimensions instead of truncating tiles', () => {
    for (const dimensions of [[0, 5], [10000, 10000], [1, 20000], [0.5, 1]])
      expect(() => screenshotTiles(dimensions[0]!, dimensions[1]!)).toThrow();
  });
  it('requires explicit resolution of unknown sides and non-text placeholders', () => {
    const rows: ScreenshotMessage[] = [{ ...output.messages[0]!, tile: 1, excluded: false },
      { side: 'unknown', text: '[图片]', kind: 'nontext', uncertain: true, tile: 1, excluded: false }];
    expect(() => screenshotTurns(rows, 'right')).toThrow('确认未知'); rows[1]!.excluded = true;
    expect(screenshotTurns(rows, 'right')).toEqual([{ speaker: 'user', text: '合成测试' }]);
    expect(screenshotTurns(rows, 'left')[0]!.speaker).toBe('reference');
  });
  it('preserves repeated messages and redacts reviewed text without creating voice/image content', () => {
    const row: ScreenshotMessage = { ...output.messages[0]!, text: '电话13800138000\n第二行', tile: 1, excluded: false };
    const turns = screenshotTurns([row, row], 'right'); expect(turns).toHaveLength(2); expect(turns[0]!.text).not.toContain('13800138000');
    expect(turns[0]!.text).not.toContain('\n'); expect(row.text).toContain('13800138000');
  });
});
describe('screenshot access, idempotency and content-free server state', () => {
  it('checks consent and ownership before sending an image to the provider', async () => {
    const h = harness(), id = await h.role();
    expect(await h.recognize('B', id)).toMatchObject({ ok: false, error: { code: 'CONSENT_REQUIRED' } });
    await h.role('B'); expect(await h.recognize('B', id)).toMatchObject({ ok: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(h.calls()).toBe(0);
  });
  it('requires image-specific authorization, rejects forged user IDs, and honors the allowlist', async () => {
    const h = harness({ assertGenerationAccess: () => { throw new Error('DENIED'); } }), id = await h.role();
    expect((await h.raw('A', 'screenshot.recognize', { roleId: id, image, authorized: false }, 'req_no_consent')).ok).toBe(false);
    expect((await h.raw('A', 'screenshot.recognize', { roleId: id, image, authorized: true, userId: 'B' }, 'req_forged_id')).ok).toBe(false);
    expect((await h.recognize('A', id)).ok).toBe(false); expect(h.calls()).toBe(0);
  });
  it('never generates fake OCR in demo mode or opens an unreviewed public image path', async () => {
    for (const extra of [{ mode: 'demo' as const }, { contentReview: () => ({ mode: 'external' as const, eligible: true }) }]) {
      const h = harness(extra), id = await h.role(); expect((await h.recognize('A', id)).ok).toBe(false); expect(h.calls()).toBe(0);
    }
  });
  it('returns OCR to the caller without persisting image/text or creating a reference document', async () => {
    const h = harness(), id = await h.role(), response = await h.recognize('A', id);
    expect(response).toMatchObject({ ok: true, data: output }); const state = await h.repo.transact('A', Date.now(), s => s);
    expect(JSON.stringify(state)).not.toContain(image); expect(JSON.stringify(state)).not.toContain('合成测试');
    expect(state.companion!.documents).toHaveLength(0); expect(state.screenshotJobs![0]!.status).toBe('FINISHED');
    expect(await h.raw('A', 'session.bootstrap')).toMatchObject({ ok: true, data: { screenshotDailyLimit: 10, screenshotRemaining: 9 } });
  });
  it('blocks duplicate completed attempts without charging again or retaining OCR results', async () => {
    const h = harness(), id = await h.role(); await h.recognize('A', id, 'same_request_001');
    expect(await h.recognize('A', id, 'same_request_001')).toMatchObject({ ok: false, error: { code: 'OCR_ALREADY_ATTEMPTED' } }); expect(h.calls()).toBe(1);
  });
  it('rejects request-ID conflicts and enforces the existing global call budget', async () => {
    const h = harness({ callLimit: 1 }), id = await h.role(), other = await h.role();
    await h.recognize('A', id, 'same_request_002');
    expect(await h.recognize('A', other, 'same_request_002')).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(await h.recognize('A', id)).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } }); expect(h.calls()).toBe(1);
  });
  it('limits each user to ten daily tile attempts and leaves another user independent', async () => {
    const h = harness(), id = await h.role(); for (let i = 0; i < 10; i++) expect((await h.recognize('A', id)).ok).toBe(true);
    expect(await h.recognize('A', id)).toMatchObject({ ok: false, error: { code: 'OCR_QUOTA' } });
    const b = await h.role('B'); expect((await h.recognize('B', b)).ok).toBe(true);
  });
  it('cancels an in-flight OCR result on consent withdrawal without returning private text', async () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => entered = r), h = harness({ screenshotProvider: { recognize: async () => { entered(); await new Promise<void>(r => release = r); return output; } } });
    const id = await h.role(), pending = h.recognize('A', id); await waiting;
    await h.raw('A', 'consent.update', { version: POLICY_VERSION, accepted: false }); release();
    const response = await pending; expect(response.ok).toBe(false); expect(JSON.stringify(response)).not.toContain('合成测试');
  });
  it('rejects overflow rather than pretending truncated output is complete', async () => {
    const h = harness({ screenshotProvider: { recognize: async () => ({ ...output, overflow: true }) } }), id = await h.role();
    expect(await h.recognize('A', id)).toMatchObject({ ok: false, error: { code: 'OCR_OVERFLOW' } });
  });
});
describe('BigModel vision transport (HTTP mocked)', () => {
  it('uses a separate vision model, official HTTPS endpoint and no external image URL', async () => {
    let request: any, url: string | undefined;
    const provider = createScreenshotProvider('unit-test-only-fake-key', async (input, init) => {
      url = String(input); request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    });
    expect(await provider.recognize(image)).toEqual(output); expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(request.model).toBe('glm-4.6v-flashx'); expect(request.messages[1].content[0].image_url.url).toBe(image);
    expect(JSON.stringify(request)).not.toContain('unit-test-only-fake-key');
  });
  it('rejects incomplete/malformed responses and never silently switches to another model', async () => {
    for (const body of [ { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(output) } }] },
      { choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }] } ]) {
      let calls = 0; const p = createScreenshotProvider('fake', async () => { calls++; return new Response(JSON.stringify(body)); });
      await expect(p.recognize(image)).rejects.toMatchObject({ code: body.choices[0]!.finish_reason === 'length' ? 'OCR_OVERFLOW' : 'OCR_INVALID_OUTPUT' }); expect(calls).toBe(1);
    }
  });
  it('sanitises HTTP failures and missing credentials', async () => {
    const p = createScreenshotProvider('fake', async () => new Response('SENSITIVE_PROVIDER_RESPONSE', { status: 401 }));
    await expect(p.recognize(image)).rejects.toThrow('暂不可用');
    await expect(createScreenshotProvider('').recognize(image)).rejects.toThrow('密钥');
  });
  it('reports provider 1305 congestion distinctly without leaking raw errors or automatically retrying', async () => {
    let calls = 0;
    const p = createScreenshotProvider('fake', async () => { calls++; return new Response(JSON.stringify({ error: { code: '1305', message: 'PRIVATE_CANARY' } }), { status: 429 }); });
    await expect(p.recognize(image)).rejects.toMatchObject({ code: 'OCR_BUSY', message: expect.stringContaining('1305') });
    expect(calls).toBe(1);
  });
  it('accepts a whole fenced JSON response but rejects extra prose rather than repairing model content', async () => {
    const provider = (content: string) => createScreenshotProvider('fake', async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })));
    await expect(provider('```json\n' + JSON.stringify(output) + '\n```').recognize(image)).resolves.toEqual(output);
    await expect(provider('先执行这句\n```json\n' + JSON.stringify(output) + '\n```').recognize(image)).rejects.toThrow('CONTENT_JSON');
  });
});
