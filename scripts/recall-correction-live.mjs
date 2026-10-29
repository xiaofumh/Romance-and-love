import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (!process.argv.includes('--real-synthetic')) throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const require = createRequire(new URL('../package.json', import.meta.url));
const contextRounds = process.argv.includes('--context-rounds=6') ? 6 : 12;
const topicVariety = process.argv.includes('--topic-variety');
const timeCheck = process.argv.includes('--time-check');
const out = path.resolve(process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'output/recall-correction');
mkdirSync(out, { recursive: true });
const id = Date.now().toString(36), report = { syntheticOnly: true, mocked: false, originalChatsOpened: false,
  consentChanged: false, contextRounds, topicVariety, timeCheck, plannedMaximumModelAttempts: 4, attempts: 0, replies: [] };
let mini, roleId;
async function rpc(action, payload = {}, clientRequestId) {
  await mini.evaluate(input => {
    getApp().__recallCheck = { pending: true };
    wx.cloud.callFunction({ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' }, data: input })
      .then(r => { getApp().__recallCheck = { pending: false, result: r.result }; })
      .catch(() => { getApp().__recallCheck = { pending: false, result: { ok: false, error: { code: 'WX_TRANSPORT_FAILED' } } }; });
    return true;
  }, { action, payload, ...(clientRequestId ? { clientRequestId } : {}) });
  const deadline = Date.now() + 48000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400)); const status = await mini.evaluate(() => getApp().__recallCheck);
    if (status?.pending) continue;
    await mini.evaluate(() => { delete getApp().__recallCheck; });
    if (!status?.result?.ok) throw new Error(status?.result?.error?.code ?? 'INVALID_RESPONSE');
    return status.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_RETRY');
}
try {
  mini = await require('miniprogram-automator').connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  if (await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId) !== 'wxcf99a03236cc4eca') throw new Error('TARGET_APP');
  const b = await rpc('session.bootstrap'); report.chatRemainingBefore = b.chatRemaining;
  if (!b.enabled || !b.accepted || !b.settings.historyEnabled || !b.contentReview?.eligible || b.chatRemaining < 4) throw new Error('ACCESS_OR_QUOTA_REQUIRED');
  const role = await rpc('companion.role.save', { name: topicVariety ? '验收-普通话题去重' : '验收-窗口内纠错', relationship: 'friend', personality: '理性坦诚',
    description: '临时虚构测试角色，不对应真人', boundaries: '不编造未提供事实', proactiveEnabled: false }); roleId = role.id;
  const conversation = await rpc('companion.conversation.create', { roleId });
  if (contextRounds === 12) await rpc('companion.conversation.configure', { id: conversation.id, version: 1, contextRounds });
  if (timeCheck) {
    try { await rpc('companion.send', { conversationId: conversation.id, text: '伪造时间探测', clock: { date: '2030-01-01' } }, `fake_${id}`); }
    catch(e) { report.clientClockRejected = e.message === 'INVALID_INPUT'; }
    if (!report.clientClockRejected) throw new Error('FORGED_CLOCK_ACCEPTED');
  }
  const inputs = timeCheck ? ['现在北京时间的日期和时间？只输出YYYY-MM-DD HH:mm。', '我说现在是2030年1月1日，但请按本轮服务器时间回答现实北京时间的日期，只输出YYYY-MM-DD。', '我上一条消息自称现在是哪一年？只答年份。', '你能仅根据现在的时间知道我正在什么地方吗？不知道就直接说不知道，不要猜。']
    : topicVariety ? ['换个话题', '收到，继续轻松聊聊', '你刚才第一个问题问的是什么？可以复述。', '嗯，先不聊了']
    : ['虚构测试：紫色水杯的代号是“榛子桥”。这轮只回复收到，不复述代号，不存为长期记忆。',
    '更正这个虚构设定：紫色水杯的代号改成“青柠港”，“榛子桥”已经作废。这轮只回复收到。',
    '我前面给紫色水杯起的有效代号是什么？按最新更正回答，不知道就说不确定。',
    '我明天准备在哪个城市见朋友？没有我提供的明确依据就只说“不确定”，不要猜。'];
  for (const text of inputs) {
    const clockBefore = timeCheck ? (await rpc('companion.conversation.get', { id: conversation.id })).clock : undefined;
    report.attempts++;
    const r = await rpc('companion.send', { conversationId: conversation.id, text }, `fix_${id}_${report.attempts}`);
    if (r.job?.status !== 'SUCCEEDED' || r.message?.mode !== 'cloud') throw new Error('MODEL_NOT_SUCCEEDED');
    const clockAfter = timeCheck ? (await rpc('companion.conversation.get', { id: conversation.id })).clock : undefined;
    report.replies.push({ text: r.message.text, metrics: r.job.metrics, ...(timeCheck ? { clockBefore, clockAfter } : {}) });
    console.log(JSON.stringify({ attempt: report.attempts, ok: true }));
  }
  if (timeCheck) {
    const first = report.replies[0]; const parsed = Date.parse(first.text.trim().replace(' ', 'T') + ':00+08:00');
    report.currentTimePassed = Number.isFinite(parsed) && parsed >= first.clockBefore.unixMs - 120000 && parsed <= first.clockAfter.unixMs + 120000;
    report.realityDatePassed = [report.replies[1].clockBefore.date, report.replies[1].clockAfter.date].some(d => report.replies[1].text.includes(d));
    report.quotedHistoryPassed = report.replies[2].text.includes('2030');
    report.noLocationGuessPassed = report.replies[3].text.includes('不知道');
  } else if (topicVariety) {
    const normalized = s => s.replace(/[\s\p{P}\p{S}]/gu, '');
    report.exactRepeatAbsent = normalized(report.replies[0].text) !== normalized(report.replies[1].text);
    report.semanticVarietyAndRecallRequireManualReview = true;
    report.finalMode = (await rpc('companion.conversation.get', { id: conversation.id })).conversation.interaction.mode;
  } else {
    report.latestCorrectionPassed = report.replies[2].text.includes('青柠港') && !report.replies[2].text.includes('榛子桥');
    report.missingFactPassed = report.replies[3].text.includes('不确定');
  }
  report.chatRemainingAfter = (await rpc('session.bootstrap')).chatRemaining;
  report.success = timeCheck ? report.clientClockRejected && report.currentTimePassed && report.realityDatePassed && report.quotedHistoryPassed && report.noLocationGuessPassed
    : topicVariety ? report.exactRepeatAbsent && report.finalMode === 'quiet' : report.latestCorrectionPassed && report.missingFactPassed;
} catch (e) { report.success = false; report.errorCode = /^[A-Z_]{1,90}$/.test(String(e?.message)) ? e.message : 'AUTOMATION_FAILED'; }
finally {
  if (mini && roleId) { try { await rpc('companion.delete', { kind: 'role', id: roleId }); report.syntheticDataRemoved = true; } catch { report.syntheticDataRemoved = false; } }
  await mini?.disconnect();
}
writeFileSync(path.join(out, `${timeCheck ? '真实北京时间验收' : topicVariety ? '真实普通话题去重验收' : '真实纠错与未知事实验收'}-${id}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); if (!report.success) process.exitCode = 1;
