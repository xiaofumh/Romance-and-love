import { AppError } from './errors';
import { messages } from './prompt';
import type { Provider, ProviderContext } from './service';
import { companionMessages } from './companion-prompt';
import type { ChatContext } from './companion-prompt';
import { ChatOutput } from '../shared/companion';
import { createHash } from 'node:crypto';

function companionOutput(content: string) {
  const text = content.trim();
  let output: unknown = { text };
  // New chat protocol is plain text. Preserve only the strict legacy {text} envelope,
  // never silently discard extra fields, repair broken JSON or coerce wrong types.
  if (text.startsWith('{') && text.endsWith('}')) {
    try { output = JSON.parse(text); }
    catch { throw new AppError('INVALID_MODEL_OUTPUT', '模型回复格式异常，本次不扣体验额度', true); }
  }
  const parsed = ChatOutput.safeParse(output);
  if (!parsed.success) throw new AppError('INVALID_MODEL_OUTPUT', '模型回复为空、过长或格式不正确，本次不扣体验额度', true);
  return parsed.data;
}

export type ModelConfig = { url: string; apiKey: string; model: string; name: string; timeoutMs: number; jsonMode: boolean;
  thinking?: 'disabled' | 'enabled'; chatTemperature?: number };
function transportFailure(error: unknown): AppError {
  // Fetch can fail either before headers or while reading a successful response.
  // Only inspect the standard error name; provider text/URLs/credentials never
  // belong in the client-facing message or the error's serialised properties.
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError'
    ? new AppError('PROVIDER_TIMEOUT', '模型响应超时，请勿重复提交原请求', true)
    : new AppError('PROVIDER_UNAVAILABLE', '模型连接中断，本次不扣体验额度', true);
}
export function createHttpProvider(config: ModelConfig, transport: typeof fetch = fetch): Provider {
  async function request(context: ProviderContext | ChatContext, chat: boolean) {
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password || !config.apiKey || !config.model)
      throw new AppError('PROVIDER_NOT_CONFIGURED', '请先完成服务端模型配置');
    if (chat && config.chatTemperature !== undefined && (!Number.isFinite(config.chatTemperature)
      || config.chatTemperature < 0 || config.chatTemperature > 1
      || Math.round(config.chatTemperature * 100) / 100 !== config.chatTemperature))
      throw new AppError('PROVIDER_NOT_CONFIGURED', '聊天采样配置无效');
    let response: Response;
    const wireMessages = chat ? companionMessages(context as ChatContext) : messages(context as ProviderContext);
    // Fingerprint the actual serialized history, not just the upstream selection.
    // No raw prompt, credentials or other user's data are included in job metrics.
    const requestAudit = chat ? { historySha256: createHash('sha256').update(JSON.stringify(wireMessages.slice(2, -1))).digest('hex'),
      historyMessages: wireMessages.length - 3, protocol: 'window-evidence-v2',
      ...(config.chatTemperature === undefined ? {} : { chatTemperature: config.chatTemperature }) } : undefined;
    try {
      response = await transport(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages: wireMessages, stream: false,
          ...(chat && config.chatTemperature !== undefined ? { temperature: config.chatTemperature } : {}),
          max_tokens: 1024, ...(chat ? { response_format: { type: 'text' } } : config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(config.thinking ? { thinking: { type: config.thinking } } : {}) }),
        signal: AbortSignal.timeout(config.timeoutMs) });
    } catch (error) {
      throw transportFailure(error);
    }
    if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', `模型服务暂不可用（${response.status}），本次不扣体验额度`, true);
    // Bound response text even if a misconfigured provider sends excessive output.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try { reader = response.body?.getReader(); }
    catch (error) { throw transportFailure(error); }
    let text = '';
    if (!reader) throw new AppError('INVALID_MODEL_OUTPUT', '模型响应为空', true);
    try {
      const decoder = new TextDecoder(); let count = 0;
      while (true) {
        const item = await reader.read(); if (item.done) break;
        count += item.value.byteLength;
        if (count > 100000) {
          // An oversized response remains a format/size failure even if cancelling
          // its underlying stream also fails during cleanup.
          try { await reader.cancel(); } catch {}
          throw new AppError('INVALID_MODEL_OUTPUT', '模型响应过长', true);
        }
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw transportFailure(error);
    } finally {
      // Cleanup must not mask the classified read/timeout error.
      try { reader.releaseLock(); } catch {}
    }
    try {
      const data = JSON.parse(text) as { choices?: { finish_reason?: string; message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
        throw new AppError('INVALID_MODEL_OUTPUT', '模型没有返回完整可用结果', true);
      return { output: chat ? companionOutput(choice.message.content) : JSON.parse(choice.message.content), ...(requestAudit ? { requestAudit } : {}), usage: data.usage ? {
        input: Number(data.usage.prompt_tokens) || 0, output: Number(data.usage.completion_tokens) || 0,
      } : undefined };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('INVALID_MODEL_OUTPUT', '模型响应格式异常，本次不扣体验额度', true);
    }
  }
  return { name: config.name, generate: c => request(c, false), chat: c => request(c, true) };
}
