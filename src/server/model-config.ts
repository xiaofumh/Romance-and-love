import type { ModelConfig } from './providers';

// Server-only defaults selected by the user. No API keys are bundled as defaults.
export const BIGMODEL_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export function modelConfigFromEnv(env: Record<string, string | undefined>): ModelConfig {
  const url = env.MODEL_API_URL ?? BIGMODEL_CHAT_URL;
  const model = env.MODEL_NAME ?? 'glm-4.7';
  const officialGlm = url === BIGMODEL_CHAT_URL && model === 'glm-4.7';
  const thinking = env.MODEL_THINKING ?? (officialGlm ? 'disabled' : 'default');
  if (!['default', 'disabled', 'enabled'].includes(thinking)) throw new Error('INVALID_MODEL_THINKING');
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS ?? 20000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 22000) throw new Error('INVALID_MODEL_TIMEOUT');
  return { url, model, apiKey: env.MODEL_API_KEY ?? '',
    name: env.PROVIDER_NAME ?? (officialGlm ? '智谱 BigModel · GLM-4.7' : '待配置模型供应商'),
    // Structured suggestion tasks only; companion chat explicitly requests plain text.
    timeoutMs, jsonMode: env.MODEL_JSON_MODE !== 'false',
    ...(thinking === 'default' ? {} : { thinking: thinking as 'disabled' | 'enabled' }) };
}
