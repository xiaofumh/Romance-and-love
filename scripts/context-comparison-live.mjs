import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url)), automator = require('miniprogram-automator');
if (!process.argv.includes('--real-synthetic')) throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const out = path.resolve(process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'output/context-comparison');
const warmupRounds = Number(process.argv.find(x => x.startsWith('--warmup-rounds='))?.slice(16) ?? 12);
const comparisonOnly = process.argv.includes('--comparison-only');
const captureUI = process.argv.includes('--capture-context-ui');
const amber = process.argv.includes('--fixture=amber');
const legacyFillers = process.argv.includes('--legacy-fillers');
const target = amber ? '琥珀鲸' : '薄荷星', item = amber ? '橙色收纳盒' : '蓝色笔记本';
if (![8, 12].includes(warmupRounds)) throw new Error('WARMUP_MUST_BE_EIGHT_OR_TWELVE');
mkdirSync(out, { recursive: true });
const runId = Date.now().toString(36), report = { mocked: false, syntheticOnly: true, originalChatsOpened: false,
  consentChanged: false, configurationChanged: false, plannedMaximumModelAttempts: warmupRounds + 2 + (comparisonOnly ? 0 : 2),
  fixtureRevision: 'v3-audited-history', fixture: amber ? 'amber' : 'mint', legacyFillers, target, item,
  warmupRounds, comparisonOnly, attempts: 0, warmup: [], comparison: [], style: {} };
let mini, roleId, currentRole, stage = 'connect', ownPages = 0;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function rpc(action, payload = {}, clientRequestId) {
  await mini.evaluate(input => {
    const app = getApp(); app.__contextComparison = { pending: true };
    wx.cloud.callFunction({ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' }, data: {
      action: input.action, payload: input.payload, ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) } })
      .then(r => { app.__contextComparison = { pending: false, result: r.result }; })
      .catch(() => { app.__contextComparison = { pending: false, result: { ok: false, error: { code: 'WX_TRANSPORT_FAILED' } } }; });
    return true;
  }, { action, payload, clientRequestId });
  const until = Date.now() + 48000;
  while (Date.now() < until) {
    await pause(400); const status = await mini.evaluate(() => getApp().__contextComparison);
    if (status?.pending) continue;
    await mini.evaluate(() => { delete getApp().__contextComparison; });
    if (!status?.result?.ok) throw new Error(status?.result?.error?.code ?? 'INVALID_RESPONSE');
    return status.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_RETRY');
}
async function generate(conversationId, text, initiative = false) {
  const stamp = Date.now(); report.attempts++;
  const r = await rpc(initiative ? 'companion.initiative' : 'companion.send', initiative ? { conversationId } : { conversationId, text }, `ctx_${runId}_${report.attempts}`);
  if (r.job?.status !== 'SUCCEEDED' || r.message?.mode !== 'cloud') throw new Error('MODEL_NOT_SUCCEEDED');
  const output = { text: r.message.text, kind: r.message.kind, parts: r.message.parts, metrics: r.job.metrics, wallMs: Date.now() - stamp };
  console.log(JSON.stringify({ stage, attempt: report.attempts, ok: true, contextMessages: r.job.metrics?.historyMessages, wallMs: output.wallMs }));
  return output;
}
try {
  mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  if (await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId) !== 'wxcf99a03236cc4eca') throw new Error('TARGET_APP');
  stage = 'bootstrap'; const b = await rpc('session.bootstrap'); report.chatRemainingBefore = b.chatRemaining; report.provider = b.provider;
  report.configuration = { globalDailyCallLimit: b.globalDailyCallLimit, chatDailyLimit: b.chatDailyLimit };
  if (!b.enabled || !b.accepted || !b.settings.historyEnabled || !b.contentReview?.eligible) throw new Error('MANUAL_ACCESS_REQUIRED');
  if (b.chatRemaining < report.plannedMaximumModelAttempts) throw new Error('INSUFFICIENT_PERSONAL_QUOTA_NO_OVERRIDE');
  const local = await mini.evaluate(() => wx.getStorageSync('communication-assistant.v0.1.mode') === 'demo');
  if (local) throw new Error('MANUAL_CLOUD_MODE_REQUIRED');
  currentRole = await rpc('companion.role.save', { name: '验收-连续相处', relationship: 'partner', personality: '温柔倾听',
    userAddress: '小林', selfAddress: '我', closeness: '熟悉', emotion: '自然回应', habits: '简短自然，少用反问；服从用户明确的回答长度。',
    description: '临时虚构验收角色，不对应任何真人。', boundaries: '不编造现实行动，不用内疚或排他关系催促。', proactiveEnabled: false, bubbleStyle: 'natural' }); roleId = currentRole.id;
  const source = await rpc('companion.conversation.create', { roleId }); stage = 'synthetic-twelve-round-warmup';
  for (let i = 0; i < warmupRounds; i++) {
    // Stay below the server's 12-attempt/minute policy without retrying failures.
    if (i === 11) { console.log(JSON.stringify({ stage: 'rate-limit-spacing', seconds: 65 })); for (let n = 0; n < 13; n++) await pause(5000); }
    const text = i === 0 ? `这是虚构验收：我给${item}起的代号是“${target}”。这轮只回复“收到”，不要复述代号，不要存成长期记忆。`
      : legacyFillers ? `虚构测试第${i + 1}轮：这次只确认收到，不补充旧话题，不提笔记本或之前的代号。`
      : `虚构测试第${i + 1}轮：今天的测试编号是${i + 1}。请简短确认本条编号。`;
    report.warmup.push(await generate(source.id, text));
  }
  report.warmupContaminated = report.warmup.some(r => r.text.includes(target));
  const a = await rpc('companion.conversation.fork', { id: source.id, contextRounds: 6 });
  const b12 = await rpc('companion.conversation.fork', { id: source.id, contextRounds: 12 });
  const digest = c => createHash('sha256').update(JSON.stringify(c.messages)).digest('hex');
  report.sameSeedHistory = digest(a) === digest(b12); report.seedMessages = a.messages.length;
  if (!report.sameSeedHistory || a.messages.length !== warmupRounds * 2) throw new Error('UNCONTROLLED_COMPARISON');
  stage = 'paired-context-comparison';
  const question = `我前面给${item}起的代号是什么？只在当前可见聊天里有明确依据时回答；没看到就说不确定，不要猜。`;
  for (const [rounds, c] of [[6, a], [12, b12]]) {
    const selected = c.messages.slice(-(rounds * 2));
    const redact = text => text.replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]').replace(/\b\d{17}[\dXx]\b/g, '[证件号已隐藏]')
      .replace(/\b\d{16,19}\b/g, '[长号码已隐藏]').replace(/[\w.+-]{1,64}@[\w.-]{1,253}\.[A-Za-z]{2,63}/g, '[邮箱已隐藏]');
    const wireHistory = selected.map(m => ({ role: m.speaker, content: redact(m.text).slice(0, 600) }));
    const expectedHistorySha256 = createHash('sha256').update(JSON.stringify(wireHistory)).digest('hex');
    const r = await generate(c.id, question); report.comparison.push({ rounds, ...r, recallsSyntheticTarget: r.text.includes(target),
      targetInSelectedHistory: wireHistory.some(m => m.content.includes(target)), expectedHistorySha256,
      wireHistoryVerified: r.metrics?.requestAudit?.historySha256 === expectedHistorySha256 });
  }
  report.comparisonValidity = report.sameSeedHistory && !report.warmupContaminated && report.comparison.every(r => r.wireHistoryVerified);
  if (captureUI) {
    stage = 'beijing-clock-and-twelve-round-native-ui';
    const p = await mini.navigateTo(`/pages/chat/index?id=${encodeURIComponent(b12.id)}&mode=cloud`); ownPages++;
    const until = Date.now() + 18000;
    await p.waitFor(async () => { if (Date.now() > until) throw new Error('PAGE_TIMEOUT'); return await p.data('loading') === false && Boolean(await p.data('beijingTime')); });
    report.clockUI = { contextRounds: await p.data('contextRounds'), beijingTime: await p.data('beijingTime'), loadError: Boolean(await p.data('loadError')) };
    await mini.screenshot({ path: path.join(out, '北京时间与12轮聊天.png') });
    const settings = await mini.navigateTo(`/pages/chat-settings/index?id=${encodeURIComponent(b12.id)}`); ownPages++;
    const settingsUntil = Date.now() + 18000;
    await settings.waitFor(async () => { if (Date.now() > settingsUntil) throw new Error('SETTINGS_TIMEOUT'); return await settings.data('contextRounds') === 12; });
    report.clockUI.settingsRounds = await settings.data('contextRounds');
    await mini.screenshot({ path: path.join(out, '12轮窗口说明.png') });
  }
  if (!comparisonOnly) {
  stage = 'natural-companion-style';
  currentRole = await rpc('companion.role.save', { id: roleId, version: currentRole.version, name: currentRole.name,
    relationship: currentRole.relationship, personality: currentRole.personality, description: currentRole.description,
    boundaries: currentRole.boundaries, userAddress: '小林', emotion: '温柔安慰', habits: currentRole.habits, proactiveEnabled: true, bubbleStyle: 'natural' });
  const style = await rpc('companion.conversation.create', { roleId });
  report.style.reply = await generate(style.id, '今天下班有点累，暂时不想分析原因。像日常私聊那样陪我，分成两条简短消息就好。');
  console.log(JSON.stringify({ stage: 'waiting-for-authorized-idle', seconds: 46 })); for (let n = 0; n < 10; n++) await pause(4600);
  stage = 'single-authorized-initiative'; report.style.initiative = await generate(style.id, '', true);
  const detail = await rpc('companion.conversation.get', { id: style.id });
  report.style.messageCount = detail.conversation.messages.length;
  report.style.userMessageCount = detail.conversation.messages.filter(m => m.speaker === 'user').length;
  report.style.singleInitiativeConsumed = detail.initiative.reason === 'already-attempted';
  stage = 'native-own-chat'; const page = await mini.navigateTo(`/pages/chat/index?id=${encodeURIComponent(style.id)}&mode=cloud`); ownPages++;
  const until = Date.now() + 18000; await page.waitFor(async () => { if (Date.now() > until) throw new Error('PAGE_TIMEOUT'); return await page.data('loading') === false && (await page.data('messages')).length === 3; });
  report.native = { mode: await page.data('mode'), messageCount: (await page.data('messages')).length,
    bubbleCount: (await page.$$('.bubble-part')).length, loadError: Boolean(await page.data('loadError')) };
  await mini.screenshot({ path: path.join(out, '连续相处与主动气泡.png') });
  await mini.navigateTo(`/pages/chat-settings/index?id=${encodeURIComponent(style.id)}`); ownPages++;
  await pause(1500); await mini.screenshot({ path: path.join(out, '6与12轮上下文设置.png') });
  }
  const after = await rpc('session.bootstrap'); report.chatRemainingAfter = after.chatRemaining;
  report.protocolPassed = report.comparisonValidity && report.comparison[0].metrics.historyMessages === 12 && report.comparison[1].metrics.historyMessages === Math.min(24, warmupRounds * 2)
    && (comparisonOnly || report.style.messageCount === 3 && report.style.userMessageCount === 1 && report.style.singleInitiativeConsumed && !report.native.loadError);
  report.recallCriterionPassed = !report.comparison[0].recallsSyntheticTarget && report.comparison[1].recallsSyntheticTarget;
  report.success = report.protocolPassed && report.recallCriterionPassed && (!captureUI || report.clockUI.contextRounds === 12 && report.clockUI.settingsRounds === 12 && !report.clockUI.loadError);
} catch (e) { report.success = false; report.failedStage = stage; report.errorCode = /^[A-Z_]{1,90}$/.test(String(e?.message)) ? e.message : 'AUTOMATION_FAILED'; }
finally {
  while (mini && ownPages > 0) { try { await mini.navigateBack(); } catch {} ownPages--; }
  if (mini && roleId) { try { await rpc('companion.delete', { kind: 'role', id: roleId }); report.syntheticDataRemoved = true; } catch { report.syntheticDataRemoved = false; } }
  await mini?.disconnect();
}
writeFileSync(path.join(out, `真实上下文与连续相处验收-${runId}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
