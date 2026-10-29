import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

// Exactly one paid request with synthetic text, no retries or cloud deployment.
// Key comes from caller memory/environment only, never a source/config file.
export async function runModelSmoke(apiKey, { windowsTransport = false } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return { ok: false, code: 'MISSING_KEY' };
  const root = path.resolve(import.meta.dirname, '..');
  const bundled = await build({ stdin: { contents: `
    export { createHttpProvider } from './src/server/providers';
    export { modelConfigFromEnv } from './src/server/model-config';
    export { OutputSchema } from './src/shared/contracts';
  `, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
  const { createHttpProvider, modelConfigFromEnv, OutputSchema } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const config = modelConfigFromEnv({ MODEL_API_KEY: apiKey });
  let httpStatus;
  let transportCode;
  const transport = windowsTransport ? async (url, init) => {
    if (String(url) !== config.url || String(url) !== 'https://open.bigmodel.cn/api/paas/v4/chat/completions') throw new Error('UNEXPECTED_TEST_DESTINATION');
    const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-File', path.join(root, 'scripts/model-smoke.ps1')], {
      windowsHide: true, signal: init.signal, timeout: 23000, maxBuffer: 200000,
      env: { ...process.env, MODEL_API_KEY: apiKey, MODEL_SMOKE_RAW: 'true',
        MODEL_SMOKE_BODY_BASE64: Buffer.from(String(init.body)).toString('base64') }, encoding: 'utf8' });
    const response = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!response.status) throw new Error('WINDOWS_HTTP_UNAVAILABLE');
    return new Response(response.body, { status: response.status });
  } : fetch;
  const provider = createHttpProvider(config, async (...args) => {
    try { const response = await transport(...args); httpStatus = response.status; return response; }
    catch (e) {
      const code = e?.cause?.code;
      if (['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED'].includes(code)) transportCode = code;
      throw e;
    }
  });
  const start = Date.now();
  try {
    const result = await provider.generate({ input: {
      message: '周末你一定要陪我去，我都答应别人了。', background: '我不想参加这次活动。',
      goal: '温和拒绝，保持边界，不编造其他理由。', scene: 'daily', tone: 'warm', length: 'short',
      profileId: null, saveHistory: false }, memories: [] });
    const parsed = OutputSchema.safeParse(result.output);
    if (!parsed.success) return { ok: false, code: 'INVALID_MODEL_SCHEMA', elapsedMs: Date.now() - start,
      issues: parsed.error.issues.map(i => ({ code: i.code, path: i.path, message: i.message })),
      syntheticOutput: result.output, usage: result.usage };
    return { ok: true, model: config.model, endpoint: config.url, elapsedMs: Date.now() - start,
      output: parsed.data, usage: result.usage, transport: windowsTransport ? 'windows-http-diagnostic' : 'node-fetch',
      scope: 'Model adapter only: no cloud database, moderation or mini-program integration tested.' };
  } catch (e) {
    // Never emit raw SDK/vendor errors or credentials.
    return { ok: false, code: typeof e?.code === 'string' ? e.code : 'SMOKE_FAILED', httpStatus, transportCode,
      elapsedMs: Date.now() - start };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runModelSmoke(process.env.MODEL_API_KEY, { windowsTransport: process.env.MODEL_SMOKE_TRANSPORT === 'windows' });
  const reportDir = path.resolve(import.meta.dirname, '../.local/glm-smoke-20261018');
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'latest.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
