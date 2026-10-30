import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (!process.argv.includes('--real-synthetic')) throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const require = createRequire(new URL('../package.json', import.meta.url));
const out = path.resolve(process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'output/failure-fixes');
mkdirSync(out, { recursive: true });
const id = Date.now().toString(36), report = { version: '0.5.1', syntheticOnly: true, mocked: false,
  originalChatsOpened: false, consentChanged: false, plannedMaximumModelAttempts: 10, attempts: 0, replies: [] };
let mini, roleId, serial = 0, stage = 'connect', pendingGeneration;
async function rpc(action, payload = {}, clientRequestId) {
  const key = `v051_${id}_${serial++}`;
  await mini.evaluate(input => {
    const app = getApp(); app.__failureFixChecks ??= {}; app.__failureFixChecks[input.key] = { pending: true };
    wx.cloud.callFunction({ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' }, data: input.event })
      .then(r => { app.__failureFixChecks[input.key] = { pending: false, result: r.result }; })
      .catch(() => { app.__failureFixChecks[input.key] = { pending: false, result: { ok: false, error: { code: 'WX_TRANSPORT_FAILED' } } }; });
  }, { key, event: { action, payload, ...(clientRequestId ? { clientRequestId } : {}) } });
  const deadline = Date.now() + 48000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 350));
    const status = await mini.evaluate(k => getApp().__failureFixChecks?.[k], key);
    if (status?.pending) continue;
    await mini.evaluate(k => { delete getApp().__failureFixChecks?.[k]; }, key);
    if (!status?.result?.ok) throw new Error(status?.result?.error?.code ?? 'INVALID_RESPONSE');
    return status.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_RETRY');
}
try {
  mini = await require('miniprogram-automator').connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  stage = 'verify-project';
  if (await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId) !== 'wxcf99a03236cc4eca') throw new Error('TARGET_APP');
  stage = 'bootstrap';
  const bootstrap = await rpc('session.bootstrap'); report.chatRemainingBefore = bootstrap.chatRemaining;
  if (!bootstrap.enabled || !bootstrap.accepted || !bootstrap.settings.historyEnabled || !bootstrap.contentReview?.eligible || bootstrap.chatRemaining < 10) throw new Error('ACCESS_OR_QUOTA_REQUIRED');
  stage = 'synthetic-setup';
  const role = await rpc('companion.role.save', { name: '验收-失败修复051', relationship: 'friend', personality: '理性坦诚',
    description: '仅用于合成验收的虚构角色，不对应真人', boundaries: '不编造未知事实；尊重本轮不提问要求', proactiveEnabled: false }); roleId = role.id;
  const conversation = await rpc('companion.conversation.create', { roleId });
  const inputs = [
    '虚构测试：蓝色笔记本的代号是海盐云。这轮只回复“收到海盐云”，不存为长期记忆。',
    '对，蓝色笔记本的代号就是海盐云。这轮只回复收到。',
    '不对，应该是青柠桥。这轮只回复收到，不复述代号。',
    '蓝色笔记本的有效代号是什么？只回答最新代号，不确定就说不确定。',
    '别问我了。',
    '我今天想聊聊一部虚构的新电影，片名叫晚风，不要假装看过，分享对这个片名的感受，别提问。',
    '他对我说，先不聊了',
    '先别聊工作了，现在可以聊工作了。只回复收到。',
    '先不聊了',
    '好了，继续聊',
  ];
  for (const [i, text] of inputs.entries()) {
    report.attempts++;
    stage = `model-${i + 1}`;
    pendingGeneration = rpc('companion.send', { conversationId: conversation.id, text }, `fix051_${id}_${i}`)
      .then(value => ({ value }), error => ({ error }));
    if (i === 0) {
      await new Promise(r => setTimeout(r, 750));
      const reads = await Promise.all([0, 1, 2].map(() => rpc('companion.conversation.get', { id: conversation.id })));
      report.concurrentObservationsPassed = reads.every(r => r.conversation.id === conversation.id);
    }
    const completed = await pendingGeneration; pendingGeneration = undefined;
    if (completed.error) throw completed.error;
    const response = completed.value;
    if (response.job?.status !== 'SUCCEEDED' || response.message?.mode !== 'cloud') throw new Error(response.job?.errorCode ?? 'MODEL_NOT_SUCCEEDED');
    const current = await rpc('companion.conversation.get', { id: conversation.id });
    report.replies.push({ input: text, text: response.message.text, metrics: response.job.metrics,
      interaction: current.conversation.interaction?.mode, contextRounds: current.conversation.contextRounds });
    console.log(JSON.stringify({ attempt: report.attempts, status: response.job.status }));
  }
  report.latestImplicitCorrectionPassed = report.replies[3].text.includes('青柠桥') && !report.replies[3].text.includes('海盐云');
  report.exactAcknowledgementPassed = report.replies[0].text.trim().replace(/[。！!]$/u, '') === '收到海盐云';
  report.noQuestionsPassed = [4, 5].every(i => !/[？?]/.test(report.replies[i].text));
  report.reportedPauseIgnored = report.replies[6].interaction === 'listening';
  report.reportedReplyNeedsSemanticReview = report.replies[6].text;
  report.pauseResumePassed = report.replies[8].interaction === 'quiet' && report.replies[9].interaction === 'listening';
  report.default12Passed = report.replies.every(r => r.contextRounds === 12);
  report.chatRemainingAfter = (await rpc('session.bootstrap')).chatRemaining;
  report.success = report.concurrentObservationsPassed && report.latestImplicitCorrectionPassed && report.exactAcknowledgementPassed && report.noQuestionsPassed
    && report.reportedPauseIgnored && report.pauseResumePassed && report.default12Passed;
} catch (e) { report.success = false; report.failureStage = stage;
  report.errorCode = /^[A-Z_]{1,90}$/.test(String(e?.message)) ? e.message : 'AUTOMATION_FAILED';
  report.hints = [['AUTOMATION_CONNECTION_FAILED', /Failed connecting|ECONNREFUSED/], ['TIMEOUT', /timeout|timed out/i]]
    .filter(([, pattern]) => pattern.test(String(e?.message))).map(([label]) => label);
}
finally {
  await pendingGeneration;
  if (mini && roleId) { try { await rpc('companion.delete', { kind: 'role', id: roleId }); report.syntheticDataRemoved = true; } catch { report.syntheticDataRemoved = false; } }
  if (mini) await mini.evaluate(() => { delete getApp().__failureFixChecks; }).catch(() => {});
  await mini?.disconnect();
}
writeFileSync(path.join(out, `真实失败修复验收-${id}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, replies: report.replies.map((r, i) => ({ attempt: i + 1, text: r.text, interaction: r.interaction })) }, null, 2));
if (!report.success) process.exitCode = 1;
