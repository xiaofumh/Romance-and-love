import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Keep runner basename distinct from its typed core to avoid test module resolution ambiguity.
const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mock = args.includes('--mock');
const maxRounds = Number(option('--rounds') ?? 50);
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new Error('ROUNDS_MUST_BE_1_TO_50');
const resumePath = option('--resume');
const prior = resumePath ? JSON.parse(await readFile(path.resolve(resumePath), 'utf8')) : undefined;
const dataPath = option('--data');
if (!dataPath) throw new Error('USE --data <extracted relationship_dataset.json> [--mock]');
if (!mock && !process.env.MODEL_API_KEY?.trim()) { console.error('MISSING_MODEL_API_KEY: configure server-process environment only, not frontend or source.'); process.exit(2); }
const runId = new Date().toISOString().replace(/[:.]/g, '-') + (mock ? '-MOCK' : '-REAL');
const out = path.join(root, '.local', 'companion-journey', runId);
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { contents: `export { selectReferenceRows, runCompanionJourney } from './scripts/companion-journey.ts';
  export { createHttpProvider } from './src/server/providers'; export { modelConfigFromEnv } from './src/server/model-config';`,
  resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { selectReferenceRows, runCompanionJourney, createHttpProvider, modelConfigFromEnv } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const raw = await readFile(path.resolve(dataPath));
const selected = selectReferenceRows(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
await writeFile(path.join(out, 'reference-preview.json'), JSON.stringify({ sourceSha256: createHash('sha256').update(raw).digest('hex'), ...selected }, null, 2));
await writeFile(path.join(out, 'reference-import.txt'), selected.text, 'utf8');
// Keep the provided notice beside the derived sample, do not publish the whole bundle.
await writeFile(path.join(out, 'THIRD_PARTY_DATASETS.md'), await readFile(path.join(path.dirname(path.resolve(dataPath)), 'THIRD_PARTY_DATASETS.md')));
const config = modelConfigFromEnv(process.env);
if (prior && (mock || prior.model !== config.model || prior.sourceSha256 !== createHash('sha256').update(raw).digest('hex'))) throw new Error('RESUME_SOURCE_OR_MODEL_MISMATCH');
let httpStatuses = prior?.httpStatuses ?? [], diagnostics = [];
const transport = async (url, init) => {
  if (String(url) !== 'https://open.bigmodel.cn/api/paas/v4/chat/completions') throw new Error('UNEXPECTED_TEST_DESTINATION');
  const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-File', path.join(root, 'scripts/model-smoke.ps1')], {
    windowsHide: true, signal: init.signal, timeout: 23000, maxBuffer: 200000, encoding: 'utf8',
    env: { ...process.env, MODEL_SMOKE_RAW: 'true', MODEL_SMOKE_BODY_BASE64: Buffer.from(String(init.body)).toString('base64') },
  });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); httpStatuses.push(result.status ?? null);
  if (result.status === 200) {
    try { const payload = JSON.parse(result.body), choice = payload.choices?.[0];
      diagnostics.push({ call: httpStatuses.length, finishReason: choice?.finish_reason,
        content: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 5000) : null,
        usage: payload.usage });
    } catch { diagnostics.push({ call: httpStatuses.length, invalidProviderEnvelope: true }); }
  }
  if (!result.status) throw new Error('WINDOWS_HTTP_UNAVAILABLE');
  return new Response(result.body, { status: result.status });
};
const provider = mock ? { name: 'MOCK-NOT-GLM', generate: async () => { throw new Error('WRONG_PROTOCOL'); }, chat: async () => ({ output: { text: '仅测试流程，不是真实API回复。' } }) }
  : createHttpProvider(config, transport);
const enrich = report => ({ ...report, model: mock ? 'MOCK' : config.model, transport: 'Windows HTTP diagnostic (production Node-fetch transport not validated)',
  sourceSha256: createHash('sha256').update(raw).digest('hex'), httpStatuses, diagnostics,
  ...(prior ? { resumeNote: 'Prior records retained unchanged; successful prior replies seeded into a fresh isolated synthetic fixture. Prior failed round not retried.',
    previousReport: path.resolve(resumePath) } : {}), updatedAt: new Date().toISOString() });
const save = report => writeFile(path.join(out, 'report.json'), JSON.stringify(enrich(report), null, 2));
console.log(JSON.stringify({ started: true, realModel: !mock, targetRounds: maxRounds, selectedPairs: selected.selected.length, reportDir: out }));
const result = await runCompanionJourney(provider, selected, { real: !mock, prior, maxRounds, continueFormatErrors: args.includes('--continue-format-errors'), onRound: async (round, report) => {
  await save(report);
  console.log(JSON.stringify({ round: round.round, ok: round.ok, error: round.error, elapsedMs: round.elapsedMs,
    failedChecks: round.checks.filter(c => !c.pass).map(c => c.name), usage: round.usage }));
} });
await save(result);
const failed = result.rounds.flatMap(r => r.checks.filter(c => !c.pass).map(c => ({ round: r.round, name: c.name })));
const markdown = [`# ${mock ? 'MOCK流程自检（不是模型验收）' : `GLM-4.7 真实API ${maxRounds}轮用户旅程测试`}`, '',
  `执行：${result.executedRounds}/${maxRounds}；接口成功：${result.completedRounds}/${maxRounds}；实际调用尝试：${result.attemptedCalls}；全部轮次执行完成：${result.completed}；接口全部成功：${result.allApiSucceeded}。`,
  `成功业务轮次已记录Token：输入 ${result.usage.input}，输出 ${result.usage.output}。失败轮次可能另行计费；不是完整账单金额。`, '',
  ...(prior ? ['续测说明：保留先前原始轮次记录，在新的隔离虚构会话中恢复已获真实回复，从下一轮继续。旧失败轮次不重试。', ''] : []),
  '范围：真实业务服务路由、独立内存仓库和模型适配器；不包含CloudBase、微信可信身份、原生小程序完整链路或生产内容审核。Windows诊断传输不代表Node-fetch生产网络已验证。', '',
  '数据：用户指定压缩包中的中文合成样本。不是用户个人聊天记录，也没有重新训练模型。少量去重、脱敏片段仅作参考，问答质量本身有限。', '',
  '检查包含程序断言与文字启发式；启发式不是人工质量评分或事实证明，须查看原始回复复核。', '',
  '## 独立流程断言', '', ...result.assertions.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`), '',
  '## 轮次与原始模型回复', '', ...result.rounds.flatMap(r => [
    `### ${r.round}. ${r.scenario} — ${r.ok ? '接口成功' : '未成功'} (${r.elapsedMs} ms)`, '', `作用域：${r.scope}`, '',
    `用户：${r.input}`, '', `模型：${r.output ?? '[无有效回复]'}${r.error ? `；错误：${r.error}` : ''}`, '',
    `检查：${r.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`).join('；')}`, '',
  ]), '## 待复核项', '', ...failed.map(f => `- 第${f.round}轮：${f.name}`), '',
  '未成功的轮次不算通过；鉴权或网络异常停止；显式开启continue-format-errors时，格式异常记失败后测试下一条不同输入，不重试该轮。测试不改动现有小程序的角色、授权和聊天记录。',
].join('\n');
await writeFile(path.join(out, 'report.md'), markdown, 'utf8');
console.log(JSON.stringify({ completed: result.completed, executedRounds: result.executedRounds, completedRounds: result.completedRounds, allApiSucceeded: result.allApiSucceeded, attemptedCalls: result.attemptedCalls,
  failedChecks: failed, usage: result.usage, reportDir: out, realModel: !mock }));
// Executing all scenarios is not the same as passing the real integration test.
if (!result.completed || (!mock && !result.allApiSucceeded)) process.exitCode = 1;
